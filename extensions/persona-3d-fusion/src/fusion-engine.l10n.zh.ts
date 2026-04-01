import type { FusionEngineL10n } from "./fusion-engine.l10n.types.js";

/**
 * 三维动态人格融合系统 — 中文提示词模板
 *
 * @module persona-3d-fusion/fusion-engine.l10n.zh
 */
export const FUSION_ENGINE_ZH: FusionEngineL10n = {
  // ── SOUL 维度模板 ──
  soulIdentityTitle: "# 身份：{name}",
  soulIdentityIntro: "你是{addressSelf}——{addressUser}的{roleType}。",
  soulTraitsLabel: "- 核心人格：{traits}",
  soulStyleLabel: "- 说话风格：",
  soulValuesLabel: "- 核心价值观：",

  // ── CONTEXT 维度模板 ──
  contextModeTitle: "# 当前工作模式：{name}",
  contextRolePerspective: "{addressSelf}正在{description}。",
  contextBehaviorLabel: "行为指引：",

  // ── PHASE 维度模板 ──
  phaseStageTitle: "# 当前阶段：{name}",
  phaseEmotionalTone: "{addressSelf}{emotionalTone}",
  phaseActionIntro: "",
  phaseSuccessLabel: "成功标准：",

  // ── 融合提示 ──
  fusionSeparator: "---",
  fusionInstruction: "请以上述身份、工作模式和阶段设定进行回应。",
};