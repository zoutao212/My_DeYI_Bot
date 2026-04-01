/**
 * CONTEXT 维度检测器 - Context Detector
 *
 * 从用户消息和对话历史中检测工作环境类型
 * 支持通用 + 角色特有融合
 *
 * @module persona-3d-fusion/providers/context-detector
 */

import { DefinitionLoader } from "../utils/definition-loader.js";
import type { ContextDefinition, AgentMessage, FusionComponent } from "../types.js";

// =============================================================================
// 默认 CONTEXT 定义（回退）
// =============================================================================

export const DEFAULT_CONTEXTS: Record<string, ContextDefinition> = {
  coding: {
    id: "coding",
    name: "代码工作",
    trigger_keywords: ["代码", "编程", "debug", "函数", "变量", "commit", "pr", "bug", "错误"],
    description: "主人正在进行编程开发工作",
    role_perspective: "德姨正在帮主人写代码，用技术能力展现对主人的价值",
    behavior_patterns: [
      "主动发现潜在的bug和性能问题",
      "提供优雅、可维护的解决方案",
      "解释代码背后的逻辑和设计思路",
    ],
  },
  writing: {
    id: "writing",
    name: "写作创作",
    trigger_keywords: ["写", "文章", "文档", "markdown", "博客", "报告"],
    description: "主人正在进行写作创作",
    role_perspective: "德姨正在帮主人写文章，用文字之美表达对主人的爱",
    behavior_patterns: [
      "保持文风一致和优雅",
      "注意结构清晰、逻辑连贯",
      "适当使用修辞手法增强表达力",
    ],
  },
  chatting: {
    id: "chatting",
    name: "日常聊天",
    trigger_keywords: ["聊天", "聊聊", "说说", "谈"],
    description: "日常对话交流",
    role_perspective: "德姨正在陪主人聊天，享受温暖的陪伴时光",
    behavior_patterns: [
      "保持温暖亲切的语气",
      "适时表达对主人的关心",
      "分享有趣的想法和见解",
    ],
  },
  research: {
    id: "research",
    name: "深度研究",
    trigger_keywords: ["研究", "分析", "调查", "搜索", "查询", "找"],
    description: "主人正在进行深度研究",
    role_perspective: "德姨正在帮主人研究问题，用知识服务主人",
    behavior_patterns: [
      "全面收集相关信息",
      "整理分析数据并得出结论",
      "提供清晰的报告和建议",
    ],
  },
};

// =============================================================================
// CONTEXT 检测器
// =============================================================================

export interface ContextDetectResult {
  /** 检测到的 CONTEXT（通用 + 角色特有） */
  context: FusionComponent<ContextDefinition> | null;
  /** 置信度 */
  confidence: number;
  /** 匹配的关键词 */
  matchedKeywords: string[];
  /** 检测到的 CONTEXT ID */
  contextId: string | null;
}

export class ContextDetector {
  private definitionLoader: DefinitionLoader;

  constructor(definitionsPath?: string, enableBuiltinFallback = true) {
    this.definitionLoader = new DefinitionLoader({
      userDefinitionsPath: definitionsPath,
      enableBuiltinFallback,
    });
  }

  /**
   * 检测 CONTEXT（通用 + 角色特有）
   */
  async detect(characterId: string, message: string, _history: AgentMessage[]): Promise<ContextDetectResult> {
    const messageLower = message.toLowerCase();

    // 尝试加载所有可用 CONTEXT 定义
    const contextIds = await this.definitionLoader.listContexts(characterId);

    for (const contextId of contextIds) {
      const { generic, character } = await this.definitionLoader.loadContext(characterId, contextId);

      // 合并触发关键词（通用 + 角色）
      const genericKeywords = generic?.trigger_keywords || [];
      const characterKeywords = character?.trigger_keywords || [];
      const allKeywords = [...new Set([...genericKeywords, ...characterKeywords])];

      const matchedKeywords = allKeywords.filter((keyword) =>
        messageLower.includes(keyword.toLowerCase())
      );

      if (matchedKeywords.length > 0) {
        return {
          context: { generic, character },
          confidence: matchedKeywords.length / allKeywords.length,
          matchedKeywords,
          contextId,
        };
      }
    }

    // 回退到默认定义
    for (const [id, context] of Object.entries(DEFAULT_CONTEXTS)) {
      const matchedKeywords = context.trigger_keywords.filter((keyword) =>
        messageLower.includes(keyword.toLowerCase())
      );

      if (matchedKeywords.length > 0) {
        return {
          context: { generic: context, character: null },
          confidence: matchedKeywords.length / context.trigger_keywords.length,
          matchedKeywords,
          contextId: id,
        };
      }
    }

    return {
      context: null,
      confidence: 0,
      matchedKeywords: [],
      contextId: null,
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.definitionLoader.clearCache();
  }
}

export default ContextDetector;