/**
 * 能力池 - 注册所有可用能力供 LLM 动态选择
 *
 * 设计原则：
 * 1. 复用现有代码，不重复造轮子
 * 2. 每个能力都有自然语言描述，供 LLM 理解
 * 3. 能力可以动态注册和扩展
 *
 * @module agents/pipeline/capability-pool
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  Capability,
  CapabilityDescription,
  CapabilityExecuteParams,
  PipelineContext,
} from "./types.js";

// 复用现有组件
import { createMemoryService, resolveMemoryServiceConfig } from "../memory/service.js";
import type { IMemoryService } from "../memory/types.js";
import { generateSessionSummary, formatSessionSummary } from "../session-summary.js";

// 使用新的角色服务
import { getCharacterService } from "./characters/character-service.js";

const log = createSubsystemLogger("pipeline:capability");

/**
 * 能力池
 */
export class CapabilityPool {
  private capabilities = new Map<string, Capability>();

  /**
   * 注册能力
   */
  register(capability: Capability): void {
    this.capabilities.set(capability.name, capability);
    log.debug(`Registered capability: ${capability.name}`);
  }

  /**
   * 获取能力
   */
  get(name: string): Capability | undefined {
    return this.capabilities.get(name);
  }

  /**
   * 获取所有能力描述（给 LLM 看的）
   */
  getDescriptions(): CapabilityDescription[] {
    return Array.from(this.capabilities.values()).map((c) => ({
      name: c.name,
      description: c.description,
      useCases: c.useCases,
      parameters: c.parameters,
    }));
  }

  /**
   * 执行能力
   */
  async execute(name: string, params: CapabilityExecuteParams): Promise<unknown> {
    const capability = this.capabilities.get(name);
    if (!capability) {
      throw new Error(`Capability not found: ${name}`);
    }
    log.debug(`Executing capability: ${name}`, { params: params.params });
    const started = Date.now();
    try {
      const result = await capability.execute(params);
      log.debug(`Capability ${name} completed in ${Date.now() - started}ms`);
      return result;
    } catch (err) {
      log.error(`Capability ${name} failed: ${err}`);
      throw err;
    }
  }

  /**
   * 获取所有已注册的能力名称
   */
  getCapabilityNames(): string[] {
    return Array.from(this.capabilities.keys());
  }
}

/**
 * 创建能力池的配置
 */
export interface CreateCapabilityPoolConfig {
  agentId: string;
  sessionId: string;
  userId?: string;
  config: ClawdbotConfig;
}

/**
 * 创建默认能力池，注册所有已实现的能力
 *
 * 复用现有组件：
 * - MemoryService (src/agents/memory/service.ts)
 * - CharacterService (src/agents/pipeline/characters/character-service.ts)
 * - generateSessionSummary (src/agents/session-summary.ts)
 */
