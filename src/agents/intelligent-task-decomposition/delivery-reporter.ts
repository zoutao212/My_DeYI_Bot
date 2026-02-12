/**
 * 结构化交付报告生成器 (Delivery Reporter)
 *
 * 在任务树完成后，生成结构化 Markdown 交付报告，
 * 包含：任务摘要、完成列表、产出文件、关键决策、失败教训、统计信息。
 *
 * @module agents/intelligent-task-decomposition/delivery-reporter
 */

import type { TaskTree, SubTask } from "./types.js";

/**
 * 交付报告数据结构
 */
export interface DeliveryReport {
  /** 任务摘要 */
  summary: string;
  /** 已完成的任务列表 */
  completedTasks: Array<{ summary: string; output?: string }>;
  /** 产出的文件列表 */
  producedFiles: string[];
  /** 关键决策 */
  keyDecisions: string[];
  /** 失败与教训 */
  failuresAndLessons: Array<{ task: string; error: string; lesson?: string }>;
  /** 统计信息 */
  statistics: {
    total: number;
    completed: number;
    failed: number;
    durationMs: number;
    successRate: string;
  };
  /** 🆕 P65: 合并质量摘要 */
  mergeQuality?: {
    totalChapters: number;
    totalChars: number;
    qualityCounts: { excellent: number; good: number; degraded: number; failed: number };
  };
}

/**
 * 结构化交付报告生成器
 */
export class DeliveryReporter {
  /**
   * 从任务树生成交付报告
   *
   * @param taskTree - 已完成/失败的任务树
   * @returns 交付报告数据
   */
  generateReport(taskTree: TaskTree): DeliveryReport {
    const completed = taskTree.subTasks.filter((t) => t.status === "completed");
    const failed = taskTree.subTasks.filter((t) => t.status === "failed");
    const total = taskTree.subTasks.length;
    const durationMs = taskTree.updatedAt - taskTree.createdAt;

    // 🆕 P65: 收集合并质量指标
    const mergeQuality = this.collectMergeQuality(taskTree);

    return {
      summary: this.buildSummary(taskTree, completed.length, failed.length),
      completedTasks: completed.map((t) => ({
        summary: t.summary,
        output: t.output?.substring(0, 300),
      })),
      producedFiles: this.collectProducedFiles(taskTree),
      keyDecisions: this.extractKeyDecisions(taskTree),
      failuresAndLessons: failed.map((t) => ({
        task: t.summary,
        error: t.error ?? "未知错误",
        lesson: this.extractLesson(t),
      })),
      statistics: {
        total,
        completed: completed.length,
        failed: failed.length,
        durationMs,
        successRate: total > 0 ? `${Math.round((completed.length / total) * 100)}%` : "0%",
      },
      mergeQuality,
    };
  }

