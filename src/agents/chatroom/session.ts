/**
 * 爱姬聊天室 — 会话状态管理
 *
 * 维护聊天室的生命周期：创建、消息追加、计数、超时、关闭。
 * 使用内存 Map 存储（与现有 FOLLOWUP_QUEUES 同层级），
 * 后续可扩展为持久化。
 *
 * @module agents/chatroom/session
 */

import crypto from "node:crypto";
import type {
  ChatRoomConfig,
  ChatRoomMessage,
  ChatRoomSession,
  InteractionMode,
} from "./types.js";
import { DEFAULT_CHATROOM_CONFIG } from "./types.js";

// ============================================================================
// 全局会话存储
// ============================================================================

/** 聊天室会话存储：parentSessionKey → ChatRoomSession */
const sessions = new Map<string, ChatRoomSession>();

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 获取或创建聊天室会话
 *
 * 如果已有活跃会话且未超时，直接返回；否则创建新会话。
 */
export function getOrCreateSession(
  parentSessionKey: string,
  participants: string[],
  config: Partial<ChatRoomConfig> = {},
): ChatRoomSession {
  const cfg = { ...DEFAULT_CHATROOM_CONFIG, ...config };
  const existing = sessions.get(parentSessionKey);

  // 如果已有活跃且未超时的会话，直接返回
  if (existing && existing.isActive) {
    const elapsed = Date.now() - existing.lastActivityAt;
    if (elapsed < cfg.sessionTimeoutMs) {
      // 更新参与者（可能有变化）
      if (participants.length > 0) {
        existing.participants = participants;
      }
      existing.lastActivityAt = Date.now();
      return existing;
    }
    // 超时，标记关闭
    existing.isActive = false;
  }

  // 创建新会话
  const session: ChatRoomSession = {
    sessionId: crypto.randomUUID(),
    parentSessionKey,
    participants,
    displayNames: Object.fromEntries(participants.map((id) => [id, id])),
    messages: [],
    replyCounters: Object.fromEntries(participants.map((id) => [id, 0])),
    totalMessageCount: 0,
    isActive: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    currentInteractionMode: null,
    interactionRoundsExecuted: 0,
  };

  sessions.set(parentSessionKey, session);
  return session;
}

/**
 * 获取当前活跃会话（如果存在）
 */
export function getActiveSession(parentSessionKey: string): ChatRoomSession | null {
  const session = sessions.get(parentSessionKey);
  if (!session || !session.isActive) return null;
  return session;
}

/**
 * 检查指定 sessionKey 是否有活跃的聊天室
 */
export function hasActiveSession(parentSessionKey: string): boolean {
  return getActiveSession(parentSessionKey) !== null;
}

/**
 * 添加用户消息到聊天历史
 */
export function addUserMessage(
  session: ChatRoomSession,
  content: string,
): ChatRoomMessage {
  const msg: ChatRoomMessage = {
    id: crypto.randomUUID(),
    senderType: "user",
    senderId: "user",
    senderDisplayName: "主人",
    content,
    timestamp: Date.now(),
    isInteraction: false,
  };
  session.messages.push(msg);
  session.totalMessageCount++;
  session.lastActivityAt = Date.now();
  return msg;
}

/**
 * 添加角色消息到聊天历史
 */
export function addCharacterMessage(
  session: ChatRoomSession,
  characterId: string,
  displayName: string,
  content: string,
  isInteraction: boolean = false,
  replyToMessageId?: string,
): ChatRoomMessage {
  const msg: ChatRoomMessage = {
    id: crypto.randomUUID(),
    senderType: "character",
    senderId: characterId,
    senderDisplayName: displayName,
    content,
    timestamp: Date.now(),
    isInteraction,
    replyToMessageId,
  };
  session.messages.push(msg);
  session.totalMessageCount++;
  session.replyCounters[characterId] = (session.replyCounters[characterId] ?? 0) + 1;
  session.lastActivityAt = Date.now();
  return msg;
}

/**
 * 检查角色是否仍可发言
 */
export function canCharacterReply(
  session: ChatRoomSession,
  characterId: string,
  config: Partial<ChatRoomConfig> = {},
): boolean {
  const cfg = { ...DEFAULT_CHATROOM_CONFIG, ...config };
  const count = session.replyCounters[characterId] ?? 0;
  return (
    session.isActive &&
    count < cfg.maxRepliesPerCharacter &&
    session.totalMessageCount < cfg.maxTotalMessages
  );
}

/**
 * 检查聊天室是否仍可继续（未达总消息上限）
 */
export function canContinue(
  session: ChatRoomSession,
  config: Partial<ChatRoomConfig> = {},
): boolean {
  const cfg = { ...DEFAULT_CHATROOM_CONFIG, ...config };
  return session.isActive && session.totalMessageCount < cfg.maxTotalMessages;
}

/**
 * 设置互动模式
 */
export function setInteractionMode(
  session: ChatRoomSession,
  mode: InteractionMode | null,
): void {
  session.currentInteractionMode = mode;
}

/**
 * 关闭聊天室
 */
export function closeSession(parentSessionKey: string): void {
  const session = sessions.get(parentSessionKey);
  if (session) {
    session.isActive = false;
  }
}

/**
 * 获取最近 N 条聊天消息（用于上下文注入）
 */
export function getRecentMessages(
  session: ChatRoomSession,
  maxCount: number = 10,
): ChatRoomMessage[] {
  return session.messages.slice(-maxCount);
}

/**
 * 获取发言统计摘要
 */
export function getReplyStats(session: ChatRoomSession): string {
  return session.participants
    .map((id) => {
      const name = session.displayNames?.[id] ?? id;
      const count = session.replyCounters[id] ?? 0;
      return `${name} ${count}`;
    })
    .join(" · ");
}

/**
 * 清除所有会话（用于测试）
 */
export function clearAllSessions(): void {
  sessions.clear();
}
