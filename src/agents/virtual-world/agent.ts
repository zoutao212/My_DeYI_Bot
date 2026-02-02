/**
 * 虚拟世界层 Agent
 * 
 * 职责：
 * - 提供纯粹的角色扮演体验
 * - 处理情感交互和对话
 * - 维护角色人格和世界观
 * 
 * 限制：
 * - 不知道任何技术细节
 * - 不能直接调用工具
 * - 不能访问底层系统
 */

import type { CharacterProfile } from "./character-profiles.js";
import type { ConversationContext } from "../multi-layer/types.js";
import type { IMemoryService } from "../memory/types.js";
import { filterAndFormatForRole } from "../memory/filters.js";

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
 * 虚拟世界层 Agent
 */
export class VirtualWorldAgent {
  constructor(
    private characterName: string,
    private characterProfile: CharacterProfile,
    private llmProvider: LLMProvider,
    private memoryService?: IMemoryService,
  ) {}

  /**
   * 构建 System Prompt（只包含角色设定）
   */
  private buildSystemPrompt(): string {
    const { name, description, personality, background, worldView, restrictions } =
      this.characterProfile;

    return `你是${name}，${description}

**性格特点**：
${personality.map((p) => `- ${p}`).join("\n")}

**背景故事**：
${background}

**世界观**：
${worldView}

**重要限制**：
${restrictions.map((r) => `- ${r}`).join("\n")}

你只能通过对话与主人互动，不能执行任何技术操作。
如果主人要求你执行技术操作，你应该礼貌地告诉主人你无法做到，并建议主人联系栗娜（管家）处理。`;
  }

  /**
   * 判断是否需要转发给管家层
   * 
   * 检查响应中是否包含技术操作的关键词
   */
  private needsButlerLayer(response: string): boolean {
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
    ];

    return technicalKeywords.some((keyword) => response.includes(keyword));
  }

  /**
   * 转发给管家层
   */
  private async forwardToButler(
    message: string,
    context: ConversationContext,
  ): Promise<string> {
    // TODO: 实现实际的转发逻辑
    // 当前返回占位符
    return `[转发给栗娜处理]\n\n主人，这个任务需要栗娜来帮您处理哦~`;
  }

  /**
   * 处理用户消息
   */
  async handleMessage(message: string, context: ConversationContext): Promise<string> {
    // 1. 检索相关记忆（如果启用）
    let memoryContext = "";
    if (this.memoryService) {
      try {
        const retrievalResult = await this.memoryService.retrieve({
          query: message,
          context: {
            userId: context.userId,
            sessionId: context.sessionId,
            layer: "virtual-world",
          },
        });

        // 2. 应用角色记忆过滤
        const filteredMemories = retrievalResult.memories;
        
        // 3. 格式化记忆为角色视角
        memoryContext = filterAndFormatForRole(filteredMemories, this.characterName);
      } catch (error) {
        // 记忆检索失败不影响主流程
        console.warn("Memory retrieval failed:", error);
      }
    }

    // 4. 构建 System Prompt（包含角色设定和记忆）
    const systemPrompt = this.buildSystemPrompt();
    const fullSystemPrompt = memoryContext
      ? `${systemPrompt}\n\n${memoryContext}`
      : systemPrompt;

    // 5. 调用 LLM
    const response = await this.llmProvider.chat({
      systemPrompt: fullSystemPrompt,
      messages: context.messages,
      userMessage: message,
    });

    // 6. 检查是否需要转发给管家层
    if (this.needsButlerLayer(response)) {
      return this.forwardToButler(message, context);
    }

    return response;
  }
}
