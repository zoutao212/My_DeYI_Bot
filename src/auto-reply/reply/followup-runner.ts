import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveAgentIdFromSessionKey, type SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import { finalizeWithFollowup } from "./agent-runner-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { resolveQueueSettings } from "./queue/settings.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { incrementCompactionCount } from "./session-updates.js";
import type { TypingController } from "./typing.js";
import { createTypingSignaler } from "./typing-mode.js";
import { setCurrentFollowupRunContext, clearCurrentFollowupRunContext } from "../../agents/tools/enqueue-task-tool.js";
import { getGlobalOrchestrator } from "../../agents/tools/enqueue-task-tool.js";
import { buildSiblingContext } from "../../agents/memory/pipeline-integration.js";
import { createMemoryService } from "../../agents/memory/factory.js";
import { sendFallbackFile } from "./send-fallback-file.js";
import { collectTrackedFiles, clearTracking } from "../../agents/intelligent-task-decomposition/file-tracker.js";
import { deriveExecutionRole, createExecutionContext } from "../../agents/intelligent-task-decomposition/execution-context.js";
import type { SubTask, TaskTree, ExecutionContext } from "../../agents/intelligent-task-decomposition/types.js";
import type { Orchestrator } from "../../agents/intelligent-task-decomposition/orchestrator.js";
import { TaskProgressReporter, getTaskProgressFromTree } from "../../agents/intelligent-task-decomposition/task-progress-reporter.js";

// ── P10: 输出验证门（OutputValidator）──
// 规则驱动，零 LLM 调用。在标记 completed 之前拦截明显无效输出。
type OutputFailureCode = "hallucinated_tool_calls" | "output_too_short" | "context_overflow_signal" | "llm_refusal" | "excessive_repetition" | "delegation_attempt";
interface OutputValidationResult {
  valid: boolean;
  failureCode?: OutputFailureCode;
  failureReason?: string;
  suggestedAction?: "retry" | "skip";
}

