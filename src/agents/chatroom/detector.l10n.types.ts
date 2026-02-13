/**
 * 爱姬聊天室 — 检测器国际化类型定义
 *
 * 将硬编码的中文关键词/正则模式抽取为可按语言切换的配置。
 *
 * @module agents/chatroom/detector.l10n.types
 */

// ============================================================================
// 类型
// ============================================================================

/**
 * 聊天室检测器的国际化配置
 *
 * 每个字段都是 RegExp[]，检测器在运行时按语言加载对应配置。
 */
export interface ChatRoomDetectorL10n {
  /** 三召唤模式（全员参与）——匹配后触发 tri_summon */
  triSummonPatterns: RegExp[];

  /** 互评触发——匹配后 interactionMode = "review" */
  reviewPatterns: RegExp[];

  /** 自由聊天触发——匹配后 interactionMode = "free_chat" */
  freeChatPatterns: RegExp[];

  /** 辩论触发——匹配后 interactionMode = "debate" */
  debatePatterns: RegExp[];

  /** 退出聊天室——匹配后 triggerType = "exit" */
  exitPatterns: RegExp[];
}
