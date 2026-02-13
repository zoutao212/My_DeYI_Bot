/**
 * 动态管道插件
 *
 * 通过 hook 机制集成到现有的 runEmbeddedAttempt 流程
 *
 * 设计原则：
 * 1. 复用现有 hook 机制，最小改动
 * 2. 在 before_agent_start 执行前置处理
 * 3. 在 agent_end 执行后置处理
 *
 * @module agents/pipeline/plugin
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { loadConfig, type ClawdbotConfig } from "../../config/config.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookAgentEndEvent,
} from "../../plugins/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createDefaultCapabilityPool } from "./capability-pool.js";
import { createIntentAnalyzer } from "./intent-analyzer.js";
import type { CapabilityExecuteParams, PipelineContext, PipelineState } from "./types.js";
import { detectChatRoomIntent, handleChatRoomMessage, closeChatRoom, hasActiveSession } from "../chatroom/index.js";

const log = createSubsystemLogger("pipeline:plugin");

/**
 * 动态管道插件状态（按 sessionKey 存储）
 */
const pipelineStates = new Map<string, PipelineState>();

/**
 * 检查是否应该启用动态管道
 *
 * 注意：不依赖 sessionKey 前缀！
 * 角色识别由 LLM 从用户消息中动态分析
 */
function shouldEnablePipeline(config: ClawdbotConfig): boolean {
  const pipelineConfig = (config as Record<string, unknown>).agents as
    | Record<string, unknown>
    | undefined;
  const dynamicPipeline = pipelineConfig?.dynamicPipeline as Record<string, unknown> | undefined;
  return dynamicPipeline?.enabled === true;
}

/**
 * 获取配置
 */
function getConfig(): ClawdbotConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

/**
 * before_agent_start hook 处理器
 *
 * 职责：
 * 1. 分析用户意图，从消息中识别角色
 * 2. 执行前置处理（记忆检索、人格加载等）
 * 3. 返回完整的 system prompt（包含角色人格）
 */
