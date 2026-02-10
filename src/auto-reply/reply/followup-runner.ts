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
import { setCurrentFollowupRunContext } from "../../agents/tools/enqueue-task-tool.js";
import { getGlobalOrchestrator } from "../../agents/tools/enqueue-task-tool.js";
import { buildSiblingContext } from "../../agents/memory/pipeline-integration.js";
import { createMemoryService } from "../../agents/memory/factory.js";
import { sendFallbackFile } from "./send-fallback-file.js";
import { collectTrackedFiles, clearTracking } from "../../agents/intelligent-task-decomposition/file-tracker.js";
import { deriveExecutionRole, createExecutionContext } from "../../agents/intelligent-task-decomposition/execution-context.js";
import type { SubTask, TaskTree, ExecutionContext } from "../../agents/intelligent-task-decomposition/types.js";
import type { Orchestrator } from "../../agents/intelligent-task-decomposition/orchestrator.js";

// ── P10: 输出验证门（OutputValidator）──
// 规则驱动，零 LLM 调用。在标记 completed 之前拦截明显无效输出。
type OutputFailureCode = "hallucinated_tool_calls" | "output_too_short" | "context_overflow_signal" | "llm_refusal" | "excessive_repetition";
interface OutputValidationResult {
  valid: boolean;
  failureCode?: OutputFailureCode;
  failureReason?: string;
  suggestedAction?: "retry" | "skip";
}

