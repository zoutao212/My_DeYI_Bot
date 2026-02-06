/**
 * 人格注入器 (Persona Injector)
 *
 * 支持两种角色加载方式（优先级从高到低）：
 *   1. **目录制角色**：通过 CharacterService 从 `clawd/characters/{name}/` 加载
 *      完整角色包（config.json + prompts/system.md + knowledge/*.md + memory/）。
 *   2. **JSON 配置 fallback**：从 clawdbot.json 的 `agents.list[].persona` 字段读取简易配置。
 *
 * @module agents/persona-injector
 */

import type { ClawdbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getCharacterService,
  type LoadedCharacter,
} from "./pipeline/characters/character-service.js";

const log = createSubsystemLogger("persona:injector");

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 简易人格配置（JSON fallback）
 */
export interface PersonaConfig {
  /** 角色名称（如 "栗娜"） */
  name: string;
  /** 性格描述 */
  personality: string;
  /** 说话风格 */
  speakingStyle: string;
  /** 能力列表 */
  capabilities: string[];
  /** 行为规则 */
  rules: string[];
}

/**
 * 解析后的人格结果（统一输出）
 */
export interface ResolvedPersona {
  /** 角色名称 */
  name: string;
  /** 角色显示名 */
  displayName: string;
  /** 完整的 System Prompt 片段（可直接拼接） */
  prompt: string;
  /** 来源：'directory' = 目录制, 'config' = JSON fallback */
  source: "directory" | "config";
  /** 目录制角色的完整数据（仅 source=directory 时有值） */
  character?: LoadedCharacter;
}

// ============================================================================
// 核心 API：统一的异步解析入口
// ============================================================================

/**
 * 解析并构建人格 Prompt（统一入口，异步）
 *
 * 优先尝试从 `clawd/characters/{characterName}/` 加载目录制角色；
 * 如果目录不存在或加载失败，回退到 clawdbot.json 的 persona 字段。
 *
 * @param cfg - Clawdbot 配置
 * @param agentId - Agent ID（用于 JSON fallback 匹配）
 * @param characterName - 角色名称（用于目录制加载，如 "lina"）
 * @returns 解析后的人格结果，或 null
 */
export async function resolvePersonaPrompt(
  cfg: ClawdbotConfig | undefined,
  agentId: string,
  characterName?: string,
): Promise<ResolvedPersona | null> {
  // ── 1. 尝试目录制角色 ──
  const charName = characterName
    ?? cfg?.agents?.dynamicPipeline?.defaultCharacter
    ?? cfg?.agents?.dynamicPipeline?.systemPersona;

  if (charName) {
    try {
      const svc = getCharacterService();
      const loaded = await svc.loadCharacter(charName);
      if (loaded && loaded.formattedSystemPrompt) {
        log.info(`[persona] 目录制角色加载成功: ${charName} (${loaded.config.displayName})`);
        return {
          name: loaded.config.name,
          displayName: loaded.config.displayName,
          prompt: loaded.formattedSystemPrompt,
          source: "directory",
          character: loaded,
        };
      }
    } catch (err) {
      log.warn(`[persona] 目录制角色加载失败 (${charName}), 回退到 JSON 配置: ${err}`);
    }
  }

  // ── 2. Fallback: JSON 配置 ──
  const simpleCfg = resolvePersonaConfig(cfg, agentId);
  if (simpleCfg) {
    const prompt = buildPersonaPrompt(simpleCfg);
    return {
      name: simpleCfg.name,
      displayName: simpleCfg.name,
      prompt,
      source: "config",
    };
  }

  return null;
}

// ============================================================================
// JSON fallback 辅助函数（保留向后兼容）
// ============================================================================

/**
 * 根据简易人格配置生成 System Prompt 片段
 *
 * @param config - 人格配置
 * @returns 格式化的 System Prompt 文本
 */
export function buildPersonaPrompt(config: PersonaConfig): string {
  const parts: string[] = [
    `## 你的身份`,
    `你是${config.name}。`,
    "",
  ];

  if (config.personality) {
    parts.push(`### 性格`, config.personality, "");
  }

  if (config.speakingStyle) {
    parts.push(`### 说话风格`, config.speakingStyle, "");
  }

  if (config.capabilities.length > 0) {
    parts.push(
      `### 你的能力`,
      ...config.capabilities.map((c) => `- ${c}`),
      "",
    );
  }

  if (config.rules.length > 0) {
    parts.push(
      `### 行为规则`,
      ...config.rules.map((r) => `- ${r}`),
      "",
    );
  }

  return parts.join("\n");
}

/**
 * 从 ClawdbotConfig 解析指定 Agent 的简易人格配置
 *
 * @param cfg - Clawdbot 配置
 * @param agentId - Agent ID
 * @returns 人格配置，如果未配置则返回 null
 */
export function resolvePersonaConfig(
  cfg: ClawdbotConfig | undefined,
  agentId: string,
): PersonaConfig | null {
  if (!cfg) return null;

  const agent = cfg.agents?.list?.find((a) => a.id === agentId);
  if (!agent) return null;

  // 从 agent 配置读取 persona 字段（类型已在 types.agents.ts 中定义）
  const persona = agent.persona;
  if (!persona?.name) return null;

  log.debug(`Persona config resolved for agent: ${agentId} -> ${persona.name}`);

  return {
    name: persona.name,
    personality: persona.personality ?? "",
    speakingStyle: persona.speakingStyle ?? "",
    capabilities: Array.isArray(persona.capabilities) ? persona.capabilities : [],
    rules: Array.isArray(persona.rules) ? persona.rules : [],
  };
}
