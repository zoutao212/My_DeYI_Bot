/**
 * 多层 Agent 架构的核心类型定义
 * 
 * 本文件定义了多层架构中各层之间通信所需的接口和类型。
 */

// 重新导出 AgentLayer 类型
export type { AgentLayer } from './layer-resolver.js';
import type { AgentLayer } from './layer-resolver.js';

// 导入记忆系统类型
import type { MemoryItem } from '../memory/types.js';

/**
 * 任务委托请求
 * 
 * 管家层使用此接口将任务委托给任务调度层
 */
export interface TaskDelegationRequest {
  /** 任务 ID，用于跟踪任务 */
  taskId: string;
  
  /** 任务类型 */
  taskType: 'simple' | 'complex' | 'skill';
  
  /** 任务描述 */
  description: string;
  
  /** 任务上下文（可选） */
  context?: Record<string, unknown>;
  
  /** 任务约束条件（可选） */
  constraints?: {
    /** 最大执行时间（毫秒） */
    maxExecutionTime?: number;
    /** 最大重试次数 */
    maxRetries?: number;
    /** 优先级 */
    priority?: 'low' | 'normal' | 'high';
  };
  
  /** 进度回调函数（可选） */
  onProgress?: (progress: TaskProgress) => void;
}

/**
 * 任务委托响应
 * 
 * 任务调度层返回给管家层的响应
 */
export interface TaskDelegationResponse {
  /** 任务 ID */
  taskId: string;
  
  /** 任务状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
  
  /** 任务结果（如果已完成） */
  result?: unknown;
  
  /** 错误信息（如果失败） */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  
  /** 执行时间（毫秒） */
  executionTime?: number;
}

/**
 * 任务进度信息
 * 
 * 用于报告任务执行进度
 */
export interface TaskProgress {
  /** 任务 ID */
  taskId: string;
  
  /** 进度百分比（0-100） */
  percentage: number;
  
  /** 当前状态描述 */
  status: string;
  
  /** 当前步骤（可选） */
  currentStep?: string;
  
  /** 总步骤数（可选） */
  totalSteps?: number;
  
  /** 已完成步骤数（可选） */
  completedSteps?: number;
}

/**
 * 层次上下文
 * 
 * 在层次之间传递的上下文信息
 */
export interface LayerContext {
  /** 当前层次 */
  currentLayer: AgentLayer;
  
  /** 上一层次（如果有） */
  previousLayer?: AgentLayer;
  
  /** 会话 ID */
  sessionId: string;
  
  /** 用户 ID */
  userId: string;
  
  /** 额外的上下文数据 */
  data?: Record<string, unknown>;
}

/**
 * 层次切换请求
 * 
 * 用于请求切换到另一个层次
 */
export interface LayerSwitchRequest {
  /** 目标层次 */
  targetLayer: AgentLayer;
  
  /** 切换原因 */
  reason: string;
  
  /** 传递给目标层次的数据 */
  data?: Record<string, unknown>;
}

/**
 * 层次切换响应
 * 
 * 层次切换的结果
 */
export interface LayerSwitchResponse {
  /** 是否成功切换 */
  success: boolean;
  
  /** 当前层次 */
  currentLayer: AgentLayer;
  
  /** 错误信息（如果失败） */
  error?: string;
}

/**
 * 对话上下文
 * 
 * 包含对话历史和相关元数据
 */
export interface ConversationContext {
  /** 会话 ID */
  sessionId: string;
  
  /** 用户 ID */
  userId: string;
  
  /** 对话历史 */
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: number;
  }>;
  
  /** 检索到的相关记忆（可选） */
  memories?: MemoryItem[];
  
  /** 格式化的记忆上下文（可选，可直接注入 System Prompt） */
  memoryContext?: string;
  
  /** 额外的上下文数据 */
  metadata?: Record<string, unknown>;
}
