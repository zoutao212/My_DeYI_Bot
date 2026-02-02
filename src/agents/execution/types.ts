/**
 * 执行层类型定义
 * 
 * 定义执行层的核心接口和类型
 */

/**
 * 执行请求
 */
export interface ExecutionRequest {
  /** 执行类型（tool 或 skill） */
  type: "tool" | "skill";
  /** 工具或技能名称 */
  name: string;
  /** 参数 */
  parameters: Record<string, unknown>;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 上下文信息 */
  context?: Record<string, unknown>;
}

/**
 * 执行响应
 */
export interface ExecutionResponse {
  /** 执行状态 */
  status: "success" | "error" | "timeout" | "cancelled";
  /** 执行结果 */
  result?: unknown;
  /** 错误信息 */
  error?: ExecutionError;
  /** 执行耗时（毫秒） */
  duration: number;
  /** 执行时间戳 */
  timestamp: number;
}

/**
 * 执行错误
 */
export interface ExecutionError {
  /** 错误类型 */
  type:
    | "tool_not_found"
    | "skill_not_found"
    | "validation_error"
    | "timeout_error"
    | "permission_error"
    | "execution_error";
  /** 错误消息 */
  message: string;
  /** 错误详情 */
  details?: unknown;
  /** 错误堆栈 */
  stack?: string;
  /** 恢复建议 */
  suggestion?: string;
}

/**
 * 执行配置
 */
export interface ExecutionConfig {
  /** 默认超时时间（毫秒） */
  defaultTimeout?: number;
  /** 是否启用日志 */
  enableLogging?: boolean;
  /** 日志级别 */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** 是否启用性能监控 */
  enableMetrics?: boolean;
  /** 最大并发执行数 */
  maxConcurrent?: number;
}

/**
 * 执行器接口
 */
export interface IExecutor {
  /**
   * 执行请求
   */
  execute(request: ExecutionRequest): Promise<ExecutionResponse>;

  /**
   * 取消执行
   */
  cancel?(executionId: string): Promise<void>;

  /**
   * 获取执行状态
   */
  getStatus?(executionId: string): Promise<ExecutionResponse | null>;
}

/**
 * 执行监控指标
 */
export interface ExecutionMetrics {
  /** 总执行次数 */
  totalExecutions: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  errorCount: number;
  /** 超时次数 */
  timeoutCount: number;
  /** 取消次数 */
  cancelledCount: number;
  /** 平均执行时间（毫秒） */
  averageDuration: number;
  /** 最大执行时间（毫秒） */
  maxDuration: number;
  /** 最小执行时间（毫秒） */
  minDuration: number;
}
