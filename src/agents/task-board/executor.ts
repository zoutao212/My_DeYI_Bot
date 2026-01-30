/**
 * 任务执行器
 * 
 * 负责执行单个子任务或并发执行多个子任务。
 */

import type { SubTask, ExecutionContext, ExecutionResult } from "./types.js";

/**
 * 任务执行器接口
 */
export interface TaskExecutor {
  /**
   * 执行单个子任务
   * @param subTask 要执行的子任务
   * @param context 执行上下文
   * @returns 执行结果
   */
  execute(subTask: SubTask, context: ExecutionContext): Promise<ExecutionResult>;

  /**
   * 并发执行多个子任务
   * @param subTasks 要执行的子任务列表
   * @param context 执行上下文
   * @returns 执行结果列表
   */
  executeConcurrent(
    subTasks: SubTask[],
    context: ExecutionContext
  ): Promise<ExecutionResult[]>;

  /**
   * 取消正在执行的子任务
   * @param subTaskId 子任务 ID
   */
  cancel(subTaskId: string): Promise<void>;
}

/**
 * 默认任务执行器实现
 */
export class DefaultTaskExecutor implements TaskExecutor {
  private cancelledTasks: Set<string> = new Set();
  private runningTasks: Map<string, Promise<ExecutionResult>> = new Map();

  /**
   * 执行单个子任务
   */
  async execute(subTask: SubTask, context: ExecutionContext): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // 检查是否已取消
      if (this.cancelledTasks.has(subTask.id)) {
        return {
          subTaskId: subTask.id,
          status: "cancelled",
          outputs: [],
          duration: Date.now() - startTime
        };
      }

      // TODO: 这里应该调用 Agent 的工具集执行子任务
      // 目前返回一个简单的成功结果
      
      // 模拟执行时间
      await new Promise(resolve => setTimeout(resolve, 100));

      // 提取产出（这里是示例）
      const outputs: string[] = [];
      
      // 如果任务描述中提到了文件，添加到产出
      const fileMatches = subTask.description.match(/\w+\.\w+/g);
      if (fileMatches) {
        outputs.push(...fileMatches);
      }

      return {
        subTaskId: subTask.id,
        status: "completed",
        outputs,
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        subTaskId: subTask.id,
        status: "failed",
        outputs: [],
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * 并发执行多个子任务
   */
  async executeConcurrent(
    subTasks: SubTask[],
    context: ExecutionContext
  ): Promise<ExecutionResult[]> {
    // 创建执行 Promise
    const executionPromises = subTasks.map(subTask => {
      const promise = this.execute(subTask, context);
      this.runningTasks.set(subTask.id, promise);
      return promise;
    });

    try {
      // 并发执行所有子任务
      const results = await Promise.all(executionPromises);

      // 清理运行中的任务
      for (const subTask of subTasks) {
        this.runningTasks.delete(subTask.id);
      }

      // 检查是否有失败的任务
      const failedTask = results.find(r => r.status === "failed");
      if (failedTask) {
        // 如果有失败的任务，取消其他正在执行的任务
        for (const subTask of subTasks) {
          if (subTask.id !== failedTask.subTaskId) {
            await this.cancel(subTask.id);
          }
        }
      }

      return results;
    } catch (error) {
      // 如果出现异常，取消所有任务
      for (const subTask of subTasks) {
        await this.cancel(subTask.id);
      }
      throw error;
    }
  }

  /**
   * 取消正在执行的子任务
   */
  async cancel(subTaskId: string): Promise<void> {
    // 标记为已取消
    this.cancelledTasks.add(subTaskId);

    // 等待任务完成（如果正在执行）
    const runningTask = this.runningTasks.get(subTaskId);
    if (runningTask) {
      try {
        await runningTask;
      } catch {
        // 忽略错误
      }
      this.runningTasks.delete(subTaskId);
    }
  }

  /**
   * 识别可并发执行的子任务
   * @param subTasks 子任务列表
   * @returns 可并发执行的子任务组
   */
  identifyConcurrentTasks(subTasks: SubTask[]): SubTask[][] {
    const groups: SubTask[][] = [];
    const processed = new Set<string>();

    for (const subTask of subTasks) {
      if (processed.has(subTask.id)) {
        continue;
      }

      // 查找所有没有依赖关系的子任务
      const group: SubTask[] = [subTask];
      processed.add(subTask.id);

      for (const otherTask of subTasks) {
        if (processed.has(otherTask.id)) {
          continue;
        }

        // 检查是否有依赖关系
        const hasDependency = 
          subTask.dependencies.includes(otherTask.id) ||
          otherTask.dependencies.includes(subTask.id) ||
          group.some(t => 
            t.dependencies.includes(otherTask.id) ||
            otherTask.dependencies.includes(t.id)
          );

        if (!hasDependency) {
          group.push(otherTask);
          processed.add(otherTask.id);
        }
      }

      if (group.length > 1) {
        groups.push(group);
      }
    }

    return groups;
  }
}

/**
 * 创建默认的任务执行器实例
 * @returns 任务执行器实例
 */
export function createTaskExecutor(): TaskExecutor {
  return new DefaultTaskExecutor();
}