export function createDefaultCapabilityPool(poolConfig: CreateCapabilityPoolConfig): CapabilityPool {
  const pool = new CapabilityPool();

  // ========== 记忆服务能力（复用 MemoryService） ==========

  const memoryConfig = resolveMemoryServiceConfig(poolConfig.config, poolConfig.agentId);
  let memoryService: IMemoryService | null = null;

  if (memoryConfig) {
    memoryService = createMemoryService(memoryConfig, poolConfig.config);

    // 记忆检索能力
    pool.register({
      name: "memory_retriever",
      description:
        "从长期记忆系统中检索相关的对话记忆、会话总结或重要信息。这些记忆可以帮助理解用户的历史偏好、之前的对话内容和关系状态。",
      useCases: [
        "在角色扮演前检索之前与该角色的对话记忆",
        "在执行任务前检索相关的经验教训和最佳实践",
        "在回答问题时检索相关的知识记忆",
        "了解用户的历史偏好和习惯",
      ],
      parameters: {
        query: "检索关键词，通常使用用户消息的关键内容",
        maxResults: "最大结果数，默认 5",
        minScore: "最小相关性分数（0-1），默认 0.7",
      },
      execute: async (execParams) => {
        if (!memoryService) return { memories: [], formattedContext: "" };

        const query = (execParams.params.query as string) || execParams.context.userMessage;

        return memoryService.retrieve({
          query,
          context: {
            userId: execParams.context.userId ?? "default",
            sessionId: execParams.context.sessionId,
            agentId: execParams.context.agentId,
          },
          params: {
            maxResults: execParams.params.maxResults as number | undefined,
            minScore: execParams.params.minScore as number | undefined,
          },
        });
      },
    });

    // 记忆归档能力
    pool.register({
      name: "memory_archiver",
      description:
        "将对话总结归档到长期记忆系统，以便将来检索。应该在重要对话结束后调用，保存关键信息和决策。",
      useCases: [
        "对话结束后归档重要内容",
        "保存任务执行经验和教训",
        "记录关键决策和原因",
        "保存与角色的互动记忆",
      ],
      parameters: {
        importance: "重要性（1-10），决定归档优先级",
        characterDir: "归档到角色专属目录（可选）",
      },
      execute: async (execParams) => {
        if (!memoryService) return { archived: false };

        // 使用前序结果中的会话总结，或者生成新的
        const existingSummary = execParams.previousResults.session_summarizer;
        const summary =
          existingSummary || generateSessionSummary(execParams.context.conversationHistory);

        if (!summary) return { archived: false };

        return memoryService.archive({
          summary: summary as Parameters<IMemoryService["archive"]>[0]["summary"],
          context: {
            userId: execParams.context.userId ?? "default",
            sessionId: execParams.context.sessionId,
            agentId: execParams.context.agentId,
          },
        });
      },
    });
  }

  // ========== 人格加载能力（使用 CharacterService） ==========

  const characterService = getCharacterService();

  pool.register({
    name: "personality_loader",
    description:
      "加载角色的完整配置：人格设定、背景故事、说话风格、能力、知识库、核心记忆等。用于角色扮演时让 AI 扮演特定角色。系统人格（栗娜）等同于整个系统。",
    useCases: [
      "角色扮演前加载角色人格（如丽丝、栗娜等）",
      "需要特定角色风格回复时",
      "系统人格化（栗娜）需要访问系统能力时",
      "加载角色的知识库和核心记忆",
    ],
    parameters: {
      character: "角色ID（如 lina, lisi）",
      loadKnowledge: "是否加载知识库，默认 true",
      loadCoreMemories: "是否加载核心记忆，默认 true",
    },
    execute: async (execParams) => {
      const characterName = execParams.params.character as string;
      if (!characterName) return null;

      try {
        // 使用 CharacterService 加载完整角色信息
        const loaded = await characterService.loadCharacter(characterName);
        if (!loaded) {
          log.warn(`Character not found: ${characterName}`);
          return null;
        }

        return {
          config: loaded.config,
          profile: loaded.profile,
          knowledge: loaded.knowledge,
          memories: loaded.memories,
          systemPrompt: loaded.formattedSystemPrompt,
          isSystemPersona: loaded.isSystemPersona,
          enabledFeatures: loaded.config.features,
          formattedPrompt: loaded.formattedSystemPrompt,
          characterDir: loaded.characterDir,
        };
      } catch (err) {
        log.warn(`Failed to load personality for ${characterName}: ${err}`);
        return null;
      }
    },
  });

  // ========== 角色记忆归档能力 ==========

  pool.register({
    name: "character_memory_archiver",
    description:
      "将会话归档到角色专属的记忆目录。每个角色都有独立的记忆空间。",
    useCases: [
      "与角色对话后归档会话内容",
      "保存与角色的互动记忆",
      "更新角色的核心记忆",
    ],
    parameters: {
      character: "角色ID",
      sessionId: "会话ID",
      summary: "会话总结",
      updateCoreMemories: "是否更新核心记忆，默认 false",
      coreMemoryContent: "核心记忆内容（如果 updateCoreMemories 为 true）",
    },
    execute: async (execParams) => {
      const characterName = execParams.params.character as string;
      const sessionId = (execParams.params.sessionId as string) || execParams.context.sessionId;
      const summary = execParams.params.summary as string || "（无总结）";
      const updateCoreMemories = execParams.params.updateCoreMemories as boolean;
      const coreMemoryContent = execParams.params.coreMemoryContent as string;

      if (!characterName) return { archived: false, reason: "No character specified" };

      try {
        // 归档会话
        await characterService.archiveSession(characterName, sessionId, summary);

        // 如果需要，更新核心记忆
        if (updateCoreMemories && coreMemoryContent) {
          await characterService.updateCoreMemories(characterName, coreMemoryContent, true);
        }

        return { archived: true, character: characterName, sessionId };
      } catch (err) {
        log.warn(`Failed to archive to character ${characterName}: ${err}`);
        return { archived: false, reason: String(err) };
      }
    },
  });

  // ========== 会话总结能力（复用 generateSessionSummary） ==========

  pool.register({
    name: "session_summarizer",
    description: "生成当前对话的总结，提取任务目标、关键操作、重要决策等信息。",
    useCases: [
      "对话结束后生成总结用于归档",
      "提取对话中的关键决策和任务",
      "为长对话生成中间总结",
    ],
    parameters: {},
    execute: async (execParams) => {
      const summary = generateSessionSummary(execParams.context.conversationHistory);
      if (!summary) return null;

      return {
        summary,
        formattedText: formatSessionSummary(summary),
      };
    },
  });

  // ========== 关键内容提取能力 ==========

  pool.register({
    name: "key_content_extractor",
    description: "从对话中提取关键信息，如用户情绪、重要事件、决策点、待办事项等。",
    useCases: [
      "角色扮演后提取用户情绪和角色反应",
      "任务完成后提取关键决策",
      "提取对话中的待办事项",
    ],
    parameters: {
      extractTypes:
        "要提取的类型，可选：emotion（情绪）, event（事件）, decision（决策）, todo（待办）",
    },
    execute: async (execParams) => {
      // 基于规则的简单提取（后续可以改为 LLM 提取）
      const messages = execParams.context.conversationHistory;
      const lastUserMessage = messages.filter((m) => m.role === "user").pop();

      const result: Record<string, unknown> = {};

      // 简单的情绪检测
      const userText =
        typeof lastUserMessage?.content === "string"
          ? lastUserMessage.content
          : Array.isArray(lastUserMessage?.content)
            ? lastUserMessage.content
                .filter((c): c is { type: "text"; text: string } => c?.type === "text")
                .map((c) => c.text)
                .join(" ")
            : "";

      if (userText.includes("累") || userText.includes("疲惫")) {
        result.emotion = "疲惫";
      } else if (userText.includes("开心") || userText.includes("高兴")) {
        result.emotion = "开心";
      } else if (userText.includes("难过") || userText.includes("伤心")) {
        result.emotion = "难过";
      }

      return result;
    },
  });

  // ========== 关系更新能力（占位，后续实现） ==========

  pool.register({
    name: "relationship_updater",
    description: "更新用户与角色的关系状态，如亲密度、好感度等。",
    useCases: ["角色扮演后更新亲密度", "记录重要互动事件", "追踪关系发展"],
    parameters: {
      character: "角色名称",
      intimacyDelta: "亲密度变化值（正数增加，负数减少）",
      event: "触发更新的事件描述",
    },
    execute: async (execParams) => {
      // 占位实现，后续接入关系系统
      log.debug("relationship_updater called", { params: execParams.params });
      return { updated: true, note: "Relationship system not yet implemented" };
    },
  });

  log.info(`CapabilityPool initialized with ${pool.getCapabilityNames().length} capabilities`);

  return pool;
}