function validateSubTaskOutput(
  outputText: string,
  toolMetas: Array<{ toolName: string; [k: string]: unknown }>,
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

  // 规则 2：上下文溢出信号 — 输出极短且无文件工具调用
  const FILE_TOOLS = new Set(["write", "send_file", "read", "exec"]);
  const usedAnyTool = toolMetas.some((m) => FILE_TOOLS.has(m.toolName));
  if (!usedAnyTool && outputText.length < 200 && outputText.length > 0) {
    return {
      valid: false,
      failureCode: "context_overflow_signal",
      failureReason: `输出仅 ${outputText.length} 字符且无工具调用，疑似上下文溢出`,
      suggestedAction: "retry",
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

/**
 * 判断错误是否可重试
 */
function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  
  // 不可重试的错误类型
  const nonRetryablePatterns = [
    "prohibited_content",      // 内容违规
    "safety",                  // 安全策略
    "recitation",              // 版权内容
    "blocked",                 // 被阻止
    "content_filter",          // 内容过滤
    "policy_violation",        // 政策违规
    "invalid_request_error",   // 无效请求
    "authentication_error",    // 认证错误
    "invalid_argument",        // 无效参数
    "permission_denied",       // 权限拒绝
  ];
  
  // 检查是否是不可重试的错误
  for (const pattern of nonRetryablePatterns) {
    if (message.includes(pattern)) {
      return false;
    }
  }
  
  // 可重试的错误类型
  const retryablePatterns = [
    "timeout",                 // 超时
    "network",                 // 网络错误
    "rate_limit",              // 速率限制
    "overloaded",              // 服务器过载
    "internal_error",          // 内部错误
    "503",                     // 服务不可用
    "502",                     // 网关错误
    "504",                     // 网关超时
  ];
  
  // 检查是否是可重试的错误
  for (const pattern of retryablePatterns) {
    if (message.includes(pattern)) {
      return true;
    }
  }
  
  // 默认不重试
  return false;
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
}): Promise<void> {
  const FILE_TOOLS = new Set(["write", "send_file"]);
  const MIN_FALLBACK_CHARS = 500;
  const { subTask, outputText, toolMetas, sessionId, queued } = opts;

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

    // Session 瘦身：截断 session 文件中的最后一条超长 assistant 消息
    try {
      const sessionFilePath = queued.run.sessionFile;
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
    try {
      const runId = crypto.randomUUID();
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
              if (queued.run.sessionKey) {
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

        setCurrentFollowupRunContext({ 
          ...queued, 
          isQueueTask: effectiveIsQueueTask,
          isRootTask: isNewRoot,
          isNewRootTask: isNewRoot,
          taskDepth: effectiveDepth,
          rootTaskId: queued.rootTaskId,
          executionContext: execCtx,
        });
        
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
            return runEmbeddedPiAgent({
              sessionId: queued.run.sessionId,
              sessionKey: queued.run.sessionKey,
              messageProvider: queued.run.messageProvider,
              agentAccountId: queued.run.agentAccountId,
              messageTo: queued.originatingTo,
              messageThreadId: queued.originatingThreadId,
              groupId: queued.run.groupId,
              groupChannel: queued.run.groupChannel,
              groupSpace: queued.run.groupSpace,
              sessionFile: queued.run.sessionFile,
              workspaceDir: queued.run.workspaceDir,
              config: queued.run.config,
              skillsSnapshot: queued.run.skillsSnapshot,
              prompt: (() => {
                // 🔧 子任务强制落盘：在 prompt 本体注入指令（用户消息级，LLM 遵从度最高）
                const isSubTask = Boolean(queued.subTaskId);
                if (isSubTask) {
                  return `[⚠️ 强制规则] 你必须使用 write 工具将生成内容写入 .txt 文件（文件名含任务摘要），然后在聊天中仅回复简短确认。禁止将完整内容直接输出到聊天。\n\n${queued.prompt}`;
                }
                return queued.prompt;
              })(),
              extraSystemPrompt: (() => {
                // 🆕 子任务间上下文共享：注入已完成兄弟任务的输出摘要
                const siblingCtx = taskTree?.subTasks
                  ? buildSiblingContext(taskTree.subTasks)
                  : "";
                if (siblingCtx) {
                  console.log(`[followup-runner] 📋 Injecting sibling context (${siblingCtx.length} chars)`);
                }
                const base = queued.run.extraSystemPrompt ?? "";

                // 🔧 子任务强制落盘（二级强化，主指令已注入 prompt 本体）
                const isSubTask = Boolean(queued.subTaskId);
                const persistInstruction = isSubTask
                  ? "\n\n[SYSTEM] 子任务必须用 write 工具落盘，禁止纯文本输出。"
                  : "";

                const combined = [base, siblingCtx, persistInstruction].filter(Boolean).join("");
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
        
        // 🔧 如果找到了子任务，更新状态为 "completed" 并保存输出
        if (taskTree && subTask) {
          const payloadArray = runResult.payloads ?? [];
          const outputText = payloadArray.map((p) => p.text).filter(Boolean).join("\n");

          // 🆕 P10: 输出验证门 — 在标记 completed 之前拦截明显无效输出
          const validation = validateSubTaskOutput(outputText, runResult.toolMetas ?? []);
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
          subTask.status = "completed";
          
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
          
          // 🆕 V2 Phase 4: 兜底落盘（委托提取的辅助函数）
          await handleFallbackPersistence({
            subTask,
            outputText,
            toolMetas: runResult.toolMetas ?? [],
            sessionId,
            queued,
          });
          
          // 🆕 V2 Phase 4: 统一后处理（onTaskCompleted 钩子替代散装逻辑）
          // 内部编排：postProcess + 质量评估 + 轮次完成检查 + markRoundCompleted
          try {
            const postResult = await orchestrator.onTaskCompleted(taskTree, subTask, queued.rootTaskId);

            if (postResult.needsRequeue) {
              console.log(
                `[followup-runner] 🔄 子任务 ${subTask.id} 质量不达标，重新入队 (restart): ` +
                `${JSON.stringify(postResult.findings)}`,
              );
              if (queued.run.sessionKey) {
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }

            if (postResult.markedFailed) {
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

            console.log(`[followup-runner] ✅ Sub task completed: ${subTask.id}`);

            // 轮次完成后续处理（由 onTaskCompleted 内部判定并设置标志）
            if (postResult.roundCompleted && postResult.completedRoundId) {
              console.log(`[followup-runner] 🏁 Round completed: ${postResult.completedRoundId} (tree: ${taskTree.id})`);
              taskTree = (await orchestrator.loadTaskTree(sessionId)) ?? taskTree;

              // 委托 onRoundCompleted 钩子：合并输出 + 交付报告
              const roundResult = await orchestrator.onRoundCompleted(taskTree, postResult.completedRoundId);

              // 发送合并文件 + 复制到用户工作目录
              if (roundResult.mergedFilePath) {
                // 🆕 P8 临时措施：将系统合并文件复制到用户工作目录
                let userCopyPath: string | undefined;
                try {
                  const wsDir = queued.run.workspaceDir;
                  if (wsDir) {
                    const outputDir = path.join(wsDir, "output");
                    await fs.mkdir(outputDir, { recursive: true });
                    // 从任务树目标生成语义化文件名
                    const rootGoal = taskTree.rootTask?.substring(0, 30)?.replace(/[\\/:*?"<>|\n\r]/g, "_") ?? "output";
                    const copyName = `${rootGoal}_完整版.txt`;
                    userCopyPath = path.join(outputDir, copyName);
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
          clearTracking(subTask.id);
          const failDecision = await orchestrator.onTaskFailed(taskTree, subTask, err);

          if (failDecision.needsRequeue) {
            console.warn(`[followup-runner] ⚠️ ${failDecision.reason}`);
            if (queued.run.sessionKey) {
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

      // 注意：不再自动发送任务进度提示
      // 用户可以通过调用 show_task_board 工具主动查看任务看板

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
      typing.markRunComplete();
      // 🔧 清理全局上下文
      setCurrentFollowupRunContext(null);
    }
  };
}
