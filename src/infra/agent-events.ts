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

// 累积日志缓冲区类型
type LogBuffer = {
  text: string;
  lastOutputTs: number;
  countsByStream: Map<string, number>;
  suppressedByStream: Map<string, number>;
};

type AgentEventsGlobalState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
  debugLogByRun: Map<string, LogBuffer>;
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
    debugLogByRun: new Map<string, LogBuffer>(),
  };
  g[AGENT_EVENTS_GLOBAL_KEY] = created;
  return created;
}

function isDebugEnabled(): boolean {
  return process.env.CLAWDBOT_DEBUG_AGENT_EVENTS === "1";
}

// 累积输出配置
const LOG_BUFFER_THRESHOLD = 20; // 累积字数阈值
const LOG_TIME_THRESHOLD_MS = 2000; // 时间阈值（毫秒）

// 高容量流类型（需要采样和累积）
function isHighVolumeStream(stream: string): boolean {
  return stream === "assistant" || stream === "reasoning" || stream === "tool";
}

// 从事件数据中提取可显示的文本内容
function extractTextPreview(data: Record<string, unknown>, stream: string): string {
  if (stream === "assistant" || stream === "reasoning") {
    // assistant/reasoning 流通常有 delta.content
    const delta = data.delta as Record<string, unknown> | undefined;
    if (delta?.content && typeof delta.content === "string") {
      return delta.content;
    }
    // 或者直接有 text
    if (data.text && typeof data.text === "string") {
      return data.text;
    }
  }
  if (stream === "tool") {
    // tool 流通常有 tool_name 或 tool_call_id
    const toolName = data.tool_name as string | undefined;
    const toolCallId = data.tool_call_id as string | undefined;
    const args = data.args as Record<string, unknown> | undefined;
    
    if (toolName) {
      // 简化参数显示
      let argsPreview = "";
      if (args) {
        try {
          const argsStr = JSON.stringify(args);
          argsPreview = argsStr.length > 50 ? argsStr.slice(0, 50) + "..." : argsStr;
        } catch {
          argsPreview = "{...}";
        }
      }
      return `[${toolName}]${argsPreview ? ` ${argsPreview}` : ""}`;
    }
    if (toolCallId) {
      return `tool:${toolCallId.slice(0, 8)}`;
    }
    // 有 chunk 时显示进度
    if (data.chunk !== undefined) {
      return "⋅";
    }
  }
  if (stream === "lifecycle") {
    const state = data.state as string | undefined;
    return state ? `[${state}]` : "";
  }
  return "";
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

  // 调试日志：累积输出模式
  if (isDebugEnabled()) {
    const stream = String(enriched.stream ?? "");
    const sk = typeof enriched.sessionKey === "string" && enriched.sessionKey.trim();
    const runIdShort = enriched.runId.slice(0, 8);
    
    // 获取或创建缓冲区
    let buffer = debugLogByRun.get(enriched.runId);
    if (!buffer) {
      buffer = {
        text: "",
        lastOutputTs: Date.now(),
        countsByStream: new Map<string, number>(),
        suppressedByStream: new Map<string, number>(),
      };
      debugLogByRun.set(enriched.runId, buffer);
    }
    
    // 更新计数
    const count = (buffer.countsByStream.get(stream) ?? 0) + 1;
    buffer.countsByStream.set(stream, count);
    
    // 提取文本内容
    const textPreview = extractTextPreview(enriched.data, stream);
    
    if (isHighVolumeStream(stream)) {
      // 高容量流：累积输出
      buffer.text += textPreview;
      
      const now = Date.now();
      const timeSinceLastOutput = now - buffer.lastOutputTs;
      const shouldOutput = 
        buffer.text.length >= LOG_BUFFER_THRESHOLD || 
        timeSinceLastOutput >= LOG_TIME_THRESHOLD_MS;
      
      if (shouldOutput && buffer.text.length > 0) {
        // 获取各流的抑制数量
        const suppressedAssistant = buffer.suppressedByStream.get("assistant") ?? 0;
        const suppressedTool = buffer.suppressedByStream.get("tool") ?? 0;
        const suppressedReasoning = buffer.suppressedByStream.get("reasoning") ?? 0;
        
        // 构建摘要
        const parts: string[] = [`runId=${runIdShort}`];
        if (suppressedAssistant > 0) parts.push(`assistant+${suppressedAssistant}`);
        if (suppressedTool > 0) parts.push(`tool+${suppressedTool}`);
        if (suppressedReasoning > 0) parts.push(`reasoning+${suppressedReasoning}`);
        parts.push(`listeners=${listeners.size}`);
        parts.push(`sessionKey=${sk ? "yes" : "no"}`);
        
        // 输出累积的内容
        // 🔧 Fix: 增加显示长度到 500 字符，方便调试
        const displayText = buffer.text.length > 500 
          ? buffer.text.slice(0, 500) + "..." 
          : buffer.text;
        console.log(`[agent-events] ${parts.join(" ")}\n  📝 ${displayText}`);
        
        // 重置缓冲区
        buffer.text = "";
        buffer.lastOutputTs = now;
        buffer.suppressedByStream.clear();
      } else {
        // 累积中，记录抑制数量
        buffer.suppressedByStream.set(stream, (buffer.suppressedByStream.get(stream) ?? 0) + 1);
      }
    } else {
      // 非高容量流：直接输出（lifecycle, error 等）
      console.log(
        `[agent-events] runId=${runIdShort} stream=${stream} seq=${enriched.seq}` +
          ` listeners=${listeners.size} sessionKey=${sk ? "yes" : "no"}` +
          (textPreview ? ` ${textPreview}` : ""),
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
