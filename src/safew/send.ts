import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  ReactionType,
  ReactionTypeEmoji,
} from "@grammyjs/types";
import { type ApiClientOptions, Bot, HttpError, InputFile } from "grammy";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import type { RetryConfig } from "../infra/retry.js";
import { createSafewRetryRunner } from "../infra/retry-policy.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { mediaKindFromMime } from "../media/constants.js";
import { isGifMedia } from "../media/mime.js";
import { loadWebMedia } from "../web/media.js";
import { type ResolvedSafewAccount, resolveSafewAccount } from "./accounts.js";
import { resolveSafewFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";
import { renderSafewHtmlText } from "./format.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { splitSafewCaption } from "./caption.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseSafewTarget, stripSafewInternalPrefixes } from "./targets.js";
import { resolveSafewVoiceSend } from "./voice.js";
import { buildSafewThreadParams } from "./bot/helpers.js";

type SafewSendOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  maxBytes?: number;
  api?: Bot["api"];
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  plainText?: string;
  /** Send audio as voice message (voice bubble) instead of audio file. Defaults to false. */
  asVoice?: boolean;
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Inline keyboard buttons (reply markup). */
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
};

type SafewSendResult = {
  messageId: string;
  chatId: string;
};

type SafewReactionOpts = {
  token?: string;
  accountId?: string;
  api?: Bot["api"];
  remove?: boolean;
  verbose?: boolean;
  retry?: RetryConfig;
};

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const diagLogger = createSubsystemLogger("safew/diagnostic");

function createSafewHttpLogger(cfg: ReturnType<typeof loadConfig>) {
  const enabled = isDiagnosticFlagEnabled("safew.http", cfg);
  if (!enabled) {
    return () => {};
  }
  return (label: string, err: unknown) => {
    if (!(err instanceof HttpError)) return;
    const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
    diagLogger.warn(`safew http error (${label}): ${detail}`);
  };
}

function resolveSafewClientOptions(
  account: ResolvedSafewAccount,
): ApiClientOptions | undefined {
  const proxyUrl = account.config.proxy?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const fetchImpl = resolveSafewFetch(proxyFetch);
  const timeoutSeconds =
    typeof account.config.timeoutSeconds === "number" &&
    Number.isFinite(account.config.timeoutSeconds)
      ? Math.max(1, Math.floor(account.config.timeoutSeconds))
      : undefined;
  return {
    apiRoot: "https://api.safew.org",
    ...(fetchImpl ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  };
}

function resolveToken(explicit: string | undefined, params: { accountId: string; token: string }) {
  if (explicit?.trim()) return explicit.trim();
  if (!params.token) {
    throw new Error(
      `Safew bot token missing for account "${params.accountId}" (set channels.safew.accounts.${params.accountId}.botToken/tokenFile or SAFEW_BOT_TOKEN for default).`,
    );
  }
  return params.token.trim();
}

function normalizeChatId(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Recipient is required for Safew sends");

  // Common internal prefixes that sometimes leak into outbound sends.
  // - ctx.To uses `safew:<id>`
  // - group sessions often use `safew:group:<id>`
  let normalized = stripSafewInternalPrefixes(trimmed);

  // Accept t.me links for public chats/channels.
  // (Invite links like `t.me/+...` are not resolvable via Bot API.)
  const m =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (m?.[1]) normalized = `@${m[1]}`;

  if (!normalized) throw new Error("Recipient is required for Safew sends");
  if (normalized.startsWith("@")) return normalized;
  if (/^-?\d+$/.test(normalized)) return normalized;

  // If the user passed a username without `@`, assume they meant a public chat/channel.
  if (/^[A-Za-z0-9_]{5,}$/i.test(normalized)) return `@${normalized}`;

  return normalized;
}

function normalizeMessageId(raw: string | number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      throw new Error("Message id is required for Safew actions");
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("Message id is required for Safew actions");
}

export function buildInlineKeyboard(
  buttons?: SafewSendOpts["buttons"],
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) return undefined;
  const rows = buttons
    .map((row) =>
      row
        .filter((button) => button?.text && button?.callback_data)
        .map(
          (button): InlineKeyboardButton => ({
            text: button.text,
            callback_data: button.callback_data,
          }),
        ),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) return undefined;
  return { inline_keyboard: rows };
}

