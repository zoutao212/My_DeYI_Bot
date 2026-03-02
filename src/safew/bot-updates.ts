import { createDedupeCache } from "../infra/dedupe.js";
import type { SafewContext, SafewMessage } from "./bot/types.js";

const MEDIA_GROUP_TIMEOUT_MS = 500;
const RECENT_SAFEW_UPDATE_TTL_MS = 5 * 60_000;
const RECENT_SAFEW_UPDATE_MAX = 2000;

export type MediaGroupEntry = {
  messages: Array<{
    msg: SafewMessage;
    ctx: SafewContext;
  }>;
  timer: ReturnType<typeof setTimeout>;
};

export type SafewUpdateKeyContext = {
  update?: {
    update_id?: number;
    message?: SafewMessage;
    edited_message?: SafewMessage;
  };
  update_id?: number;
  message?: SafewMessage;
  callbackQuery?: { id?: string; message?: SafewMessage };
};

export const resolveSafewUpdateId = (ctx: SafewUpdateKeyContext) =>
  ctx.update?.update_id ?? ctx.update_id;

export const buildSafewUpdateKey = (ctx: SafewUpdateKeyContext) => {
  const updateId = resolveSafewUpdateId(ctx);
  if (typeof updateId === "number") return `update:${updateId}`;
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId) return `callback:${callbackId}`;
  const msg =
    ctx.message ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.callbackQuery?.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  if (typeof chatId !== "undefined" && typeof messageId === "number") {
    return `message:${chatId}:${messageId}`;
  }
  return undefined;
};

export const createSafewUpdateDedupe = () =>
  createDedupeCache({
    ttlMs: RECENT_SAFEW_UPDATE_TTL_MS,
    maxSize: RECENT_SAFEW_UPDATE_MAX,
  });

export { MEDIA_GROUP_TIMEOUT_MS };
