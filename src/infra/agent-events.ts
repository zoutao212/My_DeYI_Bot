import type { VerboseLevel } from "../auto-reply/thinking.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
};

type AgentEventsGlobalState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
  debugLogByRun: Map<
    string,
    { countsByStream: Map<string, number>; suppressedByStream: Map<string, number> }
  >;
};

const AGENT_EVENTS_GLOBAL_KEY = Symbol.for("clawdbot.agentEvents.globalState");

function getGlobalState(): AgentEventsGlobalState {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const existing = g[AGENT_EVENTS_GLOBAL_KEY] as AgentEventsGlobalState | undefined;
  if (existing) return existing;
  const created: AgentEventsGlobalState = {
    seqByRun: new Map<string, number>(),
    listeners: new Set<(evt: AgentEventPayload) => void>(),
    runContextById: new Map<string, AgentRunContext>(),
    debugLogByRun: new Map<
      string,
      { countsByStream: Map<string, number>; suppressedByStream: Map<string, number> }
    >(),
  };
  g[AGENT_EVENTS_GLOBAL_KEY] = created;
  return created;
}

function isDebugEnabled(): boolean {
  return process.env.CLAWDBOT_DEBUG_AGENT_EVENTS === "1";
}

function resolveDebugSamplingEvery(): number {
  const raw = process.env.CLAWDBOT_DEBUG_AGENT_EVENTS_SAMPLE_EVERY;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 25;
}

function shouldLogHighVolumeStream(count: number, every: number): boolean {
  if (count <= 1) return true;
  return count % every === 0;
}

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) return;
  const { runContextById } = getGlobalState();
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
}

export function getAgentRunContext(runId: string) {
  return getGlobalState().runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  const state = getGlobalState();
  state.runContextById.delete(runId);
  state.debugLogByRun.delete(runId);
}

export function resetAgentRunContextForTest() {
  const state = getGlobalState();
  state.runContextById.clear();
  state.debugLogByRun.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const { seqByRun, listeners, runContextById, debugLogByRun } = getGlobalState();
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };

  if (isDebugEnabled()) {
    const stream = String(enriched.stream ?? "");
    const sk = typeof enriched.sessionKey === "string" && enriched.sessionKey.trim();
    const isHighVolume = stream === "assistant" || stream === "reasoning";
    const every = resolveDebugSamplingEvery();

    const runState =
      debugLogByRun.get(enriched.runId) ?? {
        countsByStream: new Map<string, number>(),
        suppressedByStream: new Map<string, number>(),
      };
    if (!debugLogByRun.has(enriched.runId)) debugLogByRun.set(enriched.runId, runState);

    const count = (runState.countsByStream.get(stream) ?? 0) + 1;
    runState.countsByStream.set(stream, count);

    const shouldLog = !isHighVolume || shouldLogHighVolumeStream(count, every);
    if (!shouldLog) {
      runState.suppressedByStream.set(
        stream,
        (runState.suppressedByStream.get(stream) ?? 0) + 1,
      );
    } else {
      const suppressed = runState.suppressedByStream.get(stream) ?? 0;
      if (suppressed) runState.suppressedByStream.set(stream, 0);
    // 只打摘要，避免刷屏；排障时需要确认：是否有 listener、是否带 sessionKey、runId 是否对
    console.log(
      `[agent-events] emit runId=${enriched.runId} stream=${stream} seq=${enriched.seq}` +
        (suppressed ? ` (+${suppressed} suppressed)` : "") +
        ` listeners=${listeners.size} sessionKey=${sk ? "yes" : "no"}`,
    );
    }
  }

  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  const { listeners } = getGlobalState();
  listeners.add(listener);
  if (isDebugEnabled()) {
    console.log(`[agent-events] onAgentEvent registered listeners=${listeners.size}`);
  }
  return () => listeners.delete(listener);
}
