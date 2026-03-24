import {
  loadLlmApprovals,
  shouldAskLlmApproval,
  type LlmApprovalRequestPayload,
} from "./llm-approvals.js";
import { getLlmRequestContext } from "./llm-request-context.js";
import { createHash } from "node:crypto";
import { registerUnhandledRejectionHandler } from "./unhandled-rejections.js";
import { formatErrorMessage } from "./errors.js";

/** 存储上一次 LLM 响应中的 tool call 数据（用于在审批 UI 中展示） */
let lastLlmToolCallsData: string | null = null;

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

    // 🆕 提取用户最后一条消息的内容（前 200 字符）
    let userPromptPreview: string | null = null;
    if (Array.isArray(obj.messages) && obj.messages.length > 0) {
      const lastMessage = obj.messages[obj.messages.length - 1] as Record<string, unknown>;
      if (lastMessage.role === "user") {
        const content = lastMessage.content;
        if (typeof content === "string") {
          userPromptPreview = truncateText(content.replace(/\s+/g, " "), 200);
        } else if (Array.isArray(content) && content.length > 0) {
          const textPart = content.find((p: unknown) => 
            typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text"
          ) as Record<string, unknown> | undefined;
          if (textPart && typeof textPart.text === "string") {
            userPromptPreview = truncateText(textPart.text.replace(/\s+/g, " "), 200);
          }
        }
      }
    }

    // 🆕 提取 Google Generative AI 格式的用户消息
    if (!userPromptPreview && Array.isArray(obj.contents) && obj.contents.length > 0) {
      const lastContent = obj.contents[obj.contents.length - 1] as Record<string, unknown>;
      if (lastContent.role === "user" && Array.isArray(lastContent.parts)) {
        const textPart = lastContent.parts.find((p: unknown) => 
          typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).text === "string"
        ) as Record<string, unknown> | undefined;
        if (textPart && typeof textPart.text === "string") {
          userPromptPreview = truncateText(textPart.text.replace(/\s+/g, " "), 200);
        }
      }
    }

    // 🆕 提取工具名称列表
    let toolNames: string[] = [];
    if (Array.isArray(obj.tools)) {
      for (const tool of obj.tools) {
        if (typeof tool === "object" && tool !== null) {
          const toolObj = tool as Record<string, unknown>;
          // OpenAI format: tools[].function.name
          if (typeof toolObj.function === "object" && toolObj.function !== null) {
            const funcName = (toolObj.function as Record<string, unknown>).name;
            if (typeof funcName === "string") {
              toolNames.push(funcName);
            }
          }
          // Google Generative AI format: tools[].functionDeclarations[].name
          if (Array.isArray(toolObj.functionDeclarations)) {
            for (const decl of toolObj.functionDeclarations) {
              if (typeof decl === "object" && decl !== null) {
                const declName = (decl as Record<string, unknown>).name;
                if (typeof declName === "string") {
                  toolNames.push(declName);
                }
              }
            }
          }
        }
      }
    }

    // 🆕 提取 tool result 信息（OpenAI format: messages[].role="tool"）
    let toolResultsCount = 0;
    const toolResultSummaries: string[] = [];
    if (Array.isArray(obj.messages)) {
      for (const msg of obj.messages) {
        if (typeof msg === "object" && msg !== null) {
          const msgObj = msg as Record<string, unknown>;
          if (msgObj.role === "tool" || msgObj.role === "toolResult") {
            toolResultsCount++;
            const toolName = typeof msgObj.name === "string" ? msgObj.name : 
                            typeof msgObj.toolName === "string" ? msgObj.toolName : "unknown";
            const content = msgObj.content;
            let contentPreview = "";
            if (typeof content === "string") {
              // 🔧 增加预览长度到 300 字符，提取关键信息
              contentPreview = truncateText(content.replace(/\s+/g, " "), 300);
            } else if (Array.isArray(content) && content.length > 0) {
              const textPart = content.find((p: unknown) => 
                typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text"
              ) as Record<string, unknown> | undefined;
              if (textPart && typeof textPart.text === "string") {
                contentPreview = truncateText(textPart.text.replace(/\s+/g, " "), 300);
              }
            }
            // 🔧 显示所有 tool result（不限制数量）
            toolResultSummaries.push(`${toolName}: ${contentPreview || "(empty)"}`);
          }
        }
      }
    }

    // 🆕 提取 Google Generative AI 格式的 function response
    if (Array.isArray(obj.contents)) {
      for (const content of obj.contents) {
        if (typeof content === "object" && content !== null) {
          const contentObj = content as Record<string, unknown>;
          if (contentObj.role === "function" || contentObj.role === "model") {
            if (Array.isArray(contentObj.parts)) {
              for (const part of contentObj.parts) {
                if (typeof part === "object" && part !== null) {
                  const partObj = part as Record<string, unknown>;
                  if (partObj.functionResponse && typeof partObj.functionResponse === "object") {
                    toolResultsCount++;
                    const funcResp = partObj.functionResponse as Record<string, unknown>;
                    const funcName = typeof funcResp.name === "string" ? funcResp.name : "unknown";
                    const response = funcResp.response;
                    let responsePreview = "";
                    if (typeof response === "string") {
                      responsePreview = truncateText(response.replace(/\s+/g, " "), 300);
                    } else if (response && typeof response === "object") {
                      // 🔧 提取 response 对象的关键字段
                      const respObj = response as Record<string, unknown>;
                      if (respObj.content && Array.isArray(respObj.content)) {
                        // 提取 content[].text
                        const texts = respObj.content
                          .filter((c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
                          .map((c: unknown) => (c as Record<string, unknown>).text)
                          .filter((t): t is string => typeof t === "string");
                        if (texts.length > 0) {
                          responsePreview = truncateText(texts.join(" ").replace(/\s+/g, " "), 300);
                        }
                      }
                      if (!responsePreview) {
                        responsePreview = truncateText(JSON.stringify(response).replace(/\s+/g, " "), 300);
                      }
                    }
                    // 🔧 显示所有 tool result（不限制数量）
                    toolResultSummaries.push(`${funcName}: ${responsePreview || "(empty)"}`);
                  }
                }
              }
            }
          }
        }
      }
    }

    const parts: string[] = [];
    if (model) parts.push(`model=${model}`);
    if (messagesCount != null) parts.push(`messages=${messagesCount}`);
    if (toolsCount != null) parts.push(`tools=${toolsCount}`);
    
    // 🔧 优先显示 tool result（如果有）
    if (toolResultsCount > 0) {
      parts.push(`tool_results=${toolResultsCount}`);
      // 🔧 直接显示 tool result 内容，不再用 results_preview 包裹
      for (const summary of toolResultSummaries) {
        parts.push(summary);
      }
    }
    
    // 🆕 显示工具名称（最多前 5 个）- 只在没有 tool result 时显示
    if (toolNames.length > 0 && toolResultsCount === 0) {
      const toolNamesPreview = toolNames.slice(0, 5).join(", ");
      const moreTools = toolNames.length > 5 ? ` +${toolNames.length - 5} more` : "";
      parts.push(`tool_names=[${toolNames.length > 5 ? toolNamesPreview + moreTools : toolNames.join(", ")}]`);
    }
    
    if (stream != null) parts.push(`stream=${stream ? "yes" : "no"}`);
    if (store != null) parts.push(`store=${store ? "yes" : "no"}`);
    if (maxTokens != null) parts.push(`max_tokens=${maxTokens}`);
    if (reasoning) parts.push(`reasoning=${reasoning}`);
    
    // 🆕 显示用户 prompt 预览 - 只在没有 tool result 时显示
    if (userPromptPreview && toolResultsCount === 0) {
      parts.push(`prompt="${userPromptPreview}"`);
    }

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
    lastLlmToolCalls: lastLlmToolCallsData,
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
  const MAX_ATTEMPTS_PER_KEY = 3; // 最多 3 次重试（总共 4 次请求：1 次原始 + 3 次重试）
  const BASE_RETRY_DELAY_MS = 2000; // 基础重试延迟 2 秒
  const attempts = new Map<string, { firstAtMs: number; failureCount: number }>();
  
  // 🔧 P17 修复：用串行队列替代竞态的 lastRequestTime
  // 原问题：多个并发 wrapped() 调用同时读取 lastRequestTime，全部通过检查后才各自更新
  // 修复：用 Promise 链保证请求串行化，每个请求之间至少间隔 MIN_REQUEST_GAP_MS
  let requestGatePromise = Promise.resolve();
  const MIN_REQUEST_GAP_MS = 1500; // 请求间隔 1.5 秒

  // 🔧 P18+P20 修复：429 指数退避 + jitter
  function computeRetryDelay(failureCount: number): number {
    // 指数退避：2s → 4s → 8s，上限 30s
    const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, failureCount - 1);
    const cappedDelay = Math.min(exponentialDelay, 30_000);
    // 添加 ±25% jitter 避免多个重试同时触发
    const jitter = cappedDelay * (0.75 + Math.random() * 0.5);
    return Math.round(jitter);
  }

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
    try {
      const ctx = getLlmRequestContext();
      
      // 如果没有 LLM 请求上下文，直接调用原始 fetch（不拦截 Embeddings 等非 LLM 请求）
      if (!ctx) {
        return await original(input, init);
      }
      
      // 检查是否是 LLM API 请求
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const isLlmRequest = 
        url.includes("openai.com") ||
        url.includes("anthropic.com") ||
        url.includes("generativelanguage.googleapis.com") ||
        url.includes("vectorengine") ||
        url.includes("gemini") ||
        url.includes("api.anthropic.com") ||
        url.includes("api.openai.com");
      
      // 如果不是 LLM 请求，直接调用原始 fetch（不拦截 Telegram、WhatsApp 等 API 请求）
      if (!isLlmRequest) {
        return await original(input, init);
      }
      
      // 🔧 P17 修复：串行队列保证请求间隔，消除 TOCTOU 竞态
      // 🔧 Fix: 正确的串行队列实现
      const queuePromise = requestGatePromise.then(async () => {
        await new Promise(r => setTimeout(r, MIN_REQUEST_GAP_MS));
      });
      requestGatePromise = queuePromise;
      await queuePromise;

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
      
      // 如果是重试请求，使用指数退避等待
      if (attemptEntry && attemptEntry.failureCount > 0) {
        const retryDelay = computeRetryDelay(attemptEntry.failureCount);
        console.warn(`LLM 请求重试中（第 ${attemptEntry.failureCount} 次失败后重试），等待 ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }

      const approvals = loadLlmApprovals();
      const ask = shouldAskLlmApproval({ approvals, request: payload });
      if (ask.ask) {
        console.log(`[llm-gated-fetch] 🔒 需要审批，正在请求...`);
        const res = await params.requestApproval({ request: payload, timeoutMs: 120_000 });
        const decision = res.decision;
        console.log(`[llm-gated-fetch] ✅ 审批决策：${decision}`);
        
        if (decision === "allow-once" || decision === "allow-always") {
          // 审批通过，执行请求
          console.log(`[llm-gated-fetch] 🚀 审批通过，正在执行 LLM 请求...`);
          const response = await executeRequestWithRetry(attemptKey, input, init, false);
          console.log(`[llm-gated-fetch] ✅ LLM 请求完成，状态码：${response.status}`);
          return response;
        }
        console.error(`[llm-gated-fetch] ❌ 审批被拒绝：${decision}`);
        throw new Error("LLM_REQUEST_DENIED: approval required");
      }

      // 无需审批，直接执行请求
      console.log(`[llm-gated-fetch] ℹ️ 无需审批，直接执行请求`);
      return await executeRequestWithRetry(attemptKey, input, init, false);
    } catch (error) {
      // 捕获并记录各种错误类型
      if (error && typeof error === "object" && "name" in error) {
        const errorName = error.name;
        
        if (errorName === "AbortError") {
          console.warn("[llm-gated-fetch] Request aborted:", error);
          throw error; // 重新抛出，让上层处理
        }
        
        if (errorName === "TypeError") {
          const errorMessage = (error as { message?: string }).message;
          if (errorMessage && errorMessage.includes("fetch failed")) {
            // P120b: 连接类错误只打一行摘要，不打完整堆栈（避免 embedding 端点不可达时刷屏）
            const cause = (error as { cause?: { code?: string; address?: string; port?: number } }).cause;
            if (cause && /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT/.test(cause.code ?? "")) {
              console.warn(`[llm-gated-fetch] Network error: ${cause.code} ${cause.address ?? ""}:${cause.port ?? ""}`);
            } else {
              console.warn("[llm-gated-fetch] Network error (fetch failed):", error);
            }
            throw error; // 重新抛出，让上层处理
          }
        }
        
        console.warn(`[llm-gated-fetch] Request error (${errorName}):`, error);
        throw error;
      }
      
      // 未知错误
      console.warn("[llm-gated-fetch] Unknown error:", error);
      throw error;
    }
  };

  // 检查错误是否可重试
  function isRetryableError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    
    // 检查错误消息
    const errorMessage = "message" in error && typeof error.message === "string" 
      ? error.message.toLowerCase() 
      : "";
    
    // 不可重试的错误类型
    const nonRetryablePatterns = [
      "prohibited_content",      // 内容违规
      "safety",                  // 安全策略
      "recitation",              // 版权内容
      "blocked",                 // 被阻止
      "content_filter",          // 内容过滤
      "policy_violation",        // 政策违规
      "invalid_request_error",   // 无效请求（参数错误等）
      "authentication_error",    // 认证错误
    ];
    
    for (const pattern of nonRetryablePatterns) {
      if (errorMessage.includes(pattern)) {
        return false;
      }
    }
    
    // 可重试的错误类型
    const retryablePatterns = [
      "timeout",                 // 超时
      "network",                 // 网络错误
      "fetch failed",            // Fetch 失败
      "econnreset",              // 连接重置
      "enotfound",               // DNS 解析失败
      "etimedout",               // 连接超时
      "rate_limit",              // 速率限制
      "overloaded",              // 服务器过载
      "internal_error",          // 内部错误
      "service_unavailable",     // 服务不可用
    ];
    
    for (const pattern of retryablePatterns) {
      if (errorMessage.includes(pattern)) {
        return true;
      }
    }
    
    // 检查 HTTP 状态码
    if ("status" in error && typeof error.status === "number") {
      const status = error.status;
      // 5xx 错误通常可重试
      if (status >= 500 && status < 600) return true;
      // 429 (Too Many Requests) 可重试
      if (status === 429) return true;
      // 4xx 错误通常不可重试
      if (status >= 400 && status < 500) return false;
    }
    
    // 默认：网络相关错误可重试
    if ("name" in error) {
      const errorName = String(error.name).toLowerCase();
      if (errorName === "aborterror") return true;  // 超时导致的 abort
      if (errorName === "typeerror") return true;   // 网络错误
    }
    
    return false;
  }

  // 执行请求并处理重试逻辑
  // 🔧 P122: Grok 推理模型 stream + tool result 卡死的智能降级
  let streamFallbackAttempt = 0;
  const MAX_STREAM_FALLBACK_ATTEMPTS = 1; // 最多降级重试 1 次
  
  async function executeRequestWithRetry(
    attemptKey: string,
    input: RequestInfo | URL,
    init?: RequestInit,
    forceNonStream = false,
  ): Promise<Response> {
    console.log(`[llm-gated-fetch] 📤 开始执行请求：${typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url}`);
    
    // 🔧 P122: 智能降级 - 当 forceNonStream=true 时，临时禁用 stream
    let actualInit = init;
    let parsedBodyJson: any = null;
    if (init?.body && typeof init.body === "string") {
      try {
        parsedBodyJson = JSON.parse(init.body);
        if (forceNonStream && parsedBodyJson.stream === true) {
          parsedBodyJson.stream = false;
          actualInit = { ...init, body: JSON.stringify(parsedBodyJson) };
          console.warn(`[llm-gated-fetch] 🔄 P122: 检测到 stream 卡死，降级为非 stream 模式重试`);
        }
      } catch {
        // 解析失败，保持原样
      }
    }
    
    // 🔧 P19 修复：从 60s 提高到 180s，创作任务（3000+ 字）需要更长时间
    // 🔧 P131: 推理模型需要更长时间处理复杂 tool 对话
    const isReasoningModel = parsedBodyJson?.model?.includes("reasoning") || 
                             parsedBodyJson?.model?.includes("grok-4-1");
    const TIMEOUT_MS = isReasoningModel ? 300_000 : 180_000; // 推理模型 300s，其他 180s
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[llm-gated-fetch] ⚠️ LLM 请求超时（${TIMEOUT_MS}ms），正在中断请求...`);
      controller.abort();
    }, TIMEOUT_MS);
    
    // 合并 AbortSignal
    const originalSignal = init?.signal;
    const combinedSignal = originalSignal 
      ? AbortSignal.any([originalSignal, controller.signal])
      : controller.signal;
    
    // 🔧 P123: 诊断 AbortError 来源
    if (originalSignal) {
      originalSignal.addEventListener('abort', () => {
        console.warn(`[llm-gated-fetch] 🚨 P123: 外部 signal 被 abort！reason: ${originalSignal.reason || 'unknown'}`);
      });
    }
    
    // 修复 payload 中的格式问题（在发送前修复）
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // 🔧 Fix: 区分 vectorengine 的不同 API 类型
    // - /v1beta + google-generative-ai = Gemini 格式 (需要 thought_signature, functionCall)
    // - /v1 + openai-completions = OpenAI 格式 (不需要转换，保持原样)
    const isVectorengineGemini = url.includes("vectorengine") && url.includes("/v1beta");
    const isVectorengineOpenAI = url.includes("vectorengine") && url.includes("/v1/") && !url.includes("/v1beta");
    
    // 🔧 DEBUG: 记录 URL 和判断结果
    console.warn(`[llm-gated-fetch] [DEBUG] URL: ${url.substring(0, 80)}..., isVectorengineOpenAI=${isVectorengineOpenAI}, isVectorengineGemini=${isVectorengineGemini}`);
    
    if (actualInit?.body && typeof actualInit.body === "string") {
      try {
        const bodyJson = JSON.parse(actualInit.body);
        if (bodyJson && typeof bodyJson === "object") {
          let fixed = false;
          
          // 修复 messages：仅对 vectorengine Gemini API 进行格式转换
          if (isVectorengineGemini && Array.isArray(bodyJson.messages)) {
            // 第一步：找到所有 assistant + tool 对
            const toolCallPairs: Array<{ assistantIndex: number; toolIndex: number }> = [];
            
            for (let i = 0; i < bodyJson.messages.length; i++) {
              const msg = bodyJson.messages[i];
              if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                // 找到对应的 tool 消息
                for (let j = i + 1; j < bodyJson.messages.length; j++) {
                  if (bodyJson.messages[j].role === "tool") {
                    toolCallPairs.push({ assistantIndex: i, toolIndex: j });
                    break;
                  }
                }
              }
            }
            
            // 最后一对
            const lastPair = toolCallPairs.length > 0 ? toolCallPairs[toolCallPairs.length - 1] : null;
            
            console.warn(`[llm-gated-fetch] [DEBUG] 找到 ${toolCallPairs.length} 对 tool_calls，最后一对: assistant[${lastPair?.assistantIndex}], tool[${lastPair?.toolIndex}]`);
            
            // 第二步：处理所有消息
            for (let i = 0; i < bodyJson.messages.length; i++) {
              const msg = bodyJson.messages[i];
              
              // 修复 1: content 数组 → 字符串
              if (Array.isArray(msg.content)) {
                const textParts = msg.content
                  .filter((block: { type?: string }) => block.type === "text")
                  .map((block: { text?: string }) => block.text || "")
                  .join("\n");
                
                msg.content = textParts;
                fixed = true;
                console.warn(`[llm-gated-fetch] 修复 content 数组 → 字符串 (message[${i}])`);
              }
              
              // 修复 2: 保持 content: null（OpenAI 标准格式）
              if (msg.content === "") {
                msg.content = null;
                fixed = true;
                console.warn(`[llm-gated-fetch] 修复 content: "" → null (message[${i}])`);
              }
              
              // 修复 3: 处理 tool_calls
              if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                if (lastPair && i === lastPair.assistantIndex) {
                  // 最后一次 tool_calls：转换为 Gemini 格式
                  const contentParts = [];
                  
                  for (const toolCall of msg.tool_calls) {
                    if (toolCall && toolCall.function && typeof toolCall.function === "object") {
                      let args = toolCall.function.arguments;
                      if (typeof args === "string") {
                        try {
                          args = JSON.parse(args);
                        } catch {
                          // 解析失败，保持字符串
                        }
                      }
                      
                      contentParts.push({
                        functionCall: {
                          name: toolCall.function.name,
                          args: args || {},
                        },
                        thought_signature: "default",
                      });
                    }
                  }
                  
                  if (contentParts.length > 0) {
                    msg.content = contentParts;
                    delete msg.tool_calls;
                    fixed = true;
                    console.warn(`[llm-gated-fetch] 转换 tool_calls → functionCall (Gemini 格式) (message[${i}]) [最后一次]`);
                  }
                } else {
                  // 历史 tool_calls：内联到 content 中（纯文本）
                  const toolCallsText = msg.tool_calls
                    .map((tc: any) => `[调用工具: ${tc.function?.name || "unknown"}]`)
                    .join("\n");
                  
                  if (typeof msg.content === "string") {
                    msg.content += `\n\n${toolCallsText}`;
                  } else if (msg.content === null) {
                    msg.content = toolCallsText;
                  }
                  
                  delete msg.tool_calls;
                  fixed = true;
                  console.warn(`[llm-gated-fetch] 内联 tool_calls 到 content (message[${i}]) [历史]`);
                }
              }
              
              // 修复 4: 处理 tool 消息
              if (msg.role === "tool" && msg.tool_call_id) {
                if (lastPair && i === lastPair.toolIndex) {
                  // 最后一次 tool 结果：转换为 Gemini 格式的 functionResponse
                  const toolCallId = msg.tool_call_id;
                  const toolContent = msg.content || "(no output)";
                  
                  // 找到对应的 functionCall 来获取工具名称
                  let toolName = "unknown";
                  
                  // 方法 1：从对应的 assistant 消息的 content 中提取（Gemini 格式）
                  if (lastPair && lastPair.assistantIndex >= 0) {
                    const assistantMsg = bodyJson.messages[lastPair.assistantIndex];
                    if (Array.isArray(assistantMsg.content)) {
                      for (const block of assistantMsg.content) {
                        if (block.functionCall && block.functionCall.name) {
                          toolName = block.functionCall.name;
                          break;
                        }
                      }
                    }
                    
                    // 方法 2：从 tool_calls 中提取（OpenAI 格式）
                    if (toolName === "unknown" && Array.isArray(assistantMsg.tool_calls)) {
                      for (const toolCall of assistantMsg.tool_calls) {
                        if (toolCall && toolCall.id === toolCallId && toolCall.function && toolCall.function.name) {
                          toolName = toolCall.function.name;
                          console.warn(`[llm-gated-fetch] [DEBUG] 从 tool_calls 中提取工具名称: ${toolName}`);
                          break;
                        }
                      }
                    }
                  }
                  
                  // 如果还是 unknown，记录警告
                  if (toolName === "unknown") {
                    console.error(`[llm-gated-fetch] ❌ 无法提取工具名称！tool_call_id=${toolCallId}, lastPair=${JSON.stringify(lastPair)}`);
                  }
                  
                  // 转换为 Gemini 格式
                  msg.role = "function";
                  
                  // 解析 toolContent（可能是 JSON 字符串）
                  let responseContent: any;
                  if (typeof toolContent === "string") {
                    try {
                      responseContent = JSON.parse(toolContent);
                    } catch {
                      // 如果不是 JSON，包装成对象
                      responseContent = { result: toolContent };
                    }
                  } else {
                    responseContent = toolContent;
                  }
                  
                  msg.parts = [
                    {
                      functionResponse: {
                        name: toolName,
                        response: responseContent,
                      },
                    },
                  ];
                  delete msg.content;
                  delete msg.tool_call_id;
                  fixed = true;
                  console.warn(`[llm-gated-fetch] 转换 tool → functionResponse (Gemini 格式) (message[${i}]) [最后一次]`);
                  console.warn(`[llm-gated-fetch] [DEBUG] 转换后: role=${msg.role}, toolName=${toolName}, parts=${JSON.stringify(msg.parts).substring(0, 200)}`);
                } else {
                  // 历史 tool 结果：内联到前一条 assistant 消息中
                  if (i > 0 && bodyJson.messages[i - 1].role === "assistant") {
                    const assistantMsg = bodyJson.messages[i - 1];
                    const toolResult = `\n\n[工具执行结果]\n${msg.content || "(no output)"}`;
                    
                    if (typeof assistantMsg.content === "string") {
                      assistantMsg.content += toolResult;
                    } else if (assistantMsg.content === null) {
                      assistantMsg.content = toolResult;
                    } else if (Array.isArray(assistantMsg.content)) {
                      // 如果 content 是数组（Gemini 格式），转换为字符串
                      const textContent = assistantMsg.content
                        .map((block: any) => {
                          if (block.type === "text") return block.text;
                          if (block.functionCall) return `[调用工具: ${block.functionCall.name}]`;
                          return "";
                        })
                        .join("\n");
                      assistantMsg.content = textContent + toolResult;
                    }
                    
                    msg._shouldDelete = true;
                    fixed = true;
                    console.warn(`[llm-gated-fetch] 内联 tool 消息到 assistant (message[${i - 1}]) [历史]`);
                  }
                }
              }
            }
          }
          
          // 修复 tools：仅对 vectorengine Gemini API 添加 thought_signature
          if (isVectorengineGemini && Array.isArray(bodyJson.tools)) {
            for (let i = 0; i < bodyJson.tools.length; i++) {
              const tool = bodyJson.tools[i];
              
              // 确保 tool 有 thought_signature
              if (tool && typeof tool === "object" && !("thought_signature" in tool)) {
                tool.thought_signature = "default";
                fixed = true;
                console.warn(`[llm-gated-fetch] 添加 tool.thought_signature (tool[${i}])`);
              }
              
              // 确保 tool.function 有 thought_signature
              if (tool && typeof tool === "object" && tool.function && typeof tool.function === "object") {
                if (!("thought_signature" in tool.function)) {
                  tool.function.thought_signature = "default";
                  fixed = true;
                  console.warn(`[llm-gated-fetch] 添加 tool.function.thought_signature (tool[${i}])`);
                }
              }
            }
          }
          
          // 删除标记为需要删除的消息（内联后的 tool 消息）
          if (isVectorengineGemini && Array.isArray(bodyJson.messages)) {
            const originalCount = bodyJson.messages.length;
            bodyJson.messages = bodyJson.messages.filter((msg: any) => !msg._shouldDelete);
            const deletedCount = originalCount - bodyJson.messages.length;
            if (deletedCount > 0) {
              console.warn(`[llm-gated-fetch] 删除了 ${deletedCount} 条内联后的 tool 消息`);
              fixed = true;
            }
          }
          
          // 🔧 Fix: Grok (vectorengine OpenAI API) 不支持 developer role，转换为 system
          // 标准 OpenAI API 支持 developer，但很多第三方 API 不支持
          if (isVectorengineOpenAI && Array.isArray(bodyJson.messages)) {
            let convertedCount = 0;
            let toolResultConvertedCount = 0;
            
            // 🔧 P130: 收集所有 assistant.tool_calls[].id 用于验证
            const validToolCallIds = new Set<string>();
            for (const msg of bodyJson.messages) {
              if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                  if (tc && typeof tc.id === "string") {
                    validToolCallIds.add(tc.id);
                  }
                }
              }
            }
            console.warn(`[llm-gated-fetch] 🔍 P130: 收集到 ${validToolCallIds.size} 个有效的 tool_call_id`);
            
            for (const msg of bodyJson.messages) {
              // developer → system
              if (msg.role === "developer") {
                msg.role = "system";
                convertedCount++;
              }
              // 🔧 P125: toolResult → tool (OpenAI 标准格式)
              if (msg.role === "toolResult") {
                msg.role = "tool";
                toolResultConvertedCount++;
              }
              
              // 🔧 P130: 验证 tool 消息的 tool_call_id 是否有效
              if (msg.role === "tool") {
                const msgAny = msg as any;
                const toolCallId = msgAny.tool_call_id || msgAny.toolCallId;
                
                if (!toolCallId) {
                  console.error(`[llm-gated-fetch] ❌ P130: tool 消息缺少 tool_call_id！content 预览: ${(msgAny.content || "").substring(0, 100)}...`);
                } else if (!validToolCallIds.has(toolCallId)) {
                  console.error(`[llm-gated-fetch] ❌ P130: tool_call_id="${toolCallId}" 不匹配任何 assistant.tool_calls[].id！`);
                  console.error(`[llm-gated-fetch] ❌ P130: 有效的 IDs: [${Array.from(validToolCallIds).slice(0, 5).join(", ")}${validToolCallIds.size > 5 ? "..." : ""}]`);
                  
                  // 🔧 P130: 尝试修复 - 找到最近的一个未使用的 tool_call_id
                  // 这是一个临时方案，正确的做法是在保存消息时就确保 ID 匹配
                  const toolName = msgAny.name || msgAny.toolName || "unknown";
                  console.warn(`[llm-gated-fetch] 🔧 P130: 尝试匹配工具名称="${toolName}"`);
                  
                  // 找到对应工具名称的 tool_call_id
                  for (const prevMsg of bodyJson.messages) {
                    if (prevMsg.role === "assistant" && Array.isArray(prevMsg.tool_calls)) {
                      for (const tc of prevMsg.tool_calls) {
                        if (tc && tc.function && tc.function.name === toolName && validToolCallIds.has(tc.id)) {
                          msgAny.tool_call_id = tc.id;
                          console.warn(`[llm-gated-fetch] ✅ P130: 修复 tool_call_id="${toolCallId}" → "${tc.id}"`);
                          fixed = true;
                          break;
                        }
                      }
                    }
                  }
                } else {
                  console.warn(`[llm-gated-fetch] ✅ P130: tool_call_id="${toolCallId}" 验证通过`);
                }
              }
            }
            if (convertedCount > 0) {
              console.warn(`[llm-gated-fetch] 🔄 Grok: 转换 developer → system role (${convertedCount} 条消息)`);
              fixed = true;
            }
            if (toolResultConvertedCount > 0) {
              console.warn(`[llm-gated-fetch] 🔄 P125: 转换 toolResult → tool role (${toolResultConvertedCount} 条消息)`);
              fixed = true;
            }
            
            // 🔧 DISABLED: P121 解包 tool result 可能导致格式问题
            // 暂时禁用，观察是否能解决超时问题
            /*
            let unwrappedCount = 0;
            for (const msg of bodyJson.messages) {
              if (msg.role === "tool" && typeof msg.content === "string") {
                try {
                  const parsed = JSON.parse(msg.content);
                  if (parsed && typeof parsed === "object" && "result" in parsed) {
                    msg.content = typeof parsed.result === "string" 
                      ? parsed.result 
                      : JSON.stringify(parsed.result);
                    unwrappedCount++;
                  }
                } catch {
                  // 不是 JSON，保持原样
                }
              }
            }
            if (unwrappedCount > 0) {
              console.warn(`[llm-gated-fetch] 🔄 Grok: 解包 tool result JSON 包装 (${unwrappedCount} 条消息)`);
              fixed = true;
            }
            */
            
            // 🔧 DISABLED: P121 压缩历史 tool calls 可能导致格式问题
            // 暂时禁用，观察是否能解决超时问题
            /*
            const toolCallPairsOpenAI: Array<{ assistantIndex: number; toolIndices: number[] }> = [];
            
            for (let i = 0; i < bodyJson.messages.length; i++) {
              const msg = bodyJson.messages[i];
              if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const toolIndices: number[] = [];
                for (let j = i + 1; j < bodyJson.messages.length; j++) {
                  if (bodyJson.messages[j].role === "tool") {
                    toolIndices.push(j);
                  } else {
                    break;
                  }
                }
                if (toolIndices.length > 0) {
                  toolCallPairsOpenAI.push({ assistantIndex: i, toolIndices });
                }
              }
            }
            
            if (toolCallPairsOpenAI.length > 1) {
              console.warn(`[llm-gated-fetch] 🔧 Grok: 压缩历史 tool calls (${toolCallPairsOpenAI.length - 1} 对)`);
              
              for (let pairIdx = 0; pairIdx < toolCallPairsOpenAI.length - 1; pairIdx++) {
                const pair = toolCallPairsOpenAI[pairIdx];
                const assistantMsg = bodyJson.messages[pair.assistantIndex];
                
                const summaryParts: string[] = [];
                
                if (typeof assistantMsg.content === "string" && assistantMsg.content.trim()) {
                  summaryParts.push(truncateText(assistantMsg.content.trim(), 200));
                } else if (Array.isArray(assistantMsg.content)) {
                  const textContent = assistantMsg.content
                    .filter((b: any) => b.type === "text" && typeof b.text === "string")
                    .map((b: any) => b.text)
                    .join("\n");
                  if (textContent.trim()) {
                    summaryParts.push(truncateText(textContent.trim(), 200));
                  }
                }
                
                if (Array.isArray(assistantMsg.tool_calls)) {
                  for (let tcIdx = 0; tcIdx < assistantMsg.tool_calls.length; tcIdx++) {
                    const tc = assistantMsg.tool_calls[tcIdx];
                    const toolName = tc?.function?.name || "unknown";
                    
                    let argsPreview = "";
                    if (tc?.function?.arguments) {
                      try {
                        const args = typeof tc.function.arguments === "string" 
                          ? JSON.parse(tc.function.arguments) 
                          : tc.function.arguments;
                        
                        if ((toolName === "write" || toolName === "edit") && args.content) {
                          const contentPreview = typeof args.content === "string" 
                            ? truncateText(args.content.replace(/\s+/g, " "), 100)
                            : "[复杂内容]";
                          argsPreview = ` (content: ${contentPreview})`;
                        } else if (args.path) {
                          argsPreview = ` (path: ${args.path})`;
                        }
                      } catch {
                        // 解析失败，忽略
                      }
                    }
                    
                    let resultPreview = "已完成";
                    const toolMsgIdx = pair.toolIndices[tcIdx];
                    if (toolMsgIdx !== undefined) {
                      const toolMsg = bodyJson.messages[toolMsgIdx];
                      if (toolMsg && typeof toolMsg.content === "string") {
                        resultPreview = truncateText(toolMsg.content.replace(/\s+/g, " "), 100);
                      }
                    }
                    
                    summaryParts.push(`[工具: ${toolName}${argsPreview}] → ${resultPreview}`);
                  }
                }
                
                assistantMsg.content = summaryParts.join("\n\n");
                delete assistantMsg.tool_calls;
                
                for (const toolIdx of pair.toolIndices) {
                  (bodyJson.messages[toolIdx] as any)._shouldDelete = true;
                }
                
                fixed = true;
              }
              
              const originalCount = bodyJson.messages.length;
              bodyJson.messages = bodyJson.messages.filter((msg: any) => !msg._shouldDelete);
              const deletedCount = originalCount - bodyJson.messages.length;
              
              console.warn(`[llm-gated-fetch] 🔧 Grok: 删除了 ${deletedCount} 条压缩后的 tool 消息`);
            }
            */
          }
          
          // 🔧 Fix: Grok (vectorengine OpenAI API) tool schema 清理
          // 某些 JSON Schema 字段可能不被 Grok API 支持，需要移除
          if (isVectorengineOpenAI && Array.isArray(bodyJson.tools)) {
            // 定义 Grok 可能不支持的 schema 字段
            const GROK_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
              "$schema", "$id", "$ref", "$defs", "definitions",
              "examples", "patternProperties", "propertyNames",
              "minLength", "maxLength", "minimum", "maximum", 
              "multipleOf", "pattern", "format",
              "minItems", "maxItems", "uniqueItems",
              "minProperties", "maxProperties",
              "if", "then", "else", "dependentSchemas", "dependentRequired",
              // OpenAI 特有的字段，Grok 可能不支持
              "strict", "additionalProperties"
            ]);
            
            function cleanSchemaForGrok(schema: unknown): unknown {
              if (!schema || typeof schema !== "object") return schema;
              if (Array.isArray(schema)) {
                return schema.map(cleanSchemaForGrok);
              }
              
              const obj = schema as Record<string, unknown>;
              const cleaned: Record<string, unknown> = {};
              
              for (const [key, value] of Object.entries(obj)) {
                // 跳过不支持的字段
                if (GROK_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
                  continue;
                }
                
                // 递归清理嵌套结构
                if (key === "properties" && value && typeof value === "object") {
                  const props = value as Record<string, unknown>;
                  cleaned[key] = Object.fromEntries(
                    Object.entries(props).map(([k, v]) => [k, cleanSchemaForGrok(v)])
                  );
                } else if (key === "items" && value) {
                  if (Array.isArray(value)) {
                    cleaned[key] = value.map(cleanSchemaForGrok);
                  } else if (typeof value === "object") {
                    cleaned[key] = cleanSchemaForGrok(value);
                  } else {
                    cleaned[key] = value;
                  }
                } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
                  cleaned[key] = value.map(cleanSchemaForGrok);
                } else {
                  cleaned[key] = value;
                }
              }
              
              return cleaned;
            }
            
            let cleanedToolCount = 0;
            for (let i = 0; i < bodyJson.tools.length; i++) {
              const tool = bodyJson.tools[i];
              if (tool?.function?.parameters) {
                const originalParams = tool.function.parameters;
                const cleanedParams = cleanSchemaForGrok(originalParams);
                if (JSON.stringify(originalParams) !== JSON.stringify(cleanedParams)) {
                  tool.function.parameters = cleanedParams;
                  cleanedToolCount++;
                }
              }
            }
            
            if (cleanedToolCount > 0) {
              console.warn(`[llm-gated-fetch] 🧹 Grok: 清理 tool schema (${cleanedToolCount}/${bodyJson.tools.length} 个工具)`);
              fixed = true;
            }
          }
          
          // 🆕 DEBUG: Grok 请求详情日志
          if (isVectorengineOpenAI) {
            const hasTools = Array.isArray(bodyJson.tools) && bodyJson.tools.length > 0;
            const hasStream = bodyJson.stream === true;
            const modelName = bodyJson.model || "unknown";
            const isReasoningModel = modelName.includes("reasoning");
            
            // 计算消息统计
            const msgCount = Array.isArray(bodyJson.messages) ? bodyJson.messages.length : 0;
            let totalContentChars = 0;
            let maxContentChars = 0;
            let toolMsgCount = 0;
            let assistantMsgCount = 0;
            let totalToolCallIds = 0;
            
            if (Array.isArray(bodyJson.messages)) {
              for (const msg of bodyJson.messages) {
                if (msg.role === "tool") toolMsgCount++;
                if (msg.role === "assistant") {
                  assistantMsgCount++;
                  if (Array.isArray(msg.tool_calls)) {
                    totalToolCallIds += msg.tool_calls.length;
                  }
                }
                if (typeof msg.content === "string") {
                  totalContentChars += msg.content.length;
                  maxContentChars = Math.max(maxContentChars, msg.content.length);
                } else if (Array.isArray(msg.content)) {
                  for (const block of msg.content) {
                    if (block.type === "text" && typeof block.text === "string") {
                      totalContentChars += block.text.length;
                      maxContentChars = Math.max(maxContentChars, block.text.length);
                    }
                  }
                }
              }
            }
            
            console.warn(`[llm-gated-fetch] [DEBUG-Grok] 模型: ${modelName}, 推理模型: ${isReasoningModel}`);
            console.warn(`[llm-gated-fetch] [DEBUG-Grok] tools数量: ${hasTools ? bodyJson.tools.length : 0}, stream: ${hasStream}`);
            console.warn(`[llm-gated-fetch] [DEBUG-Grok] 消息统计: ${msgCount}条 (assistant=${assistantMsgCount}, tool=${toolMsgCount}), 总字符: ${totalContentChars}`);
            console.warn(`[llm-gated-fetch] [DEBUG-Grok] tool_calls 总数: ${totalToolCallIds}, tool 消息数: ${toolMsgCount}`);
            
            // 🔧 P130: 检查 tool_calls 与 tool 消息数量是否匹配
            if (toolMsgCount > 0 && toolMsgCount !== totalToolCallIds) {
              console.error(`[llm-gated-fetch] ❌ P130: tool 消息数(${toolMsgCount}) 与 tool_calls 总数(${totalToolCallIds}) 不匹配！`);
            }
            
            // 🔧 Fix: Grok reasoning 模型 + tools 的特殊参数配置
            if (isReasoningModel && hasTools) {
              console.warn(`[llm-gated-fetch] [DEBUG-Grok] ⚠️ 推理模型 + tools 组合，添加必要参数`);
              
              // 添加 tool_choice: auto（让模型自动选择是否调用工具）
              if (!bodyJson.tool_choice) {
                bodyJson.tool_choice = "auto";
                fixed = true;
                console.warn(`[llm-gated-fetch] [DEBUG-Grok] 添加 tool_choice: auto`);
              }
              
              // 添加 parallel_tool_calls: false（Grok 可能不支持并行工具调用）
              if (bodyJson.parallel_tool_calls === undefined) {
                bodyJson.parallel_tool_calls = false;
                fixed = true;
                console.warn(`[llm-gated-fetch] [DEBUG-Grok] 添加 parallel_tool_calls: false`);
              }
              
              // 🔧 Fix: 推理模型 + tools 默认使用非流式，避免空响应问题
              // 直接设置 stream=false，因为 stream=true 会先返回空响应再降级，浪费时间
              if (bodyJson.stream !== false) {
                bodyJson.stream = false;
                fixed = true;
                console.warn(`[llm-gated-fetch] [DEBUG-Grok] 🔧 默认设置 stream=false（推理模型+tools）`);
              }
            }
            
            // 🔍 打印第一个 tool 的 schema 结构（调试用）
            if (hasTools && bodyJson.tools[0]?.function) {
              const firstTool = bodyJson.tools[0];
              const paramKeys = firstTool.function.parameters 
                ? Object.keys(firstTool.function.parameters as object)
                : [];
              console.warn(`[llm-gated-fetch] [DEBUG-Grok] 第一个tool: ${firstTool.function.name}, params字段: [${paramKeys.join(", ")}]`);
            }
            
            // 🔧 Fix: 检查并修复可能不兼容的参数组合
            // Grok 可能不支持某些 OpenAI 特有的参数
            const incompatibleParams = ["reasoning_effort", "response_format", "store", "metadata"];
            for (const param of incompatibleParams) {
              if (param in bodyJson) {
                console.warn(`[llm-gated-fetch] [DEBUG-Grok] 移除可能不兼容的参数: ${param}`);
                delete (bodyJson as Record<string, unknown>)[param];
                fixed = true;
              }
            }
            
            // 🆕 P121: Grok reasoning 模型长上下文优化
            // 当消息数量过多时，保留系统消息 + 最后一次完整的 tool call 对 + 最近消息
            if (isReasoningModel && Array.isArray(bodyJson.messages)) {
              const MAX_GROK_MESSAGES = 10; // 最多保留 10 条消息
              
              if (bodyJson.messages.length > MAX_GROK_MESSAGES) {
                console.warn(`[llm-gated-fetch] [DEBUG-Grok] ⚠️ 消息过多 (${bodyJson.messages.length}条)，智能截断至 ${MAX_GROK_MESSAGES} 条`);
                
                // 🔧 修复：保留完整的 tool call 对（assistant + tool result）
                // 找到最后一对完整的 tool call（assistant + tool results）
                let lastToolCallPair: { assistantIdx: number; toolIndices: number[] } | null = null;
                for (let i = bodyJson.messages.length - 1; i >= 0; i--) {
                  const msg = bodyJson.messages[i];
                  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    const toolIndices: number[] = [];
                    // 找到紧跟其后的所有 tool 消息
                    for (let j = i + 1; j < bodyJson.messages.length; j++) {
                      if (bodyJson.messages[j].role === "tool") {
                        toolIndices.push(j);
                      } else {
                        break;
                      }
                    }
                    if (toolIndices.length > 0) {
                      lastToolCallPair = { assistantIdx: i, toolIndices };
                      break;
                    }
                  }
                }
                
                // 构建保留的消息列表
                const preservedIndices = new Set<number>();
                
                // 1. 保留系统消息
                for (let i = 0; i < bodyJson.messages.length; i++) {
                  if (bodyJson.messages[i].role === "system") {
                    preservedIndices.add(i);
                  }
                }
                
                // 2. 保留最后一次完整的 tool call 对
                if (lastToolCallPair) {
                  preservedIndices.add(lastToolCallPair.assistantIdx);
                  for (const idx of lastToolCallPair.toolIndices) {
                    preservedIndices.add(idx);
                  }
                  console.warn(`[llm-gated-fetch] [DEBUG-Grok] 保留 tool call 对: assistant[${lastToolCallPair.assistantIdx}] + tools[${lastToolCallPair.toolIndices.join(",")}]`);
                }
                
                // 3. 从最近的用户消息开始填充，直到达到限制
                const remainingSlots = MAX_GROK_MESSAGES - preservedIndices.size;
                if (remainingSlots > 0) {
                  // 从后向前添加最近的消息
                  for (let i = bodyJson.messages.length - 1; i >= 0 && preservedIndices.size < MAX_GROK_MESSAGES; i--) {
                    if (!preservedIndices.has(i)) {
                      preservedIndices.add(i);
                    }
                  }
                }
                
                // 按原始顺序重建消息数组
                const sortedIndices = Array.from(preservedIndices).sort((a, b) => a - b);
                bodyJson.messages = sortedIndices.map(i => bodyJson.messages[i]);
                fixed = true;
                
                console.warn(`[llm-gated-fetch] [DEBUG-Grok] 截断后: ${bodyJson.messages.length} 条消息（保留完整 tool call 对）`);
              }
            }
          }
          
          if (fixed) {
            // 重新序列化修复后的 body
            try {
              const serialized = JSON.stringify(bodyJson);
              actualInit = { ...actualInit, body: serialized };
              console.warn(`[llm-gated-fetch] ✅ Body 序列化成功，长度: ${serialized.length} 字节`);
            } catch (serializeError) {
              console.error(`[llm-gated-fetch] ❌ Body 序列化失败:`, serializeError);
              // 序列化失败，使用原始 body
              console.warn(`[llm-gated-fetch] 使用原始 body（未修复）`);
            }
          }
        }
      } catch (error) {
        // 解析失败，忽略（不是 JSON body）
        console.warn(`[llm-gated-fetch] Body 解析失败（不是 JSON）:`, error);
      }
    }
    
    try {
      console.log(`[llm-gated-fetch] 🌐 调用 original fetch...`);
      const response = await original(input, { ...actualInit, signal: combinedSignal });
      
      console.log(`[llm-gated-fetch] ✅ Fetch 完成，状态码：${response.status}`);
      
      // 清除超时定时器
      clearTimeout(timeoutId);
      
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
      
      // 🔧 P127: 检测 Grok 推理模型空响应，触发 stream=false 降级重试
      // 必须在返回 response 之前同步检测
      const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const isGrokApi = reqUrl.includes("vectorengine") && reqUrl.includes("/v1/");
      
      if (response.ok && isGrokApi && streamFallbackAttempt < MAX_STREAM_FALLBACK_ATTEMPTS && actualInit?.body && typeof actualInit.body === "string") {
        // 提取请求参数（在 try 外部，确保能看到诊断日志）
        let bodyJson: any;
        try {
          bodyJson = JSON.parse(actualInit.body);
        } catch (e) {
          console.warn(`[llm-gated-fetch] P127: 请求 body 解析失败:`, e);
          bodyJson = {};
        }
        
        const isReasoningModel = typeof bodyJson.model === "string" && bodyJson.model.includes("reasoning");
        const hasStream = bodyJson.stream === true;
        const hasTools = Array.isArray(bodyJson.tools) && bodyJson.tools.length > 0;
        
        console.warn(`[llm-gated-fetch] 🔍 P127 条件检查: isReasoningModel=${isReasoningModel}, hasStream=${hasStream}, hasTools=${hasTools}`);
        
        // 只有推理模型 + stream + tools 组合才需要检测
        if (isReasoningModel && hasStream && hasTools) {
          try {
            // 克隆 response 以读取内容（不消耗原始 body）
            const clonedResponse = response.clone();
            const bodyText = await clonedResponse.text();
            
            // 检测空响应（SSE 格式：data: {"choices":[]} 或 data: [DONE])
            const isEmptyChoices = bodyText.includes('"choices":[]') || bodyText.includes('"choices": []');
            const hasFunctionCall = bodyText.includes("functionCall");
            const hasToolCalls = bodyText.includes("tool_calls");
            const hasValidToolResponse = hasFunctionCall || hasToolCalls;
            const hasContent = bodyText.includes('"content"') && !bodyText.includes('"content":null') && !bodyText.includes('"content":[]');
            
            console.warn(`[llm-gated-fetch] 🔍 P127 响应检测: isEmptyChoices=${isEmptyChoices}, hasValidToolResponse=${hasValidToolResponse}, hasContent=${hasContent}, bodyLength=${bodyText.length}`);
            
            // 检测空响应且需要降级
            if (isEmptyChoices && !hasValidToolResponse && !hasContent) {
              streamFallbackAttempt++;
              console.warn(`[llm-gated-fetch] 🚨 P127: 检测到 Grok 推理模型空响应（stream=true + tools）`);
              console.warn(`[llm-gated-fetch] 🔄 P127: 自动降级为非 stream 模式重试 (${streamFallbackAttempt}/${MAX_STREAM_FALLBACK_ATTEMPTS})`);
              
              // 清除失败计数，允许降级重试
              attempts.delete(attemptKey);
              
              // 移除已 abort 的 signal
              const { signal: _, ...initWithoutSignal } = actualInit;
              return executeRequestWithRetry(attemptKey, input, initWithoutSignal, true);
            }
          } catch (parseError) {
            // 解析失败，继续返回原始响应
            console.warn(`[llm-gated-fetch] P127: 空响应检测解析失败:`, parseError);
          }
        }
      }
      
      // 🔧 P131: 当 forceNonStream=true 时，需要将非流式响应转换为 SSE 格式
      // OpenAI SDK 的 streamOpenAICompletions 期望 SSE 格式，不处理非流式 JSON
      // 另外：如果检测到 Grok 推理模型 + tools，也要强制转换（因为 stream=false 直接返回非流式响应）
      // 注意：reqUrl 和 isGrokApi 已在 P127 段声明，这里直接使用
      
      // 检测是否需要强制转换：forceNonStream 或者 Grok推理模型+tools
      let p131BodyJson: any = {};
      try {
        if (typeof actualInit?.body === "string") {
          p131BodyJson = JSON.parse(actualInit.body);
        }
      } catch {}
      const isReasoningModelWithTools = isGrokApi &&
        typeof p131BodyJson.model === "string" && p131BodyJson.model.includes("reasoning") &&
        Array.isArray(p131BodyJson.tools) && p131BodyJson.tools.length > 0;
      
      if ((forceNonStream || isReasoningModelWithTools) && response.ok) {
        const isOpenAICompletions = reqUrl.includes("/v1/chat/completions");
        
        if (isOpenAICompletions) {
          try {
            const responseText = await response.text();
            console.warn(`[llm-gated-fetch] 🔧 P131: 检测到非流式响应，转换为 SSE 格式`);
            console.warn(`[llm-gated-fetch] 🔧 P131: 原始响应长度: ${responseText.length}`);
            
            // 解析非流式响应
            const nonStreamResponse = JSON.parse(responseText);
            
            // 转换为 SSE 格式
            // 非流式格式: {"id":"...", "choices":[{"message":{"content":"..."}}]}
            // SSE 格式: data: {"id":"...", "choices":[{"delta":{"content":"..."}}]}
            const sseChunks: string[] = [];
            
            if (nonStreamResponse.choices && Array.isArray(nonStreamResponse.choices)) {
              for (const choice of nonStreamResponse.choices) {
                if (choice.message) {
                  // 🔧 P131: 转换 tool_calls 格式
                  // 非流式: tool_calls: [{"id":"xxx", "type":"function", "function":{...}}]
                  // 流式 delta: tool_calls: [{"index":0, "id":"xxx", "type":"function", "function":{...}}]
                  let deltaToolCalls: unknown[] | undefined = undefined;
                  if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0) {
                    deltaToolCalls = choice.message.tool_calls.map((tc: any, idx: number) => ({
                      index: idx,
                      id: tc.id || "",
                      type: tc.type || "function",
                      function: {
                        name: tc.function?.name || "",
                        arguments: tc.function?.arguments || "",
                        parameters: tc.function?.parameters  // 保留 parameters 字段！
                      }
                    }));
                  }
                  
                  const hasToolCalls = deltaToolCalls && deltaToolCalls.length > 0;
                  const hasContent = choice.message.content && choice.message.content.trim().length > 0;
                  const finishReason = choice.finish_reason || "stop";
                  
                  // 🧩 2-chunk 格式：第一个chunk包含所有内容，第二个chunk只包含finish_reason
                  // 这样 SDK 可以正确累积 tool_calls 数据
                  
                  // Chunk 1: 所有内容 + finish_reason: null（让 SDK 继续等待）
                  const delta1: Record<string, unknown> = {
                    role: "assistant",
                  };
                  if (hasContent) {
                    delta1.content = choice.message.content;
                  }
                  if (hasToolCalls) {
                    delta1.tool_calls = deltaToolCalls;
                  }
                  
                  const chunk1 = {
                    id: nonStreamResponse.id || `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: nonStreamResponse.created || Math.floor(Date.now() / 1000),
                    model: nonStreamResponse.model || "unknown",
                    choices: [{
                      index: choice.index || 0,
                      delta: delta1,
                      finish_reason: null  // null 让 SDK 知道还有更多数据
                    }]
                  };
                  sseChunks.push(`data: ${JSON.stringify(chunk1)}`);
                  
                  // Chunk 2: 只有 finish_reason（告诉 SDK 数据结束）
                  const chunk2 = {
                    id: nonStreamResponse.id,
                    object: "chat.completion.chunk",
                    created: nonStreamResponse.created,
                    model: nonStreamResponse.model,
                    choices: [{
                      index: choice.index || 0,
                      delta: {},
                      finish_reason: finishReason
                    }]
                  };
                  sseChunks.push(`data: ${JSON.stringify(chunk2)}`);
                }
              }
            }
            
            // 添加 usage chunk（如果有）
            if (nonStreamResponse.usage) {
              const usageChunk = {
                id: nonStreamResponse.id || `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: nonStreamResponse.created || Math.floor(Date.now() / 1000),
                model: nonStreamResponse.model || "unknown",
                choices: [],
                usage: nonStreamResponse.usage
              };
              sseChunks.push(`data: ${JSON.stringify(usageChunk)}`);
            }
            
            // 添加 [DONE]
            sseChunks.push("data: [DONE]");
            
            const sseBody = sseChunks.join("\n\n") + "\n\n";
            console.warn(`[llm-gated-fetch] 🔧 P131: 转换后 SSE 长度: ${sseBody.length}, chunks: ${sseChunks.length}`);
            console.warn(`[llm-gated-fetch] 🔧 P131: SSE 预览: ${sseBody.substring(0, 500)}...`);
            
            // 返回转换后的 SSE 响应
            return new Response(sseBody, {
              status: response.status,
              statusText: response.statusText,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              }
            });
          } catch (parseError) {
            console.error(`[llm-gated-fetch] ❌ P131: 非流式响应转换失败:`, parseError);
            // 转换失败，返回原始响应
          }
        }
      }
      
      // 🔍 DEBUG: 打印原始 API 响应 body（排查 tool call 缺失、空响应等问题）
      // 对所有 LLM API 生效，异步读取不阻塞主流程
      {
        const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const isLlmApi = reqUrl.includes("v1beta") || 
                         reqUrl.includes("generativelanguage") || 
                         reqUrl.includes("/v1/chat/completions") ||
                         reqUrl.includes("/v1/responses");
        if (isLlmApi) {
          try {
            const cloned = response.clone();
            // 异步读取，不阻塞返回
            cloned.text().then((bodyText) => {
              const preview = bodyText.length > 2000 ? bodyText.slice(0, 2000) + `...(${bodyText.length} chars total)` : bodyText;
              const hasFunctionCall = bodyText.includes("functionCall");
              const hasToolCalls = bodyText.includes("tool_calls");
              const hasReasoning = bodyText.includes("reasoning_content") || bodyText.includes("reasoning_text");
              const hasThinking = bodyText.includes("thinking");
              const hasContent = bodyText.includes("content") && !bodyText.includes('"content":[]') && !bodyText.includes('"content":null');
              const isEmptyChoices = bodyText.includes('"choices":[]') || bodyText.includes('"choices": []');
              
              const isGrokApi = reqUrl.includes("vectorengine") && reqUrl.includes("/v1/");
              
              console.warn(`[llm-gated-fetch] 🔍 RAW RESPONSE from ${reqUrl.replace(/\?.*/, "")}: status=${response.status} hasFunctionCall=${hasFunctionCall} hasToolCalls=${hasToolCalls} hasReasoning=${hasReasoning} hasThinking=${hasThinking} hasContent=${hasContent} isEmptyChoices=${isEmptyChoices} bodyPreview=${preview}`);
              
              // 🆕 DEBUG: Grok API 空响应检测
              // 🔧 Fix: 正确的空响应判断 - 有 tool_calls/functionCall 的响应不是空响应
              const hasValidToolResponse = hasFunctionCall || hasToolCalls;
              const isTrulyEmpty = !hasContent && !hasValidToolResponse && !hasReasoning && !hasThinking;
              if (isGrokApi && isTrulyEmpty) {
                console.error(`[llm-gated-fetch] ❌ [DEBUG-Grok] 检测到空响应！可能需要调整请求参数`);
                console.error(`[llm-gated-fetch] ❌ [DEBUG-Grok] 建议：尝试移除 tools 或设置 stream=false`);
              } else if (isGrokApi && hasValidToolResponse) {
                console.warn(`[llm-gated-fetch] ✅ [DEBUG-Grok] 检测到有效 tool 调用响应，非空响应`);
              }
              
              // 🔧 P123: 检测极短响应（可能是 API 错误）
              if (isGrokApi && hasContent && !hasValidToolResponse) {
                try {
                  // 提取 completion_tokens
                  const tokensMatch = bodyText.match(/"completion_tokens"\s*:\s*(\d+)/);
                  if (tokensMatch) {
                    const completionTokens = parseInt(tokensMatch[1], 10);
                    if (completionTokens > 0 && completionTokens < 10) {
                      console.warn(`[llm-gated-fetch] ⚠️ P123: 检测到极短响应（${completionTokens} tokens），可能是 API 错误或内容过滤`);
                      console.warn(`[llm-gated-fetch] ⚠️ P123: 响应内容: ${preview.substring(0, 200)}`);
                    }
                  }
                } catch {
                  // 解析失败，忽略
                }
              }
              
              // 💾 存储 tool call 数据（用于下一次审批 UI 展示）
              if (hasFunctionCall || hasToolCalls) {
                try {
                  // 提取所有 functionCall/tool_calls 数据
                  const toolCalls: unknown[] = [];
                  
                  // Gemini 格式：functionCall
                  const geminiMatch = bodyText.match(/"functionCall":\{[^}]+\}/g);
                  if (geminiMatch) {
                    for (const m of geminiMatch) {
                      try {
                        const fc = JSON.parse(`{${m.slice(15)}`);
                        toolCalls.push(fc);
                      } catch {
                        // 解析失败，跳过
                      }
                    }
                  }
                  
                  // OpenAI 格式：tool_calls
                  const openaiMatch = bodyText.match(/"tool_calls":\[[^\]]+\]/g);
                  if (openaiMatch) {
                    for (const m of openaiMatch) {
                      try {
                        const tc = JSON.parse(`{${m.slice(13)}`);
                        toolCalls.push(...tc);
                      } catch {
                        // 解析失败，跳过
                      }
                    }
                  }
                  
                  if (toolCalls.length > 0) {
                    lastLlmToolCallsData = JSON.stringify(toolCalls, null, 2);
                    console.warn(`[llm-gated-fetch] 💾 存储 tool call 数据：${toolCalls.length} 条`);
                  }
                } catch (extractError) {
                  console.warn(`[llm-gated-fetch] 💾 提取 tool call 失败:`, extractError);
                }
              }
            }).catch((err) => {
              console.warn(`[llm-gated-fetch] 🔍 RAW RESPONSE read failed:`, err);
            });
          } catch {
            // clone 失败（某些 stream 不支持），跳过
          }
        }
      }
      
      return response;
    } catch (error) {
      // 清除超时定时器
      clearTimeout(timeoutId);
      
      // 检查错误是否可重试
      const canRetry = isRetryableError(error);
      
      if (!canRetry) {
        // 不可重试的错误（如内容违规），直接抛出
        console.error("[llm-gated-fetch] ❌ 不可重试的错误，直接抛出:", error);
        throw error;
      }
      
      // 可重试的错误，增加失败计数
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
      
      // 检查是否超过重试次数
      const currentAttempt = attempts.get(attemptKey);
      if (currentAttempt && currentAttempt.failureCount > MAX_ATTEMPTS_PER_KEY) {
        console.error(`[llm-gated-fetch] ❌ 已超过最大重试次数（${MAX_ATTEMPTS_PER_KEY}），放弃重试`);
        throw error;
      }
      
      // 记录错误类型
      if (error && typeof error === "object" && "name" in error) {
        const errorName = error.name;
        console.warn(`[llm-gated-fetch] ⚠️ 可重试的错误 (${errorName})，正在重试...`);
        
        // 🔧 P122: Grok 推理模型 stream 超时降级
        if (errorName === "AbortError" && streamFallbackAttempt < MAX_STREAM_FALLBACK_ATTEMPTS) {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
          const isGrokApi = url.includes("vectorengine") && url.includes("/v1/");
          
          // 🔧 P124: 使用 actualInit 而不是 init，保留所有修复
          if (isGrokApi && actualInit?.body && typeof actualInit.body === "string") {
            try {
              const bodyJson = JSON.parse(actualInit.body);
              const isReasoningModel = typeof bodyJson.model === "string" && bodyJson.model.includes("reasoning");
              const hasStream = bodyJson.stream === true;
              const hasTools = Array.isArray(bodyJson.tools) && bodyJson.tools.length > 0;
              const hasToolResults = Array.isArray(bodyJson.messages) && 
                bodyJson.messages.some((m: any) => m.role === "tool" || m.role === "toolResult");
              
              if (isReasoningModel && hasStream && hasTools && hasToolResults) {
                streamFallbackAttempt++;
                console.warn(`[llm-gated-fetch] 🚨 P122: 检测到 Grok 推理模型 stream + tool result 超时`);
                console.warn(`[llm-gated-fetch] 🔄 P122: 自动降级为非 stream 模式重试 (${streamFallbackAttempt}/${MAX_STREAM_FALLBACK_ATTEMPTS})`);
                
                // 清除失败计数，允许降级重试
                attempts.delete(attemptKey);
                
                // 🔧 P124: 关键修复！使用 actualInit 保留所有修复，并移除已 abort 的 signal
                // 因为原始 signal 已经 abort，重试时必须创建新的 signal
                const { signal: _, ...initWithoutSignal } = actualInit;
                console.warn(`[llm-gated-fetch] 🔧 P124: 重试时移除已 abort 的 signal，使用 actualInit（保留消息修复）`);
                return executeRequestWithRetry(attemptKey, input, initWithoutSignal, true);
              }
            } catch {
              // 解析失败，走正常重试流程
            }
          }
        }
      } else {
        console.warn("[llm-gated-fetch] ⚠️ 可重试的错误，正在重试...");
      }
      
      // 重试（使用指数退避）
      const retryDelay = computeRetryDelay(currentAttempt?.failureCount || 1);
      console.warn(`[llm-gated-fetch] 🔄 正在重试 LLM 请求（第 ${currentAttempt?.failureCount || 1} 次失败后重试），等待 ${retryDelay}ms...`);
      
      // 🔧 DEBUG: 追踪重试时的参数状态
      const bodyType = typeof actualInit?.body;
      const bodyLength = typeof actualInit?.body === "string" ? actualInit.body.length : 0;
      console.warn(`[llm-gated-fetch] [DEBUG-Retry] input类型=${typeof input}, actualInit.body类型=${bodyType}, actualInit.body长度=${bodyLength}`);
      
      // 🔧 P124: 如果是 AbortError，移除已 aborted 的 signal
      // 因为 AbortSignal.any() 会立即返回 aborted signal 如果任一输入已 aborted
      const errorName = (error && typeof error === "object" && "name" in error) ? (error as Error).name : "";
      const isAbortError = errorName === "AbortError";
      
      if (isAbortError && actualInit?.signal) {
        console.warn(`[llm-gated-fetch] 🔧 P124: 普通重试路径 - 移除已 abort 的 signal`);
        const { signal: _, ...initWithoutSignal } = actualInit;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return executeRequestWithRetry(attemptKey, input, initWithoutSignal, forceNonStream);
      }
      
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      return executeRequestWithRetry(attemptKey, input, actualInit, forceNonStream);
    }
  };

  globalThis.fetch = wrapped;
}

// 注册 unhandledRejection handler 来处理网络错误
registerUnhandledRejectionHandler((reason) => {
  const message = formatErrorMessage(reason);
  
  // 处理网络错误（fetch failed）
  if (message.includes("fetch failed") || message.includes("TypeError: fetch failed")) {
    console.error("[llm-gated-fetch] Network error (unhandled):", message);
    // 返回 true 表示已处理，不需要 process.exit(1)
    return true;
  }
  
  // 处理 AbortError
  if (message.includes("AbortError") || message.includes("aborted")) {
    console.warn("[llm-gated-fetch] Request aborted (unhandled):", message);
    // 返回 true 表示已处理
    return true;
  }
  
  // 其他错误不处理
  return false;
});