export async function onBeforeAgentStart(
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeAgentStartResult | void> {
  const config = getConfig();
  if (!config || !shouldEnablePipeline(config)) {
    return;
  }

  const started = Date.now();
  const stateKey = ctx.sessionKey ?? ctx.agentId ?? "default";
  log.info(`[Pipeline] Starting pre-process for session: ${stateKey}`);

  const agentId = ctx.agentId ?? "main";

  try {
    // 1. 创建管道上下文
    const pipelineContext: PipelineContext = {
      userMessage: event.prompt,
      conversationHistory: (event.messages as AgentMessage[]) || [],
      sessionId: stateKey,
      sessionKey: ctx.sessionKey,
      agentId,
      userId: undefined,
      config,
    };

    // 2. 创建能力池
    const capabilityPool = createDefaultCapabilityPool({
      agentId,
      sessionId: stateKey,
      userId: undefined,
      config,
    });

    // 3. 创建意图分析器并分析
    const intentAnalyzer = createIntentAnalyzer({ config, sessionKey: ctx.sessionKey });
    const { plan, detectedCharacter } = await intentAnalyzer.analyze({
      userMessage: event.prompt,
      context: pipelineContext,
      capabilities: capabilityPool.getDescriptions(),
    });

    log.info(`[Pipeline] Intent: ${plan.intentDescription}`);
    if (detectedCharacter) {
      log.info(
        `[Pipeline] Detected character: ${detectedCharacter.name} (${detectedCharacter.id})`,
      );
    }

    // 3.5 🆕 聊天室检测：检查是否触发多角色聊天室模式
    const characterConfigs = intentAnalyzer.getCharacterConfigs();
    if (characterConfigs) {
      const sessionActive = hasActiveSession(stateKey);
      const chatRoomResult = detectChatRoomIntent(event.prompt, characterConfigs, sessionActive);

      if (chatRoomResult.triggerType === "exit" && sessionActive) {
        // 退出聊天室
        const messages: string[] = [];
        await closeChatRoom(stateKey, async (text) => { messages.push(text); });
        log.info(`[Pipeline] 聊天室已关闭: ${stateKey}`);
        return {
          chatRoomHandled: { responseText: messages.join("\n\n") },
        };
      }

      if (chatRoomResult.isChatRoomMode) {
        // 进入聊天室模式：运行编排器，收集所有输出
        const messages: string[] = [];
        const collectReply = async (text: string) => { messages.push(text); };

        await handleChatRoomMessage(
          {
            userMessage: event.prompt,
            participants: chatRoomResult.participants,
            sessionKey: stateKey,
            sendReply: collectReply,
            callStrategy: "staggered",
            interactionMode: chatRoomResult.interactionMode ?? null,
            agentSessionKey: ctx.sessionKey,
          },
          config,
        );

        log.info(
          `[Pipeline] 聊天室响应完成: participants=${chatRoomResult.participants.join(",")}, ` +
          `messages=${messages.length}, triggerType=${chatRoomResult.triggerType}`,
        );

        return {
          chatRoomHandled: { responseText: messages.join("\n\n") },
        };
      }
    }

    // 4. 执行前置处理（记忆检索等，但不加载人格 - 让 buildEmbeddedSystemPrompt 处理）
    const preProcessResults: Record<string, unknown> = {};
    const contextParts: string[] = [];

    for (const call of plan.pipeline.preProcess) {
      try {
        // 🆕 跳过人格加载（让 buildEmbeddedSystemPrompt 处理）
        if (call.capability === "personality_loader") {
          log.debug(`[Pipeline] Skipping personality_loader (will be handled by buildEmbeddedSystemPrompt)`);
          continue;
        }

        const execParams: CapabilityExecuteParams = {
          params: call.params,
          context: pipelineContext,
          previousResults: preProcessResults,
        };

        const result = await capabilityPool.execute(call.capability, execParams);
        preProcessResults[call.capability] = result;

        // 构建上下文注入（记忆等）
        if (call.capability === "memory_retriever" && result) {
          const memResult = result as { formattedContext?: string };
          if (memResult.formattedContext) {
            contextParts.push(`## 相关记忆\n\n${memResult.formattedContext}`);
          }
        }

        log.debug(`[Pipeline] Pre-process ${call.capability} completed`);
      } catch (err) {
        log.warn(`[Pipeline] Pre-process ${call.capability} failed: ${err}`);
      }
    }

    // 5. 保存状态，供 agent_end 使用
    pipelineStates.set(stateKey, {
      plan,
      preProcessResults,
      detectedCharacter,
      startTime: started,
    });

    // 6. 返回结果
    const prependContext = contextParts.length > 0 ? contextParts.join("\n\n") : undefined;

    log.info(
      `[Pipeline] Pre-process completed in ${Date.now() - started}ms`,
    );

    // 🆕 返回识别到的角色名（让 buildEmbeddedSystemPrompt 加载人格）
    return {
      characterName: detectedCharacter?.id,  // 🆕 传递角色名
      prependContext,  // 记忆上下文
    };
  } catch (err) {
    log.error(`[Pipeline] Pre-process failed: ${err}`);
    return;
  }
}

/**
 * agent_end hook 处理器
 *
 * 职责：
 * 1. 执行后置处理（记忆归档、关系更新等）
 * 2. 清理状态
 */
export async function onAgentEnd(
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  const stateKey = ctx.sessionKey ?? ctx.agentId ?? "default";
  const state = pipelineStates.get(stateKey);

  if (!state) {
    return;
  }

  const config = getConfig();
  if (!config) {
    pipelineStates.delete(stateKey);
    return;
  }

  log.info(`[Pipeline] Starting post-process for session: ${stateKey}`);

  const agentId = ctx.agentId ?? "main";

  try {
    // 1. 创建管道上下文
    const pipelineContext: PipelineContext = {
      userMessage: "",
      conversationHistory: (event.messages as AgentMessage[]) || [],
      sessionId: stateKey,
      sessionKey: ctx.sessionKey,
      agentId,
      userId: undefined,
      config,
    };

    // 2. 创建能力池
    const capabilityPool = createDefaultCapabilityPool({
      agentId,
      sessionId: stateKey,
      userId: undefined,
      config,
    });

    // 3. 执行后置处理
    for (const call of state.plan.pipeline.postProcess) {
      try {
        const execParams: CapabilityExecuteParams = {
          params: call.params,
          context: pipelineContext,
          previousResults: {
            ...state.preProcessResults,
            response: event.messages?.[event.messages.length - 1],
          },
        };

        await capabilityPool.execute(call.capability, execParams);
        log.debug(`[Pipeline] Post-process ${call.capability} completed`);
      } catch (err) {
        log.warn(`[Pipeline] Post-process ${call.capability} failed: ${err}`);
      }
    }

    const totalDuration = Date.now() - state.startTime;
    log.info(`[Pipeline] Post-process completed. Total pipeline duration: ${totalDuration}ms`);
  } catch (err) {
    log.error(`[Pipeline] Post-process failed: ${err}`);
  } finally {
    // 4. 清理状态
    pipelineStates.delete(stateKey);
  }
}

/**
 * 导出插件定义
 */
export const pipelinePlugin = {
  id: "clawdbot-pipeline",
  name: "Dynamic Pipeline Plugin",
  version: "1.0.0",
  hooks: [
    {
      hookName: "before_agent_start" as const,
      handler: onBeforeAgentStart,
      priority: 100, // 高优先级，确保先执行
    },
    {
      hookName: "agent_end" as const,
      handler: onAgentEnd,
      priority: 100,
    },
  ],
};

/**
 * 获取当前管道状态（用于调试）
 */
export function getPipelineState(sessionKey: string): PipelineState | undefined {
  return pipelineStates.get(sessionKey);
}

/**
 * 清除所有管道状态（用于测试）
 */
export function clearAllPipelineStates(): void {
  pipelineStates.clear();
}

