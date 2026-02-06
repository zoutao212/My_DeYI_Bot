import { defaultRuntime } from "../../../runtime.js";
import {
  buildCollectPrompt,
  buildQueueSummaryPrompt,
  hasCrossChannelItems,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun } from "./types.js";
import { findParallelGroups } from "../../../agents/intelligent-task-decomposition/dependency-analyzer.js";
import { getGlobalOrchestrator } from "../../../agents/tools/enqueue-task-tool.js";

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = FOLLOWUP_QUEUES.get(key);
  if (!queue || queue.draining) {
    // 这是正常的防重复机制，不是错误
    // 当队列正在排空时，跳过新的排空请求
    return;
  }
  console.log(`[scheduleFollowupDrain] ✅ Starting drain: key=${key}, items=${queue.items.length}, mode=${queue.mode}`);
  queue.draining = true;
  void (async () => {
    try {
      let forceIndividualCollect = false;
      let drainIteration = 0;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        drainIteration++;
        console.log(`[drain] 🔄 Iteration ${drainIteration}: items=${queue.items.length}, droppedCount=${queue.droppedCount}, mode=${queue.mode}`);
        await waitForQueueDebounce(queue);

        // 🔧 当队列中存在通过 enqueue_task 创建的子任务时，强制逐个执行
        // collect mode 会把所有 items 合并成一个 prompt，破坏子任务的独立执行语义
        const hasQueueTasks = queue.items.some((item) => item.isQueueTask || item.subTaskId);
        if (hasQueueTasks) {
          // 🆕 轮次完成守卫（替代旧的 3 层 ad-hoc 检查）
          // 核心逻辑：用 rootTaskId 隔离轮次，只要当前轮次所有子任务都已 completed/failed，
          // 就清理队列中同一轮次的所有残留子任务。
          const nextPeek = queue.items[0];
          if (nextPeek && (nextPeek.subTaskId || nextPeek.isQueueTask)) {
            try {
              const orchestrator = getGlobalOrchestrator();
              const sessionId = nextPeek.run?.sessionId;
              if (sessionId) {
                const taskTree = await orchestrator.loadTaskTree(sessionId);
                if (taskTree) {
                  // 守卫 A：任务树全局 status 已终结（兜底，兼容旧数据）
                  // 🔧 二次校验：如果 tree 中仍有 pending 子任务，说明 status 尚未同步（addSubTask 应已修复），
                  //    此时不应丢弃队列，而是跳过守卫让任务正常执行。
                  if (taskTree.status === "completed" || taskTree.status === "failed") {
                    const hasPending = taskTree.subTasks.some((t) => t.status === "pending" || t.status === "active");
                    if (hasPending) {
                      console.log(`[drain] ⚠️ Tree status=${taskTree.status} but ${taskTree.subTasks.filter((t) => t.status === "pending" || t.status === "active").length} pending/active sub-tasks exist, skipping guard A`);
                    } else {
                      const isStale = (item: FollowupRun) => Boolean(item.subTaskId || item.isQueueTask);
                      const staleCount = queue.items.filter(isStale).length;
                      queue.items = queue.items.filter((item) => !isStale(item));
                      console.log(`[drain] 🧹 Task tree already ${taskTree.status}, discarded ${staleCount} stale sub-tasks`);
                      continue;
                    }
                  }

                  // 守卫 B：rootTaskId 轮次完成检查（核心守卫）
                  // 🔧 改进：不再批量丢弃整个 round 的队列项，
                  //    而是逐项检查 tree 中对应子任务的实际状态，只丢弃真正完成的。
                  //    防止新 round 子任务因继承旧 rootTaskId 而被误杀。
                  if (nextPeek.rootTaskId) {
                    if (orchestrator.isRoundCompleted(taskTree, nextPeek.rootTaskId)) {
                      const roundId = nextPeek.rootTaskId;
                      const before = queue.items.length;
                      // 只丢弃 tree 中对应子任务已 completed/failed 的队列项
                      queue.items = queue.items.filter((item) => {
                        if (item.rootTaskId !== roundId) return true; // 不同 round，保留
                        if (!item.subTaskId) return false; // 无 subTaskId 且属于已完成 round，丢弃
                        const treeTask = taskTree.subTasks.find((t) => t.id === item.subTaskId);
                        if (!treeTask) return false; // tree 中不存在，丢弃
                        // tree 中仍 pending/active，保留（可能是新一轮的子任务）
                        return treeTask.status === "pending" || treeTask.status === "active";
                      });
                      const discarded = before - queue.items.length;
                      if (discarded > 0) {
                        console.log(`[drain] 🧹 Round ${roundId} completed, discarded ${discarded} stale sub-tasks (kept ${queue.items.length} items)`);
                        // 同步标记任务树状态
                        await orchestrator.markRoundCompleted(taskTree, roundId);
                      }
                      if (discarded > 0 || queue.items[0]?.rootTaskId === roundId) continue;
                    }
                  }

                  // 守卫 C：单个子任务已 completed/failed，跳过（防重复执行）
                  if (nextPeek.subTaskId) {
                    const subTaskInTree = taskTree.subTasks.find((t) => t.id === nextPeek.subTaskId);
                    if (subTaskInTree && (subTaskInTree.status === "completed" || subTaskInTree.status === "failed")) {
                      queue.items.shift();
                      console.log(`[drain] 🧹 Sub-task ${nextPeek.subTaskId} already ${subTaskInTree.status}, skipping`);
                      continue;
                    }
                  }
                }
              }
            } catch {
              // 检查失败不阻塞执行，回退到正常流程
            }
          }

          const next = queue.items.shift();
          if (!next) { console.log(`[drain] ⚠️ queue task shift() returned undefined, breaking`); break; }
          console.log(`[drain] ▶️ Running queue task individually: summary=${next.summaryLine || 'none'}, isQueueTask=${next.isQueueTask}, isRootTask=${next.isRootTask}, depth=${next.taskDepth}`);
          await runFollowup(next);
          console.log(`[drain] ✅ Queue task finished: summary=${next.summaryLine || 'none'}, remaining=${queue.items.length}`);
          continue;
        }

        if (queue.mode === "collect") {
          // Once the batch is mixed, never collect again within this drain.
          // Prevents “collect after shift” collapsing different targets.
          //
          // Debug: `pnpm test src/auto-reply/reply/queue.collect-routing.test.ts`
          if (forceIndividualCollect) {
            const next = queue.items.shift();
            if (!next) break;
            await runFollowup(next);
            continue;
          }

          // Check if messages span multiple channels.
          // If so, process individually to preserve per-message routing.
          const isCrossChannel = hasCrossChannelItems(queue.items, (item) => {
            const channel = item.originatingChannel;
            const to = item.originatingTo;
            const accountId = item.originatingAccountId;
            const threadId = item.originatingThreadId;
            if (!channel && !to && !accountId && typeof threadId !== "number") {
              return {};
            }
            if (!isRoutableChannel(channel) || !to) {
              return { cross: true };
            }
            const threadKey = typeof threadId === "number" ? String(threadId) : "";
            return {
              key: [channel, to, accountId || "", threadKey].join("|"),
            };
          });

          if (isCrossChannel) {
            forceIndividualCollect = true;
            const next = queue.items.shift();
            if (!next) break;
            await runFollowup(next);
            continue;
          }

          const items = queue.items.splice(0, queue.items.length);
          const summary = buildQueueSummaryPrompt({ state: queue, noun: "message" });
          const run = items.at(-1)?.run ?? queue.lastRun;
          if (!run) break;

          // Preserve originating channel from items when collecting same-channel.
          const originatingChannel = items.find((i) => i.originatingChannel)?.originatingChannel;
          const originatingTo = items.find((i) => i.originatingTo)?.originatingTo;
          const originatingAccountId = items.find(
            (i) => i.originatingAccountId,
          )?.originatingAccountId;
          const originatingThreadId = items.find(
            (i) => typeof i.originatingThreadId === "number",
          )?.originatingThreadId;

          const prompt = buildCollectPrompt({
            title: "[Queued messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          await runFollowup({
            prompt,
            run,
            enqueuedAt: Date.now(),
            originatingChannel,
            originatingTo,
            originatingAccountId,
            originatingThreadId,
          });
          continue;
        }

        const summaryPrompt = buildQueueSummaryPrompt({ state: queue, noun: "message" });
        if (summaryPrompt) {
          const run = queue.lastRun;
          if (!run) break;
          await runFollowup({
            prompt: summaryPrompt,
            run,
            enqueuedAt: Date.now(),
          });
          continue;
        }

        // 🆕 并行执行：检测队列中是否有多个无依赖的任务可以并发
        if (queue.items.length > 1 && queue.items.every((item) => item.isQueueTask)) {
          try {
            const orchestrator = getGlobalOrchestrator();
            const sessionId = queue.items[0]?.run?.sessionId;
            const taskTree = sessionId ? await orchestrator.loadTaskTree(sessionId) : null;

            if (taskTree && taskTree.subTasks.length > 0) {
              const pendingTasks = taskTree.subTasks.filter((t) => t.status === "pending");
              const groups = findParallelGroups(pendingTasks);

              // 如果第一个并行组有 > 1 个任务，尝试并发执行
              if (groups.length > 0 && groups[0].length > 1) {
                const parallelGroup = groups[0];
                const parallelItems: FollowupRun[] = [];

                // 从队列中提取与并行组匹配的 items
                // 🆕 优先使用 subTaskId 匹配，回退到 prompt 匹配（向后兼容）
                let idMatchCount = 0;
                let promptMatchCount = 0;
                
                for (const pgTask of parallelGroup) {
                  const idx = queue.items.findIndex((item) => {
                    // 优先使用 ID 匹配（精确匹配）
                    if (item.subTaskId && pgTask.id) {
                      const matched = item.subTaskId === pgTask.id;
                      if (matched) idMatchCount++;
                      return matched;
                    }
                    // 回退到 prompt 匹配（向后兼容）
                    const matched = item.prompt === pgTask.prompt;
                    if (matched) promptMatchCount++;
                    return matched;
                  });
                  if (idx >= 0) {
                    parallelItems.push(queue.items.splice(idx, 1)[0]);
                  }
                }
                
                // 记录匹配统计
                if (parallelItems.length > 0) {
                  console.log(`[drain] 📊 Match stats: ID=${idMatchCount}, prompt=${promptMatchCount}`);
                }

                if (parallelItems.length > 1) {
                  console.log(`[drain] 🚀 Parallel execution: ${parallelItems.length} tasks`);
                  await Promise.allSettled(parallelItems.map((item) => runFollowup(item)));
                  continue;
                } else {
                  // 放回队列头部
                  queue.items.unshift(...parallelItems);
                }
              }
            }
          } catch {
            // 并行分析失败，回退到串行执行
          }
        }

        const next = queue.items.shift();
        if (!next) { console.log(`[drain] ⚠️ queue.items.shift() returned undefined, breaking`); break; }
        console.log(`[drain] ▶️ Running task: summary=${next.summaryLine || 'none'}, isQueueTask=${next.isQueueTask}, isRootTask=${next.isRootTask}, depth=${next.taskDepth}`);
        await runFollowup(next);
        console.log(`[drain] ✅ Task finished: summary=${next.summaryLine || 'none'}, remaining=${queue.items.length}`);
      }
      console.log(`[drain] 🏁 While loop exited: items=${queue.items.length}, droppedCount=${queue.droppedCount}`);
    } catch (err) {
      defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
      console.error(`[drain] ❌ Drain loop crashed:`, err);
    } finally {
      queue.draining = false;
      console.log(`[drain] 🔚 Finally: items=${queue.items.length}, droppedCount=${queue.droppedCount}`);
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(key);
      } else {
        scheduleFollowupDrain(key, runFollowup);
      }
    }
  })();
}
