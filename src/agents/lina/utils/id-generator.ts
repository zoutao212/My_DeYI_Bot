/**
 * ID 生成器
 * 
 * 为各种实体生成唯一 ID。
 */

import { randomUUID } from 'node:crypto';

/**
 * 生成任务 ID
 * @returns 任务 ID
 */
export function generateTaskId(): string {
  return `task-${randomUUID()}`;
}

/**
 * 生成记忆 ID
 * @returns 记忆 ID
 */
export function generateMemoryId(): string {
  return `memory-${randomUUID()}`;
}

/**
 * 生成提醒 ID
 * @returns 提醒 ID
 */
export function generateReminderId(): string {
  return `reminder-${randomUUID()}`;
}

/**
 * 生成技术任务 ID
 * @returns 技术任务 ID
 */
export function generateTechnicalTaskId(): string {
  return `tech-task-${randomUUID()}`;
}

/**
 * 生成对话 ID
 * @returns 对话 ID
 */
export function generateConversationId(): string {
  return `conversation-${randomUUID()}`;
}

/**
 * 生成消息 ID
 * @returns 消息 ID
 */
export function generateMessageId(): string {
  return `message-${randomUUID()}`;
}
