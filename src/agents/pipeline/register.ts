/**
 * 动态管道插件注册
 *
 * 在插件加载时注册动态管道的 hooks
 *
 * @module agents/pipeline/register
 */

import type { ClawdbotPluginApi } from "../../plugins/types.js";
import { onBeforeAgentStart, onAgentEnd } from "./plugin.js";

/**
 * 注册动态管道插件到 Clawdbot 插件系统
 */
export function registerPipelinePlugin(api: ClawdbotPluginApi): void {
  // 注册 before_agent_start hook
  api.on("before_agent_start", onBeforeAgentStart, { priority: 100 });

  // 注册 agent_end hook
  api.on("agent_end", onAgentEnd, { priority: 100 });

  api.logger.info("Dynamic pipeline plugin registered");
}

/**
 * 插件定义
 */
export const pipelinePluginDefinition = {
  id: "clawdbot-pipeline",
  name: "Dynamic Pipeline Plugin",
  version: "1.0.0",
  description: "动态管道插件：LLM 驱动的意图分析与能力调度",
  register: registerPipelinePlugin,
};

