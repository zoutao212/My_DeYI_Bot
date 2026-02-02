/**
 * 任务委托器
 * 
 * 职责：
 * - 接收管家层的任务委托
 * - 将任务传递给任务调度层
 * - 返回执行结果
 */

import type {
  TaskDelegationRequest,
  TaskDelegationResponse,
  TaskProgress,
} from "../multi-layer/types.js";

/**
 * 任务接口（简化版）
 */
export interface Task {
  id: string;
  type: "simple" | "complex" | "skill";
  description: string;
  parameters?: Record<string, unknown>;
  priority?: "low" | "normal" | "high";
  timeout?: number;
}

/**
 * 任务结果接口
 */
export interface TaskResult {
  subtaskId: string;
  status: "success" | "failure";
  result?: unknown;
  error?: string;
}

/**
 * TaskBoard 接口（简化版）
 */
export interface TaskBoard {
  createTask(params: {
    id: string;
    type: string;
    description: string;
    parameters?: Record<string, unknown>;
    priority?: string;
    timeout?: number;
  }): Promise<Task>;
}

/**
 * Orchestrator 接口（简化版）
 */
export interface Orchestrator {
  decompose(task: Task): Promise<Task[]>;
}

/**
 * Executor 接口（简化版）
 */
export interface Executor {
  execute(task: Task): Promise<unknown>;
  executeSkill(skillName: string, parameters: Record<string, unknown>): Promise<unknown>;
}

/**
 * 任务委托器
 */
export class TaskDelegator {
  constructor(
    private taskBoard: TaskBoard,
    private orchestrator: Orchestrator,
    private executor: Executor,
  ) {}

  /**
   * 委托任务
   */
  async delegate(request: TaskDelegationRequest): Promise<TaskDelegationResponse> {
    // 1. 创建任务
    const task = await this.taskBoard.createTask({
      id: request.taskId,
      type: request.taskType,
      description: request.description,
      parameters: request.context,
      priority: request.constraints?.priority || "normal",
      timeout: request.constraints?.maxExecutionTime,
    });

    // 2. 判断任务类型
    if (request.taskType === "simple") {
      return this.executeSimpleTask(task, request.onProgress);
    } else if (request.taskType === "complex") {
      return this.executeComplexTask(task, request.onProgress);
    } else if (request.taskType === "skill") {
      return this.executeSkillTask(task, request.onProgress);
    }

    throw new Error(`Unknown task type: ${request.taskType}`);
  }

  /**
   * 执行简单任务
   */
  private async executeSimpleTask(
    task: Task,
    onProgress?: (progress: TaskProgress) => void,
  ): Promise<TaskDelegationResponse> {
    try {
      // 直接调用执行层
      const result = await this.executor.execute(task);

      return {
        taskId: task.id,
        status: "completed",
        result,
      };
    } catch (error: any) {
      return {
        taskId: task.id,
        status: "failed",
        error: {
          code: "EXECUTION_ERROR",
          message: error.message,
        },
      };
    }
  }

  /**
   * 执行复杂任务
   */
  private async executeComplexTask(
    task: Task,
    onProgress?: (progress: TaskProgress) => void,
  ): Promise<TaskDelegationResponse> {
    try {
      // 1. 分解任务
      const subtasks = await this.orchestrator.decompose(task);

      // 2. 执行子任务
      const results: TaskResult[] = [];
      for (let i = 0; i < subtasks.length; i++) {
        const subtask = subtasks[i];

        // 通知进度
        if (onProgress) {
          onProgress({
            taskId: task.id,
            percentage: (i / subtasks.length) * 100,
            status: `执行子任务 ${i + 1}/${subtasks.length}`,
            currentStep: subtask.description,
            totalSteps: subtasks.length,
            completedSteps: i,
          });
        }

        // 执行子任务
        const result = await this.executor.execute(subtask);
        results.push({
          subtaskId: subtask.id,
          status: "success",
          result,
        });
      }

      // 3. 汇总结果
      return {
        taskId: task.id,
        status: "completed",
        result: this.aggregateResults(results),
      };
    } catch (error: any) {
      return {
        taskId: task.id,
        status: "failed",
        error: {
          code: "EXECUTION_ERROR",
          message: error.message,
        },
      };
    }
  }

  /**
   * 执行技能任务
   */
  private async executeSkillTask(
    task: Task,
    onProgress?: (progress: TaskProgress) => void,
  ): Promise<TaskDelegationResponse> {
    try {
      // 调用技能执行器
      const skillName = (task.parameters?.skillName as string) || "";
      const result = await this.executor.executeSkill(skillName, task.parameters || {});

      return {
        taskId: task.id,
        status: "completed",
        result,
      };
    } catch (error: any) {
      return {
        taskId: task.id,
        status: "failed",
        error: {
          code: "EXECUTION_ERROR",
          message: error.message,
        },
      };
    }
  }

  /**
   * 汇总结果
   */
  private aggregateResults(results: TaskResult[]): unknown {
    return results.map((r) => r.result);
  }
}
