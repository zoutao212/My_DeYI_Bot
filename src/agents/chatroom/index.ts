/**
 * 爱姬聊天室 — 模块导出
 *
 * 一应三答·多角色聊天室框架
 *
 * @module agents/chatroom
 */

// 类型
export type {
  ChatRoomConfig,
  ChatRoomDetectionResult,
  ChatRoomHandleParams,
  ChatRoomMessage,
  ChatRoomSession,
  ChatRoomTriggerType,
  CallStrategy,
  CharacterResponse,
  CollaborativeTaskContext,
  InteractionMode,
  MemoryAction,
  MemoryActionResult,
  MemoryActionType,
  MemoryContextSnippet,
} from "./types.js";
export { DEFAULT_CHATROOM_CONFIG, CHARACTER_ICONS } from "./types.js";

// 检测器
export { detectChatRoomIntent } from "./detector.js";

// 检测器国际化
export type { ChatRoomDetectorL10n } from "./detector.l10n.types.js";
export { setDetectorLanguage, getDetectorLanguage, getDetectorL10n, getCharacterAgentL10n } from "./detector-l10n-loader.js";

// 角色 Agent 国际化
export type { CharacterAgentL10n } from "./character-agent.l10n.types.js";
export { fillTemplate } from "./character-agent.l10n.types.js";

// 会话管理
export {
  getOrCreateSession,
  getActiveSession,
  hasActiveSession,
  addUserMessage,
  addCharacterMessage,
  canCharacterReply,
  canContinue,
  setInteractionMode,
  closeSession,
  getRecentMessages,
  getReplyStats,
  clearAllSessions,
} from "./session.js";

// 角色 Agent
export { generateCharacterResponse, getCharacterDisplayName, clearPersonaCache, executeLeadCharacterWithTools } from "./character-agent.js";

// 格式化器
export {
  formatOpeningMessage,
  formatResponses,
  formatInteractionResponses,
  formatClosingMessage,
  formatLimitReachedMessage,
  formatCollaborativeBanner,
  formatPlanningPhase,
  formatExecutionPhase,
  formatReviewPhase,
} from "./formatter.js";

// 编排器
export { handleChatRoomMessage, closeChatRoom } from "./orchestrator.js";

// 记忆桥接
export {
  fetchMemoryContext,
  formatMemoryContextForPrompt,
  buildMemoryWriteGuide,
  parseMemoryActions,
  executeMemoryActions,
} from "./memory-bridge.js";
