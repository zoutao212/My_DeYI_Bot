/**
 * 日期工具函数
 * 
 * 提供日期相关的工具函数。
 */

/**
 * 获取今天的开始时间（00:00:00）
 * @returns 今天的开始时间
 */
export function getStartOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

/**
 * 获取今天的结束时间（23:59:59）
 * @returns 今天的结束时间
 */
export function getEndOfToday(): Date {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  return now;
}

/**
 * 获取本周的开始时间（周一 00:00:00）
 * @returns 本周的开始时间
 */
export function getStartOfWeek(): Date {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day; // 周日是 0，需要特殊处理
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * 获取本周的结束时间（周日 23:59:59）
 * @returns 本周的结束时间
 */
export function getEndOfWeek(): Date {
  const startOfWeek = getStartOfWeek();
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);
  return endOfWeek;
}

/**
 * 检查日期是否在今天
 * @param date 要检查的日期
 * @returns 是否在今天
 */
export function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

/**
 * 检查日期是否在本周
 * @param date 要检查的日期
 * @returns 是否在本周
 */
export function isThisWeek(date: Date): boolean {
  const startOfWeek = getStartOfWeek();
  const endOfWeek = getEndOfWeek();
  return date >= startOfWeek && date <= endOfWeek;
}

/**
 * 检查日期是否在指定范围内
 * @param date 要检查的日期
 * @param start 范围开始时间
 * @param end 范围结束时间
 * @returns 是否在范围内
 */
export function isInRange(date: Date, start: Date, end: Date): boolean {
  return date >= start && date <= end;
}

/**
 * 计算两个日期之间的天数差
 * @param date1 第一个日期
 * @param date2 第二个日期
 * @returns 天数差（绝对值）
 */
export function daysBetween(date1: Date, date2: Date): number {
  const oneDay = 24 * 60 * 60 * 1000; // 一天的毫秒数
  const diffMs = Math.abs(date1.getTime() - date2.getTime());
  return Math.floor(diffMs / oneDay);
}

/**
 * 添加天数到日期
 * @param date 原始日期
 * @param days 要添加的天数
 * @returns 新日期
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * 添加周数到日期
 * @param date 原始日期
 * @param weeks 要添加的周数
 * @returns 新日期
 */
export function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

/**
 * 添加月数到日期
 * @param date 原始日期
 * @param months 要添加的月数
 * @returns 新日期
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

/**
 * 添加年数到日期
 * @param date 原始日期
 * @param years 要添加的年数
 * @returns 新日期
 */
export function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

/**
 * 格式化日期为字符串
 * @param date 日期
 * @param format 格式（默认：'YYYY-MM-DD HH:mm:ss'）
 * @returns 格式化后的字符串
 */
export function formatDate(date: Date, format = 'YYYY-MM-DD HH:mm:ss'): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return format
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds);
}
