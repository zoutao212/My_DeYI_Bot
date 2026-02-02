/**
 * 记忆归档器 (Memory Archiver)
 * 
 * 负责将会话总结归档到记忆存储
 * 
 * @module agents/memory/archiver
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  MemoryServiceConfig,
  MemoryArchivalRequest,
  MemoryArchivalResult,
} from "./types.js";
import type { SessionSummary } from "../session-summary.js";

/**
 * 记忆归档器
 * 
 * 功能：
 * - 根据策略判断是否需要归档
 * - 格式化会话总结为 Markdown 或 JSON
 * - 写入归档文件
 * - 触发索引更新
 */
export class MemoryArchiver {
  constructor(private config: MemoryServiceConfig) {}

  /**
   * 归档会话总结
   * 
   * @param request - 归档请求
   * @returns 归档结果
   */
  async archive(request: MemoryArchivalRequest): Promise<MemoryArchivalResult> {
    const startTime = Date.now();

    try {
      // 1. 检查归档策略
      if (!this.shouldArchive(request)) {
        return {
          path: "",
          success: true,
          durationMs: Date.now() - startTime,
        };
      }

      // 2. 格式化总结
      const format = request.params?.format ?? this.config.archival.format;
      const content = this.formatSummary(request.summary, request.context, format);

      // 3. 确定归档路径
      const archivePath = this.resolveArchivePath(request, format);

      // 4. 写入文件
      await this.writeArchiveFile(archivePath, content);

      return {
        path: archivePath,
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        path: "",
        success: false,
        error: String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 判断是否需要归档
   * 
   * @param request - 归档请求
   * @returns 是否需要归档
   */
  private shouldArchive(request: MemoryArchivalRequest): boolean {
    const strategy = this.config.archival.strategy;

    if (strategy === "always") {
      return true;
    }

    if (strategy === "on-demand") {
      return false; // 需要显式调用
    }

    if (strategy === "threshold") {
      // 检查是否达到归档阈值
      const frequency = this.config.archival.frequency;
      return request.summary.totalTurns >= frequency;
    }

    return false;
  }

  /**
   * 格式化会话总结
   * 
   * @param summary - 会话总结
   * @param context - 上下文信息
   * @param format - 归档格式
   * @returns 格式化后的内容
   */
  private formatSummary(
    summary: SessionSummary,
    context: { userId: string; sessionId: string },
    format: "markdown" | "json",
  ): string {
    if (format === "json") {
      return JSON.stringify(
        {
          sessionId: context.sessionId,
          userId: context.userId,
          createdAt: new Date(summary.createdAt).toISOString(),
          totalTurns: summary.totalTurns,
          taskGoal: summary.taskGoal,
          keyActions: summary.keyActions,
          keyDecisions: summary.keyDecisions,
          blockers: summary.blockers,
          progress: summary.progress,
        },
        null,
        2,
      );
    }

    // Markdown 格式
    const date = new Date(summary.createdAt).toISOString();

    const parts = [
      `# 会话总结 - ${context.sessionId}`,
      "",
      `**时间**: ${date}`,
      `**用户**: ${context.userId}`,
      `**对话轮数**: ${summary.totalTurns}`,
      "",
      `## 任务目标`,
      "",
      summary.taskGoal,
      "",
    ];

    if (summary.keyActions.length > 0) {
      parts.push(`## 关键操作`, "");
      parts.push(...summary.keyActions.map((a) => `- ${a}`));
      parts.push("");
    }

    if (summary.keyDecisions.length > 0) {
      parts.push(`## 关键决策`, "");
      parts.push(...summary.keyDecisions.map((d, i) => `${i + 1}. ${d}`));
      parts.push("");
    }

    if (summary.blockers.length > 0) {
      parts.push(`## 遇到的问题`, "");
      parts.push(...summary.blockers.map((b, i) => `${i + 1}. ${b}`));
      parts.push("");
    }

    if (summary.progress) {
      parts.push(`## 进度`, "");
      parts.push(
        `${summary.progress.completed}/${summary.progress.total} (${summary.progress.percentage}%)`,
      );
      parts.push("");
    }

    return parts.join("\n");
  }

  /**
   * 解析归档路径
   * 
   * @param request - 归档请求
   * @param format - 归档格式
   * @returns 归档文件路径
   */
  private resolveArchivePath(
    request: MemoryArchivalRequest,
    format: "markdown" | "json",
  ): string {
    const basePath = request.params?.path ?? this.config.archival.path;
    const date = new Date(request.summary.createdAt);
    const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
    const ext = format === "json" ? "json" : "md";

    return path.join(basePath, dateStr, `${request.context.sessionId}.${ext}`);
  }

  /**
   * 写入归档文件
   * 
   * @param filePath - 文件路径
   * @param content - 文件内容
   */
  private async writeArchiveFile(filePath: string, content: string): Promise<void> {
    // 确保目录存在
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // 写入文件
    await fs.writeFile(filePath, content, "utf-8");
  }
}
