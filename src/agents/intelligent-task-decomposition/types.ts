/**
 * 智能任务分解系统 - 核心数据类型
 * 
 * 定义任务树、子任务、检查点、失败日志、错误日志等核心数据结构
 */

/**
 * 任务树
 * 
 * 表示一个完整的任务分解树，包含根任务和所有子任务
 */
export interface TaskTree {
  /** 任务树 ID（通常是 sessionId） */
  id: string;
  
  /** 根任务描述 */
  rootTask: string;
  
  /** 所有子任务 */
  subTasks: SubTask[];
  
  /** 任务树状态 */
  status: "pending" | "active" | "completed" | "failed";
  
  /** 创建时间戳 */
  createdAt: number;
  
  /** 更新时间戳 */
  updatedAt: number;
  
  /** 检查点 ID 列表 */
  checkpoints: string[];
}

/**
 * 子任务
 * 
 * 表示任务树中的一个子任务
 */
export interface SubTask {
  /** 子任务 ID */
  id: string;
  
  /** 任务提示词 */
  prompt: string;
  
  /** 任务简短描述 */
  summary: string;
  
  /** 任务状态 */
  status: "pending" | "active" | "completed" | "failed" | "interrupted";
  
  /** 任务输出 */
  output?: string;
  
  /** 错误信息 */
  error?: string;
  
  /** 重试次数 */
  retryCount: number;
  
  /** 创建时间戳 */
  createdAt: number;
  
  /** 完成时间戳 */
  completedAt?: number;
}

/**
 * 检查点
 * 
 * 表示任务树的一个快照，用于恢复
 */
export interface Checkpoint {
  /** 检查点 ID */
  id: string;
  
  /** 任务树快照 */
  taskTree: TaskTree;
  
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 失败日志
 * 
 * 记录子任务的失败信息
 */
export interface FailureLog {
  /** 子任务 ID */
  subTaskId: string;
  
  /** 错误信息 */
  error: string;
  
  /** 堆栈跟踪 */
  stackTrace: string;
  
  /** 重试次数 */
  retryCount: number;
  
  /** 时间戳 */
  timestamp: number;
}

/**
 * 错误日志
 * 
 * 记录系统级别的错误信息
 */
export interface ErrorLog {
  /** 错误类型 */
  errorType: "llm_request_failed" | "file_system_failed" | "out_of_memory" | "system_crash";
  
  /** 错误信息 */
  error: string;
  
  /** 堆栈跟踪 */
  stackTrace: string;
  
  /** 上下文信息 */
  context: Record<string, unknown>;
  
  /** 时间戳 */
  timestamp: number;
}
