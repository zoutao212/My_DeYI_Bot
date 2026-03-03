// @ts-nocheck
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { ApiClientOptions } from "grammy";
import { Bot, webhookCallback } from "grammy";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "../auto-reply/reply/history.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../config/commands.js";
import type { ClawdbotConfig, ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../config/group-policy.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveSafewAccount } from "./accounts.js";
import {
  buildSafewGroupPeerId,
  resolveSafewForumThreadId,
  resolveSafewStreamMode,
} from "./bot/helpers.js";
import type { SafewContext, SafewMessage } from "./bot/types.js";
import { registerSafewHandlers } from "./bot-handlers.js";
import { createSafewMessageProcessor } from "./bot-message.js";
import { registerSafewNativeCommands } from "./bot-native-commands.js";
import {
  buildSafewUpdateKey,
  createSafewUpdateDedupe,
  resolveSafewUpdateId,
  type SafewUpdateKeyContext,
} from "./bot-updates.js";
import { resolveSafewFetch } from "./fetch.js";
import { wasSentByBot } from "./sent-message-cache.js";

export type SafewBotOptions = {
  token: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  proxyFetch?: typeof fetch;
  config?: ClawdbotConfig;
  updateOffset?: {
    lastUpdateId?: number | null;
    onUpdateId?: (updateId: number) => void | Promise<void>;
  };
};

export function getSafewSequentialKey(ctx: {
  chat?: { id?: number };
  message?: SafewMessage;
  update?: {
    message?: SafewMessage;
    edited_message?: SafewMessage;
    callback_query?: { message?: SafewMessage };
    message_reaction?: { chat?: { id?: number } };
  };
}): string {
  // Handle reaction updates
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `safew:${reaction.chat.id}`;
  }
  const msg =
    ctx.message ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = (ctx as { me?: { username?: string } }).me?.username;
  if (
    rawText &&
    isControlCommandMessage(rawText, undefined, botUsername ? { botUsername } : undefined)
  ) {
    if (typeof chatId === "number") return `safew:${chatId}:control`;
    return "safew:control";
  }
  const isForum = (msg?.chat as { is_forum?: boolean } | undefined)?.is_forum;
  const threadId = resolveSafewForumThreadId({
    isForum,
    messageThreadId: msg?.message_thread_id,
  });
  if (typeof chatId === "number") {
    return threadId != null ? `safew:${chatId}:topic:${threadId}` : `safew:${chatId}`;
  }
  return "safew:unknown";
}

