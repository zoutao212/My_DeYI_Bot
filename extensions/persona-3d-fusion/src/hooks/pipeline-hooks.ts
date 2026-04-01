/**
 * Pipeline Hooks - Pipeline 钩子集成
 *
 * 提供与 clawdbot Pipeline 架构的集成接口
 *
 * @module persona-3d-fusion/hooks/pipeline-hooks
 */

import type { PipelineHookEvent, PipelineHookResult, Persona3DFusionConfig } from "../types.js";
import { onBeforeAgentStart, onAfterPromptBuild } from "../index.js";

/**
 * 注册 Pipeline Hooks
 *
 * 在 clawdbot 启动时调用此函数注册 hooks
 *
 * @param config 插件配置
 * @returns hook 注册信息
 */
export function registerPipelineHooks(
  config?: Persona3DFusionConfig,
): Array<{ hookName: string; handler: Function; priority: number }> {
  return [
    {
      hookName: "before_agent_start",
      handler: (event: PipelineHookEvent) => onBeforeAgentStart(event, config),
      priority: 50,
    },
    {
      hookName: "after_prompt_build",
      handler: (event: PipelineHookEvent) => onAfterPromptBuild(event as PipelineHookEvent & { existingPrompt?: string }, config),
      priority: 50,
    },
  ];
}

/**
 * before_agent_start Hook 处理器
 *
 * 在 Agent 启动前执行，注入三维融合后的动态 prompt
 */
export async function beforeAgentStartHook(
  event: PipelineHookEvent,
  config?: Persona3DFusionConfig,
): Promise<PipelineHookResult> {
  return onBeforeAgentStart(event, config);
}

/**
 * after_prompt_build Hook 处理器
 *
 * 在 prompt 构建完成后执行，可修改或增强 prompt
 */
export async function afterPromptBuildHook(
  event: PipelineHookEvent & { existingPrompt?: string },
  config?: Persona3DFusionConfig,
): Promise<PipelineHookResult> {
  return onAfterPromptBuild(event, config);
}

export default {
  registerPipelineHooks,
  beforeAgentStartHook,
  afterPromptBuildHook,
};
