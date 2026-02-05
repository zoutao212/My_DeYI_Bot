/**
 * 消息元数据类型定义
 * 
 * 用于标记消息的类型、版本、哈希等信息
 * 支持三层消息结构：系统上下文、对话历史、工具调用历史
 */

import { createHash } from "node:crypto";

/**
 * 消息类型
 */
export type MessageMetadataType =
  | "system-context"      // 系统上下文（SOUL.md, USER.md, 角色定义等）
  | "user-input"          // 用户真实输入
  | "assistant-reply"     // AI 回复
  | "tool-call"           // 工具调用
  | "tool-result";        // 工具结果

/**
 * 消息元数据
 */
export interface MessageMetadata {
  /** 消息类型 */
  type: MessageMetadataType;
  
  /** 版本号（用于检测系统上下文更新） */
  version?: string;
  
  /** 内容哈希（用于去重） */
  hash?: string;
  
  /** 是否已清理（移除了 Pipeline 前缀和重复内容） */
  stripped?: boolean;
  
  /** 提取来源（用于调试） */
  extractedFrom?: string;
  
  /** 时间戳 */
  timestamp?: number;
}

/**
 * 计算内容哈希
 */
export function computeContentHash(content: unknown): string {
  const json = JSON.stringify(content);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/**
 * 检查两个哈希是否相同
 */
export function isSameHash(hash1: string | undefined, hash2: string | undefined): boolean {
  if (!hash1 || !hash2) return false;
  return hash1 === hash2;
}

/**
 * 生成系统上下文版本号
 * 
 * 格式：v{year}{month}{day}_{hash}
 */
export function generateSystemContextVersion(content: unknown): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hash = computeContentHash(content).slice(0, 8);
  return `v${year}${month}${day}_${hash}`;
}
