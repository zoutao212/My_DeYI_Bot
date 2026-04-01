/**
 * 三维融合引擎 - Fusion Engine
 *
 * 核心组件：负责将 SOUL、CONTEXT、PHASE 三个维度融合成最终的 prompt
 * 使用国际化模板，支持多语言提示词
 *
 * @module persona-3d-fusion/fusion-engine
 */

import { SoulProvider, DEFAULT_SOUL } from "./providers/soul-provider.js";
import { ContextDetector, DEFAULT_CONTEXTS } from "./providers/context-detector.js";
import { PhaseDetector, DEFAULT_PHASES } from "./providers/phase-detector.js";
import { fillTemplate, fillTemplateArray, type SupportedLanguage } from "./fusion-engine.l10n.types.js";
import { FUSION_ENGINE_ZH } from "./fusion-engine.l10n.zh.js";
import { FUSION_ENGINE_EN } from "./fusion-engine.l10n.en.js";
import type {
  SoulDefinition,
  ContextDefinition,
  PhaseDefinition,
  FusionResult,
  AgentMessage,
  FusionComponent,
} from "./types.js";

// =============================================================================
// L10n 选择器
// =============================================================================

const L10N_MAP: Record<SupportedLanguage, typeof FUSION_ENGINE_ZH> = {
  zh: FUSION_ENGINE_ZH,
  en: FUSION_ENGINE_EN,
};

// =============================================================================
// 融合请求
// =============================================================================

/**
 * 融合请求参数
 */
export interface FusionRequest {
  /** SOUL ID */
  soulId: string;
  /** 用户消息 */
  userMessage: string;
  /** 对话历史 */
  conversationHistory?: AgentMessage[];
  /** 是否启用 CONTEXT 检测 */
  enableContextDetection?: boolean;
  /** 是否启用 PHASE 检测 */
  enablePhaseDetection?: boolean;
  /** 语言 */
  language?: SupportedLanguage;
}

// =============================================================================
// 融合引擎
// =============================================================================

/**
 * 三维融合引擎
 */
export class FusionEngine {
  private soulProvider: SoulProvider;
  private contextDetector: ContextDetector;
  private phaseDetector: PhaseDetector;
  private language: SupportedLanguage;

  constructor(
    soulProvider: SoulProvider,
    contextDetector: ContextDetector,
    phaseDetector: PhaseDetector,
    language: SupportedLanguage = "zh",
  ) {
    this.soulProvider = soulProvider;
    this.contextDetector = contextDetector;
    this.phaseDetector = phaseDetector;
    this.language = language;
  }

  /**
   * 设置语言
   */
  setLanguage(language: SupportedLanguage): void {
    this.language = language;
  }

  /**
   * 获取当前语言的 L10n 配置
   */
  private getL10n() {
    return L10N_MAP[this.language] || FUSION_ENGINE_ZH;
  }

  /**
   * 执行三维融合
   */
  async fuse(request: FusionRequest): Promise<FusionResult> {
    const {
      soulId,
      userMessage,
      conversationHistory = [],
      enableContextDetection = true,
      enablePhaseDetection = true,
      language = this.language,
    } = request;

    // 临时设置语言
    const originalLanguage = this.language;
    this.language = language;

    // 1. 加载 SOUL 定义
    const soul = await this.soulProvider.load(soulId) || DEFAULT_SOUL;

    // 2. 检测 CONTEXT
    let context: ContextDefinition | null = null;
    if (enableContextDetection) {
      const contextResult = await this.contextDetector.detect(userMessage, conversationHistory);
      context = contextResult.context;

      // 如果没有找到自定义 CONTEXT，尝试使用内置的
      if (!context) {
        context = this.findBuiltinContext(userMessage);
      }
    }

    // 3. 识别 PHASE
    let phase: PhaseDefinition | null = null;
    if (enablePhaseDetection) {
      const phaseResult = await this.phaseDetector.detect(userMessage, conversationHistory);
      phase = phaseResult.phase;

      // 如果没有找到自定义 PHASE，尝试使用内置的
      if (!phase) {
        phase = this.findBuiltinPhase(userMessage, conversationHistory);
      }
    }

    // 4. 生成融合 prompt
    const { fusedPrompt, reasoning } = this.compose(soul, context, phase, userMessage);

    // 恢复原始语言
    this.language = originalLanguage;

    return {
      soul,
      context,
      phase,
      fusedPrompt,
      reasoning,
    };
  }

  /**
   * 查找内置 CONTEXT
   */
  private findBuiltinContext(message: string): ContextDefinition | null {
    const messageLower = message.toLowerCase();

    for (const context of Object.values(DEFAULT_CONTEXTS)) {
      for (const keyword of context.trigger_keywords) {
        if (messageLower.includes(keyword.toLowerCase())) {
          return context;
        }
      }
    }

    return null;
  }

  /**
   * 查找内置 PHASE
   */
  private findBuiltinPhase(message: string, history: AgentMessage[]): PhaseDefinition | null {
    const messageLower = message.toLowerCase();

    // 如果是新对话，倾向于 init
    if (history.length <= 1) {
      return DEFAULT_PHASES.init;
    }

    for (const phase of Object.values(DEFAULT_PHASES)) {
      for (const keyword of phase.trigger_keywords) {
        if (messageLower.includes(keyword.toLowerCase())) {
          return phase;
        }
      }
    }

    // 默认返回 implementing
    return DEFAULT_PHASES.implementing;
  }

