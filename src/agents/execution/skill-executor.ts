/**
 * 技能执行器
 * 
 * 封装技能系统，提供统一的执行接口
 */

import type {
  ExecutionRequest,
  ExecutionResponse,
  ExecutionError,
  ExecutionConfig,
  IExecutor,
} from "./types.js";

/**
 * 技能调用器接口（简化版）
 */
export interface SkillCaller {
  call(skillName: string, parameters: Record<string, unknown>): Promise<unknown>;
  exists(skillName: string): Promise<boolean>;
}

/**
 * 技能执行器
 */
export class SkillExecutor implements IExecutor {
  private config: ExecutionConfig;
  private metrics: Map<string, number[]> = new Map();

  constructor(
    private skillCaller: SkillCaller,
    config?: ExecutionConfig,
  ) {
    this.config = {
      defaultTimeout: 60000, // 60 秒（技能可能需要更长时间）
      enableLogging: true,
      logLevel: "info",
      enableMetrics: true,
      maxConcurrent: 10,
      ...config,
    };
  }

  /**
   * 执行技能调用
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
    const startTime = Date.now();

    try {
      // 1. 验证请求
      await this.validateRequest(request);

      // 2. 设置超时
      const timeout = request.timeout || this.config.defaultTimeout || 60000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(this.createTimeoutError(request.name, timeout));
        }, timeout);
      });

      // 3. 执行技能调用
      const executionPromise = this.skillCaller.call(request.name, request.parameters);

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
  private async validateRequest(request: ExecutionRequest): Promise<void> {
    if (!request.name) {
      throw new Error("Skill name is required");
    }

    if (request.type !== "skill") {
      throw new Error(`Invalid request type: ${request.type}`);
    }

    if (!request.parameters) {
      throw new Error("Skill parameters are required");
    }

    // 检查技能是否存在
    const exists = await this.skillCaller.exists(request.name);
    if (!exists) {
      throw new Error(`Skill not found: ${request.name}`);
    }
  }

  /**
   * 创建超时错误
   */
  private createTimeoutError(skillName: string, timeout: number): ExecutionError {
    return {
      type: "timeout_error",
      message: `Skill execution timeout after ${timeout}ms`,
      details: { skillName, timeout },
      suggestion: "Try increasing the timeout or optimizing the skill",
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
          suggestion: "Try increasing the timeout or optimizing the skill",
        };
      }

      // 检查是否是技能未找到错误
      if (error.message.includes("not found") || error.message.includes("unknown skill")) {
        return {
          type: "skill_not_found",
          message: `Skill not found: ${request.name}`,
          details: { skillName: request.name },
          suggestion: "Check if the skill name is correct",
        };
      }

      // 检查是否是参数验证错误
      if (error.message.includes("validation") || error.message.includes("invalid parameter")) {
        return {
          type: "validation_error",
          message: error.message,
          details: { parameters: request.parameters },
          suggestion: "Check the skill parameters",
        };
      }

      // 检查是否是权限错误
      if (error.message.includes("permission") || error.message.includes("unauthorized")) {
        return {
          type: "permission_error",
          message: error.message,
          details: { skillName: request.name },
          suggestion: "Check if you have permission to execute this skill",
        };
      }

      // 通用执行错误
      return {
        type: "execution_error",
        message: error.message,
        stack: error.stack,
        details: { skillName: request.name, parameters: request.parameters },
      };
    }

    // 未知错误
    return {
      type: "execution_error",
      message: String(error),
      details: { skillName: request.name },
    };
  }

  /**
   * 记录指标
   */
  private recordMetrics(skillName: string, duration: number, status: string): void {
    if (!this.config.enableMetrics) {
      return;
    }

    const key = `${skillName}:${status}`;
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
  getMetrics(skillName?: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, durations] of this.metrics.entries()) {
      if (skillName && !key.startsWith(skillName)) {
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
