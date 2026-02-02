/**
 * 日期工具函数测试
 */

import { describe, it, expect } from 'vitest';
import {
  getStartOfToday,
  getEndOfToday,
  getStartOfWeek,
  getEndOfWeek,
  isToday,
  isThisWeek,
  isInRange,
  daysBetween,
  addDays,
  addWeeks,
  addMonths,
  addYears,
  formatDate,
} from './date-utils.js';

describe('Date Utils', () => {
  describe('getStartOfToday', () => {
    it('should return today at 00:00:00', () => {
      const start = getStartOfToday();
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(start.getSeconds()).toBe(0);
      expect(start.getMilliseconds()).toBe(0);
    });
  });

  describe('getEndOfToday', () => {
    it('should return today at 23:59:59', () => {
      const end = getEndOfToday();
      expect(end.getHours()).toBe(23);
      expect(end.getMinutes()).toBe(59);
      expect(end.getSeconds()).toBe(59);
    });
  });

  describe('getStartOfWeek', () => {
    it('should return Monday at 00:00:00', () => {
      const start = getStartOfWeek();
      expect(start.getDay()).toBe(1); // Monday
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(start.getSeconds()).toBe(0);
    });
  });

  describe('getEndOfWeek', () => {
    it('should return Sunday at 23:59:59', () => {
      const end = getEndOfWeek();
      expect(end.getDay()).toBe(0); // Sunday
      expect(end.getHours()).toBe(23);
      expect(end.getMinutes()).toBe(59);
      expect(end.getSeconds()).toBe(59);
    });
  });

  describe('isToday', () => {
    it('should return true for today', () => {
      const today = new Date();
      expect(isToday(today)).toBe(true);
    });

    it('should return false for yesterday', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(isToday(yesterday)).toBe(false);
    });

    it('should return false for tomorrow', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(isToday(tomorrow)).toBe(false);
    });
  });

  describe('isThisWeek', () => {
    it('should return true for today', () => {
      const today = new Date();
      expect(isThisWeek(today)).toBe(true);
    });

    it('should return true for Monday of this week', () => {
      const monday = getStartOfWeek();
      expect(isThisWeek(monday)).toBe(true);
    });

    it('should return true for Sunday of this week', () => {
      const sunday = getEndOfWeek();
      expect(isThisWeek(sunday)).toBe(true);
    });
  });

  describe('isInRange', () => {
    it('should return true for date in range', () => {
      const date = new Date('2024-01-15');
      const start = new Date('2024-01-01');
      const end = new Date('2024-01-31');
      expect(isInRange(date, start, end)).toBe(true);
    });

    it('should return false for date before range', () => {
      const date = new Date('2023-12-31');
      const start = new Date('2024-01-01');
      const end = new Date('2024-01-31');
      expect(isInRange(date, start, end)).toBe(false);
    });

    it('should return false for date after range', () => {
      const date = new Date('2024-02-01');
      const start = new Date('2024-01-01');
      const end = new Date('2024-01-31');
      expect(isInRange(date, start, end)).toBe(false);
    });
  });

  describe('daysBetween', () => {
    it('should return 0 for same date', () => {
      const date = new Date('2024-01-15');
      expect(daysBetween(date, date)).toBe(0);
    });

    it('should return 1 for consecutive dates', () => {
      const date1 = new Date('2024-01-15');
      const date2 = new Date('2024-01-16');
      expect(daysBetween(date1, date2)).toBe(1);
    });

    it('should return positive value regardless of order', () => {
      const date1 = new Date('2024-01-15');
      const date2 = new Date('2024-01-20');
      expect(daysBetween(date1, date2)).toBe(5);
      expect(daysBetween(date2, date1)).toBe(5);
    });
  });

  describe('addDays', () => {
    it('should add days correctly', () => {
      const date = new Date('2024-01-15');
      const result = addDays(date, 5);
      expect(result.getDate()).toBe(20);
    });

    it('should handle negative days', () => {
      const date = new Date('2024-01-15');
      const result = addDays(date, -5);
      expect(result.getDate()).toBe(10);
    });

    it('should not modify original date', () => {
      const date = new Date('2024-01-15');
      const originalDate = date.getDate();
      addDays(date, 5);
      expect(date.getDate()).toBe(originalDate);
    });
  });

  describe('addWeeks', () => {
    it('should add weeks correctly', () => {
      const date = new Date('2024-01-15');
      const result = addWeeks(date, 2);
      expect(result.getDate()).toBe(29);
    });
  });

  describe('addMonths', () => {
    it('should add months correctly', () => {
      const date = new Date('2024-01-15');
      const result = addMonths(date, 2);
      expect(result.getMonth()).toBe(2); // March (0-indexed)
    });
  });

  describe('addYears', () => {
    it('should add years correctly', () => {
      const date = new Date('2024-01-15');
      const result = addYears(date, 2);
      expect(result.getFullYear()).toBe(2026);
    });
  });

  describe('formatDate', () => {
    it('should format date with default format', () => {
      const date = new Date('2024-01-15T10:30:45');
      const formatted = formatDate(date);
      expect(formatted).toMatch(/2024-01-15 \d{2}:30:45/);
    });

    it('should format date with custom format', () => {
      const date = new Date('2024-01-15T10:30:45');
      const formatted = formatDate(date, 'YYYY/MM/DD');
      expect(formatted).toMatch(/2024\/01\/15/);
    });

    it('should pad single digits with zero', () => {
      const date = new Date('2024-01-05T09:05:05');
      const formatted = formatDate(date);
      expect(formatted).toMatch(/2024-01-05 \d{2}:05:05/);
    });
  });
});
