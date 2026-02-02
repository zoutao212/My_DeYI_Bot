/**
 * 验证器
 * 
 * 提供数据验证函数。
 */

import type { DailyTask, Memory, Reminder, TechnicalTask } from '../types.js';

/**
 * 验证任务数据
 * @param task 任务数据
 * @returns 验证结果
 */
export function validateTask(task: Partial<DailyTask>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // 验证标题
  if (!task.title || task.title.trim().length === 0) {
    errors.push('任务标题不能为空');
  }

  if (task.title && task.title.length > 200) {
    errors.push('任务标题不能超过 200 个字符');
  }

  // 验证优先级
  if (task.priority && !['low', 'medium', 'high', 'urgent'].includes(task.priority)) {
    errors.push('任务优先级必须是 low、medium、high 或 urgent');
  }

  // 验证状态
  if (
    task.status &&
    !['pending', 'in_progress', 'completed', 'cancelled'].includes(task.status)
  ) {
    errors.push('任务状态必须是 pending、in_progress、completed 或 cancelled');
  }

  // 验证截止日期
  if (task.dueDate && !(task.dueDate instanceof Date)) {
    errors.push('截止日期必须是有效的日期对象');
  }

  // 允许今天的日期，只检查是否早于今天的开始时间
  if (task.dueDate && task.status === 'pending') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (task.dueDate < today) {
      errors.push('截止日期不能早于今天');
    }
  }

  // 验证标签
  if (task.tags && !Array.isArray(task.tags)) {
    errors.push('标签必须是数组');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证记忆数据
 * @param memory 记忆数据
 * @returns 验证结果
 */
export function validateMemory(memory: Partial<Memory>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // 验证内容
  if (!memory.content || memory.content.trim().length === 0) {
    errors.push('记忆内容不能为空');
  }

  // 验证类型
  if (memory.type && !['conversation', 'summary', 'important'].includes(memory.type)) {
    errors.push('记忆类型必须是 conversation、summary 或 important');
  }

  // 验证重要性
  if (memory.importance !== undefined) {
    if (typeof memory.importance !== 'number') {
      errors.push('重要性必须是数字');
    } else if (memory.importance < 0 || memory.importance > 10) {
      errors.push('重要性必须在 0-10 之间');
    }
  }

  // 验证标签
  if (memory.tags && !Array.isArray(memory.tags)) {
    errors.push('标签必须是数组');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证提醒数据
 * @param reminder 提醒数据
 * @returns 验证结果
 */
export function validateReminder(reminder: Partial<Reminder>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // 验证标题
  if (!reminder.title || reminder.title.trim().length === 0) {
    errors.push('提醒标题不能为空');
  }

  // 验证消息
  if (!reminder.message || reminder.message.trim().length === 0) {
    errors.push('提醒消息不能为空');
  }

  // 验证提醒时间
  if (!reminder.dueTime) {
    errors.push('提醒时间不能为空');
  } else if (!(reminder.dueTime instanceof Date)) {
    errors.push('提醒时间必须是有效的日期对象');
  } else if (reminder.dueTime < new Date()) {
    errors.push('提醒时间不能早于当前时间');
  }

  // 验证重复配置
  if (reminder.repeat) {
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(reminder.repeat.frequency)) {
      errors.push('重复频率必须是 daily、weekly、monthly 或 yearly');
    }

    if (typeof reminder.repeat.interval !== 'number' || reminder.repeat.interval < 1) {
      errors.push('重复间隔必须是大于 0 的整数');
    }

    if (reminder.repeat.endDate && reminder.dueTime && reminder.repeat.endDate < reminder.dueTime) {
      errors.push('重复结束日期不能早于提醒时间');
    }
  }

  // 验证提前提醒时间
  if (reminder.advanceTime !== undefined) {
    if (typeof reminder.advanceTime !== 'number' || reminder.advanceTime < 0) {
      errors.push('提前提醒时间必须是非负整数');
    }
  }

  // 验证状态
  if (
    reminder.status &&
    !['active', 'paused', 'completed', 'cancelled'].includes(reminder.status)
  ) {
    errors.push('提醒状态必须是 active、paused、completed 或 cancelled');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证技术任务数据
 * @param task 技术任务数据
 * @returns 验证结果
 */
export function validateTechnicalTask(task: Partial<TechnicalTask>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // 验证类型
  if (!task.type || task.type.trim().length === 0) {
    errors.push('任务类型不能为空');
  }

  // 验证描述
  if (!task.description || task.description.trim().length === 0) {
    errors.push('任务描述不能为空');
  }

  // 验证参数
  if (!task.parameters || typeof task.parameters !== 'object') {
    errors.push('任务参数必须是对象');
  }

  // 验证优先级
  if (task.priority !== undefined) {
    if (typeof task.priority !== 'number') {
      errors.push('优先级必须是数字');
    } else if (task.priority < 0 || task.priority > 10) {
      errors.push('优先级必须在 0-10 之间');
    }
  }

  // 验证超时时间
  if (task.timeout !== undefined) {
    if (typeof task.timeout !== 'number' || task.timeout <= 0) {
      errors.push('超时时间必须是大于 0 的整数');
    }
  }

  // 验证状态
  if (
    task.status &&
    !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(task.status)
  ) {
    errors.push('任务状态必须是 pending、running、completed、failed 或 cancelled');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证日期范围
 * @param start 开始日期
 * @param end 结束日期
 * @returns 验证结果
 */
export function validateDateRange(start: Date, end: Date): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!(start instanceof Date) || !(end instanceof Date)) {
    errors.push('开始日期和结束日期必须是有效的日期对象');
  } else if (start > end) {
    errors.push('开始日期不能晚于结束日期');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
