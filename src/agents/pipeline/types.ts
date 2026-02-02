/**
 * 动态管道类型定义
 *
 * 核心概念：
 * - ExecutionPlan: LLM 分析后的执行计划
 * - Capability: 能力定义
 * - CapabilityCall: 能力调用
 *
 * @module agents/pipeline/types
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ClawdbotConfig } from "../../config/config.js";

// ============================================================================
// 执行计划
// ============================================================================

/**
 * LLM 分析后的执行计划
 */
export interface ExecutionPlan {
  /** 用户意图的自然语言描述（LLM 动态生成，不预设类型） */
  intentDescription: string;

  /** 管道阶段 */
  pipeline: {
    /** 前置处理：需要调用的能力列表 */
    preProcess: CapabilityCall[];
    /** 核心处理：需要调用的能力（可为 null，由 LLM 直接处理） */
    coreProcess: CapabilityCall | null;
    /** 响应生成：需要调用的能力（可为 null，由 LLM 直接生成） */
    responseGenerate: CapabilityCall | null;
    /** 后置处理：需要调用的能力列表 */
    postProcess: CapabilityCall[];
  };
}

/**
 * 能力调用
 */
export interface CapabilityCall {
  /** 能力名称 */
  capability: string;
  /** 能力参数（LLM 动态决定） */
  params: Record<string, unknown>;
  /** 说明（LLM 生成） */
  reason: string;
}

// ============================================================================
// 能力定义
// ============================================================================

/**
 * 能力描述（给 LLM 看的）
 */
export interface CapabilityDescription {
  name: string;
  description: string;
  useCases: string[];
  parameters: Record<string, string>;
}

/**
 * 能力执行参数
 */
export interface CapabilityExecuteParams {
  /** LLM 指定的参数 */
  params: Record<string, unknown>;
  /** 执行上下文 */
  context: PipelineContext;
  /** 前序能力的执行结果 */
  previousResults: Record<string, unknown>;
}

/**
 * 能力执行器
 */
export interface Capability {
  name: string;
  description: string;
  useCases: string[];
  parameters: Record<string, string>;
  execute(params: CapabilityExecuteParams): Promise<unknown>;
}

// ============================================================================
// 管道上下文
// ============================================================================

/**
 * 管道执行上下文
 */
export interface PipelineContext {
  /** 用户消息 */
  userMessage: string;
  /** 对话历史 */
  conversationHistory: AgentMessage[];
  /** 会话 ID */
  sessionId: string;
  /** 会话 Key */
  sessionKey?: string;
  /** Agent ID */
  agentId: string;
  /** 用户 ID */
  userId?: string;
  /** Clawdbot 配置 */
  config: ClawdbotConfig;
}

// ============================================================================
// 角色识别
// ============================================================================

/**
 * 角色识别配置
 */
export interface CharacterRecognitionConfig {
  /** 角色 ID */
  id: string;
  /** 显示名称 */
  displayName: string;
  /** 是否是系统人格化（如栗娜） */
  isSystemPersona: boolean;
  /** 识别规则 */
  recognition: {
    /** 角色名称列表（直接匹配） */
    names: string[];
    /** 触发词（系统人格特有） */
    triggers?: string[];
    /** 上下文关键词 */
    contexts?: string[];
  };
}

/**
 * 识别到的角色
 */
export interface DetectedCharacter {
  /** 角色 ID */
  id: string;
  /** 匹配到的名称 */
  name: string;
  /** 是否是系统人格化 */
  isSystemPersona: boolean;
  /** 匹配类型 */
  matchType: "name" | "trigger" | "context" | "default";
}

// ============================================================================
// 前置/后置处理结果
// ============================================================================

/**
 * 前置处理结果
 */
export interface PreProcessResult {
  /** 注入到 prompt 的上下文 */
  prependContext?: string;
  /** 记忆检索结果 */
  memories?: unknown;
  /** 人格配置 */
  personality?: {
    config: unknown;
    profile: string;
    knowledge?: unknown;
    coreMemories?: unknown;
    systemPrompt: string;
    isSystemPersona: boolean;
    enabledFeatures: Record<string, boolean>;
  };
  /** 执行计划 */
  plan?: ExecutionPlan;
}

/**
 * 后置处理结果
 */
export interface PostProcessResult {
  /** 归档是否成功 */
  archived: boolean;
  /** 归档路径 */
  archivePath?: string;
  /** 其他后置处理结果 */
  [key: string]: unknown;
}

// ============================================================================
// 管道状态
// ============================================================================

/**
 * 管道状态（按 sessionKey 存储）
 */
export interface PipelineState {
  /** 执行计划 */
  plan: ExecutionPlan;
  /** 前置处理结果 */
  preProcessResults: Record<string, unknown>;
  /** 识别到的角色 */
  detectedCharacter?: DetectedCharacter;
  /** 开始时间 */
  startTime: number;
}

