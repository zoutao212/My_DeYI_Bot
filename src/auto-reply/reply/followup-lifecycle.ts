import fs from "node:fs/promises";
import path from "node:path";
import { createExecutionContext } from "../../agents/intelligent-task-decomposition/execution-context.js";
import type {
  PostProcessResult,
  RoundCompletedResult,
  SubTask,
  TaskTree,
} from "../../agents/intelligent-task-decomposition/types.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { resolveQueueSettings } from "./queue/settings.js";
import { sendFallbackFile } from "./send-fallback-file.js";

type SendFollowupPayloads = (payloads: ReplyPayload[], queued: FollowupRun) => Promise<void>;

export function buildChildFollowupRun(
  queued: FollowupRun,
  subTask: SubTask,
  overrides: Partial<FollowupRun> = {},
): FollowupRun {
  const taskDepth =
    overrides.taskDepth ??
    subTask.depth ??
    queued.executionContext?.depth ??
    queued.taskDepth ??
    0;
  const rootTaskId =
    overrides.rootTaskId ??
    subTask.rootTaskId ??
    queued.rootTaskId ??
    queued.executionContext?.roundId;
  const executionContext =
    overrides.executionContext ??
    createExecutionContext({
      role: "leaf",
      roundId: rootTaskId ?? "",
      depth: taskDepth,
    });

  return {
    prompt: subTask.prompt,
    summaryLine: subTask.summary,
    enqueuedAt: Date.now(),
    run: queued.run,
    isQueueTask: true,
    isRootTask: false,
    isNewRootTask: false,
    taskDepth,
    subTaskId: subTask.id,
    rootTaskId,
    originatingChannel: queued.originatingChannel,
    originatingTo: queued.originatingTo,
    originatingAccountId: queued.originatingAccountId,
    originatingThreadId: queued.originatingThreadId,
    originatingChatType: queued.originatingChatType,
    modelContextWindow: queued.modelContextWindow,
    modelMaxOutputTokens: queued.modelMaxOutputTokens,
    abortSignal: queued.abortSignal,
    executionContext,
    ...overrides,
  };
}

export function mergeV2PostProcessResult(
  postResult: PostProcessResult,
  v2EnhancedResult?: PostProcessResult | null,
): PostProcessResult {
  if (!v2EnhancedResult) return postResult;

  postResult.findings = [...postResult.findings, ...v2EnhancedResult.findings];
  postResult.suggestions = [...postResult.suggestions, ...v2EnhancedResult.suggestions];

  if (v2EnhancedResult.decomposedTaskIds && v2EnhancedResult.decomposedTaskIds.length > 0) {
    if (!postResult.decomposedTaskIds) postResult.decomposedTaskIds = [];
    postResult.decomposedTaskIds.push(...v2EnhancedResult.decomposedTaskIds);
  }

  if (v2EnhancedResult.status === "pending" && postResult.decision === "continue") {
    postResult.decision = "restart";
    postResult.status = "pending";
  }

  return postResult;
}

