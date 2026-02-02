/**
 * 记忆服务 (Memory Service)
 * 
 * 提供统一的记忆检索和归档接口
 * 
 * @module agents/memory/service
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { MemoryArchiver } from "./archiver.js";
import { MemoryRetriever } from "./retriever.js";
import type {
  IMemoryService,
  MemoryArchivalRequest,
  MemoryArchivalResult,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  MemoryServiceConfig,
  MemoryServiceStatus,
} from "./types.js";

const log = createSubsystemLogger("memory:service");

/**
 * 记忆服务
 * 
 * 组合记忆检索器和归档器，提供统一的记忆服务接口
 */
export class MemoryService implements IMemoryService {
  private readonly retriever: MemoryRetriever;
  private readonly archiver: MemoryArchiver;

  constructor(
    private readonly config: MemoryServiceConfig,
    private readonly cfg: ClawdbotConfig,
  ) {
    this.retriever = new MemoryRetriever(config, cfg);
    this.archiver = new MemoryArchiver(config);

    log.info("Memory service initialized", {
      retrieval: {
        maxResults: config.retrieval.maxResults,
        minScore: config.retrieval.minScore,
        timeoutMs: config.retrieval.timeoutMs,
      },
      archival: {
        strategy: config.archival.strategy,
        format: config.archival.format,
        frequency: config.archival.frequency,
      },
    });
  }

  /**
   * 检索相关记忆
   * 
   * @param request - 检索请求
   * @returns 检索结果
   */
  async retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
    log.debug("Retrieving memories", {
      query: request.query.substring(0, 100),
      sessionId: request.context.sessionId,
      layer: request.context.layer,
    });

    const result = await this.retriever.retrieve(request);

    log.debug("Memory retrieval completed", {
      memoriesCount: result.memories.length,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * 归档会话总结
   * 
   * @param request - 归档请求
   * @returns 归档结果
   */
  async archive(request: MemoryArchivalRequest): Promise<MemoryArchivalResult> {
    log.debug("Archiving session summary", {
      sessionId: request.context.sessionId,
      totalTurns: request.summary.totalTurns,
    });

    const result = await this.archiver.archive(request);

    if (result.success) {
      log.info("Memory archival completed", {
        path: result.path,
        durationMs: result.durationMs,
      });
    } else {
      log.warn("Memory archival failed", {
        error: result.error,
        durationMs: result.durationMs,
      });
    }

    return result;
  }

  /**
   * 获取记忆服务状态
   * 
   * @returns 服务状态
   */
  status(): MemoryServiceStatus {
    return {
      enabled: true,
      retrieval: {
        enabled: true,
        available: true,
      },
      archival: {
        enabled: true,
        available: true,
      },
    };
  }
}

/**
 * 从配置创建记忆服务
 * 
 * @param config - 记忆服务配置
 * @param cfg - Clawdbot 配置
 * @returns 记忆服务实例，如果配置无效则返回 null
 */
export function createMemoryService(
  config: MemoryServiceConfig | null,
  cfg: ClawdbotConfig,
): MemoryService | null {
  if (!config) {
    log.debug("Memory service disabled (no config)");
    return null;
  }

  return new MemoryService(config, cfg);
}

/**
 * 从 Clawdbot 配置解析记忆服务配置
 * 
 * @param cfg - Clawdbot 配置
 * @param agentId - Agent ID
 * @returns 记忆服务配置，如果未启用则返回 null
 */
export function resolveMemoryServiceConfig(
  cfg: ClawdbotConfig,
  agentId: string,
): MemoryServiceConfig | null {
  // 查找指定的 agent 配置
  const agentCfg = cfg.agents?.list?.find((a) => a.id === agentId);
  const memoryCfg = agentCfg?.memory;

  if (!memoryCfg) {
    log.debug("Memory service disabled for agent", { agentId });
    return null;
  }

  const config: MemoryServiceConfig = {
    retrieval: {
      maxResults: memoryCfg.retrieval?.maxResults ?? 5,
      minScore: memoryCfg.retrieval?.minScore ?? 0.7,
      sources: memoryCfg.retrieval?.sources ?? ["memory", "sessions"],
      timeoutMs: memoryCfg.retrieval?.timeoutMs ?? 5000,
    },
    archival: {
      strategy: memoryCfg.archival?.strategy ?? "threshold",
      path: memoryCfg.archival?.path ?? "memory/sessions",
      format: memoryCfg.archival?.format ?? "markdown",
      frequency: memoryCfg.archival?.frequency ?? 5,
    },
  };

  log.debug("Memory service config resolved", { agentId, config });

  return config;
}
