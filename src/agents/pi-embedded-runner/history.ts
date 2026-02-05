import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

import type { ClawdbotConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 * 
 * NEW: Preserves the first user message (task goal) to prevent task loss in long conversations.
 * NEW: Default limit is 30 user turns if not specified (increased from 10).
 * NEW: Only counts user messages, excludes tool calls and tool results from the count.
 * NEW: Compresses tool call chains to reduce token usage.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  // 默认限制为 30 个用户轮次（如果未指定）
  const effectiveLimit = limit !== undefined && limit > 0 ? limit : 30;
  
  if (messages.length === 0) return messages;

  // Step 1: Extract task goal (first user message)
  const taskGoalIndex = messages.findIndex(m => m.role === "user");
  const taskGoal = taskGoalIndex >= 0 ? messages[taskGoalIndex] : null;

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > effectiveLimit) {
        // Step 2: If task goal would be discarded, preserve it
        const limited = messages.slice(lastUserIndex);
        
        // Step 3: Compress tool call chains in the limited messages
        const compressed = compressToolCallChains(limited);
        
        // Check if task goal is already in the compressed messages
        if (taskGoal && !compressed.some(m => m === taskGoal)) {
          // Only preserve task goal if it has content (user or assistant message)
          if ("content" in taskGoal && taskGoal.content !== undefined) {
            // Filter content to only include text and image (exclude thinking and tool calls)
            const filteredContent = Array.isArray(taskGoal.content)
              ? taskGoal.content.filter(
                  (item): item is TextContent | ImageContent =>
                    item.type === "text" || item.type === "image"
                )
              : [];
            
            // Create a new user message with the task goal content
            const taskGoalMessage: AgentMessage = {
              role: "user",
              content: [
                { type: "text", text: "[任务目标 - 保留自对话开始]\n" },
                ...filteredContent
              ],
              timestamp: taskGoal.timestamp
            };
            return [taskGoalMessage, ...compressed];
          }
        }
        
        return compressed;
      }
      lastUserIndex = i;
    }
  }
  
  // Step 3: Compress tool call chains in all messages
  return compressToolCallChains(messages);
}

/**
 * Compresses tool call chains to reduce token usage.
 * 
 * Converts:
 *   assistant: [toolCall: read file.txt]
 *   toolResult: [content of file.txt]
 *   assistant: [text response]
 * 
 * Into:
 *   assistant: [text: "读取了文件 file.txt:\n{content}"]
 *   assistant: [text response]
 */
function compressToolCallChains(messages: AgentMessage[]): AgentMessage[] {
  const compressed: AgentMessage[] = [];
  let i = 0;
  
  while (i < messages.length) {
    const msg = messages[i];
    
    // Check if this is an assistant message with tool calls
    if (msg.role === "assistant" && "content" in msg && Array.isArray(msg.content)) {
      const hasToolCalls = msg.content.some(
        (block: any) => block.type === "toolCall" || block.type === "toolUse" || block.type === "functionCall"
      );
      
      if (hasToolCalls) {
        // Find all tool results that follow this message
        const toolResults: AgentMessage[] = [];
        let j = i + 1;
        
        while (j < messages.length && messages[j].role === "toolResult") {
          toolResults.push(messages[j]);
          j++;
        }
        
        // Compress the tool call chain into a single assistant message
        const compressedMessage = compressToolCallChain(msg, toolResults);
        if (compressedMessage) {
          compressed.push(compressedMessage);
        }
        
        // Skip the tool result messages
        i = j;
        continue;
      }
    }
    
    // Keep other messages as-is
    compressed.push(msg);
    i++;
  }
  
  return compressed;
}

/**
 * Compresses a single tool call chain into a natural language description.
 */