  /**
   * 将交付报告格式化为 Markdown
   *
   * @param report - 交付报告数据
   * @returns 格式化的 Markdown 文本
   */
  formatAsMarkdown(report: DeliveryReport): string {
    const parts: string[] = [];

    // 标题
    parts.push("# 📦 任务交付报告");
    parts.push("");

    // 摘要
    parts.push("## 摘要");
    parts.push(report.summary);
    parts.push("");

    // 统计
    parts.push("## 📊 统计");
    parts.push(`- **总任务数**: ${report.statistics.total}`);
    parts.push(`- **已完成**: ${report.statistics.completed}`);
    parts.push(`- **失败**: ${report.statistics.failed}`);
    parts.push(`- **成功率**: ${report.statistics.successRate}`);
    parts.push(`- **耗时**: ${this.formatDuration(report.statistics.durationMs)}`);
    parts.push("");

    // 已完成任务
    if (report.completedTasks.length > 0) {
      parts.push("## ✅ 已完成任务");
      for (const task of report.completedTasks) {
        parts.push(`- **${task.summary}**`);
        if (task.output) {
          parts.push(`  > ${task.output.substring(0, 100)}${task.output.length > 100 ? "..." : ""}`);
        }
      }
      parts.push("");
    }

    // 产出文件
    if (report.producedFiles.length > 0) {
      parts.push("## 📁 产出文件");
      for (const file of report.producedFiles) {
        parts.push(`- \`${file}\``);
      }
      parts.push("");
    }

    // 🆕 P65: 合并质量摘要
    if (report.mergeQuality && report.mergeQuality.totalChapters > 0) {
      const mq = report.mergeQuality;
      parts.push("## 📝 合并质量");
      parts.push(`- **章节数**: ${mq.totalChapters}`);
      parts.push(`- **总字数**: ${mq.totalChars.toLocaleString()}`);
      const qLabels = [];
      if (mq.qualityCounts.excellent > 0) qLabels.push(`✅ 优秀 ${mq.qualityCounts.excellent}`);
      if (mq.qualityCounts.good > 0) qLabels.push(`🟡 良好 ${mq.qualityCounts.good}`);
      if (mq.qualityCounts.degraded > 0) qLabels.push(`⚠️ 偏低 ${mq.qualityCounts.degraded}`);
      if (mq.qualityCounts.failed > 0) qLabels.push(`❌ 不足 ${mq.qualityCounts.failed}`);
      if (qLabels.length > 0) {
        parts.push(`- **质量分布**: ${qLabels.join(" | ")}`);
      }
      parts.push("");
    }

    // 失败与教训
    if (report.failuresAndLessons.length > 0) {
      parts.push("## ❌ 失败与教训");
      for (const item of report.failuresAndLessons) {
        parts.push(`- **${item.task}**: ${item.error}`);
        if (item.lesson) {
          parts.push(`  > 教训: ${item.lesson}`);
        }
      }
      parts.push("");
    }

    return parts.join("\n");
  }

  private buildSummary(taskTree: TaskTree, completed: number, failed: number): string {
    const status = failed > 0 ? "部分完成" : "全部完成";
    return `任务「${taskTree.rootTask}」已${status}：${completed} 个子任务成功，${failed} 个失败。`;
  }

  private collectProducedFiles(taskTree: TaskTree): string[] {
    const files: string[] = [];
    for (const t of taskTree.subTasks) {
      if (t.metadata?.producedFiles) {
        files.push(...(t.metadata.producedFiles as string[]));
      }
    }
    return [...new Set(files)];
  }

  private extractKeyDecisions(taskTree: TaskTree): string[] {
    if (!taskTree.failureHistory || taskTree.failureHistory.length === 0) return [];
    return taskTree.failureHistory
      .flatMap((f) => f.lessons ?? [])
      .filter(Boolean)
      .slice(0, 5);
  }

  private extractLesson(task: SubTask): string | undefined {
    if (!task.error) return undefined;
    if (task.retryCount > 1) {
      return `重试 ${task.retryCount} 次后仍然失败，可能需要调整策略`;
    }
    return undefined;
  }

  /**
   * 🆕 P65: 收集合并质量指标（从含 mergeQuality 的父任务中提取）
   */
  private collectMergeQuality(taskTree: TaskTree): DeliveryReport["mergeQuality"] {
    const chaptersWithQuality = taskTree.subTasks.filter(
      (t) => t.metadata?.mergeQuality && t.metadata?.mergeChars != null,
    );
    if (chaptersWithQuality.length === 0) return undefined;

    const qualityCounts = { excellent: 0, good: 0, degraded: 0, failed: 0 };
    let totalChars = 0;
    for (const ch of chaptersWithQuality) {
      const q = ch.metadata!.mergeQuality as keyof typeof qualityCounts;
      if (q in qualityCounts) qualityCounts[q]++;
      totalChars += ch.metadata!.mergeChars ?? 0;
    }

    return {
      totalChapters: chaptersWithQuality.length,
      totalChars,
      qualityCounts,
    };
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = seconds % 60;
    return `${minutes}m ${remainSeconds}s`;
  }
}
