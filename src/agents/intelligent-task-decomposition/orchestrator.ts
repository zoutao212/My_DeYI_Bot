/**
 * 任务分解协调器
 * 
 * 协调所有组件，实现完整的任务分解流程
 */

import crypto from "node:crypto";
import type { TaskTree, SubTask, TaskTreeChange, QualityReviewResult } from "./types.js";
import { TaskTreeManager } from "./task-tree-manager.js";
import { RetryManager } from "./retry-manager.js";
import { ErrorHandler } from "./error-handler.js";
import { RecoveryManager } from "./recovery-manager.js";
import { LLMTaskDecomposer } from "./llm-task-decomposer.js";
import { QualityReviewer } from "./quality-reviewer.js";
import { TaskAdjuster } from "./task-adjuster.js";

/**
 * 任务分解协调器
 */
export class Orchestrator {
  private taskTreeManager: TaskTreeManager;
  private retryManager: RetryManager;
  private errorHandler: ErrorHandler;
  private recoveryManager: RecoveryManager;
  private llmDecomposer: LLMTaskDecomposer;
  private qualityReviewer: QualityReviewer;
  private taskAdjuster: TaskAdjuster;

  constructor() {
    this.taskTreeManager = new TaskTreeManager();
    this.retryManager = new RetryManager();
    this.errorHandler = new ErrorHandler();
    this.recoveryManager = new RecoveryManager(this.taskTreeManager);
    
    // 初始化新组件（使用默认 LLM 配置）
    const llmConfig = {
      provider: "openai",
      model: "gpt-4",
    };
    this.llmDecomposer = new LLMTaskDecomposer(llmConfig);
    this.qualityReviewer = new QualityReviewer(llmConfig);
    this.taskAdjuster = new TaskAdjuster(this.taskTreeManager);
  }

  /**
   * 初始化任务树
   */
  async initializeTaskTree(rootTask: string, sessionId: string): Promise<TaskTree> {
    return await this.taskTreeManager.initialize(rootTask, sessionId);
  }

  /**
   * 添加子任务到任务树
   */
  async addSubTask(
    taskTree: TaskTree,
    prompt: string,
    summary: string,
  ): Promise<SubTask> {
    const subTask: SubTask = {
      id: crypto.randomUUID(),
      prompt,
      summary,
      status: "pending",
      retryCount: 0,
      createdAt: Date.now(),
    };

    taskTree.subTasks.push(subTask);
    await this.taskTreeManager.save(taskTree);

    console.log(`[Orchestrator] ✅ Sub task added: ${subTask.id} (${summary})`);
    return subTask;
  }

  /**
   * 执行子任务
   */
  async executeSubTask(
    taskTree: TaskTree,
    subTask: SubTask,
    executor: () => Promise<string>,
  ): Promise<void> {
    try {
      // 更新状态为 "active"
      await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "active");

      // 创建检查点
      await this.taskTreeManager.createCheckpoint(taskTree);

      // 执行任务（带重试）
      const output = await this.retryManager.executeWithRetry(
        subTask,
        executor,
        3, // 最多重试 3 次
      );

      // 更新输出和状态
      subTask.output = output;
      await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "completed");

