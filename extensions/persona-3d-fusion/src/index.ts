/**
 * 三维动态人格融合插件 - 入口文件
 *
 * @module persona-3d-fusion
 */

import type { PipelineHookEvent, PipelineHookResult, Persona3DFusionConfig } from "./types.js";
import { FusionEngine } from "./fusion-engine.js";
import { SoulProvider } from "./providers/soul-provider.js";
import { ContextDetector } from "./providers/context-detector.js";
import { PhaseDetector } from "./providers/phase-detector.js";
import { DEFAULT_CONFIG } from "./types.js";

// =============================================================================
// 插件状态
// =============================================================================

let fusionEngine: FusionEngine | null = null;
let soulProvider: SoulProvider | null = null;
let contextDetector: ContextDetector | null = null;
let phaseDetector: PhaseDetector | null = null;
let pluginConfig: Required<Persona3DFusionConfig> = DEFAULT_CONFIG;

// =============================================================================
// 初始化
// =============================================================================

/**
 * 初始化插件
 */
function initializePlugin(config?: Persona3DFusionConfig): void {
  if (fusionEngine) return; // 避免重复初始化

  pluginConfig = { ...DEFAULT_CONFIG, ...config };

  // 创建提供者
  soulProvider = new SoulProvider(pluginConfig.definitionsPath, pluginConfig.cacheEnabled);
  contextDetector = new ContextDetector(pluginConfig.definitionsPath, pluginConfig.cacheEnabled);
  phaseDetector = new PhaseDetector(pluginConfig.definitionsPath, pluginConfig.cacheEnabled);

  // 创建融合引擎
  fusionEngine = new FusionEngine(soulProvider, contextDetector, phaseDetector);

  console.log("[persona-3d-fusion] 插件初始化完成", {
    defaultSoul: pluginConfig.defaultSoul,
    fusionMode: pluginConfig.fusionMode,
    enableContextDetection: pluginConfig.enableContextDetection,
    enablePhaseDetection: pluginConfig.enablePhaseDetection,
  });
}

// =============================================================================
// Hook 处理器
// =============================================================================

/**
 * before_agent_start Hook
 * 在 Agent 启动前执行，注入三维融合后的动态 prompt
 */
export async function onBeforeAgentStart(
  event: PipelineHookEvent,
  config?: Persona3DFusionConfig,
): Promise<PipelineHookResult> {
  try {
    // 初始化插件（惰性初始化）
    initializePlugin(config);

    if (!fusionEngine) {
      return { error: "FusionEngine 未初始化" };
    }

    // 提取用户消息
    const userMessage = typeof event.prompt === "string"
      ? event.prompt
      : JSON.stringify(event.prompt);

    // 执行三维融合
    const fusionResult = await fusionEngine.fuse({
      soulId: pluginConfig.defaultSoul,
      userMessage,
      conversationHistory: event.messages || [],
      enableContextDetection: pluginConfig.enableContextDetection,
      enablePhaseDetection: pluginConfig.enablePhaseDetection,
    });

    // 根据融合模式处理 prompt
    let finalPrompt: string;
    switch (pluginConfig.fusionMode) {
      case "replace":
        finalPrompt = fusionResult.fusedPrompt;
        break;
      case "append":
        finalPrompt = `${userMessage}\n\n${fusionResult.fusedPrompt}`;
        break;
      case "prepend":
      default:
        finalPrompt = `${fusionResult.fusedPrompt}\n\n${userMessage}`;
        break;
    }

    return {
      fusedPrompt: finalPrompt,
      context: {
        soul: fusionResult.soul,
        context: fusionResult.context,
        phase: fusionResult.phase,
        reasoning: fusionResult.reasoning,
      },
    };
  } catch (error) {
    console.error("[persona-3d-fusion] before_agent_start 错误:", error);
    return {
      error: error instanceof Error ? error.message : "未知错误",
    };
  }
}

/**
 * after_prompt_build Hook
 * 在 prompt 构建完成后执行，可修改或增强 prompt
 */
export async function onAfterPromptBuild(
  event: PipelineHookEvent & { existingPrompt?: string },
  config?: Persona3DFusionConfig,
): Promise<PipelineHookResult> {
  try {
    // 初始化插件
    initializePlugin(config);

    if (!fusionEngine) {
      return { error: "FusionEngine 未初始化" };
    }

    // 如果没有 existingPrompt，直接返回
    if (!event.existingPrompt) {
      return {};
    }

    // 提取用户消息
    const userMessage = typeof event.prompt === "string"
      ? event.prompt
      : JSON.stringify(event.prompt);

    // 执行三维融合
    const fusionResult = await fusionEngine.fuse({
      soulId: pluginConfig.defaultSoul,
      userMessage,
      conversationHistory: event.messages || [],
      enableContextDetection: pluginConfig.enableContextDetection,
      enablePhaseDetection: pluginConfig.enablePhaseDetection,
    });

    // 将三维 prompt 以注释形式追加到现有 prompt
    const enhancedPrompt = `${event.existingPrompt}\n\n<!-- 3D-Persona-Fusion Context -->\n${fusionResult.fusedPrompt}`;

    return {
      fusedPrompt: enhancedPrompt,
      context: {
        soul: fusionResult.soul,
        context: fusionResult.context,
        phase: fusionResult.phase,
        reasoning: fusionResult.reasoning,
      },
    };
  } catch (error) {
    console.error("[persona-3d-fusion] after_prompt_build 错误:", error);
    return {
      error: error instanceof Error ? error.message : "未知错误",
    };
  }
}

// =============================================================================
// 插件元数据导出
// =============================================================================

export const persona3dFusionPlugin = {
  id: "persona-3d-fusion",
  name: "3D Persona Fusion",
  version: "1.0.0",
  description: "三维动态人格融合系统 - SOUL×CONTEXT×PHASE 动态 prompt 生成",
  author: "德姨",
  hooks: [
    {
      hookName: "before_agent_start",
      handler: onBeforeAgentStart,
      priority: 50,
    },
    {
      hookName: "after_prompt_build",
      handler: onAfterPromptBuild,
      priority: 50,
    },
  ],
};

export default persona3dFusionPlugin;

// =============================================================================
// 工具函数导出
// =============================================================================

export { FusionEngine } from "./fusion-engine.js";
export { SoulProvider } from "./providers/soul-provider.js";
export { ContextDetector } from "./providers/context-detector.js";
export { PhaseDetector } from "./providers/phase-detector.js";
export * from "./types.js";
