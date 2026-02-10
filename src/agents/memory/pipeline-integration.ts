/**
 * 记忆系统管线集成 (Memory Pipeline Integration)
 *
 * 封装记忆检索与归档的管线级接口，供 attempt.ts / followup-runner.ts 直接调用。
 * 内置超时保护，不阻塞主流程。
 *
 * @module agents/memory/pipeline-integration
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveMemoryServiceConfig, createMemoryService } from "./factory.js";
import type { IMemoryService, MemoryRetrievalResult } from "./types.js";

const log = createSubsystemLogger("memory:pipeline");

/** 默认记忆检索超时（毫秒） */
const DEFAULT_RETRIEVAL_TIMEOUT_MS = 5_000;

/**
 * 检索记忆上下文，封装超时保护。
 *
 * @param query - 检索关键词（通常为用户消息）
 * @param sessionId - 会话 ID
 * @param config - Clawdbot 配置
 * @param agentId - Agent ID（用于定位配置）
 * @param timeoutMs - 超时毫秒数，默认 5000
 * @returns 格式化的记忆上下文字符串；检索失败或超时返回空字符串
 */
export async function retrieveMemoryContext(
  query: string,
  sessionId: string,
  config: ClawdbotConfig | undefined,
  agentId: string,
  timeoutMs = DEFAULT_RETRIEVAL_TIMEOUT_MS,
): Promise<string> {
  if (!config) return "";

  let service: IMemoryService | null;
  try {
    const memCfg = resolveMemoryServiceConfig(config, agentId);
    service = memCfg ? createMemoryService(config, agentId) : null;
  } catch {
    log.debug("Failed to create memory service for pipeline integration");
    return "";
  }

  if (!service) return "";

  try {
    const result: MemoryRetrievalResult = await Promise.race([
      service.retrieve({
        query,
        context: { userId: "default", sessionId, agentId },
      }),
      new Promise<MemoryRetrievalResult>((_, reject) =>
        setTimeout(() => reject(new Error("memory retrieval timeout")), timeoutMs),
      ),
    ]);
    if (result.formattedContext) {
      log.debug(`Memory context retrieved: ${result.memories.length} items, ${result.durationMs}ms`);
    }
    return result.formattedContext ?? "";
  } catch (err) {
    log.debug(`Memory retrieval skipped: ${err}`);
    return "";
  }
}

/**
 * 构建已完成兄弟子任务的输出摘要，用于注入到下一个子任务的 extraSystemPrompt。
 *
 * @param completedSiblings - 已完成的子任务列表（需要 summary + output）
 * @param maxSnippetLen - 每条摘要最大字符数，默认 200
 * @returns 格式化的上下文文本；无内容则返回空字符串
 */
export function buildSiblingContext(
  completedSiblings: Array<{
    id?: string;
    summary?: string;
    output?: string;
    status: string;
    dependencies?: string[];
    metadata?: { producedFilePaths?: string[] };
  }>,
  maxSnippetLen = 200,
  /** 当前正在执行的子任务 ID（用于智能过滤：只注入直接相关的兄弟上下文） */
  currentTaskId?: string,
): string {
  const completed = completedSiblings.filter(
    (t) => t.status === "completed" && (t.output || (t.metadata?.producedFilePaths && t.metadata.producedFilePaths.length > 0)),
  );
  if (completed.length === 0) return "";

  // 🔧 问题 A 修复：智能过滤 — 续写子任务只注入直接依赖的前序任务，避免 prompt 膨胀
  // 非续写场景保持原有行为（注入所有已完成兄弟的摘要）
  let relevantSiblings = completed;
  const currentTask = currentTaskId
    ? completedSiblings.find(t => t.id === currentTaskId)
    : undefined;
  const isContinuationTask = currentTask?.summary?.includes("续写") ?? false;

  if (isContinuationTask && currentTask?.dependencies && currentTask.dependencies.length > 0) {
    // 续写子任务：只注入直接依赖的任务（前一个续写子任务或原始子任务）
    const depIds = new Set(currentTask.dependencies);
    relevantSiblings = completed.filter(t => t.id && depIds.has(t.id));
    // 如果依赖的任务没有完成（不在 completed 中），回退到最后一个已完成的续写兄弟
    if (relevantSiblings.length === 0) {
      const continuationSiblings = completed.filter(t => t.summary?.includes("续写"));
      if (continuationSiblings.length > 0) {
        relevantSiblings = [continuationSiblings[continuationSiblings.length - 1]];
      }
    }
  }

  // 🔧 限制总注入量：最多注入 5 个兄弟任务的上下文，避免 prompt 过长
  const MAX_SIBLINGS = isContinuationTask ? 2 : 5;
  if (relevantSiblings.length > MAX_SIBLINGS) {
    // 保留最后 N 个（最近完成的最相关）
    relevantSiblings = relevantSiblings.slice(-MAX_SIBLINGS);
  }

  const lines = relevantSiblings.map((t) => {
    // 🆕 A3: 续写子任务需要更多上下文（检测"续写"关键词）
    const isContinuation = t.summary?.includes("续写") ?? false;
    // 🔧 修复：续写场景大幅增加上下文到 2000 字符
    const effectiveMaxLen = isContinuation ? 2000 : maxSnippetLen;

    // 🔧 关键修复：优先使用文件内容而非 subTask.output
    // subTask.output 通常只是 LLM 的确认消息（如"已创作完成"），不是实际产出。
    // 对于续写场景，必须看到前一个任务的实际文件内容才能保持连贯。
    let effectiveOutput = t.output ?? "";
    const producedPaths = t.metadata?.producedFilePaths;
    if (producedPaths && producedPaths.length > 0) {
      try {
        // 同步读取文件内容（buildSiblingContext 是同步函数，使用 readFileSync）
        const fs = require("node:fs");
        const fileContents: string[] = [];
        for (const filePath of producedPaths) {
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            if (content.length > 0) {
              fileContents.push(content);
            }
          } catch {
            // 文件不存在或无法读取，跳过
          }
        }
        if (fileContents.length > 0) {
          effectiveOutput = fileContents.join("\n\n");
        }
      } catch {
        // require 失败，回退到 output
      }
    }

    const snippet = effectiveOutput.length > effectiveMaxLen
      ? `${effectiveOutput.substring(effectiveOutput.length - effectiveMaxLen)}` // 续写场景取结尾而非开头
      : effectiveOutput;
    return `- [${t.summary ?? "子任务"}]: ${snippet}`;
  });

  return `\n\n## 已完成的关联任务\n${lines.join("\n")}`;
}
