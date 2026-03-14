import crypto from "node:crypto";
import fs from "node:fs";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveContextWindowInfo } from "../../agents/context-window-guard.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { defaultRuntime } from "../../runtime.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  finalizeWithFollowup,
  isAudioPayload,
  signalTypingIfNeeded,
} from "./agent-runner-helpers.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-utils.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveBlockStreamingCoalescing } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import { enqueueFollowupRun, scheduleFollowupDrain, type FollowupRun, type QueueSettings } from "./queue.js";
import { setCurrentFollowupRunContext, clearCurrentFollowupRunContext } from "../../agents/tools/enqueue-task-tool.js";
import { getGlobalOrchestrator } from "../../agents/tools/enqueue-task-tool.js";
import { createExecutionContext } from "../../agents/intelligent-task-decomposition/execution-context.js";
import { TaskEventLogger } from "../../agents/intelligent-task-decomposition/task-event-logger.js";
import { appendLoopLedgerEntry } from "../../agents/intelligent-task-decomposition/loop-ledger.js";
import { clearCommandLane, getQueueSize } from "../../process/command-queue.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { hasControlCommand } from "../command-detection.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  analyzeIntentComplexity,
  buildComplexityGuidance,
  getActiveContext,
  setActiveContext,
  type TaskIntelligenceContext,
} from "../../agents/intelligent-task-decomposition/intent-complexity-analyzer.js";
import { applySessionHints } from "./body.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import type { TypingController } from "./typing.js";
import { createTypingSignaler } from "./typing-mode.js";
import { resolveReplyToMode, createReplyToModeFilterForChannel } from "./reply-threading.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { incrementCompactionCount } from "./session-updates.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

