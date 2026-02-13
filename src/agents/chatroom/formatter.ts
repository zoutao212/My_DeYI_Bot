/**
 * 爱姬聊天室 — 消息格式化器
 *
 * 将多角色的响应格式化为统一的聊天室消息风格。
 * 支持：开场白、多角色回答、互评、发言统计、关闭消息。
 *
 * @module agents/chatroom/formatter
 */

import type { CharacterResponse, ChatRoomConfig, ChatRoomSession } from "./types.js";
import { CHARACTER_ICONS, DEFAULT_CHATROOM_CONFIG } from "./types.js";

// ============================================================================
// 格式化函数
// ============================================================================

/**
 * 格式化聊天室开场消息
 */
export function formatOpeningMessage(participants: string[], displayNames: Record<string, string>): string {
  const names = participants
    .map((id) => {
      const icon = CHARACTER_ICONS[id]?.icon ?? "💬";
      const name = displayNames[id] ?? id;
      return `${icon}${name}`;
    })
    .join(" · ");

  return [
    `╔══════════════════════════════════════╗`,
    `║  🏠 爱姬聊天室已开启                  ║`,
    `║  参与者：${names}`,
    `╚══════════════════════════════════════╝`,
  ].join("\n");
}

/**
 * 格式化多角色的回答消息
 */
export function formatResponses(
  responses: CharacterResponse[],
  session: ChatRoomSession,
  chatroomConfig?: Partial<ChatRoomConfig>,
): string {
  const cfg = { ...DEFAULT_CHATROOM_CONFIG, ...chatroomConfig };
  const parts: string[] = [];

  // 分隔线
  parts.push(`━━━━━━━━━━━━━━━━━━━━`);

  for (const resp of responses) {
    const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
    parts.push(`${icon} ${resp.displayName}：`);
    parts.push(resp.content);
    parts.push(``);
  }

  // 记忆操作摘要（角色执行了记忆读写时显示）
  const memoryHints: string[] = [];
  for (const resp of responses) {
    if (resp.memoryActions?.length) {
      const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
      const okCount = resp.memoryActions.filter((a) => a.ok).length;
      memoryHints.push(`${icon}${resp.displayName} 📝×${okCount}`);
    }
  }

  // 发言统计（使用 session 中的 displayNames + config 实际上限）
  parts.push(`━━━━━━━━━━━━━━━━━━━━`);
  const stats = session.participants
    .map((id) => {
      const icon = CHARACTER_ICONS[id]?.icon ?? "💬";
      const name = session.displayNames?.[id] ?? id;
      const count = session.replyCounters[id] ?? 0;
      return `${icon}${name} ${count}/${cfg.maxRepliesPerCharacter}`;
    })
    .join(" · ");
  parts.push(`📊 发言统计：${stats}`);
  if (memoryHints.length > 0) {
    parts.push(`📝 记忆操作：${memoryHints.join(" · ")}`);
  }

  return parts.join("\n");
}

/**
 * 格式化互评消息
 */
export function formatInteractionResponses(
  responses: CharacterResponse[],
  mode: "review" | "free_chat" | "debate",
): string {
  const modeLabels: Record<string, string> = {
    review: "姐妹互评",
    free_chat: "自由聊天",
    debate: "观点辩论",
  };

  const parts: string[] = [];
  parts.push(`🔄 ${modeLabels[mode] ?? "互动"} ———`);
  parts.push(``);

  for (const resp of responses) {
    const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
    // 互评时，标注评价对象
    const otherNames = responses
      .filter((r) => r.characterId !== resp.characterId)
      .map((r) => {
        const rIcon = CHARACTER_ICONS[r.characterId]?.icon ?? "💬";
        return `${rIcon}${r.displayName}`;
      })
      .join(" & ");

    if (mode === "review" || mode === "debate") {
      parts.push(`${icon} ${resp.displayName} → 评 ${otherNames}：`);
    } else {
      parts.push(`${icon} ${resp.displayName}：`);
    }
    parts.push(resp.content);
    parts.push(``);
  }

  parts.push(`🔄 ${modeLabels[mode] ?? "互动"}结束 ———`);

  return parts.join("\n");
}

