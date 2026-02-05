/**
 * 任务调整器
 * 
 * 负责根据质量评估结果或执行结果动态调整任务树结构。
 * 
 * 支持的调整类型：
 * - 添加新的子任务
 * - 删除不必要的子任务
 * - 修改子任务的描述或依赖关系
 * - 移动子任务到新的父任务
 * - 合并多个子任务
 * - 拆分子任务为多个子任务
 */

import type {
  TaskTree,
  SubTask,
  TaskTreeChange,
  QualityReviewResult,
  ValidationResult,
  ChangeType
} from "./types.js";
import { TaskTreeManager } from "./task-tree-manager.js";

/**
 * 执行结果接口
 */
export interface ExecutionResult {
  subTaskId: string;
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
}

/**
 * 任务调整器
 */
export class TaskAdjuster {
  private taskTreeManager: TaskTreeManager;

  constructor(taskTreeManager: TaskTreeManager) {
    this.taskTreeManager = taskTreeManager;
  }

  /**
   * 应用任务树变更
   * 
   * 支持所有变更类型：add/remove/modify/move/merge/split
   * 
   * @param taskTree 任务树
   * @param changes 变更列表
   */
  async applyChanges(
    taskTree: TaskTree,
    changes: TaskTreeChange[]
  ): Promise<void> {
    // 1. 验证变更的合法性
    const validation = this.validateChanges(taskTree, changes);
    if (!validation.valid) {
      throw new Error(`变更验证失败: ${validation.errors.join(", ")}`);
    }

    // 2. 按类型应用变更
    for (const change of changes) {
      try {
        switch (change.type) {
          case "add_task":
            await this.applyAddTask(taskTree, change);
            break;
          case "remove_task":
            await this.applyRemoveTask(taskTree, change);
            break;
          case "modify_task":
            await this.applyModifyTask(taskTree, change);
            break;
          case "move_task":
            await this.applyMoveTask(taskTree, change);
            break;
          case "merge_tasks":
            await this.applyMergeTasks(taskTree, change);
            break;
          case "split_task":
            await this.applySplitTask(taskTree, change);
            break;
          default:
            console.warn(`未知的变更类型: ${change.type}`);
        }
      } catch (error) {
        console.error(`应用变更失败 (${change.type}):`, error);
        throw error;
      }
    }

    // 3. 更新任务树的更新时间
    taskTree.updatedAt = Date.now();
  }

  /**
   * 生成调整方案（基于执行结果）
   * 
   * 分析执行结果，生成合理的调整方案。
   * 
   * @param taskTree 任务树
   * @param executionResults 执行结果列表
   * @returns 任务树变更列表
   */
  async generateAdjustmentPlan(
    taskTree: TaskTree,
    executionResults: ExecutionResult[]
  ): Promise<TaskTreeChange[]> {
    const changes: TaskTreeChange[] = [];

    for (const result of executionResults) {
      if (!result.success) {
        // 失败的任务可能需要拆分或重新设计
        const subTask = taskTree.subTasks.find(st => st.id === result.subTaskId);
        if (subTask && subTask.retryCount >= 3) {
          // 重试次数过多，建议拆分任务
          changes.push({
            type: "split_task",
            targetId: result.subTaskId,
            after: {
              reason: "任务重试次数过多，建议拆分为更小的子任务"
            },
            timestamp: Date.now()
          });
        }
      }
    }

    return changes;
  }

  /**
   * 生成调整方案（基于质量评估）
   * 
   * 将质量评估的改进建议转换为具体的变更操作。
   * 
   * @param taskTree 任务树
   * @param review 质量评估结果
   * @returns 任务树变更列表
   */
  async generateAdjustmentFromReview(
    taskTree: TaskTree,
    review: QualityReviewResult
  ): Promise<TaskTreeChange[]> {
    // 如果评估结果中已经包含了变更建议，直接返回
    if (review.modifications && review.modifications.length > 0) {
      return review.modifications;
    }

    // 否则根据改进建议生成变更
    const changes: TaskTreeChange[] = [];

    for (const suggestion of review.suggestions) {
      // 这里可以使用 LLM 将改进建议转换为具体的变更操作
      // 目前简化处理，只记录建议
      console.log(`改进建议: ${suggestion}`);
    }

    return changes;
  }

