/**
 * 工具调用执行守卫
 * 
 * 职责：
 * 1. 检测伪工具调用（模型以文本形式输出而非 function calling）
 * 2. 验证写入操作是否真正执行
 * 3. 提供重试机制
 * 
 * @module agents/tool-execution-guard
 */

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("tool-guard");

// =============================================================================
// 类型定义
// =============================================================================

export interface ToolCallVerificationResult {
  verified: boolean;
  reason?: string;
  suggestion?: string;
}

export interface WriteVerificationParams {
  filePath: string;
  expectedContent?: string;
  expectedMinBytes?: number;
  timeoutMs?: number;
}

export interface PseudoToolCallDetectionResult {
  detected: boolean;
  toolName?: string;
  args?: Record<string, unknown>;
  rawMatch?: string;
  suggestion: string;
}

// =============================================================================
// 伪工具调用检测
// =============================================================================

/**
 * 检测模型输出中的伪工具调用
 * 
 * 当模型没有正确使用 function calling API 时，可能会以文本形式输出工具调用。
 * 这种情况下，工具不会真正执行。
 */
export function detectPseudoToolCall(text: string): PseudoToolCallDetectionResult {
  // 注意: 不再匹配 [Historical context: ...] 格式。
  // 该格式是 LLM 引述历史上下文的引用性文本（通常伴随 "Do not mimic this format"），
  // 不代表模型自身想调用工具。误匹配会导致 guard 层将引用文本转换为真正的 toolCall 执行。

  // 模式 1: 直接 JSON 工具调用格式
  // {"tool": "write", "arguments": {...}}
  const jsonToolPattern = /\{[\s\S]*?"tool"\s*:\s*["'](\w+)["'][\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\})/i;
  const jsonMatch = text.match(jsonToolPattern);
  if (jsonMatch) {
    try {
      const args = JSON.parse(jsonMatch[2]);
      return {
        detected: true,
        toolName: jsonMatch[1],
        args,
        rawMatch: jsonMatch[0],
        suggestion: "模型输出了 JSON 格式的工具调用，这不会触发真正的执行。",
      };
    } catch {
      // JSON 解析失败，可能是普通文本
    }
  }

  // 模式 3: 伪成功消息
  // Successfully wrote X bytes to path
  const successPattern = /Successfully wrote (\d+) bytes to ([\w\/\.\-]+)/i;
  const successMatch = text.match(successPattern);
  if (successMatch) {
    return {
      detected: true,
      toolName: "write",
      args: { path: successMatch[2] },
      rawMatch: successMatch[0],
      suggestion: "检测到伪成功消息，文件可能并未真正写入，请验证。",
    };
  }

  return {
    detected: false,
    suggestion: "",
  };
}

// =============================================================================
// 写入验证
// =============================================================================

/**
 * 验证文件是否真正被写入
 */
export async function verifyFileWrite(params: WriteVerificationParams): Promise<ToolCallVerificationResult> {
  const { filePath, expectedContent, expectedMinBytes = 0, timeoutMs = 1000 } = params;

  // 等待一小段时间，确保文件系统同步
  await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 100)));

  try {
    // 1. 检查文件是否存在
    const fileStat = await stat(filePath);
    
    if (!fileStat.isFile()) {
      return {
        verified: false,
        reason: `路径存在但不是文件: ${filePath}`,
        suggestion: "检查目标路径是否正确。",
      };
    }

    // 2. 检查文件大小
    if (expectedMinBytes > 0 && fileStat.size < expectedMinBytes) {
      return {
        verified: false,
        reason: `文件大小不符: 期望至少 ${expectedMinBytes} 字节，实际 ${fileStat.size} 字节`,
        suggestion: "文件可能未被正确写入，尝试重新执行写入操作。",
      };
    }

    // 3. 如果提供了期望内容，验证内容
    if (expectedContent) {
      const actualContent = await readFile(filePath, "utf-8");
      
      if (actualContent !== expectedContent) {
        // 计算差异程度
        const expectedHash = createHash("md5").update(expectedContent).digest("hex");
        const actualHash = createHash("md5").update(actualContent).digest("hex");
        
        return {
          verified: false,
          reason: `文件内容不匹配: 期望 hash=${expectedHash.slice(0, 8)}..., 实际 hash=${actualHash.slice(0, 8)}...`,
          suggestion: "文件内容与预期不符，可能是另一个进程覆盖了内容，或写入操作未成功。",
        };
      }
    }

    // 4. 验证文件修改时间是否是最近的
    const now = Date.now();
    const mtime = fileStat.mtimeMs;
    const ageSec = (now - mtime) / 1000;
    
    if (ageSec > 60) {
      return {
        verified: false,
        reason: `文件修改时间过旧: ${ageSec.toFixed(1)} 秒前`,
        suggestion: "文件可能未被更新，写入操作可能未执行。",
      };
    }

    return {
      verified: true,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    
    if (error.code === "ENOENT") {
      return {
        verified: false,
        reason: `文件不存在: ${filePath}`,
        suggestion: "写入操作可能未执行，或路径不正确。",
      };
    }
    
    if (error.code === "EACCES") {
      return {
        verified: false,
        reason: `无权限访问文件: ${filePath}`,
        suggestion: "检查文件权限设置。",
      };
    }
    
    return {
      verified: false,
      reason: `验证时发生错误: ${String(err)}`,
      suggestion: "请检查文件系统状态。",
    };
  }
}

