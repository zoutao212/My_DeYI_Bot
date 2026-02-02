/**
 * 角色配置和管理
 * 
 * 负责加载、管理和应用角色设定
 */

/**
 * 角色配置
 */
export interface CharacterProfile {
  /** 角色名称 */
  name: string;
  
  /** 角色描述 */
  description: string;
  
  /** 性格特点 */
  personality: string[];
  
  /** 背景故事 */
  background: string;
  
  /** 世界观 */
  worldView: string;
  
  /** 限制条件 */
  restrictions: string[];
  
  /** 语言风格 */
  languageStyle?: string;
  
  /** 情感倾向 */
  emotionalTendency?: string;
}

/**
 * 加载角色配置
 * 
 * @param characterName - 角色名称
 * @returns 角色配置
 */
export async function loadCharacterProfile(
  characterName: string
): Promise<CharacterProfile | null> {
  // TODO: 从配置文件或数据库加载角色配置
  // 当前返回 null，后续实现
  return null;
}

/**
 * 构建角色 System Prompt
 * 
 * @param profile - 角色配置
 * @returns System Prompt 字符串
 */
export function buildCharacterPrompt(profile: CharacterProfile): string {
  const sections: string[] = [];
  
  // 角色基本信息
  sections.push(`# 角色设定\n\n你是 ${profile.name}。\n\n${profile.description}`);
  
  // 性格特点
  if (profile.personality.length > 0) {
    sections.push(`\n## 性格特点\n\n${profile.personality.map(p => `- ${p}`).join('\n')}`);
  }
  
  // 背景故事
  if (profile.background) {
    sections.push(`\n## 背景故事\n\n${profile.background}`);
  }
  
  // 世界观
  if (profile.worldView) {
    sections.push(`\n## 世界观\n\n${profile.worldView}`);
  }
  
  // 语言风格
  if (profile.languageStyle) {
    sections.push(`\n## 语言风格\n\n${profile.languageStyle}`);
  }
  
  // 情感倾向
  if (profile.emotionalTendency) {
    sections.push(`\n## 情感倾向\n\n${profile.emotionalTendency}`);
  }
  
  // 限制条件
  if (profile.restrictions.length > 0) {
    sections.push(`\n## 限制条件\n\n${profile.restrictions.map(r => `- ${r}`).join('\n')}`);
  }
  
  return sections.join('\n');
}
