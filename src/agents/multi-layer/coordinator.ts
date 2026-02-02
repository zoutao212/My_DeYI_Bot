/**
 * 多层架构协调器
 * 
 * 负责管理各层之间的通信和切换
 */

import type { VirtualWorldAgent } from "../virtual-world/agent.js";
import type { ButlerAgent } from "../butler/agent.js";
import type { IExecutor } from "../execution/types.js";
import type { IMemoryService } from "../memory/types.js";
import type { ConversationContext, AgentLayer } from "./types.js";

/**
 * 层次消息
 */
export interface LayerMessage {
  /** 消息内容 */
  content: string;
  /** 目标层次 */
  targetLayer?: AgentLayer;
  /** 上下文 */
  context: ConversationContext;
}

/**
 * 层次响应
 */
export interface LayerResponse {
  /** 响应内容 */
  content: string;
  /** 当前层次 */
  currentLayer: AgentLayer;
  /** 是否需要切换层次 */
  needsSwitch?: boolean;
  /** 目标层次 */
  targetLayer?: AgentLayer;
  /** 切换原因 */
  switchReason?: string;
}

/**
 * 协调器配置
 */
export interface CoordinatorConfig {
  /** 默认层次 */
  defaultLayer?: AgentLayer;
  /** 是否启用自动切换 */
  enableAutoSwitch?: boolean;
  /** 是否启用日志 */
  enableLogging?: boolean;
  /** 日志级别 */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** 记忆服务 */
  memoryService?: IMemoryService | null;
}

/**
 * 多层架构协调器
 */
export class MultiLayerCoordinator {
  private config: CoordinatorConfig;
  private currentLayer: AgentLayer;
  private layerStack: AgentLayer[] = [];
  private memoryService: IMemoryService | null;

  constructor(
    private virtualWorldAgent: VirtualWorldAgent | null,
    private butlerAgent: ButlerAgent | null,
    private toolExecutor: IExecutor | null,
    private skillExecutor: IExecutor | null,
    config?: CoordinatorConfig,
  ) {
    this.config = {
      defaultLayer: "execution",
      enableAutoSwitch: true,
      enableLogging: true,
      logLevel: "info",
      ...config,
    };

    this.currentLayer = this.config.defaultLayer || "execution";
    this.memoryService = this.config.memoryService || null;

    if (this.config.enableLogging) {
      console.log("[Coordinator] Initialized", {
        defaultLayer: this.currentLayer,
        memoryEnabled: !!this.memoryService,
      });
    }
  }

  /**
   * 处理消息
   */
  async handleMessage(message: LayerMessage): Promise<LayerResponse> {
    // 1. 确定目标层次
    const targetLayer = message.targetLayer || this.determineLayer(message);

    // 2. 切换到目标层次（如果需要）
    if (targetLayer !== this.currentLayer) {
      await this.switchLayer(targetLayer);
    }

    // 3. 在当前层次处理消息
    const response = await this.processInCurrentLayer(message);

    // 4. 检查是否需要切换层次
    const switchInfo = this.checkLayerSwitch(response);

    return {
      content: response,
      currentLayer: this.currentLayer,
      needsSwitch: switchInfo.needsSwitch,
      targetLayer: switchInfo.targetLayer,
      switchReason: switchInfo.switchReason,
    };
  }