async function _appendTaskEvent(sessionId: string, type: any, data: Record<string, unknown>): Promise<void> {
  try {
    const logger = new TaskEventLogger(sessionId);
    await logger.append(type, data);
  } catch {
    // 事件流是旁路审计，不允许阻塞主流程。
  }
}

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  } = params;

  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;

  // 自主程度指令（会话级）：允许用户一句话切换 quiet/normal/proactive。
  // 旁路原则：任何异常都不阻塞本轮回复。
  try {
    const msg = followupRun.prompt ?? "";
    const sessionId = followupRun.run.sessionId;

    const desiredLevel = (() => {
      if (/(安静|别吵|少说|别那么主动|降低主动)/.test(msg)) return "quiet" as const;
      if (/(积极|主动一点|加速|更主动|放开跑|推进起来)/.test(msg)) return "proactive" as const;
      if (/(默认|正常|恢复默认|恢复正常)/.test(msg)) return "normal" as const;
      return undefined;
    })();

    if (desiredLevel && storePath && sessionKey) {
      const prev =
        activeSessionEntry?.autonomyLevel ??
        (sessionKey ? activeSessionStore?.[sessionKey]?.autonomyLevel : undefined) ??
        "normal";
      if (prev !== desiredLevel) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            autonomyLevel: desiredLevel,
            autonomyLevelUpdatedAt: Date.now(),
            updatedAt: Date.now(),
          }),
        });
        await _appendTaskEvent(sessionId, "autonomy_level_changed", {
          from: prev,
          to: desiredLevel,
          reason: "user_message",
        });
      }
    }
  } catch {
    // ignore
  }

  // 机会型 Watchdog：每次用户 turn 入口检查一次，避免 closing/task 卡死导致“陪伴断线”。
  // 旁路原则：任何异常都不阻塞本轮回复。
  try {
    const watchdogSessionId = followupRun.run.sessionId;
    const currentMode = activeSessionEntry?.agentMode;
    const modeUpdatedAt = activeSessionEntry?.agentModeUpdatedAt ?? 0;
    const now = Date.now();
    const CLOSING_STUCK_MS = 3 * 60_000;

    if (storePath && sessionKey) {
      if (currentMode === "closing" && modeUpdatedAt > 0 && now - modeUpdatedAt > CLOSING_STUCK_MS) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            agentMode: "dialog",
            agentModeReason: "watchdog:closing_stuck",
            agentModeUpdatedAt: now,
            updatedAt: now,
          }),
        });
        await _appendTaskEvent(watchdogSessionId, "watchdog_recovered", {
          from: "closing",
          to: "dialog",
          reason: "closing_stuck",
          modeUpdatedAt,
        });
      }
    }

    if (currentMode === "task") {
      const orchestrator = getGlobalOrchestrator();
      const hasUnfinished = await orchestrator.hasUnfinishedTasks(watchdogSessionId);
      if (!hasUnfinished && storePath && sessionKey) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            agentMode: "dialog",
            agentModeReason: "watchdog:task_empty",
            agentModeUpdatedAt: now,
            updatedAt: now,
          }),
        });
        await _appendTaskEvent(watchdogSessionId, "watchdog_recovered", {
          from: "task",
          to: "dialog",
          reason: "task_empty",
        });
      }
    }
  } catch {
    // ignore
  }

  const isHeartbeat = opts?.isHeartbeat === true;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });

  const shouldEmitToolResult = createShouldEmitToolResult({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });
  const shouldEmitToolOutput = createShouldEmitToolOutput({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;

  const replyToChannel =
    sessionCtx.OriginatingChannel ??
    ((sessionCtx.Surface ?? sessionCtx.Provider)?.toLowerCase() as
      | OriginatingChannelType
      | undefined);
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const blockReplyCoalescing =
    blockStreamingEnabled && opts?.onBlockReply
      ? resolveBlockStreamingCoalescing(
          cfg,
          sessionCtx.Provider,
          sessionCtx.AccountId,
          blockReplyChunking,
        )
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && opts?.onBlockReply
      ? createBlockReplyPipeline({
          onBlockReply: opts.onBlockReply,
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;

  if (shouldSteer && isStreaming) {
    const steered = queueEmbeddedPiMessage(followupRun.run.sessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      if (activeSessionEntry && activeSessionStore && sessionKey) {
        const updatedAt = Date.now();
        activeSessionEntry.updatedAt = updatedAt;
        activeSessionStore[sessionKey] = activeSessionEntry;
        if (storePath) {
          await updateSessionStoreEntry({
            storePath,
            sessionKey,
            update: async () => ({ updatedAt }),
          });
        }
      }
      typing.cleanup();
      return undefined;
    }
  }

  // 🔧 修复：不自动加入用户消息到队列
  // 原因：LLM 会通过 enqueue_task 工具自己创建队列任务
  // 如果自动加入用户消息，会导致队列中的第一个任务是用户消息，而不是 LLM 创建的任务
  console.log(`[agent-runner] 🔍 Checking followup: shouldFollowup=${shouldFollowup}, resolvedQueue.mode=${resolvedQueue.mode}, isActive=${isActive}`);
  
  if (shouldFollowup || resolvedQueue.mode === "steer") {
    // 🔧 不要自动加入用户消息！让 LLM 通过 enqueue_task 工具自己创建队列任务
    console.log(`[agent-runner] ⚠️ Skipping user message enqueue (LLM will create queue tasks via enqueue_task tool)`);

    // 🧩 兜底：当 CP0 判断为复杂任务（suggest/force）时，避免把“入队”完全交给 LLM 自觉。
    // 否则一旦模型本轮未调用 enqueue_task，就会出现“聊两句就结束/分解不足”。
    try {
      const sk = sessionKey?.trim();
      const cp0 = sk ? getActiveContext(sk)?.intentAnalysis : undefined;
      const autonomyLevel =
        activeSessionEntry?.autonomyLevel ??
        (sessionKey ? activeSessionStore?.[sessionKey]?.autonomyLevel : undefined) ??
        "normal";

      const allowByAutonomy = (() => {
        if (!cp0) return false;
        if (autonomyLevel === "quiet") return cp0.strategy === "force_decompose";
        if (autonomyLevel === "proactive") return cp0.strategy !== "direct";
        return cp0.strategy === "force_decompose" || cp0.strategy === "suggest_decompose";
      })();

      const shouldFallbackEnqueue =
        Boolean(cp0 && allowByAutonomy) &&
        (resolvedQueue.mode === "collect" ||
          resolvedQueue.mode === "followup" ||
          resolvedQueue.mode === "steer-backlog");
      if (shouldFallbackEnqueue && queueKey) {
        const orchestrator = getGlobalOrchestrator();
        const sessionId = followupRun.run.sessionId;
        const userMessage = followupRun.prompt;
        const roundId = followupRun.rootTaskId ?? crypto.randomUUID();

        const ensureAgentMode = async (mode: "dialog" | "task" | "closing", reason: string) => {
          if (!storePath || !sessionKey) return;
          await updateSessionStoreEntry({
            storePath,
            sessionKey,
            update: async () => ({
              agentMode: mode,
              agentModeReason: reason,
              agentModeUpdatedAt: Date.now(),
              updatedAt: Date.now(),
            }),
          });
        };

        await ensureAgentMode("task", `CP0:${cp0?.strategy ?? "unknown"}`);
        await _appendTaskEvent(sessionId, "agent_mode_changed", {
          to: "task",
          reason: `CP0:${cp0?.strategy ?? "unknown"}`,
          autonomyLevel,
        });

        let taskTree = await orchestrator.loadTaskTree(sessionId);
        if (!taskTree) {
          taskTree = await orchestrator.initializeTaskTree(userMessage, sessionId);
        }
        if (!taskTree.metadata) {
          taskTree.metadata = { totalTasks: taskTree.subTasks.length, completedTasks: 0, failedTasks: 0 };
        }
        taskTree.metadata.agentMode = "task";
        taskTree.metadata.agentModeReason = `CP0:${cp0?.strategy ?? "unknown"}`;
        taskTree.metadata.agentModeUpdatedAt = Date.now();

        orchestrator.getOrCreateRound(taskTree, roundId, userMessage);
        await orchestrator.saveTaskTree(taskTree);

        const subTask = await orchestrator.addSubTask(
          taskTree,
          userMessage,
          followupRun.summaryLine ?? userMessage.substring(0, 80),
          undefined,
          false,
          roundId,
        );

        const didEnqueue = enqueueFollowupRun(
          queueKey,
          {
            ...followupRun,
            enqueuedAt: Date.now(),
            rootTaskId: roundId,
            subTaskId: subTask.id,
            isQueueTask: false,
            isRootTask: true,
            isNewRootTask: true,
            taskDepth: 0,
          },
          resolvedQueue,
          "message-id",
        );
        if (didEnqueue) {
          console.log(
            `[agent-runner] 🧩 Fallback enqueue enabled by CP0 (strategy=${cp0?.strategy ?? "unknown"}, roundId=${roundId}, subTaskId=${subTask.id})`,
          );
          await _appendTaskEvent(sessionId, "fallback_enqueued", {
            roundId,
            subTaskId: subTask.id,
            strategy: cp0?.strategy ?? "unknown",
            autonomyLevel,
            queueMode: resolvedQueue.mode,
          });
        }
      }
    } catch (err) {
      console.warn(`[agent-runner] ⚠️ Fallback enqueue failed (non-blocking):`, err);
    }
    
    if (activeSessionEntry && activeSessionStore && sessionKey) {
      const updatedAt = Date.now();
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({ updatedAt }),
        });
      }
    }
    // 🔧 只有在 isActive 时才 cleanup typing 和 return
    if (isActive) {
      typing.cleanup();
      return undefined;
    }
  } else {
    console.log(`[agent-runner] ❌ Not enqueuing: shouldFollowup=${shouldFollowup}, mode=${resolvedQueue.mode}`);
  }

  await typingSignals.signalRunStart();

  // 🆕 意图分类驱动的任务恢复/归档决策
  // 解决核心问题：旧任务已完成时，系统总是把新任务塞进旧任务树
  const orchestrator = getGlobalOrchestrator();
  const sessionId = followupRun.run.sessionId;
  const hasUnfinished = await orchestrator.hasUnfinishedTasks(sessionId);
  
  if (hasUnfinished) {
    // Step 1: 分类用户意图（规则预分类 + LLM 分类）
    const userMessage = followupRun.prompt;
    const intentResult = await orchestrator.classifyUserIntent(userMessage, sessionId);
    
    if (intentResult) {
      console.log(
        `[agent-runner] 🧠 意图分类：${intentResult.intent}（置信度=${intentResult.confidence}，` +
        `降级=${intentResult.isFallback}），理由：${intentResult.reason}`
      );
      
      if (intentResult.intent === "new_task") {
        // Step 2a: 新任务 → 归档旧任务树，跳过恢复
        console.log(`[agent-runner] 📦 检测到新任务，归档旧任务树并跳过恢复`);
        try {
          await orchestrator.archiveTaskTree(sessionId, `用户发起新任务：${userMessage.substring(0, 100)}`);
        } catch (err) {
          console.warn(`[agent-runner] ⚠️ 归档旧任务树失败（不阻塞）:`, err);
        }
      } else {
        // Step 2b: 续接/调整 → 正常恢复旧任务
        console.log(`[agent-runner] 🔄 检测到续接/调整意图，恢复旧任务树`);
        try {
          const recoveredTaskTree = await orchestrator.recoverUnfinishedTasks(sessionId);
          console.log(`[agent-runner] ✅ Task tree recovered: ${recoveredTaskTree.id}`);
          const interruptedTasks = await orchestrator.reexecuteInterruptedTasks(recoveredTaskTree);
          console.log(`[agent-runner] ✅ Re-executed ${interruptedTasks.length} interrupted tasks`);
        } catch (err) {
          console.error(`[agent-runner] ❌ Failed to recover tasks:`, err);
        }
      }
    } else {
      // 无旧任务树（不应该走到这里，因为 hasUnfinished=true）
      console.log(`[agent-runner] 🔍 Found unfinished tasks but no task tree for intent classification`);
      try {
        const recoveredTaskTree = await orchestrator.recoverUnfinishedTasks(sessionId);
        console.log(`[agent-runner] ✅ Task tree recovered: ${recoveredTaskTree.id}`);
        const interruptedTasks = await orchestrator.reexecuteInterruptedTasks(recoveredTaskTree);
        console.log(`[agent-runner] ✅ Re-executed ${interruptedTasks.length} interrupted tasks`);
      } catch (err) {
        console.error(`[agent-runner] ❌ Failed to recover tasks:`, err);
      }
    }
  }

  // 🔧 设置全局上下文，让 enqueue_task 工具可以访问当前的 FollowupRun
  // isQueueTask = false 表示这不是队列任务（是用户直接发送的消息）
  // isRootTask = true 表示这是根任务（允许分解子任务）
  // 🔧 P12 修复：传入 contextId 防止并行 runner 竞态清空
  const agentRunContextId = crypto.randomUUID();
  // 🆕 V8 P0: 解析模型 contextWindow 信息，供子任务的 ContextBudgetManager 做预算分配
  const ctxWindowInfo = resolveContextWindowInfo({
    cfg: followupRun.run.config,
    provider: followupRun.run.provider,
    modelId: followupRun.run.model,
    defaultTokens: agentCfgContextTokens ?? DEFAULT_CONTEXT_TOKENS,
  });
  setCurrentFollowupRunContext({ 
    ...followupRun, 
    isQueueTask: false,
    isRootTask: true,  // 🆕 标记为根任务
    modelContextWindow: ctxWindowInfo.tokens,
    modelMaxOutputTokens: 4096,  // 子任务的默认 maxTokens（runEmbeddedPiAgent 内部也默认 4096-8192）
    executionContext: createExecutionContext({
      role: "user",
      roundId: followupRun.rootTaskId ?? "",
      depth: followupRun.taskDepth ?? 0,
    }),
  }, agentRunContextId);

  activeSessionEntry = await runMemoryFlushIfNeeded({
    cfg,
    followupRun,
    sessionCtx,
    opts,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    isHeartbeat,
  });

  const runFollowupTurn = createFollowupRunner({
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  });

  let responseUsageLine: string | undefined;
  type SessionResetOptions = {
    failureLabel: string;
    buildLogMessage: (nextSessionId: string) => string;
    cleanupTranscripts?: boolean;
  };
  const resetSession = async ({
    failureLabel,
    buildLogMessage,
    cleanupTranscripts,
  }: SessionResetOptions): Promise<boolean> => {
    if (!sessionKey || !activeSessionStore || !storePath) return false;
    const prevEntry = activeSessionStore[sessionKey] ?? activeSessionEntry;
    if (!prevEntry) return false;
    const prevSessionId = cleanupTranscripts ? prevEntry.sessionId : undefined;
    const nextSessionId = crypto.randomUUID();
    const nextEntry: SessionEntry = {
      ...prevEntry,
      sessionId: nextSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
    };
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const nextSessionFile = resolveSessionTranscriptPath(
      nextSessionId,
      agentId,
      sessionCtx.MessageThreadId,
    );
    nextEntry.sessionFile = nextSessionFile;
    activeSessionStore[sessionKey] = nextEntry;
    try {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = nextEntry;
      });
    } catch (err) {
      defaultRuntime.error(
        `Failed to persist session reset after ${failureLabel} (${sessionKey}): ${String(err)}`,
      );
    }
    followupRun.run.sessionId = nextSessionId;
    followupRun.run.sessionFile = nextSessionFile;
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    defaultRuntime.error(buildLogMessage(nextSessionId));
    if (cleanupTranscripts && prevSessionId) {
      const transcriptCandidates = new Set<string>();
      const resolved = resolveSessionFilePath(prevSessionId, prevEntry, { agentId });
      if (resolved) transcriptCandidates.add(resolved);
      transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
      for (const candidate of transcriptCandidates) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    return true;
  };
  const resetSessionAfterCompactionFailure = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "compaction failure",
      buildLogMessage: (nextSessionId) =>
        `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
    });
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
  try {
    const runStartedAt = Date.now();
    const runOutcome = await runAgentTurnWithFallback({
      commandBody,
      followupRun,
      sessionCtx,
      opts,
      typingSignals,
      blockReplyPipeline,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      applyReplyToMode,
      shouldEmitToolResult,
      shouldEmitToolOutput,
      pendingToolTasks,
      resetSessionAfterCompactionFailure,
      resetSessionAfterRoleOrderingConflict,
      isHeartbeat,
      sessionKey,
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath,
      resolvedVerboseLevel,
    });

    if (runOutcome.kind === "final") {
      return finalizeWithFollowup(runOutcome.payload, queueKey, runFollowupTurn);
    }

    const { runResult, fallbackProvider, fallbackModel, directlySentBlockKeys } = runOutcome;
    let { didLogHeartbeatStrip, autoCompactionCompleted } = runOutcome;

    if (
      shouldInjectGroupIntro &&
      activeSessionEntry &&
      activeSessionStore &&
      sessionKey &&
      activeSessionEntry.groupActivationNeedsSystemIntro
    ) {
      const updatedAt = Date.now();
      activeSessionEntry.groupActivationNeedsSystemIntro = false;
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            groupActivationNeedsSystemIntro: false,
            updatedAt,
          }),
        });
      }
    }

    const payloadArray = runResult.payloads ?? [];

    if (blockReplyPipeline) {
      await blockReplyPipeline.flush({ force: true });
      blockReplyPipeline.stop();
    }
    if (pendingToolTasks.size > 0) {
      await Promise.allSettled(pendingToolTasks);
    }

    const usage = runResult.meta.agentMeta?.usage;
    const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta.agentMeta?.sessionId?.trim()
      : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      lookupContextTokens(modelUsed) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage,
      modelUsed,
      providerUsed,
      contextTokensUsed,
      systemPromptReport: runResult.meta.systemPromptReport,
      cliSessionId,
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0)
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);

    const payloadResult = buildReplyPayloads({
      payloads: payloadArray,
      isHeartbeat,
      didLogHeartbeatStrip,
      blockStreamingEnabled,
      blockReplyPipeline,
      directlySentBlockKeys,
      replyToMode,
      replyToChannel,
      currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      originatingTo: sessionCtx.OriginatingTo ?? sessionCtx.To,
      accountId: sessionCtx.AccountId,
    });
    const { replyPayloads } = payloadResult;
    didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;

    if (replyPayloads.length === 0)
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);

    await signalTypingIfNeeded(replyPayloads, typingSignals);

    if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const promptTokens = input + cacheRead + cacheWrite;
      const totalTokens = usage.total ?? promptTokens + output;
      const costConfig = resolveModelCostConfig({
        provider: providerUsed,
        model: modelUsed,
        config: cfg,
      });
      const costUsd = estimateUsageCost({ usage, cost: costConfig });
      emitDiagnosticEvent({
        type: "model.usage",
        sessionKey,
        sessionId: followupRun.run.sessionId,
        channel: replyToChannel,
        provider: providerUsed,
        model: modelUsed,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          promptTokens,
          total: totalTokens,
        },
        context: {
          limit: contextTokensUsed,
          used: totalTokens,
        },
        costUsd,
        durationMs: Date.now() - runStartedAt,
      });
    }

    const responseUsageRaw =
      activeSessionEntry?.responseUsage ??
      (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
    const responseUsageMode = resolveResponseUsageMode(responseUsageRaw);
    if (responseUsageMode !== "off" && hasNonzeroUsage(usage)) {
      const authMode = resolveModelAuthMode(providerUsed, cfg);
      const showCost = authMode === "api-key";
      const costConfig = showCost
        ? resolveModelCostConfig({
            provider: providerUsed,
            model: modelUsed,
            config: cfg,
          })
        : undefined;
      let formatted = formatResponseUsageLine({
        usage,
        showCost,
        costConfig,
      });
      if (formatted && responseUsageMode === "full" && sessionKey) {
        formatted = `${formatted} · session ${sessionKey}`;
      }
      if (formatted) responseUsageLine = formatted;
    }

    // If verbose is enabled and this is a new session, prepend a session hint.
    let finalPayloads = replyPayloads;

    try {
      const sk = sessionKey?.trim();
      const cp0 = sk ? getActiveContext(sk)?.intentAnalysis : undefined;
      const autonomyLevel =
        activeSessionEntry?.autonomyLevel ??
        (sessionKey ? activeSessionStore?.[sessionKey]?.autonomyLevel : undefined) ??
        "normal";
      const modeHint = cp0?.strategy && cp0.strategy !== "direct" ? "task" : "dialog";
      const nextActionLine = (() => {
        if (modeHint === "task") {
          if (autonomyLevel === "quiet") {
            return "NextAction: 我会在你确认后进入任务推进。你可以补充：验收标准 / 文件路径 / 优先级。";
          }
          return "NextAction: 我会自动进入任务推进（agent loop）。你可以补充：验收标准 / 文件路径 / 优先级。";
        }
        if (autonomyLevel === "proactive") {
          return "NextAction: 我可以立刻把它拆成可执行步骤并入队推进；你只要确认目标与边界条件。";
        }
        return "NextAction: 如果你愿意，我可以把这件事拆成可执行步骤，或直接给出最小可落地改动建议。";
      })();

      // 🧾 LoopLedger（最小落盘）：每轮记录一次“我打算怎么继续”。
      // 旁路原则：失败不阻塞回复。
      try {
        await appendLoopLedgerEntry({
          sessionId: followupRun.run.sessionId,
          phase: modeHint,
          reason: "next_action_generated",
          autonomyLevel,
          agentMode: activeSessionEntry?.agentMode,
          cp0Strategy: cp0?.strategy,
          roundId: followupRun.rootTaskId,
          nextAction: nextActionLine,
          reflection: {
            summary: modeHint === "task" ? "进入任务推进" : "保持对话陪伴",
            openQuestions: modeHint === "task" ? ["验收标准/输入文件路径/优先级？"] : undefined,
          },
        });
      } catch {
        // ignore
      }

      const lastTextIdx = (() => {
        for (let i = finalPayloads.length - 1; i >= 0; i--) {
          const t = finalPayloads[i]?.text;
          if (typeof t === "string" && t.trim().length > 0) return i;
        }
        return -1;
      })();

      if (lastTextIdx >= 0) {
        const existing = finalPayloads[lastTextIdx].text ?? "";
        if (!/\bNextAction\b\s*:/i.test(existing)) {
          finalPayloads = finalPayloads.map((p, idx) =>
            idx === lastTextIdx && p.text
              ? { ...p, text: `${p.text}\n\n${nextActionLine}` }
              : p,
          );
        }
      }
    } catch {
      // 非关键路径：NextAction 追加失败不阻塞
    }
    const verboseEnabled = resolvedVerboseLevel !== "off";
    if (autoCompactionCompleted) {
      const count = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
      });
      if (verboseEnabled) {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        finalPayloads = [{ text: `🧹 Auto-compaction complete${suffix}.` }, ...finalPayloads];
      }
    }
    if (verboseEnabled && activeIsNewSession) {
      finalPayloads = [{ text: `🧭 New session: ${followupRun.run.sessionId}` }, ...finalPayloads];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }

    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
      queueKey,
      runFollowupTurn,
    );
  } finally {
    blockReplyPipeline?.stop();
    typing.markRunComplete();
    // 🔧 P12 修复：安全清理上下文（仅当 contextId 匹配时才清空）
    clearCurrentFollowupRunContext(agentRunContextId);
  }
}
