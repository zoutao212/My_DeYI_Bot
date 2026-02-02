/**
 * 记忆过滤器
 * 
 * 用于虚拟世界层（角色扮演）的记忆过滤和格式化
 * 
 * 核心功能：
 * - 过滤技术细节，只保留角色相关的记忆
 * - 按角色视角格式化记忆
 * - 确保记忆符合角色的世界观
 */

import type { MemoryItem } from "./types.js";

// 使用 MemoryItem 作为 MemorySearchResult 的别名
type MemorySearchResult = MemoryItem;

/**
 * 技术关键词列表（需要过滤的内容）
 */
const TECHNICAL_KEYWORDS = [
  // 编程相关
  "代码",
  "函数",
  "变量",
  "类",
  "接口",
  "API",
  "TypeScript",
  "JavaScript",
  "Python",
  "import",
  "export",
  "const",
  "let",
  "var",
  "async",
  "await",
  "Promise",
  
  // 系统操作
  "文件系统",
  "目录",
  "路径",
  "命令行",
  "终端",
  "Shell",
  "PowerShell",
  "bash",
  "执行命令",
  "运行脚本",
  
  // 开发工具
  "Git",
  "commit",
  "push",
  "pull",
  "branch",
  "merge",
  "npm",
  "pnpm",
  "构建",
  "编译",
  "测试",
  "调试",
  
  // 技术术语
  "数据库",
  "SQL",
  "查询",
  "索引",
  "缓存",
  "配置",
  "日志",
  "错误",
  "异常",
  "堆栈",
  "内存",
  "CPU",
  
  // 文件操作
  "读取文件",
  "写入文件",
  "创建文件",
  "删除文件",
  "修改文件",
  "保存文件",
];

/**
 * 角色相关关键词列表（需要保留的内容）
 */
const ROLE_KEYWORDS = [
  // 情感相关
  "喜欢",
  "讨厌",
  "开心",
  "难过",
  "生气",
  "担心",
  "关心",
  "想念",
  "感动",
  "感谢",
  
  // 日常生活
  "早上",
  "晚上",
  "吃饭",
  "睡觉",
  "休息",
  "玩",
  "聊天",
  "陪伴",
  
  // 人际关系
  "主人",
  "朋友",
  "家人",
  "认识",
  "了解",
  "信任",
  "依赖",
  
  // 兴趣爱好
  "喜欢",
  "爱好",
  "兴趣",
  "游戏",
  "音乐",
  "电影",
  "书",
  "故事",
];

/**
 * 过滤技术细节
 * 
 * 移除包含技术关键词的记忆片段
 * 
 * @param memories - 原始记忆列表
 * @returns 过滤后的记忆列表
 */
export function filterTechnicalDetails(
  memories: MemorySearchResult[],
): MemorySearchResult[] {
  return memories.filter((memory) => {
    const content = memory.snippet.toLowerCase();
    
    // 检查是否包含技术关键词
    const hasTechnicalKeyword = TECHNICAL_KEYWORDS.some((keyword) =>
      content.includes(keyword.toLowerCase())
    );
    
    // 如果包含技术关键词，过滤掉
    return !hasTechnicalKeyword;
  });
}

/**
 * 按角色过滤记忆
 * 
 * 只保留与角色相关的记忆片段
 * 
 * @param memories - 原始记忆列表
 * @param characterName - 角色名称（可选）
 * @returns 过滤后的记忆列表
 */
export function filterByRole(
  memories: MemorySearchResult[],
  characterName?: string,
): MemorySearchResult[] {
  return memories.filter((memory) => {
    const content = memory.snippet.toLowerCase();
    
    // 检查是否包含角色相关关键词
    const hasRoleKeyword = ROLE_KEYWORDS.some((keyword) =>
      content.includes(keyword.toLowerCase())
    );
    
    // 如果指定了角色名称，检查是否提到该角色
    if (characterName) {
      const mentionsCharacter = content.includes(characterName.toLowerCase());
      return hasRoleKeyword || mentionsCharacter;
    }
    
    return hasRoleKeyword;
  });
}

/**
 * 格式化记忆为角色视角
 * 
 * 将记忆转换为第一人称视角，符合角色的语气和世界观
 * 
 * @param memories - 记忆列表
 * @param characterName - 角色名称
 * @returns 格式化后的记忆上下文
 */
export function formatMemoryForRole(
  memories: MemorySearchResult[],
  characterName: string,
): string {
  if (memories.length === 0) {
    return "";
  }

  const parts = [
    `## ${characterName}的记忆`,
    "",
    "以下是我记得的一些事情：",
    "",
  ];

  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];
    
    // 转换为第一人称视角
    const formattedSnippet = convertToFirstPerson(memory.snippet, characterName);
    
    parts.push(`### 记忆 ${i + 1}`);
    parts.push(formattedSnippet);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * 转换为第一人称视角
 * 
 * 将记忆内容转换为角色的第一人称视角
 * 
 * @param content - 原始内容
 * @param characterName - 角色名称
 * @returns 转换后的内容
 */
function convertToFirstPerson(content: string, characterName: string): string {
  // 简单的转换规则
  let result = content;
  
  // 替换角色名称为"我"
  result = result.replace(new RegExp(characterName, "gi"), "我");
  
  // 替换"主人"为"主人"（保持不变）
  // 替换"用户"为"主人"
  result = result.replace(/用户/g, "主人");
  
  return result;
}

/**
 * 组合过滤器
 * 
 * 应用所有过滤规则，返回适合角色的记忆
 * 
 * @param memories - 原始记忆列表
 * @param characterName - 角色名称
 * @returns 过滤和格式化后的记忆上下文
 */
export function filterAndFormatForRole(
  memories: MemorySearchResult[],
  characterName: string,
): string {
  // 1. 过滤技术细节
  let filtered = filterTechnicalDetails(memories);
  
  // 2. 按角色过滤
  filtered = filterByRole(filtered, characterName);
  
  // 3. 格式化为角色视角
  return formatMemoryForRole(filtered, characterName);
}

/**
 * 检查记忆是否适合角色
 * 
 * 快速检查单个记忆是否适合角色使用
 * 
 * @param memory - 记忆片段
 * @param characterName - 角色名称（可选）
 * @returns 是否适合角色
 */
export function isMemorySuitableForRole(
  memory: MemorySearchResult,
  characterName?: string,
): boolean {
  const content = memory.snippet.toLowerCase();
  
  // 检查是否包含技术关键词
  const hasTechnicalKeyword = TECHNICAL_KEYWORDS.some((keyword) =>
    content.includes(keyword.toLowerCase())
  );
  
  if (hasTechnicalKeyword) {
    return false;
  }
  
  // 检查是否包含角色相关关键词
  const hasRoleKeyword = ROLE_KEYWORDS.some((keyword) =>
    content.includes(keyword.toLowerCase())
  );
  
  // 如果指定了角色名称，检查是否提到该角色
  if (characterName) {
    const mentionsCharacter = content.includes(characterName.toLowerCase());
    return hasRoleKeyword || mentionsCharacter;
  }
  
  return hasRoleKeyword;
}
