/**
 * Clawdbot Agent 系统集成
 * 
 * 将任务分解和跟踪机制集成到 Clawdbot 的 Agent 系统中。
 */

import { createOrchestrator, type OrchestratorConfig } from "./orchestrator.js";
import type { TaskBoard, DecompositionContext } from "./types.js";

/**
 * Agent 任务分解配置
 */
export interface AgentTaskDecompositionConfig {
  /** 是否启用任务分解 */
  enabled?: boolean;
  /** 是否启用并发执行 */
  enableConcurrentExecution?: boolean;
  /** 是否自动重试 */
  enableAutoRetry?: boolean;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 最少子任务数量 */
  minSubTasks?: number;
  /** 最多子任务数量 */
  maxSubTasks?: number;
}

/**
 * Agent 任务分解处理器
 */
export class AgentTaskDecompositionHandler {
  private config: AgentTaskDecompositionConfig;

  constructor(config: AgentTaskDecompositionConfig = {}) {
    this.config = {
      enabled: true,
      enableConcurrentExecution: false,
      enableAutoRetry: false,
      maxRetries: 3,
      minSubTasks: 2,
      maxSubTasks: 8,
      ...config
    };
  }

  /**
   * 处理用户消息，判断是否需要任务分解
   * 
   * @param message 用户消息
   * @param context Agent 上下文
   * @returns 任务看板（如果需要分解）或 null
   */
  async handleMessage(
    message: string,
    context: {
      sessionId: string;
      codebase: string;
      recentMessages: Array<{ role: string; content: string }>;
    }
  ): Promise<TaskBoard | null> {
    // 检查是否启用任务分解
    if (!this.config.enabled) {
      return null;
    }

    // 创建 Orchestrator
    const orchestratorConfig: OrchestratorConfig = {
      sessionId: context.sessionId,
      enableConcurrentExecution: this.config.enableConcurrentExecution,
      enableAutoRetry: this.config.enableAutoRetry,
      maxRetries: this.config.maxRetries
    };

    const orchestrator = createOrchestrator(orchestratorConfig);

    // 检查是否是恢复任务的请求
    if (this.isResumeRequest(message)) {
      return await orchestrator.resumeTask(context.sessionId);
    }

    // 处理任务
    const decompositionContext: DecompositionContext = {
      codebase: context.codebase,
      recentMessages: context.recentMessages
    };

    try {
      const taskBoard = await orchestrator.handleTask(message, decompositionContext);
      return taskBoard;
    } catch (error) {
      console.error("任务分解失败:", error);
      return null;
    }
  }

  /**
   * 判断是否是恢复任务的请求
   */
  private isResumeRequest(message: string): boolean {
    const resumeKeywords = [
      "继续任务",
      "恢复任务",
      "继续上次的任务",
      "resume task",
      "continue task"
    ];

    const lowerMessage = message.toLowerCase();
    return resumeKeywords.some(keyword => lowerMessage.includes(keyword.toLowerCase()));
  }

  /**
   * 格式化任务看板为消息
   * 
   * @param taskBoard 任务看板
   * @returns 格式化的消息
   */
  formatTaskBoardMessage(taskBoard: TaskBoard): string {
    let message = `📋 **任务看板**\n\n`;

    // 主任务
    message += `🎯 **主任务**: ${taskBoard.mainTask.title}\n`;
    message += `   目标: ${taskBoard.mainTask.objective}\n`;
    message += `   状态: ${taskBoard.mainTask.status}\n`;
    message += `   进度: ${taskBoard.mainTask.progress}\n\n`;

    // 子任务列表
    message += `📝 **子任务列表**:\n\n`;
    for (const subTask of taskBoard.subTasks) {
      const statusEmoji = this.getSubTaskStatusEmoji(subTask.status);
      message += `${statusEmoji} **${subTask.id}**: ${subTask.title}\n`;
      message += `   ${subTask.description}\n`;
      message += `   进度: ${subTask.progress}\n`;
      
      if (subTask.dependencies.length > 0) {
        message += `   依赖: ${subTask.dependencies.join(", ")}\n`;
      }
      
      if (subTask.outputs.length > 0) {
        message += `   产出: ${subTask.outputs.join(", ")}\n`;
      }
      
      message += `\n`;
    }

    // 当前焦点
    if (taskBoard.currentFocus.taskId) {
      message += `🎯 **当前焦点**: ${taskBoard.currentFocus.taskId}\n`;
      message += `   ${taskBoard.currentFocus.reasoningSummary}\n`;
      message += `   下一步: ${taskBoard.currentFocus.nextAction}\n\n`;
    }

    // 风险和阻塞
    if (taskBoard.risksAndBlocks.length > 0) {
      message += `⚠️ **风险和阻塞**:\n\n`;
      for (const risk of taskBoard.risksAndBlocks) {
        message += `⚠️ ${risk.description}\n`;
        message += `   缓解: ${risk.mitigation}\n\n`;
      }
    }

    // 任务看板文件位置
    message += `\n📁 任务看板已保存到: \`~/.clawdbot/tasks/${taskBoard.sessionId}/\`\n`;
    message += `   - JSON 格式: \`TASK_BOARD.json\`\n`;
    message += `   - Markdown 格式: \`TASK_BOARD.md\`\n`;

    return message;
  }

  /**
   * 获取子任务状态表情符号
   */
  private getSubTaskStatusEmoji(status: string): string {
    switch (status) {
      case "pending":
        return "⏳";
      case "active":
        return "🔄";
      case "completed":
        return "✅";
      case "blocked":
        return "🚫";
      case "skipped":
        return "⏭️";
      default:
        return "⚪";
    }
  }
}

/**
 * 创建 Agent 任务分解处理器
 * 
 * @param config 配置
 * @returns 处理器实例
 */
export function createAgentTaskDecompositionHandler(
  config?: AgentTaskDecompositionConfig
): AgentTaskDecompositionHandler {
  return new AgentTaskDecompositionHandler(config);
}
