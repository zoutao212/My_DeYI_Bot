/**
 * Agent Orchestrator
 * 
 * 负责协调任务分解器、任务执行器、进度跟踪器和失败处理器，
 * 实现完整的任务分解、执行和跟踪流程。
 */

import type {
  TaskBoard,
  MainTask,
  SubTask,
  DecompositionContext,
  ExecutionContext,
  ExecutionResult
} from "./types.js";
import { createTaskDecomposer, type TaskDecomposer } from "./decomposer.js";
import { createTaskExecutor, type TaskExecutor } from "./executor.js";
import { createProgressTracker, type ProgressTracker } from "./progress-tracker.js";
import { createFailureHandler, type FailureHandler } from "./failure-handler.js";

/**
 * Orchestrator 配置
 */
export interface OrchestratorConfig {
  sessionId: string;
  enableConcurrentExecution?: boolean;
  enableAutoRetry?: boolean;
  maxRetries?: number;
}

/**
 * Agent Orchestrator
 */
export class AgentOrchestrator {
  private decomposer: TaskDecomposer;
  private executor: TaskExecutor;
  private progressTracker: ProgressTracker;
  private failureHandler: FailureHandler;
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = {
      enableConcurrentExecution: false,
      enableAutoRetry: false,
      maxRetries: 3,
      ...config
    };

