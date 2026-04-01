/**
 * 消息标准化器 - 模仿 Claude Code 的 normalizeMessagesForAPI
 * 
 * 这是 API 调用前的最后一道防线，确保：
 * 1. 所有消息格式正确
 * 2. tool_use 和 tool_result 严格配对
 * 3. 没有孤立或重复的工具调用
 * 4. 内容经过适当净化
 * 
 * 参考：claude-code-source/src/utils/messages.ts
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// 日志接口
interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// 简单的默认日志器
const defaultLogger: Logger = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

/**
 * 标准化配置
 */
export interface NormalizeOptions {
  /** 是否启用严格模式（发现问题时抛出错误） */
  strict?: boolean;
  /** 是否净化工具调用参数（避免注入攻击） */
  sanitizeToolArgs?: boolean;
  /** 是否净化工具结果（移除可能的格式干扰） */
  sanitizeToolResults?: boolean;
  /** 孤立 tool_result 的处理方式 */
  orphanToolResultPolicy?: "drop" | "keep" | "error";
  /** 未配对 tool_use 的处理方式 */
  unpairedToolUsePolicy?: "add_fake_result" | "drop" | "error";
  /** 日志器 */
  logger?: Logger;
  /** 会话 ID（用于日志） */
  sessionId?: string;
}

/**
 * 标准化报告
 */
export interface NormalizeReport {
  /** 是否进行了修改 */
  changed: boolean;
  /** 移除的孤立 tool_result 数量 */
  droppedOrphanToolResults: number;
  /** 添加的假 tool_result 数量 */
  addedFakeToolResults: number;
  /** 移除的重复 tool_result 数量 */
  droppedDuplicateToolResults: number;
  /** 净化的工具参数数量 */
  sanitizedToolArgs: number;
  /** 净化的工具结果数量 */
  sanitizedToolResults: number;
  /** 发现的问题列表 */
  issues: string[];
}

/**
 * 从 assistant 消息中提取所有 tool_call ID
 */
function extractToolCallIds(msg: AgentMessage): Set<string> {
  const ids = new Set<string>();
  
  if (msg.role !== "assistant") return ids;
  
  // 检查 content 数组中的 toolCall/toolUse/functionCall blocks
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      const rec = block as { type?: unknown; id?: unknown };
      
      // 检测各种 tool_call 类型
      if (
        rec.type === "toolCall" ||
        rec.type === "toolUse" ||
        rec.type === "functionCall"
      ) {
        if (typeof rec.id === "string" && rec.id) {
          ids.add(rec.id);
        }
      }
    }
  }
  
  // 检查 tool_calls 数组（OpenAI 格式）
  const msgAny = msg as any;
  const toolCalls = msgAny.tool_calls || msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue;
      const id = call.id;
      if (typeof id === "string" && id) {
        ids.add(id);
      }
    }
  }
  
  return ids;
}

/**
 * 从 tool_result 消息中提取 tool_call_id
 * 支持 "toolResult" (pi-ai) 和 "tool" (OpenAI 格式) 两种 role
 */
function extractToolResultId(msg: AgentMessage): string | null {
  // 原始 pi-ai 格式
  if (msg.role === "toolResult") {
    const toolResult = msg as Extract<AgentMessage, { role: "toolResult" }>;
    return toolResult.toolCallId || null;
  }
  
  // 检查是否已被转换为 OpenAI 格式 (role: "tool")
  const msgAny= msg as any;
  if (msgAny.role === "tool") {
    const id =
      msgAny.tool_call_id ||
      msgAny.toolCallId ||
      msgAny.toolUseId ||
      msgAny.tool_use_id;
    return typeof id === "string" && id ? id : null;
  }
  
  return null;
}

/**
 * 净化工具调用参数（避免 JSON 注入）
 */
function sanitizeToolArguments(args: unknown): { sanitized: unknown; changed: boolean } {
  if (args === null || args === undefined) {
    return { sanitized: args, changed: false };
  }
  
  // 如果是字符串，确保是有效的 JSON
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      const reserialized = JSON.stringify(parsed);
      return {
        sanitized: reserialized,
        changed: reserialized !== args
      };
    } catch {
      // 如果解析失败，返回空对象
      return {
        sanitized: "{}",
        changed: true
      };
    }
  }
  
  // 如果是对象，确保可以序列化
  if (typeof args === "object") {
    try {
      const serialized = JSON.stringify(args);
      const parsed = JSON.parse(serialized);
      return {
        sanitized: parsed,
        changed: false
      };
    } catch {
      return {
        sanitized: {},
        changed: true
      };
    }
  }
  
  return { sanitized: args, changed: false };
}

