/**
 * 验证器测试
 */

import { describe, it, expect } from 'vitest';
import {
  validateTask,
  validateMemory,
  validateReminder,
  validateTechnicalTask,
  validateDateRange,
} from './validators.js';
import type { DailyTask, Memory, Reminder, TechnicalTask } from '../types.js';

describe('Validators', () => {
  describe('validateTask', () => {
    it('should validate a valid task', () => {
      const task: Partial<DailyTask> = {
        title: '完成项目报告',
        priority: 'high',
        status: 'pending',
        tags: ['工作'],
      };

      const result = validateTask(task);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject task with empty title', () => {
      const task: Partial<DailyTask> = {
        title: '',
        priority: 'high',
      };

      const result = validateTask(task);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('任务标题不能为空');
    });

    it('should reject task with too long title', () => {
      const task: Partial<DailyTask> = {
        title: 'a'.repeat(201),
        priority: 'high',
      };

      const result = validateTask(task);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('任务标题不能超过 200 个字符');
    });

    it('should reject task with invalid priority', () => {
      const task: Partial<DailyTask> = {
        title: '完成项目报告',
        priority: 'invalid' as any,
      };

      const result = validateTask(task);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('任务优先级必须是 low、medium、high 或 urgent');
    });

    it('should reject task with invalid status', () => {
      const task: Partial<DailyTask> = {
        title: '完成项目报告',
        status: 'invalid' as any,
      };

      const result = validateTask(task);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        '任务状态必须是 pending、in_progress、completed 或 cancelled'
      );
    });
  });

  describe('validateMemory', () => {
    it('should validate a valid memory', () => {
      const memory: Partial<Memory> = {
        content: '用户喜欢在早上 9 点开始工作',
        type: 'important',
        importance: 8,
        tags: ['偏好'],
      };

      const result = validateMemory(memory);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject memory with empty content', () => {
      const memory: Partial<Memory> = {
        content: '',
        type: 'important',
      };

      const result = validateMemory(memory);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('记忆内容不能为空');
    });

    it('should reject memory with invalid type', () => {
      const memory: Partial<Memory> = {
        content: '用户喜欢在早上 9 点开始工作',
        type: 'invalid' as any,
      };

      const result = validateMemory(memory);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('记忆类型必须是 conversation、summary 或 important');
    });

    it('should reject memory with invalid importance', () => {
      const memory: Partial<Memory> = {
        content: '用户喜欢在早上 9 点开始工作',
        importance: 11,
      };

      const result = validateMemory(memory);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('重要性必须在 0-10 之间');
    });
  });

  describe('validateReminder', () => {
    it('should validate a valid reminder', () => {
      const reminder: Partial<Reminder> = {
        title: '会议提醒',
        message: '下午 3 点有团队会议',
        dueTime: new Date(Date.now() + 3600000), // 1 hour from now
        status: 'active',
      };

      const result = validateReminder(reminder);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject reminder with empty title', () => {
      const reminder: Partial<Reminder> = {
        title: '',
        message: '下午 3 点有团队会议',
        dueTime: new Date(Date.now() + 3600000),
      };

      const result = validateReminder(reminder);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('提醒标题不能为空');
    });

    it('should reject reminder with empty message', () => {
      const reminder: Partial<Reminder> = {
        title: '会议提醒',
        message: '',
        dueTime: new Date(Date.now() + 3600000),
      };

      const result = validateReminder(reminder);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('提醒消息不能为空');
    });

    it('should reject reminder with past due time', () => {
      const reminder: Partial<Reminder> = {
        title: '会议提醒',
        message: '下午 3 点有团队会议',
        dueTime: new Date(Date.now() - 3600000), // 1 hour ago
      };

      const result = validateReminder(reminder);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('提醒时间不能早于当前时间');
    });

    it('should reject reminder with invalid repeat frequency', () => {
      const reminder: Partial<Reminder> = {
        title: '会议提醒',
        message: '下午 3 点有团队会议',
        dueTime: new Date(Date.now() + 3600000),
        repeat: {
          frequency: 'invalid' as any,
          interval: 1,
        },
      };

      const result = validateReminder(reminder);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('重复频率必须是 daily、weekly、monthly 或 yearly');
    });
  });

  describe('validateTechnicalTask', () => {
    it('should validate a valid technical task', () => {
      const task: Partial<TechnicalTask> = {
        type: 'file-operation',
        description: '创建项目文件夹',
        parameters: { path: '/projects/new-project' },
        priority: 5,
      };

      const result = validateTechnicalTask(task);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject task with empty type', () => {
      const task: Partial<TechnicalTask> = {
        type: '',
        description: '创建项目文件夹',
        parameters: {},
      };

      const result = validateTechnicalTask(task);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('任务类型不能为空');
    });

    it('should reject task with empty description', () => {
      const task: Partial<TechnicalTask> = {
        type: 'file-operation',
        description: '',
        parameters: {},
      };

      const result = validateTechnicalTask(task);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('任务描述不能为空');
    });

    it('should reject task with invalid priority', () => {
      const task: Partial<TechnicalTask> = {
        type: 'file-operation',
        description: '创建项目文件夹',
        parameters: {},
        priority: 11,
      };

      const result = validateTechnicalTask(task);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('优先级必须在 0-10 之间');
    });
  });

  describe('validateDateRange', () => {
    it('should validate a valid date range', () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-01-31');

      const result = validateDateRange(start, end);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject date range with start after end', () => {
      const start = new Date('2024-01-31');
      const end = new Date('2024-01-01');

      const result = validateDateRange(start, end);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('开始日期不能晚于结束日期');
    });
  });
});
