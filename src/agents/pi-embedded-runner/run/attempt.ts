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
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";
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
    const { bootstrapFiles: hookAdjustedBootstrapFiles, contextFiles } =
      await resolveBootstrapContextForRun({
        workspaceDir: effectiveWorkspace,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        promptLanguage,
        warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
      });
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
    const tools = sanitizeToolsForGoogle({ tools: toolsRaw, provider: params.provider });
    logToolSchemasForGoogle({ tools, provider: params.provider });

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
        } catch (hookErr) {
          log.warn(`before_agent_start hook failed: ${String(hookErr)}`);
        }
      }
      
      // 🆕 promptMode 逻辑：子代理或角色化对话使用 minimal，否则使用 full
      const promptMode = 
        isSubagentSessionKey(params.sessionKey) || hookCharacterName
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
            ? `${personaPrompt}\n\n${enhancedExtraSystemPrompt}`
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

      // Step 4: 生成 system prompt
      const appendPrompt = await buildEmbeddedSystemPrompt({
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
        tools,
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
        tools,
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

      const { builtInTools, customTools } = splitSdkTools({
        tools,
        sandboxEnabled: !!sandbox?.enabled,
      });

      // Add client tools (OpenResponses hosted tools) to customTools
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      const clientToolDefs = params.clientTools
        ? toClientToolDefinitions(params.clientTools, (toolName, toolParams) => {
            clientToolCallDetected = { name: toolName, params: toolParams };
          })
        : [];

      const allCustomTools = [...customTools, ...clientToolDefs];

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
        
        cacheTrace?.recordStage("session:sanitized", { messages: prior });
        const validatedGemini = transcriptPolicy.validateGeminiTurns
          ? validateGeminiTurns(prior)
          : prior;
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
            tools,
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
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        cloudCodeAssistFormatError: Boolean(
          lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
        ),
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
