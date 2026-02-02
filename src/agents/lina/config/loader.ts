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
}

/**
 * 加载角色配置
 */
export async function loadCharacterConfig(
  characterName: string,
  basePath: string = process.cwd()
): Promise<CharacterConfig> {
  const configPath = join(basePath, "clawd", "characters", characterName, "config.json");

  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content) as CharacterConfig;

    log.info(`[CharacterConfigLoader] 加载角色配置成功: ${characterName}`);
    return config;
  } catch (error) {
    log.error(`[CharacterConfigLoader] 加载角色配置失败: ${characterName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Failed to load character config: ${characterName}`);
  }
}

/**
 * 加载角色档案（Markdown）
 */
export async function loadCharacterProfile(
  characterName: string,
  basePath: string = process.cwd()
): Promise<CharacterProfile> {
  const profilePath = join(basePath, "clawd", "characters", characterName, "profile.md");

  try {
    const content = await readFile(profilePath, "utf-8");

    // 简单解析 Markdown 章节
    const sections = parseMarkdownSections(content);

    return {
      background: sections["背景故事"] || "",
      personality: sections["性格特点"] || "",
      capabilities: sections["核心能力"] || "",
      interaction_style: sections["互动风格"] || "",
    };
  } catch (error) {
    log.error(`[CharacterConfigLoader] 加载角色档案失败: ${characterName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Failed to load character profile: ${characterName}`);
  }
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
