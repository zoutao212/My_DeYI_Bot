import {
  loadLlmApprovals,
  shouldAskLlmApproval,
  type LlmApprovalRequestPayload,
} from "./llm-approvals.js";
import { getLlmRequestContext } from "./llm-request-context.js";
import { createHash } from "node:crypto";

function toPlainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[String(k)] = String(v);
    return out;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    out[String(k)] = String(v);
  }
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(authorization|x-goog-api-key|api-key|x-api-key)$/i.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = v;
  }
  return out;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... truncated (${text.length} chars)`;
}

function tryParseJson(text: string): object | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as object;
  } catch {
    return null;
  }
}

function summarizeBody(params: { bodyText?: string | null; bodyJson?: unknown }): string | null {
  if (params.bodyJson && typeof params.bodyJson === "object") {
    const obj = params.bodyJson as Record<string, unknown>;
    const model = typeof obj.model === "string" ? obj.model : null;
    const stream = typeof obj.stream === "boolean" ? obj.stream : null;
    const store = typeof obj.store === "boolean" ? obj.store : null;
    const maxTokens =
      typeof obj.max_completion_tokens === "number"
        ? obj.max_completion_tokens
        : typeof obj.max_tokens === "number"
          ? obj.max_tokens
          : null;
    const reasoning = typeof obj.reasoning_effort === "string" ? obj.reasoning_effort : null;

    const messagesCount = Array.isArray(obj.messages) ? obj.messages.length : null;
    const toolsCount = Array.isArray(obj.tools) ? obj.tools.length : null;

    const parts: string[] = [];
    if (model) parts.push(`model=${model}`);
    if (messagesCount != null) parts.push(`messages=${messagesCount}`);
    if (toolsCount != null) parts.push(`tools=${toolsCount}`);
    if (stream != null) parts.push(`stream=${stream ? "yes" : "no"}`);
    if (store != null) parts.push(`store=${store ? "yes" : "no"}`);
    if (maxTokens != null) parts.push(`max_tokens=${maxTokens}`);
    if (reasoning) parts.push(`reasoning=${reasoning}`);

    const summary = parts.join(" · ").trim();
    return summary || "json";
  }
  const text = (params.bodyText ?? "").trim();
  if (!text) return null;
  return truncateText(text.replace(/\s+/g, " "), 240);
}

async function readBodyTextFromRequest(req: Request): Promise<string | null> {
  try {
    const clone = req.clone();
    const text = await clone.text();
    return text;
  } catch {
    return null;
  }
}

async function buildApprovalPayload(params: {
  input: RequestInfo | URL;
  init?: RequestInit;
}): Promise<LlmApprovalRequestPayload | null> {
  const ctx = getLlmRequestContext();
  if (!ctx) return null;

  const req = new Request(params.input, params.init);
  const url = req.url;
  const method = req.method;
  const headersRaw = toPlainHeaders(req.headers);
  const headers = redactHeaders(headersRaw);

  let bodyText: string | null = null;
  if (typeof (params.init as { body?: unknown } | undefined)?.body === "string") {
    bodyText = (params.init as { body: string }).body;
  } else {
    bodyText = await readBodyTextFromRequest(req);
  }

  const bodyTextTruncated = bodyText != null ? truncateText(bodyText, 200_000) : null;
  const bodyJson = bodyTextTruncated ? tryParseJson(bodyTextTruncated) : null;
  const bodySummary = summarizeBody({ bodyText: bodyTextTruncated, bodyJson });

  return {
    provider: ctx.provider ?? null,
    modelId: ctx.modelId ?? null,
    source: ctx.source ?? null,
    toolName: ctx.toolName ?? null,
    sessionKey: ctx.sessionKey ?? null,
    runId: ctx.runId ?? null,
    url,
    method,
    headers,
    bodyText: bodyTextTruncated,
    bodyJson: bodyJson ?? undefined,
    bodySummary,
  };
}

export type RequestLlmApprovalFn = (params: {
  request: LlmApprovalRequestPayload;
  timeoutMs?: number;
}) => Promise<{ decision: "allow-once" | "allow-always" | "deny" | null }>;

export function installLlmFetchGate(params: { requestApproval: RequestLlmApprovalFn }): void {
  const original = globalThis.fetch;
  if (typeof original !== "function") return;

  const ATTEMPT_WINDOW_MS = 5 * 60_000;
  const MAX_ATTEMPTS_PER_KEY = 2;
  const attempts = new Map<string, { firstAtMs: number; count: number }>();

  function computeAttemptKey(payload: LlmApprovalRequestPayload): string {
    const stable = JSON.stringify({
      provider: payload.provider ?? null,
      modelId: payload.modelId ?? null,
      source: payload.source ?? null,
      toolName: payload.toolName ?? null,
      sessionKey: payload.sessionKey ?? null,
      runId: payload.runId ?? null,
      url: payload.url,
      method: payload.method ?? null,
      bodyText: payload.bodyText ?? null,
    });
    return createHash("sha256").update(stable).digest("hex");
  }

  function pruneAttempts(): void {
    const now = Date.now();
    for (const [key, entry] of attempts.entries()) {
      if (now - entry.firstAtMs > ATTEMPT_WINDOW_MS) attempts.delete(key);
    }
  }

  const wrapped: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const ctx = getLlmRequestContext();
    if (!ctx) {
      return await original(input, init);
    }

    const payload = await buildApprovalPayload({ input, init });
    if (!payload) {
      return await original(input, init);
    }

    pruneAttempts();
    const attemptKey = computeAttemptKey(payload);
    const attemptEntry = attempts.get(attemptKey);
    if (attemptEntry && attemptEntry.count >= MAX_ATTEMPTS_PER_KEY) {
      throw new Error(
        `LLM_REQUEST_RETRY_LIMIT: exceeded max attempts (${MAX_ATTEMPTS_PER_KEY}) for same request in ${ATTEMPT_WINDOW_MS}ms window`,
      );
    }

    const approvals = loadLlmApprovals();
    const ask = shouldAskLlmApproval({ approvals, request: payload });
    if (ask.ask) {
      const res = await params.requestApproval({ request: payload, timeoutMs: 120_000 });
      const decision = res.decision;
      if (decision === "allow-once" || decision === "allow-always") {
        const now = Date.now();
        const current = attempts.get(attemptKey);
        if (!current) {
          attempts.set(attemptKey, { firstAtMs: now, count: 1 });
        } else {
          attempts.set(attemptKey, { firstAtMs: current.firstAtMs, count: current.count + 1 });
        }
        return await original(input, init);
      }
      throw new Error("LLM_REQUEST_DENIED: approval required");
    }

    const now = Date.now();
    const current = attempts.get(attemptKey);
    if (!current) {
      attempts.set(attemptKey, { firstAtMs: now, count: 1 });
    } else {
      attempts.set(attemptKey, { firstAtMs: current.firstAtMs, count: current.count + 1 });
    }
    return await original(input, init);
  };

  globalThis.fetch = wrapped;
}
