/**
 * Lina Agent - 人格化 AI 助手
 * 基于配置文件驱动的角色定义，复用 Butler 的所有能力
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadCharacterConfig, loadCharacterProfile } from "./config/loader.js";
import {
  generateSystemPrompt,
  type SystemPromptContext,
} from "./prompts/system-prompt-generator.js";
import {
  routeCapability,
  logRoutingDecision,
  getCapabilityDescription,
  type RoutingContext,
} from "./routing/capability-router.js";

// 复用 Butler 的能力
import type { TaskDelegator } from "../butler/task-delegator.js";
import type { IMemoryService } from "../memory/types.js";

const log = createSubsystemLogger("lina");

export interface LinaAgentConfig {
  characterName: string;
  basePath?: string;
  taskDelegator?: TaskDelegator;
  memoryService?: IMemoryService;
}

export interface LinaAgentContext {
  userMessage: string;
  userName?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

export interface LinaAgentResponse {
  message: string;
  capability: string;
  metadata?: {
    routing: {
      capability: string;
      confidence: number;
      reason: string;
    };
    systemPrompt?: string;
  };
}

/**
 * Lina Agent 主类
 */
export class LinaAgent {
  private characterName: string;
  private basePath: string;
  private taskDelegator?: TaskDelegator;
  private memoryService?: IMemoryService;

  // 缓存的配置
  private config?: Awaited<ReturnType<typeof loadCharacterConfig>>;
  private profile?: Awaited<ReturnType<typeof loadCharacterProfile>>;
  private systemPrompt?: string;

  constructor(config: LinaAgentConfig) {
    this.characterName = config.characterName;
    this.basePath = config.basePath || process.cwd();
    this.taskDelegator = config.taskDelegator;
    this.memoryService = config.memoryService;
  }

  /**
   * 初始化 Agent（加载配置）
   */
  async initialize(): Promise<void> {
    log.info(`[LinaAgent] 初始化角色: ${this.characterName}`);

    // 加载配置和档案
    this.config = await loadCharacterConfig(this.characterName, this.basePath);
    this.profile = await loadCharacterProfile(this.characterName, this.basePath);

    // 生成 System Prompt
    const promptContext: SystemPromptContext = {
      config: this.config,
      profile: this.profile,
      currentDate: new Date().toLocaleDateString("zh-CN"),
    };

    this.systemPrompt = generateSystemPrompt(promptContext);

    log.info(`[LinaAgent] 初始化完成: ${this.characterName} v${this.config.version}`);
  }

  /**
   * 处理用户消息
   */
  async handleMessage(context: LinaAgentContext): Promise<LinaAgentResponse> {
    if (!this.config || !this.profile) {
      throw new Error("Agent not initialized. Call initialize() first.");
    }

    const { userMessage, userName, conversationHistory } = context;

    log.info(`[LinaAgent] 处理消息: ${userMessage.substring(0, 50)}...`);

    // 1. 路由到对应能力
    const routingContext: RoutingContext = {
      userMessage,
      config: this.config,
      conversationHistory,
    };

    const routingResult = routeCapability(routingContext);
    logRoutingDecision(routingResult);

    // 2. 根据路由结果调用对应能力
    let responseMessage: string;

    switch (routingResult.capability) {
      case "task_management":
        responseMessage = await this.handleTaskManagement(userMessage);
        break;

      case "memory_service":
        responseMessage = await this.handleMemoryService(userMessage);
        break;

      case "daily_planning":
        responseMessage = await this.handleDailyPlanning(userMessage);
        break;

      case "general":
      default:
        responseMessage = await this.handleGeneralConversation(userMessage, userName);
        break;
    }

    return {
      message: responseMessage,
      capability: getCapabilityDescription(routingResult.capability),
      metadata: {
        routing: routingResult,
        systemPrompt: this.systemPrompt,
      },
    };
  }

  /**
   * 处理任务管理请求
   */
  private async handleTaskManagement(userMessage: string): Promise<string> {
    if (!this.taskDelegator) {
      return "抱歉，任务管理功能暂未配置。请联系管理员启用 TaskDelegator。";
    }

    log.info(`[LinaAgent] 调用 TaskDelegator: ${userMessage}`);

    // 调用 Butler 的 TaskDelegator
    // 这里需要根据 TaskDelegator 的实际接口调整
    // 暂时返回占位符
    return `[TaskDelegator] 正在处理任务请求: ${userMessage}`;
  }

  /**
   * 处理记忆服务请求
   */
  private async handleMemoryService(userMessage: string): Promise<string> {
    if (!this.memoryService) {
      return "抱歉，记忆服务暂未配置。请联系管理员启用 MemoryService。";
    }

    log.info(`[LinaAgent] 调用 MemoryService: ${userMessage}`);

    // 调用 Butler 的 MemoryService
    // 这里需要根据 MemoryService 的实际接口调整
    // 暂时返回占位符
    return `[MemoryService] 正在处理记忆请求: ${userMessage}`;
  }

  /**
   * 处理日程规划请求
   */
  private async handleDailyPlanning(userMessage: string): Promise<string> {
    log.info(`[LinaAgent] 处理日程规划: ${userMessage}`);

    // 日程规划功能暂未实现
    return `[日程规划] 正在处理日程请求: ${userMessage}`;
  }

  /**
   * 处理通用对话
   */
  private async handleGeneralConversation(
    userMessage: string,
    userName?: string
  ): Promise<string> {
    log.info(`[LinaAgent] 通用对话: ${userMessage}`);

    // 使用角色人格进行自然对话
    // 这里可以调用 LLM，传入 systemPrompt
    // 暂时返回简单响应
    const greeting = userName ? `${userName}，` : "";
    return `${greeting}我是 ${this.config!.name}。${userMessage}`;
  }

  /**
   * 获取 System Prompt
   */
  getSystemPrompt(): string | undefined {
    return this.systemPrompt;
  }

  /**
   * 获取角色配置
   */
  getConfig() {
    return this.config;
  }

  /**
   * 获取角色档案
   */
  getProfile() {
    return this.profile;
  }
}

/**
 * 创建 Lina Agent 实例
 */
export async function createLinaAgent(
  config: LinaAgentConfig
): Promise<LinaAgent> {
  const agent = new LinaAgent(config);
  await agent.initialize();
  return agent;
}
