import type { FollowupRun } from "./queue.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { resolveQueueSettings } from "./queue/settings.js";
import { finalizeWithFollowup } from "./agent-runner-helpers.js";
import { buildChildFollowupRun } from "./followup-lifecycle.js";
import type { TaskRuntime } from "../../agents/intelligent-task-decomposition/task-runtime.js";
import type { SubTask, TaskTree } from "../../agents/intelligent-task-decomposition/types.js";

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function requeueAndContinue(opts: {
  reason: string;
  delayMs?: number;
  queued: FollowupRun;
  subTask: SubTask;
  taskTree: TaskTree;
  sessionId: string;
  taskRuntime: TaskRuntime;
  createRunner: () => (queued: FollowupRun) => Promise<void>;
}): Promise<void> {
  const {
    reason,
    delayMs,
    queued,
    subTask,
    taskTree,
    sessionId,
    taskRuntime,
    createRunner,
  } = opts;

  if (!queued.run.sessionKey) return;

  await taskRuntime.recordEnqueueRequested(
    { sessionId, rootTaskId: queued.rootTaskId, taskTree, subTask },
    { reason, delayMs, retryCount: subTask.retryCount },
  );

  const backoff = Math.min(Math.max(delayMs ?? 0, 0), 10_000);
  if (backoff > 0) {
    await _sleep(backoff);
  }

  const followupRun = buildChildFollowupRun(queued, subTask);
  const resolvedQueue = resolveQueueSettings({
    cfg: queued.run.config ?? ({} as any),
    inlineMode: "followup",
  });

  enqueueFollowupRun(queued.run.sessionKey, followupRun, resolvedQueue, "none");
  finalizeWithFollowup(undefined, queued.run.sessionKey, createRunner());
}
