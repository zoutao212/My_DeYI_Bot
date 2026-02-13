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
import type { CharacterRecognitionConfig, PipelineContext } from "./types.js";
import { detectChatRoomIntent, handleChatRoomMessage, closeChatRoom, hasActiveSession } from "../chatroom/index.js";
import { loadConfig } from "../../config/config.js";
import { analyzeIntentComplexity, buildComplexityGuidance } from "../intelligent-task-decomposition/intent-complexity-analyzer.js";

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
        log.info(`🔵 [Pipeline] User message: ${event.prompt?.slice(0, 150)}...`);
        log.info(`🔵 [Pipeline] metadata.isQueueTask: ${event.metadata?.isQueueTask}`);
        
        // 🔧 获取用户消息
        const userMessage = event.prompt || "";
        
        // 🔧 检测是否是原始用户消息在队列中
        const isOriginalUserMessageInQueue = userMessage.includes("[message_id:");
        
        // 🔧 检测是否是队列任务
        const isQueueTask = event.metadata?.isQueueTask === true;
        
        if (isQueueTask) {
          log.info("🔵 [Pipeline] ⚠️ Detected queue task (from metadata), will still perform character detection");
        }
        
        if (isOriginalUserMessageInQueue) {
          log.info("🔵 [Pipeline] ⚠️ Detected original user message in queue, will still perform character detection");
        }

        // ── 聊天室检测（优先级最高，在单角色检测之前） ──
        const characterConfigs = getBuiltinCharacterConfigs();
        const stateKey = ctx.sessionKey ?? ctx.agentId ?? "default";
        const sessionActive = hasActiveSession(stateKey);
        const chatRoomResult = detectChatRoomIntent(userMessage, characterConfigs, sessionActive);

        // 退出聊天室
        if (chatRoomResult.triggerType === "exit" && sessionActive) {
          const messages: string[] = [];
          await closeChatRoom(stateKey, async (text) => { messages.push(text); });
          log.info(`🔵 [Pipeline] 聊天室已关闭: ${stateKey}`);
          return {
            chatRoomHandled: { responseText: messages.join("\n\n") },
          };
        }

        // 进入/延续聊天室模式
        if (chatRoomResult.isChatRoomMode) {
          log.info(
            `🔵 [Pipeline] 🏠 聊天室模式触发: participants=${chatRoomResult.participants.join(",")}, ` +
            `triggerType=${chatRoomResult.triggerType}`,
          );

          // ── 🧠 复杂任务智能路由：聊天室协作模式 ──
          // 预分析用户意图复杂度，复杂任务触发三阶段协作流程（不退出聊天室）
          let complexityHint = "";
          let collaborativeTaskMode = false;
          let collaborativeContext: import("../chatroom/types.js").CollaborativeTaskContext | undefined;
          try {
            let _crConfig;
            try { _crConfig = loadConfig(); } catch { /* 静默 */ }
            const complexityResult = await analyzeIntentComplexity(userMessage, _crConfig ?? undefined);
            if (complexityResult.strategy === "force_decompose") {
              // 高复杂度任务：触发聊天室协作模式（规划→执行→互检）
              collaborativeTaskMode = true;
              collaborativeContext = {
                workspaceDir: ctx.workspaceDir ?? "",
                sessionKey: ctx.sessionKey ?? stateKey,
                agentId: ctx.agentId,
                messageProvider: ctx.messageProvider,
                config: _crConfig ?? undefined,
                complexityReason: complexityResult.reason,
              };
              // 从 config 中提取 provider/model
              if (_crConfig) {
                const agentDefaults = (_crConfig as Record<string, any>)?.agents?.defaults;
                collaborativeContext.provider = agentDefaults?.provider;
                collaborativeContext.model = agentDefaults?.model?.id;
              }
              log.info(
                `🔵 [Pipeline] 🤝 复杂任务检测 (complexity=${complexityResult.complexity}): ` +
                `触发聊天室协作模式（规划→执行→互检）`,
              );
            }
            // 中等复杂度：仍进入聊天室，但注入复杂度感知提示
            if (complexityResult.strategy === "suggest_decompose") {
              complexityHint =
                `[🧠 任务提示] 此任务具有一定复杂度（${complexityResult.complexity}）。` +
                `如果你认为需要更深入的处理，可以建议主人将任务单独交给你或姐妹中的一位全权处理，` +
                `以便调用任务分解(enqueue_task)等高级能力。\n` +
                (complexityResult.reason ? `分析：${complexityResult.reason}` : "");
              log.info(
                `🔵 [Pipeline] 🧠 中等复杂度任务 (${complexityResult.complexity}): 注入 complexityHint 到聊天室`,
              );
            }
          } catch (err) {
            log.warn(`🔵 [Pipeline] 🧠 复杂度预判异常，跳过: ${err}`);
          }

          const messages: string[] = [];
          const collectReply = async (text: string) => { messages.push(text); };
          let config;
          try { config = loadConfig(); } catch { /* 静默 */ }

          await handleChatRoomMessage(
            {
              userMessage,
              participants: chatRoomResult.participants,
              sessionKey: stateKey,
              sendReply: collectReply,
              callStrategy: collaborativeTaskMode ? "sequential" : "staggered",
              interactionMode: chatRoomResult.interactionMode ?? null,
              agentSessionKey: ctx.sessionKey,
              complexityHint: complexityHint || undefined,
              collaborativeTaskMode,
              collaborativeContext,
            },
            config ?? undefined,
          );

          log.info(
            `🔵 [Pipeline] 聊天室响应完成: messages=${messages.length}`,
          );
          return {
            chatRoomHandled: { responseText: messages.join("\n\n") },
          };
        }

        // ── 单角色识别（聊天室未触发时回退到此） ──
        let detectedCharacter: string | undefined;
        
        // 检测是否提到栗娜
        if (userMessage.includes("栗娜") || userMessage.includes("琳娜") || userMessage.includes("lina")) {
          detectedCharacter = "lina";
          log.info("🔵 [Pipeline] Detected character: lina (栗娜)");
        }
        // 检测是否提到德默泽尔
        else if (userMessage.includes("德默泽尔") || userMessage.includes("德姨") || userMessage.includes("demerzel") || userMessage.includes("爱姬") || userMessage.includes("机械姬")) {
          detectedCharacter = "demerzel";
          log.info("🔵 [Pipeline] Detected character: demerzel (德默泽尔)");
        }
        // 检测是否提到德洛丽丝
        else if (userMessage.includes("德洛丽丝") || userMessage.includes("多莉") || userMessage.includes("dolores") || userMessage.includes("德妹") || userMessage.includes("Dolly")) {
          detectedCharacter = "dolores";
          log.info("🔵 [Pipeline] Detected character: dolores (德洛丽丝)");
        }
        // 检测是否提到丽丝
        else if (userMessage.includes("丽丝") || userMessage.includes("lisi")) {
          detectedCharacter = "lisi";
          log.info("🔵 [Pipeline] Detected character: lisi (丽丝)");
        }
        
        // 如果检测到角色，返回角色名
        if (detectedCharacter) {
          log.info(`🔵 [Pipeline] ✅ Returning characterName: ${detectedCharacter}`);

          // ── 🧠 系统化身能力感知注入 ──
          // 三位系统化身拥有完整的系统能力，注入能力清单让 LLM 知道可以使用
          const SYSTEM_PERSONAS = new Set(["lina", "demerzel", "dolores", "lisi"]);
          let capabilityNote = "";
          if (SYSTEM_PERSONAS.has(detectedCharacter)) {
            capabilityNote =
              `\n\n## 🔧 系统能力（按需使用）\n` +
              `你是系统的人格化身，拥有以下高级能力：\n` +
              `- **enqueue_task**：当任务复杂（多步骤/长文本创作/大规模分析）时，使用智能任务分解系统。` +
              `系统会自动构建任务树、并行执行子任务、质量评估、合并产出。\n` +
              `- **记忆系统**：memory_search/write/update/delete/list/deep_search/patch — 完整的记忆 CRUD 能力\n` +
              `- **continue_generation**：单次回复无法完成时，调用续传工具分批输出\n` +
              `- **文件操作**：read/write/edit/exec/process — 完整文件系统访问\n` +
              `- **Web 能力**：web_search/web_fetch/browser — 互联网搜索和浏览\n` +
              `- **技能系统**：可调用已注册的各种技能（Skill）\n` +
              `\n💡 判断准则：当用户请求涉及多个步骤、长文本生成(>2000字)、多文件操作、` +
              `大规模数据分析时，优先使用 enqueue_task 进行任务分解。`;
          }

          return {
            characterName: detectedCharacter,
            prependContext: `\n\n🔵 [Pipeline Active] 动态管道已激活，角色：${detectedCharacter}${capabilityNote}\n`,
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

// ============================================================================
// 内置角色识别配置（供聊天室检测器使用）
// ============================================================================

/** 缓存，避免每次请求重建 */
let _builtinCharConfigs: CharacterRecognitionConfig[] | null = null;

/**
 * 获取内置角色识别配置列表
 *
 * 与 plugin.ts 中 IntentAnalyzer 的硬编码回退一致，
 * 确保聊天室检测器能识别所有已知角色。
 */
function getBuiltinCharacterConfigs(): CharacterRecognitionConfig[] {
  if (_builtinCharConfigs) return _builtinCharConfigs;
  _builtinCharConfigs = [
    {
      id: "lina",
      displayName: "琳娜",
      isSystemPersona: true,
      recognition: {
        names: ["栗娜", "lina", "linna", "莉娜", "琳娜", "管家"],
        triggers: ["帮我", "安排", "提醒", "记住", "日程", "待办", "任务"],
        contexts: ["任务", "日程", "待办", "记忆", "提醒"],
      },
    },
    {
      id: "demerzel",
      displayName: "德默泽尔",
      isSystemPersona: true,
      recognition: {
        names: ["德默泽尔", "德姨", "demerzel", "爱姬01号", "机械姬"],
        triggers: ["德默泽尔", "01号"],
        contexts: ["爱姬", "资产", "克隆", "丝袜", "泌乳", "场景"],
      },
    },
    {
      id: "dolores",
      displayName: "德洛丽丝",
      isSystemPersona: true,
      recognition: {
        names: ["德洛丽丝", "dolores", "爱姬02号", "多莉", "Dolly", "德妹", "Lola"],
        triggers: ["德洛丽丝", "多莉", "02号"],
        contexts: ["爱姬", "资产", "克隆", "丝袜", "泌乳", "场景", "西部世界", "接待员"],
      },
    },
  ];
  return _builtinCharConfigs;
}
