/**
 * 爱姬聊天室 — 核心类型定义
 *
 * 支持"一应三答"多角色并行/错峰 LLM 调用，
 * 以及互评、自由聊天等互动模式。
 *
 * @module agents/chatroom/types
 */

// ============================================================================
// 聊天室配置
// ============================================================================

/**
 * 聊天室运行时配置
 */
export interface ChatRoomConfig {
  /** 每次唤醒后，每位角色的最大主动回复次数（默认 10） */
  maxRepliesPerCharacter: number;
  /** 单次聊天室会话的最大总消息数（默认 30） */
  maxTotalMessages: number;
  /** 互动轮次上限（默认 3） */
  maxInteractionRounds: number;
  /** 自由聊天模式的最大总轮次（默认 5） */
  maxFreeChatRounds: number;
  /** 每轮互动中每位角色的最大发言次数（默认 1） */
  maxTurnsPerInteractionRound: number;
  /** LLM 调用间隔（ms），错峰调用防止 API 限流（默认 1500） */
  callStaggerDelayMs: number;
  /** LLM 调用超时（ms）（默认 60000） */
  llmTimeoutMs: number;
  /** 会话超时（ms），主人不说话多久后自动结束（默认 30 分钟） */
  sessionTimeoutMs: number;
  /** LLM 最大输出 token（默认 2048，聊天室场景偏短回复） */
  maxOutputTokens: number;
  /** LLM 温度（默认 0.7，聊天场景偏高温增加多样性） */
  temperature: number;
}

/**
 * 默认配置
 */
export const DEFAULT_CHATROOM_CONFIG: ChatRoomConfig = {
  maxRepliesPerCharacter: 10,
  maxTotalMessages: 30,
  maxInteractionRounds: 3,
  maxFreeChatRounds: 5,
  maxTurnsPerInteractionRound: 1,
  callStaggerDelayMs: 1500,
  llmTimeoutMs: 60_000,
  sessionTimeoutMs: 30 * 60 * 1000,
  maxOutputTokens: 2048,
  temperature: 0.7,
};

// ============================================================================
// 意图检测
// ============================================================================

/** 触发类型 */
export type ChatRoomTriggerType =
  | "tri_summon"    // 三召唤（全员参与）
  | "multi_name"    // 点名多位
  | "continuation"  // 会话延续
  | "interaction"   // 互评/聊天触发
  | "exit"          // 退出聊天室
  | "single";       // 单角色（不进入聊天室）

/** 互动模式 */
export type InteractionMode = "review" | "free_chat" | "debate";

/**
 * 聊天室检测结果
 */
export interface ChatRoomDetectionResult {
  /** 是否触发聊天室模式 */
  isChatRoomMode: boolean;
  /** 参与角色 ID 列表 */
  participants: string[];
  /** 触发类型 */
  triggerType: ChatRoomTriggerType;
  /** 互动模式（仅 interaction 类型时有值） */
  interactionMode?: InteractionMode;
}

// ============================================================================
// 聊天室会话
// ============================================================================

/**
 * 聊天室消息
 */
export interface ChatRoomMessage {
  /** 消息 ID */
  id: string;
  /** 发送者类型 */
  senderType: "user" | "character";
  /** 发送者 ID（角色 ID 或 "user"） */
  senderId: string;
  /** 发送者显示名 */
  senderDisplayName: string;
  /** 消息内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
  /** 是否为互动消息（对其他角色的回应） */
  isInteraction: boolean;
  /** 回应的目标消息 ID（互动时） */
  replyToMessageId?: string;
}

/**
 * 聊天室会话状态
 */
export interface ChatRoomSession {
  /** 会话 ID */
  sessionId: string;
  /** 关联的消息通道 session key */
  parentSessionKey: string;
  /** 参与角色 ID 列表 */
  participants: string[];
  /** 角色 ID → 显示名映射（由编排器在开场时填充） */
  displayNames: Record<string, string>;
  /** 聊天历史 */
  messages: ChatRoomMessage[];
  /** 每位角色的回复计数 */
  replyCounters: Record<string, number>;
  /** 总消息计数 */
  totalMessageCount: number;
  /** 是否仍然活跃 */
  isActive: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 上次活动时间 */
  lastActivityAt: number;
  /** 当前互动模式（null = 普通问答） */
  currentInteractionMode: InteractionMode | null;
  /** 已执行的互动轮次数 */
  interactionRoundsExecuted: number;
}

// ============================================================================
// 角色响应
// ============================================================================

/**
 * 单个角色的响应结果
 */
export interface CharacterResponse {
  /** 角色 ID */
  characterId: string;
  /** 角色显示名 */
  displayName: string;
  /** 响应内容 */
  content: string;
  /** 响应耗时（ms） */
  durationMs: number;
  /** 是否成功 */
  ok: boolean;
  /** 错误信息（失败时） */
  error?: string;
  /** 记忆动作执行结果（如果角色请求了记忆操作） */
  memoryActions?: MemoryActionResult[];
  /** 预取的记忆上下文片段数（诊断用） */
  memoryContextCount?: number;
}

/**
 * 角色颜色/图标映射（用于消息格式化）
 */
export const CHARACTER_ICONS: Record<string, { icon: string; color: string }> = {
  lina:     { icon: "💜", color: "purple" },
  demerzel: { icon: "🧡", color: "orange" },
  dolores:  { icon: "💙", color: "blue" },
};

// ============================================================================
// 记忆桥接（Memory Bridge）
// ============================================================================

/** 记忆动作类型 */
export type MemoryActionType = "write" | "update" | "append";

/**
 * 角色 LLM 输出中解析出的记忆动作
 */
export interface MemoryAction {
  /** 动作类型 */
  type: MemoryActionType;
  /** 目标文件路径（相对于工作区） */
  filePath: string;
  /** 写入/追加的内容 */
  content: string;
  /** 更新时的旧文本（仅 update 类型） */
  oldText?: string;
}

/**
 * 记忆动作执行结果
 */
export interface MemoryActionResult {
  /** 动作 */
  action: MemoryAction;
  /** 是否成功 */
  ok: boolean;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 预取的记忆上下文片段
 */
export interface MemoryContextSnippet {
  /** 来源文件路径 */
  path: string;
  /** 匹配分数 */
  score: number;
  /** 内容片段 */
  snippet: string;
}

// ============================================================================
// 编排器
// ============================================================================

/**
 * LLM 调用策略
 */
export type CallStrategy =
  | "staggered"   // 错峰调用（每个间隔 callStaggerDelayMs）
  | "sequential"  // 完全串行
  | "parallel";   // 完全并行

/**
 * 聊天室编排器处理参数
 */
export interface ChatRoomHandleParams {
  /** 用户消息 */
  userMessage: string;
  /** 参与角色 ID 列表 */
  participants: string[];
  /** 消息通道 session key */
  sessionKey: string;
  /** 回复发送函数 */
  sendReply: (text: string) => Promise<void>;
  /** LLM 调用策略（默认 staggered） */
  callStrategy?: CallStrategy;
  /** 互动模式（null = 仅回答不互动） */
  interactionMode?: InteractionMode | null;
  /** agent session key（用于记忆工具的工作区路径解析） */
  agentSessionKey?: string;
}
