import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { enqueueFollowupRun, type FollowupRun } from "../../auto-reply/reply/queue.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings.js";
import { getCurrentFollowupRunContext, getGlobalOrchestrator } from "./enqueue-task-tool.js";

const SubTaskSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        "子任务 ID（可选）。如果省略，系统会基于顺序自动生成稳定 ID。",
    }),
  ),
  summary: Type.String({ description: "子任务一句话摘要（面向人）" }),
  prompt: Type.String({ description: "子任务的完整执行说明（面向执行 Agent）" }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), {
      description: "依赖的子任务 ID 列表（可选）",
    }),
  ),
  waitForChildren: Type.Optional(
    Type.Boolean({
      description:
        "是否为父任务/汇总任务（可选）。如果 true，通常不应直接执行，而是等待 children/deps 完成后由系统策略处理。",
    }),
  ),
  taskType: Type.Optional(
    Type.Union(
      [
        Type.Literal("generic"),
        Type.Literal("writing"),
        Type.Literal("analysis"),
        Type.Literal("research"),
        Type.Literal("coding"),
        Type.Literal("automation"),
        Type.Literal("data"),
        Type.Literal("design"),
      ],
      { description: "子任务类型（可选，便于系统选择验证策略与工具白名单）" },
    ),
  ),
});

const SubmitDecompositionSchema = Type.Object({
  rationale: Type.Optional(
    Type.String({
      description:
        "分解理由（可选）：说明你如何确保覆盖总目标、依赖关系为何合理、以及如何验证产出。",
    }),
  ),
  subTasks: Type.Array(SubTaskSchema, {
    description:
      "分解后的子任务列表。必须覆盖总目标，且每个子任务应可独立验收。",
    minItems: 1,
    maxItems: 30,
  }),
});

function stableAutoId(index: number): string {
  const n = index + 1;
  return `decomp_${String(n).padStart(2, "0")}`;
}

function normalizeSubTasks(raw: Array<Record<string, unknown>>): {
  normalized: Array<Record<string, unknown>>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const usedIds = new Set<string>();
  const normalized = raw.map((t, idx) => {
    const idRaw = typeof t.id === "string" ? t.id.trim() : "";
    const id = idRaw || stableAutoId(idx);

    if (usedIds.has(id)) {
      const newId = `${id}_${idx + 1}`;
      warnings.push(`子任务 ID 重复：${id}，已自动改为 ${newId}`);
      usedIds.add(newId);
      return { ...t, id: newId };
    }

    usedIds.add(id);
    return { ...t, id };
  });

  return { normalized, warnings };
}

export function createSubmitDecompositionTool(): AnyAgentTool {
  return {
    label: "Submit Decomposition",
    name: "submit_decomposition",
    description:
      "提交任务分解结果（结构化 JSON）。你必须先完成任务分解，再调用此工具提交 subTasks。",
    parameters: SubmitDecompositionSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const rationale = typeof args.rationale === "string" ? args.rationale.trim() : undefined;
      const subTasksRaw = Array.isArray(args.subTasks) ? (args.subTasks as Array<Record<string, unknown>>) : [];

      const { normalized, warnings } = normalizeSubTasks(subTasksRaw);

      const payload = {
        ok: true,
        rationale: rationale || undefined,
        warnings,
        subTasks: normalized,
      };

      try {
        const currentFollowupRun = getCurrentFollowupRunContext();
        const isQueueTask = currentFollowupRun?.isQueueTask ?? false;
        if (currentFollowupRun && !isQueueTask) {
          const sessionId = currentFollowupRun.run.sessionId;
          const orchestrator = getGlobalOrchestrator();

          let rootTaskId = currentFollowupRun.rootTaskId;
          if (!rootTaskId) {
            rootTaskId = crypto.randomUUID();
            currentFollowupRun.rootTaskId = rootTaskId;
            console.log(`[submit_decomposition] 🆕 New rootTaskId: ${rootTaskId}`);
          }

          let taskTree = await orchestrator.loadTaskTree(sessionId);
          if (!taskTree) {
            taskTree = await orchestrator.initializeTaskTree(
              currentFollowupRun.prompt,
              sessionId,
            );
            console.log(`[submit_decomposition] ✅ Task tree initialized: sessionId=${sessionId}`);
          }

          const agentSessionKey = currentFollowupRun.run.sessionKey ?? sessionId;
          const resolvedQueue = resolveQueueSettings({
            cfg: currentFollowupRun.run.config ?? ({} as any),
            inlineMode: "followup",
          });

          let enqueuedCount = 0;
          for (const t of normalized) {
            const prompt = typeof (t as any)?.prompt === "string" ? String((t as any).prompt) : "";
            const summary = typeof (t as any)?.summary === "string" ? String((t as any).summary) : prompt;
            const waitForChildren = typeof (t as any)?.waitForChildren === "boolean" ? Boolean((t as any).waitForChildren) : false;
            const taskType = typeof (t as any)?.taskType === "string" ? String((t as any).taskType) : undefined;

            const subTask = await orchestrator.addSubTask(
              taskTree,
              prompt,
              summary,
              undefined,
              waitForChildren,
              rootTaskId,
            );

            if (taskType) {
              subTask.taskType = taskType as any;
            }

            const subTaskDepth = subTask.depth ?? 0;
            const followupRun: FollowupRun = {
              prompt,
              summaryLine: summary,
              enqueuedAt: Date.now(),
              run: currentFollowupRun.run,
              isQueueTask: true,
              isRootTask: false,
              isNewRootTask: false,
              taskDepth: subTaskDepth,
              subTaskId: subTask.id,
              rootTaskId,
              originatingChannel: currentFollowupRun.originatingChannel,
              originatingTo: currentFollowupRun.originatingTo,
              originatingAccountId: currentFollowupRun.originatingAccountId,
              originatingThreadId: currentFollowupRun.originatingThreadId,
              originatingChatType: currentFollowupRun.originatingChatType,
              modelContextWindow: currentFollowupRun.modelContextWindow,
              modelMaxOutputTokens: currentFollowupRun.modelMaxOutputTokens,
              abortSignal: currentFollowupRun.abortSignal,
              executionContext: currentFollowupRun.executionContext,
            };

            const enqueued = enqueueFollowupRun(
              agentSessionKey,
              followupRun,
              resolvedQueue,
              "none",
            );

            if (enqueued) {
              enqueuedCount++;
            }
          }

          await orchestrator.saveTaskTree(taskTree);

          (payload as any).autoEnqueue = {
            success: true,
            sessionId,
            rootTaskId,
            enqueuedCount,
            totalCount: normalized.length,
            taskTreePath: `~/.clawdbot/tasks/${sessionId}/TASK_TREE.json`,
          };
        }
      } catch (err) {
        console.error(`[submit_decomposition] ❌ autoEnqueue failed:`, err);
        (payload as any).autoEnqueue = {
          success: false,
          error: String(err),
        };
      }

      const text = JSON.stringify(payload);
      // 控制在 480 左右，留出日志前缀空间，确保进入 toolMetas.meta 的 500 字符截断窗口
      const compact = text.length > 480 ? text.slice(0, 480) : text;

      return {
        content: [{ type: "text" as const, text: compact }],
        details: payload,
      };
    },
  };
}
