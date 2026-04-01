/**
 * 三维动态人格融合系统 - 类型定义
 *
 * 定义 SOUL、CONTEXT、PHASE 三个维度的数据结构
 * 以及融合结果和插件配置的类型
 *
 * @module persona-3d-fusion/types
 */

// =============================================================================
// 核心类型定义
// =============================================================================

/**
 * SOUL 定义 - 灵魂/身份基础
 * 核心人格不变的部分
 */
export interface SoulDefinition {
  /** 唯一标识符 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 人格特质列表 */
  personality_traits: string[];
  /** 说话风格描述 */
  speaking_style: string;
  /** 对用户的称呼 */
  address_user: string;
  /** 对自己的称呼 */
  address_self: string;
  /** 核心价值观 */
  core_values: string;
  /** 情感回路描述 */
  emotional_circuits?: string;
  /** 身份宣言 */
  identity_statement?: string;
}

/**
 * CONTEXT 定义 - 工作/环境基础
 * 干什么事的认知
 */
export interface ContextDefinition {
  /** 唯一标识符 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 触发关键词列表 */
  trigger_keywords: string[];
  /** 描述 */
  description: string;
  /** 角色视角/立场 */
  role_perspective: string;
  /** 行为模式列表 */
  behavior_patterns: string[];
}

/**
 * PHASE 定义 - 任务阶段基础
 * 事情进行到哪一步的认知
 */
export interface PhaseDefinition {
  /** 唯一标识符 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 触发关键词列表 */
  trigger_keywords: string[];
  /** 描述 */
  description: string;
  /** 情感基调 */
  emotional_tone: string;
  /** 行动模式列表 */
  action_patterns: string[];
  /** 成功标准 */
  success_criteria?: string;
}

// =============================================================================
// 融合结果
// =============================================================================

/**
 * 三维融合结果
 */
export interface FusionResult {
  /** SOUL 定义 */
  soul: SoulDefinition;
  /** CONTEXT 定义（未检测到则为 null） */
  context: ContextDefinition | null;
  /** PHASE 定义（未识别到则为 null） */
  phase: PhaseDefinition | null;
  /** 融合后的 prompt 文本 */
  fusedPrompt: string;
  /** 融合推理过程 */
  reasoning: string;
}

/**
 * 融合模式
 */
export type FusionMode = "replace" | "append" | "prepend";

// =============================================================================
// 检测结果
// =============================================================================

/**
 * CONTEXT 检测结果
 */
export interface ContextDetectionResult {
  /** 检测到的 CONTEXT 定义 */
  context: ContextDefinition | null;
  /** 置信度 0-1 */
  confidence: number;
  /** 匹配的关键词 */
  matchedKeywords: string[];
}

/**
 * PHASE 检测结果
 */
export interface PhaseDetectionResult {
  /** 识别到的 PHASE 定义 */
  phase: PhaseDefinition | null;
  /** 置信度 0-1 */
  confidence: number;
  /** 匹配的关键词 */
  matchedKeywords: string[];
  /** 对话状态线索 */
  stateClues: string[];
}

// =============================================================================
// 插件配置
// =============================================================================

/**
 * 角色配置（从 config.json 加载）
 */
export interface CharacterConfig {
  /** 角色唯一标识 */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 版本号 */
  version: string;
  /** 类型 */
  type: string;
  /** 是否启用 */
  enabled: boolean;
  /** 资产 ID */
  assetId?: string;
  /** 三维定义配置 */
  threeDimensional: {
    soulsDir: string;
    contextsDir: string;
    phasesDir: string;
    defaultSoul: string;
    defaultContext: string;
    defaultPhase: string;
  };
  /** 其他配置（扩展用） */
  [key: string]: unknown;
}

/**
 * 插件配置
 */
export interface Persona3DFusionConfig {
  /** 定义文件根目录路径（clawd 目录） */
  definitionsPath?: string;
  /** 默认角色 ID */
  defaultCharacter?: string;
  /** 默认 SOUL ID */
  defaultSoul?: string;
  /** 是否启用 CONTEXT 自动检测 */
  enableContextDetection?: boolean;
  /** 是否启用 PHASE 自动识别 */
  enablePhaseDetection?: boolean;
  /** 融合模式 */
  fusionMode?: FusionMode;
  /** 是否启用文件缓存 */
  cacheEnabled?: boolean;
}

/**
 * 插件配置默认值
 */
export const DEFAULT_CONFIG: Required<Persona3DFusionConfig> = {
  definitionsPath: "C:\\Users\\zouta\\clawd",
  defaultCharacter: "demerzel",
  defaultSoul: "demerzel",
  enableContextDetection: true,
  enablePhaseDetection: true,
  fusionMode: "prepend",
  cacheEnabled: true,
};

// =============================================================================
// Hook 相关类型
// =============================================================================

/**
 * Pipeline Hook 事件类型（参考 clawdbot 类型）
 */
export interface PipelineHookEvent {
  /** 用户消息 */
  prompt: string;
  /** 对话历史消息 */
  messages?: AgentMessage[];
  /** 会话 Key */
  sessionKey?: string;
  /** Agent ID */
  agentId?: string;
}

/**
 * Agent 消息结构
 */
export interface AgentMessage {
  /** 消息角色 */
  role: "user" | "assistant" | "system";
  /** 消息内容 */
  content: string | MessageContentBlock[];
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 消息内容块（支持多模态） */
export type MessageContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64" | "url"; media_type: string; data?: string } };

/**
 * Hook 返回结果
 */
export interface PipelineHookResult {
  /** 融合后的 prompt */
  fusedPrompt?: string;
  /** 上下文信息 */
  context?: Record<string, unknown>;
  /** 错误信息 */
  error?: string;
}

// =============================================================================
// 缓存相关
// =============================================================================

/**
 * 缓存条目
 */
export interface CacheEntry<T> {
  /** 数据 */
  data: T;
  /** 过期时间戳 */
  expiresAt: number;
}

/**
 * 融合组件（通用 + 角色特有）
 */
export interface FusionComponent<T> {
  /** 通用定义 */
  generic?: T | null;
  /** 角色特有定义 */
  character?: T | null;
}

/**
 * 插件状态
 */
export interface PluginState {
  /** 当前角色配置 */
  currentCharacter: CharacterConfig | null;
  /** 当前 SOUL */
  currentSoul: SoulDefinition | null;
  /** 当前 CONTEXT（通用 + 角色特有） */
  currentContext: FusionComponent<ContextDefinition> | null;
  /** 当前 PHASE（通用 + 角色特有） */
  currentPhase: FusionComponent<PhaseDefinition> | null;
  /** 上次融合结果 */
  lastFusionResult: FusionResult | null;
  /** 配置 */
  config: Persona3DFusionConfig;
}
