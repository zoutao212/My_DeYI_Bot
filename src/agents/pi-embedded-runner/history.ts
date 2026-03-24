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
 * 🆕 V3: 修复 OpenAI API 格式问题
 * - 保持 assistant + tool 消息的独立结构（API 要求）
 * - 仅压缩 tool result 的 content 长度，不合并消息
 * - 最近 2 个 user turn 内的 tool result: 完整保留（≤5000 字符）
 * - 3-5 个 user turn 前: 截断到 500 字符
 * - 5+ 个 user turn 前: 截断到 200 字符（仅工具名+状态摘要）
 * 
 * 这是解决长对话 tool call 膨胀的核心策略：
 * 旧的 tool 输出对 LLM 理解当前任务几乎无用，但会占满上下文窗口。
 */
function compressToolCallChains(messages: AgentMessage[]): AgentMessage[] {
  // 快速检查：如果没有任何 tool call 链，直接返回原始引用（避免无谓的对象创建）
  // 🆕 V3: 同时检查 toolResult 和 tool（OpenAI 格式）
  const hasAnyToolChain = messages.some((msg, idx) => {
    if (msg.role !== "assistant" || !("content" in msg) || !Array.isArray(msg.content)) return false;
    const hasToolCalls = msg.content.some(
      (block: any) => block.type === "toolCall" || block.type === "toolUse" || block.type === "functionCall",
    );
    if (!hasToolCalls) return false;
    // 确认后面跟着 toolResult 或 tool（OpenAI 格式）
    const nextRole = idx + 1 < messages.length ? (messages[idx + 1] as any).role : null;
    return nextRole === "toolResult" || nextRole === "tool";
  });
  if (!hasAnyToolChain) return messages;

  // Step 1: 计算每条消息距末尾的 user turn 年龄
  const ageMap = computeUserTurnAge(messages);
  
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
        // 首先保留 assistant 消息（不修改）
        compressed.push(msg);
        
        // Find all tool results that follow this message
        // 🆕 V3: 同时支持 toolResult（内部格式）和 tool（OpenAI 格式）
        let j = i + 1;
        
        while (j < messages.length) {
          const nextRole = (messages[j] as any).role;
          if (nextRole !== "toolResult" && nextRole !== "tool") break;
          
          const toolResult = messages[j];
          
          // 基于年龄决定压缩程度
          const age = ageMap.get(j) ?? 999;
          const maxChars = resolveMaxCharsForAge(age);
          
          // 压缩单个 tool result（保持独立消息）
          const compressedToolResult = compressSingleToolResult(toolResult, maxChars);
          compressed.push(compressedToolResult);
          
          j++;
        }
        
        // 移动到 tool results 之后
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
 * 计算每条消息距离末尾的 user turn 年龄
 * 返回 Map<消息索引, 年龄>，年龄 = 从该消息到末尾经过了多少个 user turn
 */
function computeUserTurnAge(messages: AgentMessage[]): Map<number, number> {
  const ageMap = new Map<number, number>();
  let userTurnCount = 0;
  
  // 从末尾反向遍历
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnCount++;
    }
    ageMap.set(i, userTurnCount);
  }
  
  return ageMap;
}

/**
 * 根据年龄决定 tool result 的最大保留字符数
 * 
 * 策略：
 * - 年龄 0-2（最近 2 个 user turn）: 5000 字符（充裕但有上限）
 * - 年龄 3-5: 500 字符（只保留关键摘要）
 * - 年龄 6+: 200 字符（最小化，仅保留工具名和执行状态）
 */
function resolveMaxCharsForAge(age: number): number {
  if (age <= 2) return 5000;
  if (age <= 5) return 500;
  return 200;
}

/**
 * 压缩单个 tool result 消息（保持独立结构，不合并到 assistant）
 * 
 * @param maxChars 基于年龄的最大字符数限制，越旧的消息限制越小
 */
function compressSingleToolResult(
  toolResult: AgentMessage,
  maxChars: number
): AgentMessage {
  if (!("content" in toolResult) || !toolResult.content) {
    return toolResult;
  }
  
  // Extract the result content
  let resultText = "";
  if (typeof toolResult.content === "string") {
    resultText = toolResult.content;
  } else if (Array.isArray(toolResult.content)) {
    for (const item of toolResult.content) {
      if (item && typeof item === "object" && "text" in item) {
        resultText += (item as any).text;
      }
    }
  }
  
  // 🆕 尝试从 JSON 包装中提取纯文本
  if (resultText.startsWith("{") && resultText.includes('"result"')) {
    try {
      const parsed = JSON.parse(resultText);
      if (typeof parsed.result === "string") {
        resultText = parsed.result;
      }
    } catch {
      // 不是 JSON，保持原样
    }
  }
  
  // 获取 tool name
  const toolName = (toolResult as any).toolName || "unknown";
  
  // 如果内容在限制内，直接返回
  if (resultText.length <= maxChars) {
    return toolResult;
  }
  
  // 根据工具类型生成压缩后的摘要
  let compressedText = "";
  
  if (toolName === "read") {
    if (maxChars <= 200) {
      compressedText = `[文件读取完成，${resultText.length} 字符]`;
    } else {
      const headLen = Math.floor(maxChars * 0.7);
      const tailLen = Math.floor(maxChars * 0.2);
      compressedText = resultText.substring(0, headLen) 
        + `\n...(已截断，原始 ${resultText.length} 字符)\n`
        + resultText.substring(resultText.length - tailLen);
    }
  } else if (toolName === "exec") {
    if (maxChars <= 200) {
      compressedText = `[命令执行完成，输出 ${resultText.length} 字符]`;
    } else {
      const headLen = Math.floor(maxChars * 0.7);
      const tailLen = Math.floor(maxChars * 0.2);
      compressedText = resultText.substring(0, headLen) 
        + `\n...(输出已截断，原始 ${resultText.length} 字符)\n`
        + resultText.substring(resultText.length - tailLen);
    }
  } else {
    // 其他工具
    if (maxChars <= 200) {
      compressedText = `[${toolName}: 已完成，${resultText.length} 字符]`;
    } else {
      const headLen = Math.floor(maxChars * 0.7);
      const tailLen = Math.floor(maxChars * 0.2);
      compressedText = resultText.substring(0, headLen) 
        + `\n...(已截断，原始 ${resultText.length} 字符)\n`
        + resultText.substring(resultText.length - tailLen);
    }
  }
  
  // 返回压缩后的 tool result（保持 role: "toolResult"）
  // 使用类型断言确保 TypeScript 正确识别类型
  return {
    ...toolResult,
    content: [{ type: "text" as const, text: compressedText }]
  } as AgentMessage;
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
