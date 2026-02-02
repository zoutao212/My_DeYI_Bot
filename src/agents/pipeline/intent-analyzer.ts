/**
 * LLM 驱动的意图分析器
 *
 * 核心职责：
 * 1. 分析用户消息，理解用户意图（不预设类型）
 * 2. 从用户消息中动态识别角色
 * 3. 根据意图选择需要的能力
 * 4. 组装执行管道
 *
 * @module agents/pipeline/intent-analyzer
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  CapabilityDescription,
  CharacterRecognitionConfig,
  DetectedCharacter,
  ExecutionPlan,
  PipelineContext,
} from "./types.js";
import { getCharacterService } from "./characters/character-service.js";

const log = createSubsystemLogger("pipeline:intent");

/**
 * 意图分析器配置
 */
export interface IntentAnalyzerConfig {
  config: ClawdbotConfig;
  sessionKey?: string;
}

/**
 * 分析参数
 */
export interface AnalyzeParams {
  userMessage: string;
  context: PipelineContext;
  capabilities: CapabilityDescription[];
}

/**
 * 分析结果
 */
export interface AnalyzeResult {
  plan: ExecutionPlan;
  detectedCharacter?: DetectedCharacter;
}

/**
 * 意图分析器
 *
 * 设计原则：
 * 1. 不预设意图类型，让 LLM 自由分析
 * 2. 从用户消息中动态识别角色
 * 3. 基于能力描述让 LLM 选择合适的能力
 * 4. 返回完整的执行计划
 */
export class IntentAnalyzer {
  private characterConfigs: CharacterRecognitionConfig[] | null = null;

  constructor(private readonly analyzerConfig: IntentAnalyzerConfig) {}

  /**
   * 分析用户意图并生成执行计划
   *
   * 这是动态管道的核心：LLM 自己决定如何处理用户请求
   */
  async analyze(params: AnalyzeParams): Promise<AnalyzeResult> {
    const { userMessage, capabilities } = params;

    // 加载角色识别配置
    const characters = await this.loadCharacterRecognitionConfig();

    // 从用户消息中识别角色
    let detectedCharacter = this.detectCharacter(userMessage, characters);

    // 如果未识别到角色，使用默认系统人格
    if (!detectedCharacter) {
      detectedCharacter = this.getDefaultCharacter(characters);
    }

    // 生成执行计划
    const plan = this.buildExecutionPlan(userMessage, capabilities, detectedCharacter, characters);

    return { plan, detectedCharacter };
  }

  /**
   * 从用户消息中检测角色
   *
   * 核心逻辑：
   * - "丽丝，我回来了" → 识别到"丽丝" → 加载丽丝人格
   * - "栗娜，帮我安排日程" → 识别到"栗娜" → 加载栗娜人格
   * - "帮我安排日程" → 识别到触发词 → 使用系统人格"栗娜"
   * - "你好" → 未识别到 → 使用默认系统人格
   */
  private detectCharacter(
    userMessage: string,
    characters: CharacterRecognitionConfig[],
  ): DetectedCharacter | undefined {
    const messageLower = userMessage.toLowerCase();

    // 1. 首先检查角色名称（最高优先级）
    for (const char of characters) {
      const foundName = char.recognition.names.find((name) =>
        messageLower.includes(name.toLowerCase()),
      );
      if (foundName) {
        return {
          id: char.id,
          name: foundName,
          isSystemPersona: char.isSystemPersona,
          matchType: "name",
        };
      }
    }

    // 2. 检查系统人格的触发词
    for (const char of characters) {
      if (char.isSystemPersona && char.recognition.triggers) {
        const foundTrigger = char.recognition.triggers.find((trigger) =>
          messageLower.includes(trigger.toLowerCase()),
        );
        if (foundTrigger) {
          return {
            id: char.id,
            name: char.displayName,
            isSystemPersona: true,
            matchType: "trigger",
          };
        }
      }
    }

    // 3. 未识别到 → 返回 undefined，后续使用默认系统人格
    return undefined;
  }

