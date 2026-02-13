/**
 * 爱姬聊天室 — 检测器国际化加载器
 *
 * 复用 PromptsLoader 的语言设置，按当前语言返回对应的检测器模式配置。
 *
 * @module agents/chatroom/detector-l10n-loader
 */

import type { ChatRoomDetectorL10n } from "./detector.l10n.types.js";
import { CHATROOM_DETECTOR_ZH } from "./detector.l10n.zh.js";
import { CHATROOM_DETECTOR_EN } from "./detector.l10n.en.js";

/** 支持的语言（与 PromptsLoader 一致） */
export type DetectorLanguage = "zh" | "en";

/** 当前语言，默认中文 */
let currentLang: DetectorLanguage = "zh";

/**
 * 设置检测器语言
 */
export function setDetectorLanguage(lang: DetectorLanguage): void {
  currentLang = lang;
}

/**
 * 获取当前语言
 */
export function getDetectorLanguage(): DetectorLanguage {
  return currentLang;
}

/**
 * 获取当前语言的检测器模式配置
 */
export function getDetectorL10n(): ChatRoomDetectorL10n {
  return currentLang === "zh" ? CHATROOM_DETECTOR_ZH : CHATROOM_DETECTOR_EN;
}
