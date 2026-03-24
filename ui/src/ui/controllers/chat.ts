import type { GatewayBrowserClient } from "../gateway";
import { extractText, extractThinking } from "../chat/message-extract";
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
  chatReasoningStream?: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  messageId?: string;
  chatroomMessageText?: string;
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
  state.chatReasoningStream = null;
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
    state.chatReasoningStream = null;
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
  const hasChatroomSplitPayload =
    typeof payload.messageId === "string" && typeof payload.chatroomMessageText === "string";
  const isSameSession = payload.sessionKey === state.sessionKey;
  const isActiveRunMatch = Boolean(state.chatRunId && payload.runId === state.chatRunId);
  const isActiveChatroomRun = Boolean(state.chatRunId && payload.state === "delta");
  const shouldAcceptChatroomSplit = hasChatroomSplitPayload && isActiveChatroomRun;
  if (!isSameSession && !isActiveRunMatch && !shouldAcceptChatroomSplit) {
    if (hasChatroomSplitPayload) {
      console.debug("[chat-ui] drop split delta", {
        reason: "session/run mismatch",
        payloadRunId: payload.runId,
        payloadSessionKey: payload.sessionKey,
        stateSessionKey: state.sessionKey,
        activeRunId: state.chatRunId,
      });
    }
    return null;
  }

  // NOTE: The gateway may emit a different runId than the client-side idempotencyKey.
  // Do not drop events solely due to runId mismatch, otherwise the UI can get stuck
  // in a loading state until a manual refresh rehydrates history.

  if (payload.state === "delta") {
    const chatroomMessageId = typeof payload.messageId === "string" ? payload.messageId : null;
    const chatroomMessageText =
      typeof payload.chatroomMessageText === "string" ? payload.chatroomMessageText : null;
    if (chatroomMessageId && chatroomMessageText) {
      console.debug("[chat-ui] accept split delta", {
        payloadRunId: payload.runId,
        payloadSessionKey: payload.sessionKey,
        messageId: chatroomMessageId,
        textLength: chatroomMessageText.length,
        activeRunId: state.chatRunId,
      });
      
      // 聊天室分条推送时，立即清空 stream 气泡，避免与正式消息重复显示
      state.chatStream = null;
      state.chatReasoningStream = null;
      
      const msgs = state.chatMessages as Array<Record<string, unknown>>;
      // 检查是否已存在相同 _chatroomMsgId 的消息（可能由 agent 事件先创建）
      let prevIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const existingId = msgs[i]._chatroomMsgId;
        const existingMessageId = msgs[i].messageId;
        // 同时检查 _chatroomMsgId 和 messageId，确保不重复
        if (existingId === chatroomMessageId || existingMessageId === chatroomMessageId) {
          prevIdx = i;
          break;
        }
      }
      
      // 如果消息已存在（由 agent 事件创建），只更新内容，不添加新消息
      if (prevIdx >= 0) {
        const next = [...msgs];
        const existing = next[prevIdx];
        // 保留原有的时间戳，只更新内容
        next[prevIdx] = {
          ...existing,
          content: [{ type: "text", text: chatroomMessageText }],
          messageId: chatroomMessageId,
          _chatroomMsgId: chatroomMessageId,
          _chatroomRunId: payload.runId,
        };
        state.chatMessages = next;
      } else {
        // 消息不存在，添加新消息
        const message = {
          role: "assistant",
          messageId: chatroomMessageId,
          content: [{ type: "text", text: chatroomMessageText }],
          timestamp: Date.now(),
          _chatroomRunId: payload.runId,
          _chatroomMsgId: chatroomMessageId,
        };
        state.chatMessages = [...msgs, message];
      }
      return payload.state;
    }

    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
    const nextThinking = extractThinking(payload.message);
    state.chatReasoningStream =
      typeof nextThinking === "string" && nextThinking.trim().length > 0
        ? nextThinking
        : null;
  } else if (payload.state === "final") {
    const finalText = extractText(payload.message);
    const finalMessage =
      payload.message && typeof payload.message === "object"
        ? (payload.message as Record<string, unknown>)
        : null;
    const msgs = state.chatMessages as Array<Record<string, unknown>>;
    const hasMatchingTempMessage = msgs.some(
      (m) => typeof m._chatroomRunId === "string" && m._chatroomRunId === payload.runId,
    );
    const shouldCloseActiveRun = Boolean(
      (state.chatRunId && payload.runId === state.chatRunId) || hasMatchingTempMessage,
    );
    if (typeof finalText === "string" && finalText.trim()) {
      // 聊天室短路模式下，assistant stream 会先写入带 _chatroomRunId 的临时消息（每个角色一条）。
      // chat final 到来时，将所有临时消息升级为正式消息（去掉标记字段），
      // 避免临时消息残留或与正式消息重复。
      const tempIndices: number[] = [];
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i]._chatroomRunId !== undefined) tempIndices.push(i);
      }
      if (tempIndices.length > 0) {
        // 多条临时消息（聊天室多角色）：逐条升级为正式消息，保留各自的文本内容
        const next = [...msgs];
        for (const idx of tempIndices) {
          const msg = next[idx];
          const msgText = Array.isArray(msg.content)
            ? (msg.content[0] as Record<string, unknown>)?.text as string | undefined
            : undefined;
          const msgId = typeof msg._chatroomMsgId === "string" ? msg._chatroomMsgId : undefined;
          next[idx] = {
            role: "assistant",
            messageId: msgId,
            content: [{ type: "text", text: msgText ?? finalText }],
            timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
          };
        }
        state.chatMessages = next;
      } else {
        const last = msgs[msgs.length - 1] as
          | { role?: unknown; content?: unknown }
          | undefined;
        const lastRole = typeof last?.role === "string" ? last.role : "";
        const lastText = last ? extractText(last) : null;
        const lastThinking = last ? extractThinking(last) : null;
        const finalThinking = finalMessage ? extractThinking(finalMessage) : null;
        const shouldReplaceExisting =
          lastRole === "assistant" &&
          typeof lastText === "string" &&
          lastText.trim() === finalText.trim() &&
          typeof finalThinking === "string" &&
          finalThinking.trim().length > 0 &&
          (!lastThinking || lastThinking.trim().length === 0);
        if (shouldReplaceExisting && finalMessage) {
          const next = [...msgs];
          next[next.length - 1] = {
            ...finalMessage,
            role: "assistant",
            timestamp:
              typeof finalMessage.timestamp === "number"
                ? finalMessage.timestamp
                : Date.now(),
          };
          state.chatMessages = next;
        } else {
          const shouldAppend =
            lastRole !== "assistant" ||
            typeof lastText !== "string" ||
            lastText.trim() !== finalText.trim();
          if (shouldAppend) {
            state.chatMessages = [
              ...state.chatMessages,
              finalMessage ?? {
                role: "assistant",
                content: [{ type: "text", text: finalText }],
                timestamp: Date.now(),
              },
            ];
          }
        }
      }
    }
    state.chatStream = null;
    state.chatReasoningStream = null;
    if (shouldCloseActiveRun) {
      state.chatRunId = null;
      state.chatStreamStartedAt = null;
    }
  } else if (payload.state === "aborted") {
    state.chatStream = null;
    state.chatReasoningStream = null;
    if (state.chatRunId && payload.runId === state.chatRunId) {
      state.chatRunId = null;
      state.chatStreamStartedAt = null;
    }
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatReasoningStream = null;
    if (state.chatRunId && payload.runId === state.chatRunId) {
      state.chatRunId = null;
      state.chatStreamStartedAt = null;
    }
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
