/**
 * 爱姬聊天室 — 角色 Agent 国际化类型定义
 *
 * 将 character-agent.ts 中硬编码的中文提示词/模板抽取为可按语言切换的配置。
 *
 * 模板字符串使用 `{placeholder}` 占位符，运行时由 fillTemplate() 替换。
 *
 * @module agents/chatroom/character-agent.l10n.types
 */

// ============================================================================
// 类型
// ============================================================================

/**
 * 角色 Agent 的国际化配置
 */
export interface CharacterAgentL10n {
  // ── buildChatRoomContextPrompt ──

  /** 聊天室标题，如 "## 🏠 爱姬聊天室" */
  chatRoomTitle: string;

  /** 聊天室场景说明，如 "你正在与主人和其他姐妹一起在聊天室中。" */
  chatRoomIntro: string;

  /** 角色身份说明模板，占位符 {displayName}，如 "你是 {displayName}，请用你自己独特的风格和视角回答。" */
  chatRoomYouAre: string;

  /** 参与者前缀模板，占位符 {participants}，如 "参与者：{participants}" */
  chatRoomParticipants: string;

  /** 参与者分隔符，中文用 "、"，英文用 ", " */
  participantSeparator: string;

  /** 聊天记录标题，如 "## 聊天记录" */
  chatHistoryTitle: string;

  /** 聊天室守则标题，如 "## 聊天室守则" */
  chatRulesTitle: string;

  /** 聊天室守则条目（每条一个字符串） */
  chatRules: string[];

  // ── generateCharacterResponse ──

  /** 角色不可用时的回退文本模板，占位符 {name}，如 "（{name} 暂时无法回应）" */
  characterUnavailable: string;

  /** 角色加载失败错误文本，如 "角色加载失败" */
  characterLoadFailed: string;

  /** 角色设定标题，如 "# 角色设定" */
  roleSettingTitle: string;

  /** 主人消息标题，如 "# 主人的消息" */
  masterMessageTitle: string;

  /** 回复指令模板，占位符 {displayName}，如 "请以 {displayName} 的身份回复。直接输出回复内容，不要加任何前缀标签。" */
  replyInstruction: string;

  /** 角色思考中回退文本模板，占位符 {displayName}，如 "（{displayName} 正在思考中，稍后再来……）" */
  characterThinking: string;

  // ── executeLeadCharacterWithTools ──

  /** 协作模式角色加载失败文本模板，占位符 {name}，如 "（{name} 角色加载失败，无法执行协作任务）" */
  collabCharacterLoadFailed: string;

  /** 协作任务标题，如 "## 🤝 爱姬聊天室 — 协作任务执行" */
  collabTitle: string;

  /** 协作领头角色说明模板，占位符 {displayName}，如 "你是 {displayName}，姐妹们推举你主导完成这项复杂任务。" */
  collabLeadIntro: string;

  /** 规划讨论标题，如 "## 📋 姐妹们的规划讨论" */
  collabPlanningTitle: string;

  /** 规划讨论引言，如 "以下是姐妹们对这个任务的分析和建议，请参考她们的意见：" */
  collabPlanningIntro: string;

  /** 复杂度分析标题，如 "## 🧠 任务复杂度分析" */
  collabComplexityTitle: string;

  /** 系统能力标题，如 "## 🔧 系统能力（全部可用）" */
  collabCapabilitiesTitle: string;

  /** 系统能力引言，如 "你拥有完整的系统能力来完成这个任务：" */
  collabCapabilitiesIntro: string;

  /** enqueue_task 能力说明 */
  collabCapabilityEnqueue: string;

  /** 记忆系统能力说明 */
  collabCapabilityMemory: string;

  /** continue_generation 能力说明 */
  collabCapabilityContinue: string;

  /** 文件操作能力说明 */
  collabCapabilityFile: string;

  /** Web 能力说明 */
  collabCapabilityWeb: string;

  /** 协作任务结尾指令，如 "请根据姐妹们的讨论和任务需求，高效执行。..." */
  collabClosingInstruction: string;

  /** 无输出时的回退文本，如 "（任务执行完成，但未产生文本输出）" */
  collabNoOutput: string;

  /** 协作任务异常文本模板，占位符 {displayName} {error}，如 "（{displayName} 执行协作任务时遇到问题：{error}）" */
  collabError: string;
}

// ============================================================================
// 模板填充工具
// ============================================================================

/**
 * 简单的模板占位符替换
 *
 * @example
 * fillTemplate("你是 {displayName}，请回复。", { displayName: "琳娜" })
 * // → "你是 琳娜，请回复。"
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}