  /**
   * 组合三维定义生成最终 prompt（使用国际化模板）
   */
  private compose(
    soul: SoulDefinition,
    context: ContextDefinition | null,
    phase: PhaseDefinition | null,
    originalMessage?: string,
  ): { fusedPrompt: string; reasoning: string } {
    const l10n = this.getL10n();
    const parts: string[] = [];
    const reasoningParts: string[] = [];

    // === 第一部分：SOUL（身份基础）===
    parts.push(this.composeSoulSection(soul, l10n));
    reasoningParts.push(`使用 SOUL: ${soul.name}`);

    // === 第二部分：CONTEXT（工作环境）===
    if (context) {
      parts.push(this.composeContextSection(context, l10n));
      reasoningParts.push(`检测到 CONTEXT: ${context.name}`);
    }

    // === 第三部分：PHASE（任务阶段）===
    if (phase) {
      parts.push(this.composePhaseSection(phase, l10n));
      reasoningParts.push(`识别到 PHASE: ${phase.name}`);
    }

    // === 融合指令 ===
    parts.push("");
    parts.push(l10n.fusionSeparator);
    parts.push(l10n.fusionInstruction);

    // === 组合 ===
    const fusedPrompt = parts.join("\n\n");
    const reasoning = reasoningParts.join(" | ");

    return { fusedPrompt, reasoning };
  }

  /**
   * 组合 SOUL 部分（使用国际化模板）
   */
  private composeSoulSection(soul: SoulDefinition, l10n: typeof FUSION_ENGINE_ZH): string {
    const lines: string[] = [];

    // 身份标题
    lines.push(fillTemplate(l10n.soulIdentityTitle, { name: soul.name }));
    lines.push("");

    // 身份介绍
    lines.push(fillTemplate(l10n.soulIdentityIntro, {
      addressSelf: soul.address_self || soul.name,
      addressUser: soul.address_user,
      roleType: "爱姬",
    }));

    // 核心人格
    lines.push(fillTemplate(l10n.soulTraitsLabel, {
      traits: soul.personality_traits.join("、"),
    }));

    // 说话风格
    lines.push(`${l10n.soulStyleLabel}${soul.speaking_style}`);

    // 核心价值观
    if (soul.core_values) {
      lines.push(`${l10n.soulValuesLabel}${soul.core_values}`);
    }

    // 身份声明
    if (soul.identity_statement) {
      lines.push("");
      lines.push(`"${soul.identity_statement}"`);
    }

    return lines.join("\n");
  }

  /**
   * 组合 CONTEXT 部分（使用国际化模板）
   */
  private composeContextSection(context: ContextDefinition, l10n: typeof FUSION_ENGINE_ZH): string {
    const lines: string[] = [];

    // 工作模式标题
    lines.push(fillTemplate(l10n.contextModeTitle, { name: context.name }));
    lines.push("");

    // 角色视角
    lines.push(fillTemplateArray(l10n.contextRolePerspective, {
      addressSelf: context.role_perspective ? "" : DEFAULT_SOUL.address_self || DEFAULT_SOUL.name,
      description: context.role_perspective || context.description,
    }));

    // 行为准则
    if (context.behavior_patterns && context.behavior_patterns.length > 0) {
      lines.push("");
      lines.push(l10n.contextBehaviorLabel);
      for (const pattern of context.behavior_patterns) {
        lines.push(`- ${pattern}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 组合 PHASE 部分（使用国际化模板）
   */
  private composePhaseSection(phase: PhaseDefinition, l10n: typeof FUSION_ENGINE_ZH): string {
    const lines: string[] = [];

    // 阶段标题
    lines.push(fillTemplate(l10n.phaseStageTitle, { name: phase.name }));
    lines.push("");

    // 情感基调
    lines.push(fillTemplate(l10n.phaseEmotionalTone, {
      addressSelf: DEFAULT_SOUL.address_self || DEFAULT_SOUL.name,
      emotionalTone: phase.emotional_tone || phase.description,
    }));

    // 行动指引
    if (phase.action_patterns && phase.action_patterns.length > 0) {
      lines.push("");
      lines.push(l10n.phaseActionIntro);
      for (const pattern of phase.action_patterns) {
        lines.push(`- ${pattern}`);
      }
    }

    // 成功标准
    if (phase.success_criteria) {
      lines.push("");
      lines.push(`${l10n.phaseSuccessLabel}${phase.success_criteria}`);
    }

    return lines.join("\n");
  }

  /**
   * 清除所有缓存
   */
  clearCache(): void {
    this.soulProvider.clearCache();
    this.contextDetector.clearCache();
    this.phaseDetector.clearCache();
  }
}

// =============================================================================
// 默认融合引擎（使用内置定义）
// =============================================================================

/**
 * 创建默认融合引擎
 */
export function createDefaultFusionEngine(
  definitionsPath?: string,
  language: SupportedLanguage = "zh",
): FusionEngine {
  const soulProvider = new SoulProvider(definitionsPath || "./definitions", true);
  const contextDetector = new ContextDetector(definitionsPath || "./definitions", true);
  const phaseDetector = new PhaseDetector(definitionsPath || "./definitions", true);

 return new FusionEngine(soulProvider, contextDetector, phaseDetector, language);
}

export default FusionEngine;