      console.log(`[Orchestrator] ✅ Sub task completed: ${subTask.id}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // 更新错误信息和状态
      subTask.error = error.message;
      subTask.retryCount++;
      await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "failed");

      // 记录失败日志
      await this.retryManager.logFailure(subTask, error, taskTree.id);

      // 处理错误
      await this.errorHandler.handleError(
        error,
        {
          taskTreeId: taskTree.id,
          subTaskId: subTask.id,
          subTaskSummary: subTask.summary,
        },
        taskTree.id,
      );

      console.error(`[Orchestrator] ❌ Sub task failed: ${subTask.id} - ${error.message}`);
      throw error;
    }
  }

  /**
   * 检查是否有未完成的任务
   */
  async hasUnfinishedTasks(sessionId: string): Promise<boolean> {
    return await this.recoveryManager.hasUnfinishedTasks(sessionId);
  }

  /**
   * 恢复未完成的任务
   */
  async recoverUnfinishedTasks(sessionId: string): Promise<TaskTree> {
    return await this.recoveryManager.recoverUnfinishedTasks(sessionId);
  }

  /**
   * 重新执行中断的任务
   */
  async reexecuteInterruptedTasks(taskTree: TaskTree): Promise<SubTask[]> {
    const interruptedTasks = this.recoveryManager.identifyInterruptedTasks(taskTree);
    await this.recoveryManager.reexecuteInterruptedTasks(taskTree, interruptedTasks);
    return interruptedTasks;
  }

  /**
   * 加载任务树
   */
  async loadTaskTree(sessionId: string): Promise<TaskTree | null> {
    return await this.taskTreeManager.load(sessionId);
  }

  /**
   * 保存任务树
   */
  async saveTaskTree(taskTree: TaskTree): Promise<void> {
    await this.taskTreeManager.save(taskTree);
  }

  /**
   * 渲染任务树为 Markdown
   */
  renderTaskTreeToMarkdown(taskTree: TaskTree): string {
    return this.taskTreeManager.renderToMarkdown(taskTree);
  }

  // ========================================
  // 🆕 新增方法：递归分解和质量评估
  // ========================================

  /**
   * 递归分解子任务
   * 
   * @param taskTree 任务树
   * @param subTaskId 要分解的子任务 ID
   * @param enableQualityReview 是否启用质量评估（默认 true）
   * @returns 分解后的子任务列表
   */
  async decomposeSubTask(
    taskTree: TaskTree,
    subTaskId: string,
    enableQualityReview: boolean = true
  ): Promise<SubTask[]> {
    // 1. 查找子任务
    const subTask = taskTree.subTasks.find(t => t.id === subTaskId);
    if (!subTask) {
      throw new Error(`子任务 ${subTaskId} 不存在`);
    }

    // 2. 检查是否可以分解
    const maxDepth = taskTree.maxDepth ?? 3;
    if (!this.llmDecomposer.canDecompose(subTask, maxDepth)) {
      console.log(`[Orchestrator] ℹ️ 子任务 ${subTaskId} 不可分解`);
      return [];
    }

    // 3. 调用 LLM 进行分解
    const decomposedTasks = await this.llmDecomposer.decomposeRecursively(
      taskTree,
      subTask,
      maxDepth
    );

    // 4. 如果启用质量评估，评估分解质量
    if (enableQualityReview && taskTree.qualityReviewEnabled !== false) {
      const review = await this.qualityReviewer.reviewDecomposition(
        taskTree,
        subTaskId,
        "initial_decomposition"
      );

      // 根据评估决策执行相应操作
      switch (review.decision) {
        case "continue":
          // 通过，继续执行
          console.log(`[Orchestrator] ✅ 分解质量评估通过`);
          break;

        case "adjust":
          // 需要调整，应用调整方案
          console.log(`[Orchestrator] ⚠️ 分解质量需要调整`);
          if (review.modifications && review.modifications.length > 0) {
            await this.adjustTaskTree(taskTree, review.modifications, false);
          }
          break;

        case "restart":
          // 需要重启，保留经验并重新分解
          console.log(`[Orchestrator] 🔄 分解质量不满意，需要重启`);
          return await this.restartDecomposition(taskTree, subTask, review);

        case "overthrow":
          // 需要推翻，完全重新开始
          console.log(`[Orchestrator] ❌ 分解质量严重不满意，需要推翻`);
          return await this.overthrowDecomposition(taskTree, subTask, review);
      }
    }

    // 5. 将分解后的子任务添加到任务树
    for (const decomposedTask of decomposedTasks) {
      await this.taskTreeManager.addSubTask(taskTree, subTaskId, decomposedTask);
    }

    // 6. 标记子任务为已分解
    await this.markAsDecomposed(taskTree, subTaskId);

    console.log(`[Orchestrator] ✅ 子任务 ${subTaskId} 分解完成，生成 ${decomposedTasks.length} 个子任务`);
    return decomposedTasks;
  }

  /**
   * 动态调整任务树
   * 
   * @param taskTree 任务树
   * @param changes 要应用的变更列表
   * @param enableQualityReview 是否启用质量评估（默认 true）
   */
  async adjustTaskTree(
    taskTree: TaskTree,
    changes: TaskTreeChange[],
    enableQualityReview: boolean = true
  ): Promise<void> {
    // 1. 验证变更的合法性
    const validation = this.taskAdjuster.validateChanges(taskTree, changes);
    if (!validation.valid) {
      throw new Error(`变更验证失败: ${validation.errors.join(", ")}`);
    }

    // 2. 如果启用质量评估，评估调整方案
    if (enableQualityReview && taskTree.qualityReviewEnabled !== false) {
      // TODO: 实现调整方案的质量评估
      console.log(`[Orchestrator] ℹ️ 调整方案质量评估（待实现）`);
    }

    // 3. 应用变更
    await this.taskAdjuster.applyChanges(taskTree, changes);

    // 4. 保存任务树
    await this.taskTreeManager.save(taskTree);

    console.log(`[Orchestrator] ✅ 任务树调整完成，应用了 ${changes.length} 个变更`);
  }

  /**
   * 获取可执行的子任务列表（考虑依赖关系）
   * 
   * @param taskTree 任务树
   * @returns 可执行的子任务列表（按优先级排序）
   */
  getExecutableTasks(taskTree: TaskTree): SubTask[] {
    const executableTasks: SubTask[] = [];

    for (const subTask of taskTree.subTasks) {
      // 1. 检查任务状态（只有 pending 状态的任务可以执行）
      if (subTask.status !== "pending") {
        continue;
      }

      // 2. 检查依赖关系（所有依赖的任务都必须已完成）
      if (subTask.dependencies && subTask.dependencies.length > 0) {
        const allDependenciesCompleted = subTask.dependencies.every(depId => {
          const depTask = taskTree.subTasks.find(t => t.id === depId);
          return depTask && depTask.status === "completed";
        });

        if (!allDependenciesCompleted) {
          continue;
        }
      }

      // 3. 添加到可执行任务列表
      executableTasks.push(subTask);
    }

    // 4. 按优先级排序（high > medium > low）
    executableTasks.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      const aPriority = priorityOrder[a.metadata?.priority || "medium"];
      const bPriority = priorityOrder[b.metadata?.priority || "medium"];
      return bPriority - aPriority;
    });

    return executableTasks;
  }

  /**
   * 标记子任务为已分解
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   */
  async markAsDecomposed(
    taskTree: TaskTree,
    subTaskId: string
  ): Promise<void> {
    await this.taskTreeManager.modifySubTask(taskTree, subTaskId, {
      decomposed: true
    });
  }

  // ========================================
  // 私有辅助方法：重启和推翻机制
  // ========================================

  /**
   * 重启分解（保留经验并重新分解）
   * 
   * @param taskTree 任务树
   * @param subTask 子任务
   * @param review 质量评估结果
   * @returns 新的子任务列表
   */
  private async restartDecomposition(
    taskTree: TaskTree,
    subTask: SubTask,
    review: QualityReviewResult
  ): Promise<SubTask[]> {
    // 1. 初始化字段（如果不存在）
    if (!taskTree.restartCount) {
      taskTree.restartCount = 0;
    }
    if (!taskTree.failureHistory) {
      taskTree.failureHistory = [];
    }

    // 2. 检查重启次数限制
    const maxRestarts = 2;
    if (taskTree.restartCount >= maxRestarts) {
      console.warn(`[Orchestrator] ⚠️ 已达到最大重启次数 ${maxRestarts}，改为推翻`);
      return await this.overthrowDecomposition(taskTree, subTask, review);
    }

    // 3. 保留当前分解结果作为失败经验
    const failureRecord = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      reason: review.findings.join("; "),
      context: `子任务 ${subTask.id} 的分解质量不满意`,
      lessons: review.findings,
      improvements: review.suggestions
    };

    taskTree.failureHistory.push(failureRecord);
    taskTree.restartCount++;

    // 4. 使用失败经验重新分解
    const maxDepth = taskTree.maxDepth ?? 3;
    const newTasks = await this.llmDecomposer.decomposeWithLessons(
      taskTree,
      subTask,
      taskTree.failureHistory
    );

    console.log(`[Orchestrator] 🔄 重启分解完成（第 ${taskTree.restartCount} 次），生成 ${newTasks.length} 个新子任务`);
    return newTasks;
  }

  /**
   * 推翻分解（完全重新开始）
   * 
   * @param taskTree 任务树
   * @param subTask 子任务
   * @param review 质量评估结果
   * @returns 新的子任务列表
   */
  private async overthrowDecomposition(
    taskTree: TaskTree,
    subTask: SubTask,
    review: QualityReviewResult
  ): Promise<SubTask[]> {
    // 1. 初始化字段（如果不存在）
    if (!taskTree.overthrowCount) {
      taskTree.overthrowCount = 0;
    }
    if (!taskTree.failureHistory) {
      taskTree.failureHistory = [];
    }

    // 2. 检查推翻次数限制
    const maxOverthrows = 1;
    if (taskTree.overthrowCount >= maxOverthrows) {
      throw new Error(`已达到最大推翻次数 ${maxOverthrows}，无法继续分解`);
    }

    // 3. 记录推翻原因
    const failureRecord = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      reason: `根本性错误：${review.findings.join("; ")}`,
      context: `子任务 ${subTask.id} 的分解方案存在根本性错误，需要完全推翻`,
      lessons: review.findings,
      improvements: review.suggestions
    };

    taskTree.failureHistory.push(failureRecord);
    taskTree.overthrowCount++;

    // 4. 完全重新分解（不使用失败经验，从头开始）
    const maxDepth = taskTree.maxDepth ?? 3;
    const newTasks = await this.llmDecomposer.decomposeRecursively(
      taskTree,
      subTask,
      maxDepth
    );

    console.log(`[Orchestrator] ❌ 推翻分解完成（第 ${taskTree.overthrowCount} 次），生成 ${newTasks.length} 个新子任务`);
    return newTasks;
  }
}
