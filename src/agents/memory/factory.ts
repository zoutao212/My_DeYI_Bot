/**
 * 记忆服务工厂 (Memory Service Factory)
 * 
 * 提供记忆服务的创建和配置解析功能
 * 
 * @module agents/memory/factory
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { MemoryService } from "./service.js";
import type { MemoryServiceConfig } from "./types.js";

const log = createSubsystemLogger("memory:factory");

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
  
  if (!agentCfg) {
    log.debug("Agent not found in config", { agentId });
    return null;
  }

  // 检查是否启用了记忆功能
  // 注意：当前 AgentConfig 类型中还没有 memory 字段
  // 这里使用 any 类型断言，等待配置类型更新
  const memoryCfg = (agentCfg as any).memory;

  if (!memoryCfg?.enabled) {
    log.debug("Memory service disabled for agent", { agentId });
    return null;
  }

  // 构建记忆服务配置，使用默认值
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

/**
 * 从配置创建记忆服务
 * 
 * @param cfg - Clawdbot 配置
 * @param agentId - Agent ID
 * @returns 记忆服务实例，如果配置无效则返回 null
 */
export function createMemoryService(
  cfg: ClawdbotConfig,
  agentId: string,
): MemoryService | null {
  // 解析配置
  const config = resolveMemoryServiceConfig(cfg, agentId);

  if (!config) {
    log.debug("Memory service disabled (no config)", { agentId });
    return null;
  }

  // 创建服务实例
  try {
    const service = new MemoryService(config, cfg);
    log.info("Memory service created", { agentId });
    return service;
  } catch (error) {
    log.error("Failed to create memory service", { agentId, error });
    return null;
  }
}
