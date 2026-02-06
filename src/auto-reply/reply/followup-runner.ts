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
import { DeliveryReporter } from "../../agents/intelligent-task-decomposition/delivery-reporter.js";
import { sendFallbackFile } from "./send-fallback-file.js";

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
      // 注意：只有通过 enqueue_task 创建的任务才会有对应的子任务
      let taskTree = await orchestrator.loadTaskTree(sessionId);
      let subTask = taskTree?.subTasks.find(
        (task) => task.prompt === queued.prompt && task.status === "pending"
      );
      
      // 🔧 如果找到了子任务，更新状态为 "active"
      if (taskTree && subTask) {
        console.log(`[followup-runner] 🔍 Found sub task in tree: ${subTask.id}`);
        await orchestrator.saveTaskTree(taskTree);
      }
      
      let autoCompactionCompleted = false;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      try {
        // 🔧 设置全局上下文（融合方案 1+2+3）
        // 双保险：isRootTask 或 isNewRootTask 任一为 true 即视为根任务
        const isRootTask = queued.isRootTask ?? false;
        const isNewRoot = queued.isNewRootTask ?? false;
        const effectiveIsRoot = isRootTask || isNewRoot;
        
        setCurrentFollowupRunContext({ 
          ...queued, 
          isQueueTask: !effectiveIsRoot,  // 根任务不标记为队列任务
          isRootTask: effectiveIsRoot,     // 双保险恢复根任务语义
          isNewRootTask: isNewRoot,        // 传播 isNewRootTask 标记
          taskDepth: queued.taskDepth ?? 0, // 传播任务树深度
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
              prompt: queued.prompt,
              extraSystemPrompt: (() => {
                // 🆕 子任务间上下文共享：注入已完成兄弟任务的输出摘要
                const siblingCtx = taskTree?.subTasks
                  ? buildSiblingContext(taskTree.subTasks)
                  : "";
                if (siblingCtx) {
                  console.log(`[followup-runner] 📋 Injecting sibling context (${siblingCtx.length} chars)`);
                }
                const base = queued.run.extraSystemPrompt ?? "";
                return siblingCtx ? `${base}${siblingCtx}` : base || undefined;
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
          subTask.output = outputText;
          subTask.completedAt = Date.now();
          subTask.status = "completed";
          
          // 🆕 兜底落盘：检测 LLM 是否偷懒（生成了大段内容但未调用 write 工具落盘）
          const FILE_TOOLS = new Set(["write", "send_file"]);
          const MIN_FALLBACK_CHARS = 500;
          const toolMetas = runResult.toolMetas ?? [];
          const usedFileTool = toolMetas.some((m) => FILE_TOOLS.has(m.toolName));
          
          if (!usedFileTool && outputText.length >= MIN_FALLBACK_CHARS) {
            try {
              const taskDir = path.join(
                os.homedir(), ".clawdbot", "tasks", sessionId, "fallback-outputs",
              );
              await fs.mkdir(taskDir, { recursive: true });
              const safeId = (subTask.id ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "_");
              const fallbackFile = path.join(taskDir, `${safeId}.txt`);
              await fs.writeFile(fallbackFile, outputText, "utf-8");
              console.log(
                `[followup-runner] 📝 兜底落盘：LLM 未调用 write 工具，已自动保存 ${outputText.length} 字到 ${fallbackFile}`,
              );
              // 记录到子任务元数据
              if (!subTask.metadata) subTask.metadata = {};
              subTask.metadata.fallbackFilePath = fallbackFile;
              subTask.metadata.fallbackReason = "LLM 未调用 write 工具，系统自动兜底落盘";
              
              // 🆕 立即发送兜底文件到用户的聊天频道
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
            } catch (fallbackErr) {
              console.warn(`[followup-runner] ⚠️ 兜底落盘失败: ${fallbackErr}`);
            }
          }
          
          await orchestrator.saveTaskTree(taskTree);
          console.log(`[followup-runner] ✅ Sub task completed: ${subTask.id}`);
          
          // 🆕 检查任务树是否全部完成，异步归档到记忆系统
          const allDone = taskTree.subTasks.every(
            (t) => t.status === "completed" || t.status === "failed",
          );
          if (allDone) {
            taskTree.status = taskTree.subTasks.some((t) => t.status === "failed")
              ? "failed"
              : "completed";
            await orchestrator.saveTaskTree(taskTree);
            console.log(`[followup-runner] 🏁 Task tree ${taskTree.status}: ${taskTree.id}`);
            
            // 异步归档（fire-and-forget，不阻塞主流程）
            try {
              const memService = createMemoryService(queued.run.config, "main");
              if (memService) {
                const completedCount = taskTree.subTasks.filter((t) => t.status === "completed").length;
                const totalCount = taskTree.subTasks.length;
                const archiveSummary = {
                  taskGoal: taskTree.rootTask ?? "任务树",
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
                };
                memService.archive({
                  summary: archiveSummary,
                  context: {
                    userId: queued.run.agentAccountId ?? "default",
                    sessionId,
                  },
                }).catch((err) => console.warn(`[followup-runner] Memory archive failed: ${err}`));
              }
            } catch {
              // 归档失败不影响主流程
            }

            // 🆕 Step 6a: 合并兜底落盘文件并发送给用户
            const fallbackTasks = taskTree.subTasks.filter(
              (t) => t.status === "completed" && t.metadata?.fallbackFilePath,
            );
            if (fallbackTasks.length > 0) {
              try {
                const mergedDir = path.join(
                  os.homedir(), ".clawdbot", "tasks", sessionId, "fallback-outputs",
                );
                await fs.mkdir(mergedDir, { recursive: true });
                const mergedFile = path.join(mergedDir, "merged_output.txt");
                const mergedContent = fallbackTasks
                  .map((t) => t.output ?? "")
                  .filter(Boolean)
                  .join("\n\n---\n\n");
                await fs.writeFile(mergedFile, mergedContent, "utf-8");
                console.log(
                  `[followup-runner] 📝 已合并 ${fallbackTasks.length} 个兜底落盘文件到 ${mergedFile}（${mergedContent.length} 字）`,
                );
                // 🆕 发送合并后的兜底文件到用户的聊天频道
                const mergedSendResult = await sendFallbackFile({
                  filePath: mergedFile,
                  caption: `📝 完整输出（${fallbackTasks.length} 个子任务合并）`,
                  queued,
                });
                if (!mergedSendResult.ok) {
                  // 文件发送失败时降级为文本通知
                  console.warn(
                    `[followup-runner] ⚠️ 合并文件发送失败 (${mergedSendResult.method}): ${mergedSendResult.error}`,
                  );
                  await sendFollowupPayloads([{
                    text: `📝 系统检测到 ${fallbackTasks.length} 个子任务的内容未被 LLM 主动落盘为文件，已自动保存到：\n${mergedFile}`,
                  }], queued);
                }
              } catch (mergeErr) {
                console.warn(`[followup-runner] ⚠️ 合并兜底落盘文件失败: ${mergeErr}`);
              }
            }

            // 🆕 Step 6b: 生成并发送结构化交付报告（支持 HTML）
            try {
              const reporter = new DeliveryReporter();
              const report = reporter.generateReport(taskTree);
              
              // 🆕 根据频道类型选择格式
              const { selectFormatter } = require("../../agents/intelligent-task-decomposition/report-formatter.js");
              const originatingChannel = queued.originatingChannel;
              const formatter = selectFormatter(originatingChannel);
              
              const formattedReport = formatter.format(report);
              const isHTML = formatter.constructor.name === "HTMLFormatter";
              
              await sendFollowupPayloads([{ 
                text: formattedReport,
                ...(isHTML && { parseMode: "HTML" })
              }], queued);
              
              console.log(`[followup-runner] 📦 Delivery report sent (${report.statistics.successRate} success, format=${formatter.constructor.name})`);
            } catch (reportErr) {
              console.warn(`[followup-runner] ⚠️ Delivery report failed: ${reportErr}`);
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        
        // 🔧 检查错误类型
        const isRetryable = isRetryableError(err);
        
        // 🔧 如果找到了子任务，更新状态并保存错误信息
        if (taskTree && subTask) {
          subTask.error = message;
          subTask.retryCount++;
          
          if (isRetryable && subTask.retryCount < 3) {
            // ✅ 可重试错误，标记为 "pending" 并重新入队
            subTask.status = "pending";
            await orchestrator.saveTaskTree(taskTree);
            console.warn(`[followup-runner] ⚠️ Sub task failed (retryable), will retry: ${subTask.id} (attempt ${subTask.retryCount}/3)`);
            
            // 重新入队
            if (queued.run.sessionKey) {
              const queueKey = queued.run.sessionKey;
              finalizeWithFollowup(undefined, queueKey, createFollowupRunner(params));
            }
          } else {
            // ❌ 不可重试错误或重试次数用尽，标记为 "failed"
            subTask.status = "failed";
            await orchestrator.saveTaskTree(taskTree);
            
            // 更新任务树状态
            const anyFailed = taskTree.subTasks.some((t) => t.status === "failed");
            if (anyFailed) {
              taskTree.status = "failed";
              await orchestrator.saveTaskTree(taskTree);
            }
            
            console.error(`[followup-runner] ❌ Sub task failed (non-retryable or max retries): ${subTask.id} - ${message}`);
            
            // ❌ 停止执行后续任务
            console.error(`[followup-runner] ❌ Task tree failed, stopping queue: ${taskTree.id}`);
            // 不再调用 finalizeWithFollowup，停止队列执行
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
    } finally {
      typing.markRunComplete();
      // 🔧 清理全局上下文
      setCurrentFollowupRunContext(null);
    }
  };
}
