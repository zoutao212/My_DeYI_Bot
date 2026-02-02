/**
 * 记忆系统集成 - 类型定义
 * 
 * 定义记忆服务的核心类型和接口
 * 
 * @module agents/memory/types
 */

import type { SessionSummary } from "../session-summary.js";

/**
 * 记忆服务配置
 */
export interface MemoryServiceConfig {
  /** 检索配置 */
  retrieval: {
    /** 最大结果数 */
    maxResults: number;
    /** 最小相关性分数 (0-1) */
    minScore: number;
    /** 检索来源 */
    sources: ("memory" | "sessions")[];
    /** 检索超时（毫秒） */
    timeoutMs: number;
  };
  /** 归档配置 */
  archival: {
    /** 归档策略 */
    strategy: "always" | "on-demand" | "threshold";
    /** 归档路径 */
    path: string;
    /** 归档格式 */
    format: "markdown" | "json";
    /** 归档频率（轮数） */
    frequency: number;
  };
}

/**
 * 记忆检索请求
 */
export interface MemoryRetrievalRequest {
  /** 查询文本 */
  query: string;
  /** 上下文信息 */
  context: {
    /** 用户 ID */
    userId: string;
    /** 会话 ID */
    sessionId: string;
    /** Agent ID（可选） */
    agentId?: string;
    /** 层级（可选） */
    layer?: "virtual-world" | "butler" | "execution";
  };
  /** 检索参数（可选，覆盖默认配置） */
  params?: {
    /** 最大结果数 */
    maxResults?: number;
    /** 最小相关性分数 */
    minScore?: number;
    /** 检索来源 */
    sources?: ("memory" | "sessions")[];
  };
}

/**
 * 记忆检索结果中的单条记忆
 */
export interface MemoryItem {
  /** 文件路径 */
  path: string;
  /** 内容片段 */
  snippet: string;
  /** 相关性分数 (0-1) */
  score: number;
  /** 来源 */
  source: "memory" | "sessions";
  /** 时间戳（可选） */
  timestamp?: number;
  /** 起始行 */
  startLine: number;
  /** 结束行 */
  endLine: number;
}

/**
 * 记忆检索结果
 */
export interface MemoryRetrievalResult {
  /** 检索到的记忆列表 */
  memories: MemoryItem[];
  /** 格式化的上下文（可直接注入 System Prompt） */
  formattedContext: string;
  /** 检索耗时（毫秒） */
  durationMs: number;
}

/**
 * 记忆归档请求
 */
export interface MemoryArchivalRequest {
  /** 会话总结 */
  summary: SessionSummary;
  /** 上下文信息 */
  context: {
    /** 用户 ID */
    userId: string;
    /** 会话 ID */
    sessionId: string;
    /** Agent ID（可选） */
    agentId?: string;
  };
  /** 归档参数（可选，覆盖默认配置） */
  params?: {
    /** 归档路径 */
    path?: string;
    /** 归档格式 */
    format?: "markdown" | "json";
  };
}

/**
 * 记忆归档结果
 */
export interface MemoryArchivalResult {
  /** 归档文件路径 */
  path: string;
  /** 归档是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
  /** 归档耗时（毫秒） */
  durationMs: number;
}

/**
 * 记忆服务状态
 */
export interface MemoryServiceStatus {
  /** 记忆服务是否启用 */
  enabled: boolean;
  /** 检索功能状态 */
  retrieval: {
    /** 是否启用 */
    enabled: boolean;
    /** 是否可用 */
    available: boolean;
  };
  /** 归档功能状态 */
  archival: {
    /** 是否启用 */
    enabled: boolean;
    /** 是否可用 */
    available: boolean;
  };
}

/**
 * 记忆服务接口
 * 
 * 提供统一的记忆检索和归档功能
 */
export interface IMemoryService {
  /**
   * 检索相关记忆
   * 
   * @param request - 检索请求
   * @returns 检索结果
   */
  retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult>;

  /**
   * 归档会话总结
   * 
   * @param request - 归档请求
   * @returns 归档结果
   */
  archive(request: MemoryArchivalRequest): Promise<MemoryArchivalResult>;

  /**
   * 获取记忆服务状态
   * 
   * @returns 服务状态
   */
  status(): MemoryServiceStatus;
}