  /**
   * 确定应该使用哪个层次
   */
  private determineLayer(message: LayerMessage): AgentLayer {
    const content = message.content.toLowerCase();

    // 检查是否包含技术操作关键词
    const technicalKeywords = [
      "写入文件",
      "读取文件",
      "执行命令",
      "搜索",
      "创建文件",
      "删除文件",
      "修改文件",
      "查找",
      "运行",
      "编译",
      "构建",
      "测试",
      "grep",
      "exec",
      "read",
      "write",
    ];

    const hasTechnicalKeyword = technicalKeywords.some((keyword) =>
      content.includes(keyword.toLowerCase()),
    );

    if (hasTechnicalKeyword) {
      // 如果有技术关键词，使用管家层或执行层
      return this.butlerAgent ? "butler" : "execution";
    }

    // 检查是否是角色扮演对话
    const rolePlayKeywords = ["聊天", "对话", "陪我", "讲故事", "心情", "感觉"];

    const hasRolePlayKeyword = rolePlayKeywords.some((keyword) =>
      content.includes(keyword),
    );

    if (hasRolePlayKeyword && this.virtualWorldAgent) {
      return "virtual-world";
    }

    // 默认使用当前层次
    return this.currentLayer;
  }

  /**
   * 切换层次
   */
  private async switchLayer(targetLayer: AgentLayer): Promise<void> {
    if (this.config.enableLogging) {
      console.log(`[Coordinator] Switching from ${this.currentLayer} to ${targetLayer}`);
    }

    // 保存当前层次到栈
    this.layerStack.push(this.currentLayer);

    // 切换到目标层次
    this.currentLayer = targetLayer;
  }

  /**
   * 在当前层次处理消息
   */
  private async processInCurrentLayer(message: LayerMessage): Promise<string> {
    switch (this.currentLayer) {
      case "virtual-world":
        if (!this.virtualWorldAgent) {
          throw new Error("Virtual world agent not available");
        }
        return this.virtualWorldAgent.handleMessage(message.content, message.context);

      case "butler":
        if (!this.butlerAgent) {
          throw new Error("Butler agent not available");
        }
        return this.butlerAgent.handleMessage(message.content, message.context);

      case "execution":
        // 执行层直接返回消息（实际应该调用现有的 Pi Agent）
        return `[执行层] 处理消息: ${message.content}`;

      default:
        throw new Error(`Unknown layer: ${this.currentLayer}`);
    }
  }

  /**
   * 检查是否需要切换层次
   */
  private checkLayerSwitch(response: string): {
    needsSwitch: boolean;
    targetLayer?: AgentLayer;
    switchReason?: string;
  } {
    // 检查响应中是否包含切换提示
    if (response.includes("[转发给栗娜处理]")) {
      return {
        needsSwitch: true,
        targetLayer: "butler",
        switchReason: "Virtual world agent forwarding to butler",
      };
    }

    if (response.includes("[委托任务]")) {
      return {
        needsSwitch: true,
        targetLayer: "execution",
        switchReason: "Butler agent delegating task",
      };
    }

    return { needsSwitch: false };
  }

  /**
   * 回退到上一层
   */
  async popLayer(): Promise<void> {
    if (this.layerStack.length === 0) {
      if (this.config.enableLogging) {
        console.warn("[Coordinator] No layer to pop, staying in current layer");
      }
      return;
    }

    const previousLayer = this.layerStack.pop()!;

    if (this.config.enableLogging) {
      console.log(`[Coordinator] Popping back to ${previousLayer}`);
    }

    this.currentLayer = previousLayer;
  }

  /**
   * 获取当前层次
   */
  getCurrentLayer(): AgentLayer {
    return this.currentLayer;
  }

  /**
   * 获取层次栈
   */
  getLayerStack(): AgentLayer[] {
    return [...this.layerStack];
  }

  /**
   * 重置协调器
   */
  reset(): void {
    this.currentLayer = this.config.defaultLayer || "execution";
    this.layerStack = [];
  }

  /**
   * 获取记忆服务
   */
  getMemoryService(): IMemoryService | null {
    return this.memoryService;
  }

  /**
   * 获取记忆服务状态
   */
  getMemoryStatus(): { enabled: boolean; available: boolean } {
    if (!this.memoryService) {
      return { enabled: false, available: false };
    }

    const status = this.memoryService.status();
    return {
      enabled: status.enabled,
      available: status.retrieval.available && status.archival.available,
    };
  }
}
