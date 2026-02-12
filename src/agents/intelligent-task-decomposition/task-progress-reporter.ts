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

/**
 * V8 P5: 格式化详细的轮次进度仪表盘
 *
 * 输出示例：
 * 📊 创作进度：4/6 完成 (67%)
 * ✅ 第1章(3012字) ✅ 第2章(2856字) ✅ 第3章(3201字) ✅ 第4章(2945字)
 * ⏳ 第5章 执行中 (45s)
 * ⏸️ 第6章 等待中
 * ⚠️ 失败: 0 | 预估剩余: ~2 分钟
 */
export function formatDetailedProgress(
  taskTree: TaskTree | null | undefined,
  rootTaskId?: string,
): string {
  if (!taskTree) return "📊 无任务数据";

  const tasks = rootTaskId
    ? taskTree.subTasks.filter((t) => t.rootTaskId === rootTaskId && !t.waitForChildren)
    : taskTree.subTasks.filter((t) => !t.waitForChildren);

  if (tasks.length === 0) return "📊 无子任务";

  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");
  const active = tasks.filter((t) => t.status === "active");
  const pending = tasks.filter((t) => t.status === "pending");
  const skipped = tasks.filter((t) => t.status === "skipped");

  const pct = tasks.length > 0 ? Math.round((completed.length / tasks.length) * 100) : 0;

  // 标题行
  const lines: string[] = [
    `📊 任务进度：${completed.length}/${tasks.length} 完成 (${pct}%)`,
  ];

  // 每个子任务的状态行
  const taskLines: string[] = [];
  for (const t of tasks) {
    const label = t.summary?.substring(0, 25) || t.id.substring(0, 8);

    switch (t.status) {
      case "completed": {
        // 尝试获取字数信息
        let charInfo = "";
        if (t.metadata?.mergeChars) {
          charInfo = `(${t.metadata.mergeChars}字)`;
        } else if (t.output && t.output.length > 500) {
          charInfo = `(~${t.output.length}字)`;
        }
        taskLines.push(`✅ ${label}${charInfo}`);
        break;
      }
      case "active": {
        const elapsed = t.createdAt ? Math.round((Date.now() - t.createdAt) / 1000) : 0;
        taskLines.push(`⏳ ${label} 执行中${elapsed > 0 ? ` (${formatDuration(elapsed)})` : ""}`);
        break;
      }
      case "failed":
        taskLines.push(`❌ ${label} 失败`);
        break;
      case "pending":
        taskLines.push(`⏸️ ${label} 等待中`);
        break;
      case "skipped":
        taskLines.push(`⏭️ ${label} 已跳过`);
        break;
      default:
        taskLines.push(`❓ ${label} ${t.status}`);
    }
  }
  lines.push(taskLines.join("  "));

  // 摘要行
  const summaryParts: string[] = [];
  if (failed.length > 0) summaryParts.push(`❌ 失败: ${failed.length}`);
  if (skipped.length > 0) summaryParts.push(`⏭️ 跳过: ${skipped.length}`);

  // 预估剩余时间（基于已完成任务的平均耗时）
  if (completed.length > 0 && (active.length + pending.length) > 0) {
    const completedDurations = completed
      .filter((t) => t.createdAt && t.completedAt)
      .map((t) => (t.completedAt! - t.createdAt))
      .filter((d) => d > 0);
    if (completedDurations.length > 0) {
      const avgMs = completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length;
      const remainingCount = active.length + pending.length;
      const estRemainingMs = avgMs * remainingCount;
      const estRemainingSec = Math.round(estRemainingMs / 1000);
      summaryParts.push(`预估剩余: ~${formatDuration(estRemainingSec)}`);
    }
  }

  if (summaryParts.length > 0) {
    lines.push(summaryParts.join(" | "));
  }

  return lines.join("\n");
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