  /**
   * 构建执行计划
   */
  private buildExecutionPlan(
    userMessage: string,
    capabilities: CapabilityDescription[],
    detectedCharacter: DetectedCharacter | undefined,
    characters: CharacterRecognitionConfig[],
  ): ExecutionPlan {
    const plan: ExecutionPlan = {
      intentDescription: "",
      pipeline: {
        preProcess: [],
        coreProcess: null,
        responseGenerate: null,
        postProcess: [],
      },
    };

    // 获取有效角色（检测到的或默认系统人格）
    const effectiveCharacter = detectedCharacter || this.getDefaultCharacter(characters);

    if (effectiveCharacter) {
      // 有角色（检测到的或默认的）
      const matchDesc =
        effectiveCharacter.matchType === "name"
          ? `从消息中识别到角色名"${effectiveCharacter.name}"`
          : effectiveCharacter.matchType === "trigger"
            ? `从消息中识别到触发词，使用系统人格"${effectiveCharacter.name}"`
            : `使用默认系统人格"${effectiveCharacter.name}"`;

      plan.intentDescription = `用户与"${effectiveCharacter.name}"对话（${matchDesc}）`;

      // 前置处理：记忆检索 + 完整人格加载
      if (this.hasCapability(capabilities, "memory_retriever")) {
        plan.pipeline.preProcess.push({
          capability: "memory_retriever",
          params: {
            query: `${effectiveCharacter.name} 对话 互动`,
            sources: effectiveCharacter.isSystemPersona
              ? ["memory", "sessions", "characters", "system"]
              : ["memory", "sessions", "characters"],
          },
          reason: `检索与${effectiveCharacter.name}相关的记忆和上下文`,
        });
      }

      if (this.hasCapability(capabilities, "personality_loader")) {
        plan.pipeline.preProcess.push({
          capability: "personality_loader",
          params: {
            character: effectiveCharacter.id,
            loadKnowledge: true,
            loadCoreMemories: effectiveCharacter.matchType !== "default",
          },
          reason: `加载${effectiveCharacter.name}的完整人格配置`,
        });
      }

      // 后置处理
      if (this.hasCapability(capabilities, "key_content_extractor")) {
        plan.pipeline.postProcess.push({
          capability: "key_content_extractor",
          params: { extractTypes: "emotion,event,decision,todo" },
          reason: "提取对话中的关键信息",
        });
      }

      if (this.hasCapability(capabilities, "memory_archiver")) {
        plan.pipeline.postProcess.push({
          capability: "memory_archiver",
          params: {
            importance: effectiveCharacter.isSystemPersona ? 5 : 6,
            characterDir: `clawd/characters/${effectiveCharacter.id}/memory/sessions`,
          },
          reason: `归档对话到${effectiveCharacter.name}的记忆系统`,
        });
      }

      // 只有虚拟世界角色才更新关系
      if (
        !effectiveCharacter.isSystemPersona &&
        this.hasCapability(capabilities, "relationship_updater")
      ) {
        plan.pipeline.postProcess.push({
          capability: "relationship_updater",
          params: { character: effectiveCharacter.id, intimacyDelta: 1 },
          reason: `更新与${effectiveCharacter.name}的亲密度`,
        });
      }
    } else {
      // 完全没有角色配置（异常情况）
      plan.intentDescription = "用户进行普通对话";

      // 仅记忆检索和归档
      if (this.hasCapability(capabilities, "memory_retriever")) {
        plan.pipeline.preProcess.push({
          capability: "memory_retriever",
          params: { query: userMessage.substring(0, 100) },
          reason: "检索相关记忆作为上下文",
        });
      }

      if (this.hasCapability(capabilities, "memory_archiver")) {
        plan.pipeline.postProcess.push({
          capability: "memory_archiver",
          params: { importance: 3 },
          reason: "归档对话到记忆系统",
        });
      }
    }

    // 日志
    log.info(`[IntentAnalyzer] Intent: ${plan.intentDescription}`);
    if (effectiveCharacter) {
      log.info(
        `[IntentAnalyzer] Character: ${effectiveCharacter.name} (${effectiveCharacter.id}), ` +
          `matchType=${effectiveCharacter.matchType}, isSystemPersona=${effectiveCharacter.isSystemPersona}`,
      );
    }
    log.debug(
      `[IntentAnalyzer] Pipeline: preProcess=${plan.pipeline.preProcess.length}, ` +
        `postProcess=${plan.pipeline.postProcess.length}`,
    );

    return plan;
  }

  /**
   * 获取默认系统人格
   */
  private getDefaultCharacter(
    characters: CharacterRecognitionConfig[],
  ): DetectedCharacter | undefined {
    const defaultChar = characters.find((c) => c.isSystemPersona);
    if (defaultChar) {
      return {
        id: defaultChar.id,
        name: defaultChar.displayName,
        isSystemPersona: true,
        matchType: "default",
      };
    }
    return undefined;
  }

  /**
   * 检查能力是否存在
   */
  private hasCapability(capabilities: CapabilityDescription[], name: string): boolean {
    return capabilities.some((c) => c.name === name);
  }

  /**
   * 从 clawd/characters/ 目录动态加载所有角色的识别配置
   *
   * 使用 CharacterService 扫描目录并读取每个角色的 config.json
   */
  private async loadCharacterRecognitionConfig(): Promise<CharacterRecognitionConfig[]> {
    // 如果已加载，直接返回缓存
    if (this.characterConfigs) {
      return this.characterConfigs;
    }

    try {
      const characterService = getCharacterService();
      this.characterConfigs = await characterService.getAllRecognitionConfigs();

      // 如果没有找到任何角色配置，使用默认配置
      if (this.characterConfigs.length === 0) {
        log.warn("[IntentAnalyzer] No character configs found, initializing defaults...");

        // 尝试初始化默认角色
        await characterService.initializeCharacter("lina");
        await characterService.initializeCharacter("lisi");

        // 重新加载
        this.characterConfigs = await characterService.getAllRecognitionConfigs();
      }

      log.info(`[IntentAnalyzer] Loaded ${this.characterConfigs.length} character configs`);
    } catch (error) {
      log.error(`[IntentAnalyzer] Failed to load character configs: ${error}`);

      // 回退到硬编码配置
      this.characterConfigs = [
        {
          id: "lina",
          displayName: "栗娜",
          isSystemPersona: true,
          recognition: {
            names: ["栗娜", "lina", "莉娜", "管家"],
            triggers: ["帮我", "安排", "提醒", "记住", "日程", "待办", "任务"],
            contexts: ["任务", "日程", "待办", "记忆", "提醒"],
          },
        },
        {
          id: "lisi",
          displayName: "丽丝",
          isSystemPersona: false,
          recognition: {
            names: ["丽丝", "lisi", "莉丝"],
            triggers: [],
            contexts: [],
          },
        },
      ];
    }

    return this.characterConfigs;
  }

  /**
   * 清除角色配置缓存（当配置更新时调用）
   */
  clearCache(): void {
    this.characterConfigs = null;
    log.debug("[IntentAnalyzer] Character config cache cleared");
  }
}

/**
 * 创建意图分析器
 */
export function createIntentAnalyzer(config: IntentAnalyzerConfig): IntentAnalyzer {
  return new IntentAnalyzer(config);
}

