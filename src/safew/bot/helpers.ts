import { formatLocationText, type NormalizedLocation } from "../../channels/location.js";
import type { SafewAccountConfig } from "../../config/types.safew.js";
import type {
  SafewForwardChat,
  SafewForwardOrigin,
  SafewForwardUser,
  SafewForwardedMessage,
  SafewLocation,
  SafewMessage,
  SafewStreamMode,
  SafewVenue,
} from "./types.js";

const SAFEW_GENERAL_TOPIC_ID = 1;

export function resolveSafewForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}) {
  if (params.isForum && params.messageThreadId == null) {
    return SAFEW_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId ?? undefined;
}

/**
 * Build thread params for Safew API calls (messages, media).
 * General forum topic (id=1) must be treated like a regular supergroup send:
 * Safew rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
 */
export function buildSafewThreadParams(messageThreadId?: number) {
  if (messageThreadId == null) {
    return undefined;
  }
  const normalized = Math.trunc(messageThreadId);
  if (normalized === SAFEW_GENERAL_TOPIC_ID) {
    return undefined;
  }
  return { message_thread_id: normalized };
}

/**
 * Build thread params for typing indicators (sendChatAction).
 * Empirically, General topic (id=1) needs message_thread_id for typing to appear.
 */
export function buildTypingThreadParams(messageThreadId?: number) {
  if (messageThreadId == null) {
    return undefined;
  }
  return { message_thread_id: Math.trunc(messageThreadId) };
}

export function resolveSafewStreamMode(
  safewCfg: Pick<SafewAccountConfig, "streamMode"> | undefined,
): SafewStreamMode {
  const raw = safewCfg?.streamMode?.trim().toLowerCase();
  if (raw === "off" || raw === "partial" || raw === "block") return raw;
  return "partial";
}

export function buildSafewGroupPeerId(chatId: number | string, messageThreadId?: number) {
  return messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
}

export function buildSafewGroupFrom(chatId: number | string, messageThreadId?: number) {
  return `safew:group:${buildSafewGroupPeerId(chatId, messageThreadId)}`;
}

export function buildSenderName(msg: SafewMessage) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() ||
    msg.from?.username;
  return name || undefined;
}

export function buildSenderLabel(msg: SafewMessage, senderId?: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const normalizedSenderId =
    senderId != null && `${senderId}`.trim() ? `${senderId}`.trim() : undefined;
  const fallbackId = normalizedSenderId ?? (msg.from?.id != null ? String(msg.from.id) : undefined);
  const idPart = fallbackId ? `id:${fallbackId}` : undefined;
  if (label && idPart) return `${label} ${idPart}`;
  if (label) return label;
  return idPart ?? "id:unknown";
}

export function buildGroupLabel(
  msg: SafewMessage,
  chatId: number | string,
  messageThreadId?: number,
) {
  const title = msg.chat?.title;
  const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
  if (title) return `${title} id:${chatId}${topicSuffix}`;
  return `group:${chatId}${topicSuffix}`;
}

export function hasBotMention(msg: SafewMessage, botUsername: string) {
  const text = (msg.text ?? msg.caption ?? "").toLowerCase();
  if (text.includes(`@${botUsername}`)) return true;
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const ent of entities) {
    if (ent.type !== "mention") continue;
    const slice = (msg.text ?? msg.caption ?? "").slice(ent.offset, ent.offset + ent.length);
    if (slice.toLowerCase() === `@${botUsername}`) return true;
  }
  return false;
}

type SafewTextLinkEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};

export function expandTextLinks(text: string, entities?: SafewTextLinkEntity[] | null): string {
  if (!text || !entities?.length) return text;

  const textLinks = entities
    .filter(
      (entity): entity is SafewTextLinkEntity & { url: string } =>
        entity.type === "text_link" && Boolean(entity.url),
    )
    .sort((a, b) => b.offset - a.offset);

  if (textLinks.length === 0) return text;

  let result = text;
  for (const entity of textLinks) {
    const linkText = text.slice(entity.offset, entity.offset + entity.length);
    const markdown = `[${linkText}](${entity.url})`;
    result =
      result.slice(0, entity.offset) + markdown + result.slice(entity.offset + entity.length);
  }
  return result;
}

export function resolveSafewReplyId(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function describeReplyTarget(msg: SafewMessage) {
  const reply = msg.reply_to_message;
  if (!reply) return null;
  const replyBody = (reply.text ?? reply.caption ?? "").trim();
  let body = replyBody;
  if (!body) {
    if (reply.photo) body = "<media:image>";
    else if (reply.video) body = "<media:video>";
    else if (reply.audio || reply.voice) body = "<media:audio>";
    else if (reply.document) body = "<media:document>";
    else {
      const locationData = extractSafewLocation(reply);
      if (locationData) body = formatLocationText(locationData);
    }
  }
  if (!body) return null;
  const sender = buildSenderName(reply);
  const senderLabel = sender ? `${sender}` : "unknown sender";
  return {
    id: reply.message_id ? String(reply.message_id) : undefined,
    sender: senderLabel,
    body,
  };
}

export type SafewForwardedContext = {
  from: string;
  date?: number;
  fromType: string;
  fromId?: string;
  fromUsername?: string;
  fromTitle?: string;
  fromSignature?: string;
};

function normalizeForwardedUserLabel(user: SafewForwardUser) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = user.username?.trim() || undefined;
  const id = user.id != null ? String(user.id) : undefined;
  const display =
    (name && username
      ? `${name} (@${username})`
      : name || (username ? `@${username}` : undefined)) || (id ? `user:${id}` : undefined);
  return { display, name: name || undefined, username, id };
}

