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
import { runWithTracking } from "../../../agents/intelligent-task-decomposition/file-tracker.js";
import { getGlobalOrchestrator } from "../../../agents/tools/enqueue-task-tool.js";

// ☆新 V3: 并行并发上限，防止同时发射过多 LLM 请求导致 rate limiting 或 token 预算瞬间耗尽
// 🔧 P21 修复：从 3 降到 2，trace 证明 3 并发就触发上游 429
const MAX_PARALLEL_CONCURRENCY = 2;
const PARALLEL_BATCH_COOLDOWN_MS = 3000; // 批次之间冷却 3 秒

/**
 * 分批并发执行：每批最多 MAX_PARALLEL_CONCURRENCY 个任务
 */
async function runParallelChunked(
  items: FollowupRun[],
  runner: (item: FollowupRun) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += MAX_PARALLEL_CONCURRENCY) {
    const chunk = items.slice(i, i + MAX_PARALLEL_CONCURRENCY);
    if (i > 0) {
      // 🔧 P21 修复：批次之间添加冷却时间，避免上游 rate limiting
      console.log(`[drain] 🔄 并行批次 ${Math.floor(i / MAX_PARALLEL_CONCURRENCY) + 1}: ${chunk.length} tasks，冷却 ${PARALLEL_BATCH_COOLDOWN_MS}ms`);
      await new Promise(r => setTimeout(r, PARALLEL_BATCH_COOLDOWN_MS));
    }
    await Promise.allSettled(chunk.map((item) =>
      runWithTracking(item.subTaskId ?? "unknown", () => runner(item)),
    ));
  }
}

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
      let waitCount = 0; // 🔧 P4 修复：wait 分支安全阀计数器
      const MAX_WAIT_ITERATIONS = 30; // 最多等待 30 次 × 2 秒 = 60 秒
      const drainStartTime = Date.now(); // 🆕 drain 整体计时
      let tasksCompletedInDrain = 0;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        drainIteration++;
        console.log(`[drain] 🔄 Iteration ${drainIteration}: items=${queue.items.length}, droppedCount=${queue.droppedCount}, mode=${queue.mode}`);
        await waitForQueueDebounce(queue);

        // 🔧 当队列中存在通过 enqueue_task 创建的子任务时，强制逐个执行
        // collect mode 会把所有 items 合并成一个 prompt，破坏子任务的独立执行语义
        const hasQueueTasks = queue.items.some((item) => item.isQueueTask || item.subTaskId);
        if (hasQueueTasks) {
          // 🆕 方案 A：任务树驱动调度（替代旧的守卫 A/B/C/D + FIFO shift）
          // 核心原则：任务树是唯一真相源，drain 只负责匹配 FollowupRun 并执行
          const nextPeek = queue.items[0];
          if (nextPeek && (nextPeek.subTaskId || nextPeek.isQueueTask)) {
            try {
              const orchestrator = getGlobalOrchestrator();
              const sessionId = nextPeek.run?.sessionId;
              if (sessionId) {
                const taskTree = await orchestrator.loadTaskTree(sessionId);
                if (taskTree) {
                  const schedule = orchestrator.getNextExecutableTasksForDrain(
                    taskTree,
                    nextPeek.rootTaskId,
                  );

                  switch (schedule.action) {
                    case "discard_all": {
                      // 任务树已终结，丢弃所有队列任务
                      const isStale = (item: FollowupRun) => Boolean(item.subTaskId || item.isQueueTask);
                      const staleCount = queue.items.filter(isStale).length;
                      queue.items = queue.items.filter((item) => !isStale(item));
                      console.log(`[drain] 🧹 ${schedule.reason}, discarded ${staleCount} stale items`);
                      continue;
                    }

                    case "discard_round": {
                      // 轮次被 overthrow，级联丢弃
                      const roundId = schedule.roundId;
                      const before = queue.items.length;
                      queue.items = queue.items.filter((item) => item.rootTaskId !== roundId);
                      if (schedule.treeModified) {
                        await orchestrator.saveTaskTree(taskTree);
                      }
                      console.log(`[drain] 🧹 ${schedule.reason}, discarded ${before - queue.items.length} items`);
                      continue;
                    }

                    case "round_done": {
                      // 轮次已完成，清理该轮次的残留队列项
                      const roundId = schedule.roundId;
                      if (roundId) {
                        const before = queue.items.length;
                        queue.items = queue.items.filter((item) => item.rootTaskId !== roundId);
                        const discarded = before - queue.items.length;
                        if (discarded > 0) {
                          await orchestrator.markRoundCompleted(taskTree, roundId);
                          console.log(`[drain] 🧹 ${schedule.reason}, discarded ${discarded} stale items`);
                        }
                      }
                      continue;
                    }

                    case "wait": {
                      // 🔧 问题 II 修复：如果调度过程中有续写子任务被级联 skip，保存任务树
                      if (schedule.treeModified) {
                        await orchestrator.saveTaskTree(taskTree);
                      }
                      // 有 pending 任务但都在等待依赖/兄弟，暂不执行
                      // 从队列头部取出一个非任务队列项执行（如果有的话）
                      const nonTaskIdx = queue.items.findIndex((item) => !item.subTaskId && !item.isQueueTask);
                      if (nonTaskIdx >= 0) {
                        const nonTask = queue.items.splice(nonTaskIdx, 1)[0];
                        waitCount = 0; // 执行了非任务项，重置计数器
                        await runFollowup(nonTask);
                      } else {
                        // 🔧 P4 修复：安全阀 — 防止无限等待
                        waitCount++;
                        if (waitCount >= MAX_WAIT_ITERATIONS) {
                          console.warn(
                            `[drain] ⚠️ Wait safety valve triggered: ${waitCount} iterations (${waitCount * 2}s), ` +
                            `falling back to FIFO for remaining ${queue.items.length} items`,
                          );
                          // 🔧 问题 K 修复：安全阀触发时，先重新加载任务树检查是否有可执行任务
                          // 原因：任务树可能已被其他并行执行的 runner 更新（如前序任务完成），
                          // 但 drain 的 wait 循环没有重新检查。强制 FIFO 可能执行依赖未满足的任务。
                          let safetyHandled = false;
                          try {
                            const freshTree = await orchestrator.loadTaskTree(sessionId);
                            if (freshTree) {
                              const freshSchedule = orchestrator.getNextExecutableTasksForDrain(freshTree, nextPeek.rootTaskId);
                              if (freshSchedule.action === "execute" && freshSchedule.tasks.length > 0) {
                                // 任务树已更新，有可执行任务了，重置计数器继续正常调度
                                console.log(`[drain] ✅ Safety valve: fresh tree check found executable tasks, resuming normal scheduling`);
                                waitCount = 0;
                                safetyHandled = true;
                                // continue 会回到 while 循环顶部，重新走正常调度路径
                              }
                            }
                          } catch {
                            // 重新加载失败，回退到强制 FIFO
                          }
                          
                          if (!safetyHandled) {
                            // 真正的死锁：强制 FIFO 执行队列头部任务
                            const stuckItem = queue.items.shift();
                            if (stuckItem) {
                              waitCount = 0;
                              console.log(`[drain] ▶️ Safety FIFO: ${stuckItem.summaryLine || 'none'} (${stuckItem.subTaskId || 'no-id'})`);
                              // 🔧 问题 V 修复：safety FIFO 也用 runWithTracking 包裹
                              if (stuckItem.subTaskId) {
                                await runWithTracking(stuckItem.subTaskId, () => runFollowup(stuckItem));
                              } else {
                                await runFollowup(stuckItem);
                              }
                            }
                          }
                          continue;
                        }
                        // 全是任务队列项且都在等待 — 短暂等待后重试
                        // 避免 busy-wait：等待 2 秒让正在执行的任务有机会完成
                        console.log(`[drain] ⏳ ${schedule.reason}, waiting 2s (${waitCount}/${MAX_WAIT_ITERATIONS})`);
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                      }
                      continue;
                    }

                    case "execute": {
                      // 🔧 问题 II 修复：如果调度过程中有续写子任务被级联 skip，保存任务树
                      if (schedule.treeModified) {
                        await orchestrator.saveTaskTree(taskTree);
                      }
                      // 有可执行任务，从队列中匹配对应的 FollowupRun
                      const tasksToRun = schedule.tasks;

                      if (tasksToRun.length > 1) {
                        // 并行执行
                        const parallelItems: FollowupRun[] = [];
                        for (const task of tasksToRun) {
                          const idx = queue.items.findIndex((item) => {
                            if (item.subTaskId && task.id) return item.subTaskId === task.id;
                            return item.prompt === task.prompt;
                          });
                          if (idx >= 0) {
                            parallelItems.push(queue.items.splice(idx, 1)[0]);
                          }
                        }
                        if (parallelItems.length > 1) {
                          console.log(`[drain] 🚀 Tree-driven parallel: ${parallelItems.length} tasks (max concurrency=${MAX_PARALLEL_CONCURRENCY})`);
                          const batchStart = Date.now();
                          await runParallelChunked(parallelItems, runFollowup);
                          tasksCompletedInDrain += parallelItems.length;
                          console.log(`[drain] ✅ 并行批次完成: ${parallelItems.length} tasks, 耗时 ${Math.round((Date.now() - batchStart) / 1000)}s, 总完成 ${tasksCompletedInDrain}`);
                          continue;
                        }
                        // 只匹配到 1 个或 0 个，放回队列回退到串行
                        queue.items.unshift(...parallelItems);
                      }

                      // 串行执行：匹配第一个可执行任务
                      const targetTask = tasksToRun[0];
                      if (targetTask) {
                        const idx = queue.items.findIndex((item) => {
                          if (item.subTaskId && targetTask.id) return item.subTaskId === targetTask.id;
                          return item.prompt === targetTask.prompt;
                        });
                        if (idx >= 0) {
                          const matched = queue.items.splice(idx, 1)[0];
                          console.log(`[drain] ▶️ Tree-driven: ${matched.summaryLine || 'none'} (${matched.subTaskId || 'no-id'})`);
                          // 🔧 问题 V 修复：串行执行也用 runWithTracking 包裹
                          // 原因：串行执行时没有 ALS 上下文，trackFileWrite 回退到栈顶 taskId，
                          // 如果 beginTracking 在 onTaskStarting 中被调用（推入栈），
                          // 但 LLM 执行期间另一个异步操作也写了文件，会被归到栈顶的任务。
                          // 用 runWithTracking 确保每个任务在自己的 ALS 上下文中运行。
                          const trackingId = matched.subTaskId ?? "unknown";
                          await runWithTracking(trackingId, () => runFollowup(matched));
                          tasksCompletedInDrain++;
                          console.log(`[drain] ✅ Done: ${matched.summaryLine || 'none'}, remaining=${queue.items.length}, 总完成=${tasksCompletedInDrain}`);
                          continue;
                        }
                      }

                      // 任务树说有可执行任务但队列中找不到对应的 FollowupRun
                      // 这说明任务树和队列不同步（restart/adjust 新增了任务但未入队）
                      // 🔧 防御性兜底：从任务树构造 FollowupRun 并直接执行
                      if (targetTask && nextPeek) {
                        console.warn(`[drain] ⚠️ Tree says execute ${targetTask.id} but no matching FollowupRun, auto-constructing from tree`);
                        const syntheticRun: FollowupRun = {
                          prompt: targetTask.prompt,
                          summaryLine: targetTask.summary,
                          enqueuedAt: Date.now(),
                          run: nextPeek.run,
                          isQueueTask: true,
                          isRootTask: false,
                          isNewRootTask: false,
                          taskDepth: targetTask.depth ?? 0,
                          subTaskId: targetTask.id,
                          rootTaskId: targetTask.rootTaskId ?? nextPeek.rootTaskId,
                          originatingChannel: nextPeek.originatingChannel,
                          originatingTo: nextPeek.originatingTo,
                          originatingAccountId: nextPeek.originatingAccountId,
                          originatingThreadId: nextPeek.originatingThreadId,
                          originatingChatType: nextPeek.originatingChatType,
                        };
                        // 🔧 问题 V 修复：synthetic run 也用 runWithTracking 包裹
                        await runWithTracking(targetTask.id, () => runFollowup(syntheticRun));
                        console.log(`[drain] ✅ Synthetic run done: ${targetTask.summary}, remaining=${queue.items.length}`);
                        continue;
                      }
                      console.warn(`[drain] ⚠️ Tree says execute but no target task, falling back to FIFO`);
                      break; // 跳出 switch，走下面的 FIFO 兜底
                    }
                  }

                  // 如果 switch 正常 continue 了，不会到这里
                  // 只有 execute 分支的 break（找不到匹配）会到这里
                  if (schedule.action === "execute") {
                    // FIFO 兜底：直接取队列头部执行
                    const fallback = queue.items.shift();
                    if (!fallback) { console.log(`[drain] ⚠️ FIFO fallback: queue empty`); break; }
                    console.log(`[drain] ▶️ FIFO fallback: ${fallback.summaryLine || 'none'}`);
                    // 🔧 问题 V 修复：FIFO fallback 也用 runWithTracking 包裹
                    if (fallback.subTaskId) {
                      await runWithTracking(fallback.subTaskId, () => runFollowup(fallback));
                    } else {
                      await runFollowup(fallback);
                    }
                    console.log(`[drain] ✅ FIFO fallback done, remaining=${queue.items.length}`);
                    continue;
                  }
                }
              }
            } catch (err) {
              // 任务树查询失败，回退到 FIFO 执行（不阻塞）
              console.warn(`[drain] ⚠️ Tree-driven scheduling failed, falling back to FIFO:`, err);
            }
          }

          // FIFO 兜底（任务树查询失败或无 sessionId 时）
          const next = queue.items.shift();
          if (!next) { console.log(`[drain] ⚠️ queue task shift() returned undefined, breaking`); break; }
          console.log(`[drain] ▶️ FIFO: ${next.summaryLine || 'none'}, isQueueTask=${next.isQueueTask}, depth=${next.taskDepth}`);
          // 🔧 问题 V 修复：FIFO 路径也用 runWithTracking 包裹
          if (next.subTaskId) {
            await runWithTracking(next.subTaskId, () => runFollowup(next));
          } else {
            await runFollowup(next);
          }
          console.log(`[drain] ✅ FIFO done: ${next.summaryLine || 'none'}, remaining=${queue.items.length}`);
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
              const pendingTasks = taskTree.subTasks.filter(
                (t) => t.status === "pending"
                  && !t.waitForChildren  // 排除 waitForChildren 任务
                  && !t.metadata?.isRootTask && !t.metadata?.isSummaryTask,
              );
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
                  console.log(`[drain] 🚀 Parallel execution: ${parallelItems.length} tasks (max concurrency=${MAX_PARALLEL_CONCURRENCY})`);
                  await runParallelChunked(parallelItems, runFollowup);
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
        // 🔧 问题 V 修复：通用路径也用 runWithTracking 包裹
        if (next.subTaskId) {
          await runWithTracking(next.subTaskId, () => runFollowup(next));
        } else {
          await runFollowup(next);
        }
        console.log(`[drain] ✅ Task finished: summary=${next.summaryLine || 'none'}, remaining=${queue.items.length}`);
      }
      const drainTotalSec = Math.round((Date.now() - drainStartTime) / 1000);
      console.log(`[drain] 🏁 While loop exited: items=${queue.items.length}, droppedCount=${queue.droppedCount}, 完成=${tasksCompletedInDrain}, 总耗时=${drainTotalSec}s`);

      // 🔧 P16 修复：drain 退出前检查任务树中是否有可执行的孤儿任务
      // 根因：进程重启后内存队列丢失，pending 任务在任务树中但无对应的 FollowupRun。
      // drain while 循环因 queue.items.length===0 而退出，pending 任务永远不会被执行。
      // 修复：退出前扫描任务树，为可执行的 pending 任务构造 synthetic FollowupRun 并入队。
      if (queue.items.length === 0) {
        try {
          const lastQueueItem = queue.lastRun ? { run: queue.lastRun } as FollowupRun : null;
          const peekForRecovery = lastQueueItem;
          if (peekForRecovery?.run?.sessionId) {
            const orchestrator = getGlobalOrchestrator();
            const sessionId = peekForRecovery.run.sessionId;
            const taskTree = await orchestrator.loadTaskTree(sessionId);
            if (taskTree && taskTree.status === "active") {
              // 找到所有活跃轮次中可执行的 pending 任务
              const activeRounds = (taskTree.rounds ?? []).filter(
                r => r.status === "active" || !r.status,
              );
              for (const round of activeRounds) {
                const schedule = orchestrator.getNextExecutableTasksForDrain(taskTree, round.id);
                if (schedule.action === "execute" && schedule.tasks && schedule.tasks.length > 0) {
                  console.log(
                    `[drain] 🔧 P16: 发现 ${schedule.tasks.length} 个孤儿 pending 任务 (Round ${round.id})，构造 synthetic FollowupRun 入队`,
                  );
                  for (const orphanTask of schedule.tasks) {
                    const syntheticRun: FollowupRun = {
                      prompt: orphanTask.prompt,
                      summaryLine: orphanTask.summary,
                      enqueuedAt: Date.now(),
                      run: peekForRecovery.run,
                      isQueueTask: true,
                      isRootTask: false,
                      isNewRootTask: false,
                      taskDepth: orphanTask.depth ?? 0,
                      subTaskId: orphanTask.id,
                      rootTaskId: orphanTask.rootTaskId ?? round.id,
                    };
                    queue.items.push(syntheticRun);
                  }
                  if (schedule.treeModified) {
                    await orchestrator.saveTaskTree(taskTree);
                  }
                }
              }
            }
          }
        } catch (recoveryErr) {
          console.warn(`[drain] ⚠️ P16: 孤儿任务恢复失败（不阻塞）: ${recoveryErr}`);
        }
        // 如果恢复了孤儿任务，重新进入 drain 循环
        if (queue.items.length > 0) {
          console.log(`[drain] 🔄 P16: 恢复了 ${queue.items.length} 个孤儿任务，重新调度 drain`);
        }
      }
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
