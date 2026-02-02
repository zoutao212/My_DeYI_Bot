/**
 * 栗娜日常事务管理系统 - 类型定义测试
 * 
 * 本文件测试核心类型定义的正确性。
 */

import { describe, it, expect } from 'vitest';
import type {
  DailyTask,
  Memory,
  Reminder,
  TechnicalTask,
  TaskProgress,
  TaskFilter,
  MemoryQuery,
  ReminderFilter,
} from './types.js';

describe('Lina Types', () => {
  describe('DailyTask', () => {
    it('should create a valid DailyTask', () => {
      const task: DailyTask = {
        id: 'task-1',
        title: '完成项目报告',
        description: '完成 Q1 项目总结报告',
        priority: 'high',
        status: 'pending',
        dueDate: new Date('2024-02-01'),
        tags: ['工作', '报告'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(task.id).toBe('task-1');
      expect(task.title).toBe('完成项目报告');
      expect(task.priority).toBe('high');
      expect(task.status).toBe('pending');
      expect(task.tags).toEqual(['工作', '报告']);
    });

    it('should allow optional fields to be undefined', () => {
      const task: DailyTask = {
        id: 'task-2',
        title: '买菜',
        priority: 'low',
        status: 'pending',
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(task.description).toBeUndefined();
      expect(task.dueDate).toBeUndefined();
      expect(task.completedAt).toBeUndefined();
    });
  });

  describe('Memory', () => {
    it('should create a valid Memory', () => {
      const memory: Memory = {
        id: 'memory-1',
        content: '用户喜欢在早上 9 点开始工作',
        type: 'important',
        tags: ['偏好', '工作习惯'],
        importance: 8,
        createdAt: new Date(),
        metadata: {
          source: 'conversation',
          confidence: 0.9,
        },
      };

      expect(memory.id).toBe('memory-1');
      expect(memory.type).toBe('important');
      expect(memory.importance).toBe(8);
      expect(memory.metadata.source).toBe('conversation');
    });
  });

  describe('Reminder', () => {
    it('should create a valid Reminder without repeat', () => {
      const reminder: Reminder = {
        id: 'reminder-1',
        title: '会议提醒',
        message: '下午 3 点有团队会议',
        dueTime: new Date('2024-01-31T15:00:00'),
        status: 'active',
        createdAt: new Date(),
      };

      expect(reminder.id).toBe('reminder-1');
      expect(reminder.status).toBe('active');
      expect(reminder.repeat).toBeUndefined();
    });

    it('should create a valid Reminder with repeat', () => {
      const reminder: Reminder = {
        id: 'reminder-2',
        title: '每日站会',
        message: '早上 9:30 站会',
        dueTime: new Date('2024-01-31T09:30:00'),
        repeat: {
          frequency: 'daily',
          interval: 1,
        },
        advanceTime: 10,
        status: 'active',
        createdAt: new Date(),
      };

      expect(reminder.repeat?.frequency).toBe('daily');
      expect(reminder.repeat?.interval).toBe(1);
      expect(reminder.advanceTime).toBe(10);
    });
  });

  describe('TechnicalTask', () => {
    it('should create a valid TechnicalTask', () => {
      const task: TechnicalTask = {
        id: 'tech-task-1',
        type: 'file-operation',
        description: '创建项目文件夹',
        parameters: {
          path: '/projects/new-project',
          recursive: true,
        },
        priority: 5,
        status: 'pending',
        createdAt: new Date(),
      };

      expect(task.id).toBe('tech-task-1');
      expect(task.type).toBe('file-operation');
      expect(task.status).toBe('pending');
      expect(task.parameters.path).toBe('/projects/new-project');
    });
  });

  describe('TaskProgress', () => {
    it('should create a valid TaskProgress', () => {
      const progress: TaskProgress = {
        taskId: 'tech-task-1',
        percentage: 50,
        currentStep: '正在创建子目录',
        totalSteps: 10,
        completedSteps: 5,
        estimatedTimeRemaining: 30000,
        updatedAt: new Date(),
      };

      expect(progress.percentage).toBe(50);
      expect(progress.completedSteps).toBe(5);
      expect(progress.totalSteps).toBe(10);
    });
  });

  describe('TaskFilter', () => {
    it('should create a valid TaskFilter with single status', () => {
      const filter: TaskFilter = {
        status: 'pending',
        priority: 'high',
      };

      expect(filter.status).toBe('pending');
      expect(filter.priority).toBe('high');
    });

    it('should create a valid TaskFilter with multiple statuses', () => {
      const filter: TaskFilter = {
        status: ['pending', 'in_progress'],
        tags: ['工作', '紧急'],
      };

      expect(filter.status).toEqual(['pending', 'in_progress']);
      expect(filter.tags).toEqual(['工作', '紧急']);
    });

    it('should create a valid TaskFilter with date range', () => {
      const filter: TaskFilter = {
        dateRange: {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-31'),
        },
      };

      expect(filter.dateRange?.start).toBeInstanceOf(Date);
      expect(filter.dateRange?.end).toBeInstanceOf(Date);
    });
  });

  describe('MemoryQuery', () => {
    it('should create a valid MemoryQuery', () => {
      const query: MemoryQuery = {
        query: '用户的工作习惯',
        type: 'important',
        minImportance: 7,
        limit: 10,
      };

      expect(query.query).toBe('用户的工作习惯');
      expect(query.type).toBe('important');
      expect(query.minImportance).toBe(7);
      expect(query.limit).toBe(10);
    });

    it('should create a valid MemoryQuery with time range', () => {
      const query: MemoryQuery = {
        timeRange: {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-31'),
        },
      };

      expect(query.timeRange?.start).toBeInstanceOf(Date);
      expect(query.timeRange?.end).toBeInstanceOf(Date);
    });
  });

  describe('ReminderFilter', () => {
    it('should create a valid ReminderFilter', () => {
      const filter: ReminderFilter = {
        status: 'active',
        keyword: '会议',
      };

      expect(filter.status).toBe('active');
      expect(filter.keyword).toBe('会议');
    });
  });
});
