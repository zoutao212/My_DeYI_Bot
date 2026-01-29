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
  const MAX_ATTEMPTS_PER_KEY = 1; // 最多 1 次重试（总共 2 次请求：1 次原始 + 1 次重试）
  const RETRY_DELAY_MS = 1000; // 重试前等待 1 秒
  const attempts = new Map<string, { firstAtMs: number; failureCount: number }>();
  
  // 添加请求队列，避免并发请求
  let lastRequestTime = 0;
  const MIN_REQUEST_INTERVAL_MS = 1000; // 最小请求间隔 1 秒

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
    // 添加请求间隔控制，避免并发请求
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
      const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastRequestTime = Date.now();
    
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
    
    // 检查是否超过重试次数（只计算失败次数）
    if (attemptEntry && attemptEntry.failureCount > MAX_ATTEMPTS_PER_KEY) {
      throw new Error(
        `LLM_REQUEST_RETRY_LIMIT: 已超过最大重试次数（${MAX_ATTEMPTS_PER_KEY}），请求被阻断`,
      );
    }
    
    // 如果是重试请求，等待 1 秒
    if (attemptEntry && attemptEntry.failureCount > 0) {
      console.warn(`LLM 请求重试中（第 ${attemptEntry.failureCount} 次失败后重试），等待 ${RETRY_DELAY_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    const approvals = loadLlmApprovals();
    const ask = shouldAskLlmApproval({ approvals, request: payload });
    if (ask.ask) {
      const res = await params.requestApproval({ request: payload, timeoutMs: 120_000 });
      const decision = res.decision;
      if (decision === "allow-once" || decision === "allow-always") {
        // 审批通过，执行请求
        return await executeRequestWithRetry(attemptKey, input, init);
      }
      throw new Error("LLM_REQUEST_DENIED: approval required");
    }

    // 无需审批，直接执行请求
    return await executeRequestWithRetry(attemptKey, input, init);
  };

  // 执行请求并处理重试逻辑
  async function executeRequestWithRetry(
    attemptKey: string,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // 修复 payload 中的 content: null 问题（在发送前修复）
    if (init?.body && typeof init.body === "string") {
      try {
        const bodyJson = JSON.parse(init.body);
        if (bodyJson && typeof bodyJson === "object" && Array.isArray(bodyJson.messages)) {
          let fixed = false;
          for (let i = 0; i < bodyJson.messages.length; i++) {
            const msg = bodyJson.messages[i];
            if (msg && msg.role === "assistant" && msg.content === null) {
              msg.content = "";
              fixed = true;
              console.warn(`[llm-gated-fetch] 修复 content: null → "" (message[${i}])`);
            }
          }
          if (fixed) {
            // 重新序列化修复后的 body
            init = { ...init, body: JSON.stringify(bodyJson) };
          }
        }
      } catch (error) {
        // 解析失败，忽略（不是 JSON body）
      }
    }
    
    try {
      const response = await original(input, init);
      
      // 请求成功（HTTP 状态码 2xx），清除失败计数
      if (response.ok) {
        attempts.delete(attemptKey);
      } else {
        // 请求失败（HTTP 状态码非 2xx），增加失败计数
        const now = Date.now();
        const current = attempts.get(attemptKey);
        if (!current) {
          attempts.set(attemptKey, { firstAtMs: now, failureCount: 1 });
        } else {
          attempts.set(attemptKey, { 
            firstAtMs: current.firstAtMs, 
            failureCount: current.failureCount + 1 
          });
        }
      }
      
      return response;
    } catch (error) {
      // 请求异常（网络错误等），增加失败计数
      const now = Date.now();
      const current = attempts.get(attemptKey);
      if (!current) {
        attempts.set(attemptKey, { firstAtMs: now, failureCount: 1 });
      } else {
        attempts.set(attemptKey, { 
          firstAtMs: current.firstAtMs, 
          failureCount: current.failureCount + 1 
        });
      }
      throw error;
    }
  };

  globalThis.fetch = wrapped;
}
