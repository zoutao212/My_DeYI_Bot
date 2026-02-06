/**
 * 统一模板变量渲染引擎
 *
 * 所有 {变量} 占位符在此处一次性替换，避免多处重复实现。
 *
 * 规则：
 * - 未匹配的变量保留原样（不报错，方便渐进填充）
 * - 空字符串变量会被替换为配置的默认值
 *
 * @module agents/pipeline/characters/template-engine
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 模板渲染上下文 */
export interface TemplateContext {
  // 来自 config.json / persona.md
  displayName: string;
  addressUser: string;
  addressSelf: string;
  personality: string;
  capabilities: string;

  // 来自外部注入
  userName: string;
  currentDate: string;

  // 来自记忆层（延迟注入）
  coreMemories: string;
  relevantMemories: string;

  // 来自知识层
  knowledgeBase: string;

  // 来自角色档案
  characterProfile: string;

  // 关系状态（虚拟角色）
  relationshipStatus: string;

  // 扩展变量（用户自定义）
  [key: string]: string;
}

// ============================================================================
// 核心 API
// ============================================================================

/**
 * 渲染模板，替换 {变量} 占位符
 *
 * @param template - 含 {变量} 占位符的模板字符串
 * @param context - 变量值映射（部分即可）
 * @param defaults - 当 context 中某变量为空字符串时使用的默认值
 * @returns 替换后的字符串
 */
export function renderTemplate(
  template: string,
  context: Partial<TemplateContext>,
  defaults?: Partial<TemplateContext>,
): string {
  // 合并默认值（context 优先）
  const merged = { ...defaults, ...context };

  let result = template;
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      result = result.replaceAll(`{${key}}`, value);
    }
  }
  return result;
}

/**
 * 从已加载的角色数据构建 TemplateContext（不含记忆层，记忆由调用方延迟注入）
 */
export function buildTemplateContextFromCharacter(params: {
  config: {
    displayName: string;
    systemPrompt: {
      addressUser: string;
      addressSelf: string;
      personality: string[];
    };
  };
  profileRawContent: string;
  profileCapabilities: string;
  knowledgeCombined: string;
  userName?: string;
}): Partial<TemplateContext> {
  const { config, profileRawContent, profileCapabilities, knowledgeCombined, userName } = params;
  return {
    displayName: config.displayName,
    addressUser: config.systemPrompt.addressUser,
    addressSelf: config.systemPrompt.addressSelf,
    personality: config.systemPrompt.personality.join("、"),
    capabilities: profileCapabilities || "待定义",
    characterProfile: profileRawContent,
    currentDate: new Date().toLocaleDateString("zh-CN"),
    knowledgeBase: knowledgeCombined,
    userName: userName ?? "用户",
    relationshipStatus: "初始状态",
  };
}
