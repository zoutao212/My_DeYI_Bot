import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { appendRuntimeTrace } from "./runtime-log.js";

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
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    deltaSentAt,
    abortedRuns,
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

  const sendDeltaNow = (sessionKey: string, clientRunId: string, seq: number, text: string) => {
    chatRunState.deltaSentAt.set(clientRunId, Date.now());
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    };
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const emitChatDelta = (sessionKey: string, clientRunId: string, seq: number, text: string) => {
    chatRunState.buffers.set(clientRunId, text);
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    const elapsed = now - last;

    // 清除旧的 trailing timer
    const existingTimer = deltaTrailingTimers.get(clientRunId);
    if (existingTimer) clearTimeout(existingTimer);

    if (elapsed >= 150) {
      // 超过节流窗口，立即发送
      sendDeltaNow(sessionKey, clientRunId, seq, text);
    } else {
      // 在节流窗口内，设置 trailing timer 确保窗口结束后发送
      const delay = 150 - elapsed;
      deltaTrailingTimers.set(
        clientRunId,
        setTimeout(() => {
          deltaTrailingTimers.delete(clientRunId);
          const latestText = chatRunState.buffers.get(clientRunId);
          if (latestText != null) {
            sendDeltaNow(sessionKey, clientRunId, seq, latestText);
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
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        message: text
          ? {
              role: "assistant",
              content: [{ type: "text", text }],
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
    const sessionKey = chatLink?.sessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    const agentPayload = sessionKey ? { ...evt, sessionKey } : evt;
    const last = agentRunSeq.get(evt.runId) ?? 0;
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
        emitChatDelta(sessionKey, clientRunId, evt.seq, evt.data.text);
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        } else {
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
        chatRunState.deltaSentAt.delete(clientRunId);
        cleanupDeltaTimer(clientRunId);
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
