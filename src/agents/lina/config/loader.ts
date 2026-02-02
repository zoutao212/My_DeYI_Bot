/**
 * 角色配置加载器
 * 从 clawd/characters/{characterName}/ 加载角色配置
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("lina:config");

export interface CharacterConfig {
  name: string;
  version: string;
  personality: {
    traits: string[];
    values: string[];
    communication_style: string[];
  };
  capabilities: {
    task_management: boolean;
    memory_service: boolean;
    daily_planning: boolean;
    reminders: boolean;
  };
  system_prompt: {
    role: string;
    core_principles: string[];
    interaction_guidelines: string[];
  };
}

export interface CharacterProfile {
  background: string;
  personality: string;
  capabilities: string;
  interaction_style: string;
  /** System prompt from prompts/system.md (required) */
  systemPrompt: string;
  /** Core memories from memory/core-memories.md (optional) */
  coreMemories?: string;
}

/**
 * 加载角色配置
 * 
 * @param characterName - 角色名称（如 "lina"）
 * @param basePath - 基础路径（可以是 clawd 目录或其父目录）
 */
export async function loadCharacterConfig(
  characterName: string,
  basePath: string = process.cwd()
): Promise<CharacterConfig> {
  // 🔧 FIX: 智能检测路径（支持传入 clawd 目录或其父目录）
  const normalizedBasePath = basePath.endsWith("clawd") || basePath.endsWith("clawd\\") || basePath.endsWith("clawd/")
    ? basePath
    : join(basePath, "clawd");
  
  const configPath = join(normalizedBasePath, "characters", characterName, "config.json");

  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content) as CharacterConfig;

    log.info(`[CharacterConfigLoader] 加载角色配置成功: ${characterName}`);
    return config;
  } catch (error) {
    log.error(`[CharacterConfigLoader] 加载角色配置失败: ${characterName}`, {
      error: error instanceof Error ? error.message : String(error),
      configPath,
    });
    throw new Error(`Failed to load character config: ${characterName}`);
  }
}

/**
 * 加载角色档案（完整版）
 * 
 * 加载顺序：
 * 1. prompts/system.md（必需）- 完整的 System Prompt
 * 2. memory/core-memories.md（可选）- 核心记忆
 * 3. profile.md（可选）- 用户可见的角色介绍
 * 
 * @param characterName - 角色名称（如 "lina"）
 * @param basePath - 基础路径（可以是 clawd 目录或其父目录）
 */
export async function loadCharacterProfile(
  characterName: string,
  basePath: string = process.cwd()
): Promise<CharacterProfile> {
  // 🔧 FIX: 智能检测路径（支持传入 clawd 目录或其父目录）
  const normalizedBasePath = basePath.endsWith("clawd") || basePath.endsWith("clawd\\") || basePath.endsWith("clawd/")
    ? basePath
    : join(basePath, "clawd");
  
  const characterDir = join(normalizedBasePath, "characters", characterName);
  const systemPromptPath = join(characterDir, "prompts", "system.md");
  const coreMemoriesPath = join(characterDir, "memory", "core-memories.md");
  const profilePath = join(characterDir, "profile.md");

  // 1. 加载 System Prompt（必需）
  let systemPrompt: string;
  try {
    systemPrompt = await readFile(systemPromptPath, "utf-8");
    log.info(`[CharacterConfigLoader] 加载角色 System Prompt 成功: ${characterName} (${systemPrompt.length} 字符)`);
  } catch (error) {
    log.error(`[CharacterConfigLoader] 加载角色 System Prompt 失败: ${characterName}`, {
      error: error instanceof Error ? error.message : String(error),
      systemPromptPath,
    });
    throw new Error(`Failed to load character system prompt: ${characterName}`);
  }

  // 2. 加载核心记忆（可选）
  let coreMemories: string | undefined;
  try {
    coreMemories = await readFile(coreMemoriesPath, "utf-8");
    log.info(`[CharacterConfigLoader] 加载核心记忆成功: ${characterName} (${coreMemories.length} 字符)`);
  } catch {
    log.debug(`[CharacterConfigLoader] 未找到核心记忆文件: ${coreMemoriesPath}`);
  }

  // 3. 加载 profile.md（可选，用于 UI 展示）
  let profileSections: Record<string, string> = {};
  try {
    const profileContent = await readFile(profilePath, "utf-8");
    profileSections = parseMarkdownSections(profileContent);
    log.debug(`[CharacterConfigLoader] 加载角色档案成功: ${characterName}`);
  } catch {
    log.debug(`[CharacterConfigLoader] 未找到角色档案文件: ${profilePath}`);
  }

  return {
    background: profileSections["背景故事"] || "",
    personality: profileSections["性格特点"] || "",
    capabilities: profileSections["核心能力"] || "",
    interaction_style: profileSections["互动风格"] || "",
    systemPrompt,      // 完整的 System Prompt（必需）
    coreMemories,      // 核心记忆（可选）
  };
}

/**
 * 解析 Markdown 章节
 */
function parseMarkdownSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split("\n");

  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    // 检测二级标题
    if (line.startsWith("## ")) {
      // 保存上一个章节
      if (currentSection) {
        sections[currentSection] = currentContent.join("\n").trim();
      }

      // 开始新章节
      currentSection = line.replace("## ", "").trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // 保存最后一个章节
  if (currentSection) {
    sections[currentSection] = currentContent.join("\n").trim();
  }

  return sections;
}

/**
 * 验证角色配置
 */
export function validateCharacterConfig(config: CharacterConfig): boolean {
  if (!config.name || !config.version) {
    return false;
  }

  if (!config.personality || !config.capabilities || !config.system_prompt) {
    return false;
  }

  return true;
}
