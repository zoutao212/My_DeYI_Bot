import { truncateText } from "./format";

const TOOL_STREAM_LIMIT = 50;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};

export type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  result?: unknown;
  isError?: boolean;
  startedAt: number;
  updatedAt: number;
  message: Record<string, unknown>;
};

type ToolStreamHost = {
  sessionKey: string;
  chatRunId: string | null;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  chatMessages: unknown[];
  toolStreamSyncTimer: number | null;
};

function extractToolOutputText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") return entry.text;
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return parts.join("\n");
}

function formatToolOutput(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const contentText = extractToolOutputText(value);
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (contentText) {
    text = contentText;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  const truncated = truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
  if (!truncated.truncated) return truncated.text;
  return `${truncated.text}\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`;
}

function buildToolStreamMessage(entry: ToolStreamEntry): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "toolcall",
    name: entry.name,
    arguments: entry.args ?? {},
  });
  if (entry.output || entry.result !== undefined) {
    content.push({
      type: "toolresult",
      name: entry.name,
      text: entry.output ?? "",
      result: entry.result,
      isError: entry.isError ?? false,
    });
  }
  return {
    role: "assistant",
    toolCallId: entry.toolCallId,
    runId: entry.runId,
    content,
    timestamp: entry.startedAt,
  };
}

function trimToolStream(host: ToolStreamHost) {
  if (host.toolStreamOrder.length <= TOOL_STREAM_LIMIT) return;
  const overflow = host.toolStreamOrder.length - TOOL_STREAM_LIMIT;
  const removed = host.toolStreamOrder.splice(0, overflow);
  for (const id of removed) host.toolStreamById.delete(id);
}

function syncToolStreamMessages(host: ToolStreamHost) {
  host.chatToolMessages = host.toolStreamOrder
    .map((id) => host.toolStreamById.get(id)?.message)
    .filter((msg): msg is Record<string, unknown> => Boolean(msg));
}

export function flushToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  syncToolStreamMessages(host);
}

export function scheduleToolStreamSync(host: ToolStreamHost, force = false) {
  if (force) {
    flushToolStreamSync(host);
    return;
  }
  if (host.toolStreamSyncTimer != null) return;
  host.toolStreamSyncTimer = window.setTimeout(
    () => flushToolStreamSync(host),
    TOOL_STREAM_THROTTLE_MS,
  );
}

export function resetToolStream(host: ToolStreamHost) {
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.chatToolMessages = [];
  flushToolStreamSync(host);
}

export type CompactionStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

type CompactionHost = ToolStreamHost & {
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

export function handleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";

  // Clear any existing timer
  if (host.compactionClearTimer != null) {
    window.clearTimeout(host.compactionClearTimer);
    host.compactionClearTimer = null;
  }

  if (phase === "start") {
    host.compactionStatus = {
      active: true,
      startedAt: Date.now(),
      completedAt: null,
    };
  } else if (phase === "end") {
    host.compactionStatus = {
      active: false,
      startedAt: host.compactionStatus?.startedAt ?? null,
      completedAt: Date.now(),
    };
    // Auto-clear the toast after duration
    host.compactionClearTimer = window.setTimeout(() => {
      host.compactionStatus = null;
      host.compactionClearTimer = null;
    }, COMPACTION_TOAST_DURATION_MS);
  }
}

