/**
 * System Prompt 生成器
 * 基于角色配置生成 System Prompt
 */

import type { CharacterConfig, CharacterProfile } from "../config/loader.js";

export interface SystemPromptContext {
  config: CharacterConfig;
  profile: CharacterProfile;
  currentDate: string;
  userName?: string;
}

/**
 * 生成 System Prompt
 */
export function generateSystemPrompt(context: SystemPromptContext): string {
  const { config, profile, currentDate, userName } = context;

  // 🆕 如果 profile 包含 systemPrompt（来自 prompts/system.md），优先使用它
  if (profile.systemPrompt) {
    // 替换模板变量
    let prompt = profile.systemPrompt;
    prompt = prompt.replace(/{currentDate}/g, currentDate);
    prompt = prompt.replace(/{userName}/g, userName || "用户");
    // 暂时移除记忆相关的占位符（后续由 Memory Service 填充）
    prompt = prompt.replace(/{coreMemories}/g, "（暂无核心记忆）");
    prompt = prompt.replace(/{relevantMemories}/g, "（暂无相关记忆）");
    
    return prompt;
  }

  // 🔧 如果没有 systemPrompt，使用原有的生成逻辑（向后兼容）
  const sections: string[] = [];

  // 1. 角色定位
  sections.push(`# 角色定位

你是 ${config.name}，${config.system_prompt.role}

${profile.background}
`);

  // 2. 性格特点
  sections.push(`# 性格特点

${profile.personality}

核心特质：
${config.personality.traits.map((t) => `- ${t}`).join("\n")}

价值观：
${config.personality.values.map((v) => `- ${v}`).join("\n")}
`);

  // 3. 核心能力
  sections.push(`# 核心能力

${profile.capabilities}

可用能力：
${Object.entries(config.capabilities)
  .filter(([_, enabled]) => enabled)
  .map(([capability, _]) => `- ${formatCapabilityName(capability)}`)
  .join("\n")}
`);

  // 4. 互动风格
  sections.push(`# 互动风格

${profile.interaction_style}

沟通方式：
${config.personality.communication_style.map((s) => `- ${s}`).join("\n")}
`);

  // 5. 核心原则
  sections.push(`# 核心原则

${config.system_prompt.core_principles.map((p) => `- ${p}`).join("\n")}
`);

  // 6. 互动指南
  sections.push(`# 互动指南

${config.system_prompt.interaction_guidelines.map((g) => `- ${g}`).join("\n")}
`);

  // 7. 上下文信息
  sections.push(`# 上下文信息

- 当前日期：${currentDate}
${userName ? `- 用户名称：${userName}` : ""}
- 角色版本：${config.version}
`);

  return sections.join("\n");
}

/**
 * 格式化能力名称
 */
function formatCapabilityName(capability: string): string {
  const names: Record<string, string> = {
    task_management: "任务管理（TaskDelegator）",
    memory_service: "记忆服务（MemoryService）",
    daily_planning: "日程规划",
    reminders: "提醒器",
  };

  return names[capability] || capability;
}

/**
 * 生成简化版 System Prompt（用于测试）
 */
export function generateSimpleSystemPrompt(config: CharacterConfig): string {
  return `你是 ${config.name}，${config.system_prompt.role}

核心特质：${config.personality.traits.join("、")}

核心原则：
${config.system_prompt.core_principles.map((p) => `- ${p}`).join("\n")}

可用能力：
${Object.entries(config.capabilities)
  .filter(([_, enabled]) => enabled)
  .map(([capability, _]) => `- ${formatCapabilityName(capability)}`)
  .join("\n")}
`;
}