function compressToolCallChain(
  assistantMsg: AgentMessage,
  toolResults: AgentMessage[]
): AgentMessage | null {
  if (!("content" in assistantMsg) || !Array.isArray(assistantMsg.content)) return assistantMsg;
  
  const compressedContent: TextContent[] = [];
  
  // Extract tool calls from the assistant message
  for (const block of assistantMsg.content) {
    if (!block || typeof block !== "object") continue;
    
    const toolCall = block as any;
    if (toolCall.type !== "toolCall" && toolCall.type !== "toolUse" && toolCall.type !== "functionCall") {
      continue;
    }
    
    const toolName = toolCall.name || "unknown";
    const toolId = toolCall.id;
    
    // Find the corresponding tool result
    const toolResult = toolResults.find((tr: any) => {
      return tr.toolCallId === toolId || tr.toolUseId === toolId;
    });
    
    if (!toolResult || !("content" in toolResult)) continue;
    
    // Extract the result content
    let resultText = "";
    if (typeof toolResult.content === "string") {
      resultText = toolResult.content;
    } else if (Array.isArray(toolResult.content)) {
      for (const item of toolResult.content) {
        if (item && typeof item === "object" && "text" in item) {
          resultText += item.text;
        }
      }
    }
    
    // Compress based on tool name
    let compressedText = "";
    
    if (toolName === "read") {
      // For read tool, keep the file content but add a brief description
      const path = (toolCall.arguments as any)?.path || "unknown";
      const fileName = path.split(/[/\\]/).pop() || path;
      compressedText = `[读取文件: ${fileName}]\n${resultText}`;
    } else if (toolName === "exec") {
      // For exec tool, keep the output but add a brief description
      const command = (toolCall.arguments as any)?.command || "unknown";
      const shortCommand = command.length > 50 ? command.slice(0, 50) + "..." : command;
      compressedText = `[执行命令: ${shortCommand}]\n${resultText}`;
    } else if (toolName === "grep" || toolName === "find" || toolName === "ls") {
      // For search tools, keep the results
      compressedText = `[搜索结果]\n${resultText}`;
    } else if (toolName === "write" || toolName === "edit") {
      // For write/edit tools, just keep a brief description
      const path = (toolCall.arguments as any)?.path || "unknown";
      const fileName = path.split(/[/\\]/).pop() || path;
      compressedText = `[已写入文件: ${fileName}]`;
    } else if (toolName === "enqueue_task") {
      // For enqueue_task, keep a brief description
      const summary = (toolCall.arguments as any)?.summary || "unknown";
      compressedText = `[已加入任务: ${summary}]`;
    } else {
      // For other tools, keep the result as-is
      compressedText = `[工具: ${toolName}]\n${resultText}`;
    }
    
    // Limit the length of the compressed text
    if (compressedText.length > 10000) {
      compressedText = compressedText.slice(0, 10000) + "\n...(内容过长，已截断)";
    }
    
    compressedContent.push({
      type: "text",
      text: compressedText
    });
  }
  
  // If no tool calls were found, return the original message
  if (compressedContent.length === 0) {
    return assistantMsg;
  }
  
  // Return a new assistant message with compressed content
  // Note: We need to preserve the required fields from the original assistant message
  if (assistantMsg.role === "assistant") {
    return {
      ...assistantMsg,
      content: compressedContent
    };
  }
  
  return assistantMsg;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 */
export function getDmHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: ClawdbotConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) return undefined;

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = providerParts[0]?.toLowerCase();
  if (!provider) return undefined;

  const kind = providerParts[1]?.toLowerCase();
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);
  if (kind !== "dm") return undefined;

  const getLimit = (
    providerConfig:
      | {
          dmHistoryLimit?: number;
          dms?: Record<string, { historyLimit?: number }>;
        }
      | undefined,
  ): number | undefined => {
    if (!providerConfig) return undefined;
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  };

  const resolveProviderConfig = (
    cfg: ClawdbotConfig | undefined,
    providerId: string,
  ): { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> } | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") return undefined;
    const entry = (channels as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    return entry as { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> };
  };

  return getLimit(resolveProviderConfig(config, provider));
}
