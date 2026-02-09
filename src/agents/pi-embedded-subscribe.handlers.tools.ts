import type { AgentEvent } from "@mariozechner/pi-agent-core";

import { emitAgentEvent } from "../infra/agent-events.js";
import { appendRuntimeTrace } from "../gateway/runtime-log.js";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./pi-embedded-messaging.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import {
  extractToolErrorMessage,
  extractToolResultText,
  extractMessagingToolSend,
  isToolResultError,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { normalizeToolName } from "./tool-policy.js";

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function normalizeTail(value: string, limit = 320): string {
  const stripped = stripTerminalControlSequences(value);
  if (stripped.length <= limit) return stripped;
  return stripped.slice(stripped.length - limit);
}

function extractToolDetails(value: unknown): {
  status?: string;
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
  aggregated?: string;
} {
  if (!value || typeof value !== "object") return {};
  const rec = value as Record<string, unknown>;
  const details = rec.details;
  if (!details || typeof details !== "object") return {};
  const d = details as Record<string, unknown>;
  const out: {
    status?: string;
    exitCode?: number | null;
    durationMs?: number;
    cwd?: string;
    aggregated?: string;
  } = {};
  if (typeof d.status === "string") out.status = d.status;
  if (typeof d.exitCode === "number") out.exitCode = d.exitCode;
  if (d.exitCode === null) out.exitCode = null;
  if (typeof d.durationMs === "number") out.durationMs = d.durationMs;
  if (typeof d.cwd === "string") out.cwd = d.cwd;
  if (typeof d.aggregated === "string") out.aggregated = d.aggregated;
  return out;
}

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized !== "exec" && normalized !== "bash") return meta;
  if (!args || typeof args !== "object") return meta;
  const record = args as Record<string, unknown>;
  const flags: string[] = [];
  if (record.pty === true) flags.push("pty");
  if (record.elevated === true) flags.push("elevated");
  if (flags.length === 0) return meta;
  const suffix = flags.join(" · ");
  return meta ? `${meta} · ${suffix}` : suffix;
}