/**
 * 格式化聊天室关闭消息
 */
export function formatClosingMessage(session: ChatRoomSession): string {
  const totalDuration = Math.round((Date.now() - session.createdAt) / 1000);
  const minutes = Math.floor(totalDuration / 60);
  const seconds = totalDuration % 60;

  const stats = session.participants
    .map((id) => {
      const icon = CHARACTER_ICONS[id]?.icon ?? "💬";
      const name = session.displayNames?.[id] ?? id;
      const count = session.replyCounters[id] ?? 0;
      return `${icon}${name} ${count}次`;
    })
    .join(" · ");

  return [
    `╔══════════════════════════════════════╗`,
    `║  🏠 爱姬聊天室已关闭                  ║`,
    `║  时长：${minutes}分${seconds}秒`,
    `║  发言：${stats}`,
    `║  总消息数：${session.totalMessageCount}`,
    `╚══════════════════════════════════════╝`,
  ].join("\n");
}

/**
 * 格式化到达上限提示
 */
export function formatLimitReachedMessage(
  characterId: string,
  displayName: string,
  limitType: "character" | "total",
): string {
  const icon = CHARACTER_ICONS[characterId]?.icon ?? "💬";
  if (limitType === "character") {
    return `⚠️ ${icon}${displayName} 已达到本次发言上限`;
  }
  return `⚠️ 聊天室已达到总消息上限，即将自动关闭`;
}

// ============================================================================
// 协作任务格式化
// ============================================================================

/**
 * 格式化协作任务启动横幅
 */
export function formatCollaborativeBanner(
  participants: string[],
  displayNames: Record<string, string>,
  leadCharacterId: string,
): string {
  const leadIcon = CHARACTER_ICONS[leadCharacterId]?.icon ?? "💬";
  const leadName = displayNames[leadCharacterId] ?? leadCharacterId;
  const allNames = participants
    .map((id) => {
      const icon = CHARACTER_ICONS[id]?.icon ?? "💬";
      return `${icon}${displayNames[id] ?? id}`;
    })
    .join(" · ");

  return [
    `╔══════════════════════════════════════╗`,
    `║  🤝 协作任务模式启动                   ║`,
    `║  参与者：${allNames}`,
    `║  执行主导：${leadIcon}${leadName}`,
    `╚══════════════════════════════════════╝`,
  ].join("\n");
}

/**
 * 格式化规划阶段结果
 */
export function formatPlanningPhase(responses: CharacterResponse[]): string {
  const parts: string[] = [];
  parts.push(`📋 **Phase 1 — 姐妹规划讨论** ———`);
  parts.push(``);

  for (const resp of responses) {
    const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
    parts.push(`${icon} ${resp.displayName} 的方案：`);
    parts.push(resp.content);
    parts.push(``);
  }

  parts.push(`📋 规划讨论结束 ———`);
  return parts.join("\n");
}

/**
 * 格式化执行阶段结果
 */
export function formatExecutionPhase(
  leadResponse: CharacterResponse,
  durationMs: number,
): string {
  const icon = CHARACTER_ICONS[leadResponse.characterId]?.icon ?? "💬";
  const seconds = Math.round(durationMs / 1000);

  const parts: string[] = [];
  parts.push(`⚡ **Phase 2 — ${icon}${leadResponse.displayName} 执行任务** (${seconds}s) ———`);
  parts.push(``);
  parts.push(leadResponse.content);
  parts.push(``);
  parts.push(`⚡ 执行阶段结束 ———`);
  return parts.join("\n");
}

/**
 * 格式化互检阶段结果
 */
export function formatReviewPhase(responses: CharacterResponse[]): string {
  const parts: string[] = [];
  parts.push(`🔍 **Phase 3 — 姐妹互检** ———`);
  parts.push(``);

  for (const resp of responses) {
    const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
    parts.push(`${icon} ${resp.displayName} 的审查意见：`);
    parts.push(resp.content);
    parts.push(``);
  }

  parts.push(`🔍 互检结束 ———`);
  return parts.join("\n");
}
