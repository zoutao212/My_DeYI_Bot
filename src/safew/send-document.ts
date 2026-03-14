import { loadConfig } from "../config/config.js";
import { resolveSafewAccount } from "./accounts.js";
import { makeProxyFetch } from "./proxy.js";
import { resolveSafewFetch } from "./fetch.js";
import { parseSafewTarget, stripSafewInternalPrefixes } from "./targets.js";

type SendSafewDocumentParams = {
  to: string;
  fileBuffer: Buffer;
  fileName: string;
  caption?: string;
  parseMode?: "HTML" | "Markdown";
  accountId?: string;
  messageThreadId?: number;
};

type SendSafewDocumentResult = {
  ok: boolean;
  errorCode?: number;
  description?: string;
};

function normalizeChatId(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Recipient is required for Safew sends");

  let normalized = stripSafewInternalPrefixes(trimmed);

  const m =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (m?.[1]) normalized = `@${m[1]}`;

  if (!normalized) throw new Error("Recipient is required for Safew sends");
  if (normalized.startsWith("@")) return normalized;
  if (/^-?\d+$/.test(normalized)) return normalized;
  if (/^[A-Za-z0-9_]{5,}$/i.test(normalized)) return `@${normalized}`;
  return normalized;
}

export async function sendSafewDocument(
  params: SendSafewDocumentParams,
): Promise<SendSafewDocumentResult> {
  const cfg = loadConfig();
  const account = resolveSafewAccount({ cfg, accountId: params.accountId });
  const token = account.token;
  if (!token) {
    return { ok: false, errorCode: 401, description: "Safew bot token 未配置" };
  }

  const proxyUrl = account.config.proxy?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const fetchImpl = resolveSafewFetch(proxyFetch) ?? fetch;

  const target = parseSafewTarget(params.to);
  const chatId = normalizeChatId(target.chatId);

  const url = `https://api.safew.org/bot${token}/sendDocument`;

  const form = new FormData();
  form.set("chat_id", chatId);

  const blob = new Blob([new Uint8Array(params.fileBuffer)]);
  form.set("document", blob, params.fileName);

  if (params.caption) {
    form.set("caption", params.caption);
  }

  if (params.parseMode) {
    form.set("parse_mode", params.parseMode);
  }

  const messageThreadId =
    params.messageThreadId != null ? params.messageThreadId : target.messageThreadId;
  if (messageThreadId != null) {
    form.set("message_thread_id", String(messageThreadId));
  }

  const res = await fetchImpl(url, {
    method: "POST",
    body: form,
  });

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (res.ok && json?.ok) {
    return { ok: true };
  }

  const errorCode =
    typeof json?.error_code === "number" ? json.error_code : res.status || undefined;
  const description =
    typeof json?.description === "string" ? json.description : res.statusText;

  return { ok: false, errorCode, description };
}