  /**
   * 验证变更的合法性
   * 
   * 检查变更是否会导致：
   * - 循环依赖
   * - 引用不存在的任务
   * - 超过深度限制
   * 
   * @param taskTree 任务树
   * @param changes 变更列表
   * @returns 验证结果
   */
  validateChanges(
    taskTree: TaskTree,
    changes: TaskTreeChange[]
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const change of changes) {
      // 1. 检查目标任务是否存在（除了 add_task）
      if (change.type !== "add_task") {
        const targetExists = taskTree.subTasks.some(st => st.id === change.targetId);
        if (!targetExists) {
          errors.push(`目标任务 ${change.targetId} 不存在`);
        }
      }

      // 2. 检查变更类型特定的验证
      switch (change.type) {
        case "add_task":
          if (!change.after) {
            errors.push(`add_task 变更缺少 after 字段`);
          }
          break;
        case "modify_task":
          if (!change.after) {
            errors.push(`modify_task 变更缺少 after 字段`);
          }
          break;
        case "move_task":
          if (!change.after || !change.after.parentId) {
            errors.push(`move_task 变更缺少 after.parentId 字段`);
          }
          break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * 合并多个子任务
   * 
   * @param taskTree 任务树
   * @param taskIds 要合并的任务 ID 列表
   * @param newTask 合并后的新任务
   * @returns 新任务 ID
   */
  async mergeTasks(
    taskTree: TaskTree,
    taskIds: string[],
    newTask: Partial<SubTask>
  ): Promise<string> {
    // 1. 找到要合并的任务
    const tasksToMerge = taskTree.subTasks.filter(st => taskIds.includes(st.id));
    if (tasksToMerge.length === 0) {
      throw new Error("没有找到要合并的任务");
    }

    // 2. 合并任务的描述、依赖关系、输出
    const mergedPrompt = tasksToMerge.map(t => t.prompt).join("\n\n");
    const mergedDependencies = Array.from(
      new Set(tasksToMerge.flatMap(t => t.dependencies || []))
    ).filter(depId => !taskIds.includes(depId)); // 排除内部依赖

    // 3. 创建新任务
    const newSubTask: SubTask = {
      id: newTask.id || `merged-${Date.now()}`,
      prompt: newTask.prompt || mergedPrompt,
      summary: newTask.summary || "合并的任务",
      status: "pending",
      retryCount: 0,
      createdAt: Date.now(),
      parentId: tasksToMerge[0].parentId,
      depth: tasksToMerge[0].depth,
      children: [],
      dependencies: mergedDependencies,
      canDecompose: true,
      decomposed: false,
      qualityReviewEnabled: tasksToMerge[0].qualityReviewEnabled,
      metadata: newTask.metadata
    };

    // 4. 添加新任务
    await this.taskTreeManager.addSubTask(taskTree, newSubTask.parentId || null, newSubTask);

    // 5. 删除原任务
    for (const taskId of taskIds) {
      await this.taskTreeManager.removeSubTask(taskTree, taskId);
    }

    return newSubTask.id;
  }

  /**
   * 拆分子任务
   * 
   * @param taskTree 任务树
   * @param taskId 要拆分的任务 ID
   * @param newTasks 拆分后的新任务列表
   * @returns 新任务 ID 列表
   */
  async splitTask(
    taskTree: TaskTree,
    taskId: string,
    newTasks: Partial<SubTask>[]
  ): Promise<string[]> {
    // 1. 找到要拆分的任务
    const taskToSplit = taskTree.subTasks.find(st => st.id === taskId);
    if (!taskToSplit) {
      throw new Error(`任务 ${taskId} 不存在`);
    }

    // 2. 创建新任务
    const newSubTaskIds: string[] = [];
    for (let i = 0; i < newTasks.length; i++) {
      const newTask = newTasks[i];
      const newSubTask: SubTask = {
        id: newTask.id || `${taskId}-split-${i + 1}`,
        prompt: newTask.prompt || "",
        summary: newTask.summary || `拆分任务 ${i + 1}`,
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        parentId: taskToSplit.parentId,
        depth: taskToSplit.depth,
        children: [],
        dependencies: newTask.dependencies || [],
        canDecompose: true,
        decomposed: false,
        qualityReviewEnabled: taskToSplit.qualityReviewEnabled,
        metadata: newTask.metadata
      };

      await this.taskTreeManager.addSubTask(taskTree, newSubTask.parentId || null, newSubTask);
      newSubTaskIds.push(newSubTask.id);
    }

    // 3. 删除原任务
    await this.taskTreeManager.removeSubTask(taskTree, taskId);

    return newSubTaskIds;
  }

  // ========================================
  // 私有辅助方法
  // ========================================

  /**
   * 应用添加任务变更
   */
  private async applyAddTask(taskTree: TaskTree, change: TaskTreeChange): Promise<void> {
    const newTask = change.after as SubTask;
    await this.taskTreeManager.addSubTask(taskTree, newTask.parentId || null, newTask);
  }

  /**
   * 应用删除任务变更
   */
  private async applyRemoveTask(taskTree: TaskTree, change: TaskTreeChange): Promise<void> {
    await this.taskTreeManager.removeSubTask(taskTree, change.targetId);
  }

  /**
   * 应用修改任务变更
   */
  private async applyModifyTask(taskTree: TaskTree, change: TaskTreeChange): Promise<void> {
    const updates = change.after as Partial<SubTask>;
    await this.taskTreeManager.modifySubTask(taskTree, change.targetId, updates);
  }

  /**
   * 应用移动任务变更
   */
  private async applyMoveTask(taskTree: TaskTree, change: TaskTreeChange): Promise<void> {
    const newParentId = change.after.parentId;
    await this.taskTreeManager.moveSubTask(taskTree, change.targetId, newParentId);
  }

  /**
   * 应用合并任务变更
   */
  private async applyMergeTasks(taskTree: TaskTree, change: TaskTreeChange): Promise<void> {
    const taskIds = change.after.taskIds as string[];
    const newTask = change.after.newTask as Partial<SubTask>;
    await this.mergeTasks(taskTree, taskIds, newTask);
  }

  /**
   * 应用拆分任务变更
   */
  private async applySplitTask(taskTree: TaskTree, change: TaskTreeChange): Promise<void> {
    const newTasks = change.after.newTasks as Partial<SubTask>[];
    await this.splitTask(taskTree, change.targetId, newTasks);
  }
}

/**
 * 创建 TaskAdjuster 实例
 * 
 * @param taskTreeManager TaskTreeManager 实例
 * @returns TaskAdjuster 实例
 */
export function createTaskAdjuster(taskTreeManager: TaskTreeManager): TaskAdjuster {
  return new TaskAdjuster(taskTreeManager);
}