// =============================================================================
// 重试机制
// =============================================================================

export interface RetryOptions {
  maxRetries: number;
  delayMs: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  delayMs: 1000,
  backoffMultiplier: 2,
  shouldRetry: (error) => {
    if (!error) return false;
    const err = error as NodeJS.ErrnoException;
    // 可重试的错误类型
    return ["EBUSY", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"].includes(err.code ?? "");
  },
};

/**
 * 带重试的函数执行器
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;
  let delay = opts.delayMs;
  
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      
      if (attempt === opts.maxRetries) {
        break;
      }
      
      if (!opts.shouldRetry?.(err)) {
        throw err;
      }
      
      log.warn(`操作失败，将在 ${delay}ms 后重试 (${attempt + 1}/${opts.maxRetries}): ${String(err)}`);
      
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= opts.backoffMultiplier ?? 2;
    }
  }
  
  throw lastError;
}

// =============================================================================
// 工具调用监控
// =============================================================================

export interface ToolCallMetrics {
  toolName: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  success: boolean;
  error?: string;
  verified?: boolean;
  verificationReason?: string;
}

const toolCallHistory: ToolCallMetrics[] = [];
const MAX_HISTORY = 100;

/**
 * 记录工具调用指标
 */
export function recordToolCallMetric(metric: ToolCallMetrics): void {
  toolCallHistory.push(metric);
  
  // 限制历史记录大小
  if (toolCallHistory.length > MAX_HISTORY) {
    toolCallHistory.shift();
  }
  
  // 记录日志
  if (!metric.success || metric.verified === false) {
    log.warn("工具调用可能存在问题", {
      toolName: metric.toolName,
      success: metric.success,
      verified: metric.verified,
      error: metric.error,
      verificationReason: metric.verificationReason,
      durationMs: metric.durationMs,
    });
  } else {
    log.debug("工具调用完成", {
      toolName: metric.toolName,
      durationMs: metric.durationMs,
    });
  }
}

/**
 * 获取工具调用统计
 */
export function getToolCallStats(): {
  totalCalls: number;
  successRate: number;
  verificationRate: number;
  avgDurationMs: number;
  byTool: Record<string, { calls: number; successRate: number }>;
} {
  const total = toolCallHistory.length;
  const successful = toolCallHistory.filter((m) => m.success).length;
  const verified = toolCallHistory.filter((m) => m.verified === true).length;
  const durations = toolCallHistory.filter((m) => m.durationMs).map((m) => m.durationMs!);
  
  const byTool: Record<string, { calls: number; successRate: number }> = {};
  for (const metric of toolCallHistory) {
    if (!byTool[metric.toolName]) {
      byTool[metric.toolName] = { calls: 0, successRate: 0 };
    }
    byTool[metric.toolName].calls++;
  }
  
  for (const toolName of Object.keys(byTool)) {
    const toolMetrics = toolCallHistory.filter((m) => m.toolName === toolName);
    const toolSuccess = toolMetrics.filter((m) => m.success).length;
    byTool[toolName].successRate = toolMetrics.length > 0 ? toolSuccess / toolMetrics.length : 0;
  }
  
  return {
    totalCalls: total,
    successRate: total > 0 ? successful / total : 0,
    verificationRate: total > 0 ? verified / total : 0,
    avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    byTool,
  };
}

/**
 * 清除工具调用历史
 */
export function clearToolCallHistory(): void {
  toolCallHistory.length = 0;
}

// =============================================================================
// 导出
// =============================================================================

export const toolExecutionGuard = {
  detectPseudoToolCall,
  verifyFileWrite,
  withRetry,
  recordToolCallMetric,
  getToolCallStats,
  clearToolCallHistory,
};

