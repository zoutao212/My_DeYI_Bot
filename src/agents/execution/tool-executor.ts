/**
 * 工具执行器
 * 
 * 封装现有的工具系统，提供统一的执行接口
 */

import type {
  ExecutionRequest,
  ExecutionResponse,
  ExecutionError,
  ExecutionConfig,
  IExecutor,
} from "./types.js";

/**
 * 工具调用器接口（简化版）
 */
export interface ToolCaller {
  call(toolName: string, parameters: Record<string, unknown>): Promise<unknown>;
}

/**
 * 工具执行器
 */
export class ToolExecutor implements IExecutor {
  private config: ExecutionConfig;
  private metrics: Map<string, number[]> = new Map();

  constructor(
    private toolCaller: ToolCaller,
    config?: ExecutionConfig,
  ) {
    this.config = {
      defaultTimeout: 30000, // 30 秒
      enableLogging: true,
      logLevel: "info",
      enableMetrics: true,
      maxConcurrent: 20,
      ...config,
    };
  }

  /**
   * 执行工具调用
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
    const startTime = Date.now();

    try {
      // 1. 验证请求
      this.validateRequest(request);

      // 2. 设置超时
      const timeout = request.timeout || this.config.defaultTimeout || 30000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(this.createTimeoutError(request.name, timeout));
        }, timeout);
      });

      // 3. 执行工具调用
      const executionPromise = this.toolCaller.call(request.name, request.parameters);

      // 4. 等待结果或超时
      const result = await Promise.race([executionPromise, timeoutPromise]);

      // 5. 记录指标
      const duration = Date.now() - startTime;
      this.recordMetrics(request.name, duration, "success");

      // 6. 返回成功响应
      return {
        status: "success",
        result,
        duration,
        timestamp: Date.now(),
      };
    } catch (error) {
      // 7. 处理错误
      const duration = Date.now() - startTime;
      const executionError = this.convertError(error, request);

      // 8. 记录指标
      this.recordMetrics(
        request.name,
        duration,
        executionError.type === "timeout_error" ? "timeout" : "error",
      );

      // 9. 返回错误响应
      return {
        status: executionError.type === "timeout_error" ? "timeout" : "error",
        error: executionError,
        duration,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 验证请求
   */
  private validateRequest(request: ExecutionRequest): void {
    if (!request.name) {
      throw new Error("Tool name is required");
    }

    if (request.type !== "tool") {
      throw new Error(`Invalid request type: ${request.type}`);
    }

    if (!request.parameters) {
      throw new Error("Tool parameters are required");
    }
  }

  /**
   * 创建超时错误
   */
  private createTimeoutError(toolName: string, timeout: number): ExecutionError {
    return {
      type: "timeout_error",
      message: `Tool execution timeout after ${timeout}ms`,
      details: { toolName, timeout },
      suggestion: "Try increasing the timeout or optimizing the tool",
    };
  }

  /**
   * 转换错误
   */
  private convertError(error: unknown, request: ExecutionRequest): ExecutionError {
    if (error instanceof Error) {
      // 检查是否是超时错误
      if (error.message.includes("timeout")) {
        return {
          type: "timeout_error",
          message: error.message,
          stack: error.stack,
          suggestion: "Try increasing the timeout or optimizing the tool",
        };
      }

      // 检查是否是工具未找到错误
      if (error.message.includes("not found") || error.message.includes("unknown tool")) {
        return {
          type: "tool_not_found",
          message: `Tool not found: ${request.name}`,
          details: { toolName: request.name },
          suggestion: "Check if the tool name is correct",
        };
      }

      // 检查是否是参数验证错误
      if (error.message.includes("validation") || error.message.includes("invalid parameter")) {
        return {
          type: "validation_error",
          message: error.message,
          details: { parameters: request.parameters },
          suggestion: "Check the tool parameters",
        };
      }

      // 通用执行错误
      return {
        type: "execution_error",
        message: error.message,
        stack: error.stack,
        details: { toolName: request.name, parameters: request.parameters },
      };
    }

    // 未知错误
    return {
      type: "execution_error",
      message: String(error),
      details: { toolName: request.name },
    };
  }

  /**
   * 记录指标
   */
  private recordMetrics(toolName: string, duration: number, status: string): void {
    if (!this.config.enableMetrics) {
      return;
    }

    const key = `${toolName}:${status}`;
    const durations = this.metrics.get(key) || [];
    durations.push(duration);
    this.metrics.set(key, durations);

    // 限制历史记录大小
    if (durations.length > 1000) {
      durations.shift();
    }
  }

  /**
   * 获取指标
   */
  getMetrics(toolName?: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, durations] of this.metrics.entries()) {
      if (toolName && !key.startsWith(toolName)) {
        continue;
      }

      const sum = durations.reduce((a, b) => a + b, 0);
      const avg = sum / durations.length;
      const max = Math.max(...durations);
      const min = Math.min(...durations);

      result[key] = {
        count: durations.length,
        averageDuration: avg,
        maxDuration: max,
        minDuration: min,
      };
    }

    return result;
  }
}
