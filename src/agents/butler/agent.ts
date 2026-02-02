/**
 * 管家层 Agent（栗娜）
 * 
 * 职责：
 * - 理解用户意图
 * - 分解任务为可执行的子任务
 * - 委托任务给任务调度层
 * - 将执行结果以友好的方式反馈给用户
 * 
 * 能力：
 * - 调用独立的系统技能（记忆检索、知识查询等）
 * - 调用任务委托接口
 * - 处理对话前后的任务调度（记忆填充、总结归档）
 */

import type { TaskDelegator } from "./task-delegator.js";
import type { ConversationContext, TaskDelegationRequest } from "../multi-layer/types.js";
import type { IMemoryService, MemoryRetrievalRequest } from "../memory/types.js";
import { generateSessionSummary } from "../session-summary.js";

/**
 * LLM Provider 接口（简化版）
 */
export interface LLMProvider {
  chat(params: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
    userMessage: string;
  }): Promise<string>;
}

/**
 * 技能调用器接口（简化版）
 */
export interface SkillCaller {
  call(skillName: string, parameters: Record<string, unknown>): Promise<unknown>;
}

/**
 * 记忆接口
 */
export interface Memory {
  id: string;
  content: string;
  timestamp: number;
  relevance: number;
}

/**
 * 意图接口
 */
export interface Intent {
  type: "task" | "skill" | "conversation";
  description: string;
  complexity?: "simple" | "complex";
  skillName?: string;
  parameters?: Record<string, unknown>;
}

/**
 * 管家层 Agent
 */
export class ButlerAgent {
  constructor(
    private taskDelegator: TaskDelegator,
    private skillCaller: SkillCaller,
    private llmProvider: LLMProvider,
    private memoryService?: IMemoryService,
  ) {}

  /**
   * 对话前任务调度（记忆填充）
   */
  private async beforeConversation(context: ConversationContext): Promise<void> {
    // 如果没有记忆服务，跳过
    if (!this.memoryService) {
      return;
    }

    try {
      // 获取最后一条用户消息作为查询
      const lastMessage = context.messages[context.messages.length - 1];
      const query = lastMessage?.content || "";

      if (!query) {
        return;
      }

      // 构建检索请求
      const request: MemoryRetrievalRequest = {
        query,
        context: {
          userId: context.userId,
          sessionId: context.sessionId,
          layer: "butler",
        },
      };

      // 检索相关记忆
      const result = await this.memoryService.retrieve(request);

      // 注入到上下文
      if (result.memories.length > 0) {
        (context as any).memories = result.memories;
        (context as any).memoryContext = result.formattedContext;
        console.log(`[ButlerAgent] Retrieved ${result.memories.length} memories in ${result.durationMs}ms`);
      }
    } catch (error) {
      // 记录错误但不影响对话流程
      console.error("[ButlerAgent] Memory retrieval failed:", error);
    }
  }

  /**
   * 对话后任务调度（总结归档）
   */
  private async afterConversation(context: ConversationContext, result: string): Promise<void> {
    // 如果没有记忆服务，跳过
    if (!this.memoryService) {
      return;
    }

    try {
      // 生成会话总结
      // 注意：这里需要将 ConversationContext.messages 转换为 AgentMessage[]
      // 当前简化实现，跳过类型转换
      const summary = generateSessionSummary(context.messages as any);

      if (!summary) {
        console.log("[ButlerAgent] No summary generated, skipping archival");
        return;
      }

      // 异步归档（不等待结果）
      this.memoryService
        .archive({
          summary,
          context: {
            userId: context.userId,
            sessionId: context.sessionId,
          },
        })
        .then((archiveResult) => {
          if (archiveResult.success) {
            console.log(
              `[ButlerAgent] Memory archived to ${archiveResult.path} in ${archiveResult.durationMs}ms`,
            );
          } else {
            console.error(`[ButlerAgent] Memory archival failed: ${archiveResult.error}`);
          }
        })
        .catch((err) => {
          console.error("[ButlerAgent] Memory archival failed:", err);
        });
    } catch (error) {
      // 记录错误但不影响对话流程
      console.error("[ButlerAgent] Memory archival failed:", error);
    }
  }

  /**
   * 理解用户意图
   */
  private async understandIntent(message: string, context: ConversationContext): Promise<Intent> {
    // 使用 LLM 分析用户意图
    const systemPrompt = `你是栗娜，主人的管家。请分析用户的意图，判断是：
1. task（需要执行的任务）
2. skill（需要调用的技能）
3. conversation（普通对话）

如果是任务，判断复杂度（simple/complex）。
如果是技能，识别技能名称。

返回 JSON 格式：
{
  "type": "task" | "skill" | "conversation",
  "description": "任务描述",
  "complexity": "simple" | "complex",
  "skillName": "技能名称",
  "parameters": {}
}`;

    const response = await this.llmProvider.chat({
      systemPrompt,
      messages: context.messages,
      userMessage: message,
    });

    return JSON.parse(response);
  }

  /**
   * 处理任务
   */
  private async handleTask(intent: Intent): Promise<string> {
    const request: TaskDelegationRequest = {
      taskId: `task-${Date.now()}`,
      taskType: intent.complexity || "simple",
      description: intent.description,
      context: intent.parameters,
    };

    const response = await this.taskDelegator.delegate(request);

    if (response.status === "completed") {
      return `任务已完成：${JSON.stringify(response.result)}`;
    } else {
      return `任务失败：${response.error?.message}`;
    }
  }

  /**
   * 处理技能调用
   */
  private async handleSkill(intent: Intent): Promise<string> {
    const result = await this.skillCaller.call(intent.skillName || "", intent.parameters || {});
    return `技能调用结果：${JSON.stringify(result)}`;
  }

  /**
   * 处理普通对话
   */
  private async handleConversation(message: string, context: ConversationContext): Promise<string> {
    const systemPrompt = `你是栗娜，主人的管家。请以友好、专业的方式回复主人。`;

    return this.llmProvider.chat({
      systemPrompt,
      messages: context.messages,
      userMessage: message,
    });
  }

  /**
   * 处理用户消息
   */
  async handleMessage(message: string, context: ConversationContext): Promise<string> {
    // 1. 对话前任务调度（记忆填充）
    await this.beforeConversation(context);

    // 2. 理解用户意图
    const intent = await this.understandIntent(message, context);

    // 3. 根据意图执行操作
    let result: string;
    if (intent.type === "task") {
      result = await this.handleTask(intent);
    } else if (intent.type === "skill") {
      result = await this.handleSkill(intent);
    } else {
      result = await this.handleConversation(message, context);
    }

    // 4. 对话后任务调度（总结归档）
    await this.afterConversation(context, result);

    return result;
  }
}
