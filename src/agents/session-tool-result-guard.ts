import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { makeMissingToolResult } from "./session-transcript-repair.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

const log = createSubsystemLogger("agent/guard");

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
  },
): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();

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

    // 🔧 Fix: Normalize assistant messages with null content (OpenAI API requirement)
    // This ensures content is never saved as null to the session
    if (role === "assistant") {
      const msg = message as Extract<AgentMessage, { role: "assistant" }>;
      const contentType = msg.content === null ? "null" : msg.content === undefined ? "undefined" : Array.isArray(msg.content) ? `array(${msg.content.length})` : typeof msg.content;
      log.info(`[guard] appendMessage called: role=assistant, content=${contentType}`);
      
      // 🆕 DEBUG: Log full message structure to see what API returned
      log.info(`[guard] [DEBUG] Full assistant message: ${JSON.stringify(msg, null, 2).slice(0, 2000)}`);
      
      // 🔧 Fix: Remove provider-specific signature fields from assistant messages before saving
      // Some providers (like yinli) return signature fields in responses, but may reject them in requests
      // We need to remove them from saved messages to prevent errors in subsequent requests
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
        msg.content = [] as never; // Empty array for assistant messages with only tool_calls
        log.info(`[guard] ✓ Fixed assistant.content: null → [] before saving to session`);
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
      return originalAppend(
        persistToolResult(message, {
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
