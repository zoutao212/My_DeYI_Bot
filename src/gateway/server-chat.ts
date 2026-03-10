import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { appendRuntimeTrace } from "./runtime-log.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("server-chat");

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift();
    if (!queue.length) chatRunSessions.delete(sessionId);
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) return undefined;
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) chatRunSessions.delete(sessionId);
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  abortedRuns: Map<string, number>;
  chatRoomHandledRuns: Set<string>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();
  const chatRoomHandledRuns = new Set<string>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
    chatRoomHandledRuns.clear();
  };

  return {
    registry,
    buffers,
    deltaSentAt,
    abortedRuns,
    chatRoomHandledRuns,
    clear,
  };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
};

export function createAgentEventHandler({
  broadcast,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
}: AgentEventHandlerOptions) {
  // trailing-edge timers：节流窗口结束后自动发送最新缓冲内容，
  // 避免最后一个 delta 被吞掉导致前端文字滞后
  const deltaTrailingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reasoningBuffers = new Map<string, string>();

  const buildAssistantContent = (text: string, thinking?: string) => {
    const content: Array<Record<string, unknown>> = [];
    const normalizedThinking = thinking?.trim() ?? "";
    const normalizedText = text.trim();
    if (normalizedThinking) {
      content.push({ type: "thinking", thinking: normalizedThinking });
    }
    if (normalizedText || content.length === 0) {
      content.push({ type: "text", text });
    }
    return content;
  };

  const sendDeltaNow = (
    sessionKey: string,
    clientRunId: string,
    seq: number,
    text: string,
    extras?: { messageId?: string; chatroomMessageText?: string; thinking?: string },
  ) => {
    chatRunState.deltaSentAt.set(clientRunId, Date.now());
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      messageId: extras?.messageId,
      chatroomMessageText: extras?.chatroomMessageText,
      message: {
        role: "assistant",
        content: buildAssistantContent(text, extras?.thinking),
        timestamp: Date.now(),
      },
    };
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);

    // 关键诊断：确保后台一定能看到“chat delta 已发送”
    if (extras?.messageId && extras?.chatroomMessageText) {
      const preview =
        extras.chatroomMessageText.length > 60
          ? extras.chatroomMessageText.slice(0, 60) + "..."
          : extras.chatroomMessageText;
      console.log(
        `[server-chat] ✅ split-delta sent session=${sessionKey} runId=${clientRunId} seq=${seq} ` +
          `messageId=${extras.messageId} textLen=${extras.chatroomMessageText.length} preview="${preview}"`,
      );
    }
  };

  const emitChatDelta = (
    sessionKey: string,
    clientRunId: string,
    seq: number,
    update: { text?: string; thinking?: string },
    extras?: { messageId?: string; chatroomMessageText?: string },
  ) => {
    if (typeof update.text === "string") {
      chatRunState.buffers.set(clientRunId, update.text);
    }
    if (typeof update.thinking === "string") {
      reasoningBuffers.set(clientRunId, update.thinking);
    }
    const text = chatRunState.buffers.get(clientRunId) ?? "";
    const thinking = reasoningBuffers.get(clientRunId) ?? "";
    const previewSource = text || thinking;
    // 首个 chunk 接收日志：在 deltaSentAt 中还没有记录时输出
    const isFirstChunk = !chatRunState.deltaSentAt.has(clientRunId);
    if (isFirstChunk) {
      const timeStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const preview =
        previewSource.length > 60 ? previewSource.slice(0, 60) + "..." : previewSource;
      console.log(
        `${timeStr} [reply] 🔵 AI 开始回复 session=${sessionKey} runId=${clientRunId} firstChunkChars=${previewSource.length} preview="${preview}"`,
      );
    }
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    const elapsed = now - last;

    // 清除旧的 trailing timer
    const existingTimer = deltaTrailingTimers.get(clientRunId);
    if (existingTimer) clearTimeout(existingTimer);

    if (elapsed >= 150) {
      // 超过节流窗口，立即发送
      sendDeltaNow(sessionKey, clientRunId, seq, text, {
        ...extras,
        thinking,
      });
    } else {
      // 在节流窗口内，设置 trailing timer 确保窗口结束后发送
      const delay = 150 - elapsed;
      deltaTrailingTimers.set(
        clientRunId,
        setTimeout(() => {
          deltaTrailingTimers.delete(clientRunId);
          const latestText = chatRunState.buffers.get(clientRunId);
          const latestThinking = reasoningBuffers.get(clientRunId);
          if (latestText != null || latestThinking != null) {
            sendDeltaNow(sessionKey, clientRunId, seq, latestText ?? "", {
              ...extras,
              thinking: latestThinking,
            });
          }
        }, delay),
      );
    }
  };

  const cleanupDeltaTimer = (clientRunId: string) => {
    const timer = deltaTrailingTimers.get(clientRunId);
    if (timer) {
      clearTimeout(timer);
      deltaTrailingTimers.delete(clientRunId);
    }
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
  ) => {
    cleanupDeltaTimer(clientRunId);
    const text = chatRunState.buffers.get(clientRunId)?.trim() ?? "";
    const thinking = reasoningBuffers.get(clientRunId)?.trim() ?? "";
    chatRunState.buffers.delete(clientRunId);
    reasoningBuffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);

    // CLI 控制台通知式日志
    const now = new Date();
    const timeStr = now.toLocaleTimeString("zh-CN", { hour12: false });
    const previewSource = text || thinking;
    const textPreview =
      previewSource.length > 80 ? previewSource.slice(0, 80) + "..." : previewSource;
    if (jobState === "done") {
      console.log(
        `${timeStr} [reply] ✅ AI 已回复 session=${sessionKey} runId=${clientRunId} chars=${previewSource.length}${textPreview ? ` preview="${textPreview}"` : ""}`,
      );
    } else {
      const errMsg = error ? formatForLog(error) : "unknown";
      console.log(
        `${timeStr} [reply] ❌ AI 回复出错 session=${sessionKey} runId=${clientRunId} error=${errMsg}`,
      );
    }

    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        message: text || thinking
          ? {
              role: "assistant",
              content: buildAssistantContent(text, thinking),
              timestamp: Date.now(),
            }
          : undefined,
      };
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const shouldEmitToolEvents = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) return runVerbose === "on";
    if (!sessionKey) return false;
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      if (entry?.channel === INTERNAL_MESSAGE_CHANNEL) return true;
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) return sessionVerbose === "on";
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose === "on";
    } catch {
      return false;
    }
  };

  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const sessionKey =
      chatLink?.sessionKey ??
      (typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined) ??
      resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    const agentPayload = sessionKey ? { ...evt, sessionKey } : evt;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    
    // 特殊处理聊天室短路模式
    if (evt.stream === "chat_room_handled" && sessionKey) {
      log.info(`[server-chat] 🏠 检测到聊天室短路模式，sessionKey=${sessionKey}, runId=${evt.runId}`);
      
      // 标记此 runId 为聊天室短路模式
      chatRunState.chatRoomHandledRuns.add(evt.runId);
      
      // 为聊天室模式创建虚拟的 chat 链接（如果不存在）
      if (!chatLink) {
        chatRunState.registry.add(evt.runId, {
          sessionKey,
          clientRunId,
        });
      }
      
      // 不直接发送 chat 消息，让后续的 assistant 和 lifecycle 事件处理
      return;
    }
    
    if (evt.stream === "tool" && !shouldEmitToolEvents(evt.runId, sessionKey)) {
      agentRunSeq.set(evt.runId, evt.seq);
      return;
    }

    if (evt.stream === "tool") {
      try {
        const entry = sessionKey ? loadSessionEntry(sessionKey).entry : undefined;
        if (entry?.channel === INTERNAL_MESSAGE_CHANNEL) {
          void appendRuntimeTrace({
            ts: typeof evt.ts === "number" ? evt.ts : Date.now(),
            sessionKey,
            runId: evt.runId,
            event: "agent.tool",
            payload: {
              runId: evt.runId,
              seq: evt.seq,
              data: evt.data,
            },
          });
        }
      } catch {
      }
    } else if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
      const messageId = typeof evt.data?.messageId === "string" ? evt.data.messageId : undefined;
      const chatroomMessageText =
        typeof evt.data?.chatroomMessageText === "string" ? evt.data.chatroomMessageText : undefined;
      if (messageId && chatroomMessageText) {
        // 关键诊断：如果这里出现，说明 agent 事件到了 server-chat，但拿不到 sessionKey，所以无法推送到 Web
        console.log(
          `[server-chat] ❌ NO_SESSION_KEY split-delta runId=${evt.runId} clientRunId=${clientRunId} ` +
            `seq=${evt.seq} messageId=${messageId} textLen=${chatroomMessageText.length}`,
        );
      }
    }

    if (evt.stream === "lifecycle") {
      try {
        const entry = sessionKey ? loadSessionEntry(sessionKey).entry : undefined;
        if (entry?.channel === INTERNAL_MESSAGE_CHANNEL) {
          const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
          if (phase === "error") {
            void appendRuntimeTrace({
              ts: typeof evt.ts === "number" ? evt.ts : Date.now(),
              sessionKey,
              runId: evt.runId,
              event: "agent.lifecycle",
              payload: {
                runId: evt.runId,
                seq: evt.seq,
                phase,
                error: evt.data?.error,
              },
            });
          }
        }
      } catch {
      }
    }
    if (evt.seq !== last + 1) {
      broadcast("agent", {
        runId: evt.runId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    broadcast("agent", agentPayload);

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    if (sessionKey) {
      nodeSendToSession(sessionKey, "agent", agentPayload);
      if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") {
        // 检查是否是聊天室短路模式
        const isChatRoomHandled = chatRunState.chatRoomHandledRuns.has(evt.runId);
        if (isChatRoomHandled) {
          log.info(`[server-chat] 🏠 聊天室短路模式发送 chat delta, sessionKey=${sessionKey}, runId=${evt.runId}`);
        }
        const messageId = typeof evt.data?.messageId === "string" ? evt.data.messageId : undefined;
        const chatroomMessageText =
          typeof evt.data?.chatroomMessageText === "string" ? evt.data.chatroomMessageText : undefined;
        if (messageId && chatroomMessageText) {
          // 关键诊断：log.info 可能被日志级别吞掉，这里强制 console.log
          console.log(
            `[server-chat] 🧩 split-delta recv runId=${evt.runId} clientRunId=${clientRunId} ` +
              `sessionKey=${sessionKey} seq=${evt.seq} messageId=${messageId} ` +
              `textLen=${chatroomMessageText.length} totalLen=${evt.data.text.length}`,
          );
        }
        emitChatDelta(sessionKey, clientRunId, evt.seq, { text: evt.data.text }, {
          messageId,
          chatroomMessageText,
        });
      } else if (
        !isAborted &&
        evt.stream === "reasoning" &&
        (typeof evt.data?.thinking === "string" || typeof evt.data?.text === "string")
      ) {
        emitChatDelta(
          sessionKey,
          clientRunId,
          evt.seq,
          {
            thinking:
              typeof evt.data?.thinking === "string"
                ? evt.data.thinking
                : typeof evt.data?.text === "string"
                  ? evt.data.text
                  : undefined,
          },
        );
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          // 检查是否是聊天室短路模式
          const isChatRoomHandled = chatRunState.chatRoomHandledRuns.has(evt.runId);
          if (isChatRoomHandled) {
            log.info(`[server-chat] 🏠 聊天室短路模式发送 chat final, sessionKey=${finished.sessionKey}, runId=${evt.runId}`);
            // 清理标记
            chatRunState.chatRoomHandledRuns.delete(evt.runId);
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        } else {
          // 检查是否是聊天室短路模式
          const isChatRoomHandled = chatRunState.chatRoomHandledRuns.has(evt.runId);
          if (isChatRoomHandled) {
            log.info(`[server-chat] 🏠 聊天室短路模式发送 chat final (no chatLink), sessionKey=${sessionKey}, runId=${evt.runId}`);
            // 清理标记
            chatRunState.chatRoomHandledRuns.delete(evt.runId);
          }
          emitChatFinal(
            sessionKey,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        reasoningBuffers.delete(clientRunId);
        chatRunState.deltaSentAt.delete(clientRunId);
        cleanupDeltaTimer(clientRunId);
        // 清理聊天室标记
        chatRunState.chatRoomHandledRuns.delete(evt.runId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      clearAgentRunContext(evt.runId);
    }
  };
}
