/**
 * 系统上下文提取器
 * 
 * 从历史消息中提取系统上下文（SOUL.md, USER.md, 角色定义等）
 * 并将其分离到独立的 system message
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  computeContentHash,
  generateSystemContextVersion,
  type MessageMetadata,
} from "./message-metadata.js";

const log = createSubsystemLogger("system-context-extractor");

/**
 * 系统提示词模式
 * 
 * 用于检测用户消息中是否包含系统提示词
 * 
 * 包括：
 * - 角色定义（SOUL.md, USER.md, 角色设定）
 * - 工具定义（## 工具定义, ## Available Tools）
 * - Skills 定义（## Skills, ## 技能）
 * - 上下文文件（## 上下文文件, ## Context Files）
 * - 运行时信息（## 运行时信息, ## Runtime Info）
 * - 记忆系统（## 记忆检索, ## Memory Recall）
 * - 任务分解（## 任务分解, ## Task Decomposition）
 */
const SYSTEM_PROMPT_PATTERNS = [
  // 角色定义
  /【系统人物卡/,
  /SOUL\.md/,
  /USER\.md/,
  /## 角色设定/,
  /# 角色设定/,
  /## User Identity/,
  /## 用户身份/,
  
  // 工具定义
  /## 工具定义/,
  /## Available Tools/,
  /## Tooling/,
  
  // Skills 定义
  /## Skills/,
  /## 技能/,
  /## Workspace Skills/,
  
  // 上下文文件
  /## 上下文文件/,
  /## Context Files/,
  /## Bootstrap Files/,
  
  // 运行时信息
  /## 运行时信息/,
  /## Runtime Info/,
  /## System Information/,
  
  // 记忆系统
  /## 记忆检索/,
  /## Memory Recall/,
  
  // 任务分解
  /## 任务分解/,
  /## Task Decomposition/,
  
  // 消息系统
  /## Messaging/,
  /## 消息发送/,
  
  // 时间信息
  /## Current Date & Time/,
  /## 当前日期与时间/,
];

/**
 * 检查文本是否是系统提示词
 */
function isSystemPrompt(text: string): boolean {
  return SYSTEM_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 从用户消息中提取系统上下文
 * 
 * 注意：由于 AgentMessage 类型限制，我们不直接创建 system message
 * 而是返回提取的系统上下文内容，由调用者决定如何处理
 * 
 * @param messages - 历史消息列表
 * @returns 提取的系统上下文内容和清理后的消息
 */
export function extractSystemContext(messages: AgentMessage[]): {
  systemContextContent: string | null;
  systemContextMetadata: MessageMetadata | null;
  cleanedMessages: AgentMessage[];
} {
  // 查找第一条用户消息
  const firstUserIndex = messages.findIndex((m) => m.role === "user");
  if (firstUserIndex === -1) {
    return { systemContextContent: null, systemContextMetadata: null, cleanedMessages: messages };
  }

  const firstUser = messages[firstUserIndex];
  
  // 类型守卫：确保是用户消息
  if (firstUser.role !== "user") {
    return { systemContextContent: null, systemContextMetadata: null, cleanedMessages: messages };
  }
  
  if (!Array.isArray(firstUser.content)) {
    return { systemContextContent: null, systemContextMetadata: null, cleanedMessages: messages };
  }

  // 分离系统上下文和用户输入
  const systemBlocks: string[] = [];
  const userBlocks: Array<{ type: "text"; text: string }> = [];

  for (const block of firstUser.content) {
    if (block.type === "text" && typeof block.text === "string") {
      // 检测是否是系统提示词
      if (isSystemPrompt(block.text)) {
        systemBlocks.push(block.text);
      } else {
        userBlocks.push({ type: "text", text: block.text });
      }
    } else {
      // 非文本块保留在用户消息中
      if (block.type === "text" && block.text) {
        userBlocks.push({ type: "text", text: block.text });
      }
    }
  }

  // 如果没有系统上下文，直接返回
  if (systemBlocks.length === 0) {
    return { systemContextContent: null, systemContextMetadata: null, cleanedMessages: messages };
  }

  // 创建系统上下文内容
  const systemContent = systemBlocks.join("\n\n");
  const systemHash = computeContentHash(systemContent);
  const systemVersion = generateSystemContextVersion(systemContent);

  const metadata: MessageMetadata = {
    type: "system-context",
    version: systemVersion,
    hash: systemHash,
    extractedFrom: "first-user-message",
    timestamp: Date.now(),
  };

  // 更新第一条用户消息，移除系统上下文
  const cleanedMessages = [...messages];
  
  // 如果清理后没有用户输入，保留一个占位符（避免第一条消息变成 assistant）
  // 这样可以防止 sanitizeGoogleTurnOrdering 插入 bootstrap 标记
  const cleanedContent = userBlocks.length > 0 
    ? userBlocks 
    : [{ type: "text" as const, text: "(context extracted)" }];
  
  cleanedMessages[firstUserIndex] = {
    ...firstUser,
    content: cleanedContent,
  };

  log.info(
    `[extractSystemContext] Extracted system context: version=${systemVersion}, hash=${systemHash}, blocks=${systemBlocks.length}`,
  );

  return { systemContextContent: systemContent, systemContextMetadata: metadata, cleanedMessages };
}

/**
 * 检查是否已经有系统上下文（存储在 SessionManager 的 custom entry 中）
 */
export function hasSystemContextInSession(sessionManager: { getEntries: () => unknown[] }): boolean {
  try {
    const entries = sessionManager.getEntries();
    return entries.some((entry) => {
      const customEntry = entry as { type?: string; customType?: string };
      return customEntry.type === "custom" && customEntry.customType === "system-context";
    });
  } catch {
    return false;
  }
}

/**
 * 从 SessionManager 获取系统上下文
 */
export function getSystemContextFromSession(sessionManager: {
  getEntries: () => unknown[];
}): { content: string; metadata: MessageMetadata } | null {
  try {
    const entries = sessionManager.getEntries();
    const contextEntry = entries.find((entry) => {
      const customEntry = entry as { type?: string; customType?: string };
      return customEntry.type === "custom" && customEntry.customType === "system-context";
    });
    
    if (!contextEntry) return null;
    
    const data = (contextEntry as { data?: { content?: string; metadata?: MessageMetadata } }).data;
    if (!data || !data.content || !data.metadata) return null;
    
    return { content: data.content, metadata: data.metadata };
  } catch {
    return null;
  }
}

/**
 * 将系统上下文保存到 SessionManager
 */
export function saveSystemContextToSession(
  sessionManager: { appendCustomEntry: (type: string, data: unknown) => void },
  content: string,
  metadata: MessageMetadata,
): void {
  try {
    sessionManager.appendCustomEntry("system-context", {
      content,
      metadata,
    });
    log.info(`[saveSystemContextToSession] Saved system context: version=${metadata.version}`);
  } catch (error) {
    log.error(`[saveSystemContextToSession] Failed to save system context:`, error as Record<string, unknown>);
  }
}

/**
 * 检查系统上下文是否需要更新
 * 
 * @param existingMessage - 现有的系统上下文消息
 * @param newContent - 新的系统上下文内容
 * @returns 是否需要更新
 */
export function shouldUpdateSystemContext(
  existingMessage: AgentMessage,
  newContent: string,
): boolean {
  const existingMetadata = (existingMessage as { metadata?: MessageMetadata }).metadata;
  if (!existingMetadata) return true;

  const newHash = computeContentHash(newContent);
  return existingMetadata.hash !== newHash;
}
