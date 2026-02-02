/**
 * 记忆检索器 (Memory Retriever)
 * 
 * 负责检索相关记忆并格式化为上下文
 * 
 * @module agents/memory/retriever
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { MemoryIndexManager } from "../../memory/manager.js";
import type {
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  MemoryServiceConfig,
} from "./types.js";

const log = createSubsystemLogger("memory:retriever");

/**
 * 记忆检索器
 * 
 * 提供记忆检索和上下文格式化功能
 */
export class MemoryRetriever {
  constructor(
    private readonly config: MemoryServiceConfig,
    private readonly cfg: ClawdbotConfig,
  ) {}

  /**
   * 检索相关记忆
   * 
   * @param request - 检索请求
   * @returns 检索结果
   */
  async retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
    const startTime = Date.now();

    try {
      // 1. 获取记忆索引管理器
      const manager = await MemoryIndexManager.get({
        cfg: this.cfg,
        agentId: request.context.agentId || "main",
      });

      if (!manager) {
        log.debug("Memory index manager not available, returning empty result");
        return this.emptyResult(startTime);
      }

      // 2. 执行检索（带超时）
      const params = request.params || {};
      const maxResults = params.maxResults ?? this.config.retrieval.maxResults;
      const minScore = params.minScore ?? this.config.retrieval.minScore;

      log.debug("Retrieving memories", {
        query: request.query.substring(0, 100),
        maxResults,
        minScore,
        sessionId: request.context.sessionId,
      });

      const results = await this.withTimeout(
        manager.search(request.query, {
          maxResults,
          minScore,
          sessionKey: request.context.sessionId,
        }),
        this.config.retrieval.timeoutMs,
      );

      log.debug("Memory retrieval completed", {
        resultsCount: results.length,
        durationMs: Date.now() - startTime,
      });

      // 3. 格式化结果
      const formattedContext = this.formatMemoryContext(results);

      return {
        memories: results.map((r) => ({
          path: r.path,
          snippet: r.snippet,
          score: r.score,
          source: r.source,
          startLine: r.startLine,
          endLine: r.endLine,
        })),
        formattedContext,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      log.warn(`Memory retrieval failed: ${error}`);
      return this.emptyResult(startTime);
    }
  }

  /**
   * 格式化记忆为上下文
   * 
   * @param memories - 记忆搜索结果
   * @returns 格式化的上下文文本
   */
  private formatMemoryContext(
    memories: Array<{
      path: string;
      snippet: string;
      score: number;
      source: "memory" | "sessions";
      startLine: number;
      endLine: number;
    }>,
  ): string {
    if (memories.length === 0) {
      return "";
    }

    const parts = ["## 相关记忆 (Relevant Memories)", ""];

    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      const relevancePercent = (memory.score * 100).toFixed(0);

      parts.push(`### 记忆 ${i + 1} (相关性: ${relevancePercent}%)`);
      parts.push(
        `**来源**: ${memory.path} (行 ${memory.startLine}-${memory.endLine})`,
      );
      parts.push("");
      parts.push(memory.snippet);
      parts.push("");
    }

    return parts.join("\n");
  }

  /**
   * 返回空结果
   * 
   * @param startTime - 开始时间
   * @returns 空的检索结果
   */
  private emptyResult(startTime: number): MemoryRetrievalResult {
    return {
      memories: [],
      formattedContext: "",
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 带超时的 Promise 执行
   * 
   * @param promise - 要执行的 Promise
   * @param timeoutMs - 超时时间（毫秒）
   * @returns Promise 结果
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("Memory retrieval timeout")), timeoutMs),
      ),
    ]);
  }
}
