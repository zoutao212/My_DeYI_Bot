/**
 * 三维动态人格融合系统 — 国际化类型定义
 *
 * 将 fusion-engine.ts 中硬编码的提示词模板抽取为可按语言切换的配置。
 *
 * 模板字符串使用 `{placeholder}` 占位符，运行时由 fillTemplate() 替换。
 *
 * @module persona-3d-fusion/fusion-engine.l10n.types
 */

// ============================================================================
// 类型
// ============================================================================

/**
 * 三维融合引擎的国际化配置
 */
export interface FusionEngineL10n {
  // ── SOUL 维度模板 ──

  /** SOUL 身份标题，如 "# 身份：{name}" */
  soulIdentityTitle: string;

  /** SOUL 核心人格说明，如 "你是{addressSelf}——{addressUser}的{roleType}。" */
  soulIdentityIntro: string;

  /** SOUL 人格特质标题，如 "- 核心人格：{traits}" */
  soulTraitsLabel: string;

  /** SOUL 说话风格标签，如 "- 说话风格：" */
  soulStyleLabel: string;

  /** SOUL 核心价值观标签，如 "- 核心价值观：" */
  soulValuesLabel: string;

  // ── CONTEXT 维度模板 ──

  /** CONTEXT 工作模式标题，如 "# 当前工作模式：{name}" */
  contextModeTitle: string;

  /** CONTEXT 角色视角说明，如 "{addressSelf}正在{description}。" */
  contextRolePerspective: string;

  /** CONTEXT 行为模式标题，如 "行为指引：" */
  contextBehaviorLabel: string;

  // ── PHASE 维度模板 ──

  /** PHASE 阶段标题，如 "# 当前阶段：{name}" */
  phaseStageTitle: string;

  /** PHASE 情感基调说明，如 "{addressSelf}{emotionalTone}" */
  phaseEmotionalTone: string;

  /** PHASE 行动模式说明 */
  phaseActionIntro: string;

  /** PHASE 成功标准标签，如 "成功标准：" */
  phaseSuccessLabel: string;

  // ── 融合提示 ──

  /** 融合分隔线，如 "---" */
  fusionSeparator: string;

  /** 融合提示语，如 "请以上述身份、工作模式和阶段设定进行回应。" */
  fusionInstruction: string;
}

// ============================================================================
// 模板填充工具
// ============================================================================

/**
 * 简单的模板占位符替换
 *
 * @example
 * fillTemplate("你是 {displayName}，请回复。", { displayName: "琳娜" })
 * // → "你是 琳娜，请回复。"
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}

/**
 * 多值模板填充（处理数组）
 *
 * @example
 * fillTemplateArray("{addressSelf}正在{action}。", { addressSelf: "德姨", action: "帮主人写代码" })
 * // → "德姨正在帮主人写代码。"
 */
export function fillTemplateArray(template: string, values: Record<string, string | string[]>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = values[key];
    if (Array.isArray(value)) {
      return value.join("、");
    }
    return value ?? `{${key}}`;
  });
}

// ============================================================================
// 语言选择器
// ============================================================================

export type SupportedLanguage = "zh" | "en";

/**
 * 获取默认语言
 */
export function getDefaultLanguage(): SupportedLanguage {
  // 从环境变量或系统语言推断
  const envLang = process.env.LANG || process.env.LANGUAGE || "";
  if (envLang.toLowerCase().includes("zh")) {
    return "zh";
  }
  return "zh"; // 默认中文
}