/**
 * 净化工具结果内容（移除可能的格式干扰）
 */
function sanitizeToolResultContent(content: unknown): { sanitized: unknown; changed: boolean } {
  if (content === null || content === undefined) {
    return {
      sanitized: "[Tool returned no content]",
      changed: true
    };
  }
  
  // 字符串内容
  if (typeof content === "string") {
    // 移除可能导致格式问题的特殊标记
    let sanitized = content;
    
    // 移除可能的 markdown 代码块标记（避免模型误解）
    // 但保留内容本身
    const dangerousPatterns = [
      /^```[\w]*\n?/,
      /\n?```$/,
    ];
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(sanitized)) {
        // 只记录，不实际移除（因为可能是有意的内容）
        // sanitized = sanitized.replace(pattern, '');
      }
    }
    
    // 截断过长的内容（防止 token 溢出）
    const maxLength = 50000;
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength) + "\n...[content truncated]";
      return { sanitized, changed: true };
    }
    
    return { sanitized, changed: false };
  }
  
  // 数组内容
  if (Array.isArray(content)) {
    const sanitized = content.map(item => {
      if (!item || typeof item !== "object") return item;
      const rec = item as { type?: unknown; text?: unknown };
      if (rec.type === "text" && typeof rec.text === "string") {
        const { sanitized: text } = sanitizeToolResultContent(rec.text);
        return { ...rec, text };
      }
      return item;
    });
    
    return {
      sanitized,
      changed: JSON.stringify(sanitized) !== JSON.stringify(content)
    };
  }
  
  return { sanitized: content, changed: false };
}

/**
 * 创建假的 tool_result（用于未配对的 tool_use）
 */
function createFakeToolResult(toolCallId: string, toolName?: string): AgentMessage {
  // 使用 "toolResult" role (pi-ai 原生格式)
  // google.ts 会负责将其转换为 OpenAI 格式的 "tool"
  const msg: AgentMessage = {
    role: "toolResult",
    toolCallId: toolCallId,
    toolName: toolName || "unknown",
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: "Tool result missing from session history",
          tool: toolName || "unknown",
          note: "This is a synthetic result inserted by message normalizer"
        })
      }
    ],
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
  
  return msg;
}

/**
 * 标准化消息数组，确保 API 调用前的格式正确性
 * 
 * 这是模仿 Claude Code 的 normalizeMessagesForAPI 的核心函数
 */
