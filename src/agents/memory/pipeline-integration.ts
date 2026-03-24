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

  // 🔧 问题 U 修复：章节隔离 — 非续写的独立章节任务不注入其他章节的内容
  // 根因：LLM 看到其他章节的摘要后，会把它们混入当前章节，导致内容混乱。
  // 这是第一章被 restart 7 次的根本原因——每次都把第三章/第四章内容混入。
  // 策略：
  //   - 续写子任务：只注入直接依赖的前序任务（保持连贯性）
  //   - 独立章节任务（无依赖）：不注入任何兄弟上下文（章节隔离）
  //   - 有依赖的非续写任务：只注入依赖任务的摘要
  let relevantSiblings = completed;
  const currentTask = currentTaskId
    ? completedSiblings.find(t => t.id === currentTaskId)
    : undefined;
  // 🆕 V5: chunk 子任务不注入兄弟上下文（prompt 已指定精确的文件读取指令）
  const isChunkTask = (currentTask as any)?.metadata?.isChunkTask ?? false;
  if (isChunkTask) return "";

  // 🆕 V4: 分段子任务与续写子任务共享相同的上下文策略
  const isSegmentTask = (currentTask as any)?.metadata?.isSegment ?? false;
  const isContinuationTask = isSegmentTask
    || (currentTask as any)?.metadata?.isContinuation
    || currentTask?.summary?.includes("续写")
    || false;

  if (isContinuationTask && currentTask?.dependencies && currentTask.dependencies.length > 0) {
    // 续写/分段子任务：只注入直接依赖的任务（前一个分段/续写子任务）
    const depIds = new Set(currentTask.dependencies);
    relevantSiblings = completed.filter(t => t.id && depIds.has(t.id));
    if (relevantSiblings.length === 0) {
      const continuationSiblings = completed.filter(t => t.summary?.includes("续写") || (t as any)?.metadata?.isSegment);
      if (continuationSiblings.length > 0) {
        relevantSiblings = [continuationSiblings[continuationSiblings.length - 1]];
      }
    }
  } else if (currentTask?.dependencies && currentTask.dependencies.length > 0) {
    // 有依赖的非续写任务：只注入依赖任务的摘要
    const depIds = new Set(currentTask.dependencies);
    relevantSiblings = completed.filter(t => t.id && depIds.has(t.id));
  } else {
    // 🔧 问题 U 核心修复：独立章节任务（无依赖）→ 不注入任何兄弟上下文
    // 原因：独立章节之间不需要上下文共享，注入反而会导致 LLM 混淆内容。
    // 例如：第一章"废体觉醒"不需要看到第二章"宗门试炼"的内容。
    relevantSiblings = [];
  }

  // 🔧 限制总注入量：最多注入 5 个兄弟任务的上下文，避免 prompt 过长
  // 🔧 P112: 分段子任务注入更多前文（最多 3 个）以保持文学连贯性
  const MAX_SIBLINGS = isContinuationTask ? 3 : 5;
  if (relevantSiblings.length > MAX_SIBLINGS) {
    // 保留最后 N 个（最近完成的最相关）
    relevantSiblings = relevantSiblings.slice(-MAX_SIBLINGS);
  }

  // 🔧 P112: 文学创作的累积上下文机制
  // 对于分段子任务，构建累积的前文内容，而非仅取最后一段
  let accumulatedContext = "";
  if (isSegmentTask && relevantSiblings.length > 1) {
    // 尝试读取所有前序分段的文件内容并累积
    const fs = require("node:fs");
    const accumulatedParts: string[] = [];
    let totalChars = 0;
    const MAX_ACCUMULATED = 4000; // 累积上下文上限
    
    // 从最早的分段开始累积（保持时间顺序）
    for (const sibling of relevantSiblings) {
      const producedPaths = sibling.metadata?.producedFilePaths;
      if (producedPaths && producedPaths.length > 0) {
        for (const filePath of producedPaths) {
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            if (content.length > 0) {
              const segmentIndex = (sibling as any)?.metadata?.segmentIndex;
              const header = `\n--- 【分段 ${segmentIndex}】---\n`;
              const partContent = header + content;
              if (totalChars + partContent.length <= MAX_ACCUMULATED) {
                accumulatedParts.push(partContent);
                totalChars += partContent.length;
              } else {
                // 超出预算，只保留最后部分
                const remaining = MAX_ACCUMULATED - totalChars;
                if (remaining > 500) {
                  accumulatedParts.push(partContent.slice(-remaining));
                  totalChars = MAX_ACCUMULATED;
                }
                break;
              }
            }
          } catch {
            // 文件读取失败，跳过
          }
        }
      }
      if (totalChars >= MAX_ACCUMULATED) break;
    }
    
    if (accumulatedParts.length > 0) {
      accumulatedContext = `\n\n## 📚 累积前文（共 ${accumulatedParts.length} 个分段，${totalChars} 字）\n` +
        `以下是本章节之前所有分段的内容，请仔细阅读以确保连贯性：\n` +
        accumulatedParts.join("\n") +
        `\n\n---\n**请从上文结尾处自然续写，保持风格、人物状态和情节的连贯性。**\n`;
    }
  }

  const lines = relevantSiblings.map((t) => {
    // 🆕 A3: 续写子任务需要更多上下文
    // 🔧 问题 Q 修复：优先用 metadata.isContinuation 检测，回退到字符串匹配
    const isContinuation = (t as any)?.metadata?.isContinuation || (t as any)?.metadata?.isSegment || t.summary?.includes("续写") || false;
    // 🔧 修复：续写场景大幅增加上下文到 2000 字符
    // 🔧 P112: 如果已有累积上下文，单个分段只需要简短摘要
    const effectiveMaxLen = accumulatedContext.length > 0 ? 300 : (isContinuation ? 2000 : maxSnippetLen);

    // 🆕 V9: 优先使用智能摘要（smartSummary）— 信息密度高且 token 消耗低
    // 智能摘要由 llm_light 在子任务完成后生成，包含：
    // “做了什么 + 关键产出 + 对后续任务的价值”
    // 非续写场景优先使用 smartSummary，续写场景仍需要实际文件内容衡接
    const smartSummary = (t as any)?.metadata?.smartSummary as string | undefined;
    if (!isContinuation && smartSummary && smartSummary.length > 20) {
      return `- [📝 ${t.summary ?? "子任务"}]: ${smartSummary}`;
    }

    // 🔧 关键修复：优先使用文件内容而非 subTask.output
    // subTask.output 通常只是 LLM 的确认消息（如“已创作完成”），不是实际产出。
    // 对于续写场景，必须看到前一个任务的实际文件内容才能保持连贯。
    let effectiveOutput = t.output ?? "";
    const producedPaths = t.metadata?.producedFilePaths;
    if (producedPaths && producedPaths.length > 0) {
      try {
        // 同步读取文件内容（buildSiblingContext 是同步函数，使用 readFileSync）
        // 🔧 问题 HH 修复：捕获单个文件的读取错误，避免一个文件失败导致整个上下文丢失
        const fs = require("node:fs");
        const fileContents: string[] = [];
        for (const filePath of producedPaths) {
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            if (content.length > 0) {
              fileContents.push(content);
            }
          } catch {
            // 文件不存在、正在被写入、或无法读取，跳过
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

  // 🔧 P112: 组装最终上下文
  // 如果有累积上下文，优先使用；否则使用传统的兄弟摘要
  if (accumulatedContext) {
    // 累积上下文模式：提供完整前文 + 关键信息提示
    return accumulatedContext + (lines.length > 0 ? 
      `\n\n## 关键衔接点\n${lines.slice(-1).join("\n")}` : "");
  }

  return `\n\n## 已完成的关联任务\n${lines.join("\n")}`;
}
