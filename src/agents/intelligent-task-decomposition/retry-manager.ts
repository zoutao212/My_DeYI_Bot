/**
 * 重试管理器
 * 
 * 负责自动重试失败的子任务，使用指数退避策略
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SubTask, FailureLog } from "./types.js";

/**
 * 重试管理器
 */
export class RetryManager {
  /**
   * 获取失败日志文件路径
   */
  private getFailureLogPath(sessionId: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
    return path.join(homeDir, ".clawdbot", "tasks", sessionId, "failures.log");
  }

  /**
   * 判断错误是否可重试
   */
  isRetryable(error: Error): boolean {
    const errorMessage = error.message.toLowerCase();

    // 可重试的错误类型
    const retryableErrors = [
      "timeout",
      "network",
      "econnrefused",
      "econnreset",
      "etimedout",
      "rate limit",
      "too many requests",
      "503",
      "502",
      "504",
    ];

    // 不可重试的错误类型
    const nonRetryableErrors = [
      "syntax error",
      "type error",
      "reference error",
      "file not found",
      "enoent",
      "permission denied",
      "eacces",
      "invalid argument",
      "einval",
    ];

    // 检查是否是不可重试的错误
    for (const pattern of nonRetryableErrors) {
      if (errorMessage.includes(pattern)) {
        return false;
      }
    }

    // 检查是否是可重试的错误
    for (const pattern of retryableErrors) {
      if (errorMessage.includes(pattern)) {
        return true;
      }
    }

    // 默认不重试
    return false;
  }

  /**
   * 执行任务并自动重试
   */
  async executeWithRetry<T>(
    subTask: SubTask,
    executor: () => Promise<T>,
    maxRetries: number = 3,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[RetryManager] 🔄 Executing task (attempt ${attempt + 1}/${maxRetries + 1}): ${subTask.id}`);
        const result = await executor();
        console.log(`[RetryManager] ✅ Task succeeded: ${subTask.id}`);
        return result;
      } catch (error) {
        lastError = error as Error;
        console.error(`[RetryManager] ❌ Task failed (attempt ${attempt + 1}/${maxRetries + 1}): ${subTask.id}`, error);

        // 检查是否可重试
        if (!this.isRetryable(lastError)) {
          console.error(`[RetryManager] ⚠️ Error is not retryable: ${lastError.message}`);
          throw lastError;
        }

        // 如果还有重试机会，等待后重试
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 指数退避：1s, 2s, 4s
          console.log(`[RetryManager] ⏳ Waiting ${delay}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // 所有重试都失败了
    console.error(`[RetryManager] ❌ All retries failed for task: ${subTask.id}`);
    throw lastError!;
  }

  /**
   * 记录失败日志
   */
  async logFailure(subTask: SubTask, error: Error, sessionId: string): Promise<void> {
    const failureLog: FailureLog = {
      subTaskId: subTask.id,
      error: error.message,
      stackTrace: error.stack || "",
      retryCount: subTask.retryCount,
      timestamp: Date.now(),
    };

    const logPath = this.getFailureLogPath(sessionId);

    // 确保目录存在
    const dir = path.dirname(logPath);
    await fs.mkdir(dir, { recursive: true });

    // 追加日志
    const logLine = JSON.stringify(failureLog) + "\n";
    await fs.appendFile(logPath, logLine, "utf-8");

    console.log(`[RetryManager] 📝 Failure logged: ${logPath}`);
  }

  /**
   * 获取失败日志
   */
  async getFailureLogs(sessionId: string): Promise<FailureLog[]> {
    const logPath = this.getFailureLogPath(sessionId);

    try {
      const content = await fs.readFile(logPath, "utf-8");
      const lines = content.trim().split("\n");
      const logs = lines.map((line) => JSON.parse(line) as FailureLog);
      return logs;
    } catch (err) {
      // 文件不存在或读取失败
      return [];
    }
  }
}
