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
  /** 角色 ID */
  characterId: string;
  /** SOUL ID（可选，默认与角色 ID 相同） */
  soulId?: string;
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
      characterId,
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

    // 1. 加载 SOUL 定义（从角色专用目录）
    const soul = await this.soulProvider.load(characterId, soulId) || DEFAULT_SOUL;

    // 2. 检测 CONTEXT（通用 + 角色特有）
    let context: FusionComponent<ContextDefinition> | null = null;
    if (enableContextDetection) {
      const contextResult = await this.contextDetector.detect(characterId, userMessage, conversationHistory);
      context = contextResult.context;

      // 如果没有找到自定义 CONTEXT，尝试使用内置的
      if (!context) {
        const builtinContext = this.findBuiltinContext(userMessage);
        if (builtinContext) {
          context = { generic: builtinContext, character: null };
        }
      }
    }

    // 3. 识别 PHASE（通用 + 角色特有）
    let phase: FusionComponent<PhaseDefinition> | null = null;
    if (enablePhaseDetection) {
      const phaseResult = await this.phaseDetector.detect(characterId, userMessage, conversationHistory);
      phase = phaseResult.phase;

      // 如果没有找到自定义 PHASE，尝试使用内置的
      if (!phase) {
        const builtinPhase = this.findBuiltinPhase(userMessage, conversationHistory);
        if (builtinPhase) {
          phase = { generic: builtinPhase, character: null };
        }
      }
    }

    // 4. 生成融合 prompt
    const { fusedPrompt, reasoning } = this.compose(soul, context, phase);

    // 恢复原始语言
    this.language = originalLanguage;

    return {
      soul,
      context: context?.generic || context?.character || null,
      phase: phase?.generic || phase?.character || null,
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
    context: FusionComponent<ContextDefinition> | null,
    phase: FusionComponent<PhaseDefinition> | null,
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
      const contextNames = [];
      if (context.generic) contextNames.push(`${context.generic.name}(通用)`);
      if (context.character) contextNames.push(`${context.character.name}(角色特有)`);
      reasoningParts.push(`检测到 CONTEXT: ${contextNames.join(" + ")}`);
    }

    // === 第三部分：PHASE（任务阶段）===
    if (phase) {
      parts.push(this.composePhaseSection(phase, l10n));
      const phaseNames = [];
      if (phase.generic) phaseNames.push(`${phase.generic.name}(通用)`);
      if (phase.character) phaseNames.push(`${phase.character.name}(角色特有)`);
      reasoningParts.push(`识别到 PHASE: ${phaseNames.join(" + ")}`);
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
   * 组合 CONTEXT 部分（使用国际化模板，支持通用 + 角色特有融合）
   */
  private composeContextSection(context: FusionComponent<ContextDefinition>, l10n: typeof FUSION_ENGINE_ZH): string {
    const lines: string[] = [];

    // 合并通用 + 角色特有定义
    const mergedContext = this.mergeContext(context);

    // 工作模式标题
    lines.push(fillTemplate(l10n.contextModeTitle, { name: mergedContext.name }));
    lines.push("");

    // 角色视角（优先使用角色特有）
    const rolePerspective = context.character?.role_perspective || context.generic?.role_perspective || "";
    const description = mergedContext.description;

    lines.push(fillTemplateArray(l10n.contextRolePerspective, {
      addressSelf: rolePerspective ? "" : DEFAULT_SOUL.address_self || DEFAULT_SOUL.name,
      description: rolePerspective || description,
    }));

    // 行为准则（合并通用 + 角色）
    const allPatterns = [
      ...(context.generic?.behavior_patterns || []),
      ...(context.character?.behavior_patterns || []),
    ];

    if (allPatterns.length > 0) {
      lines.push("");
      lines.push(l10n.contextBehaviorLabel);
      for (const pattern of allPatterns) {
        lines.push(`- ${pattern}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 合并 CONTEXT 定义（通用 + 角色）
   */
  private mergeContext(context: FusionComponent<ContextDefinition>): ContextDefinition {
    const generic = context.generic;
    const character = context.character;

    return {
      id: character?.id || generic?.id || "unknown",
      name: character?.name || generic?.name || "未知工作",
      trigger_keywords: [...new Set([
        ...(generic?.trigger_keywords || []),
        ...(character?.trigger_keywords || []),
      ])],
      description: character?.description || generic?.description || "",
      role_perspective: character?.role_perspective || generic?.role_perspective || "",
      behavior_patterns: [
        ...(generic?.behavior_patterns || []),
        ...(character?.behavior_patterns || []),
      ],
    };
  }

  /**
   * 组合 PHASE 部分（使用国际化模板，支持通用 + 角色特有融合）
   */
  private composePhaseSection(phase: FusionComponent<PhaseDefinition>, l10n: typeof FUSION_ENGINE_ZH): string {
    const lines: string[] = [];

    // 合并通用 + 角色特有定义
    const mergedPhase = this.mergePhase(phase);

    // 阶段标题
    lines.push(fillTemplate(l10n.phaseStageTitle, { name: mergedPhase.name }));
    lines.push("");

    // 情感基调（优先使用角色特有）
    const emotionalTone = phase.character?.emotional_tone || phase.generic?.emotional_tone || "";

    lines.push(fillTemplate(l10n.phaseEmotionalTone, {
      addressSelf: DEFAULT_SOUL.address_self || DEFAULT_SOUL.name,
      emotionalTone: emotionalTone || mergedPhase.description,
    }));

    // 行动指引（合并通用 + 角色）
    const allPatterns = [
      ...(phase.generic?.action_patterns || []),
      ...(phase.character?.action_patterns || []),
    ];

    if (allPatterns.length > 0) {
      lines.push("");
      lines.push(l10n.phaseActionIntro);
      for (const pattern of allPatterns) {
        lines.push(`- ${pattern}`);
      }
    }

    // 成功标准（优先使用角色特有）
    const successCriteria = phase.character?.success_criteria || phase.generic?.success_criteria;
    if (successCriteria) {
      lines.push("");
      lines.push(`${l10n.phaseSuccessLabel}${successCriteria}`);
    }

    return lines.join("\n");
  }

  /**
   * 合并 PHASE 定义（通用 + 角色）
   */
  private mergePhase(phase: FusionComponent<PhaseDefinition>): PhaseDefinition {
    const generic = phase.generic;
    const character = phase.character;

    return {
      id: character?.id || generic?.id || "unknown",
      name: character?.name || generic?.name || "未知阶段",
      trigger_keywords: [...new Set([
        ...(generic?.trigger_keywords || []),
        ...(character?.trigger_keywords || []),
      ])],
      description: character?.description || generic?.description || "",
      emotional_tone: character?.emotional_tone || generic?.emotional_tone || "",
      action_patterns: [
        ...(generic?.action_patterns || []),
        ...(character?.action_patterns || []),
      ],
      success_criteria: character?.success_criteria || generic?.success_criteria,
    };
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