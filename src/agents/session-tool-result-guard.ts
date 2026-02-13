import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { makeMissingToolResult } from "./session-transcript-repair.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { convertGeminiToOpenAIFormat } from "./gemini-payload-thought-signature.js";
import { detectPseudoToolCall } from "./tool-execution-guard.js";

const log = createSubsystemLogger("agent/guard");

// P116: 工具结果大小上限（字符数）
// 30K 字符 ≈ 15-20K tokens（CJK），防止单个工具结果（如 read 大文件）
// 塞满整个 context window。典型场景：LLM 用 read 读取 1MB+ 小说全文。
const MAX_TOOL_RESULT_CHARS = 30_000;

type ToolCall = { id: string; name?: string };

function extractAssistantToolCalls(msg: Extract<AgentMessage, { role: "assistant" }>): ToolCall[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) continue;
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) return toolCallId;
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) return toolUseId;
  return null;
}

// ── P116: 工具结果截断辅助函数 ──

/**
 * 截断 OpenAI 格式的过大工具结果 (role="toolResult")
 *
 * 检查 content 中的文本块，如果总长度超过 MAX_TOOL_RESULT_CHARS，
 * 保留首尾各 40%/20% 并插入截断提示。
 */
function truncateLargeToolResult(
  msg: AgentMessage & { toolName?: string },
  toolName?: string,
): void {
  if (!("content" in msg)) return;
  const content = msg.content;

  // 处理字符串类型的 content
  if (typeof content === "string") {
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      const headLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.65);
      const tailLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.25);
      const truncated = content.substring(0, headLen)
        + `\n\n⚠️ [P116 工具结果截断] 原始内容 ${content.length} 字符，已截断到 ${MAX_TOOL_RESULT_CHARS} 字符上限。`
        + `\n如需完整内容，请使用 offset/limit 参数分段读取。\n\n`
        + content.substring(content.length - tailLen);
      (msg as { content: unknown }).content = truncated;
      log.warn(`[guard] ✂️ P116: 截断 toolResult (${toolName ?? "unknown"}) ${content.length} → ${truncated.length} 字符`);
    }
    return;
  }

  // 处理数组类型的 content
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const textBlock = block as { type?: string; text?: string };
    if (textBlock.type !== "text" || typeof textBlock.text !== "string") continue;

    if (textBlock.text.length > MAX_TOOL_RESULT_CHARS) {
      const original = textBlock.text;
      const headLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.65);
      const tailLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.25);
      textBlock.text = original.substring(0, headLen)
        + `\n\n⚠️ [P116 工具结果截断] 原始内容 ${original.length} 字符，已截断到 ${MAX_TOOL_RESULT_CHARS} 字符上限。`
        + `\n如需完整内容，请使用 offset/limit 参数分段读取。\n\n`
        + original.substring(original.length - tailLen);
      log.warn(`[guard] ✂️ P116: 截断 toolResult text block (${toolName ?? "unknown"}) ${original.length} → ${textBlock.text.length} 字符`);
    }
  }
}

/**
 * 截断 Gemini 格式的过大工具结果 (functionResponse)
 *
 * Gemini 格式：functionResponse.response 包含工具返回内容，
 * 可能是字符串或嵌套对象。递归检查并截断超大文本字段。
 */
function truncateGeminiFunctionResponse(
  functionResponse: Record<string, unknown>,
): void {
  const response = functionResponse.response;
  if (!response) return;

  const toolName = typeof functionResponse.name === "string" ? functionResponse.name : "unknown";

  // response 是字符串
  if (typeof response === "string" && response.length > MAX_TOOL_RESULT_CHARS) {
    const headLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.65);
    const tailLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.25);
    functionResponse.response = response.substring(0, headLen)
      + `\n\n⚠️ [P116 工具结果截断] 原始内容 ${response.length} 字符，已截断。\n\n`
      + response.substring(response.length - tailLen);
    log.warn(`[guard] ✂️ P116: 截断 Gemini functionResponse (${toolName}) ${response.length} → ${(functionResponse.response as string).length} 字符`);
    return;
  }

  // response 是对象（常见：{ content: [{ text: "..." }] } 或 { result: "..." }）
  if (typeof response === "object" && response !== null) {
    _truncateDeepStrings(response as Record<string, unknown>, toolName, 0);
  }
}

/**
 * 递归截断对象中的超大字符串字段（最多 2 层深度）
 */
