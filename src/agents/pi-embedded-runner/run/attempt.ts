import fs from "node:fs/promises";
import os from "node:os";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";

import { resolveHeartbeatPrompt } from "../../../auto-reply/heartbeat.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
} from "../../channel-tools.js";
import { resolveChannelCapabilities } from "../../../config/channel-capabilities.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { resolveTelegramInlineButtonsScope } from "../../../telegram/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../../../telegram/reaction-level.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { resolveUserPath } from "../../../utils.js";
import { createCacheTrace } from "../../cache-trace.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { createOpenAiCompletionsPayloadDebugger } from "../../openai-completions-payload-debug.js";
import { createGeminiPayloadThoughtSignaturePatcher } from "../../gemini-payload-thought-signature.js";
import { createLlmCallConsoleLogger } from "../../llm-call-console-log.js";
import { resolveClawdbotAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../bootstrap-files.js";
import { resolveClawdbotDocsPath } from "../../docs-path.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import {
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "../../pi-embedded-subscribe.js";
import {
  ensurePiCompactionReserveTokens,
  resolveCompactionReserveTokensFloor,
} from "../../pi-settings.js";
import { createClawdbotCodingTools } from "../../pi-tools.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import { generateSessionSummary, formatSessionSummary } from "../../session-summary.js";
import { retrieveMemoryContext } from "../../memory/pipeline-integration.js";
import { resolvePersonaPrompt, renderPersonaWithContext } from "../../persona-injector.js";
import { proactiveRetrieval } from "../../proactive-retrieval.js"; // 🆕 主动检索增强引擎

import { emitAgentEvent } from "../../../infra/agent-events.js";
import { isAbortError } from "../abort.js";
import { buildEmbeddedExtensionPaths } from "../extensions.js";
import { applyExtraParamsToAgent } from "../extra-params.js";
import { appendCacheTtlTimestamp, isCacheTtlEligibleProvider } from "../cache-ttl.js";
import {
  logToolSchemasForGoogle,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "../google.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildModelAliasLines } from "../model.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
  setActiveEmbeddedRun,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import { buildEmbeddedSystemPrompt, createSystemPromptOverride } from "../system-prompt.js";
import { splitSdkTools } from "../tool-split.js";
import { toClientToolDefinitions } from "../../pi-tool-definition-adapter.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { describeUnknownError, mapThinkingLevel } from "../utils.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { buildTtsSystemPromptHint } from "../../../tts/tts.js";
import { isTimeoutError } from "../../failover-error.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js";
import { withLlmRequestContext } from "../../../infra/llm-request-context.js";
import type { AttemptOutcome, EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";
import { detectAndLoadPromptImages } from "./images.js";

export function injectHistoryImagesIntoMessages(
  messages: AgentMessage[],
  historyImagesByIndex: Map<number, ImageContent[]>,
): boolean {
  if (historyImagesByIndex.size === 0) return false;
  let didMutate = false;

  for (const [msgIndex, images] of historyImagesByIndex) {
    // Bounds check: ensure index is valid before accessing
    if (msgIndex < 0 || msgIndex >= messages.length) continue;
    const msg = messages[msgIndex];
    if (msg && msg.role === "user") {
      // Convert string content to array format if needed
      if (typeof msg.content === "string") {
        msg.content = [{ type: "text", text: msg.content }];
        didMutate = true;
      }
      if (Array.isArray(msg.content)) {
        // Check for existing image content to avoid duplicates across turns
        const existingImageData = new Set(
          msg.content
            .filter(
              (c): c is ImageContent =>
                c != null &&
                typeof c === "object" &&
                c.type === "image" &&
                typeof c.data === "string",
            )
            .map((c) => c.data),
        );
        for (const img of images) {
          // Only add if this image isn't already in the message
          if (!existingImageData.has(img.data)) {
            msg.content.push(img);
            didMutate = true;
          }
        }
      }
    }
  }

  return didMutate;
}

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const prevCwd = process.cwd();
  const runAbortController = new AbortController();

  // 🚨 Bug #1 修复: LLM 请求超时熔断机制
  const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟超时
  const timeoutHandle = setTimeout(() => {
    if (!runAbortController.signal.aborted) {
      log.warn(`🚨 LLM 请求超时(${REQUEST_TIMEOUT_MS}ms)，主动中断: runId=${params.runId}`);
      const timeoutError = new Error("LLM request timeout");
      timeoutError.name = "TimeoutError";
      runAbortController.abort(timeoutError);
    }
  }, REQUEST_TIMEOUT_MS);

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );

  await fs.mkdir(resolvedWorkspace, { recursive: true });

  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  let restoreSkillEnv: (() => void) | undefined;
  process.chdir(effectiveWorkspace);
  try {
    const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
    const skillEntries = shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(effectiveWorkspace)
      : [];
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });

    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir: effectiveWorkspace,
    });

    const promptLanguage =
      params.config?.agents?.defaults?.promptLanguage === "zh" ? "zh" : "en";

    const sessionLabel = params.sessionKey ?? params.sessionId;
    // 🔧 子任务跳过 bootstrap/context 文件（AGENTS.md、SOUL.md 等），减少 prompt 体积
    type BootstrapResult = Awaited<ReturnType<typeof resolveBootstrapContextForRun>>;
    const { bootstrapFiles: hookAdjustedBootstrapFiles, contextFiles } =
      params.skipBootstrapContext
        ? { bootstrapFiles: [] as BootstrapResult["bootstrapFiles"], contextFiles: [] as BootstrapResult["contextFiles"] }
        : await resolveBootstrapContextForRun({
            workspaceDir: effectiveWorkspace,
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            promptLanguage,
            warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
          });
    if (params.skipBootstrapContext) {
      log.info(`[attempt] 🔧 skipBootstrapContext: skipped bootstrap/context file loading`);
    }
    const workspaceNotes = hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
      ? ["Reminder: commit your changes in this workspace after edits."]
      : undefined;

    const agentDir = params.agentDir ?? resolveClawdbotAgentDir();

    // Check if the model supports native image input
    const modelHasVision = params.model.input?.includes("image") ?? false;
    const toolsRaw = params.disableTools
      ? []
      : createClawdbotCodingTools({
          exec: {
            ...params.execOverrides,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          messageTo: params.messageTo,
          messageThreadId: params.messageThreadId,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          sessionKey: params.sessionKey ?? params.sessionId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          config: params.config,
          abortSignal: runAbortController.signal,
          modelProvider: params.model.provider,
          modelId: params.modelId,
          modelApi: params.model.api,
          modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef,
          modelHasVision,
        });
    // 🔧 子任务工具白名单裁剪：大幅减少 system prompt 体积（60KB → ~15KB）
    const toolsAllowed = params.toolAllowlist?.length
      ? toolsRaw.filter((t) => params.toolAllowlist!.includes(t.name))
      : toolsRaw;
    if (params.toolAllowlist?.length) {
      log.info(
        `[attempt] 🔧 toolAllowlist: ${toolsRaw.length} → ${toolsAllowed.length} tools ` +
        `(kept: ${toolsAllowed.map((t) => t.name).join(", ")})`,
      );
    }
    const tools = sanitizeToolsForGoogle({ tools: toolsAllowed, provider: params.provider });
    logToolSchemasForGoogle({ tools, provider: params.provider });

    // 🆕 Tool 审批包装：如果启用审批，包装所有 tools
    // 这样用户可以看到所有 tool 的执行过程（参数和结果）
    const { wrapToolsWithApproval } = await import("../../tools/tool-wrapper.js");
    const { getToolApprovalConfig } = await import("../../../infra/tool-approval-manager.js");
    const approvalConfig = getToolApprovalConfig();
    const toolsWithApproval =
      approvalConfig.enabled && approvalConfig.mode !== "off"
        ? wrapToolsWithApproval(tools)
        : tools;
    
    if (approvalConfig.enabled && approvalConfig.mode !== "off") {
      log.info(
        `[attempt] 🔐 Tool 审批已启用: mode=${approvalConfig.mode}, tools=${toolsWithApproval.length}`,
      );
    }

    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    let runtimeCapabilities = runtimeChannel
      ? (resolveChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        }) ?? [])
      : undefined;
    if (runtimeChannel === "telegram" && params.config) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: params.config,
        accountId: params.agentAccountId ?? undefined,
      });
      if (inlineButtonsScope !== "off") {
        if (!runtimeCapabilities) runtimeCapabilities = [];
        if (
          !runtimeCapabilities.some((cap) => String(cap).trim().toLowerCase() === "inlinebuttons")
        ) {
          runtimeCapabilities.push("inlineButtons");
        }
      }
    }
    const reactionGuidance =
      runtimeChannel && params.config
        ? (() => {
            if (runtimeChannel === "telegram") {
              const resolved = resolveTelegramReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Telegram" } : undefined;
            }
            if (runtimeChannel === "signal") {
              const resolved = resolveSignalReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Signal" } : undefined;
            }
            return undefined;
          })()
        : undefined;
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(params.provider);
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions({
          cfg: params.config,
          channel: runtimeChannel,
        })
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.config ?? {},
      agentId: sessionAgentId,
    });
    const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      config: params.config,
      agentId: sessionAgentId,
      workspaceDir: effectiveWorkspace,
      cwd: process.cwd(),
      runtime: {
        host: machineName,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        model: `${params.provider}/${params.modelId}`,
        defaultModel: defaultModelLabel,
        channel: runtimeChannel,
        capabilities: runtimeCapabilities,
        channelActions,
      },
    });
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    const docsPath = await resolveClawdbotDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;

    // 🆕 Step 1: 提前创建 SessionManager（用于 hook）
    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
    });

    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    let hookCharacterName: string | undefined;
    let hookPrependContext: string | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const hadSessionFile = await fs
        .stat(params.sessionFile)
        .then(() => true)
        .catch(() => false);

      const transcriptPolicy = resolveTranscriptPolicy({
        modelApi: params.model?.api,
        provider: params.provider,
        modelId: params.modelId,
      });

      await prewarmSessionFile(params.sessionFile);
      sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        provider: params.provider,
      });
      trackSessionManagerAccess(params.sessionFile);
      
      // 🔍 DEBUG: Check how many messages sessionManager loaded
      const smContext = sessionManager.buildSessionContext();
      log.info(`[attempt] SessionManager loaded ${smContext.messages.length} messages from file (sessionId: ${params.sessionId})`);
      if (smContext.messages.length > 0) {
        const roles = smContext.messages.map(m => m.role).join(' → ');
        log.info(`[attempt] Message roles: ${roles}`);
      }
      
      // 🔍 DEBUG: Check SessionManager internal state
      const sm = sessionManager as any;
      if (sm.fileEntries) {
        const messageEntries = sm.fileEntries.filter((e: any) => e.type === "message");
        log.info(`[attempt] SessionManager fileEntries: total=${sm.fileEntries.length}, messages=${messageEntries.length}`);
        if (messageEntries.length > 0) {
          const entryRoles = messageEntries.slice(0, 10).map((e: any) => e.message?.role || "unknown");
          log.info(`[attempt] First 10 message entry roles: ${entryRoles.join(' → ')}`);
        }
        // 🔍 DEBUG: Check leafId
        log.info(`[attempt] SessionManager leafId: ${sm.leafId}`);
        // 🔍 DEBUG: Check all entry IDs
        const entryIds = sm.fileEntries.map((e: any) => `${e.type}:${e.id}`).join(', ');
        log.info(`[attempt] SessionManager entry IDs: ${entryIds}`);
      }

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: params.sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      // 🆕 Step 2: 获取 hook runner（用于 before_agent_start 和 agent_end）
      const hookRunner = getGlobalHookRunner();
      
      // 🆕 Step 3: 执行 hook 获取动态角色识别结果（在 buildEmbeddedSystemPrompt 之前）
      if (hookRunner?.hasHooks("before_agent_start")) {
        try {
          // 🔧 从全局上下文获取 isQueueTask 标记和实际的 prompt
          const { getCurrentFollowupRunContext } = await import("../../tools/enqueue-task-tool.js");
          const followupContext = getCurrentFollowupRunContext();
          const isQueueTask = followupContext?.isQueueTask === true;
          
          // 🔧 使用正确的 prompt：
          // - 如果是队列任务，使用 followupContext.prompt（队列任务的 prompt）
          // - 否则，使用 params.prompt（用户的原始消息）
          const actualPrompt = followupContext?.prompt ?? params.prompt;
          
          // 🔍 调试日志：验证 prompt 来源
          console.log(`[attempt] 🔍 followupContext?.prompt: ${followupContext?.prompt?.slice(0, 100)}`);
          console.log(`[attempt] 🔍 params.prompt: ${params.prompt?.slice(0, 100)}`);
          console.log(`[attempt] 🔍 actualPrompt: ${actualPrompt?.slice(0, 100)}`);
          console.log(`[attempt] 🔍 isQueueTask: ${isQueueTask}`);
          
          const hookResult = await hookRunner.runBeforeAgentStart(
            {
              prompt: actualPrompt,
              metadata: {
                isQueueTask,  // 🆕 传递 isQueueTask 标记
                runId: params.runId,  // 🆕 传递 runId，让聊天室 hook 能实时推送
              },
            },
            {
              sessionKey: params.sessionKey,
              agentId: sessionAgentId,
              workspaceDir: effectiveWorkspace,
            },
          );
          
          if (hookResult?.characterName) {
            hookCharacterName = hookResult.characterName;
            log.info(`hooks: detected character: ${hookCharacterName}`);
          }
          
          if (hookResult?.prependContext) {
            hookPrependContext = hookResult.prependContext;
            log.debug(`hooks: prepended context (${hookResult.prependContext.length} chars)`);
          }
          // 🆕 聊天室短路：chatRoomHandled 表示聊天室编排器已生成完整回复
          if (hookResult?.chatRoomHandled) {
            const chatText = hookResult.chatRoomHandled.responseText;
            log.info(`[attempt] 🏠 聊天室模式短路: ${chatText.length} 字符`);
            
            // P122: 发出 agent events 让 Web UI 的 server-chat agent event handler 能接收
            // 没有这些事件，Web 网关永远不会调用 emitChatDelta/emitChatFinal
            if (params.runId) {
              // 首先发出特殊的 chat_room_handled 事件，让 server-chat 提前创建 chat 链接
              emitAgentEvent({
                runId: params.runId,
                sessionKey: params.sessionKey,
                stream: "chat_room_handled",
                data: { 
                  responseText: chatText,
                  isChatRoom: true,
                  participants: hookResult.characterName ? [hookResult.characterName] : undefined
                },
              });
              
              // register.ts 的 collectReply 已在每次 sendReply 时实时推送了 assistant delta，
              // 这里只需发最终完整内容（确保 server-chat buffer 持有正确的 final 内容），
              // 然后发 lifecycle:end 触发 emitChatFinal。
              emitAgentEvent({
                runId: params.runId,
                sessionKey: params.sessionKey,
                stream: "assistant",
                data: { text: chatText },
              });
              
              // 发出 lifecycle end 事件（触发 chat final，UI 把 chatStream 追加到消息列表）
              emitAgentEvent({
                runId: params.runId,
                sessionKey: params.sessionKey,
                stream: "lifecycle",
                data: { phase: "end", endedAt: Date.now() },
              });
            }
            return {
              aborted: false,
              timedOut: false,
              promptError: null,
              sessionIdUsed: params.sessionId,
              messagesSnapshot: [],
              assistantTexts: [chatText],
              toolMetas: [],
              lastAssistant: undefined,
              didSendViaMessagingTool: false,
              messagingToolSentTexts: [],
              messagingToolSentTargets: [],
              cloudCodeAssistFormatError: false,
            };
          }
        } catch (hookErr) {
          log.warn(`before_agent_start hook failed: ${String(hookErr)}`);
        }
      }
      
      // 🆕 promptMode 逻辑：
      // - 子代理 session → minimal（精简 prompt，节省上下文）
      // - 系统化身角色（琳娜/德默泽尔/德洛丽丝/丽丝）→ full
      //   她们是系统的人格化身，需要完整能力：任务分解、记忆工具、技能系统等
      // - 其他角色 → minimal
      const SYSTEM_PERSONA_IDS = new Set(["lina", "demerzel", "dolores", "lisi"]);
      const _isSystemPersona = hookCharacterName ? SYSTEM_PERSONA_IDS.has(hookCharacterName) : false;
      // 🧩 RunMode 驱动的系统底座强度：
      // - qc/decompose/delivery: 必须 full（否则 minimal 可能跳过关键硬编码段落，导致标准漂移）
      // - tool_exec_compact: 仍可 minimal（依赖 promptProfile 注入德姨 mini 底座）
      // - 其他：延续原规则
      const _runModeForcesFull =
        params.runMode === "qc_agent" ||
        params.runMode === "decompose_agent" ||
        params.runMode === "delivery_agent";
      const promptMode = _runModeForcesFull
        ? "full"
        : isSubagentSessionKey(params.sessionKey)
          ? "minimal"
          : _isSystemPersona
            ? "full"
            : hookCharacterName
              ? "minimal"
              : "full";
      
      // Step 3.5: 人格 + 记忆上下文注入（延迟渲染）
      let enhancedExtraSystemPrompt = params.extraSystemPrompt;
      let filteredContextFiles = contextFiles;
      {
        // Step A: 解析人格（目录制角色优先，JSON 配置 fallback）
        const resolved = await resolvePersonaPrompt(params.config, sessionAgentId, hookCharacterName ?? undefined);

        // Step B: 检索记忆（仅根任务，避免子任务重复检索）
        let relevantMemories: string | undefined;
        const followupCtx = (await import("../../tools/enqueue-task-tool.js")).getCurrentFollowupRunContext();
        const isQueueTask = followupCtx?.isQueueTask === true;
        if (!isQueueTask && params.prompt) {
          const memoryCtx = await retrieveMemoryContext(
            params.prompt,
            params.sessionId,
            params.config,
            sessionAgentId,
          );
          if (memoryCtx) {
            relevantMemories = memoryCtx;
            log.info(`[attempt] Memory context retrieved (${memoryCtx.length} chars)`);
          }
        }

        // Step C: 延迟渲染 — 在记忆就绪后统一替换模板变量
        if (resolved) {
          const personaPrompt = renderPersonaWithContext(resolved, {
            relevantMemories,
            userName: params.ownerNumbers?.[0],
          });
          enhancedExtraSystemPrompt = enhancedExtraSystemPrompt
            ? `${enhancedExtraSystemPrompt}\n\n${personaPrompt}`
            : personaPrompt;
          log.info(`[attempt] Persona injected: ${resolved.displayName} (source=${resolved.source})`);

          // Step D: Workspace 文件冲突协调 — system-persona 存在时过滤 SOUL.md
          if (resolved.overridesWorkspaceFiles.length > 0 && filteredContextFiles) {
            const overrideSet = new Set(resolved.overridesWorkspaceFiles);
            filteredContextFiles = filteredContextFiles.filter(
              (f) => {
                const basename = f.path.split(/[\\/]/).pop() ?? "";
                return !overrideSet.has(basename);
              },
            );
            log.info(`[attempt] Workspace files filtered by overrides: ${resolved.overridesWorkspaceFiles.join(", ")}`);
          }
        } else if (relevantMemories) {
          // 没有角色但有记忆，直接追加
          enhancedExtraSystemPrompt = enhancedExtraSystemPrompt
            ? `${enhancedExtraSystemPrompt}\n\n${relevantMemories}`
            : relevantMemories;
        }
      }

      // 🆕 主动检索增强：从用户消息、Agent 定义、系统提示词中抽取关键词进行多维度检索
      // 在人格 + 记忆注入之后执行，确保检索结果能够与人格设定协同工作
      let proactiveRetrievalCtx = "";
      try {
        const retrievalResult = await proactiveRetrieval(params.config!, {
          userMessage: params.prompt || "",
          agentDefinition: "", // 可以从 params 或其他地方获取
          systemPrompt: enhancedExtraSystemPrompt || "",
          backgroundPrompt: "",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          maxSnippets: 6,
          minScore: 0.35,
          enableMemory: true,
          enableNovel: true,
          enableAgentDef: false, // agentDefinition 为空时禁用
          enableToolDefs: true, // 🆕 ToolCall 2.0 工具定义注入
        });
        
        if (retrievalResult.formattedContext) {
          proactiveRetrievalCtx = retrievalResult.formattedContext;
          log.info(
            `[attempt] 🚀 主动检索增强完成：${retrievalResult.stats.memory} 记忆，` +
            `${retrievalResult.stats.novel} 小说，${retrievalResult.stats.toolDef} 工具定义，` +
            `${retrievalResult.durationMs}ms`
          );
        }
      } catch (err) {
        log.warn(`[attempt] ⚠️ 主动检索失败 (不阻塞): ${err}`);
      }

      // 将主动检索结果注入到 enhancedExtraSystemPrompt
      if (proactiveRetrievalCtx) {
        enhancedExtraSystemPrompt = enhancedExtraSystemPrompt
          ? `${enhancedExtraSystemPrompt}\n${proactiveRetrievalCtx}`
          : proactiveRetrievalCtx;
      }

      // Step 3.8: P118 — 输出 token 限制感知 + continue_generation 引导
      // 告知 LLM 其 maxOutputTokens 限制，并指导使用 continue_generation 工具分批输出
      // 🔧 P118a: 修复 maxTokens 为 undefined 时静默跳过的致命 BUG
      //   - 使用 DEFAULT_MAX_OUTPUT_TOKENS 回退，确保提示始终注入
      //   - 仅在 maxTokens ≤ 16384 时注入详细提示（大模型不需要）
      //   - 系数从 0.7 修正为 0.6（更保守准确：中文约 1.5 tokens/字符）
      //   - 新增策略4：提前续传引导（60-70% 用量时主动续传）
      {
        const _P118A_DEFAULT_MAX_OUTPUT = 4096;
        const modelMaxTokens = params.model?.maxTokens || _P118A_DEFAULT_MAX_OUTPUT;
        // 仅在输出限制较紧时注入详细提示（大 maxTokens 模型几乎不会被截断）
        if (modelMaxTokens <= 16384) {
          const approxChars = Math.round(modelMaxTokens * 0.6);
          const tokenLimitHint = [
            `\n## ⚠️ 输出长度限制`,
            `你的单次回复上限约为 **${modelMaxTokens} tokens**（约 ${approxChars} 个中文字符）。`,
            `当你的回复内容较多时（如需要多次调用工具、生成长文本），务必遵循以下策略：`,
            `1. **优先行动，后描述**：先调用工具（如 enqueue_task、write），再做简要说明。不要用大段文字描述计划后再调用工具。`,
            `2. **分批输出**：如果一次回复无法完成所有工作，先完成当前能做的部分，然后调用 \`continue_generation\` 工具请求续传。`,
            `3. **禁止纯文本计划**：当任务需要调用工具时，绝对不要只输出文字计划而不调用任何工具。每次回复必须至少执行一个实际操作。`,
            `4. **提前续传**：当你感觉已使用约 60-70% 的输出空间时，如果还有未完成的工作，请立即调用 \`continue_generation\`，不要等到被截断。`,
          ].join("\n");
          enhancedExtraSystemPrompt = enhancedExtraSystemPrompt
            ? `${enhancedExtraSystemPrompt}\n${tokenLimitHint}`
            : tokenLimitHint;
          log.info(
            `[attempt] 🔧 P118: 注入 token 限制提示 (maxTokens=${modelMaxTokens}, approxChars=${approxChars}, source=${params.model?.maxTokens ? "model" : "default"})`,
          );
        }
      }

      // Step 3.9: 文本工具回退 — 配置预标记 + 降级 provider 检测 + 文本工具描述注入
      const {
        isDegradedProvider: _isDegraded,
        buildTextToolPrompt: _buildTextToolPrompt,
        initDegradedFromConfig: _initDegradedFromConfig,
      } = await import("../../text-tool-fallback.js");
      // 从 config 中读取 toolCalling=false 的 provider+model，预标记为降级（幂等）
      if (params.config) {
        _initDegradedFromConfig(params.config);
      }
      const _isTextToolMode = !params.disableTools && _isDegraded(params.provider, params.modelId);
      if (_isTextToolMode) {
        const textToolPrompt = _buildTextToolPrompt(tools);
        enhancedExtraSystemPrompt = enhancedExtraSystemPrompt
          ? `${enhancedExtraSystemPrompt}\n\n${textToolPrompt}`
          : textToolPrompt;
        log.info(
          `[attempt] 🔧 文本工具模式已激活 (provider=${params.provider}/${params.modelId})，` +
          `注入 ${textToolPrompt.length} 字符工具描述到 system prompt`,
        );
      }

      // Step 4: 生成 system prompt
      const appendPrompt = await buildEmbeddedSystemPrompt({
        workspaceDir: effectiveWorkspace,
        defaultThinkLevel: params.thinkLevel,
        reasoningLevel: params.reasoningLevel ?? "off",
        extraSystemPrompt: enhancedExtraSystemPrompt,
        promptProfile: params.promptProfile,
        ownerNumbers: params.ownerNumbers,
        reasoningTagHint,
        heartbeatPrompt: isDefaultAgent
          ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
          : undefined,
        skillsPrompt,
        docsPath: docsPath ?? undefined,
        ttsHint,
        workspaceNotes,
        reactionGuidance,
        promptMode,
        promptLanguage,
        runtimeInfo,
        messageToolHints,
        sandboxInfo,
        tools: toolsWithApproval,
        modelAliasLines: buildModelAliasLines(params.config),
        userTimezone,
        userTime,
        userTimeFormat,
        contextFiles: filteredContextFiles,
        characterName: hookCharacterName,
        characterBasePath: process.cwd(),
      });
      
      const systemPromptReport = buildSystemPromptReport({
        source: "run",
        generatedAt: Date.now(),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        model: params.modelId,
        workspaceDir: effectiveWorkspace,
        bootstrapMaxChars: resolveBootstrapMaxChars(params.config),
        sandbox: (() => {
          const runtime = resolveSandboxRuntimeStatus({
            cfg: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
          });
          return { mode: runtime.mode, sandboxed: runtime.sandboxed };
        })(),
        systemPrompt: appendPrompt,
        bootstrapFiles: hookAdjustedBootstrapFiles,
        injectedFiles: contextFiles,
        skillsPrompt,
        tools: toolsWithApproval,
      });
      const systemPrompt = createSystemPromptOverride(appendPrompt);

      const settingsManager = SettingsManager.create(effectiveWorkspace, agentDir);
      ensurePiCompactionReserveTokens({
        settingsManager,
        minReserveTokens: resolveCompactionReserveTokensFloor(params.config),
      });

      const additionalExtensionPaths = buildEmbeddedExtensionPaths({
        cfg: params.config,
        sessionManager,
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
      });

      const { builtInTools: _builtInToolsRaw, customTools } = splitSdkTools({
        tools: toolsWithApproval,
        sandboxEnabled: !!sandbox?.enabled,
      });
      // 文本工具模式下，工具已通过 system prompt 文本描述传递，
      // 不能再把原生工具定义传给 createAgentSession，
      // 否则 pi-ai 在 Google Generative AI API 下处理工具 schema 时会崩溃。
      const builtInTools = _isTextToolMode ? [] : _builtInToolsRaw;

      // Add client tools (OpenResponses hosted tools) to customTools
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      const clientToolDefs = params.clientTools
        ? toClientToolDefinitions(params.clientTools, (toolName, toolParams) => {
            clientToolCallDetected = { name: toolName, params: toolParams };
          })
        : [];

      const allCustomTools = _isTextToolMode ? [] : [...customTools, ...clientToolDefs];

      ({ session } = await createAgentSession({
        cwd: resolvedWorkspace,
        agentDir,
        authStorage: params.authStorage,
        modelRegistry: params.modelRegistry,
        model: params.model,
        thinkingLevel: mapThinkingLevel(params.thinkLevel),
        systemPrompt,
        tools: builtInTools,
        customTools: allCustomTools,
        sessionManager,
        settingsManager,
        skills: [],
        contextFiles: [],
        additionalExtensionPaths,
      }));
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      const activeSession = session;
      
      // 🔍 DEBUG: Check how many messages createAgentSession returned
      log.info(`[attempt] createAgentSession returned ${activeSession.messages.length} messages (sessionId: ${params.sessionId})`);
      if (activeSession.messages.length > 0) {
        const roles = activeSession.messages.map(m => m.role).join(' → ');
        log.info(`[attempt] Active session message roles: ${roles}`);
      }
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const openAiCompletionsPayloadDebugger = createOpenAiCompletionsPayloadDebugger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
      });
      const geminiPayloadThoughtSignaturePatcher = createGeminiPayloadThoughtSignaturePatcher({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
      });
      const llmCallConsoleLogger = createLlmCallConsoleLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        showLlmProgress: params.config?.agents?.defaults?.showLlmProgress,
      });

      // Force a stable streamFn reference so vitest can reliably mock @mariozechner/pi-ai.
      activeSession.agent.streamFn = streamSimple;

      applyExtraParamsToAgent(
        activeSession.agent,
        params.config,
        params.provider,
        params.modelId,
        params.streamParams,
      );

      if (cacheTrace) {
        cacheTrace.recordStage("session:loaded", {
          messages: activeSession.messages,
          system: systemPrompt,
          note: "after session create",
        });
        activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
      }
      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }
      if (openAiCompletionsPayloadDebugger) {
        activeSession.agent.streamFn = openAiCompletionsPayloadDebugger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }
      // ⚠️ 重要：wrapper 的嵌套顺序决定了执行顺序
      // 最后包装的 wrapper 最先执行（洋葱模型）
      // 我们需要：格式转换 → payload 验证 → 发送
      // 所以包装顺序应该是：llmCallConsoleLogger → geminiPayloadThoughtSignaturePatcher
      if (llmCallConsoleLogger) {
        activeSession.agent.streamFn = llmCallConsoleLogger.wrapStreamFn(activeSession.agent.streamFn);
      }
      if (geminiPayloadThoughtSignaturePatcher) {
        activeSession.agent.streamFn = geminiPayloadThoughtSignaturePatcher.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }

      try {
        // 🔧 从全局上下文获取 isQueueTask 标记
        const { getCurrentFollowupRunContext } = await import("../../tools/enqueue-task-tool.js");
        const followupContext = getCurrentFollowupRunContext();
        const isQueueTask = followupContext?.isQueueTask === true;
        
        const prior = await sanitizeSessionHistory({
          messages: activeSession.messages,
          modelApi: params.model.api,
          modelId: params.modelId,
          provider: params.provider,
          sessionManager,
          sessionId: params.sessionId,
          policy: transcriptPolicy,
          isQueueTask,  // 🆕 传递 isQueueTask 标记
        });
        log.info(`[attempt] 🔍 After sanitizeSessionHistory: ${prior.length} messages (user: ${prior.filter(m => m.role === "user").length}, assistant: ${prior.filter(m => m.role === "assistant").length})`);
        
        // 🆕 智能上下文剪枝：在 sanitize 之后、validate/limit 之前，
        // 识别旧任务段落并压缩为摘要，防止旧上下文污染当前任务。
        const { pruneIrrelevantContext } = await import("../context-pruning.js");
        const pruneResult = pruneIrrelevantContext(prior, {
          minMessagesThreshold: 20,
          keepRecentSegments: 1,
          isQueueTask,
        });
        const prunedMessages = pruneResult.messages;
        if (pruneResult.prunedSegments > 0) {
          log.info(`[attempt] ✂️ Context pruning: ${pruneResult.prunedSegments} segments compressed, ${prior.length} → ${prunedMessages.length} messages, ~${pruneResult.savedTokens} tokens saved`);
        }
        
        cacheTrace?.recordStage("session:sanitized", { messages: prunedMessages });
        const validatedGemini = transcriptPolicy.validateGeminiTurns
          ? validateGeminiTurns(prunedMessages)
          : prunedMessages;
        log.info(`[attempt] 🔍 After validateGeminiTurns: ${validatedGemini.length} messages`);
        
        const validated = transcriptPolicy.validateAnthropicTurns
          ? validateAnthropicTurns(validatedGemini)
          : validatedGemini;
        log.info(`[attempt] 🔍 After validateAnthropicTurns: ${validated.length} messages`);
        
        const limited = limitHistoryTurns(
          validated,
          getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
        );
        log.info(`[attempt] 🔍 After limitHistoryTurns: ${limited.length} messages (user: ${limited.filter(m => m.role === "user").length}, assistant: ${limited.filter(m => m.role === "assistant").length})`);
        
        cacheTrace?.recordStage("session:limited", { messages: limited });
        if (limited.length > 0) {
          activeSession.agent.replaceMessages(limited);
          log.info(`[attempt] 🔍 After replaceMessages: activeSession.messages.length = ${activeSession.messages.length}`);
        }

        // 🆕 Generate session summary and inject into system prompt
        // This provides task context to help AI remember the goal across long conversations
        const sessionSummary = generateSessionSummary(limited);
        const sessionSummaryText = sessionSummary ? formatSessionSummary(sessionSummary) : undefined;

        if (sessionSummaryText && sessionSummary) {
          // Rebuild system prompt with session summary
          const updatedSystemPrompt = await buildEmbeddedSystemPrompt({
            workspaceDir: effectiveWorkspace,
            defaultThinkLevel: params.thinkLevel,
            reasoningLevel: params.reasoningLevel ?? "off",
            extraSystemPrompt: enhancedExtraSystemPrompt,
            ownerNumbers: params.ownerNumbers,
            reasoningTagHint,
            heartbeatPrompt: isDefaultAgent
              ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
              : undefined,
            skillsPrompt,
            docsPath: docsPath ?? undefined,
            ttsHint,
            workspaceNotes,
            reactionGuidance,
            promptMode,
            promptLanguage,
            runtimeInfo,
            messageToolHints,
            sandboxInfo,
            tools: toolsWithApproval,
            modelAliasLines: buildModelAliasLines(params.config),
            userTimezone,
            userTime,
            userTimeFormat,
            contextFiles: filteredContextFiles,
            sessionSummary: sessionSummaryText, // 🆕 Inject session summary
          });

          // Update agent's system prompt
          activeSession.agent.setSystemPrompt(updatedSystemPrompt);
          log.debug(
            `[session-summary] Injected session summary: taskGoal="${sessionSummary.taskGoal.slice(0, 50)}..." turns=${sessionSummary.totalTurns} actions=${sessionSummary.keyActions.length}`,
          );
        }
      } catch (err) {
        sessionManager.flushPendingToolResults?.();
        activeSession.dispose();
        throw err;
      }

      let aborted = Boolean(params.abortSignal?.aborted);
      let timedOut = false;
      const getAbortReason = (signal: AbortSignal): unknown =>
        "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      const makeTimeoutAbortReason = (): Error => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        return err;
      };
      const makeAbortError = (signal: AbortSignal): Error => {
        const reason = getAbortReason(signal);
        const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
        err.name = "AbortError";
        return err;
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) timedOut = true;
        if (isTimeout) {
          runAbortController.abort(reason ?? makeTimeoutAbortReason());
        } else {
          runAbortController.abort(reason);
        }
        void activeSession.abort();
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> => {
        const signal = runAbortController.signal;
        if (signal.aborted) {
          return Promise.reject(makeAbortError(signal));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(makeAbortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              reject(err);
            },
          );
        });
      };

      const subscription = subscribeEmbeddedPiSession({
        session: activeSession,
        sessionKey: params.sessionKey,
        runId: params.runId,
        verboseLevel: params.verboseLevel,
        reasoningMode: params.reasoningLevel ?? "off",
        toolResultFormat: params.toolResultFormat,
        shouldEmitToolResult: params.shouldEmitToolResult,
        shouldEmitToolOutput: params.shouldEmitToolOutput,
        onToolResult: params.onToolResult,
        onReasoningStream: params.onReasoningStream,
        onBlockReply: params.onBlockReply,
        onBlockReplyFlush: params.onBlockReplyFlush,
        blockReplyBreak: params.blockReplyBreak,
        blockReplyChunking: params.blockReplyChunking,
        onPartialReply: params.onPartialReply,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onAgentEvent: params.onAgentEvent,
        enforceFinalTag: params.enforceFinalTag,
      });

      const {
        assistantTexts,
        toolMetas,
        unsubscribe,
        waitForCompactionRetry,
        getMessagingToolSentTexts,
        getMessagingToolSentTargets,
        didSendViaMessagingTool,
        getLastToolError,
      } = subscription;

      const queueHandle: EmbeddedPiQueueHandle = {
        queueMessage: async (text: string) => {
          await activeSession.steer(text);
        },
        isStreaming: () => activeSession.isStreaming,
        isCompacting: () => subscription.isCompacting(),
        abort: abortRun,
      };
      setActiveEmbeddedRun(params.sessionId, queueHandle);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const abortTimer = setTimeout(
        () => {
          if (!isProbeSession) {
            log.warn(
              `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
            );
          }
          abortRun(true);
          if (!abortWarnTimer) {
            abortWarnTimer = setTimeout(() => {
              if (!activeSession.isStreaming) return;
              if (!isProbeSession) {
                log.warn(
                  `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                );
              }
            }, 10_000);
          }
        },
        Math.max(1, params.timeoutMs),
      );

      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      const onAbort = () => {
        const reason = params.abortSignal ? getAbortReason(params.abortSignal) : undefined;
        const timeout = reason ? isTimeoutError(reason) : false;
        abortRun(timeout, reason);
      };
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, {
            once: true,
          });
        }
      }

      // 🆕 hookRunner 已经在前面声明（第 422 行附近），这里不需要重复声明

      let promptError: unknown = null;
      let spotRecoveryExecuted = false;
      try {
        const promptStartedAt = Date.now();

        // 🆕 使用之前 hook 返回的 prependContext（已经在 sessionManager 创建后执行过 hook）
        let effectivePrompt = params.prompt;
        if (hookPrependContext) {
          effectivePrompt = `${hookPrependContext}\n\n${params.prompt}`;
          log.debug(
            `hooks: using prepended context from earlier hook (${hookPrependContext.length} chars)`,
          );
        }

        log.debug(`embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`);
        cacheTrace?.recordStage("prompt:before", {
          prompt: effectivePrompt,
          messages: activeSession.messages,
        });

        // Repair orphaned trailing user messages so new prompts don't violate role ordering.
        const leafEntry = sessionManager.getLeafEntry();
        if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
          if (leafEntry.parentId) {
            sessionManager.branch(leafEntry.parentId);
          } else {
            sessionManager.resetLeaf();
          }
          const sessionContext = sessionManager.buildSessionContext();
          activeSession.agent.replaceMessages(sessionContext.messages);
          log.warn(
            `Removed orphaned user message to prevent consecutive user turns. ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
        }

        try {
          // Detect and load images referenced in the prompt for vision-capable models.
          // This eliminates the need for an explicit "view" tool call by injecting
          // images directly into the prompt when the model supports it.
          // Also scans conversation history to enable follow-up questions about earlier images.
          const imageResult = await detectAndLoadPromptImages({
            prompt: effectivePrompt,
            workspaceDir: effectiveWorkspace,
            model: params.model,
            existingImages: params.images,
            historyMessages: activeSession.messages,
            maxBytes: MAX_IMAGE_BYTES,
            // Enforce sandbox path restrictions when sandbox is enabled
            sandboxRoot: sandbox?.enabled ? sandbox.workspaceDir : undefined,
          });

          // Inject history images into their original message positions.
          // This ensures the model sees images in context (e.g., "compare to the first image").
          const didMutate = injectHistoryImagesIntoMessages(
            activeSession.messages,
            imageResult.historyImagesByIndex,
          );
          if (didMutate) {
            // Persist message mutations (e.g., injected history images) so we don't re-scan/reload.
            activeSession.agent.replaceMessages(activeSession.messages);
          }

          cacheTrace?.recordStage("prompt:images", {
            prompt: effectivePrompt,
            messages: activeSession.messages,
            note: `images: prompt=${imageResult.images.length} history=${imageResult.historyImagesByIndex.size}`,
          });

          const shouldTrackCacheTtl =
            params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
            isCacheTtlEligibleProvider(params.provider, params.modelId);
          if (shouldTrackCacheTtl) {
            appendCacheTtlTimestamp(sessionManager, {
              timestamp: Date.now(),
              provider: params.provider,
              modelId: params.modelId,
            });
          }

          // Only pass images option if there are actually images to pass
          // This avoids potential issues with models that don't expect the images parameter
          if (imageResult.images.length > 0) {
            await withLlmRequestContext(
              {
                runId: params.runId,
                sessionKey: params.sessionKey,
                provider: params.provider,
                modelId: params.modelId,
                source: params.messageChannel ?? params.messageProvider ?? "unknown",
              },
              () => abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images })),
            );
          } else {
            await withLlmRequestContext(
              {
                runId: params.runId,
                sessionKey: params.sessionKey,
                provider: params.provider,
                modelId: params.modelId,
                source: params.messageChannel ?? params.messageProvider ?? "unknown",
              },
              () => abortable(activeSession.prompt(effectivePrompt)),
            );
          }
        } catch (err) {
          promptError = err;
        } finally {
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        try {
          await waitForCompactionRetry();
        } catch (err) {
          if (isAbortError(err)) {
            if (!promptError) promptError = err;
          } else {
            throw err;
          }
        }

        messagesSnapshot = activeSession.messages.slice();
        
        // 🔧 Fix: Normalize assistant messages with null content after LLM response
        // Pi AI library may save assistant messages with content: null when they only have tool_calls
        // This must be fixed immediately after prompt() to ensure session file is correct
        let fixedAfterPrompt = 0;
        for (let i = 0; i < activeSession.messages.length; i++) {
          const msg = activeSession.messages[i];
          if (msg.role === "assistant" && msg.content === null) {
            msg.content = [] as never; // Empty array for assistant messages with only tool_calls
            fixedAfterPrompt++;
            log.info(`[attempt] ✓ Fixed assistant.content: null → [] after prompt (message index: ${i})`);
          }
        }
        if (fixedAfterPrompt > 0) {
          // Force re-save to persist the fix
          activeSession.agent.replaceMessages(activeSession.messages);
          log.info(`[attempt] Re-saved ${fixedAfterPrompt} fixed messages to session`);
        }

        // ═══════════════════════════════════════════════════════════════
        // Step 5.5: 文本工具回退循环（ReAct 模式）
        // 当 API 代理不支持 function calling 时，从 LLM 文本响应中解析
        // ```tool 代码块，执行工具调用，将结果注入下一轮对话。
        // ═══════════════════════════════════════════════════════════════
        if (!promptError && !aborted && !params.disableTools && tools.length > 0) {
          const {
            isDegradedProvider: _ttfIsDegraded,
            markDegradedProvider: _ttfMarkDegraded,
            clearDegradedProvider: _ttfClearDegraded,
            shouldDetectDegraded: _ttfShouldDetect,
            parseTextToolCalls: _ttfParse,
            executeTextToolCalls: _ttfExecute,
            formatToolResultsPrompt: _ttfFormatResults,
            buildTextToolPrompt: _ttfBuildPrompt,
            MAX_TEXT_TOOL_ITERATIONS: _ttfMaxIter,
          } = await import("../../text-tool-fallback.js");

          const _ttfResponseText = assistantTexts.join("\n");
          const _ttfHasNativeToolCalls = toolMetas.length > 0;

          // 如果有原生 function call → 说明 provider 正常，清除降级标记
          if (_ttfHasNativeToolCalls) {
            _ttfClearDegraded(params.provider, params.modelId);
          }

          // P76: 检查 session 历史中是否有过 function call（toolResult 消息）
          // 如果之前轮次有成功的 function call，说明 provider 支持 function calling
          const _ttfHadPriorToolCalls = _ttfHasNativeToolCalls ||
            messagesSnapshot.some(
              (m) => (m.role as string) === "toolResult" || (m.role as string) === "tool",
            );

          // 检测是否应标记为降级
          const _ttfWasDegraded = _ttfIsDegraded(params.provider, params.modelId);
          const _ttfNewlyDetected =
            !_ttfWasDegraded &&
            _ttfShouldDetect({
              toolsRegistered: true,
              hasToolCalls: _ttfHasNativeToolCalls,
              hasTextResponse: _ttfResponseText.length > 0,
              textLength: _ttfResponseText.length,
              hadPriorToolCalls: _ttfHadPriorToolCalls,
              responseText: _ttfResponseText,
            });

          // 首次降级时引导 prompt 前的文本基线（用于循环中定位新文本）
          let _ttfPreGuideBaseline = 0;

          if (_ttfNewlyDetected) {
            _ttfMarkDegraded(params.provider, params.modelId);
            log.warn(
              `[attempt] ⚠️ 检测到 provider ${params.provider}/${params.modelId} 不支持 function calling，` +
                `首次降级：将注入文本工具格式并重新请求 LLM`,
            );

            // 首次降级：需要重新 prompt，因为 LLM 之前不知道文本工具格式
            // 更新 system prompt 加入文本工具格式说明
            const _ttfTextToolPrompt = _ttfBuildPrompt(tools);
            const _ttfUpdatedExtra = enhancedExtraSystemPrompt
              ? `${enhancedExtraSystemPrompt}\n\n${_ttfTextToolPrompt}`
              : _ttfTextToolPrompt;

            const _ttfUpdatedSystemPrompt = await buildEmbeddedSystemPrompt({
              workspaceDir: effectiveWorkspace,
              defaultThinkLevel: params.thinkLevel,
              reasoningLevel: params.reasoningLevel ?? "off",
              extraSystemPrompt: _ttfUpdatedExtra,
              ownerNumbers: params.ownerNumbers,
              reasoningTagHint,
              heartbeatPrompt: isDefaultAgent
                ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
                : undefined,
              skillsPrompt,
              docsPath: docsPath ?? undefined,
              ttsHint,
              workspaceNotes,
              reactionGuidance,
              promptMode,
              promptLanguage,
              runtimeInfo,
              messageToolHints,
              sandboxInfo,
              tools: toolsWithApproval,
              modelAliasLines: buildModelAliasLines(params.config),
              userTimezone,
              userTime,
              userTimeFormat,
              contextFiles: filteredContextFiles,
              characterName: hookCharacterName,
              characterBasePath: process.cwd(),
            });
            activeSession.agent.setSystemPrompt(_ttfUpdatedSystemPrompt);

            // 记录引导 prompt 前的基线（用于后续循环定位新文本）
            _ttfPreGuideBaseline = assistantTexts.length;

            // 用引导消息重新触发 LLM
            const _ttfGuidePrompt =
              "[系统提示] 当前 API 不支持原生函数调用(function calling)。" +
              "请使用 system prompt 中描述的 ```tool 文本格式来调用工具。" +
              "请重新审视任务并使用文本工具格式执行所需操作。";
            try {
              await abortable(activeSession.prompt(_ttfGuidePrompt));
            } catch (err) {
              promptError = err;
            }
            // 更新快照
            messagesSnapshot = activeSession.messages.slice();
          }

          // 文本工具调用循环（降级模式下执行）
          if (
            !promptError &&
            !aborted &&
            (_ttfWasDegraded || _ttfNewlyDetected)
          ) {
            let _ttfIteration = 0;
            // 追踪 assistantTexts 基线，确保只解析当前轮次的文本
            // - 首次降级：从引导 prompt 前的位置开始（捕获引导响应中的工具调用）
            // - 已知降级：从第一轮开始（Step 3.9 已注入文本工具提示）
            let _ttfTextBaseline = _ttfNewlyDetected
              ? _ttfPreGuideBaseline
              : 0;
            while (_ttfIteration < _ttfMaxIter && !aborted && !promptError) {
              // 取本轮 LLM 响应的完整文本（从基线到最新）
              const _ttfLatestText = assistantTexts
                .slice(_ttfTextBaseline)
                .join("\n");
              const _ttfCalls = _ttfParse(_ttfLatestText);
              if (_ttfCalls.length === 0) break;

              log.info(
                `[attempt] 🔧 文本工具回退 #${_ttfIteration + 1}: ` +
                  `解析到 ${_ttfCalls.length} 个工具调用: ` +
                  `${_ttfCalls.map((c) => c.tool).join(", ")}`,
              );

              // 执行工具调用
              const _ttfResults = await _ttfExecute(_ttfCalls, tools);

              // 记录工具元数据（与原生 tool call 统一追踪）
              for (const r of _ttfResults) {
                toolMetas.push({
                  toolName: r.tool,
                  meta: r.success
                    ? r.result.slice(0, 500)
                    : `ERROR: ${r.error}`,
                });
              }

              // 构建结果提示并重新调用 LLM
              const _ttfResultPrompt = _ttfFormatResults(_ttfResults);
              try {
                await abortable(activeSession.prompt(_ttfResultPrompt));
              } catch (err) {
                promptError = err;
                break;
              }

              // 更新快照和基线
              messagesSnapshot = activeSession.messages.slice();
              _ttfTextBaseline = assistantTexts.length;
              _ttfIteration++;
            }

            if (_ttfIteration > 0) {
              log.info(
                `[attempt] ✅ 文本工具回退完成: ${_ttfIteration} 轮工具调用，` +
                  `共 ${toolMetas.length} 个工具执行`,
              );
            }
          }

          // ═════════════════════════════════════════════════════════════
          // P88: 单次幻觉回退（Spot Recovery）
          // 当 provider 正常（hadPriorToolCalls=true）但当前回复偶发性地将
          // 工具调用输出为纯文本时（如 Gemini 偶发 function calling 失败），
          // 解析并执行文本中的工具调用，但不标记 provider 为降级。
          // 🔧 P98 增强：成功执行后设置 spotRecoveryExecuted 标志，
          //    通知下游 OutputValidator 跳过幻觉检测（原始幻觉文本仍留在 output 中）。
          // 🔧 P103 修复：_ttfHasNativeToolCalls 检查的是整个 attempt 的 toolMetas，
          //    当 seq=1/2 有正常 tool call 但 seq=3 退化为 [Historical context:...] 时，
          //    toolMetas.length > 0 → P88 永远不触发。改为检查最后一条 assistant 消息
          //    是否包含 toolCall 内容（只看最后一轮回复是否有原生工具调用）。
          // ═════════════════════════════════════════════════════════════
          const _ttfLastRoundHasNativeToolCalls = (() => {
            const lastAssist = messagesSnapshot.slice().reverse()
              .find((m) => (m as AgentMessage)?.role === "assistant") as AssistantMessage | undefined;
            if (!lastAssist) return false;
            const content = lastAssist.content;
            if (Array.isArray(content)) {
              return content.some((c) => typeof c === "object" && c !== null && "type" in c && c.type === "toolCall");
            }
            return false;
          })();
          if (
            !promptError &&
            !aborted &&
            !_ttfWasDegraded &&
            !_ttfNewlyDetected &&
            !_ttfLastRoundHasNativeToolCalls &&
            _ttfResponseText.length > 50
          ) {
            const {
              detectToolCallIntentInText: _ttfDetectIntent,
              parseSpotToolCallsFromText: _ttfParseSpot,
            } = await import("../../text-tool-fallback.js");

            if (_ttfDetectIntent(_ttfResponseText)) {
              const _ttfSpotCalls = _ttfParseSpot(_ttfResponseText);
              if (_ttfSpotCalls.length > 0) {
                log.warn(
                  `[attempt] ⚠️ P88: provider 正常但当前回复含文本格式工具调用 ` +
                    `(${_ttfSpotCalls.length} 个: ${_ttfSpotCalls.map((c) => c.tool).join(", ")}), ` +
                    `执行单次回退恢复（不标记降级）`,
                );

                // 执行工具调用
                const _ttfSpotResults = await _ttfExecute(_ttfSpotCalls, tools);

                // 记录工具元数据（与原生 tool call 统一追踪）
                for (const r of _ttfSpotResults) {
                  toolMetas.push({
                    toolName: r.tool,
                    meta: r.success
                      ? r.result.slice(0, 500)
                      : `ERROR: ${r.error}`,
                  });
                }

                // 注入结果并重新请求 LLM 继续
                const _ttfSpotResultPrompt = _ttfFormatResults(_ttfSpotResults);
                try {
                  await abortable(activeSession.prompt(_ttfSpotResultPrompt));
                  messagesSnapshot = activeSession.messages.slice();
                } catch (err) {
                  promptError = err;
                }

                spotRecoveryExecuted = true;
                log.info(
                  `[attempt] ✅ P88 单次回退完成: ${_ttfSpotCalls.length} 个工具调用已执行 (spotRecoveryExecuted=true)`,
                );
              }
            }
          }
        }
        // ═══════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════
        // Step 5.7: P118b — 截断自动续传恢复（continue_generation 安全网）
        // 当 LLM 输出因 maxOutputTokens 被截断但未主动调用 continue_generation 时，
        // 系统自动检测 stopReason 并注入续传请求重新 prompt LLM。
        // 这解决了 P118 的核心盲区：截断 = LLM 已无法调用任何工具（包括 continue_generation）。
        // ═══════════════════════════════════════════════════════════════
        const _P118B_TRUNCATION_REASONS = new Set(["length", "max_tokens"]);
        const _P118B_MAX_AUTO_CONT = 5;
        if (!promptError && !aborted && !params.disableTools) {
          const _p118bHasContinueTool = tools.some((t) => t.name === "continue_generation");
          let _p118bAutoContCount = 0;

          while (_p118bAutoContCount < _P118B_MAX_AUTO_CONT && !promptError && !aborted) {
            // 获取最新的 lastAssistant（经过 Step 5.5/P88 可能已更新）
            const _p118bLatestAssistant = messagesSnapshot
              .slice()
              .reverse()
              .find((m) => (m as AgentMessage)?.role === "assistant") as AssistantMessage | undefined;

            if (
              !_p118bLatestAssistant?.stopReason ||
              !_P118B_TRUNCATION_REASONS.has(_p118bLatestAssistant.stopReason)
            ) {
              break; // 不是截断，正常结束
            }

            _p118bAutoContCount++;
            log.warn(
              `[attempt] ⚠️ P118b: 输出被截断 (stopReason=${_p118bLatestAssistant.stopReason}), ` +
              `自动续传 #${_p118bAutoContCount}/${_P118B_MAX_AUTO_CONT}` +
              (_p118bHasContinueTool ? "" : " (无 continue_generation 工具)"),
            );

            // 引导 LLM 从断点继续：有 continue_generation 时提醒使用，否则直接要求继续
            const _p118bContPrompt = _p118bHasContinueTool
              ? `[系统提示] 你的回复因 token 限制被截断了。请调用 continue_generation 工具记录进度摘要，然后从上次停止的地方继续完成任务。不要重复已输出的内容。`
              : `[系统提示] 你的回复因 token 限制被截断了。请从上次停止的地方继续，完成未完成的工作。不要重复已输出的内容，尽量精简表述。`;

            try {
              await abortable(activeSession.prompt(_p118bContPrompt));
              messagesSnapshot = activeSession.messages.slice();
            } catch (err) {
              promptError = err;
              break;
            }
          }

          if (_p118bAutoContCount > 0) {
            log.info(
              `[attempt] ✅ P118b 截断自动续传完成: ${_p118bAutoContCount} 轮`,
            );
          }
        }
        // ═══════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════
        // Step 5.8: No-op Guard（防“聊嗨就结束/不分解”安全网）
        // 当任务被 CP0 判定为复杂（suggest/force），但本轮回复没有任何工具调用，
        // 且输出内容疑似闲聊/承诺/计划（未执行关键动作），则自动再 prompt 1 次强约束引导。
        // 设计目标：把“是否入队/是否行动”从 LLM 自觉，升级为系统的硬护栏。
        // ═══════════════════════════════════════════════════════════════
        if (!promptError && !aborted && !params.disableTools) {
          try {
            const { getActiveContext } = await import("../../intelligent-task-decomposition/intent-complexity-analyzer.js");
            const sk = params.sessionKey?.trim();
            const cp0 = sk ? getActiveContext(sk)?.intentAnalysis : undefined;
            const shouldGuard = Boolean(cp0 && cp0.strategy !== "direct");
            const hasAnyToolCalls = toolMetas.length > 0;
            const lastText = assistantTexts.slice(-1).join("\n");
            const looksLikeNoOp =
              /(?:计划|打算|稍后|接下来|我会|我将|允许我|先为你|先给你|先展示|请允许|开始动手|现在就开始)/.test(
                lastText,
              ) &&
              !/(?:已完成|已写入|已保存|已创建|已更新|已修改|已归档|已入队|enqueue_task|memory_write|write\b|edit\b)/.test(
                lastText,
              );

            // 仅在“应分解/应执行”且“没工具调用且疑似空转”时触发
            if (shouldGuard && !hasAnyToolCalls && looksLikeNoOp) {
              log.warn(
                `[attempt] ⚠️ No-op Guard triggered (cp0=${cp0?.strategy ?? "unknown"}): ` +
                  `no tool calls + reply looks like planning/chat. Forcing a constrained reprompt.`,
              );

              const guardPrompt =
                "[系统提示][No-op Guard] 你上一条回复没有执行任何实际操作。" +
                "当前请求被系统判定为复杂任务，你必须立刻采取行动：\n" +
                "- 若需要分解：请调用 enqueue_task 创建可执行的子任务（不要只写计划）。\n" +
                "- 若不分解：请至少调用一个工具完成关键一步（read/memory_search/write 等）。\n" +
                "- 禁止闲聊与承诺式描述；先行动，后用 1-2 句总结。";

              try {
                await abortable(activeSession.prompt(guardPrompt));
                messagesSnapshot = activeSession.messages.slice();
              } catch (err) {
                promptError = err;
              }
            }
          } catch (err) {
            // 兜底：守卫异常不阻塞主流程
            log.warn(`[attempt] No-op Guard failed (non-blocking): ${String(err)}`);
          }
        }
        // ═══════════════════════════════════════════════════════════════

        sessionIdUsed = activeSession.sessionId;
        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: promptError ? "prompt error" : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        // Run agent_end hooks to allow plugins to analyze the conversation
        // This is fire-and-forget, so we don't await
        if (hookRunner?.hasHooks("agent_end")) {
          hookRunner
            .runAgentEnd(
              {
                messages: messagesSnapshot,
                success: !aborted && !promptError,
                error: promptError ? describeUnknownError(promptError) : undefined,
                durationMs: Date.now() - promptStartedAt,
              },
              {
                agentId: params.sessionKey?.split(":")[0] ?? "main",
                sessionKey: params.sessionKey,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
              },
            )
            .catch((err) => {
              log.warn(`agent_end hook failed: ${err}`);
            });
        }
      } finally {
        clearTimeout(abortTimer);
        if (abortWarnTimer) clearTimeout(abortWarnTimer);
        clearTimeout(timeoutHandle); // 🚨 Bug #1 修复: 清理超时定时器
        unsubscribe();
        clearActiveEmbeddedRun(params.sessionId, queueHandle);
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }

      const lastAssistant = messagesSnapshot
        .slice()
        .reverse()
        .find((m) => (m as AgentMessage)?.role === "assistant") as AssistantMessage | undefined;

      const toolMetasNormalized = toolMetas
        .filter(
          (entry): entry is { toolName: string; meta?: string } =>
            typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({ toolName: entry.toolName, meta: entry.meta }));

      const cloudCodeAssistFormatError = Boolean(
        lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
      );

      const buildAttemptOutcome = (): AttemptOutcome => {
        const msg =
          (promptError instanceof Error ? promptError.message : promptError ? String(promptError) : "").trim();

        const lower = msg.toLowerCase();
        const isContextOverflow =
          /context.*(?:length|limit|overflow|exceeded)|maximum.*(?:context|token)|prompt.*too.*long|request.*too.*large/i.test(
            msg,
          );
        const isRateLimit =
          /429|too many requests|rate[_ -]?limit|负载已饱和|请稍后再试|overloaded|upstream.*saturated/i.test(msg);

        if (aborted && timedOut) {
          return {
            kind: "timeout",
            ok: false,
            retryable: true,
            suggestedAction: "retry",
            suggestedDelayMs: 2000,
            details: { message: msg, provider: params.provider, modelId: params.modelId },
          };
        }
        if (aborted) {
          return {
            kind: "aborted",
            ok: false,
            retryable: true,
            suggestedAction: "retry",
            suggestedDelayMs: 1000,
            details: { message: msg, provider: params.provider, modelId: params.modelId },
          };
        }
        if (cloudCodeAssistFormatError) {
          return {
            kind: "cloud_code_assist_format_error",
            ok: false,
            retryable: true,
            suggestedAction: "degrade",
            suggestedDelayMs: 500,
            details: { message: lastAssistant?.errorMessage ?? msg, provider: params.provider, modelId: params.modelId },
            hints: { needsTextToolMode: true },
          };
        }
        if (promptError) {
          if (isContextOverflow) {
            return {
              kind: "context_overflow",
              ok: false,
              retryable: false,
              suggestedAction: "shrink_context",
              details: { message: msg, provider: params.provider, modelId: params.modelId },
              hints: { needsContextShrink: true },
            };
          }
          if (isRateLimit) {
            return {
              kind: "rate_limit",
              ok: false,
              retryable: true,
              suggestedAction: "retry",
              suggestedDelayMs: 4000,
              details: { message: msg, provider: params.provider, modelId: params.modelId },
            };
          }
          if (/compaction/i.test(lower)) {
            return {
              kind: "compaction_failure",
              ok: false,
              retryable: true,
              suggestedAction: "retry",
              suggestedDelayMs: 1000,
              details: { message: msg, provider: params.provider, modelId: params.modelId },
            };
          }
          return {
            kind: "provider_error",
            ok: false,
            retryable: true,
            suggestedAction: "retry",
            suggestedDelayMs: 1500,
            details: { message: msg, provider: params.provider, modelId: params.modelId },
          };
        }

        if (spotRecoveryExecuted) {
          return {
            kind: "ok",
            ok: true,
            retryable: false,
            suggestedAction: "continue",
            details: { provider: params.provider, modelId: params.modelId },
          };
        }

        const lastToolErr = getLastToolError?.();
        if (lastToolErr?.error) {
          return {
            kind: "tool_error",
            ok: false,
            retryable: true,
            suggestedAction: "retry",
            suggestedDelayMs: 800,
            details: {
              message: lastToolErr.error,
              provider: params.provider,
              modelId: params.modelId,
              toolName: lastToolErr.toolName,
            },
          };
        }

        return {
          kind: "ok",
          ok: true,
          retryable: false,
          suggestedAction: "continue",
          details: { provider: params.provider, modelId: params.modelId },
        };
      };

      return {
        aborted,
        timedOut,
        promptError,
        sessionIdUsed,
        systemPromptReport,
        messagesSnapshot,
        assistantTexts,
        toolMetas: toolMetasNormalized,
        lastAssistant,
        lastToolError: getLastToolError?.(),
        attemptOutcome: buildAttemptOutcome(),
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        // 🔧 P98: P88 Spot Recovery 成功执行后为 true
        spotRecoveryExecuted,
        cloudCodeAssistFormatError,
        // Client tool call detected (OpenResponses hosted tools)
        clientToolCall: clientToolCallDetected ?? undefined,
      };
    } finally {
      // Always tear down the session (and release the lock) before we leave this attempt.
      sessionManager?.flushPendingToolResults?.();
      session?.dispose();
      await sessionLock.release();
    }
  } finally {
    restoreSkillEnv?.();
    process.chdir(prevCwd);
  }
}
