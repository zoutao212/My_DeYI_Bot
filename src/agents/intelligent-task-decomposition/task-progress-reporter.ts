/**
 * 任务进度报告器
 * 
 * 在任务树执行期间定期向用户推送进度消息并输出控制台日志，
 * 让焦急等待的用户时刻了解系统当前的执行进展。
 * 
 * 使用方式：
 *   const reporter = new TaskProgressReporter(totalTasks);
 *   reporter.setSender(async (text) => sendFollowupPayloads([{ text }], queued));
 *   reporter.onTaskStart('第1章：废体觉醒');
 *   reporter.onLLMStart();
 *   // ... LLM 执行 ...
 *   reporter.onLLMComplete();
 *   reporter.onQualityReviewStart();
 *   // ... 质检 ...
 *   reporter.onQualityReviewComplete();
 *   reporter.onTaskComplete();
 *   reporter.dispose();
 */

import type { TaskTree } from "./types.js";

// ── 类型定义 ──

export type TaskPhase =
  | "starting"        // 任务开始
  | "llm_requesting"  // 等待 AI 回复
  | "quality_review"  // 质量评估中
  | "post_processing" // 后处理
  | "completed"       // 任务完成
  | "failed"          // 任务失败
  | "idle";           // 空闲

/** 消息发送回调 */
export type ProgressSender = (text: string) => Promise<void>;

// ── 常量 ──

const PROGRESS_INTERVAL_MS = 10_000;  // 每 10 秒向用户推送一次进度
const CONSOLE_INTERVAL_MS = 15_000;   // 每 15 秒输出一次控制台日志
const MIN_SEND_GAP_MS = 8_000;        // 用户消息最小间隔，避免刷屏

// ── 辅助函数 ──

/** 从任务树中提取指定轮次的进度统计 */
export function getTaskProgressFromTree(
  taskTree: TaskTree | null | undefined,
  rootTaskId?: string,
): { total: number; completed: number; failed: number; active: number } {
  if (!taskTree) return { total: 0, completed: 0, failed: 0, active: 0 };
  const tasks = rootTaskId
    ? taskTree.subTasks.filter((t) => t.rootTaskId === rootTaskId && !t.waitForChildren)
    : taskTree.subTasks.filter((t) => !t.waitForChildren);
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    active: tasks.filter((t) => t.status === "active").length,
  };
}

