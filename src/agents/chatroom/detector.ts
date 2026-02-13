/**
 * 爱姬聊天室 — 三召唤意图检测器
 *
 * 从用户消息中检测是否要触发聊天室模式（多角色同时回答）。
 * 支持三召唤、多角色点名、互动触发、退出等模式。
 *
 * @module agents/chatroom/detector
 */

import type { CharacterRecognitionConfig } from "../pipeline/types.js";
import type {
  ChatRoomDetectionResult,
  ChatRoomTriggerType,
  InteractionMode,
} from "./types.js";
import { getDetectorL10n } from "./detector-l10n-loader.js";

// ============================================================================
// 触发词模式（已国际化，从 detector.l10n.*.ts 加载）
// ============================================================================

// ============================================================================
// 检测器
// ============================================================================

/**
 * 检测用户消息是否触发聊天室模式
 *
 * @param userMessage - 用户消息
 * @param characters - 已注册的角色识别配置列表
 * @param activeSession - 当前是否已有活跃的聊天室会话
 * @returns 检测结果
 */
export function detectChatRoomIntent(
  userMessage: string,
  characters: CharacterRecognitionConfig[],
  activeSession: boolean = false,
): ChatRoomDetectionResult {
  const msg = userMessage.toLowerCase();
  const l10n = getDetectorL10n();

  // ── 0. 退出检测（最高优先级） ──
  if (matchesAny(msg, l10n.exitPatterns)) {
    return {
      isChatRoomMode: false,
      participants: [],
      triggerType: "exit",
    };
  }

  // ── 1. 互动模式检测（聊天室已开启时） ──
  if (activeSession) {
    const interactionMode = detectInteractionMode(msg);
    if (interactionMode) {
      return {
        isChatRoomMode: true,
        participants: [], // 由 session 中的 participants 决定
        triggerType: "interaction",
        interactionMode,
      };
    }
  }

  // ── 2. 三召唤模式检测 ──
  if (matchesAny(msg, l10n.triSummonPatterns)) {
    const allIds = characters.map((c) => c.id);
    // P121: 同时检测互动模式（"开启闲谈模式"应同时触发 tri_summon + free_chat）
    const interactionMode = detectInteractionMode(msg);
    return {
      isChatRoomMode: true,
      participants: allIds,
      triggerType: "tri_summon",
      interactionMode,
    };
  }

  // ── 3. 多角色名检测（点名 ≥2 位） ──
  const mentionedIds = detectMentionedCharacters(msg, characters);
  if (mentionedIds.length >= 2) {
    // P121: 同时检测互动模式（"琳娜 德默泽尔 来辩论"应附带互动模式）
    const interactionMode = detectInteractionMode(msg);
    return {
      isChatRoomMode: true,
      participants: mentionedIds,
      triggerType: "multi_name",
      interactionMode,
    };
  }

  // ── 4. 会话延续（已有活跃聊天室 + 非退出） ──
  if (activeSession) {
    return {
      isChatRoomMode: true,
      participants: [], // 由 session 决定
      triggerType: "continuation",
    };
  }

  // ── 5. 同时检测互动词（未开启聊天室但说了互评/讨论） ──
  const interactionMode = detectInteractionMode(msg);
  if (interactionMode) {
    const allIds = characters.map((c) => c.id);
    return {
      isChatRoomMode: true,
      participants: allIds,
      triggerType: "tri_summon",
      interactionMode,
    };
  }

  // ── 6. 未触发 ──
  return {
    isChatRoomMode: false,
    participants: mentionedIds.length === 1 ? mentionedIds : [],
    triggerType: "single",
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 检查消息是否匹配任意模式 */
function matchesAny(messageLower: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(messageLower));
}

/** 检测互动模式 */
function detectInteractionMode(messageLower: string): InteractionMode | undefined {
  const l10n = getDetectorL10n();
  if (matchesAny(messageLower, l10n.reviewPatterns)) return "review";
  if (matchesAny(messageLower, l10n.debatePatterns)) return "debate";
  if (matchesAny(messageLower, l10n.freeChatPatterns)) return "free_chat";
  return undefined;
}

/** 从消息中检测被点名的角色 */
function detectMentionedCharacters(
  messageLower: string,
  characters: CharacterRecognitionConfig[],
): string[] {
  const mentioned: string[] = [];
  for (const char of characters) {
    const found = char.recognition.names.some((name) =>
      messageLower.includes(name.toLowerCase()),
    );
    if (found && !mentioned.includes(char.id)) {
      mentioned.push(char.id);
    }
  }
  return mentioned;
}
