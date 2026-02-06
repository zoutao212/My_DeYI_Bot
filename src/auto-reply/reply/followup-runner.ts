import crypto from "node:crypto";
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
        // 🔧 设置全局上下文：正在执行队列任务
        // 检查是否是根任务
        const isRootTask = queued.isRootTask ?? false;
        
        setCurrentFollowupRunContext({ 
          ...queued, 
          isQueueTask: !isRootTask,  // 🆕 根任务不标记为队列任务
          isRootTask: isRootTask      // 🆕 保留根任务标记
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
              extraSystemPrompt: queued.run.extraSystemPrompt,
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
          
          await orchestrator.saveTaskTree(taskTree);
          console.log(`[followup-runner] ✅ Sub task completed: ${subTask.id}`);
          
          // 注意：不在这里添加进度提示，而是在后面单独发送简化的进度消息
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
