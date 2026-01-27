import {
  loadLlmApprovals,
  shouldAskLlmApproval,
  type LlmApprovalRequestPayload,
} from "./llm-approvals.js";
import { getLlmRequestContext } from "./llm-request-context.js";

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
    const keys = Object.keys(params.bodyJson as Record<string, unknown>);
    return keys.length > 0 ? `json keys: ${keys.slice(0, 24).join(", ")}` : "json";
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

  const bodyTextTruncated = bodyText != null ? truncateText(bodyText, 40_000) : null;
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

  const wrapped: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const ctx = getLlmRequestContext();
    if (!ctx) {
      return await original(input, init);
    }

    const payload = await buildApprovalPayload({ input, init });
    if (!payload) {
      return await original(input, init);
    }

    const approvals = loadLlmApprovals();
    const ask = shouldAskLlmApproval({ approvals, request: payload });
    if (ask.ask) {
      const res = await params.requestApproval({ request: payload, timeoutMs: 120_000 });
      const decision = res.decision;
      if (decision === "allow-once" || decision === "allow-always") {
        return await original(input, init);
      }
      throw new Error("LLM_REQUEST_DENIED: approval required");
    }

    return await original(input, init);
  };

  globalThis.fetch = wrapped;
}