    this.decomposer = createTaskDecomposer();
    this.executor = createTaskExecutor();
    this.progressTracker = createProgressTracker(config.sessionId);
    this.failureHandler = createFailureHandler();
  }

  /**
   * 处理用户任务
   * @param task 用户提交的任务描述
   * @param context 分解上下文
   * @returns 任务看板
   */
  async handleTask(task: string, context: DecompositionContext): Promise<TaskBoard> {
    // 1. 判断是否需要拆解
    const shouldDecompose = await this.decomposer.shouldDecompose(task);

    if (!shouldDecompose) {
      // 如果不需要拆解，直接执行
      return await this.executeSimpleTask(task, context);
    }

    // 2. 拆解任务
    const subTasks = await this.decomposer.decompose(task, context);

    // 3. 初始化任务看板
    const mainTask: MainTask = {
      title: task,
      objective: task,
      status: "active",
      progress: "0%"
    };

    const taskBoard = await this.progressTracker.initialize(mainTask, subTasks);

    // 4. 执行子任务
    await this.executeSubTasks(subTasks, taskBoard);

    return taskBoard;
  }

  /**
   * 执行简单任务（不需要拆解）
   */
  private async executeSimpleTask(
    task: string,
    context: DecompositionContext
  ): Promise<TaskBoard> {
    // 创建单个子任务
    const subTask: SubTask = {
      id: "T1",
      title: task,
      description: task,
      status: "pending",
      progress: "0%",
      dependencies: [],
      outputs: [],
      notes: ""
    };

    // 初始化任务看板
    const mainTask: MainTask = {
      title: task,
      objective: task,
      status: "active",
      progress: "0%"
    };

    const taskBoard = await this.progressTracker.initialize(mainTask, [subTask]);

    // 执行子任务
    await this.executeSubTasks([subTask], taskBoard);

    return taskBoard;
  }

  /**
   * 执行子任务列表
   */
  private async executeSubTasks(subTasks: SubTask[], taskBoard: TaskBoard): Promise<void> {
    const executionContext: ExecutionContext = {
      sessionId: this.config.sessionId,
      taskBoard
    };

    // 按依赖关系排序子任务
    const sortedSubTasks = this.sortSubTasksByDependencies(subTasks);

    for (const subTask of sortedSubTasks) {
      // 更新当前焦点
      await this.progressTracker.updateCurrentFocus(
        subTask.id,
        `正在执行子任务: ${subTask.title}`,
        `执行 ${subTask.description}`
      );

      // 更新子任务状态为 active
      await this.progressTracker.updateSubTaskStatus(subTask.id, "active", "0%");

      // 执行子任务
      const result = await this.executeSubTaskWithRetry(subTask, executionContext);

      // 更新子任务状态
      if (result.status === "completed") {
        await this.progressTracker.updateSubTaskStatus(subTask.id, "completed", "100%");
        
        // 更新产出
        subTask.outputs = result.outputs;
        
        // 创建检查点
        await this.progressTracker.createCheckpoint(
          `完成子任务: ${subTask.title}`,
          [`产出: ${result.outputs.join(", ")}`],
          []
        );
      } else if (result.status === "failed") {
        await this.progressTracker.updateSubTaskStatus(subTask.id, "blocked", "失败");
        
        // 添加风险
        await this.progressTracker.addRisk(
          `子任务 ${subTask.id} 失败: ${result.error?.message}`,
          "需要用户介入处理"
        );
        
        // 暂停执行
        break;
      } else if (result.status === "cancelled") {
        await this.progressTracker.updateSubTaskStatus(subTask.id, "skipped", "已取消");
      }
    }

    // 检查是否所有子任务都完成
    const allCompleted = subTasks.every(t => t.status === "completed");
    if (allCompleted) {
      // 更新主任务状态
      taskBoard.mainTask.status = "completed";
      taskBoard.mainTask.progress = "100%";
      
      // 生成任务总结
      await this.generateTaskSummary(taskBoard);
    }
  }

  /**
   * 执行子任务（带重试）
   */
  private async executeSubTaskWithRetry(
    subTask: SubTask,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    let retries = 0;
    let lastError: Error | undefined;

    while (retries <= (this.config.maxRetries || 3)) {
      try {
        const result = await this.executor.execute(subTask, context);
        
        if (result.status === "completed") {
          return result;
        } else if (result.status === "failed") {
          lastError = result.error;
          
          // 如果启用了自动重试，继续重试
          if (this.config.enableAutoRetry && retries < (this.config.maxRetries || 3)) {
            retries++;
            console.log(`重试子任务 ${subTask.id} (第 ${retries} 次)`);
            continue;
          }
          
          // 否则，调用失败处理器
          const decision = await this.failureHandler.handleFailure(subTask, result.error!);
          
          if (decision.action === "retry") {
            retries++;
            continue;
          } else if (decision.action === "skip") {
            return {
              ...result,
              status: "cancelled"
            };
          } else if (decision.action === "modify") {
            // 修改子任务并重试
            if (decision.modifiedTask) {
              Object.assign(subTask, decision.modifiedTask);
              retries++;
              continue;
            }
          } else if (decision.action === "abort") {
            return result;
          }
        }
        
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retries++;
      }
    }

    // 重试次数用尽，返回失败结果
    return {
      subTaskId: subTask.id,
      status: "failed",
      outputs: [],
      error: lastError,
      duration: 0
    };
  }

  /**
   * 按依赖关系排序子任务
   */
  private sortSubTasksByDependencies(subTasks: SubTask[]): SubTask[] {
    const sorted: SubTask[] = [];
    const visited = new Set<string>();

    const visit = (task: SubTask) => {
      if (visited.has(task.id)) {
        return;
      }

      // 先访问依赖的任务
      for (const depId of task.dependencies) {
        const depTask = subTasks.find(t => t.id === depId);
        if (depTask) {
          visit(depTask);
        }
      }

      visited.add(task.id);
      sorted.push(task);
    };

    for (const task of subTasks) {
      visit(task);
    }

    return sorted;
  }

  /**
   * 生成任务总结
   */
  private async generateTaskSummary(taskBoard: TaskBoard): Promise<void> {
    // 收集所有产出
    const allOutputs = taskBoard.subTasks.flatMap(t => t.outputs);
    
    // 收集所有关键决策
    const allDecisions = taskBoard.checkpoints.flatMap(c => c.decisions);
    
    // 创建最终检查点
    await this.progressTracker.createCheckpoint(
      "任务完成",
      [
        `完成了 ${taskBoard.subTasks.length} 个子任务`,
        `产出: ${allOutputs.join(", ")}`,
        ...allDecisions
      ],
      []
    );
  }

  /**
   * 恢复任务
   * @param sessionId 会话 ID
   * @returns 任务看板，如果不存在则返回 null
   */
  async resumeTask(sessionId: string): Promise<TaskBoard | null> {
    // 从持久化存储加载任务看板
    const taskBoard = await this.progressTracker.load(sessionId);
    
    if (!taskBoard) {
      return null;
    }

    // 检查当前焦点
    if (!taskBoard.currentFocus.nextAction) {
      // 如果下一步行动不明确，添加风险
      await this.progressTracker.addRisk(
        "下一步行动不明确",
        "请用户澄清下一步应该做什么"
      );
    }

    return taskBoard;
  }

  /**
   * 获取进度跟踪器
   */
  getProgressTracker(): ProgressTracker {
    return this.progressTracker;
  }
}

/**
 * 创建 Agent Orchestrator 实例
 * @param config Orchestrator 配置
 * @returns Agent Orchestrator 实例
 */
export function createOrchestrator(config: OrchestratorConfig): AgentOrchestrator {
  return new AgentOrchestrator(config);
}