function normalizeForwardedChatLabel(chat: SafewForwardChat, fallbackKind: "chat" | "channel") {
  const title = chat.title?.trim() || undefined;
  const username = chat.username?.trim() || undefined;
  const id = chat.id != null ? String(chat.id) : undefined;
  const display =
    title || (username ? `@${username}` : undefined) || (id ? `${fallbackKind}:${id}` : undefined);
  return { display, title, username, id };
}

function buildForwardedContextFromUser(params: {
  user: SafewForwardUser;
  date?: number;
  type: string;
}): SafewForwardedContext | null {
  const { display, name, username, id } = normalizeForwardedUserLabel(params.user);
  if (!display) return null;
  return {
    from: display,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: name,
  };
}

function buildForwardedContextFromHiddenName(params: {
  name?: string;
  date?: number;
  type: string;
}): SafewForwardedContext | null {
  const trimmed = params.name?.trim();
  if (!trimmed) return null;
  return {
    from: trimmed,
    date: params.date,
    fromType: params.type,
    fromTitle: trimmed,
  };
}

function buildForwardedContextFromChat(params: {
  chat: SafewForwardChat;
  date?: number;
  type: string;
  signature?: string;
}): SafewForwardedContext | null {
  const fallbackKind =
    params.type === "channel" || params.type === "legacy_channel" ? "channel" : "chat";
  const { display, title, username, id } = normalizeForwardedChatLabel(params.chat, fallbackKind);
  if (!display) return null;
  const signature = params.signature?.trim() || undefined;
  const from = signature ? `${display} (${signature})` : display;
  return {
    from,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: title,
    fromSignature: signature,
  };
}

function resolveForwardOrigin(
  origin: SafewForwardOrigin,
  signature?: string,
): SafewForwardedContext | null {
  if (origin.type === "user" && origin.sender_user) {
    return buildForwardedContextFromUser({
      user: origin.sender_user,
      date: origin.date,
      type: "user",
    });
  }
  if (origin.type === "hidden_user") {
    return buildForwardedContextFromHiddenName({
      name: origin.sender_user_name,
      date: origin.date,
      type: "hidden_user",
    });
  }
  if (origin.type === "chat" && origin.sender_chat) {
    return buildForwardedContextFromChat({
      chat: origin.sender_chat,
      date: origin.date,
      type: "chat",
      signature,
    });
  }
  if (origin.type === "channel" && origin.chat) {
    return buildForwardedContextFromChat({
      chat: origin.chat,
      date: origin.date,
      type: "channel",
      signature,
    });
  }
  return null;
}

/**
 * Extract forwarded message origin info from Safew message.
 * Supports both new forward_origin API and legacy forward_from/forward_from_chat fields.
 */
export function normalizeForwardedContext(msg: SafewMessage): SafewForwardedContext | null {
  const forwardMsg = msg as SafewForwardedMessage;
  const signature = forwardMsg.forward_signature?.trim() || undefined;

  if (forwardMsg.forward_origin) {
    const originContext = resolveForwardOrigin(forwardMsg.forward_origin, signature);
    if (originContext) return originContext;
  }

  if (forwardMsg.forward_from_chat) {
    const legacyType =
      forwardMsg.forward_from_chat.type === "channel" ? "legacy_channel" : "legacy_chat";
    const legacyContext = buildForwardedContextFromChat({
      chat: forwardMsg.forward_from_chat,
      date: forwardMsg.forward_date,
      type: legacyType,
      signature,
    });
    if (legacyContext) return legacyContext;
  }

  if (forwardMsg.forward_from) {
    const legacyContext = buildForwardedContextFromUser({
      user: forwardMsg.forward_from,
      date: forwardMsg.forward_date,
      type: "legacy_user",
    });
    if (legacyContext) return legacyContext;
  }

  const hiddenContext = buildForwardedContextFromHiddenName({
    name: forwardMsg.forward_sender_name,
    date: forwardMsg.forward_date,
    type: "legacy_hidden_user",
  });
  if (hiddenContext) return hiddenContext;

  return null;
}

export function extractSafewLocation(msg: SafewMessage): NormalizedLocation | null {
  const msgWithLocation = msg as {
    location?: SafewLocation;
    venue?: SafewVenue;
  };
  const { venue, location } = msgWithLocation;

  if (venue) {
    return {
      latitude: venue.location.latitude,
      longitude: venue.location.longitude,
      accuracy: venue.location.horizontal_accuracy,
      name: venue.title,
      address: venue.address,
      source: "place",
      isLive: false,
    };
  }

  if (location) {
    const isLive = typeof location.live_period === "number" && location.live_period > 0;
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.horizontal_accuracy,
      source: isLive ? "live" : "pin",
      isLive,
    };
  }

  return null;
}
