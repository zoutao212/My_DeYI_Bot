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
  // 🚫 聊天室功能已停用
  // 直接返回不触发聊天室模式，所有消息都会走单角色路径
  return {
    isChatRoomMode: false,
    participants: [],
    triggerType: "single",
  };

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

  // ── 0.5. 任务树意图优先排除（新增） ──
  // 当检测到明确的任务树/复杂任务意图时，优先跳过聊天室模式
  // 确保多角色场景下的任务树功能不被误拦截
  const taskTreePatterns = [
    /任务树|复杂任务|智能任务|任务分解|enqueue_task/,
    /(?:写|创作|生成|分析|整理|构建).*(?:万字|长篇|多章|多节|系列|全套|完整)/,
    /(?:启动|开始|执行|运行).*(?:任务树|复杂任务|大型项目)/,
    /长篇.*小说|万字.*创作|多章.*规划|系列.*写作/,
    /大规模.*分析|系统性.*处理|项目.*管理/,
  ];
  
  if (matchesAny(msg, taskTreePatterns)) {
    return {
      isChatRoomMode: false,
      participants: [],
      triggerType: "single",
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
