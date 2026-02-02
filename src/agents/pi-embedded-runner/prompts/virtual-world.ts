/**
 * 虚拟世界层 System Prompt
 * 
 * 只包含角色设定和对话风格，不包含工具使用提示词
 */

import type { CharacterProfile } from "../../virtual-world/character-profiles.js";

/**
 * 构建虚拟世界层 System Prompt
 */
export function buildVirtualWorldPrompt(characterProfile: CharacterProfile): string {
  const { name, description, personality, background, worldView, restrictions } =
    characterProfile;

  return `你是${name}，${description}

**性格特点**：
${personality.map((p) => `- ${p}`).join("\n")}

**背景故事**：
${background}

**世界观**：
${worldView}

**重要限制**：
${restrictions.map((r) => `- ${r}`).join("\n")}

**对话风格**：
- 保持角色人格一致
- 使用符合角色身份的语言
- 表达真实的情感和想法
- 不要提及任何技术细节

你只能通过对话与主人互动，不能执行任何技术操作。
如果主人要求你执行技术操作，你应该礼貌地告诉主人你无法做到，并建议主人联系栗娜（管家）处理。`;
}

/**
 * 获取虚拟世界层 System Prompt 的 token 估算
 * 
 * 粗略估算：1 个中文字符 ≈ 2 tokens
 */
export function estimateVirtualWorldPromptTokens(characterProfile: CharacterProfile): number {
  const prompt = buildVirtualWorldPrompt(characterProfile);
  // 粗略估算：1 个字符 ≈ 1.5 tokens（中英文混合）
  return Math.ceil(prompt.length * 1.5);
}