export function enqueuePendingSubTasks(params: {
  queued: FollowupRun;
  taskTree: TaskTree;
  taskIds?: string[];
  logPrefix: string;
}): number {
  const { queued, taskTree, taskIds, logPrefix } = params;
  if (!queued.run.sessionKey || !taskIds || taskIds.length === 0) return 0;

  const resolvedQueue = resolveQueueSettings({
    cfg: queued.run.config ?? ({} as any),
    inlineMode: "followup",
  });

  let enqueuedCount = 0;
  for (const newId of new Set(taskIds)) {
    const newSubTask = taskTree.subTasks.find((task) => task.id === newId);
    if (!newSubTask || newSubTask.status !== "pending") continue;

    const followupRun = buildChildFollowupRun(queued, newSubTask);
    enqueueFollowupRun(queued.run.sessionKey, followupRun, resolvedQueue, "none");
    enqueuedCount++;
    console.log(`${logPrefix}: ${newId} (${newSubTask.summary})`);
  }

  return enqueuedCount;
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[\\/:*?"<>|\n\r\s]+/g, "_").replace(/^_+|_+$/g, "");
}

async function copyMergedFileToWorkspace(
  queued: FollowupRun,
  taskTree: TaskTree,
  mergedFilePath: string,
): Promise<string | undefined> {
  const wsDir = queued.run.workspaceDir;
  if (!wsDir) return undefined;

  const taskOutputDir = queued.rootTaskId
    ? path.join(wsDir, "workspace", queued.rootTaskId)
    : path.join(wsDir, "workspace");
  await fs.mkdir(taskOutputDir, { recursive: true });

  const rootTaskStr = taskTree.rootTask ?? "";
  let rootGoal = "";

  const bookMatch = rootTaskStr.match(/[《\u300A]([^》\u300B]+)[》\u300B]/);
  if (bookMatch) {
    rootGoal = sanitizeFileStem(bookMatch[1]);
  }

  if (!rootGoal && taskTree.subTasks) {
    const summaries = taskTree.subTasks
      .filter((task) => task.summary && task.summary.length > 4 && task.summary.length < 60 && !task.metadata?.isRootTask)
      .map((task) => task.summary!);
    if (summaries.length > 0) {
      for (const summary of summaries) {
        const namedMatch =
          summary.match(/[《\u300A]([^》\u300B]+)[》\u300B]/) ??
          summary.match(/[「""]([^」""]+)[」""]/);
        if (namedMatch) {
          rootGoal = sanitizeFileStem(namedMatch[1]);
          break;
        }
      }
      if (!rootGoal) {
        rootGoal = sanitizeFileStem(summaries[0].substring(0, 20));
      }
    }
  }

  if (!rootGoal) {
    const fileMatch = rootTaskStr.match(/[\\/]([^\s\\/]+?)\.(?:txt|md)\b/);
    if (fileMatch) rootGoal = sanitizeFileStem(fileMatch[1]);
  }

  if (!rootGoal) {
    rootGoal = sanitizeFileStem(rootTaskStr.substring(0, 20)) || "output";
  }

  const userCopyPath = path.join(taskOutputDir, `${rootGoal}_完整版.txt`);
  await fs.copyFile(mergedFilePath, userCopyPath);
  return userCopyPath;
}

export async function deliverCompletedRound(params: {
  queued: FollowupRun;
  taskTree: TaskTree;
  completedRoundId: string;
  roundResult: RoundCompletedResult;
  sendFollowupPayloads: SendFollowupPayloads;
  onArchive?: () => void;
  onDelivered?: (info: { mergedFilePath?: string }) => Promise<void> | void;
  copyMergedOutputToWorkspace?: boolean;
  logPrefix?: string;
}): Promise<void> {
  const {
    queued,
    taskTree,
    completedRoundId,
    roundResult,
    sendFollowupPayloads,
    onArchive,
    onDelivered,
    copyMergedOutputToWorkspace,
    logPrefix = "[followup-runner]",
  } = params;

  if (roundResult.alreadyDelivered) {
    console.log(`${logPrefix} ℹ️ Round ${completedRoundId} 已交付，跳过重复发送`);
    return;
  }

  if (roundResult.mergedFilePath) {
    let userCopyPath: string | undefined;
    if (copyMergedOutputToWorkspace) {
      try {
        userCopyPath = await copyMergedFileToWorkspace(queued, taskTree, roundResult.mergedFilePath);
        if (userCopyPath) {
          console.log(`${logPrefix} 🗂️ 合并文件已复制到用户工作目录: ${userCopyPath}`);
        }
      } catch (copyErr) {
        console.warn(`${logPrefix} ⚠️ 复制合并文件到工作目录失败（不阻塞）: ${copyErr}`);
      }
    }

    const mergedSendResult = await sendFallbackFile({
      filePath: roundResult.mergedFilePath,
      caption: "📝 完整输出（子任务合并）",
      queued,
    });

    if (!mergedSendResult.ok) {
      const displayPath = userCopyPath ?? roundResult.mergedFilePath;
      await sendFollowupPayloads(
        [{ text: `📝 子任务输出已合并保存到：\n${displayPath}` }],
        queued,
      );
    }
  }

  if (roundResult.deliveryReportMarkdown) {
    await sendFollowupPayloads([{ text: roundResult.deliveryReportMarkdown }], queued);
    console.log(`${logPrefix} 🧾 Delivery report sent (${completedRoundId})`);
  }

  onArchive?.();
  await onDelivered?.({ mergedFilePath: roundResult.mergedFilePath });
}