function validateSubTaskOutput(
  outputText: string,
  toolMetas: Array<{ toolName: string; [k: string]: unknown }>,
  context?: { isRootTask?: boolean },
): OutputValidationResult {
  // 规则 1：检测 LLM 把 tool call 幻觉为纯文本
  const hallucinationPatterns = [
    /\[Historical context:.*called tool/i,
    /Do not mimic this format.*use proper function calling/i,
    /a different model called tool/i,
  ];
  if (hallucinationPatterns.some((p) => p.test(outputText))) {
    return {
      valid: false,
      failureCode: "hallucinated_tool_calls",
      failureReason: "LLM 将 tool call 幻觉为纯文本输出，非真实工具调用",
      suggestedAction: "retry",
    };
  }

  // 规则 1.5：检测 LLM 委派行为（调用 sessions_spawn/enqueue_task 而非直接执行）
  // 根因 P13/P14：LLM 在子任务中调用 sessions_spawn 绕过任务系统，
  // 导致输出不被追踪，只有 191 字元叙述被当作 output → 字数不达标 → 死循环
  const DELEGATION_TOOLS = new Set(["sessions_spawn", "enqueue_task", "batch_enqueue_tasks"]);
  const usedDelegationTool = toolMetas.some((m) => DELEGATION_TOOLS.has(m.toolName));
  // 根任务调用 enqueue_task 是正常分解行为，不拦截；只对非根子任务拦截
  if (usedDelegationTool && !context?.isRootTask) {
    const delegationToolNames = toolMetas
      .filter((m) => DELEGATION_TOOLS.has(m.toolName))
      .map((m) => m.toolName)
      .join(", ");
    return {
      valid: false,
      failureCode: "delegation_attempt",
      failureReason: `LLM 尝试委派任务（调用了 ${delegationToolNames}），而非直接执行。子任务必须亲自完成，禁止委派。`,
      suggestedAction: "retry",
    };
  }

  // 规则 2：上下文溢出信号 — 输出极短且无文件工具调用
  // 🔧 P0-C 修复：区分"明确上下文溢出"和"泛化 abort 信号"
  // 根因：原逻辑把所有 abort 信号（包括 API 限流、网络超时、临时性中断）
  // 都标记为 skip（不可重试），导致可恢复的临时失败直接放弃。
  // 修复：明确的上下文溢出（context length/overflow 关键词）→ skip
  //       泛化的 abort（"Request aborted"、"aborted"）→ retry（给一次重试机会）
  const FILE_TOOLS = new Set(["write", "send_file", "read", "exec"]);
  const usedAnyTool = toolMetas.some((m) => FILE_TOOLS.has(m.toolName));
  const contextOverflowPatterns = [
    /context.*(?:length|limit|overflow|exceeded)/i,
    /maximum.*(?:context|token)/i,
    /prompt.*too.*long/i,
    /request.*too.*large/i,
  ];
  const genericAbortPatterns = [
    /request\s*aborted/i,
    /aborted/i,
  ];
  const isContextOverflow = contextOverflowPatterns.some((p) => p.test(outputText));
  const isGenericAbort = !isContextOverflow && genericAbortPatterns.some((p) => p.test(outputText));
  const isAbortSignal = isContextOverflow || isGenericAbort;
  if (!usedAnyTool && (outputText.length < 200 && outputText.length > 0 || isAbortSignal)) {
    // 明确上下文溢出 → skip；泛化 abort → retry（临时性问题可恢复）
    const action = isContextOverflow ? "skip" : "retry";
    return {
      valid: false,
      failureCode: "context_overflow_signal",
      failureReason: isContextOverflow
        ? `检测到上下文溢出: "${outputText.substring(0, 80)}"，结构性问题不可重试`
        : isGenericAbort
          ? `检测到 abort 信号: "${outputText.substring(0, 80)}"，可能是临时性问题`
          : `输出仅 ${outputText.length} 字符且无工具调用，疑似上下文溢出`,
      suggestedAction: action,
    };
  }

  // 规则 3：检测 LLM 拒绝执行（常见的拒绝模式）
  const refusalPatterns = [
    /^(?:I (?:cannot|can't|am unable to|apologize)|抱歉|对不起|我无法|我不能)/i,
    /(?:I'm not able to|as an AI|作为AI|作为一个AI)/i,
  ];
  if (outputText.length < 500 && refusalPatterns.some((p) => p.test(outputText.trim()))) {
    return {
      valid: false,
      failureCode: "llm_refusal",
      failureReason: "LLM 拒绝执行任务",
      suggestedAction: "retry",
    };
  }

  // 规则 4：检测重复内容（同一段文字重复 3 次以上）
  if (outputText.length > 500) {
    const lines = outputText.split("\n").filter(l => l.trim().length > 20);
    const lineSet = new Map<string, number>();
    for (const line of lines) {
      const trimmed = line.trim();
      lineSet.set(trimmed, (lineSet.get(trimmed) ?? 0) + 1);
    }
    const maxRepeat = Math.max(...lineSet.values(), 0);
    if (maxRepeat >= 5) {
      return {
        valid: false,
        failureCode: "excessive_repetition",
        failureReason: `检测到严重重复内容（同一行重复 ${maxRepeat} 次），疑似 LLM 循环生成`,
        suggestedAction: "retry",
      };
    }
  }

  return { valid: true };
}

// isRetryableError 已移至 Orchestrator.isRetryableError()（统一错误分类入口）

/**
 * 🔧 P12: FollowupRun 工厂函数
 * 
 * 从 queued（当前执行的 FollowupRun）和 subTask 构造新的 FollowupRun。
 * 替代 followup-runner 和 drain.ts 中 7 处重复的手动构造代码。
 */
function buildFollowupRun(
  queued: FollowupRun,
  subTask: SubTask,
  overrides?: Partial<FollowupRun>,
): FollowupRun {
  return {
    prompt: subTask.prompt,
    summaryLine: subTask.summary,
    enqueuedAt: Date.now(),
    run: queued.run,
    isQueueTask: true,
    isRootTask: false,
    isNewRootTask: false,
    taskDepth: subTask.depth ?? queued.taskDepth ?? 0,
    subTaskId: subTask.id,
    rootTaskId: subTask.rootTaskId ?? queued.rootTaskId,
    originatingChannel: queued.originatingChannel,
    originatingTo: queued.originatingTo,
    originatingAccountId: queued.originatingAccountId,
    originatingThreadId: queued.originatingThreadId,
    originatingChatType: queued.originatingChatType,
    ...overrides,
  };
}

/**
 * 🆕 V2 Phase 4: 兜底落盘（提取自主循环，减少嵌套深度）
 *
 * 检测 LLM 是否偷懒（生成了大段内容但未调用 write 工具落盘），
 * 如果偷懒则自动保存到兜底目录并发送给用户，同时截断 session 中的超长 assistant 消息。
 */
async function handleFallbackPersistence(opts: {
  subTask: SubTask;
  outputText: string;
  toolMetas: Array<{ toolName: string; [k: string]: unknown }>;
  sessionId: string;
  queued: FollowupRun;
  skipSend?: boolean; // 🔧 问题 JJ：跳过发送，仅保存文件
  llmSessionFile?: string; // 🔧 Session 隔离：隔离的 session 文件路径
}): Promise<void> {
  const FILE_TOOLS = new Set(["write", "send_file"]);
  const MIN_FALLBACK_CHARS = 500;
  const { subTask, outputText, toolMetas, sessionId, queued, skipSend, llmSessionFile } = opts;

  const usedFileTool = toolMetas.some((m) => FILE_TOOLS.has(m.toolName));
  if (usedFileTool || outputText.length < MIN_FALLBACK_CHARS) return;

  try {
    const taskDir = path.join(os.homedir(), ".clawdbot", "tasks", sessionId, "fallback-outputs");
    await fs.mkdir(taskDir, { recursive: true });
    const safeId = (subTask.id ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "_");
    const fallbackFile = path.join(taskDir, `${safeId}.txt`);
    await fs.writeFile(fallbackFile, outputText, "utf-8");
    console.log(
      `[followup-runner] 📝 兜底落盘：LLM 未调用 write 工具，已自动保存 ${outputText.length} 字到 ${fallbackFile}`,
    );

    if (!subTask.metadata) subTask.metadata = {};
    subTask.metadata.fallbackFilePath = fallbackFile;
    subTask.metadata.fallbackReason = "LLM 未调用 write 工具，系统自动兜底落盘";

    // 发送兜底文件到用户频道
    // 🔧 问题 JJ：如果 skipSend=true，跳过发送（等质检通过后再发）
    if (!skipSend) {
      const sendResult = await sendFallbackFile({
        filePath: fallbackFile,
        caption: subTask.summary
          ? `📝 ${subTask.summary}（系统自动保存）`
          : `📝 子任务输出（系统自动保存）`,
        queued,
      });
      if (!sendResult.ok) {
        console.warn(
          `[followup-runner] ⚠️ 兜底文件发送失败 (${sendResult.method}): ${sendResult.error}`,
        );
      }
    }

    // Session 瘦身：截断 session 文件中的最后一条超长 assistant 消息
    try {
      const sessionFilePath = llmSessionFile ?? queued.run.sessionFile;
      if (sessionFilePath) {
        const rawSession = await fs.readFile(sessionFilePath, "utf-8");
        const lines = rawSession.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.role === "assistant" && Array.isArray(entry.content)) {
              const textPart = entry.content.find((c: { type: string }) => c.type === "text");
              if (textPart && typeof textPart.text === "string" && textPart.text.length > 500) {
                const truncated = textPart.text.substring(0, 200) +
                  `\n\n[内容已落盘到文件: ${fallbackFile}，此处截断以控制 session 大小]`;
                textPart.text = truncated;
                lines[i] = JSON.stringify(entry);
                await fs.writeFile(sessionFilePath, lines.join("\n"), "utf-8");
                console.log(
                  `[followup-runner] ✂️ Session 瘦身：截断 assistant 消息 ${outputText.length} → ${truncated.length} 字`,
                );
              }
              break;
            }
          } catch { /* 非 JSON 行，跳过 */ }
        }
      }
    } catch (trimErr) {
      console.warn(`[followup-runner] ⚠️ Session 瘦身失败（不阻塞）: ${trimErr}`);
    }
  } catch (fallbackErr) {
    console.warn(`[followup-runner] ⚠️ 兜底落盘失败: ${fallbackErr}`);
  }
}

/**
 * 🆕 V2 Phase 4: 异步归档轮次记忆（提取自主循环，减少嵌套深度）
 *
 * fire-and-forget：归档失败不影响主流程。
 */
function archiveRoundMemory(
  orchestrator: Orchestrator,
  taskTree: TaskTree,
  roundId: string,
  queued: FollowupRun,
  sessionId: string,
): void {
  try {
    const memService = createMemoryService(queued.run.config, "main");
    if (!memService) return;
    const roundGoal = orchestrator.getRoundRootDescription(taskTree, roundId);
    const completedCount = taskTree.subTasks.filter((t) => t.status === "completed").length;
    const totalCount = taskTree.subTasks.length;
    memService.archive({
      summary: {
        taskGoal: roundGoal || taskTree.rootTask || "任务树",
        keyActions: taskTree.subTasks
          .filter((t) => t.status === "completed")
          .map((t) => t.summary ?? t.prompt?.substring(0, 60) ?? "子任务"),
        keyDecisions: [] as string[],
        blockers: taskTree.subTasks
          .filter((t) => t.status === "failed")
          .map((t) => t.error ?? "未知错误"),
        totalTurns: totalCount,
        createdAt: Date.now(),
        progress: {
          completed: completedCount,
          total: totalCount,
          percentage: totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0,
        },
      },
      context: { userId: queued.run.agentAccountId ?? "default", sessionId },
    }).catch((err: unknown) => console.warn(`[followup-runner] Memory archive failed: ${err}`));
  } catch { /* 归档失败不影响主流程 */ }
}

export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): (queued: FollowupRun) => Promise<void> {
  const {
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  } = params;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat: opts?.isHeartbeat === true,
  });

  /**
   * Sends followup payloads, routing to the originating channel if set.
   *
   * When originatingChannel/originatingTo are set on the queued run,
   * replies are routed directly to that provider instead of using the
   * session's current dispatcher. This ensures replies go back to
   * where the message originated.
   */
  const sendFollowupPayloads = async (payloads: ReplyPayload[], queued: FollowupRun) => {
    // Check if we should route to originating channel.
    const { originatingChannel, originatingTo } = queued;
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      logVerbose("followup queue: no onBlockReply handler; dropping payloads");
      return;
    }

    for (const payload of payloads) {
      if (!payload?.text && !payload?.mediaUrl && !payload?.mediaUrls?.length) {
        continue;
      }
      if (
        isSilentReplyText(payload.text, SILENT_REPLY_TOKEN) &&
        !payload.mediaUrl &&
        !payload.mediaUrls?.length
      ) {
        continue;
      }
      await typingSignals.signalTextDelta(payload.text);

      // Route to originating channel if set, otherwise fall back to dispatcher.
      if (shouldRouteToOriginating) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: queued.run.sessionKey,
          accountId: queued.originatingAccountId,
          threadId: queued.originatingThreadId,
          cfg: queued.run.config,
        });
        if (!result.ok) {
          // Log error and fall back to dispatcher if available.
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          // Fallback: try the dispatcher if routing failed.
          if (opts?.onBlockReply) {
            await opts.onBlockReply(payload);
          }
        }
      } else if (opts?.onBlockReply) {
        await opts.onBlockReply(payload);
      }
    }
  };

  return async (queued: FollowupRun) => {
    const runId = crypto.randomUUID();
    let progressReporter: TaskProgressReporter | null = null;
    try {
      if (queued.run.sessionKey) {
        registerAgentRunContext(runId, {
          sessionKey: queued.run.sessionKey,
          verboseLevel: queued.run.verboseLevel,
        });
      }
      
      // 🔧 获取 Orchestrator 实例
      const orchestrator = getGlobalOrchestrator();
      const sessionId = queued.run.sessionId;
      
      // 🔧 尝试从任务树中找到对应的子任务
      // 优先用 subTaskId 精确匹配，回退到 prompt 匹配（向后兼容）
      let taskTree = await orchestrator.loadTaskTree(sessionId);
      let subTask: SubTask | undefined;
      if (taskTree) {
        if (queued.subTaskId) {
          subTask = taskTree.subTasks.find((t) => t.id === queued.subTaskId);
        }
        if (!subTask) {
          subTask = taskTree.subTasks.find(
            (task) => task.prompt === queued.prompt && task.status === "pending",
          );
        }
      }
      
      // 🆕 V2 Phase 4: 通过 onTaskStarting 钩子统一处理任务启动前的准备
      let startDecisionCtx: ExecutionContext | undefined;
      if (taskTree && subTask) {
        console.log(`[followup-runner] 🔍 Found sub task in tree: ${subTask.id}`);

        // 🆕 初始化任务进度报告器
        const progressInfo = getTaskProgressFromTree(taskTree, queued.rootTaskId);
        progressReporter = new TaskProgressReporter(progressInfo.total);
        progressReporter.updateCounts(progressInfo.completed, progressInfo.failed, progressInfo.total);
        progressReporter.setSender(async (text: string) => {
          try { await sendFollowupPayloads([{ text }], queued); } catch { /* 进度消息发送失败不阻塞主流程 */ }
        });
        progressReporter.onTaskStart(subTask.summary ?? queued.summaryLine ?? "子任务");

        const startDecision = orchestrator.onTaskStarting(taskTree, subTask, {
          isQueueTask: queued.isQueueTask,
          isRootTask: queued.isRootTask ?? queued.isNewRootTask,
          isNewRootTask: queued.isNewRootTask,
          taskDepth: queued.taskDepth,
          rootTaskId: queued.rootTaskId,
        });
        startDecisionCtx = startDecision.executionContext;

        // 钩子判断应先自动分解 → 委托分解后跳过直接执行
        if (startDecision.shouldDecompose) {
          try {
            const decomposed = await orchestrator.decomposeSubTask(taskTree, subTask.id);
            if (decomposed.length > 0) {
              console.log(
                `[followup-runner] ✅ P2: 子任务 ${subTask.id} 已自动分解为 ${decomposed.length} 个子任务，跳过直接执行`,
              );
              // 🔧 问题 BB 修复：分解后 return 前清理文件追踪
              // onTaskStarting 中 beginTracking 已被调用，但分解后不会执行 LLM，
              // 也不会走到 collectTrackedFiles。如果不清理，activeTrackingStack 中
              // 会残留这个 taskId，后续任务的 trackFileWrite 可能误归到这里。
              clearTracking(subTask.id);
              // 🔧 BUG 修复：分解产生的子任务必须创建 FollowupRun 入队
              // 修复前：只调用 finalizeWithFollowup 触发 drain，但队列中没有对应的 FollowupRun
              // 导致分解后的子任务永远不会被执行
              if (queued.run.sessionKey) {
                for (const newSubTask of decomposed) {
                  if (newSubTask.status === "pending") {
                    const decompFollowupRun = buildFollowupRun(queued, newSubTask);
                    const resolvedQueue = resolveQueueSettings({
                      cfg: queued.run.config ?? ({} as any),
                      inlineMode: "followup",
                    });
                    enqueueFollowupRun(queued.run.sessionKey, decompFollowupRun, resolvedQueue, "none");
                    console.log(`[followup-runner] 🆕 分解子任务已入队: ${newSubTask.id} (${newSubTask.summary})`);
                  }
                }
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }
          } catch (decompErr) {
            console.warn(`[followup-runner] ⚠️ P2: 自动递归分解失败（继续正常执行）: ${decompErr}`);
          }
        }

        await orchestrator.saveTaskTree(taskTree);
      }
      
      // 🔧 Session 隔离：子任务使用独立的 session 文件，防止 LLM 上下文交叉污染
      // 根因：所有子任务共享同一个 session 文件（JSONL 对话历史），导致：
      // 1. 后续子任务的 LLM 上下文中包含前序子任务的完整对话
      // 2. 重试时 LLM 看到所有章节的历史，输出混入其他子任务的内容
      // 3. 质检正确检测到"内容归属错乱"，但根因是 session 污染
      let llmSessionFile = queued.run.sessionFile;
      if (queued.subTaskId && queued.isQueueTask) {
        const isolatedSessionDir = path.join(
          os.homedir(), ".clawdbot", "tasks", sessionId, "sessions"
        );
        await fs.mkdir(isolatedSessionDir, { recursive: true });
        // 重试时使用新的 session 文件，避免锚定到上次失败的输出
        // 迭代优化指令已通过 prompt 注入（previousOutput + lastFailureFindings），无需旧 session
        const retryCount = subTask?.retryCount ?? 0;
        const sessionSuffix = retryCount > 0 ? `_retry${retryCount}` : "";
        llmSessionFile = path.join(isolatedSessionDir, `${queued.subTaskId}${sessionSuffix}.jsonl`);
        console.log(
          `[followup-runner] 🔒 Session 隔离: 子任务 ${queued.subTaskId} 使用独立 session` +
          (retryCount > 0 ? ` (retry ${retryCount})` : ""),
        );
      }

      let autoCompactionCompleted = false;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      try {
        // 🆕 V2 Phase 4: ExecutionContext 由 onTaskStarting 钩子构建，回退到旧推导
        const isNewRoot = queued.isNewRootTask ?? false;
        const effectiveIsQueueTask = isNewRoot ? false : (queued.isQueueTask ?? true);
        const effectiveDepth = queued.taskDepth ?? 0;

        const execCtx = startDecisionCtx
          ?? queued.executionContext
          ?? createExecutionContext({
              role: deriveExecutionRole({ isQueueTask: effectiveIsQueueTask, isRootTask: isNewRoot, isNewRootTask: isNewRoot, taskDepth: effectiveDepth }),
              roundId: queued.rootTaskId ?? "",
              depth: effectiveDepth,
            });

        // 🔧 P12 修复：传入 runId 作为 contextId，防止并行 runner 的 finally 块互相清空上下文
        setCurrentFollowupRunContext({ 
          ...queued, 
          isQueueTask: effectiveIsQueueTask,
          isRootTask: isNewRoot,
          isNewRootTask: isNewRoot,
          taskDepth: effectiveDepth,
          rootTaskId: queued.rootTaskId,
          executionContext: execCtx,
        }, runId);
        
        // 🆕 进度报告：开始等待 LLM 回复
        progressReporter?.onLLMStart();

        const fallbackResult = await runWithModelFallback({
          cfg: queued.run.config,
          provider: queued.run.provider,
          model: queued.run.model,
          fallbacksOverride: resolveAgentModelFallbacksOverride(
            queued.run.config,
            resolveAgentIdFromSessionKey(queued.run.sessionKey),
          ),
          run: (provider, model) => {
            const authProfileId =
              provider === queued.run.provider ? queued.run.authProfileId : undefined;
            // 🔧 并行子任务 session lane 隔离：
            // 根因：runEmbeddedPiAgent 内部用 sessionKey 作为 session lane 的 key，
            // maxConcurrent=1，导致同一 session 下的所有子任务被串行化。
            // drain 的 Promise.allSettled 并行只是让多个 runner 同时进入队列等待，
            // 但实际 LLM 调用是一个接一个的。
            // 修复：给子任务的 sessionKey 加上 subTaskId 后缀，让每个子任务有独立的
            // session lane，从而实现真正的并行 LLM 调用。
            const effectiveSessionKey = (queued.isQueueTask && queued.subTaskId)
              ? `${queued.run.sessionKey}:task:${queued.subTaskId}`
              : queued.run.sessionKey;
            return runEmbeddedPiAgent({
              sessionId: queued.run.sessionId,
              sessionKey: effectiveSessionKey,
              messageProvider: queued.run.messageProvider,
              agentAccountId: queued.run.agentAccountId,
              messageTo: queued.originatingTo,
              messageThreadId: queued.originatingThreadId,
              groupId: queued.run.groupId,
              groupChannel: queued.run.groupChannel,
              groupSpace: queued.run.groupSpace,
              sessionFile: llmSessionFile,
              workspaceDir: queued.run.workspaceDir,
              config: queued.run.config,
              skillsSnapshot: queued.run.skillsSnapshot,
              prompt: (() => {
                // 🔧 子任务强制落盘：在 prompt 本体注入指令（用户消息级，LLM 遵从度最高）
                const isSubTask = Boolean(queued.subTaskId);
                if (isSubTask) {
                  // 🔧 写入目录：workspace/{rootTaskId}/，避免污染工作目录根
                  const taskOutputDir = queued.rootTaskId
                    ? `workspace/${queued.rootTaskId}`
                    : "workspace";
                  
                  // 🆕 A1: 迭代优化 — 如果有上次输出和失败原因，注入到 prompt
                  let iterationHint = "";
                  if (subTask?.metadata?.previousOutput || subTask?.metadata?.lastFailureFindings) {
                    const parts: string[] = ["\n\n[⚠️ 迭代优化指令] 这是重试执行。请基于上次的结果进行改进，不要从零开始。"];
                    if (subTask.metadata.lastFailureFindings && subTask.metadata.lastFailureFindings.length > 0) {
                      parts.push(`上次被打回的原因：${subTask.metadata.lastFailureFindings.join("；")}`);
                      parts.push("请针对以上问题重点改进。");
                    }
                    if (subTask.metadata.previousOutput) {
                      const prevSnippet = subTask.metadata.previousOutput.length > 1500
                        ? subTask.metadata.previousOutput.substring(0, 1500) + "...[截断]"
                        : subTask.metadata.previousOutput;
                      parts.push(`上次的输出（供参考和改进）：\n---\n${prevSnippet}\n---`);
                      parts.push("请在上次输出的基础上改进，保留好的部分，修正问题部分。");
                    }
                    iterationHint = parts.join("\n");
                    console.log(`[followup-runner] 🔄 注入迭代优化指令 (previousOutput=${subTask.metadata.previousOutput?.length ?? 0} chars, findings=${subTask.metadata.lastFailureFindings?.length ?? 0})`);
                  }
                  
                  return `[⚠️ 强制规则] 你必须亲自使用 write 工具将生成内容写入 .txt 文件，保存到 ${taskOutputDir}/ 目录下（文件名含任务摘要）。然后在聊天中仅回复简短确认。禁止将完整内容直接输出到聊天。\n[🚫 禁止委派] 严禁调用 enqueue_task、sessions_spawn、batch_enqueue_tasks。你必须自己直接完成创作，不能把任务交给任何人。${iterationHint}\n\n${queued.prompt}`;
                }
                return queued.prompt;
              })(),
              extraSystemPrompt: (() => {
                // 🆕 子任务间上下文共享：注入已完成兄弟任务的输出摘要
                // 🔧 传入 currentTaskId，让 buildSiblingContext 智能过滤：
                // 续写子任务只注入直接依赖的前序任务，避免 prompt 膨胀导致上下文溢出
                const siblingCtx = taskTree?.subTasks
                  ? buildSiblingContext(taskTree.subTasks, 200, subTask?.id)
                  : "";
                if (siblingCtx) {
                  console.log(`[followup-runner] 📋 Injecting sibling context (${siblingCtx.length} chars)`);
                }
                const base = queued.run.extraSystemPrompt ?? "";

                // 🔧 子任务强制落盘（二级强化，主指令已注入 prompt 本体）
                const isSubTask = Boolean(queued.subTaskId);
                const persistInstruction = isSubTask
                  ? "\n\n[SYSTEM] 子任务必须用 write 工具落盘，禁止纯文本输出。严禁使用 enqueue_task/sessions_spawn/batch_enqueue_tasks 委派任务，必须亲自完成。"
                  : "";

                // 🆕 V3: 注入总纲领（Master Blueprint）到子任务上下文
                // 让每个并行执行的子任务都能看到"指挥家的总谱"，保证内容一致性
                let blueprintCtx = "";
                if (isSubTask && taskTree?.metadata?.masterBlueprint) {
                  const blueprint = taskTree.metadata.masterBlueprint;
                  // 🔧 O6: 智能截断纲领——保留"前3000（世界观/角色设定）+ 后3000（后面章节大纲）"
                  // 原策略"前6000一刀切"会导致后面章节（如第5、6章）的大纲完全丢失
                  const MAX_BLUEPRINT = 6000;
                  const truncated = blueprint.length > MAX_BLUEPRINT
                    ? blueprint.substring(0, MAX_BLUEPRINT / 2)
                      + "\n\n...[纲领中段已省略，保留首尾关键内容]...\n\n"
                      + blueprint.substring(blueprint.length - MAX_BLUEPRINT / 2)
                    : blueprint;
                  blueprintCtx = `\n\n[📋 总纲领 / Master Blueprint]\n以下是整体任务的详细规划纲领，你必须严格遵循其中与你当前子任务相关的部分。\n确保角色描述、世界观设定、风格要求与纲领一致。\n---\n${truncated}\n---`;
                  console.log(`[followup-runner] 🎼 注入总纲领 (${blueprint.length} chars, truncated=${blueprint.length > 6000})`);
                }

                // 🆕 V3: 注入子任务专属大纲（chapterOutline）
                let chapterOutlineCtx = "";
                if (isSubTask && subTask?.metadata?.chapterOutline) {
                  chapterOutlineCtx = `\n\n[📖 本任务专属大纲]\n以下是你当前子任务的详细大纲，请严格按此大纲完成创作/执行：\n---\n${subTask.metadata.chapterOutline}\n---`;
                  console.log(`[followup-runner] 📖 注入章节大纲 (${subTask.metadata.chapterOutline.length} chars)`);
                }

                const combined = [base, siblingCtx, persistInstruction, blueprintCtx, chapterOutlineCtx].filter(Boolean).join("");
                return combined || undefined;
              })(),
              ownerNumbers: queued.run.ownerNumbers,
              enforceFinalTag: queued.run.enforceFinalTag,
              provider,
              model,
              authProfileId,
              authProfileIdSource: authProfileId ? queued.run.authProfileIdSource : undefined,
              thinkLevel: queued.run.thinkLevel,
              verboseLevel: queued.run.verboseLevel,
              reasoningLevel: queued.run.reasoningLevel,
              execOverrides: queued.run.execOverrides,
              bashElevated: queued.run.bashElevated,
              timeoutMs: queued.run.timeoutMs,
              runId,
              blockReplyBreak: queued.run.blockReplyBreak,
              onAgentEvent: (evt) => {
                if (evt.stream !== "compaction") return;
                const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                const willRetry = Boolean(evt.data.willRetry);
                if (phase === "end" && !willRetry) {
                  autoCompactionCompleted = true;
                }
              },
            });
          },
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;

        // 🆕 进度报告：LLM 回复完成
        {
          const outputChars = (fallbackResult.result.payloads ?? [])
            .reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
          progressReporter?.onLLMComplete(outputChars > 0 ? outputChars : undefined);
        }
        
        // 🔧 如果找到了子任务，更新状态为 "completed" 并保存输出
        if (taskTree && subTask) {
          // 🔧 竞态保护：重新加载最新的任务树，防止并行 runner 的修改被覆盖
          // 问题：多个 runner 并行执行时，各自持有不同时刻加载的 taskTree 快照。
          // 后保存的 runner 会覆盖先保存的修改（如 output、producedFilePaths 丢失）。
          const freshTree = await orchestrator.loadTaskTree(sessionId);
          if (freshTree && queued.subTaskId) {
            const freshSubTask = freshTree.subTasks.find(t => t.id === queued.subTaskId);
            if (freshSubTask) {
              taskTree = freshTree;
              subTask = freshSubTask;
            }
          }

          const payloadArray = runResult.payloads ?? [];
          const outputText = payloadArray.map((p) => p.text).filter(Boolean).join("\n");

          // 🆕 P10: 输出验证门 — 在标记 completed 之前拦截明显无效输出
          const isRootTaskExecution = Boolean(queued.isRootTask || queued.isNewRootTask);
          const validation = validateSubTaskOutput(outputText, runResult.toolMetas ?? [], { isRootTask: isRootTaskExecution });
          if (!validation.valid) {
            console.warn(
              `[followup-runner] ⚠️ OutputValidator 拦截: ${validation.failureCode} — ${validation.failureReason}`,
            );
            subTask.output = outputText;
            subTask.status = "failed";
            subTask.error = `OutputValidator: ${validation.failureReason}`;
            subTask.retryCount = (subTask.retryCount ?? 0) + 1;

            // 收集并清理文件追踪
            collectTrackedFiles(subTask.id);
            await orchestrator.saveTaskTree(taskTree);

            // 如果建议重试且重试次数未超限，重新入队
            if (validation.suggestedAction === "retry" && subTask.retryCount < 3) {
              subTask.status = "pending";
              await orchestrator.saveTaskTree(taskTree);
              console.log(
                `[followup-runner] 🔄 OutputValidator 建议重试 (${subTask.retryCount}/3)`,
              );
              if (queued.run.sessionKey) {
                // 🔧 P1 修复：OutputValidator retry 时必须创建新的 FollowupRun 入队
                // 修复前：只调用 finalizeWithFollowup 触发 drain，但队列中没有对应的 FollowupRun
                const retryFollowupRun = buildFollowupRun(queued, subTask);
                const resolvedQueue = resolveQueueSettings({
                  cfg: queued.run.config ?? ({} as any),
                  inlineMode: "followup",
                });
                enqueueFollowupRun(queued.run.sessionKey, retryFollowupRun, resolvedQueue, "none");
                console.log(`[followup-runner] 🔄 OutputValidator 重试已入队: ${subTask.id} (retryCount=${subTask.retryCount})`);
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }
            // 否则标记失败，继续处理下一个任务
            if (queued.run.sessionKey) {
              finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
            }
            return;
          }

          subTask.output = outputText;
          subTask.completedAt = Date.now();
          // 🔧 P7 修复：通过 taskTreeManager 统一管理状态转换，而非直接赋值
          // 这样 taskTreeManager 内部的状态转换验证和副作用（如自动设置 completedAt）都能生效
          await orchestrator.updateSubTaskStatus(taskTree, subTask.id, "completed");
          
          // 🔧 收集文件追踪结果（与 orchestrator.executeSubTask 对齐）
          const trackedFiles = collectTrackedFiles(subTask.id);
          if (trackedFiles.length > 0) {
            if (!subTask.metadata) subTask.metadata = {};
            subTask.metadata.producedFiles = trackedFiles.map(f => f.fileName);
            subTask.metadata.producedFilePaths = trackedFiles.map(f => f.filePath);
            console.log(
              `[followup-runner] 📂 收集到 ${trackedFiles.length} 个文件产出: ` +
              trackedFiles.map(f => f.fileName).join(", ")
            );
          }
          // 🔧 FileTracker 断裂回退：从 toolMetas 中提取 write 工具的文件路径
          // 场景：FileTracker 的 ALS 上下文丢失或 beginTracking 未被调用，
          // 导致 collectTrackedFiles 返回 0，但 LLM 确实调用了 write 工具写了文件。
          // toolMetas 的 meta 字段对于 write 工具包含文件路径（由 resolveWriteDetail 提取）。
          // 注意：meta 经过 shortenHomeInString 处理，路径可能以 ~ 开头，需要展开。
          if (trackedFiles.length === 0 && runResult.toolMetas) {
            const writeMetas = runResult.toolMetas.filter(
              (m) => m.toolName === "write" && typeof m.meta === "string" && m.meta.length > 0,
            );
            if (writeMetas.length > 0) {
              if (!subTask.metadata) subTask.metadata = {};
              const homedir = os.homedir();
              const recoveredPaths = writeMetas.map((m) => {
                let p = String(m.meta);
                // shortenHomeInString 可能把 home 路径缩短为 ~
                if (p.startsWith("~/") || p.startsWith("~\\")) {
                  p = path.join(homedir, p.slice(2));
                }
                return p;
              });
              const recoveredNames = recoveredPaths.map((p) => path.basename(p));
              subTask.metadata.producedFiles = recoveredNames;
              subTask.metadata.producedFilePaths = recoveredPaths;
              console.log(
                `[followup-runner] 📂 FileTracker 回退：从 toolMetas 恢复 ${writeMetas.length} 个文件: ` +
                recoveredNames.join(", "),
              );
            }
          }
          
          // 🆕 V2 Phase 4: 兜底落盘（委托提取的辅助函数）
          // 🔧 问题 JJ 修复：兜底落盘仅保存文件，不立即发送给用户
          // 原因：如果质检后决定 restart，用户会先收到不完整的文件，然后又收到重试后的文件。
          // 发送逻辑移到质检通过后（由 postProcessSubTaskCompletion 的 sendSubTaskFiles 处理）。
          await handleFallbackPersistence({
            subTask,
            outputText,
            toolMetas: runResult.toolMetas ?? [],
            sessionId,
            queued,
            skipSend: true, // 🔧 问题 JJ：不立即发送，等质检通过后再发
            llmSessionFile, // 🔧 Session 隔离：传递隔离的 session 文件路径
          });
          
          // 🆕 V2 Phase 4: 统一后处理（onTaskCompleted 钩子替代散装逻辑）
          // 内部编排：postProcess + 质量评估 + 轮次完成检查 + markRoundCompleted
          try {
            // 🆕 进度报告：开始质量评估
            progressReporter?.onQualityReviewStart();

            const postResult = await orchestrator.onTaskCompleted(taskTree, subTask, queued.rootTaskId);

            if (postResult.needsRequeue) {
              progressReporter?.onQualityReviewComplete(false);
              progressReporter?.onTaskRestart(subTask.retryCount ?? 1);
              console.log(
                `[followup-runner] 🔄 子任务 ${subTask.id} 质量不达标，重新入队 (restart): ` +
                `${JSON.stringify(postResult.findings)}`,
              );
              // 🔧 BUG 修复：restart 时必须创建新的 FollowupRun 入队
              // 修复前：只调用 finalizeWithFollowup 触发 drain，但队列中没有对应的 FollowupRun
              // 导致 drain 的 getNextExecutableTasksForDrain 返回 execute，但找不到匹配项，任务永远不会被重新执行
              if (queued.run.sessionKey) {
                const restartFollowupRun = buildFollowupRun(queued, subTask);
                const resolvedQueue = resolveQueueSettings({
                  cfg: queued.run.config ?? ({} as any),
                  inlineMode: "followup",
                });
                enqueueFollowupRun(queued.run.sessionKey, restartFollowupRun, resolvedQueue, "none");
                console.log(`[followup-runner] 🔄 restart 子任务已重新入队: ${subTask.id} (retryCount=${subTask.retryCount})`);
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }

            // 🆕 decompose 决策：增量分解产生的新子任务需要入队
            if (postResult.decision === "decompose" && postResult.decomposedTaskIds && postResult.decomposedTaskIds.length > 0 && taskTree) {
              console.log(
                `[followup-runner] 🔧 子任务 ${subTask.id} 转为增量分解，` +
                `${postResult.decomposedTaskIds.length} 个续写子任务需要入队`,
              );
              for (const newId of postResult.decomposedTaskIds) {
                const newSubTask = taskTree.subTasks.find(t => t.id === newId);
                if (newSubTask && newSubTask.status === "pending") {
                  const newFollowupRun = buildFollowupRun(queued, newSubTask);
                  if (queued.run.sessionKey) {
                    const resolvedQueue = resolveQueueSettings({
                      cfg: queued.run.config ?? ({} as any),
                      inlineMode: "followup",
                    });
                    enqueueFollowupRun(queued.run.sessionKey, newFollowupRun, resolvedQueue, "none");
                    console.log(`[followup-runner] 🆕 decompose 续写子任务已入队: ${newId} (${newSubTask.summary})`);
                  }
                }
              }
              if (queued.run.sessionKey) {
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              // 🔧 问题 N 修复：decompose 后必须 return，否则会继续执行到 sendFollowupPayloads
              // 发送 LLM 的原始不完整回复给用户，造成混乱。
              // 轮次完成检查由 onTaskCompleted 内部处理（decompose 分支已跳过）。
              return;
            }

            if (postResult.markedFailed) {
              progressReporter?.onQualityReviewComplete(false);
              progressReporter?.onTaskFailed("质量严重不通过 (overthrow)");
              console.error(
                `[followup-runner] ❌ 子任务 ${subTask.id} 质量严重不通过 (overthrow): ` +
                `${JSON.stringify(postResult.findings)}`,
              );
              // 🔧 即使当前子任务被 overthrow，也要触发队列继续执行剩余兄弟任务
              // 修复前：直接 return 导致队列停滞，drain 无法推进后续任务
              if (queued.run.sessionKey) {
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }

            // 🆕 进度报告：质检通过 + 任务完成
            progressReporter?.onQualityReviewComplete(true);
            progressReporter?.onTaskComplete();

            console.log(`[followup-runner] ✅ Sub task completed: ${subTask.id}`);

            // 🆕 BUG3 修复：质检 adjust 新增的子任务需要入队到 drain 队列
            if (postResult.newTaskIds && postResult.newTaskIds.length > 0 && taskTree) {
              for (const newId of postResult.newTaskIds) {
                const newSubTask = taskTree.subTasks.find(t => t.id === newId);
                if (newSubTask && newSubTask.status === "pending") {
                  const newFollowupRun = buildFollowupRun(queued, newSubTask);
                  if (queued.run.sessionKey) {
                    const resolvedQueue = resolveQueueSettings({
                      cfg: queued.run.config ?? ({} as any),
                      inlineMode: "followup",
                    });
                    enqueueFollowupRun(queued.run.sessionKey, newFollowupRun, resolvedQueue, "none");
                    console.log(`[followup-runner] 🆕 adjust 新增子任务已入队: ${newId} (${newSubTask.summary})`);
                  }
                }
              }
            }

            // 轮次完成后续处理（由 onTaskCompleted 内部判定并设置标志）
            if (postResult.roundCompleted && postResult.completedRoundId) {
              console.log(`[followup-runner] 🏁 Round completed: ${postResult.completedRoundId} (tree: ${taskTree.id})`);
              taskTree = (await orchestrator.loadTaskTree(sessionId)) ?? taskTree;

              // 委托 onRoundCompleted 钩子：合并输出 + 交付报告
              const roundResult = await orchestrator.onRoundCompleted(taskTree, postResult.completedRoundId);

              // 发送合并文件 + 复制到用户工作目录
              if (roundResult.mergedFilePath) {
                // 🔧 将系统合并文件复制到用户工作目录 workspace/{rootTaskId}/
                let userCopyPath: string | undefined;
                try {
                  const wsDir = queued.run.workspaceDir;
                  if (wsDir) {
                    const taskOutputDir = queued.rootTaskId
                      ? path.join(wsDir, "workspace", queued.rootTaskId)
                      : path.join(wsDir, "workspace");
                    await fs.mkdir(taskOutputDir, { recursive: true });
                    // 从任务树目标生成语义化文件名
                    const rootGoal = taskTree.rootTask?.substring(0, 30)?.replace(/[\\/:*?"<>|\n\r]/g, "_") ?? "output";
                    const copyName = `${rootGoal}_完整版.txt`;
                    userCopyPath = path.join(taskOutputDir, copyName);
                    await fs.copyFile(roundResult.mergedFilePath, userCopyPath);
                    console.log(`[followup-runner] 📄 合并文件已复制到用户工作目录: ${userCopyPath}`);
                  }
                } catch (copyErr) {
                  console.warn(`[followup-runner] ⚠️ 复制合并文件到工作目录失败（不阻塞）: ${copyErr}`);
                }

                const mergedSendResult = await sendFallbackFile({
                  filePath: roundResult.mergedFilePath,
                  caption: `📝 完整输出（子任务合并）`,
                  queued,
                });
                if (!mergedSendResult.ok) {
                  const displayPath = userCopyPath ?? roundResult.mergedFilePath;
                  await sendFollowupPayloads([{
                    text: `📝 子任务输出已合并保存到：\n${displayPath}`,
                  }], queued);
                }
              }

              // 发送交付报告
              if (roundResult.deliveryReportMarkdown) {
                await sendFollowupPayloads([{ text: roundResult.deliveryReportMarkdown }], queued);
                console.log(`[followup-runner] 📦 Delivery report sent`);
              }

              // 异步归档（fire-and-forget，委托辅助函数）
              archiveRoundMemory(orchestrator, taskTree, postResult.completedRoundId, queued, sessionId);
            }
          } catch (ppErr) {
            console.warn(`[followup-runner] ⚠️ 子任务后处理异常（不阻塞）: ${ppErr}`);
            await orchestrator.saveTaskTree(taskTree);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        
        // 🆕 V2 Phase 4: 委托 onTaskFailed 钩子集中处理重试/级联/停止
        if (taskTree && subTask) {
          // 🔧 竞态保护：错误路径也需要重新加载最新的任务树
          const freshTreeOnErr = await orchestrator.loadTaskTree(sessionId);
          if (freshTreeOnErr && queued.subTaskId) {
            const freshSubTaskOnErr = freshTreeOnErr.subTasks.find(t => t.id === queued.subTaskId);
            if (freshSubTaskOnErr) {
              taskTree = freshTreeOnErr;
              subTask = freshSubTaskOnErr;
            }
          }
          clearTracking(subTask.id);
          const failDecision = await orchestrator.onTaskFailed(taskTree, subTask, err);

          if (failDecision.needsRequeue) {
            console.warn(`[followup-runner] ⚠️ ${failDecision.reason}`);
            if (queued.run.sessionKey) {
              // 🔧 P0 修复：needsRequeue 时必须创建新的 FollowupRun 入队
              // 修复前：只调用 finalizeWithFollowup 触发 drain，但队列中没有对应的 FollowupRun
              // 导致 drain 找不到匹配项，重试永远不会执行
              const retryFollowupRun = buildFollowupRun(queued, subTask);
              const resolvedQueue = resolveQueueSettings({
                cfg: queued.run.config ?? ({} as any),
                inlineMode: "followup",
              });
              enqueueFollowupRun(queued.run.sessionKey, retryFollowupRun, resolvedQueue, "none");
              console.log(`[followup-runner] 🔄 onTaskFailed 重试已入队: ${subTask.id} (retryCount=${subTask.retryCount})`);
              finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
            }
          } else {
            console.error(`[followup-runner] ❌ ${failDecision.reason}`);
          }
        } else {
          // 没有找到子任务，继续执行下一个任务（保持原有行为）
          if (queued.run.sessionKey) {
            const queueKey = queued.run.sessionKey;
            finalizeWithFollowup(undefined, queueKey, createFollowupRunner(params));
          }
        }
        
        return;
      }

      if (storePath && sessionKey) {
        const usage = runResult.meta.agentMeta?.usage;
        const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
        const contextTokensUsed =
          agentCfgContextTokens ??
          lookupContextTokens(modelUsed) ??
          sessionEntry?.contextTokens ??
          DEFAULT_CONTEXT_TOKENS;

        await persistSessionUsageUpdate({
          storePath,
          sessionKey,
          usage,
          modelUsed,
          providerUsed: fallbackProvider,
          contextTokensUsed,
          logLabel: "followup",
        });
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) return;
      const sanitizedPayloads = payloadArray.flatMap((payload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) return [payload];
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) return [];
        return [{ ...payload, text: stripped.text }];
      });
      const replyToChannel =
        queued.originatingChannel ??
        (queued.run.messageProvider?.toLowerCase() as OriginatingChannelType | undefined);
      const replyToMode = resolveReplyToMode(
        queued.run.config,
        replyToChannel,
        queued.originatingAccountId,
        queued.originatingChatType,
      );

      const replyTaggedPayloads: ReplyPayload[] = applyReplyThreading({
        payloads: sanitizedPayloads,
        replyToMode,
        replyToChannel,
      });

      const dedupedPayloads = filterMessagingToolDuplicates({
        payloads: replyTaggedPayloads,
        sentTexts: runResult.messagingToolSentTexts ?? [],
      });
      const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
        messageProvider: queued.run.messageProvider,
        messagingToolSentTargets: runResult.messagingToolSentTargets,
        originatingTo: queued.originatingTo,
        accountId: queued.run.agentAccountId,
      });
      
      // 声明 finalPayloads（提前声明，避免作用域问题）
      let finalPayloads = suppressMessagingToolReplies ? [] : dedupedPayloads;

      if (finalPayloads.length === 0) return;

      if (autoCompactionCompleted) {
        const count = await incrementCompactionCount({
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
        });
        if (queued.run.verboseLevel && queued.run.verboseLevel !== "off") {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          finalPayloads.unshift({
            text: `🧹 Auto-compaction complete${suffix}.`,
          });
        }
      }

      await sendFollowupPayloads(finalPayloads, queued);

      // 🆕 触发队列继续执行下一个任务
      if (queued.run.sessionKey) {
        const queueKey = queued.run.sessionKey;
        finalizeWithFollowup(undefined, queueKey, createFollowupRunner(params));
      }
    } catch (outerErr) {
      // 🔧 外层 catch：防止未捕获的异常（orchestrator 操作、payload 处理等）
      // 泄漏到 drain 循环导致整个队列停止
      const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
      console.error(`[followup-runner] ❌ Unhandled error in followup runner: ${msg}`);
      defaultRuntime.error?.(`Followup runner unhandled error: ${msg}`);
    } finally {
      // 🆕 进度报告器清理（停止所有定时器）
      progressReporter?.dispose();
      typing.markRunComplete();
      // 🔧 P12 修复：安全清理上下文（仅当 contextId 匹配时才清空，防止并行 runner 覆盖）
      clearCurrentFollowupRunContext(runId);
    }
  };
}