export function normalizeMessagesForAPI(
  messages: AgentMessage[],
  options: NormalizeOptions = {}
): { messages: AgentMessage[]; report: NormalizeReport } {
  const logger = options.logger || defaultLogger;
  const sessionId = options.sessionId || "unknown";
  
  const report: NormalizeReport = {
    changed: false,
    droppedOrphanToolResults: 0,
    addedFakeToolResults: 0,
    droppedDuplicateToolResults: 0,
    sanitizedToolArgs: 0,
    sanitizedToolResults: 0,
    issues: [],
  };
  
  if (messages.length === 0) {
    return { messages, report };
  }
  
  const normalized: AgentMessage[] = [];
  const seenToolResultIds = new Set<string>();
  
  // 第一遍：跟踪所有未配对的 tool_use
  const pendingToolCalls = new Map<string, { index: number; toolName?: string }>();
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    
    if (!msg || typeof msg !== "object") {
      report.issues.push(`Message at index ${i} is not a valid object`);
      continue;
    }
    
    // 处理 assistant 消息
    if (msg.role === "assistant") {
      // 提取所有 tool_call IDs
      const toolCallIds = extractToolCallIds(msg);
      
      // 净化工具参数（如果启用）
      if (options.sanitizeToolArgs) {
        const msgAny = msg as any;
        if (Array.isArray(msgAny.content)) {
          let contentChanged = false;
          for (const block of msgAny.content) {
            if (!block || typeof block !== "object") continue;
            const rec = block as any;
            
            if (
              rec.type === "toolCall" ||
              rec.type === "toolUse" ||
              rec.type === "functionCall"
            ) {
              const { sanitized, changed } = sanitizeToolArguments(rec.arguments);
              if (changed) {
                rec.arguments = sanitized;
                report.sanitizedToolArgs++;
                contentChanged = true;
              }
            }
          }
          if (contentChanged) report.changed = true;
        }
      }
      
      normalized.push(msg);
      
      // 记录所有 tool_call，等待配对
      for (const id of toolCallIds) {
        pendingToolCalls.set(id, {
          index: normalized.length - 1,
          toolName: undefined // TODO: 从 block 中提取
        });
      }
      
      continue;
    }
    
    // 处理 tool_result 消息
    // 支持 "toolResult" (pi-ai) 和 "tool" (OpenAI 格式) 两种 role
    if (msg.role === "toolResult" || (msg as any).role === "tool") {
      const toolCallId = extractToolResultId(msg);
      
      // 没有有效的 tool_call_id
      if (!toolCallId) {
        const errorMsg = `Tool result at index ${i} has no valid tool_call_id`;
        report.issues.push(errorMsg);
        logger.warn(`[${sessionId}] ${errorMsg}`);
        
        if (options.strict) {
          throw new Error(errorMsg);
        }
        
        // 根据策略处理
        if (options.orphanToolResultPolicy === "drop") {
          report.droppedOrphanToolResults++;
          report.changed = true;
          continue;
        }
      }
      
      // 检查是否已存在（重复）
      if (toolCallId && seenToolResultIds.has(toolCallId)) {
        const errorMsg = `Duplicate tool result for id ${toolCallId} at index ${i}`;
        report.issues.push(errorMsg);
        logger.warn(`[${sessionId}] ${errorMsg}`);
        
        report.droppedDuplicateToolResults++;
        report.changed = true;
        continue;
      }
      
      // 记录已看到的 tool_result
      if (toolCallId) {
        seenToolResultIds.add(toolCallId);
        pendingToolCalls.delete(toolCallId);
      }
      
      // 净化工具结果（如果启用）
      if (options.sanitizeToolResults) {
        const msgAny = msg as any;
        const { sanitized, changed } = sanitizeToolResultContent(msgAny.content);
        if (changed) {
          msgAny.content = sanitized;
          report.sanitizedToolResults++;
          report.changed = true;
        }
      }
      
      normalized.push(msg);
      continue;
    }
    
    // 其他消息类型（user, system 等）
    normalized.push(msg);
  }
  
  // 第二遍：处理未配对的 tool_use
  if (pendingToolCalls.size > 0) {
    const errorMsg = `Found ${pendingToolCalls.size} unpaired tool_use(s)`;
    report.issues.push(errorMsg);
    logger.warn(`[${sessionId}] ${errorMsg}: ${Array.from(pendingToolCalls.keys()).join(", ")}`);
    
    if (options.unpairedToolUsePolicy === "add_fake_result") {
      // 添加假的 tool_result
      for (const [toolCallId, { toolName }] of pendingToolCalls) {
        const fakeResult = createFakeToolResult(toolCallId, toolName);
        normalized.push(fakeResult);
        report.addedFakeToolResults++;
        report.changed = true;
        logger.info(`[${sessionId}] Added fake tool_result for id ${toolCallId}`);
      }
    } else if (options.unpairedToolUsePolicy === "drop") {
      // TODO: 移除未配对的 tool_use（复杂操作，需要修改 assistant 消息）
      logger.warn(`[${sessionId}] Dropping unpaired tool_use is not implemented yet`);
    } else if (options.strict) {
      throw new Error(`Unpaired tool_use found: ${Array.from(pendingToolCalls.keys()).join(", ")}`);
    }
  }
  
  // 最终日志
  if (report.changed) {
    logger.info(
      `[${sessionId}] normalizeMessagesForAPI: changed=true, ` +
      `dropped=${report.droppedOrphanToolResults + report.droppedDuplicateToolResults}, ` +
      `added=${report.addedFakeToolResults}, ` +
      `sanitized=${report.sanitizedToolArgs + report.sanitizedToolResults}`
    );
  }
  
  return {
    messages: report.changed ? normalized : messages,
    report
  };
}

/**
 * 快速检查消息数组是否需要标准化
 */
export function needsNormalization(messages: AgentMessage[]): boolean {
 const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const id of extractToolCallIds(msg)) {
        toolCallIds.add(id);
      }
    } else if (msg.role === "toolResult" || (msg as any).role === "tool") {
      const id = extractToolResultId(msg);
      if (id) {
        if (toolResultIds.has(id)) {
          // 重复的 tool_result
          return true;
        }
        toolResultIds.add(id);
      } else {
        // 没有有效的 tool_call_id
        return true;
      }
    }
  }
  
  // 检查配对
  for (const id of toolCallIds) {
    if (!toolResultIds.has(id)) {
      // 未配对的 tool_use
      return true;
    }
  }
  
  return false;
}

/**
 * 默认导出：标准化函数
 */
export default normalizeMessagesForAPI;