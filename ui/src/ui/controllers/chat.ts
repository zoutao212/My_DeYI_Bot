import type { GatewayBrowserClient } from "../gateway";
import { extractText } from "../chat/message-extract";
import { generateUUID } from "../uuid";

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  settings: { systemPromptLanguage: "en" | "zh" };
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) return;
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = (await state.client.request("chat.history", {
      sessionKey: state.sessionKey,
      limit: 200,
    })) as { messages?: unknown[]; thinkingLevel?: string | null };
    state.chatMessages = Array.isArray(res.messages) ? res.messages : [];
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

export type ChatAttachment = {
  fileName: string;
  mimeType: string;
  content: string; // base64 or text
};

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const msg = message.trim();
  if (!msg && (!attachments || attachments.length === 0)) return false;

  const now = Date.now();
  const displayText =
    attachments && attachments.length > 0
      ? `${msg || ""}${msg ? "\n" : ""}📎 ${attachments.map((a) => a.fileName).join(", ")}`
      : msg;

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: [{ type: "text", text: displayText }],
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;
  try {
    const payload: Record<string, unknown> = {
      sessionKey: state.sessionKey,
      message: msg || "(see attached file)",
      deliver: false,
      idempotencyKey: runId,
      promptLanguage: state.settings.systemPromptLanguage,
    };
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments.map((a) => ({
        type: "file",
        mimeType: a.mimeType,
        fileName: a.fileName,
        content: a.content,
      }));
    }
    await state.client.request("chat.send", payload);
    return true;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return false;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId
        ? { sessionKey: state.sessionKey, runId }
        : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(
  state: ChatState,
  payload?: ChatEventPayload,
) {
  if (!payload) return null;
  if (payload.sessionKey !== state.sessionKey) return null;

  // NOTE: The gateway may emit a different runId than the client-side idempotencyKey.
  // Do not drop events solely due to runId mismatch, otherwise the UI can get stuck
  // in a loading state until a manual refresh rehydrates history.

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    const finalText = extractText(payload.message);
    if (typeof finalText === "string" && finalText.trim()) {
      const last = state.chatMessages[state.chatMessages.length - 1] as
        | { role?: unknown; content?: unknown }
        | undefined;
      const lastRole = typeof last?.role === "string" ? last.role : "";
      const lastText = last ? extractText(last) : null;
      const shouldAppend =
        lastRole !== "assistant" || typeof lastText !== "string" || lastText.trim() !== finalText.trim();
      if (shouldAppend) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: finalText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