export async function handleToolExecutionStart(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { toolName: string; toolCallId: string; args: unknown },
) {
  // Flush pending block replies to preserve message boundaries before tool execution.
  ctx.flushBlockReplyBuffer();
  if (ctx.params.onBlockReplyFlush) {
    void ctx.params.onBlockReplyFlush();
  }

  const rawToolName = String(evt.toolName);
  const toolName = normalizeToolName(rawToolName);
  const toolCallId = String(evt.toolCallId);
  const args = evt.args;

  if (toolName === "read") {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const filePath = typeof record.path === "string" ? record.path.trim() : "";
    if (!filePath) {
      const argsPreview = typeof args === "string" ? args.slice(0, 200) : undefined;
      ctx.log.warn(
        `read tool called without path: toolCallId=${toolCallId} argsType=${typeof args}${argsPreview ? ` argsPreview=${argsPreview}` : ""}`,
      );
    }
  }

  const meta = extendExecMeta(toolName, args, inferToolMetaFromArgs(toolName, args));
  ctx.state.toolMetaById.set(toolCallId, meta);
  ctx.log.debug(
    `embedded run tool start: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  void appendRuntimeTrace({
    sessionKey: ctx.params.sessionKey,
    runId: ctx.params.runId,
    event: "tool.start",
    payload: {
      toolName,
      toolCallId,
      meta,
      args,
    },
  });

  const shouldEmitToolEvents = ctx.shouldEmitToolResult();
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "start",
      name: toolName,
      toolCallId,
      args: args as Record<string, unknown>,
    },
  });
  // Best-effort typing signal; do not block tool summaries on slow emitters.
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: { phase: "start", name: toolName, toolCallId },
  });

  if (
    ctx.params.onToolResult &&
    shouldEmitToolEvents &&
    !ctx.state.toolSummaryById.has(toolCallId)
  ) {
    ctx.state.toolSummaryById.add(toolCallId);
    ctx.emitToolSummary(toolName, meta);
  }

  // Track messaging tool sends (pending until confirmed in tool_execution_end).
  if (isMessagingTool(toolName)) {
    const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const isMessagingSend = isMessagingToolSendAction(toolName, argsRecord);
    if (isMessagingSend) {
      const sendTarget = extractMessagingToolSend(toolName, argsRecord);
      if (sendTarget) {
        ctx.state.pendingMessagingTargets.set(toolCallId, sendTarget);
      }
      // Field names vary by tool: Discord/Slack use "content", sessions_send uses "message"
      const text = (argsRecord.content as string) ?? (argsRecord.message as string);
      if (text && typeof text === "string") {
        ctx.state.pendingMessagingTexts.set(toolCallId, text);
        ctx.log.debug(`Tracking pending messaging text: tool=${toolName} len=${text.length}`);
      }
    }
  }
}

export function handleToolExecutionUpdate(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
      partialResult: sanitized,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
    },
  });
}

export function handleToolExecutionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const isError = Boolean(evt.isError);
  const result = evt.result;
  const isToolError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const meta = ctx.state.toolMetaById.get(toolCallId);
  ctx.state.toolMetas.push({ toolName, meta });
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  if (isToolError) {
    const errorMessage = extractToolErrorMessage(sanitizedResult);
    ctx.state.lastToolError = {
      toolName,
      meta,
      error: errorMessage,
    };
  }

  // Commit messaging tool text on success, discard on error.
  const pendingText = ctx.state.pendingMessagingTexts.get(toolCallId);
  const pendingTarget = ctx.state.pendingMessagingTargets.get(toolCallId);
  if (pendingText) {
    ctx.state.pendingMessagingTexts.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTexts.push(pendingText);
      ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(pendingText));
      ctx.log.debug(`Committed messaging text: tool=${toolName} len=${pendingText.length}`);
      ctx.trimMessagingToolSent();
    }
  }
  if (pendingTarget) {
    ctx.state.pendingMessagingTargets.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTargets.push(pendingTarget);
      ctx.trimMessagingToolSent();
    }
  }

  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
      result: sanitizedResult,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
    },
  });

  ctx.log.debug(
    `embedded run tool end: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  const details = extractToolDetails(sanitizedResult);
  const outputText = extractToolResultText(sanitizedResult);
  const tailCandidate =
    (details.aggregated && details.aggregated.trim()) || (outputText && outputText.trim()) || "";
  const tail = tailCandidate ? normalizeTail(tailCandidate) : undefined;

  void appendRuntimeTrace({
    sessionKey: ctx.params.sessionKey,
    runId: ctx.params.runId,
    event: "tool.end",
    payload: {
      toolName,
      toolCallId,
      meta,
      isError: isToolError,
      status: details.status,
      exitCode: details.exitCode,
      durationMs: details.durationMs,
      cwd: details.cwd,
      tail,
    },
  });

  if (ctx.params.onToolResult && ctx.shouldEmitToolOutput()) {
    if (outputText) {
      ctx.emitToolOutput(toolName, meta, outputText);
    }
  }

  // ── 工具调用熔断器：防止 LLM 无限重试返回软失败的工具（如 send_file） ──
  // 检测软失败：工具返回 { success: false } 的 JSON 结果（isError=false）
  const isSoftFailure = detectToolSoftFailure(result);
  const cb = ctx.state.toolCircuitBreaker;
  if (isToolError || isSoftFailure) {
    if (cb.lastToolName === toolName) {
      cb.consecutiveFailures += 1;
    } else {
      cb.lastToolName = toolName;
      cb.consecutiveFailures = 1;
    }
  } else {
    // 成功调用，重置熔断器
    cb.lastToolName = null;
    cb.consecutiveFailures = 0;
  }

  const TOOL_CIRCUIT_BREAKER_THRESHOLD = 3;
  if (cb.consecutiveFailures >= TOOL_CIRCUIT_BREAKER_THRESHOLD) {
    ctx.log.warn(
      `[CircuitBreaker] 工具 "${toolName}" 连续失败 ${cb.consecutiveFailures} 次，触发熔断，abort session。` +
      ` runId=${ctx.params.runId}`,
    );
    void ctx.params.session.abort();
  }
}

/**
 * 检测工具返回的"软失败"：JSON 结果中 success === false。
 * 这类结果 pi-agent-core 不视为错误（isError=false），但 LLM 可能无限重试。
 */
function detectToolSoftFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  // jsonResult() 把 payload 放在 details 字段
  const details = record.details;
  if (details && typeof details === "object") {
    return (details as Record<string, unknown>).success === false;
  }
  // 兜底：检查 content[0].text 中的 JSON
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content || content.length === 0) return false;
  const first = content[0];
  if (!first || typeof first !== "object") return false;
  const text = (first as Record<string, unknown>).text;
  if (typeof text !== "string") return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parsed.success === false;
  } catch {
    return false;
  }
}