function _truncateDeepStrings(
  obj: Record<string, unknown>,
  toolName: string,
  depth: number,
): void {
  if (depth > 2) return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string" && val.length > MAX_TOOL_RESULT_CHARS) {
      const headLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.65);
      const tailLen = Math.floor(MAX_TOOL_RESULT_CHARS * 0.25);
      obj[key] = val.substring(0, headLen)
        + `\n\n⚠️ [P116 截断] 原始 ${val.length} 字符\n\n`
        + val.substring(val.length - tailLen);
      log.warn(`[guard] ✂️ P116: 截断 Gemini response.${key} (${toolName}) ${val.length} → ${(obj[key] as string).length} 字符`);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === "object") {
          _truncateDeepStrings(item as Record<string, unknown>, toolName, depth + 1);
        }
      }
    } else if (val && typeof val === "object") {
      _truncateDeepStrings(val as Record<string, unknown>, toolName, depth + 1);
    }
  }
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    /**
     * Provider name for format conversion
     */
    provider?: string;
  },
): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const provider = opts?.provider;
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();
  
  // 🔧 Fix: For Gemini format, use a queue to match functionCall and functionResponse by order
  const geminiPendingToolNames: string[] = [];

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;

  const flushPendingToolResults = () => {
    if (pending.size === 0) return;
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        originalAppend(
          persistToolResult(synthetic, {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }) as never,
        );
      }
    }
    pending.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    const role = (message as { role?: unknown }).role;
    
    // 🔧 Fix: Handle Gemini format tool calls (role: "model" + parts + functionCall)
    // Extract toolName and add to queue for later matching with functionResponse
    if (role === "model") {
      const parts = (message as { parts?: unknown }).parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part && typeof part === "object") {
            const rec = part as Record<string, unknown>;
            if ("functionCall" in rec) {
              const functionCall = rec.functionCall as Record<string, unknown>;
              const toolName = typeof functionCall.name === "string" ? functionCall.name : undefined;
              if (toolName) {
                geminiPendingToolNames.push(toolName);
                log.debug(`[guard] Gemini functionCall detected: toolName="${toolName}", queue length=${geminiPendingToolNames.length}`);
              }
            }
          }
        }
      }
    }
    
    // 🔧 Fix: Handle Gemini format tool results (role: "user" + parts + functionResponse)
    // vectorengine saves tool results in Gemini format, not OpenAI format
    // P116: Also truncate oversized functionResponse content
    if (role === "user") {
      const parts = (message as { parts?: unknown }).parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part && typeof part === "object") {
            const rec = part as Record<string, unknown>;
            if ("functionResponse" in rec) {
              const functionResponse = rec.functionResponse as Record<string, unknown>;
              
              // 🆕 Fix: Remove signature fields from functionResponse (before saving to session)
              // These fields may interfere with LLM's understanding of tool results
              if ("thought_signature" in functionResponse) {
                delete functionResponse.thought_signature;
                log.debug(`[guard] Removed thought_signature from functionResponse`);
              }
              if ("thoughtSignature" in functionResponse) {
                delete functionResponse.thoughtSignature;
                log.debug(`[guard] Removed thoughtSignature from functionResponse`);
              }
              
              // 🆕 Fix: Remove signature fields from functionResponse.response
              if (functionResponse.response && typeof functionResponse.response === "object") {
                const response = functionResponse.response as Record<string, unknown>;
                if ("thought_signature" in response) {
                  delete response.thought_signature;
                  log.debug(`[guard] Removed thought_signature from functionResponse.response`);
                }
                if ("thoughtSignature" in response) {
                  delete response.thoughtSignature;
                  log.debug(`[guard] Removed thoughtSignature from functionResponse.response`);
                }
              }
              
              // P116: 截断 Gemini 格式的过大工具结果
              truncateGeminiFunctionResponse(functionResponse);
              
              // Match with the first pending toolName (FIFO order)
              if (geminiPendingToolNames.length > 0 && functionResponse.name === "unknown") {
                const toolName = geminiPendingToolNames.shift()!;
                functionResponse.name = toolName;
                log.info(`[guard] ✓ Fixed Gemini functionResponse.name: "unknown" → "${toolName}" (queue length=${geminiPendingToolNames.length})`);
              } else if (geminiPendingToolNames.length > 0) {
                // Remove from queue even if name is not "unknown"
                geminiPendingToolNames.shift();
                log.debug(`[guard] Gemini functionResponse already has name="${functionResponse.name}", removed from queue (queue length=${geminiPendingToolNames.length})`);
              } else {
                log.warn(`[guard] ⚠️ Gemini functionResponse but queue is empty, name="${functionResponse.name}"`);
              }
            }
          }
        }
      }
    }

    // 🔧 Fix: Normalize assistant messages with null content (OpenAI API requirement)
    // This ensures content is never saved as null to the session
    if (role === "assistant") {
      const msg = message as Extract<AgentMessage, { role: "assistant" }>;
      const contentType = msg.content === null ? "null" : msg.content === undefined ? "undefined" : Array.isArray(msg.content) ? `array(${msg.content.length})` : typeof msg.content;
      log.info(`[guard] appendMessage called: role=assistant, content=${contentType}`);
      
      // 🆕 DEBUG: Log full message structure to see what API returned
      // Truncate textSignature to avoid log spam
      const msgForLog = JSON.parse(JSON.stringify(msg));
      if (Array.isArray(msgForLog.content)) {
        for (const block of msgForLog.content) {
          if (block && typeof block === "object" && "textSignature" in block) {
            const sig = block.textSignature;
            if (typeof sig === "string" && sig.length > 32) {
              block.textSignature = `${sig.slice(0, 32)}...`;
            }
          }
        }
      }
      log.info(`[guard] [DEBUG] Full assistant message: ${JSON.stringify(msgForLog, null, 2).slice(0, 2000)}`);
      
      // 🔧 Fix: For vectorengine, convert empty content array to empty string
      // vectorengine (OpenAI compatible) converts empty array to null in payload
      // which causes API error
      if (Array.isArray(msg.content) && msg.content.length === 0) {
        // Check if this is a tool call message (has toolCall blocks)
        const hasToolCalls = msg.content.some((block: unknown) => {
          if (!block || typeof block !== "object") return false;
          const rec = block as Record<string, unknown>;
          return rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall";
        });
        
        if (hasToolCalls) {
          // For tool call messages, use empty string instead of empty array
          // This prevents OpenAI API from converting it to null
          msg.content = "" as never;
          log.info(`[guard] ✓ Converted empty content array to empty string (tool call message)`);
        }
      }
      
      // 🔧 Fix: Remove provider-specific signature fields from assistant messages before saving
      // Some providers (like yinli) return signature fields in responses, but may reject them in requests
      // We need to remove them from saved messages to prevent errors in subsequent requests
      
      // 🆕 Step 1: Remove message-level signature fields
      const msgRec = msg as unknown as Record<string, unknown>;
      if ("thoughtSignature" in msgRec) {
        delete msgRec.thoughtSignature;
        log.debug(`[guard] Removed thoughtSignature from message level`);
      }
      if ("thought_signature" in msgRec) {
        delete msgRec.thought_signature;
        log.debug(`[guard] Removed thought_signature from message level`);
      }
      if ("textSignature" in msgRec) {
        delete msgRec.textSignature;
        log.debug(`[guard] Removed textSignature from message level`);
      }
      
      // 🆕 Step 2: Remove content-level signature fields
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object") {
            const rec = block as unknown as Record<string, unknown>;
            if ("thoughtSignature" in rec) {
              delete rec.thoughtSignature;
              log.debug(`[guard] Removed thoughtSignature from content block`);
            }
            if ("thought_signature" in rec) {
              delete rec.thought_signature;
              log.debug(`[guard] Removed thought_signature from content block`);
            }
            if ("textSignature" in rec) {
              delete rec.textSignature;
              log.debug(`[guard] Removed textSignature from content block`);
            }
          }
        }
      }
      
      // 🔧 Fix: Detect pseudo tool calls in assistant text output
      // When LLM outputs tool calls as plain text (e.g. JSON tool format, fake success messages)
      // instead of proper function calling, convert them to real toolCall format so agent loop
      // executes them. Note: [Historical context: ...] is excluded — it's referential text.
      if (Array.isArray(msg.content)) {
        const hasRealToolCalls = msg.content.some((block: unknown) => {
          if (!block || typeof block !== "object") return false;
          const rec = block as Record<string, unknown>;
          return rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall";
        });
        
        if (!hasRealToolCalls) {
          // Extract all text content and check for pseudo tool calls
          const textBlocks = msg.content.filter((block: unknown) => {
            if (!block || typeof block !== "object") return false;
            return (block as Record<string, unknown>).type === "text";
          }) as Array<{ type: "text"; text: string }>;
          
          const fullText = textBlocks.map(b => b.text).join("\n");
          if (fullText.trim()) {
            const pseudoResult = detectPseudoToolCall(fullText);
            if (pseudoResult.detected && pseudoResult.toolName && pseudoResult.args) {
              const syntheticId = `pseudo_${pseudoResult.toolName}_${crypto.randomUUID().slice(0, 8)}`;
              log.warn(`[guard] ⚠️ Detected pseudo tool call: ${pseudoResult.toolName} → converting to real toolCall (id=${syntheticId})`);
              log.info(`[guard] Pseudo tool call args: ${JSON.stringify(pseudoResult.args).slice(0, 500)}`);
              
              // Replace text content with a real toolCall block
              msg.content = [
                {
                  type: "toolCall" as const,
                  id: syntheticId,
                  name: pseudoResult.toolName,
                  arguments: pseudoResult.args,
                },
              ] as never;
              
              log.info(`[guard] ✅ Converted pseudo tool call to real toolCall: ${pseudoResult.toolName}`);
            }
          }
        }
      }
      
      // 🔧 Fix: Handle sensitive words error from API
      // When API returns error due to sensitive words, fill content with friendly error message
      const stopReason = (msg as { stopReason?: unknown }).stopReason;
      const errorMessage = (msg as { errorMessage?: unknown }).errorMessage;
      const errorMessageStr = typeof errorMessage === "string" ? errorMessage : "";
      
      if (stopReason === "error" && errorMessageStr.toLowerCase().includes("sensitive words")) {
        log.warn(`[guard] ⚠️ Sensitive words detected by API, filling content with error message`);
        msg.content = [
          {
            type: "text" as const,
            text: "⚠️ 抱歉，您的消息包含敏感词，被 API 服务商拦截了。\n\n" +
                  "这不是系统错误，而是 API 服务商的内容审核机制。\n\n" +
                  "建议：\n" +
                  "1. 修改消息内容，避免敏感词\n" +
                  "2. 切换到官方 API（没有额外的内容审核）\n" +
                  "3. 使用其他没有内容审核的中转 API\n\n" +
                  `详细错误：${errorMessageStr}`,
          },
        ] as never;
        log.info(`[guard] ✓ Filled assistant.content with sensitive words error message`);
      } else if (msg.content === null) {
        // 🔧 Fix: vectorengine requires content to be empty string, not null or empty array
        // OpenAI Completions API allows null, but vectorengine rejects it
        msg.content = "" as never;
        log.info(`[guard] ✓ Fixed assistant.content: null → "" before saving to session`);
      } else if (Array.isArray(msg.content) && msg.content.length === 0 && stopReason === "error") {
        // 🔧 Fix: Handle empty content with error stopReason
        // This prevents system from breaking when API returns error with empty content
        log.warn(`[guard] ⚠️ Empty content with error stopReason, filling with generic error message`);
        msg.content = [
          {
            type: "text" as const,
            text: "⚠️ API 返回了错误响应，但没有提供详细信息。\n\n" +
                  (errorMessageStr ? `错误信息：${errorMessageStr}` : "请检查网络连接或稍后重试。"),
          },
        ] as never;
        log.info(`[guard] ✓ Filled assistant.content with generic error message`);
      }
    }

    if (role === "toolResult") {
      const id = extractToolResultId(message as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) pending.delete(id);
      
      // 🔧 Fix: Ensure toolName is preserved in the message for format conversion
      // vectorengine needs toolName to convert toolResult → functionResponse correctly
      const msgWithToolName = message as Extract<AgentMessage, { role: "toolResult" }> & { toolName?: string };
      if (toolName && !msgWithToolName.toolName) {
        msgWithToolName.toolName = toolName;
        log.debug(`[guard] Added toolName="${toolName}" to toolResult message (id=${id})`);
      }
      
      // P116: 截断过大的工具结果，防止 session 累积导致 token 爆炸
      truncateLargeToolResult(msgWithToolName, toolName);
      
      return originalAppend(
        persistToolResult(msgWithToolName, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }) as never,
      );
    }

    const toolCalls =
      role === "assistant"
        ? extractAssistantToolCalls(message as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || role !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const result = originalAppend(message as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
