/**
 * 错误处理器
 * 
 * 负责处理各种错误、记录错误日志、尝试恢复
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ErrorLog } from "./types.js";

/**
 * 错误处理器
 */
export class ErrorHandler {
  /**
   * 获取错误日志文件路径
   */
  private getErrorLogPath(sessionId: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
    return path.join(homeDir, ".clawdbot", "tasks", sessionId, "errors.log");
  }

  /**
   * 处理错误
   */
  async handleError(
    error: Error,
    context: Record<string, unknown>,
    sessionId: string,
  ): Promise<void> {
    const errorType = this.classifyError(error);

    // 记录错误日志
    await this.logError(errorType, error, context, sessionId);

    // 尝试恢复
    const recovered = await this.tryRecover(error, context);
    if (recovered) {
      console.log(`[ErrorHandler] ✅ Recovered from error: ${error.message}`);
    } else {
      console.error(`[ErrorHandler] ❌ Failed to recover from error: ${error.message}`);
    }
  }

  /**
   * 记录错误日志
   */
  async logError(
    errorType: ErrorLog["errorType"],
    error: Error,
    context: Record<string, unknown>,
    sessionId: string,
  ): Promise<void> {
    const errorLog: ErrorLog = {
      errorType,
      error: error.message,
      stackTrace: error.stack || "",
      context,
      timestamp: Date.now(),
    };

    const logPath = this.getErrorLogPath(sessionId);
    const logLine = JSON.stringify(errorLog) + "\n";

    try {
      await fs.appendFile(logPath, logLine, "utf-8");
      console.log(`[ErrorHandler] ✅ Error logged: ${logPath}`);
    } catch (err) {
      console.error(`[ErrorHandler] ❌ Failed to log error: ${err}`);
    }
  }

  /**
   * 获取错误日志
   */
  async getErrorLogs(sessionId: string): Promise<ErrorLog[]> {
    const logPath = this.getErrorLogPath(sessionId);

    try {
      const content = await fs.readFile(logPath, "utf-8");
      const lines = content.trim().split("\n");
      return lines.map((line) => JSON.parse(line) as ErrorLog);
    } catch {
      return [];
    }
  }

  /**
   * 尝试恢复
   */
  async tryRecover(error: Error, context: Record<string, unknown>): Promise<boolean> {
    const errorType = this.classifyError(error);

    switch (errorType) {
      case "llm_request_failed":
        // LLM 请求失败：由 RetryManager 处理重试
        return false;

      case "file_system_failed":
        // 文件系统操作失败：备份到临时位置
        return await this.backupToTemp(context);

      case "out_of_memory":
        // 内存不足：释放资源
        return await this.freeMemory();

      case "system_crash":
        // 系统崩溃：从检查点恢复（由 RecoveryManager 处理）
        return false;

      default:
        return false;
    }
  }

  /**
   * 分类错误
   */
  private classifyError(error: Error): ErrorLog["errorType"] {
    const message = error.message.toLowerCase();

    if (message.includes("llm") || message.includes("model") || message.includes("api")) {
      return "llm_request_failed";
    }

    if (
      message.includes("enoent") ||
      message.includes("eacces") ||
      message.includes("eperm") ||
      message.includes("file")
    ) {
      return "file_system_failed";
    }

    if (message.includes("memory") || message.includes("heap")) {
      return "out_of_memory";
    }

    return "system_crash";
  }

  /**
   * 备份到临时位置
   */
  private async backupToTemp(context: Record<string, unknown>): Promise<boolean> {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
      const tempDir = path.join(homeDir, ".clawdbot", "temp");
      await fs.mkdir(tempDir, { recursive: true });

      const backupPath = path.join(tempDir, `backup_${Date.now()}.json`);
      await fs.writeFile(backupPath, JSON.stringify(context, null, 2), "utf-8");

      console.log(`[ErrorHandler] ✅ Backed up to temp: ${backupPath}`);
      return true;
    } catch (err) {
      console.error(`[ErrorHandler] ❌ Failed to backup to temp: ${err}`);
      return false;
    }
  }

  /**
   * 释放内存
   */
  private async freeMemory(): Promise<boolean> {
    try {
      // 触发垃圾回收（如果可用）
      if (global.gc) {
        global.gc();
        console.log(`[ErrorHandler] ✅ Garbage collection triggered`);
        return true;
      }

      console.warn(`[ErrorHandler] ⚠️ Garbage collection not available`);
      return false;
    } catch (err) {
      console.error(`[ErrorHandler] ❌ Failed to free memory: ${err}`);
      return false;
    }
  }
}
