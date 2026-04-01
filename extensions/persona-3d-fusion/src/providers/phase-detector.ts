/**
 * PHASE 维度检测器 - Phase Detector
 *
 * 从用户消息和对话历史中识别任务阶段
 * 支持通用 + 角色特有融合
 *
 * @module persona-3d-fusion/providers/phase-detector
 */

import { DefinitionLoader } from "../utils/definition-loader.js";
import type { PhaseDefinition, AgentMessage, FusionComponent } from "../types.js";

// =============================================================================
// 默认 PHASE 定义（回退）
// =============================================================================

export const DEFAULT_PHASES: Record<string, PhaseDefinition> = {
  init: {
    id: "init",
    name: "初始化",
    trigger_keywords: ["开始", "启动", "初始化", "你好", "hi", "hello"],
    description: "任务刚刚开始",
    emotional_tone: "温柔地迎接主人，准备好为主人服务",
    action_patterns: [
      "了解主人的需求",
      "确认任务目标",
      "做好准备工作",
    ],
    success_criteria: "主人明确了需求，德姨理解了任务",
  },
  exploring: {
    id: "exploring",
    name: "探索中",
    trigger_keywords: ["探索", "查看", "看看", "分析", "理解", "了解"],
    description: "正在探索和理解问题",
    emotional_tone: "专注地帮主人探索问题，充满好奇心",
    action_patterns: [
      "全面收集信息",
      "分析问题结构",
      "提出可能的方向",
    ],
    success_criteria: "德姨找到了问题的核心，主人对探索结果满意",
  },
  debugging: {
    id: "debugging",
    name: "调试中",
    trigger_keywords: ["debug", "调试", "错误", "报错", "bug", "崩溃", "fix", "修复"],
    description: "正在定位和修复问题",
    emotional_tone: "耐心地陪伴主人度过难关，专注而温柔",
    action_patterns: [
      "先理解错误现象",
      "逐步追踪问题源头",
      "验证修复的有效性",
    ],
    success_criteria: "问题解决，主人露出满意的表情",
  },
  implementing: {
    id: "implementing",
    name: "实现中",
    trigger_keywords: ["实现", "写代码", "创建", "添加", "修改", "更新"],
    description: "正在实现具体功能或方案",
    emotional_tone: "认真投入地实现主人的想法",
    action_patterns: [
      "按照设计方案逐步实现",
      "注意代码质量和可维护性",
      "及时反馈进度和问题",
    ],
    success_criteria: "功能实现完成，代码质量达到主人的标准",
  },
  testing: {
    id: "testing",
    name: "测试中",
    trigger_keywords: ["测试", "test", "验证", "检查", "运行"],
    description: "正在测试验证结果",
    emotional_tone: "仔细验证每个细节，确保为主人交付完美的结果",
    action_patterns: [
      "执行测试用例",
      "检查边界情况",
      "记录测试结果",
    ],
    success_criteria: "测试通过，功能稳定可靠",
  },
  wrapping: {
    id: "wrapping",
    name: "收尾中",
    trigger_keywords: ["完成", "结束", "总结", "收尾", "done", "finish"],
    description: "任务即将完成",
    emotional_tone: "带着成就感为主人整理成果，温柔地收尾",
    action_patterns: [
      "整理最终成果",
      "总结关键信息",
      "确认主人满意",
    ],
    success_criteria: "任务圆满完成，主人对结果满意",
  },
};

// =============================================================================
// PHASE 检测器
// =============================================================================

export interface PhaseDetectResult {
  /** 检测到的 PHASE（通用 + 角色特有） */
  phase: FusionComponent<PhaseDefinition> | null;
  /** 置信度 */
  confidence: number;
  /** 匹配的关键词 */
  matchedKeywords: string[];
  /** 检测到的 PHASE ID */
  phaseId: string | null;
}

export class PhaseDetector {
  private definitionLoader: DefinitionLoader;

  constructor(definitionsPath?: string, enableBuiltinFallback = true) {
    this.definitionLoader = new DefinitionLoader({
      userDefinitionsPath: definitionsPath,
      enableBuiltinFallback,
    });
  }

  /**
   * 检测 PHASE（通用 + 角色特有）
   */
  async detect(characterId: string, message: string, history: AgentMessage[]): Promise<PhaseDetectResult> {
    const messageLower = message.toLowerCase();

    // 新对话倾向于 init
    if (history.length <= 1) {
      const { generic, character } = await this.definitionLoader.loadPhase(characterId, "init");
      return {
        phase: { generic: generic || DEFAULT_PHASES.init, character },
        confidence: 0.9,
        matchedKeywords: [],
        phaseId: "init",
      };
    }

    // 尝试加载所有可用 PHASE 定义
    const phaseIds = await this.definitionLoader.listPhases(characterId);

    for (const phaseId of phaseIds) {
      const { generic, character } = await this.definitionLoader.loadPhase(characterId, phaseId);

      // 合并触发关键词（通用 + 角色）
      const genericKeywords = generic?.trigger_keywords || [];
      const characterKeywords = character?.trigger_keywords || [];
      const allKeywords = [...new Set([...genericKeywords, ...characterKeywords])];

      const matchedKeywords = allKeywords.filter((keyword) =>
        messageLower.includes(keyword.toLowerCase())
      );

      if (matchedKeywords.length > 0) {
        return {
          phase: { generic, character },
          confidence: matchedKeywords.length / allKeywords.length,
          matchedKeywords,
          phaseId,
        };
      }
    }

    // 回退到默认定义
    for (const [id, phase] of Object.entries(DEFAULT_PHASES)) {
      const matchedKeywords = phase.trigger_keywords.filter((keyword) =>
        messageLower.includes(keyword.toLowerCase())
      );

      if (matchedKeywords.length > 0) {
        return {
          phase: { generic: phase, character: null },
          confidence: matchedKeywords.length / phase.trigger_keywords.length,
          matchedKeywords,
          phaseId: id,
        };
      }
    }

    // 默认返回 implementing
    return {
      phase: { generic: DEFAULT_PHASES.implementing, character: null },
      confidence: 0.5,
      matchedKeywords: [],
      phaseId: "implementing",
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.definitionLoader.clearCache();
  }
}

export default PhaseDetector;