export async function sendMessageSafew(
  to: string,
  text: string,
  opts: SafewSendOpts = {},
): Promise<SafewSendResult> {
  const cfg = loadConfig();
  const account = resolveSafewAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const target = parseSafewTarget(to);
  const chatId = normalizeChatId(target.chatId);
  // Use provided api or create a new Bot instance. The nullish coalescing
  // operator ensures api is always defined (Bot.api is always non-null).
  const client = resolveSafewClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const mediaUrl = opts.mediaUrl?.trim();
  const replyMarkup = buildInlineKeyboard(opts.buttons);

  // Build optional params for forum topics and reply threading.
  // Only include these if actually provided to keep API calls clean.
  const messageThreadId =
    opts.messageThreadId != null ? opts.messageThreadId : target.messageThreadId;
  const threadIdParams = buildSafewThreadParams(messageThreadId);
  const threadParams: Record<string, number> = threadIdParams ? { ...threadIdParams } : {};
  if (opts.replyToMessageId != null) {
    threadParams.reply_to_message_id = Math.trunc(opts.replyToMessageId);
  }
  const hasThreadParams = Object.keys(threadParams).length > 0;
  const request = createSafewRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  const logHttpError = createSafewHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    request(fn, label).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });
  const wrapSafewSendError = (err: unknown) => {
    const errText = formatErrorMessage(err);

    if (/\b401\b.*unauthorized/i.test(errText) || /401:\s*unauthorized/i.test(errText)) {
      return new Error(
        [
          `Safew send failed: Unauthorized (401). accountId=${account.accountId} chat_id=${chatId}.`,
          `Input was: ${JSON.stringify(to)}.`,
          "Likely:",
          "- bot token is wrong for this accountId",
          "- SAFEW_BOT_TOKEN / channels.safew.accounts.<id>.botToken/tokenFile not loaded as expected",
          "- token was revoked / account mapping mismatch",
        ].join(" "),
      );
    }

    if (/\b403\b.*forbidden/i.test(errText) || /403:\s*forbidden/i.test(errText)) {
      return new Error(
        [
          `Safew send failed: Forbidden (403). accountId=${account.accountId} chat_id=${chatId}.`,
          `Input was: ${JSON.stringify(to)}.`,
          "Likely:",
          "- bot is not a member of the group/channel",
          "- bot lacks permission to post in the target chat",
          "- posting is disabled for the bot/user in that chat",
        ].join(" "),
      );
    }

    if (/400: Bad Request: chat not found/i.test(errText)) {
      return new Error(
        [
          `Safew send failed: chat not found (chat_id=${chatId}). accountId=${account.accountId}.`,
          "Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
          `Input was: ${JSON.stringify(to)}.`,
        ].join(" "),
      );
    }

    return err;
  };

  const textMode = opts.textMode ?? "markdown";
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "safew",
    accountId: account.accountId,
  });
  const renderHtmlText = (value: string) => renderSafewHtmlText(value, { textMode, tableMode });

  // Resolve link preview setting from config (default: enabled).
  const linkPreviewEnabled = account.config.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };

  const sendSafewText = async (
    rawText: string,
    params?: Record<string, unknown>,
    fallbackText?: string,
  ) => {
    const htmlText = renderHtmlText(rawText);
    const baseParams = params ? { ...params } : {};
    if (linkPreviewOptions) {
      baseParams.link_preview_options = linkPreviewOptions;
    }
    const hasBaseParams = Object.keys(baseParams).length > 0;
    const sendParams = {
      parse_mode: "HTML" as const,
      ...baseParams,
    };
    const res = await requestWithDiag(
      () => api.sendMessage(chatId, htmlText, sendParams),
      "message",
    ).catch(async (err) => {
      // Safew rejects malformed HTML (e.g., unsupported tags or entities).
      // When that happens, fall back to plain text so the message still delivers.
      const errText = formatErrorMessage(err);
      if (PARSE_ERR_RE.test(errText)) {
        if (opts.verbose) {
          console.warn(`safew HTML parse failed, retrying as plain text: ${errText}`);
        }
        const fallback = fallbackText ?? rawText;
        const plainParams = hasBaseParams ? baseParams : undefined;
        return await requestWithDiag(
          () =>
            plainParams
              ? api.sendMessage(chatId, fallback, plainParams)
              : api.sendMessage(chatId, fallback),
          "message-plain",
        ).catch((err2) => {
          throw wrapSafewSendError(err2);
        });
      }
      throw wrapSafewSendError(err);
    });
    return res;
  };

  if (mediaUrl) {
    const media = await loadWebMedia(mediaUrl, opts.maxBytes);
    const kind = mediaKindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });
    const fileName = media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind)) ?? "file";
    const file = new InputFile(media.buffer, fileName);
    const { caption, followUpText } = splitSafewCaption(text);
    const htmlCaption = caption ? renderHtmlText(caption) : undefined;
    // If text exceeds Safew's caption limit, send media without caption
    // then send text as a separate follow-up message.
    const needsSeparateText = Boolean(followUpText);
    // When splitting, put reply_markup only on the follow-up text (the "main" content),
    // not on the media message.
    const baseMediaParams = {
      ...(hasThreadParams ? threadParams : {}),
      ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
    const mediaParams = {
      caption: htmlCaption,
      ...(htmlCaption ? { parse_mode: "HTML" as const } : {}),
      ...baseMediaParams,
    };
    let result:
      | Awaited<ReturnType<typeof api.sendPhoto>>
      | Awaited<ReturnType<typeof api.sendVideo>>
      | Awaited<ReturnType<typeof api.sendAudio>>
      | Awaited<ReturnType<typeof api.sendVoice>>
      | Awaited<ReturnType<typeof api.sendAnimation>>
      | Awaited<ReturnType<typeof api.sendDocument>>;
    if (isGif) {
      result = await requestWithDiag(
        () => api.sendAnimation(chatId, file, mediaParams),
        "animation",
      ).catch((err) => {
        throw wrapSafewSendError(err);
      });
    } else if (kind === "image") {
      result = await requestWithDiag(() => api.sendPhoto(chatId, file, mediaParams), "photo").catch(
        (err) => {
          throw wrapSafewSendError(err);
        },
      );
    } else if (kind === "video") {
      result = await requestWithDiag(() => api.sendVideo(chatId, file, mediaParams), "video").catch(
        (err) => {
          throw wrapSafewSendError(err);
        },
      );
    } else if (kind === "audio") {
      const { useVoice } = resolveSafewVoiceSend({
        wantsVoice: opts.asVoice === true, // default false (backward compatible)
        contentType: media.contentType,
        fileName,
        logFallback: logVerbose,
      });
      if (useVoice) {
        result = await requestWithDiag(
          () => api.sendVoice(chatId, file, mediaParams),
          "voice",
        ).catch((err) => {
          throw wrapSafewSendError(err);
        });
      } else {
        result = await requestWithDiag(
          () => api.sendAudio(chatId, file, mediaParams),
          "audio",
        ).catch((err) => {
          throw wrapSafewSendError(err);
        });
      }
    } else {
      result = await requestWithDiag(
        () => api.sendDocument(chatId, file, mediaParams),
        "document",
      ).catch((err) => {
        throw wrapSafewSendError(err);
      });
    }
    const mediaMessageId = String(result?.message_id ?? "unknown");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    if (result?.message_id) {
      recordSentMessage(chatId, result.message_id);
    }
    recordChannelActivity({
      channel: "safew",
      accountId: account.accountId,
      direction: "outbound",
    });

    // If text was too long for a caption, send it as a separate follow-up message.
    // Use HTML conversion so markdown renders like captions.
    if (needsSeparateText && followUpText) {
      const textParams =
        hasThreadParams || replyMarkup
          ? {
              ...threadParams,
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }
          : undefined;
      const textRes = await sendSafewText(followUpText, textParams);
      // Return the text message ID as the "main" message (it's the actual content).
      return {
        messageId: String(textRes?.message_id ?? mediaMessageId),
        chatId: resolvedChatId,
      };
    }

    return { messageId: mediaMessageId, chatId: resolvedChatId };
  }

  if (!text || !text.trim()) {
    throw new Error("Message must be non-empty for Safew sends");
  }
  const textParams =
    hasThreadParams || replyMarkup
      ? {
          ...threadParams,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;
  const res = await sendSafewText(text, textParams, opts.plainText);
  const messageId = String(res?.message_id ?? "unknown");
  if (res?.message_id) {
    recordSentMessage(chatId, res.message_id);
  }
  recordChannelActivity({
    channel: "safew",
    accountId: account.accountId,
    direction: "outbound",
  });
  return { messageId, chatId: String(res?.chat?.id ?? chatId) };
}