export function handleAgentEvent(host: ToolStreamHost, payload?: AgentEventPayload) {
  if (!payload) return;

  // Handle compaction events
  if (payload.stream === "compaction") {
    handleCompactionEvent(host as CompactionHost, payload);
    return;
  }

  // Handle assistant stream events (chatroom messages)
  if (payload.stream === "assistant") {
    const data = payload.data ?? {};
    const text = typeof data.text === "string" ? data.text : "";
    const messageId = typeof data.messageId === "string" ? data.messageId : null;
    const chatroomMessageText = typeof data.chatroomMessageText === "string" ? data.chatroomMessageText : null;
    const hasChatroomSplitPayload = Boolean(messageId && chatroomMessageText);
    // 聊天室短路模式下，payload.runId 是服务端 streamRunId，
    // 而 host.chatRunId 是客户端 idempotencyKey，两者不同。
    // 改为：有 sessionKey 时按 sessionKey 匹配，否则按 runId 匹配（兜底）。
    const payloadSessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : null;
    const sessionMatch =
      (payloadSessionKey ? payloadSessionKey === host.sessionKey : false) ||
      host.chatRunId === payload.runId;
    const shouldAcceptSplitPayload = hasChatroomSplitPayload && Boolean(host.chatRunId);
    if (text && (sessionMatch || shouldAcceptSplitPayload)) {
      if (hasChatroomSplitPayload) {
        console.debug("[tool-stream] accept split assistant", {
          payloadRunId: payload.runId,
          payloadSessionKey,
          hostSessionKey: host.sessionKey,
          activeRunId: host.chatRunId,
          messageId,
          textLength: chatroomMessageText?.length ?? text.length,
        });
      }
      // 聊天室多角色模式：每条消息带独立的 messageId，按 messageId 区分不同角色的气泡。
      // 如果有 messageId，用 messageId 作为临时消息的 key；否则回退到 runId（兼容旧逻辑）。
      // chatroomMessageText 是本条消息的独立文本（不累积），用于独立气泡显示
      const tempKey = messageId ?? payload.runId;
      const msgs = host.chatMessages as Array<Record<string, unknown>>;
      let prevIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const existingId = msgs[i]._chatroomMsgId;
        const existingMessageId = msgs[i].messageId;
        // 同时检查 _chatroomMsgId 和 messageId，确保不重复（兼容 chat 事件先创建的情况）
        if (existingId === tempKey || existingMessageId === tempKey) {
          prevIdx = i;
          break;
        }
      }
      // 如果有独立消息文本（chatroomMessageText），用它显示；否则用累积文本
      const displayText = chatroomMessageText ?? text;
      const message = {
        role: "assistant",
        content: [{ type: "text", text: displayText }],
        timestamp: payload.ts,
        _chatroomRunId: payload.runId,
        _chatroomMsgId: tempKey,
      };
      if (prevIdx >= 0) {
        // 消息已存在，只更新内容
        const next = [...(host.chatMessages as Array<Record<string, unknown>>)];
        const existing = next[prevIdx];
        next[prevIdx] = {
          ...existing,
          ...message,
          // 保留 messageId 如果已经存在
          messageId: existing.messageId ?? tempKey,
        };
        host.chatMessages = next;
      } else {
        host.chatMessages = [...host.chatMessages, message];
      }
    } else if (hasChatroomSplitPayload) {
      console.debug("[tool-stream] drop split assistant", {
        reason: text ? "session/run mismatch" : "empty text",
        payloadRunId: payload.runId,
        payloadSessionKey,
        hostSessionKey: host.sessionKey,
        activeRunId: host.chatRunId,
        messageId,
      });
    }
    return;
  }

  // Handle lifecycle events
  if (payload.stream === "lifecycle") {
    const data = payload.data ?? {};
    const phase = typeof data.phase === "string" ? data.phase : "";
    if (phase === "end" && host.chatRunId === payload.runId) {
      // Clear chat run ID when lifecycle ends
      host.chatRunId = null;
    }
    return;
  }

  if (payload.stream !== "tool") return;
  const sessionKey =
    typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && sessionKey !== host.sessionKey) return;

  const data = payload.data ?? {};
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!toolCallId) return;
  const name = typeof data.name === "string" ? data.name : "tool";
  const phase = typeof data.phase === "string" ? data.phase : "";

  // Tool result events can arrive slightly after the chat lifecycle ends.
  // If we drop them when chatRunId is cleared, the UI shows "已完成" but no output.
  const isLateAllowed = phase === "result" || host.toolStreamById.has(toolCallId);
  if (!host.chatRunId && !isLateAllowed) return;

  const args = phase === "start" ? data.args : undefined;
  const isError = phase === "result" ? Boolean(data.isError) : undefined;
  const resultRaw = phase === "result" ? data.result : undefined;
  const outputRaw =
    phase === "update"
      ? formatToolOutput(data.partialResult)
      : phase === "result"
        ? formatToolOutput(data.result)
        : undefined;
  const output = outputRaw ?? undefined;

  const now = Date.now();
  let entry: ToolStreamEntry | undefined = host.toolStreamById.get(toolCallId);
  if (!entry) {
    entry = {
      toolCallId,
      runId: payload.runId,
      sessionKey,
      name,
      args,
      output,
      result: resultRaw,
      isError,
      startedAt: typeof payload.ts === "number" ? payload.ts : now,
      updatedAt: now,
      message: {},
    };
    host.toolStreamById.set(toolCallId, entry);
    host.toolStreamOrder.push(toolCallId);
  } else {
    entry.name = name;
    if (args !== undefined) entry.args = args;
    if (output !== undefined) entry.output = output;
    if (resultRaw !== undefined) entry.result = resultRaw;
    if (isError !== undefined) entry.isError = isError;
    entry.updatedAt = now;
  }

  const resolvedEntry = entry;
  if (!resolvedEntry) return;
  resolvedEntry.message = buildToolStreamMessage(resolvedEntry);
  trimToolStream(host);
  scheduleToolStreamSync(host, phase === "result");
}
