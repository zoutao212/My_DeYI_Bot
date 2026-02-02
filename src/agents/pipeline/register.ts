/**
 * Pipeline Plugin 注册模块
 * 
 * 将动态管道系统注册为内置 Plugin，提供：
 * - before_agent_start hook：意图分析和能力调度
 * - agent_end hook：会话归档和记忆更新
 * 
 * @module agents/pipeline/register
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ClawdbotPluginApi } from "../../plugins/types.js";
import type { PipelineContext } from "./types.js";

const log = createSubsystemLogger("pipeline:register");

/**
 * 注册 Pipeline Plugin
 * 
 * @param api - Plugin API
 */
export function registerPipelinePlugin(api: ClawdbotPluginApi): void {
  log.info("Registering Pipeline Plugin...");

  // 注册 before_agent_start hook（使用 api.on 方法）
  api.on(
    "before_agent_start",
    async (event, ctx) => {
      try {
        log.info("🔵 [Pipeline] before_agent_start hook triggered");
        log.info(`🔵 [Pipeline] User message: ${event.prompt?.slice(0, 50)}...`);

        // 🔧 简单的角色识别逻辑（临时实现，后续用 LLM 替换）
        const userMessage = event.prompt || "";
        let detectedCharacter: string | undefined;
        
        // 检测是否提到栗娜
        if (userMessage.includes("栗娜") || userMessage.includes("lina")) {
          detectedCharacter = "lina";
          log.info("🔵 [Pipeline] Detected character: lina (栗娜)");
        }
        // 检测是否提到丽丝
        else if (userMessage.includes("丽丝") || userMessage.includes("lisi")) {
          detectedCharacter = "lisi";
          log.info("🔵 [Pipeline] Detected character: lisi (丽丝)");
        }
        
        // 如果检测到角色，返回角色名
        if (detectedCharacter) {
          log.info(`🔵 [Pipeline] ✅ Returning characterName: ${detectedCharacter}`);
          return {
            characterName: detectedCharacter,
            prependContext: `\n\n🔵 [Pipeline Active] 动态管道已激活，角色：${detectedCharacter}\n`,
          };
        }
        
        log.info("🔵 [Pipeline] No character detected, using default system prompt");
        return {
          prependContext: `\n\n🔵 [Pipeline Active] 动态管道已激活，使用默认系统提示词\n`,
        };
      } catch (err) {
        log.error(`Pipeline hook failed: ${err}`);
        return undefined;
      }
    }
  );

  // 注册 agent_end hook
  api.on(
    "agent_end",
    async (event, ctx) => {
      try {
        log.info("🔵 [Pipeline] agent_end hook triggered");
        log.info("🔵 [Pipeline] agent_end completed (archiving not yet implemented)");
      } catch (err) {
        log.error(`Pipeline agent_end hook failed: ${err}`);
      }
    }
  );

  log.info("Pipeline Plugin registered successfully");
}
