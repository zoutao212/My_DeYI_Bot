/**
 * ID 生成器测试
 */

import { describe, it, expect } from 'vitest';
import {
  generateTaskId,
  generateMemoryId,
  generateReminderId,
  generateTechnicalTaskId,
  generateConversationId,
  generateMessageId,
} from './id-generator.js';

describe('ID Generator', () => {
  describe('generateTaskId', () => {
    it('should generate a task ID with correct prefix', () => {
      const id = generateTaskId();
      expect(id).toMatch(/^task-[0-9a-f-]+$/);
    });

    it('should generate unique IDs', () => {
      const id1 = generateTaskId();
      const id2 = generateTaskId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateMemoryId', () => {
    it('should generate a memory ID with correct prefix', () => {
      const id = generateMemoryId();
      expect(id).toMatch(/^memory-[0-9a-f-]+$/);
    });

    it('should generate unique IDs', () => {
      const id1 = generateMemoryId();
      const id2 = generateMemoryId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateReminderId', () => {
    it('should generate a reminder ID with correct prefix', () => {
      const id = generateReminderId();
      expect(id).toMatch(/^reminder-[0-9a-f-]+$/);
    });

    it('should generate unique IDs', () => {
      const id1 = generateReminderId();
      const id2 = generateReminderId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateTechnicalTaskId', () => {
    it('should generate a technical task ID with correct prefix', () => {
      const id = generateTechnicalTaskId();
      expect(id).toMatch(/^tech-task-[0-9a-f-]+$/);
    });

    it('should generate unique IDs', () => {
      const id1 = generateTechnicalTaskId();
      const id2 = generateTechnicalTaskId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateConversationId', () => {
    it('should generate a conversation ID with correct prefix', () => {
      const id = generateConversationId();
      expect(id).toMatch(/^conversation-[0-9a-f-]+$/);
    });

    it('should generate unique IDs', () => {
      const id1 = generateConversationId();
      const id2 = generateConversationId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateMessageId', () => {
    it('should generate a message ID with correct prefix', () => {
      const id = generateMessageId();
      expect(id).toMatch(/^message-[0-9a-f-]+$/);
    });

    it('should generate unique IDs', () => {
      const id1 = generateMessageId();
      const id2 = generateMessageId();
      expect(id1).not.toBe(id2);
    });
  });
});