export async function reactMessageSafew(
  chatIdInput: string | number,
  messageIdInput: string | number,
  emoji: string,
  opts: SafewReactionOpts = {},
): Promise<{ ok: true }> {
  const cfg = loadConfig();
  const account = resolveSafewAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const client = resolveSafewClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createSafewRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  const logHttpError = createSafewHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    request(fn, label).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });
  const remove = opts.remove === true;
  const trimmedEmoji = emoji.trim();
  // Build the reaction array. We cast emoji to the grammY union type since
  // Safew validates emoji server-side; invalid emojis fail gracefully.
  const reactions: ReactionType[] =
    remove || !trimmedEmoji
      ? []
      : [{ type: "emoji", emoji: trimmedEmoji as ReactionTypeEmoji["emoji"] }];
  if (typeof api.setMessageReaction !== "function") {
    throw new Error("Safew reactions are unavailable in this bot API.");
  }
  await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
  return { ok: true };
}

type SafewDeleteOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: Bot["api"];
  retry?: RetryConfig;
};

export async function deleteMessageSafew(
  chatIdInput: string | number,
  messageIdInput: string | number,
  opts: SafewDeleteOpts = {},
): Promise<{ ok: true }> {
  const cfg = loadConfig();
  const account = resolveSafewAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const chatId = normalizeChatId(String(chatIdInput));
  const messageId = normalizeMessageId(messageIdInput);
  const client = resolveSafewClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;
  const request = createSafewRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  const logHttpError = createSafewHttpLogger(cfg);
  const requestWithDiag = <T>(fn: () => Promise<T>, label?: string) =>
    request(fn, label).catch((err) => {
      logHttpError(label ?? "request", err);
      throw err;
    });
  await requestWithDiag(() => api.deleteMessage(chatId, messageId), "deleteMessage");
  logVerbose(`[safew] Deleted message ${messageId} from chat ${chatId}`);
  return { ok: true };
}

function inferFilename(kind: ReturnType<typeof mediaKindFromMime>) {
  switch (kind) {
    case "image":
      return "image.jpg";
    case "video":
      return "video.mp4";
    case "audio":
      return "audio.ogg";
    default:
      return "file.bin";
  }
}
