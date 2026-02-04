import {
  loadLlmApprovals,
  shouldAskLlmApproval,
  type LlmApprovalRequestPayload,
} from "./llm-approvals.js";
import { getLlmRequestContext } from "./llm-request-context.js";
import { createHash } from "node:crypto";
import { registerUnhandledRejectionHandler } from "./unhandled-rejections.js";
import { formatErrorMessage } from "./errors.js";

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
    try {
      const ctx = getLlmRequestContext();
      
      // 如果没有 LLM 请求上下文，直接调用原始 fetch（不拦截 Embeddings 等非 LLM 请求）
      if (!ctx) {
        return await original(input, init);
      }
      
      // 添加请求间隔控制，避免并发请求
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
        const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      lastRequestTime = Date.now();

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
            console.warn("[llm-gated-fetch] Network error (fetch failed):", error);
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

  // 执行请求并处理重试逻辑
  async function executeRequestWithRetry(
    attemptKey: string,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // 修复 payload 中的格式问题（在发送前修复）
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isVectorengine = url.includes("vectorengine");
    
    if (init?.body && typeof init.body === "string") {
      try {
        const bodyJson = JSON.parse(init.body);
        if (bodyJson && typeof bodyJson === "object") {
          let fixed = false;
          
          // 修复 messages：vectorengine 使用 OpenAI 格式，但有特殊要求
          if (isVectorengine && Array.isArray(bodyJson.messages)) {
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
          
          // 修复 tools：vectorengine 需要 thought_signature
          if (isVectorengine && Array.isArray(bodyJson.tools)) {
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
          if (isVectorengine && Array.isArray(bodyJson.messages)) {
            const originalCount = bodyJson.messages.length;
            bodyJson.messages = bodyJson.messages.filter((msg: any) => !msg._shouldDelete);
            const deletedCount = originalCount - bodyJson.messages.length;
            if (deletedCount > 0) {
              console.warn(`[llm-gated-fetch] 删除了 ${deletedCount} 条内联后的 tool 消息`);
              fixed = true;
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
      
      // 记录错误类型
      if (error && typeof error === "object" && "name" in error) {
        const errorName = error.name;
        if (errorName === "AbortError") {
          console.warn("[llm-gated-fetch] Request aborted in executeRequestWithRetry:", error);
        } else if (errorName === "TypeError") {
          const errorMessage = (error as { message?: string }).message;
          if (errorMessage && errorMessage.includes("fetch failed")) {
            console.warn("[llm-gated-fetch] Network error (fetch failed):", error);
          } else {
            console.warn(`[llm-gated-fetch] Request error (${errorName}):`, error);
          }
        } else {
          console.warn(`[llm-gated-fetch] Request error (${errorName}):`, error);
        }
      } else {
        console.warn("[llm-gated-fetch] Unknown request error:", error);
      }
      
      throw error;
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
