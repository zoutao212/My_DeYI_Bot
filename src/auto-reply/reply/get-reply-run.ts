import crypto from "node:crypto";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  resolveEmbeddedSessionLane,
} from "../../agents/pi-embedded.js";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  resolveGroupSessionKey,
  resolveSessionFilePath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { clearCommandLane, getQueueSize } from "../../process/command-queue.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { hasControlCommand } from "../command-detection.js";
import { buildMemoryWriteHint } from "../../agents/system-prompt.js";
import { SYSTEM_PROMPT_L10N_EN } from "../../agents/system-prompt.l10n.en.js";
import { SYSTEM_PROMPT_L10N_ZH } from "../../agents/system-prompt.l10n.zh.js";
import { hasNovelAssets, searchNovelAssets, formatNovelSnippetsForPromptBlocks } from "../../memory/novel-assets-searcher.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import {
  type ElevatedLevel,
  formatXHighModelHint,
  normalizeThinkLevel,
  type ReasoningLevel,
  supportsXHighThinking,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { analyzeIntentComplexity, buildComplexityGuidance, setActiveContext, type TaskIntelligenceContext } from "../../agents/intelligent-task-decomposition/intent-complexity-analyzer.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runReplyAgent } from "./agent-runner.js";
import { applySessionHints } from "./body.js";
import { routeReply } from "./route-reply.js";
import type { buildCommandContext } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import { buildGroupIntro } from "./groups.js";
import type { createModelSelectionState } from "./model-selection.js";
import { resolveQueueSettings } from "./queue.js";
import { ensureSkillSnapshot, prependSystemEvents } from "./session-updates.js";
import type { TypingController } from "./typing.js";
import { resolveTypingMode } from "./typing-mode.js";

type AgentDefaults = NonNullable<ClawdbotConfig["agents"]>["defaults"];
type ExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;

const BARE_SESSION_RESET_PROMPT =
  "A new session was started via /new or /reset. Say hi briefly (1-2 sentences) and ask what the user wants to do next. If the runtime model differs from default_model in the system prompt, mention the default model in the greeting. Do not mention internal steps, files, tools, or reasoning.";

type RunPreparedReplyParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: ClawdbotConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionCfg: ClawdbotConfig["session"];
  commandAuthorized: boolean;
  command: ReturnType<typeof buildCommandContext>;
  commandSource: string;
  allowTextCommands: boolean;
  directives: InlineDirectives;
  defaultActivation: Parameters<typeof buildGroupIntro>[0]["defaultActivation"];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ExecOverrides;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  provider: string;
  model: string;
  perMessageQueueMode?: InlineDirectives["queueMode"];
  perMessageQueueOptions?: {
    debounceMs?: number;
    cap?: number;
    dropPolicy?: InlineDirectives["dropPolicy"];
  };
  typing: TypingController;
  opts?: GetReplyOptions;
  defaultProvider: string;
  defaultModel: string;
  timeoutMs: number;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  workspaceDir: string;
  abortedLastRun: boolean;
};

