import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { buildToolSummaryMap } from "../../agents/tool-summaries.js";
import { createClawdbotCodingTools } from "../../agents/pi-tools.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { resolveClawdbotDocsPath } from "../../agents/docs-path.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../../agents/identity.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../auto-reply/reply/response-prefix-template.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import { type ChatImageContent, parseMessageWithAttachments } from "../chat-attachments.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
  validateChatSendPreviewParams,
} from "../protocol/index.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { stripEnvelopeFromMessages } from "../chat-sanitize.js";
import { formatForLog } from "../ws-log.js";
import {
  getRuntimeLogDir,
  getTraceFilePathForRun,
  writeRunBundleLog,
  writeRuntimeLog,
} from "../runtime-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

let didLogChatSendPromptLanguage = false;

function truncateRuntimeLogText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... truncated (${value.length} chars)`;
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
}): string | null {
  const { sessionId, storePath, sessionFile } = params;
  if (sessionFile) return sessionFile;
  if (!storePath) return null;
  return path.join(path.dirname(storePath), `${sessionId}.jsonl`);
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) return { ok: true };
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  createIfMissing?: boolean;
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  const now = Date.now();
  const messageId = randomUUID().slice(0, 8);
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  const messageBody: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: `${labelPrefix}${params.message}` }],
    timestamp: now,
    stopReason: "injected",
    usage: { input: 0, output: 0, totalTokens: 0 },
  };
  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  };

  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, messageId, message: transcriptEntry.message };
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function extractMessageIdMarker(value: string): string | null {
  const match = value.match(/\[message_id:\s*([^\]]+)\]/i);
  const extracted = match?.[1]?.trim();
  return extracted ? extracted : null;
}

function matchesRunMarker(text: string, markerId: string): boolean {
  const marker = `[message_id: ${markerId}]`;
  if (text.includes(marker)) return true;
  if (text.includes(`runId=${markerId}`)) return true;
  if (text.includes(`runId="${markerId}"`)) return true;
  if (text.includes(`runId: ${markerId}`)) return true;
  return false;
}

function readTraceEventsForRun(params: {
  sessionKey: string;
  runId: string;
}): Array<{ ts: number; event: string; payload: unknown }> {
  const filePath = getTraceFilePathForRun({ sessionKey: params.sessionKey, runId: params.runId });
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out: Array<{ ts: number; event: string; payload: unknown }> = [];
    for (const line of lines.slice(-500)) {
      try {
        const rec = JSON.parse(line) as {
          ts?: number;
          event?: string;
          sessionKey?: string;
          runId?: string;
          payload?: unknown;
        };
        if (rec.sessionKey !== params.sessionKey) continue;
        if (rec.runId !== params.runId) continue;
        if (typeof rec.event !== "string") continue;
        out.push({ ts: typeof rec.ts === "number" ? rec.ts : 0, event: rec.event, payload: rec.payload });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

function buildFallbackRunSummaryFromTrace(events: Array<{ ts: number; event: string; payload: unknown }>): string {
  const toolNames = new Set<string>();
  const llmSeqs = new Set<number>();
  for (const e of events) {
    if (e.event === "tool.start" || e.event === "tool.end") {
      const p = e.payload as Record<string, unknown> | undefined;
      const toolName = typeof p?.toolName === "string" ? p.toolName : "";
      if (toolName) toolNames.add(toolName);
    }
    if (e.event === "llm.payload" || e.event === "llm.done") {
      const p = e.payload as Record<string, unknown> | undefined;
      const seq = typeof p?.seq === "number" ? p.seq : NaN;
      if (Number.isFinite(seq)) llmSeqs.add(seq);
    }
  }
  const toolsText = toolNames.size > 0 ? Array.from(toolNames).join(", ") : "(无)";
  const llmText = llmSeqs.size > 0 ? Array.from(llmSeqs).sort((a, b) => a - b).join(", ") : "(无)";
  const hasExec = toolNames.has("exec");
  return [
    `- trace工具: ${toolsText}`,
    `- 是否出现exec: ${hasExec ? "是" : "否"}`,
    `- trace LLM seq: ${llmText}`,
  ].join("\n");
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: params.message,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

function extractLastToolResultText(params: {
  messages: Record<string, unknown>[];
  markerId: string;
}): string | null {
  let startIndex = -1;
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const entry = params.messages[i];
    const m = extractTranscriptMessage(entry);
    if (!m) continue;
    if (m.role !== "user") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((part) => (part && typeof part === "object" ? (part as Record<string, unknown>).text : null))
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    if (matchesRunMarker(text, params.markerId)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex < 0) return null;

  for (let i = params.messages.length - 1; i > startIndex; i -= 1) {
    const m = extractTranscriptMessage(params.messages[i]);
    if (!m) continue;
    if (m.role !== "toolResult") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        const t = rec.text.trim();
        if (t) parts.push(t);
      }
    }
    const combined = parts.join("\n").trim();
    if (combined) return combined;
  }
  return null;
}

function stripTerminalControlSequences(value: string): string {
  // Remove ANSI escape sequences and common PTY control fragments.
  return value
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function extractTranscriptMessage(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") return null;
  const rec = entry as Record<string, unknown>;
  const nested = rec.message;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  return rec;
}

function normalizeToolSummaryTail(value: string, limit = 240): string {
  const stripped = stripTerminalControlSequences(value);
  if (stripped.length <= limit) return stripped;
  return stripped.slice(stripped.length - limit);
}

type ToolSummaryEntry = {
  toolCallId: string;
  toolName: string;
  status?: string;
  exitCode?: number | null;
  cwd?: string;
  tail?: string;
};

type LlmProgressEntry = {
  seq: number;
  direction: "start" | "end";
  ok?: boolean;
  durationMs?: number;
  model?: string;
  api?: string;
  bytes?: number;
  err?: string;
};

function extractLlmProgressForRun(params: {
  messages: Record<string, unknown>[];
  markerId: string;
}): { entries: LlmProgressEntry[]; connectionErrors: number } {
  let startIndex = -1;
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const entry = params.messages[i];
    const m = extractTranscriptMessage(entry);
    if (!m) continue;
    if (m.role !== "user") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((part) => (part && typeof part === "object" ? (part as Record<string, unknown>).text : null))
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    if (matchesRunMarker(text, params.markerId)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex < 0) {
    for (let i = params.messages.length - 1; i >= 0; i -= 1) {
      const entry = params.messages[i];
      const m = extractTranscriptMessage(entry);
      if (!m) continue;
      if (m.role === "user") {
        startIndex = i;
        break;
      }
    }
  }

  if (startIndex < 0) return { entries: [], connectionErrors: 0 };

  const entries: LlmProgressEntry[] = [];
  let connectionErrors = 0;

  for (let i = startIndex + 1; i < params.messages.length; i += 1) {
    const entry = params.messages[i];
    const m = extractTranscriptMessage(entry);
    if (!m) continue;
    if (m.role === "user") break;

    if (m.role === "assistant") {
      const errorMessage = typeof m.errorMessage === "string" ? m.errorMessage : "";
      if (errorMessage.includes("Connection error")) connectionErrors += 1;

      const content = m.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .map((part) => (part && typeof part === "object" ? (part as Record<string, unknown>).text : null))
        .filter((t): t is string => typeof t === "string")
        .join("\n")
        .trim();
      if (!text) continue;
      if (!text.startsWith("[LLM]")) continue;

      const lines = text.split("\n").map((l) => l.trim());
      const payloadLine = lines.find((l) => l.startsWith("→") || l.startsWith("←"));
      if (!payloadLine) continue;

      const isStart = payloadLine.startsWith("→");
      const seqMatch = payloadLine.match(/seq=(\d+)/);
      const seq = seqMatch ? Number(seqMatch[1]) : NaN;
      if (!Number.isFinite(seq)) continue;

      const bytesMatch = payloadLine.match(/bytes=(\d+)/);
      const durationMatch = payloadLine.match(/durationMs=(\d+)/);
      const modelMatch = payloadLine.match(/model=([^\s]+)/);
      const apiMatch = payloadLine.match(/api=([^\s]+)/);
      const ok = payloadLine.includes(" ok ") || payloadLine.includes(" ok$") || payloadLine.includes(" ok durationMs=");
      const errMatch = payloadLine.match(/err=([\s\S]+)$/);

      entries.push({
        seq,
        direction: isStart ? "start" : "end",
        ok: isStart ? undefined : ok,
        durationMs: durationMatch ? Number(durationMatch[1]) : undefined,
        model: modelMatch ? modelMatch[1] : undefined,
        api: apiMatch ? apiMatch[1] : undefined,
        bytes: bytesMatch ? Number(bytesMatch[1]) : undefined,
        err: errMatch ? errMatch[1].trim() : undefined,
      });
    }
  }

  return { entries, connectionErrors };
}

function renderRunSummaryText(params: {
  llm: { entries: LlmProgressEntry[]; connectionErrors: number };
  tools: ToolSummaryEntry[];
}): string {
  const lines: string[] = [];

  const toolLines: string[] = [];
  for (const t of params.tools) {
    const exitCodeText =
      t.exitCode === null || t.exitCode === undefined ? "" : ` exitCode=${t.exitCode}`;
    const cwdText = t.cwd ? ` cwd=${t.cwd}` : "";
    const tailText = t.tail ? `\n  tail: ${t.tail}` : "";
    toolLines.push(`- ${t.toolName}${exitCodeText}${cwdText}${tailText}`);
  }
  if (toolLines.length > 0) {
    lines.push("[工具]");
    lines.push(...toolLines);
  }

  const bySeq = new Map<number, { start?: LlmProgressEntry; end?: LlmProgressEntry }>();
  for (const entry of params.llm.entries) {
    const rec = bySeq.get(entry.seq) ?? {};
    if (entry.direction === "start") rec.start = entry;
    if (entry.direction === "end") rec.end = entry;
    bySeq.set(entry.seq, rec);
  }
  const seqs = Array.from(bySeq.keys()).sort((a, b) => a - b);
  const llmLines: string[] = [];
  for (const seq of seqs) {
    const rec = bySeq.get(seq);
    if (!rec) continue;
    const model = rec.start?.model || rec.end?.model;
    const api = rec.start?.api || rec.end?.api;
    const bytes = rec.start?.bytes;
    const duration = rec.end?.durationMs;
    const okText =
      rec.end?.ok === undefined ? "" : rec.end.ok ? "ok" : "error";
    const errText = rec.end?.err ? ` err=${rec.end.err}` : "";
    const bits = [
      `seq=${seq}`,
      okText ? okText : null,
      duration !== undefined ? `durationMs=${duration}` : null,
      bytes !== undefined ? `bytes=${bytes}` : null,
      model ? `model=${model}` : null,
      api ? `api=${api}` : null,
    ]
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .join(" ");
    llmLines.push(`- ${bits}${errText}`.trim());
  }
  if (llmLines.length > 0 || params.llm.connectionErrors > 0) {
    lines.push("[LLM]");
    if (llmLines.length > 0) lines.push(...llmLines);
    if (params.llm.connectionErrors > 0) {
      lines.push(`- Connection error 次数=${params.llm.connectionErrors}`);
    }
  }

  return lines.join("\n").trim();
}

function appendRunSummaryToReply(params: {
  reply: string;
  messages: Record<string, unknown>[];
  markerId: string;
}): string {
  const tools = extractToolSummariesForRun({
    messages: params.messages,
    markerId: params.markerId,
  });
  const llm = extractLlmProgressForRun({
    messages: params.messages,
    markerId: params.markerId,
  });
  const runSummary = renderRunSummaryText({ tools, llm });
  if (!runSummary.trim()) return params.reply.trim();
  const normalizedReply = params.reply.trim();
  return `${normalizedReply}\n\n[运行摘要]\n${runSummary}`.trim();
}

function extractToolSummariesForRun(params: {
  messages: Record<string, unknown>[];
  markerId: string;
}): ToolSummaryEntry[] {
  let startIndex = -1;
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const entry = params.messages[i];
    const m = extractTranscriptMessage(entry);
    if (!m) continue;
    if (m.role !== "user") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .map((part) => (part && typeof part === "object" ? (part as Record<string, unknown>).text : null))
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    if (matchesRunMarker(text, params.markerId)) {
      startIndex = i;
      break;
    }
  }

  if (startIndex < 0) {
    for (let i = params.messages.length - 1; i >= 0; i -= 1) {
      const entry = params.messages[i];
      const m = extractTranscriptMessage(entry);
      if (!m) continue;
      if (m.role === "user") {
        startIndex = i;
        break;
      }
    }
  }

  if (startIndex < 0) return [];

  const toolCalls: ToolSummaryEntry[] = [];
  const byId = new Map<string, ToolSummaryEntry>();

  for (let i = startIndex + 1; i < params.messages.length; i += 1) {
    const entry = params.messages[i];
    const m = extractTranscriptMessage(entry);
    if (!m) continue;

    if (m.role === "user") break;

    if (m.role === "assistant") {
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const rec = part as Record<string, unknown>;
        if (rec.type !== "toolCall") continue;
        const toolCallId = typeof rec.id === "string" ? rec.id : "";
        const toolName = typeof rec.name === "string" ? rec.name : "";
        if (!toolCallId || !toolName) continue;
        const existing = byId.get(toolCallId);
        if (existing) continue;
        const next: ToolSummaryEntry = { toolCallId, toolName };
        byId.set(toolCallId, next);
        toolCalls.push(next);
      }
      continue;
    }

    if (m.role === "toolResult") {
      const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const toolName = typeof m.toolName === "string" ? m.toolName : "";
      if (!toolCallId || !toolName) continue;
      const entryExisting = byId.get(toolCallId) ?? { toolCallId, toolName };

      const details = m.details;
      if (details && typeof details === "object") {
        const d = details as Record<string, unknown>;
        if (typeof d.status === "string") entryExisting.status = d.status;
        if (typeof d.exitCode === "number") entryExisting.exitCode = d.exitCode;
        if (d.exitCode === null) entryExisting.exitCode = null;
        if (typeof d.cwd === "string") entryExisting.cwd = d.cwd;
        if (typeof d.aggregated === "string" && d.aggregated.trim()) {
          entryExisting.tail = normalizeToolSummaryTail(d.aggregated);
        }
      }

      if (!entryExisting.tail) {
        const content = m.content;
        if (Array.isArray(content)) {
          const text = content
            .map((part) =>
              part && typeof part === "object" ? (part as Record<string, unknown>).text : null,
            )
            .filter((t): t is string => typeof t === "string")
            .join("\n")
            .trim();
          if (text) entryExisting.tail = normalizeToolSummaryTail(text);
        }
      }

      if (!byId.has(toolCallId)) {
        byId.set(toolCallId, entryExisting);
        toolCalls.push(entryExisting);
      } else {
        byId.set(toolCallId, entryExisting);
      }
    }
  }

  return toolCalls;
}

function renderToolSummaryText(entries: ToolSummaryEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const exitCodeText =
      entry.exitCode === null || entry.exitCode === undefined ? "" : ` exitCode=${entry.exitCode}`;
    const cwdText = entry.cwd ? ` cwd=${entry.cwd}` : "";
    const statusText = entry.status ? ` status=${entry.status}` : "";
    const tailText = entry.tail ? `\n  tail: ${entry.tail}` : "";
    lines.push(`- tool=${entry.toolName}${statusText}${exitCodeText}${cwdText}${tailText}`);
  }
  return lines.join("\n");
}

function appendToolSummaryToReply(params: {
  reply: string;
  messages: Record<string, unknown>[];
  markerId: string;
}): string {
  const summaries = extractToolSummariesForRun({
    messages: params.messages,
    markerId: params.markerId,
  });
  if (summaries.length === 0) return params.reply;
  const summaryText = renderToolSummaryText(summaries);
  const normalizedReply = params.reply.trim();
  return `${normalizedReply}\n\n[工具调用摘要]\n${summaryText}`.trim();
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit } = params as {
      sessionKey: string;
      limit?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const sanitized = stripEnvelopeFromMessages(sliced);
    const capped = capArrayByJsonBytes(sanitized, getMaxChatHistoryMessagesBytes()).items;
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const configured = cfg.agents?.defaults?.thinkingDefault;
      if (configured) {
        thinkingLevel = configured;
      } else {
        const { provider, model } = resolveSessionModelRef(cfg, entry);
        const catalog = await context.loadGatewayModelCatalog();
        thinkingLevel = resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog,
        });
      }
    }
    respond(true, {
      sessionKey,
      sessionId,
      messages: capped,
      thinkingLevel,
    });
  },
  "chat.send.preview": async ({ params, respond, context }) => {
    if (!validateChatSendPreviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send.preview params: ${formatValidationErrors(validateChatSendPreviewParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      promptLanguage?: string;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
    };

    const { cfg, entry } = loadSessionEntry(p.sessionKey);
    const agentId = resolveSessionAgentId({ sessionKey: p.sessionKey, config: cfg });
    const { provider, model } = resolveSessionModelRef(cfg, entry);
    const catalog = await context.loadGatewayModelCatalog();
    const thinkingLevel =
      entry?.thinkingLevel ??
      cfg.agents?.defaults?.thinkingDefault ??
      resolveThinkingDefault({ cfg, provider, model, catalog });

    let systemPrompt: string | null = null;
    try {
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const effectiveWorkspaceDir = workspaceDir || process.cwd();
      const docsPath = await resolveClawdbotDocsPath({
        workspaceDir: effectiveWorkspaceDir,
        argv1: process.argv[1],
        cwd: process.cwd(),
        moduleUrl: import.meta.url,
      });
      const ttsHint = cfg ? buildTtsSystemPromptHint(cfg) : undefined;
      const { contextFiles } = await resolveBootstrapContextForRun({
        workspaceDir: effectiveWorkspaceDir,
        config: cfg,
        sessionKey: p.sessionKey,
        sessionId: entry?.sessionId,
        agentId,
        promptLanguage: p.promptLanguage === "zh" ? "zh" : "en",
      });
      const skillsSnapshot = (() => {
        try {
          return buildWorkspaceSkillSnapshot(effectiveWorkspaceDir, {
            config: cfg,
            eligibility: { remote: getRemoteSkillEligibility() },
            snapshotVersion: getSkillsSnapshotVersion(effectiveWorkspaceDir),
          });
        } catch {
          return { prompt: "", skills: [], resolvedSkills: [] };
        }
      })();
      const tools = (() => {
        try {
          const modelApi = provider.trim().toLowerCase().includes("vectorengine")
            ? "openai-completions"
            : undefined;
          return createClawdbotCodingTools({
            config: cfg,
            workspaceDir: effectiveWorkspaceDir,
            sessionKey: p.sessionKey,
            messageProvider: entry?.channel,
            groupId: entry?.groupId ?? undefined,
            groupChannel: entry?.groupChannel ?? undefined,
            groupSpace: entry?.space ?? undefined,
            spawnedBy: entry?.spawnedBy ?? undefined,
            modelProvider: provider,
            modelId: model,
            modelApi,
          });
        } catch {
          return [];
        }
      })();
      const toolSummaries = buildToolSummaryMap(tools);
      const toolNames = tools.map((t) => t.name);
      const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId });
      const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
      const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
        config: cfg,
        agentId,
        workspaceDir: effectiveWorkspaceDir,
        cwd: process.cwd(),
        runtime: {
          host: os.hostname(),
          os: process.platform,
          arch: process.arch,
          node: process.version,
          model: `${provider}/${model}`,
          defaultModel: defaultModelLabel,
          channel: entry?.channel,
        },
      });
      const sandboxRuntime = resolveSandboxRuntimeStatus({ cfg, sessionKey: p.sessionKey });

      systemPrompt = buildAgentSystemPrompt({
        workspaceDir: effectiveWorkspaceDir,
        defaultThinkLevel: undefined,
        extraSystemPrompt: undefined,
        promptLanguage: p.promptLanguage === "zh" ? "zh" : "en",
        toolNames,
        toolSummaries,
        userTimezone,
        userTime,
        userTimeFormat,
        contextFiles,
        skillsPrompt: skillsSnapshot.prompt ?? "",
        docsPath: docsPath ?? undefined,
        ttsHint,
        runtimeInfo,
        sandboxInfo: { enabled: sandboxRuntime.sandboxed },
      });

      // Ensure we didn't accidentally return an empty/whitespace-only prompt.
      if (typeof systemPrompt === "string") {
        const trimmed = systemPrompt.trim();
        systemPrompt = trimmed ? systemPrompt : null;
      }
    } catch {
      systemPrompt = null;
    }

    const normalizedAttachments =
      p.attachments
        ?.map((a) => ({
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
          bytes:
            typeof a?.content === "string"
              ? a.content.length
              : ArrayBuffer.isView(a?.content)
                ? a.content.byteLength
                : undefined,
        }))
        .filter((a) => a.bytes != null || a.fileName || a.mimeType || a.type) ?? [];

    respond(true, {
      sessionKey: p.sessionKey,
      agentId,
      provider,
      model,
      modelRef: `${provider}/${model}`,
      thinkingLevel,
      extraSystemPrompt: systemPrompt,
      clientToolsStatus: "not_applicable",
      clientTools: null,
      attachments: normalizedAttachments,
    });
  },
  "chat.abort": ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = {
      chatAbortControllers: context.chatAbortControllers,
      chatRunBuffers: context.chatRunBuffers,
      chatDeltaSentAt: context.chatDeltaSentAt,
      chatAbortedRuns: context.chatAbortedRuns,
      removeChatRun: context.removeChatRun,
      agentRunSeq: context.agentRunSeq,
      broadcast: context.broadcast,
      nodeSendToSession: context.nodeSendToSession,
    };

    if (!runId) {
      const res = abortChatRunsForSessionKey(ops, {
        sessionKey,
        stopReason: "rpc",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const res = abortChatRunById(ops, {
      runId,
      sessionKey,
      stopReason: "rpc",
    });
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      promptLanguage?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const stopCommand = isChatStopCommandText(p.message);
    const normalizedAttachments =
      p.attachments
        ?.map((a) => ({
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
          content:
            typeof a?.content === "string"
              ? a.content
              : ArrayBuffer.isView(a?.content)
                ? Buffer.from(
                    a.content.buffer,
                    a.content.byteOffset,
                    a.content.byteLength,
                  ).toString("base64")
                : undefined,
        }))
        .filter((a) => a.content) ?? [];
    let parsedMessage = p.message;
    let parsedImages: ChatImageContent[] = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(p.message, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const { cfg, entry } = loadSessionEntry(p.sessionKey);
    const cfgForRun =
      p.promptLanguage === "zh"
        ? {
            ...cfg,
            agents: cfg.agents
              ? {
                  ...cfg.agents,
                  defaults: {
                    ...cfg.agents.defaults,
                    promptLanguage: "zh" as const,
                  },
                }
              : {
                  defaults: {
                    promptLanguage: "zh" as const,
                  },
                },
          }
        : cfg;
    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey: p.sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    const timeoutMs = resolveAgentTimeoutMs({
      cfg: cfgForRun,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const markerId =
      extractMessageIdMarker(String(p.message ?? "")) ??
      extractMessageIdMarker(String(parsedMessage ?? "")) ??
      clientRunId;

    const trimmedMessage = parsedMessage.trim();
    const injectThinking = Boolean(
      p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
    );
    const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
    const modelRef = resolveSessionModelRef(cfg, entry);
    const agentId = resolveSessionAgentId({
      sessionKey: p.sessionKey,
      config: cfg,
    });
    const clientInfo = client?.connect?.client;
    const clientSummary = clientInfo
      ? {
          id: clientInfo.id,
          displayName: clientInfo.displayName,
          mode: clientInfo.mode,
        }
      : undefined;
    const entrySummary = entry
      ? {
          sessionId: entry.sessionId,
          channel: entry.channel,
          chatType: entry.chatType,
          modelOverride: entry.modelOverride,
          providerOverride: entry.providerOverride,
          thinkingLevel: entry.thinkingLevel,
          verboseLevel: entry.verboseLevel,
          reasoningLevel: entry.reasoningLevel,
          sendPolicy: entry.sendPolicy,
          spawnedBy: entry.spawnedBy,
          updatedAt: entry.updatedAt,
          lastChannel: entry.lastChannel,
          lastTo: entry.lastTo,
        }
      : undefined;
    const runtimeLogRequest = {
      sessionKey: p.sessionKey,
      runId: clientRunId,
      now,
      client: clientSummary,
      agentId,
      sendPolicy,
      session: entrySummary,
      modelRef,
      promptLanguage: p.promptLanguage,
      thinking: p.thinking,
      deliver: p.deliver,
      timeoutMs: p.timeoutMs,
      resolvedTimeoutMs: timeoutMs,
      message: truncateRuntimeLogText(String(p.message ?? ""), 20_000),
      parsedMessage: truncateRuntimeLogText(String(parsedMessage ?? ""), 20_000),
      commandBody: truncateRuntimeLogText(commandBody, 20_000),
      injectThinking,
      stopCommand,
      attachments: normalizedAttachments.map((a) => ({
        type: a.type,
        mimeType: a.mimeType,
        fileName: a.fileName,
        contentBytesBase64: typeof a.content === "string" ? a.content.length : undefined,
      })),
      images: parsedImages.map((img) => ({
        mimeType: img.mimeType,
        bytesBase64: typeof img.data === "string" ? img.data.length : undefined,
      })),
    };

    const sendLogPathPromise = writeRuntimeLog({
      kind: "sendmsg",
      ts: now,
      sessionKey: p.sessionKey,
      runId: clientRunId,
      payload: runtimeLogRequest,
    });
    void sendLogPathPromise.then((logPath) => {
      if (logPath) return;
      context.logGateway.warn(
        `[runtimelog] write failed kind=sendmsg dir=${getRuntimeLogDir()} sessionKey=${p.sessionKey} runId=${clientRunId}`,
      );
    });

    if (!didLogChatSendPromptLanguage) {
      didLogChatSendPromptLanguage = true;
      const normalizedPromptLanguage = p.promptLanguage === "zh" ? "zh" : "en";
      context.logGateway.warn(
        `[debug-once] chat.send promptLanguage sessionKey=${p.sessionKey} runId=${clientRunId} raw=${String(p.promptLanguage)} normalized=${normalizedPromptLanguage}`,
      );
    }
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKey(
        {
          chatAbortControllers: context.chatAbortControllers,
          chatRunBuffers: context.chatRunBuffers,
          chatDeltaSentAt: context.chatDeltaSentAt,
          chatAbortedRuns: context.chatAbortedRuns,
          removeChatRun: context.removeChatRun,
          agentRunSeq: context.agentRunSeq,
          broadcast: context.broadcast,
          nodeSendToSession: context.nodeSendToSession,
        },
        { sessionKey: p.sessionKey, stopReason: "stop" },
      );
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: p.sessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
      });

      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      const clientInfo = client?.connect?.client;
      const ctx: MsgContext = {
        Body: parsedMessage,
        BodyForAgent: parsedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        SessionKey: p.sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
      };

      const agentId = resolveSessionAgentId({
        sessionKey: p.sessionKey,
        config: cfg,
      });
      let prefixContext: ResponsePrefixContext = {
        identityName: resolveIdentityName(cfg, agentId),
      };
      const modelSelected: {
        provider?: string;
        model?: string;
        modelFull?: string;
        thinkingLevel?: string;
      } = {};
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
        responsePrefixContextProvider: () => prefixContext,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (info.kind !== "final") return;
          const text = payload.text?.trim() ?? "";
          if (!text) return;
          finalReplyParts.push(text);
        },
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg: cfgForRun,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          disableBlockStreaming: true,
          onAgentRunStart: () => {
            agentRunStarted = true;
          },
          onModelSelected: (ctx) => {
            prefixContext.provider = ctx.provider;
            prefixContext.model = extractShortModelName(ctx.model);
            prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
            prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";

            modelSelected.provider = ctx.provider;
            modelSelected.model = extractShortModelName(ctx.model);
            modelSelected.modelFull = `${ctx.provider}/${ctx.model}`;
            modelSelected.thinkingLevel = ctx.thinkLevel ?? "off";
          },
        },
      })
        .then(() => {
          if (!agentRunStarted) {
            const combinedReply = finalReplyParts
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            let message: Record<string, unknown> | undefined;
            if (combinedReply) {
              const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
                p.sessionKey,
              );
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const appended = appendAssistantTranscriptMessage({
                message: combinedReply,
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile,
                createIfMissing: true,
              });
              if (appended.ok) {
                message = appended.message;
              } else {
                context.logGateway.warn(
                  `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                );
                const now = Date.now();
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: now,
                  stopReason: "injected",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
              }
            }
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: p.sessionKey,
              message,
            });
          }
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
          });

          const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(p.sessionKey);
          const latestSessionId = latestEntry?.sessionId ?? entry?.sessionId;
          const recentMessages =
            latestSessionId && latestStorePath
              ? readSessionMessages(latestSessionId, latestStorePath, latestEntry?.sessionFile)
              : [];

          const traceEvents = readTraceEventsForRun({ sessionKey: p.sessionKey, runId: clientRunId });

          const traceFallbackSummary =
            traceEvents.length > 0 ? buildFallbackRunSummaryFromTrace(traceEvents) : "";

          const lastToolResultText = extractLastToolResultText({
            messages: (Array.isArray(recentMessages)
              ? recentMessages.slice(-80)
              : []) as Record<string, unknown>[],
            markerId,
          });

          const rawReply = finalReplyParts
            .map((part) => part.trim())
            .filter(Boolean)
            .join("\n\n")
            .trim();

          const reply =
            rawReply && rawReply !== "Connection error."
              ? rawReply
              : lastToolResultText && lastToolResultText !== "Connection error."
                ? lastToolResultText
                : rawReply;

          const replyWithTools = appendToolSummaryToReply({
            reply: reply || "(no output)",
            messages: (Array.isArray(recentMessages) ? recentMessages : []) as Record<string, unknown>[],
            markerId,
          });

          const safeReplyWithTools =
            replyWithTools && replyWithTools.includes("Connection error.")
              ? appendToolSummaryToReply({
                  reply: lastToolResultText || reply || "(no output)",
                  messages: (Array.isArray(recentMessages) ? recentMessages : []) as Record<string, unknown>[],
                  markerId,
                })
              : replyWithTools;

          const safeReplyWithToolsAndSummary = appendRunSummaryToReply({
            reply: safeReplyWithTools || "(no output)",
            messages: (Array.isArray(recentMessages) ? recentMessages : []) as Record<string, unknown>[],
            markerId,
          });

          const toolsForReply = extractToolSummariesForRun({
            messages: (Array.isArray(recentMessages) ? recentMessages : []) as Record<string, unknown>[],
            markerId,
          });
          const llmForReply = extractLlmProgressForRun({
            messages: (Array.isArray(recentMessages) ? recentMessages : []) as Record<string, unknown>[],
            markerId,
          });

          const safeReplyNoConnError =
            safeReplyWithToolsAndSummary?.trim() === "Connection error." &&
            (toolsForReply.length > 0 || llmForReply.entries.length > 0 || traceFallbackSummary)
              ? [
                  "(模型连接异常，已回放本次运行证据)",
                  traceFallbackSummary ? `[运行摘要]\n${traceFallbackSummary}` : safeReplyWithToolsAndSummary,
                ]
                  .filter(Boolean)
                  .join("\n\n")
                  .trim()
              : safeReplyWithToolsAndSummary;

          if (
            safeReplyNoConnError &&
            safeReplyWithToolsAndSummary &&
            safeReplyNoConnError.trim() !== safeReplyWithToolsAndSummary.trim()
          ) {
            const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(p.sessionKey);
            const sessionIdForAppend = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
            const appended = appendAssistantTranscriptMessage({
              message: safeReplyNoConnError,
              sessionId: sessionIdForAppend,
              storePath: latestStorePath,
              sessionFile: latestEntry?.sessionFile,
              createIfMissing: true,
            });
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: p.sessionKey,
              message: appended.ok
                ? appended.message
                : {
                    role: "assistant",
                    content: [{ type: "text", text: safeReplyNoConnError }],
                    timestamp: Date.now(),
                    stopReason: "injected",
                    usage: { input: 0, output: 0, totalTokens: 0 },
                  },
            });
          }

          const summaries = extractToolSummariesForRun({
            messages: (Array.isArray(recentMessages) ? recentMessages : []) as Record<string, unknown>[],
            markerId,
          });

          if (
            summaries.length > 0 &&
            rawReply &&
            rawReply.trim() &&
            safeReplyWithToolsAndSummary &&
            safeReplyWithToolsAndSummary !== rawReply &&
            !rawReply.includes("[工具调用摘要]")
          ) {
            const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(p.sessionKey);
            const sessionIdForAppend = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
            const appended = appendAssistantTranscriptMessage({
              message: safeReplyWithToolsAndSummary,
              sessionId: sessionIdForAppend,
              storePath: latestStorePath,
              sessionFile: latestEntry?.sessionFile,
              createIfMissing: true,
            });
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: p.sessionKey,
              message: appended.ok
                ? appended.message
                : {
                    role: "assistant",
                    content: [{ type: "text", text: safeReplyWithToolsAndSummary }],
                    timestamp: Date.now(),
                    stopReason: "injected",
                    usage: { input: 0, output: 0, totalTokens: 0 },
                  },
            });
          }

          if (safeReplyWithToolsAndSummary && finalReplyParts.length === 0) {
            const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(p.sessionKey);
            const sessionIdForAppend = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
            const appended = appendAssistantTranscriptMessage({
              message: safeReplyWithToolsAndSummary,
              sessionId: sessionIdForAppend,
              storePath: latestStorePath,
              sessionFile: latestEntry?.sessionFile,
              createIfMissing: true,
            });
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: p.sessionKey,
              message: appended.ok
                ? appended.message
                : {
                    role: "assistant",
                    content: [{ type: "text", text: safeReplyWithToolsAndSummary }],
                    timestamp: Date.now(),
                    stopReason: "injected",
                    usage: { input: 0, output: 0, totalTokens: 0 },
                  },
            });
          }

          const resOkLogPathPromise = writeRuntimeLog({
            kind: "resmsg",
            ts: Date.now(),
            sessionKey: p.sessionKey,
            runId: clientRunId,
            payload: {
              sessionKey: p.sessionKey,
              runId: clientRunId,
              request: runtimeLogRequest,
              modelSelected,
              reply: safeReplyNoConnError,
            },
          });
          void resOkLogPathPromise.then((logPath) => {
            if (logPath) return;
            context.logGateway.warn(
              `[runtimelog] write failed kind=resmsg dir=${getRuntimeLogDir()} sessionKey=${p.sessionKey} runId=${clientRunId}`,
            );
          });

          void writeRunBundleLog({
            ts: Date.now(),
            sessionKey: p.sessionKey,
            runId: clientRunId,
            payload: {
              kind: "chat.send",
              sessionKey: p.sessionKey,
              runId: clientRunId,
              markerId,
              modelSelected,
              recentMessagesCount: Array.isArray(recentMessages) ? recentMessages.length : 0,
              traceFile: getTraceFilePathForRun({ sessionKey: p.sessionKey, runId: clientRunId }),
              traceEventsCount: traceEvents.length,
              traceFallbackSummary: traceFallbackSummary || undefined,
              rawReply: rawReply || undefined,
              reply: safeReplyNoConnError || undefined,
              toolSummaries: toolsForReply,
              llmProgress: llmForReply,
            },
          });
        })
        .catch((err) => {
          const errText = String(err);
          const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(p.sessionKey);
          const latestSessionId = latestEntry?.sessionId ?? entry?.sessionId;
          const recentMessagesErr =
            latestSessionId && latestStorePath
              ? readSessionMessages(latestSessionId, latestStorePath, latestEntry?.sessionFile)
              : [];
          const lastToolResultTextRaw = extractLastToolResultText({
            messages: (Array.isArray(recentMessagesErr)
              ? recentMessagesErr.slice(-80)
              : []) as Record<string, unknown>[],
            markerId,
          });
          const lastToolResultText = lastToolResultTextRaw
            ? stripTerminalControlSequences(lastToolResultTextRaw)
            : null;

          const toolSummaryText = appendToolSummaryToReply({
            reply: lastToolResultText ?? "",
            messages: (Array.isArray(recentMessagesErr)
              ? recentMessagesErr
              : []) as Record<string, unknown>[],
            markerId,
          });

          const fallbackInjectedText = appendRunSummaryToReply({
            reply: toolSummaryText.trim() ? toolSummaryText : lastToolResultText ?? "Connection error.",
            messages: (Array.isArray(recentMessagesErr)
              ? recentMessagesErr
              : []) as Record<string, unknown>[],
            markerId,
          });

          if (errText.includes("Connection error.") && fallbackInjectedText.trim()) {
            context.logGateway.warn(
              `[chat.send] connection-error fallback injected runId=${clientRunId} markerId=${markerId} hasLastToolResult=${Boolean(lastToolResultText)} toolSummaryChars=${toolSummaryText.length}`,
            );
            const sessionIdForAppend = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
            const appended = appendAssistantTranscriptMessage({
              message: fallbackInjectedText,
              sessionId: sessionIdForAppend,
              storePath: latestStorePath,
              sessionFile: latestEntry?.sessionFile,
              createIfMissing: true,
            });
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: p.sessionKey,
              message: appended.ok
                ? appended.message
                : {
                    role: "assistant",
                    content: [{ type: "text", text: fallbackInjectedText }],
                    timestamp: Date.now(),
                    stopReason: "injected",
                    usage: { input: 0, output: 0, totalTokens: 0 },
                  },
            });

            const resOkLogPathPromise = writeRuntimeLog({
              kind: "resmsg",
              ts: Date.now(),
              sessionKey: p.sessionKey,
              runId: clientRunId,
              payload: {
                sessionKey: p.sessionKey,
                runId: clientRunId,
                request: runtimeLogRequest,
                modelSelected,
                reply: fallbackInjectedText,
              },
            });
            void resOkLogPathPromise.then((logPath) => {
              if (logPath) return;
              context.logGateway.warn(
                `[runtimelog] write failed kind=resmsg dir=${getRuntimeLogDir()} sessionKey=${p.sessionKey} runId=${clientRunId}`,
              );
            });

            context.dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            });
            return;
          }

          const error = errorShape(ErrorCodes.UNAVAILABLE, errText);
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: false,
            payload: {
              runId: clientRunId,
              status: "error" as const,
              summary: errText,
            },
            error,
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey: p.sessionKey,
            errorMessage: errText,
          });

          const resErrLogPathPromise = writeRuntimeLog({
            kind: "resmsg",
            ts: Date.now(),
            sessionKey: p.sessionKey,
            runId: clientRunId,
            payload: {
              sessionKey: p.sessionKey,
              runId: clientRunId,
              request: runtimeLogRequest,
              modelSelected,
              error: errText,
            },
          });
          void resErrLogPathPromise.then((logPath: string | null) => {
            if (logPath) return;
            context.logGateway.warn(
              `[runtimelog] write failed kind=resmsg dir=${getRuntimeLogDir()} sessionKey=${p.sessionKey} runId=${clientRunId}`,
            );
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      context.dedupe.set(`chat:${clientRunId}`, {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const { storePath, entry } = loadSessionEntry(p.sessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    // Resolve transcript path
    const transcriptPath = entry?.sessionFile
      ? entry.sessionFile
      : path.join(path.dirname(storePath), `${sessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) {
      const ensured = ensureTranscriptFile({ transcriptPath, sessionId });
      if (!ensured.ok) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to create transcript file: ${ensured.error ?? "unknown error"}`,
          ),
        );
        return;
      }
    }

    // Build transcript entry
    const now = Date.now();
    const messageId = randomUUID().slice(0, 8);
    const labelPrefix = p.label ? `[${p.label}]\n\n` : "";
    const messageBody: Record<string, unknown> = {
      role: "assistant",
      content: [{ type: "text", text: `${labelPrefix}${p.message}` }],
      timestamp: now,
      stopReason: "injected",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
    const transcriptEntry = {
      type: "message",
      id: messageId,
      timestamp: new Date(now).toISOString(),
      message: messageBody,
    };

    // Append to transcript file
    try {
      fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to write transcript: ${errMessage}`),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${messageId}`,
      sessionKey: p.sessionKey,
      seq: 0,
      state: "final" as const,
      message: transcriptEntry.message,
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(p.sessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId });
  },
};