/** 格式化秒数为人类友好的时间字符串 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

// ── 主类 ──

export class TaskProgressReporter {
  private totalTasks: number;
  private completedTasks = 0;
  private failedTasks = 0;
  private currentTaskSummary = "";
  private currentPhase: TaskPhase = "idle";
  private phaseStartedAt = Date.now();
  private drainStartedAt = Date.now();

  private userTimerId: ReturnType<typeof setInterval> | null = null;
  private consoleTimerId: ReturnType<typeof setInterval> | null = null;
  private sender: ProgressSender | null = null;
  private lastSentAt = 0;
  private disposed = false;

  constructor(totalTasks: number) {
    this.totalTasks = totalTasks;
  }

  /** 设置用户消息发送回调 */
  setSender(sender: ProgressSender): void {
    this.sender = sender;
  }

  /** 从任务树刷新计数 */
  updateCounts(completed: number, failed: number, total: number): void {
    this.completedTasks = completed;
    this.failedTasks = failed;
    this.totalTasks = total;
  }

  // ── 生命周期钩子 ──

  /** 新任务开始执行 */
  onTaskStart(summary: string): void {
    this.currentTaskSummary = summary;
    this.setPhase("starting");
    const msg = `🔄 任务进度 [${this.completedTasks}/${this.totalTasks}] 开始执行「${summary}」`;
    console.log(`[task-progress] ${msg}`);
    this.trySendToUser(msg);
  }

  /** 开始等待 LLM 回复 */
  onLLMStart(): void {
    this.setPhase("llm_requesting");
    console.log(`[task-progress] ⏳ [${this.completedTasks}/${this.totalTasks}]「${this.currentTaskSummary}」等待 AI 回复中...`);
    this.startPeriodicTimers();
  }

  /** LLM 回复完成 */
  onLLMComplete(charCount?: number): void {
    this.stopPeriodicTimers();
    const elapsed = this.phaseElapsed();
    const charInfo = charCount ? ` (回复约 ${charCount} 字)` : "";
    console.log(`[task-progress] ✅ AI 回复完成${charInfo}，耗时 ${formatDuration(elapsed)}`);
  }

  /** 开始质量评估 */
  onQualityReviewStart(): void {
    this.setPhase("quality_review");
    console.log(`[task-progress] 🔍 [${this.completedTasks}/${this.totalTasks}]「${this.currentTaskSummary}」开始质量评估...`);
    this.startPeriodicTimers();
  }

  /** 质量评估完成 */
  onQualityReviewComplete(passed: boolean): void {
    this.stopPeriodicTimers();
    const elapsed = this.phaseElapsed();
    const result = passed ? "通过 ✅" : "未通过 ⚠️";
    console.log(`[task-progress] 🔍 质量评估${result}，耗时 ${formatDuration(elapsed)}`);
  }

  /** 任务成功完成 */
  onTaskComplete(): void {
    this.stopPeriodicTimers();
    this.completedTasks++;
    this.setPhase("completed");
    const totalSec = this.totalElapsed();
    const msg = `✅ 任务进度 [${this.completedTasks}/${this.totalTasks}]「${this.currentTaskSummary}」已完成 | 总耗时 ${formatDuration(totalSec)}`;
    console.log(`[task-progress] ${msg}`);
    this.trySendToUser(msg);
  }

  /** 任务失败 */
  onTaskFailed(reason?: string): void {
    this.stopPeriodicTimers();
    this.failedTasks++;
    this.setPhase("failed");
    const suffix = reason ? ` — ${reason}` : "";
    console.log(`[task-progress] ❌ 任务失败「${this.currentTaskSummary}」${suffix}`);
  }

  /** 任务需要重试 */
  onTaskRestart(retryCount: number): void {
    this.stopPeriodicTimers();
    console.log(`[task-progress] 🔄 任务重试「${this.currentTaskSummary}」(第 ${retryCount} 次)`);
    const msg = `🔄 任务进度 [${this.completedTasks}/${this.totalTasks}]「${this.currentTaskSummary}」质量不达标，正在重试 (第 ${retryCount} 次)`;
    this.trySendToUser(msg);
  }

  /** 全部任务完成（drain 结束时调用） */
  onAllTasksComplete(): void {
    this.stopPeriodicTimers();
    const totalSec = this.totalElapsed();
    const msg = `🏁 所有任务已完成！共 ${this.completedTasks} 个成功` +
      (this.failedTasks > 0 ? `，${this.failedTasks} 个失败` : "") +
      ` | 总耗时 ${formatDuration(totalSec)}`;
    console.log(`[task-progress] ${msg}`);
    this.trySendToUser(msg);
  }

  /** 清理所有定时器 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPeriodicTimers();
  }

  // ── 内部方法 ──

  private setPhase(phase: TaskPhase): void {
    this.currentPhase = phase;
    this.phaseStartedAt = Date.now();
  }

  private phaseElapsed(): number {
    return Math.round((Date.now() - this.phaseStartedAt) / 1000);
  }

  private totalElapsed(): number {
    return Math.round((Date.now() - this.drainStartedAt) / 1000);
  }

  private generatePeriodicMessage(): string {
    const elapsed = this.phaseElapsed();
    const totalSec = this.totalElapsed();
    const progress = `[${this.completedTasks}/${this.totalTasks}]`;

    switch (this.currentPhase) {
      case "llm_requesting":
        return `⏳ 任务进度 ${progress}「${this.currentTaskSummary}」— 等待 AI 回复中... (已等待 ${formatDuration(elapsed)}) | 总耗时 ${formatDuration(totalSec)}`;
      case "quality_review":
        return `🔍 任务进度 ${progress}「${this.currentTaskSummary}」— AI 质量评估中... (已等待 ${formatDuration(elapsed)})`;
      case "post_processing":
        return `⚙️ 任务进度 ${progress}「${this.currentTaskSummary}」— 后处理中... (${formatDuration(elapsed)})`;
      default:
        return `⏳ 任务进度 ${progress} 处理中... | 总耗时 ${formatDuration(totalSec)}`;
    }
  }

  private startPeriodicTimers(): void {
    this.stopPeriodicTimers();

    // 用户侧定时推送（10 秒）
    this.userTimerId = setInterval(() => {
      if (this.disposed) return;
      const msg = this.generatePeriodicMessage();
      this.trySendToUser(msg);
    }, PROGRESS_INTERVAL_MS);

    // 控制台定时日志（15 秒）
    this.consoleTimerId = setInterval(() => {
      if (this.disposed) return;
      const msg = this.generatePeriodicMessage();
      console.log(`[task-progress] ${msg}`);
    }, CONSOLE_INTERVAL_MS);
  }

  private stopPeriodicTimers(): void {
    if (this.userTimerId) {
      clearInterval(this.userTimerId);
      this.userTimerId = null;
    }
    if (this.consoleTimerId) {
      clearInterval(this.consoleTimerId);
      this.consoleTimerId = null;
    }
  }

  private trySendToUser(text: string): void {
    if (!this.sender || this.disposed) return;
    const now = Date.now();
    if (now - this.lastSentAt < MIN_SEND_GAP_MS) return;
    this.lastSentAt = now;
    this.sender(text).catch((err) => {
      // 发送失败不阻塞主流程
      console.warn(`[task-progress] ⚠️ 发送进度消息失败: ${err}`);
    });
  }
}