export function createSafewBot(opts: SafewBotOptions) {
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const cfg = opts.config ?? loadConfig();
  const account = resolveSafewAccount({
    cfg,
    accountId: opts.accountId,
  });
  const safewCfg = account.config;

  const fetchImpl = resolveSafewFetch(opts.proxyFetch);
  const shouldProvideFetch = Boolean(fetchImpl);
  const timeoutSeconds =
    typeof safewCfg?.timeoutSeconds === "number" && Number.isFinite(safewCfg.timeoutSeconds)
      ? Math.max(1, Math.floor(safewCfg.timeoutSeconds))
      : undefined;
  const client: ApiClientOptions = {
    apiRoot: "https://api.safew.org",
    ...(shouldProvideFetch && fetchImpl
      ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
      : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  };

  const bot = new Bot(opts.token, { client });
  bot.api.config.use(apiThrottler());
  bot.use(sequentialize(getSafewSequentialKey));

  const recentUpdates = createSafewUpdateDedupe();
  let lastUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;

  const recordUpdateId = (ctx: SafewUpdateKeyContext) => {
    const updateId = resolveSafewUpdateId(ctx);
    if (typeof updateId !== "number") return;
    if (lastUpdateId !== null && updateId <= lastUpdateId) return;
    lastUpdateId = updateId;
    void opts.updateOffset?.onUpdateId?.(updateId);
  };

  const shouldSkipUpdate = (ctx: SafewUpdateKeyContext) => {
    const updateId = resolveSafewUpdateId(ctx);
    if (typeof updateId === "number" && lastUpdateId !== null) {
      if (updateId <= lastUpdateId) return true;
    }
    const key = buildSafewUpdateKey(ctx);
    const skipped = recentUpdates.check(key);
    if (skipped && key && shouldLogVerbose()) {
      logVerbose(`safew dedupe: skipped ${key}`);
    }
    return skipped;
  };

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/safew/raw-update");
  const MAX_RAW_UPDATE_CHARS = 8000;
  const MAX_RAW_UPDATE_STRING = 500;
  const MAX_RAW_UPDATE_ARRAY = 20;
  const stringifyUpdate = (update: unknown) => {
    const seen = new WeakSet<object>();
    return JSON.stringify(update ?? null, (key, value) => {
      if (typeof value === "string" && value.length > MAX_RAW_UPDATE_STRING) {
        return `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`;
      }
      if (Array.isArray(value) && value.length > MAX_RAW_UPDATE_ARRAY) {
        return [
          ...value.slice(0, MAX_RAW_UPDATE_ARRAY),
          `...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`,
        ];
      }
      if (value && typeof value === "object") {
        const obj = value as object;
        if (seen.has(obj)) return "[Circular]";
        seen.add(obj);
      }
      return value;
    });
  };

  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        const raw = stringifyUpdate(ctx.update);
        const preview =
          raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
        rawUpdateLogger.debug(`safew update: ${preview}`);
      } catch (err) {
        rawUpdateLogger.debug(`safew update log failed: ${String(err)}`);
      }
    }
    await next();
    recordUpdateId(ctx);
  });

  const historyLimit = Math.max(
    0,
    safewCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "safew", account.accountId);
  const dmPolicy = safewCfg.dmPolicy ?? "pairing";
  const allowFrom = opts.allowFrom ?? safewCfg.allowFrom;
  const groupAllowFrom =
    opts.groupAllowFrom ??
    safewCfg.groupAllowFrom ??
    (safewCfg.allowFrom && safewCfg.allowFrom.length > 0
      ? safewCfg.allowFrom
      : undefined) ??
    (opts.allowFrom && opts.allowFrom.length > 0 ? opts.allowFrom : undefined);
  const replyToMode = opts.replyToMode ?? safewCfg.replyToMode ?? "first";
  const streamMode = resolveSafewStreamMode(safewCfg);
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "safew",
    providerSetting: safewCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "safew",
    providerSetting: safewCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: safewCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? safewCfg.mediaMaxMb ?? 5) * 1024 * 1024;
  const logger = getChildLogger({ module: "safew-auto-reply" });
  let botHasTopicsEnabled: boolean | undefined;
  const resolveBotTopicsEnabled = async (ctx?: SafewContext) => {
    const fromCtx = ctx?.me as { has_topics_enabled?: boolean } | undefined;
    if (typeof fromCtx?.has_topics_enabled === "boolean") {
      botHasTopicsEnabled = fromCtx.has_topics_enabled;
      return botHasTopicsEnabled;
    }
    if (typeof botHasTopicsEnabled === "boolean") return botHasTopicsEnabled;
    try {
      const me = (await bot.api.getMe()) as { has_topics_enabled?: boolean };
      botHasTopicsEnabled = Boolean(me?.has_topics_enabled);
    } catch (err) {
      logVerbose(`safew getMe failed: ${String(err)}`);
      botHasTopicsEnabled = false;
    }
    return botHasTopicsEnabled;
  };
  const resolveGroupPolicy = (chatId: string | number) =>
    resolveChannelGroupPolicy({
      cfg,
      channel: "safew",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const sessionKey =
      params.sessionKey ??
      `agent:${agentId}:safew:group:${buildSafewGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    try {
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      if (entry?.groupActivation === "always") return false;
      if (entry?.groupActivation === "mention") return true;
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveChannelGroupRequireMention({
      cfg,
      channel: "safew",
      accountId: account.accountId,
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const resolveSafewGroupConfig = (chatId: string | number, messageThreadId?: number) => {
    const groups = safewCfg.groups;
    if (!groups) return { groupConfig: undefined, topicConfig: undefined };
    const groupKey = String(chatId);
    const groupConfig = groups[groupKey] ?? groups["*"];
    const topicConfig =
      messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : undefined;
    return { groupConfig, topicConfig };
  };

  const processMessage = createSafewMessageProcessor({
    bot,
    cfg,
    account,
    safewCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveSafewGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  });

  registerSafewNativeCommands({
    bot,
    cfg,
    runtime,
    accountId: account.accountId,
    safewCfg,
    allowFrom,
    groupAllowFrom,
    replyToMode,
    textLimit,
    useAccessGroups,
    nativeEnabled,
    nativeSkillsEnabled,
    nativeDisabledExplicit,
    resolveGroupPolicy,
    resolveSafewGroupConfig,
    shouldSkipUpdate,
    opts,
  });

  // Handle emoji reactions to messages
  bot.on("message_reaction", async (ctx) => {
    try {
      const reaction = ctx.messageReaction;
      if (!reaction) return;
      if (shouldSkipUpdate(ctx)) return;

      const chatId = reaction.chat.id;
      const messageId = reaction.message_id;
      const user = reaction.user;

      // Resolve reaction notification mode (default: "own")
      const reactionMode = safewCfg.reactionNotifications ?? "own";
      if (reactionMode === "off") return;
      if (user?.is_bot) return;
      if (reactionMode === "own" && !wasSentByBot(chatId, messageId)) return;

      // Detect added reactions
      const oldEmojis = new Set(
        reaction.old_reaction
          .filter((r): r is { type: "emoji"; emoji: string } => r.type === "emoji")
          .map((r) => r.emoji),
      );
      const addedReactions = reaction.new_reaction
        .filter((r): r is { type: "emoji"; emoji: string } => r.type === "emoji")
        .filter((r) => !oldEmojis.has(r.emoji));

      if (addedReactions.length === 0) return;

      // Build sender label
      const senderName = user
        ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username
        : undefined;
      const senderUsername = user?.username ? `@${user.username}` : undefined;
      let senderLabel = senderName;
      if (senderName && senderUsername) {
        senderLabel = `${senderName} (${senderUsername})`;
      } else if (!senderName && senderUsername) {
        senderLabel = senderUsername;
      }
      if (!senderLabel && user?.id) {
        senderLabel = `id:${user.id}`;
      }
      senderLabel = senderLabel || "unknown";

      // Extract forum thread info (similar to message processing)
      const messageThreadId = (reaction as any).message_thread_id;
      const isForum = (reaction.chat as any).is_forum === true;
      const resolvedThreadId = resolveSafewForumThreadId({
        isForum,
        messageThreadId,
      });

      // Resolve agent route for session
      const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
      const peerId = isGroup ? buildSafewGroupPeerId(chatId, resolvedThreadId) : String(chatId);
      const route = resolveAgentRoute({
        cfg,
        channel: "safew",
        accountId: account.accountId,
        peer: { kind: isGroup ? "group" : "dm", id: peerId },
      });
      const baseSessionKey = route.sessionKey;
      const dmThreadId = !isGroup ? resolvedThreadId : undefined;
      const threadKeys =
        dmThreadId != null
          ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
          : null;
      const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;

      // Enqueue system event for each added reaction
      for (const r of addedReactions) {
        const emoji = r.emoji;
        const text = `Safew reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
        enqueueSystemEvent(text, {
          sessionKey: sessionKey,
          contextKey: `safew:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`,
        });
        logVerbose(`safew: reaction event enqueued: ${text}`);
      }
    } catch (err) {
      runtime.error?.(danger(`safew reaction handler failed: ${String(err)}`));
    }
  });

  registerSafewHandlers({
    cfg,
    accountId: account.accountId,
    bot,
    opts,
    runtime,
    mediaMaxBytes,
    safewCfg,
    groupAllowFrom,
    resolveGroupPolicy,
    resolveSafewGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger,
  });

  return bot;
}

export function createSafewWebhookCallback(bot: Bot, path = "/safew-webhook") {
  return { path, handler: webhookCallback(bot, "http") };
}
