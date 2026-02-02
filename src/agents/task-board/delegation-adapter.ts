/**
 * 任务委托适配器
 * 
 * 职责：
 * - 将管家层的任务委托接口连接到现有的任务分解系统
 * - 转换请求和响应格式
 * - 处理进度回调
 * - 实现错误处理和重试机制
 */

import type {
  TaskDelegationRequest,
  TaskDelegationResponse,
  TaskProgress,
} from "../multi-layer/types.js";
import type { TaskBoard, SubTask, ExecutionContext } from "./types.js";
import type { AgentOrchestrator } from "./orchestrator.js";
import type { TaskExecutor } from "./executor.js";

/**
 * 适配器配置
 */
export interface DelegationAdapterConfig {
  /** 最大重试次数 */
  maxRetries?: number;
  /** 重试延迟（毫秒） */
  retryDelay?: number;
  /** 默认超时时间（毫秒） */
  defaultTimeout?: number;
  /** 进度更新频率限制（毫秒） */
  progressThrottle?: number;
}

/**
 * 转换选项
 */
export interface ConversionOptions {
  /** 是否包含详细信息 */
  includeDetails?: boolean;
  /** 是否包含子任务 */
  includeSubtasks?: boolean;
}

/**
 * 任务委托适配器
 */
export class DelegationAdapter {
  private config: Required<DelegationAdapterConfig>;
  private progressCache: Map<string, TaskProgress>;
  private lastProgressTime: Map<string, number>;

  constructor(
    private orchestrator: AgentOrchestrator,
    private executor: TaskExecutor,
    config?: DelegationAdapterConfig,
  ) {
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      retryDelay: config?.retryDelay ?? 1000,
      defaultTimeout: config?.defaultTimeout ?? 300000, // 5 分钟
      progressThrottle: config?.progressThrottle ?? 500, // 500ms
    };
    this.progressCache = new Map();
    this.lastProgressTime = new Map();
  }

  /**
   * 委托任务
   */
  async delegate(request: TaskDelegationRequest): Promise<TaskDelegationResponse> {
    try {
      // 1. 转换请求为 SubTask
      const subtask = this.convertRequestToSubTask(request);

      // 2. 设置进度回调
      if (request.onProgress) {
        this.setupProgressCallback(subtask.id, request.onProgress);
      }

      // 3. 创建执行上下文
      const context: ExecutionContext = {
        sessionId: request.taskId,
        taskBoard: {
          sessionId: request.taskId,
          mainTask: {
            title: request.description,
            objective: request.description,
            status: "active",
            progress: "0%",
          },
          subTasks: [subtask],
          currentFocus: {
            taskId: subtask.id,
            reasoningSummary: "",
            nextAction: request.description,
          },
          checkpoints: [],
          risksAndBlocks: [],
          contextAnchors: {
            codeLocations: [],
            commands: [],
          },
          lastUpdated: new Date().toISOString(),
          version: "1.0",
        },
      };

      // 4. 执行任务
      const result = await this.executor.execute(subtask, context);

      // 5. 转换响应
      return this.convertExecutionResultToResponse(result);
    } catch (error: any) {
      return this.convertResponse(request.taskId, "failed", undefined, {
        code: "EXECUTION_ERROR",
        message: error.message,
      });
    }
  }

  /**
   * 转换请求为 SubTask
   */
  private convertRequestToSubTask(request: TaskDelegationRequest): SubTask {
    return {
      id: request.taskId,
      title: request.description,
      description: request.description,
      status: "pending",
      progress: "0%",
      dependencies: [],
      outputs: [],
      notes: "",
    };
  }

  /**
   * 转换执行结果为响应
   */
  private convertExecutionResultToResponse(result: any): TaskDelegationResponse {
    return {
      taskId: result.subTaskId,
      status: result.status === "completed" ? "completed" : "failed",
      result: result.outputs,
      error: result.error
        ? {
            code: "EXECUTION_ERROR",
            message: result.error.message,
          }
        : undefined,
      executionTime: result.duration,
    };
  }

  /**
   * 转换响应
   */
  private convertResponse(
    taskId: string,
    status: "pending" | "running" | "completed" | "failed",
    result?: unknown,
    error?: { code: string; message: string; details?: unknown },
  ): TaskDelegationResponse {
    return {
      taskId,
      status,
      result,
      error,
    };
  }

  /**
   * 设置进度回调
   */
  private setupProgressCallback(taskId: string, onProgress: (progress: TaskProgress) => void): void {
    // TODO: 实现进度监听逻辑
    // 当前为占位符
  }

  /**
   * 转换进度事件
   */
  private convertProgressEvent(taskId: string, event: any): TaskProgress {
    return {
      taskId,
      percentage: event.percentage || 0,
      status: event.status || "running",
      currentStep: event.currentStep,
      totalSteps: event.totalSteps,
      completedSteps: event.completedSteps,
    };
  }

  /**
   * 检查是否应该发送进度更新
   */
  private shouldSendProgress(taskId: string): boolean {
    const lastTime = this.lastProgressTime.get(taskId) || 0;
    const now = Date.now();
    return now - lastTime >= this.config.progressThrottle;
  }

  /**
   * 更新进度缓存
   */
  private updateProgressCache(taskId: string, progress: TaskProgress): void {
    this.progressCache.set(taskId, progress);
    this.lastProgressTime.set(taskId, Date.now());
  }

  /**
   * 获取当前进度
   */
  getProgress(taskId: string): TaskProgress | undefined {
    return this.progressCache.get(taskId);
  }

  /**
   * 清理进度缓存
   */
  clearProgress(taskId: string): void {
    this.progressCache.delete(taskId);
    this.lastProgressTime.delete(taskId);
  }
}