export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    commandSource,
    allowTextCommands,
    directives,
    defaultActivation,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts,
    defaultProvider,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    sessionStore,
  } = params;
  let {
    sessionEntry,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    abortedLastRun,
  } = params;
  let currentSystemSent = systemSent;

  const isFirstTurnInSession = isNewSession || !currentSystemSent;
  const isGroupChat = sessionCtx.ChatType === "group";
  const wasMentioned = ctx.WasMentioned === true;
  const isHeartbeat = opts?.isHeartbeat === true;
  const typingMode = resolveTypingMode({
    configured: sessionCfg?.typingMode ?? agentCfg?.typingMode,
    isGroupChat,
    wasMentioned,
    isHeartbeat,
  });
  const shouldInjectGroupIntro = Boolean(
    isGroupChat && (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  const groupIntro = shouldInjectGroupIntro
    ? buildGroupIntro({
        cfg,
        sessionCtx,
        sessionEntry,
        defaultActivation,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  const groupSystemPrompt = sessionCtx.GroupSystemPrompt?.trim() ?? "";

  // P102: 上游意图复杂度预判 — 每条用户消息先做轻量 LLM 分析
  // 对"短 prompt + 高隐含复杂度"的请求，注入 extraSystemPrompt 引导 LLM 使用 enqueue_task
  const _p102Body = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim();
  let complexityGuidance = "";
  try {
    const _p102Result = await analyzeIntentComplexity(_p102Body, cfg, provider, model);
    complexityGuidance = buildComplexityGuidance(_p102Result);

    // UTIL P5: 将 CP0 结果存入全局 TaskIntelligenceContext，供 CP1-CP4 消费
    const _utilSessionKey = sessionKey ?? "";
    if (_utilSessionKey) {
      const _utilCtx: TaskIntelligenceContext = {
        intentAnalysis: _p102Result,
        userMessage: _p102Body,
        createdAt: Date.now(),
      };
      setActiveContext(_utilSessionKey, _utilCtx);
    }

    if (complexityGuidance) {
      console.log(
        `[get-reply-run] P102+UTIL: CP0 预判注入 (complexity=${_p102Result.complexity}, ` +
        `strategy=${_p102Result.strategy}, guidance长度=${complexityGuidance.length})`,
      );
    }
  } catch (err) {
    // 静默降级，不阻塞主流程
    console.warn(`[get-reply-run] P102+UTIL: CP0 预判异常，跳过: ${err instanceof Error ? err.message : String(err)}`);
  }

  // P89: 检测用户消息中的"记忆写入"意图，注入记忆目录路径引导
  // 升级版：优先推荐专用 CRUD 工具（memory_write/memory_update/memory_list）
  const _p89Body = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").toLowerCase();
  const _p89HasMemoryWriteIntent =
    /(?:写入|保存|整理|归档|更新|同步).{0,8}(?:记忆|memory|记忆库|记忆文件)/i.test(_p89Body) ||
    /(?:记忆|memory).{0,8}(?:写入|保存|整理|归档|更新|同步)/i.test(_p89Body);
  let memoryWriteHint = "";
  if (_p89HasMemoryWriteIntent && workspaceDir) {
    const _p89PromptLang = cfg.agents?.defaults?.promptLanguage === "zh" ? "zh" : "en";
    const _p89L10n = _p89PromptLang === "zh" ? SYSTEM_PROMPT_L10N_ZH : SYSTEM_PROMPT_L10N_EN;
    memoryWriteHint = buildMemoryWriteHint(_p89L10n, workspaceDir);
  }

  const _novelBody = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim();
  const _hasNovelStyleIntent =
    /(?:文笔|文风|写作|创作|小说|续写|描写|叙事|剧情|段落|台词|对话|视角|节奏|氛围|意象|修辞|高级作家)/i.test(
      _novelBody,
    );
  let novelReferenceHintA = "";
  let novelReferenceHintB = "";
  let novelReferenceHintC = "";
  if (_hasNovelStyleIntent && workspaceDir) {
    try {
      const available = await hasNovelAssets(workspaceDir);
      if (available) {
        const query = _novelBody.length > 0 ? _novelBody : (sessionCtx.BodyStripped ?? sessionCtx.Body ?? "");

        const maxSnippets = Number.parseInt(process.env.CLAWDBOT_NOVEL_REF_MAX_SNIPPETS ?? "", 10);
        const maxSnippetsPerFile = Number.parseInt(process.env.CLAWDBOT_NOVEL_REF_MAX_SNIPPETS_PER_FILE ?? "", 10);
        const snippetTargetChars = Number.parseInt(process.env.CLAWDBOT_NOVEL_REF_SNIPPET_TARGET_CHARS ?? "", 10);
        const maxTotalChars = Number.parseInt(process.env.CLAWDBOT_NOVEL_REF_MAX_TOTAL_CHARS ?? "", 10);
        const blocks = Number.parseInt(process.env.CLAWDBOT_NOVEL_REF_BLOCKS ?? "", 10);

        const effectiveMaxSnippets = Number.isFinite(maxSnippets) ? Math.min(12, Math.max(2, maxSnippets)) : 8;
        const effectiveMaxSnippetsPerFile = Number.isFinite(maxSnippetsPerFile)
          ? Math.min(6, Math.max(1, maxSnippetsPerFile))
          : 3;
        const effectiveSnippetTarget = Number.isFinite(snippetTargetChars)
          ? Math.min(600, Math.max(120, snippetTargetChars))
          : 260;
        const effectiveMaxTotalChars = Number.isFinite(maxTotalChars) ? Math.min(12000, Math.max(2500, maxTotalChars)) : 7000;
        const effectiveBlocks = Number.isFinite(blocks) ? Math.min(6, Math.max(1, blocks)) : 3;

        const result = await searchNovelAssets(query.substring(0, 500), workspaceDir, {
          maxSnippets: effectiveMaxSnippets,
          snippetTargetChars: effectiveSnippetTarget,
          snippetMaxChars: Math.min(800, effectiveSnippetTarget + 120),
          maxSnippetsPerFile: effectiveMaxSnippetsPerFile,
          minScore: 0.12,
          autoExtractKeywords: true,
        });
        if (result.snippets.length > 0) {
          const formattedBlocks = formatNovelSnippetsForPromptBlocks(result, {
            maxTotalChars: effectiveMaxTotalChars,
            blocks: effectiveBlocks,
          });
          if (formattedBlocks.length > 0) {
             // W13+W14: 块级指令已内嵌到 formattedBlocks 中，外层只做身份标签
             const blockRoles = ["叙事教练·节奏与视角", "风格参照·意象与质感", "技法示范·结构与张力"];
             const mk = (idx: number, body: string) =>
               `\n\n[📖 风格化学习样本｜${blockRoles[idx] ?? `样本块 ${idx + 1}`}]\n⚠️ 以下是 few-shot 写作样本，严禁照抄情节与专有名词，只学习写法。\n${body}`;
            const blockA = formattedBlocks[0] ?? "";
            const blockB = formattedBlocks[1] ?? "";
            // 超过 3 块时不浪费：把剩余块合并进 C 槽位，仍保持 A/B/C 分散注入。
            const blockC = formattedBlocks.slice(2).join("\n\n");
            novelReferenceHintA = blockA ? mk(0, blockA) : "";
            novelReferenceHintB = blockB ? mk(1, blockB) : "";
            novelReferenceHintC = blockC ? mk(2, blockC) : "";
            console.log(
              `[get-reply-run] 📖 NovelsAssets 参考注入(分块): snippets=${result.snippets.length}, blocks=${formattedBlocks.length}, ` +
              `perFile=${effectiveMaxSnippetsPerFile}, charsA=${novelReferenceHintA.length}, charsB=${novelReferenceHintB.length}, charsC=${novelReferenceHintC.length}, ${result.durationMs}ms`,
            );
          }
        }
      }
    } catch {
      // 静默降级，不阻塞主流程
    }
  }

  const extraSystemPrompt = [
    groupIntro,
    groupSystemPrompt,
    novelReferenceHintA,
    memoryWriteHint,
    novelReferenceHintB,
    complexityGuidance,
    novelReferenceHintC,
  ]
    .filter(Boolean)
    .join("\n\n");
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  // Use CommandBody/RawBody for bare reset detection (clean message without structural context).
  const rawBodyTrimmed = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  if (
    allowTextCommands &&
    (!commandAuthorized || !command.isAuthorizedSender) &&
    !baseBodyTrimmedRaw &&
    hasControlCommand(commandSource, cfg)
  ) {
    typing.cleanup();
    return undefined;
  }
  const isBareNewOrReset = rawBodyTrimmed === "/new" || rawBodyTrimmed === "/reset";
  const isBareSessionReset =
    isNewSession &&
    ((baseBodyTrimmedRaw.length === 0 && rawBodyTrimmed.length > 0) || isBareNewOrReset);
  if (isBareNewOrReset && isBareSessionReset) {
    await typing.onReplyStart();
    const modelLabel = `${provider}/${model}`;
    const defaultLabel = `${defaultProvider}/${defaultModel}`;
    const modelHint =
      modelLabel === defaultLabel
        ? `当前模型：${modelLabel}`
        : `当前模型：${modelLabel}（默认：${defaultLabel}）`;
    typing.cleanup();
    return {
      text: `✅ 已开启新会话\n${modelHint}\n\n接下来你想做什么？`,
    };
  }

  const baseBodyFinal = isBareSessionReset ? BARE_SESSION_RESET_PROMPT : baseBody;
  const baseBodyTrimmed = baseBodyFinal.trim();
  if (!baseBodyTrimmed) {
    await typing.onReplyStart();
    logVerbose("Inbound body empty after normalization; skipping agent run");
    typing.cleanup();
    return {
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    };
  }
  let prefixedBodyBase = await applySessionHints({
    baseBody: baseBodyFinal,
    abortedLastRun,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    abortKey: command.abortKey,
    messageId: sessionCtx.MessageSid,
  });
  const isGroupSession = sessionEntry?.chatType === "group" || sessionEntry?.chatType === "channel";
  const isMainSession = !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);
  prefixedBodyBase = await prependSystemEvents({
    cfg,
    sessionKey,
    isMainSession,
    isNewSession,
    prefixedBodyBase,
  });
  const threadStarterBody = ctx.ThreadStarterBody?.trim();
  const threadStarterNote =
    isNewSession && threadStarterBody
      ? `[Thread starter - for context]\n${threadStarterBody}`
      : undefined;
  const skillResult = await ensureSkillSnapshot({
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter: opts?.skillFilter,
  });
  sessionEntry = skillResult.sessionEntry ?? sessionEntry;
  currentSystemSent = skillResult.systemSent;
  const skillsSnapshot = skillResult.skillsSnapshot;
  const prefixedBody = [threadStarterNote, prefixedBodyBase].filter(Boolean).join("\n\n");
  const mediaNote = buildInboundMediaNote(ctx);
  const mediaReplyHint = mediaNote
    ? "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:/path or MEDIA:https://example.com/image.jpg (spaces ok, quote if needed). Keep caption in the text body."
    : undefined;
  let prefixedCommandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody ?? ""].filter(Boolean).join("\n").trim()
    : prefixedBody;
  if (!resolvedThinkLevel && prefixedCommandBody) {
    const parts = prefixedCommandBody.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    if (maybeLevel && (maybeLevel !== "xhigh" || supportsXHighThinking(provider, model))) {
      resolvedThinkLevel = maybeLevel;
      prefixedCommandBody = parts.slice(1).join(" ").trim();
    }
  }
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await modelState.resolveDefaultThinkingLevel();
  }
  if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    const explicitThink = directives.hasThinkDirective && directives.thinkLevel !== undefined;
    if (explicitThink) {
      typing.cleanup();
      return {
        text: `Thinking level "xhigh" is only supported for ${formatXHighModelHint()}. Use /think high or switch to one of those models.`,
      };
    }
    resolvedThinkLevel = "high";
    if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
      sessionEntry.thinkingLevel = "high";
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
    }
  }
  if (resetTriggered && command.isAuthorizedSender) {
    const channel = ctx.OriginatingChannel || (command.channel as any);
    const to = ctx.OriginatingTo || command.from || command.to;
    if (channel && to) {
      const modelLabel = `${provider}/${model}`;
      const defaultLabel = `${defaultProvider}/${defaultModel}`;
      const text =
        modelLabel === defaultLabel
          ? `✅ New session started · model: ${modelLabel}`
          : `✅ New session started · model: ${modelLabel} (default: ${defaultLabel})`;
      await routeReply({
        payload: { text },
        channel,
        to,
        sessionKey,
        accountId: ctx.AccountId,
        threadId: ctx.MessageThreadId,
        cfg,
      });
    }
  }
  const sessionIdFinal = sessionId ?? crypto.randomUUID();
  const sessionFile = resolveSessionFilePath(sessionIdFinal, sessionEntry);
  const queueBodyBase = [threadStarterNote, baseBodyFinal].filter(Boolean).join("\n\n");
  const queueMessageId = sessionCtx.MessageSid?.trim();
  const queueMessageIdHint = queueMessageId ? `[message_id: ${queueMessageId}]` : "";
  const queueBodyWithId = queueMessageIdHint
    ? `${queueBodyBase}\n${queueMessageIdHint}`
    : queueBodyBase;
  const queuedBody = mediaNote
    ? [mediaNote, mediaReplyHint, queueBodyWithId].filter(Boolean).join("\n").trim()
    : queueBodyWithId;
  const resolvedQueue = resolveQueueSettings({
    cfg,
    channel: sessionCtx.Provider,
    sessionEntry,
    inlineMode: perMessageQueueMode,
    inlineOptions: perMessageQueueOptions,
  });
  const sessionLaneKey = resolveEmbeddedSessionLane(sessionKey ?? sessionIdFinal);
  const laneSize = getQueueSize(sessionLaneKey);
  if (resolvedQueue.mode === "interrupt" && laneSize > 0) {
    const cleared = clearCommandLane(sessionLaneKey);
    const aborted = abortEmbeddedPiRun(sessionIdFinal);
    logVerbose(`Interrupting ${sessionLaneKey} (cleared ${cleared}, aborted=${aborted})`);
  }
  const queueKey = sessionKey ?? sessionIdFinal;
  const isActive = isEmbeddedPiRunActive(sessionIdFinal);
  const isStreaming = isEmbeddedPiRunStreaming(sessionIdFinal);
  const shouldSteer = resolvedQueue.mode === "steer" || resolvedQueue.mode === "steer-backlog";
  const shouldFollowup =
    resolvedQueue.mode === "followup" ||
    resolvedQueue.mode === "collect" ||
    resolvedQueue.mode === "steer-backlog";
  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg,
    provider,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    isNewSession,
  });
  const authProfileIdSource = sessionEntry?.authProfileOverrideSource;
  const followupRun = {
    prompt: queuedBody,
    messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    summaryLine: baseBodyTrimmedRaw,
    enqueuedAt: Date.now(),
    // Originating channel for reply routing.
    originatingChannel: ctx.OriginatingChannel,
    originatingTo: ctx.OriginatingTo,
    originatingAccountId: ctx.AccountId,
    originatingThreadId: ctx.MessageThreadId,
    originatingChatType: ctx.ChatType,
    run: {
      agentId,
      agentDir,
      sessionId: sessionIdFinal,
      sessionKey,
      messageProvider: sessionCtx.Provider?.trim().toLowerCase() || undefined,
      agentAccountId: sessionCtx.AccountId,
      groupId: resolveGroupSessionKey(sessionCtx)?.id ?? undefined,
      groupChannel: sessionCtx.GroupChannel?.trim() ?? sessionCtx.GroupSubject?.trim(),
      groupSpace: sessionCtx.GroupSpace?.trim() ?? undefined,
      sessionFile,
      workspaceDir,
      config: cfg,
      skillsSnapshot,
      provider,
      model,
      authProfileId,
      authProfileIdSource,
      thinkLevel: resolvedThinkLevel,
      verboseLevel: resolvedVerboseLevel,
      reasoningLevel: resolvedReasoningLevel,
      elevatedLevel: resolvedElevatedLevel,
      execOverrides,
      bashElevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        defaultLevel: resolvedElevatedLevel ?? "off",
      },
      timeoutMs,
      blockReplyBreak: resolvedBlockStreamingBreak,
      ownerNumbers: command.ownerList.length > 0 ? command.ownerList : undefined,
      extraSystemPrompt: extraSystemPrompt || undefined,
      ...(isReasoningTagProvider(provider) ? { enforceFinalTag: true } : {}),
    },
  };

  return runReplyAgent({
    commandBody: prefixedCommandBody,
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
    agentCfgContextTokens: agentCfg?.contextTokens,
    resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  });
}
