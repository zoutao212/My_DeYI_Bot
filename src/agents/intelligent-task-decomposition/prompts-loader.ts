import type { TaskDecompositionPromptsL10n } from "./prompts.l10n.types.js";
import { TASK_DECOMPOSITION_PROMPTS_ZH } from "./prompts.l10n.zh.js";
import { TASK_DECOMPOSITION_PROMPTS_EN } from "./prompts.l10n.en.js";

/**
 * 支持的语言
 */
export type SupportedLanguage = "zh" | "en";

/**
 * 提示词加载器
 * 根据语言选择合适的提示词
 */
export class PromptsLoader {
  private static instance: PromptsLoader;
  private currentLanguage: SupportedLanguage = "zh";
  private prompts: TaskDecompositionPromptsL10n;

  private constructor() {
    this.prompts = TASK_DECOMPOSITION_PROMPTS_ZH;
  }

  /**
   * 获取单例实例
   */
  static getInstance(): PromptsLoader {
    if (!PromptsLoader.instance) {
      PromptsLoader.instance = new PromptsLoader();
    }
    return PromptsLoader.instance;
  }

  /**
   * 设置当前语言
   */
  setLanguage(language: SupportedLanguage): void {
    this.currentLanguage = language;
    this.prompts = language === "zh" 
      ? TASK_DECOMPOSITION_PROMPTS_ZH 
      : TASK_DECOMPOSITION_PROMPTS_EN;
  }

  /**
   * 获取当前语言
   */
  getLanguage(): SupportedLanguage {
    return this.currentLanguage;
  }

  /**
   * 获取当前语言的提示词
   */
  getPrompts(): TaskDecompositionPromptsL10n {
    return this.prompts;
  }
}

/**
 * 获取提示词加载器实例
 */
export function getPromptsLoader(): PromptsLoader {
  return PromptsLoader.getInstance();
}

/**
 * 获取当前语言的提示词
 */
export function getPrompts(): TaskDecompositionPromptsL10n {
  return getPromptsLoader().getPrompts();
}
