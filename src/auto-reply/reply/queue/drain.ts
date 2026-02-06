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
  console.log(`[scheduleFollowupDrain] ✅ Starting drain: key=${key}, items=${queue.items.length}`);
  queue.draining = true;
  void (async () => {
    try {
      let forceIndividualCollect = false;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
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
                for (const pgTask of parallelGroup) {
                  const idx = queue.items.findIndex((item) => item.prompt === pgTask.prompt);
                  if (idx >= 0) {
                    parallelItems.push(queue.items.splice(idx, 1)[0]);
                  }
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
        if (!next) break;
        await runFollowup(next);
      }
    } catch (err) {
      defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(key);
      } else {
        scheduleFollowupDrain(key, runFollowup);
      }
    }
  })();
}
