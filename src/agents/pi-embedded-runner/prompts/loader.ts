/**
 * 提示词加载器
 * 
 * 根据层次加载对应的 System Prompt
 */

import type { AgentLayer } from "../../multi-layer/types.js";
import type { CharacterProfile } from "../../virtual-world/character-profiles.js";
import { buildVirtualWorldPrompt, estimateVirtualWorldPromptTokens } from "./virtual-world.js";
import { buildButlerPrompt, estimateButlerPromptTokens } from "./butler.js";
import { buildExecutionPrompt, estimateExecutionPromptTokens } from "./execution.js";

/**
 * 提示词加载器配置
 */
export interface PromptLoaderConfig {
  /** 是否启用缓存 */
  enableCache?: boolean;
  /** 是否启用 token 估算 */
  enableTokenEstimation?: boolean;
}

/**
 * 提示词加载结果
 */
export interface PromptLoadResult {
  /** System Prompt 内容 */
  prompt: string;
  /** 层次 */
  layer: AgentLayer;
  /** Token 估算（如果启用） */
  estimatedTokens?: number;
}

/**
 * 提示词加载器
 */
export class PromptLoader {
  private cache: Map<string, string> = new Map();
  private config: PromptLoaderConfig;

  constructor(config?: PromptLoaderConfig) {
    this.config = {
      enableCache: true,
      enableTokenEstimation: true,
      ...config,
    };
  }

  /**
   * 加载 System Prompt
   */
  load(layer: AgentLayer, options?: { characterProfile?: CharacterProfile }): PromptLoadResult {
    // 1. 检查缓存
    const cacheKey = this.getCacheKey(layer, options);
    if (this.config.enableCache && this.cache.has(cacheKey)) {
      const prompt = this.cache.get(cacheKey)!;
      return {
        prompt,
        layer,
        estimatedTokens: this.config.enableTokenEstimation
          ? this.estimateTokens(layer, prompt, options)
          : undefined,
      };
    }

    // 2. 构建 System Prompt
    const prompt = this.buildPrompt(layer, options);

    // 3. 缓存结果
    if (this.config.enableCache) {
      this.cache.set(cacheKey, prompt);
    }

    // 4. 返回结果
    return {
      prompt,
      layer,
      estimatedTokens: this.config.enableTokenEstimation
        ? this.estimateTokens(layer, prompt, options)
        : undefined,
    };
  }

  /**
   * 构建 System Prompt
   */
  private buildPrompt(
    layer: AgentLayer,
    options?: { characterProfile?: CharacterProfile },
  ): string {
    switch (layer) {
      case "virtual-world":
        if (!options?.characterProfile) {
          throw new Error("Character profile is required for virtual-world layer");
        }
        return buildVirtualWorldPrompt(options.characterProfile);

      case "butler":
        return buildButlerPrompt();

      case "execution":
        return buildExecutionPrompt();

      default:
        throw new Error(`Unknown layer: ${layer}`);
    }
  }

  /**
   * 估算 token 数量
   */
  private estimateTokens(
    layer: AgentLayer,
    prompt: string,
    options?: { characterProfile?: CharacterProfile },
  ): number {
    switch (layer) {
      case "virtual-world":
        if (!options?.characterProfile) {
          return Math.ceil(prompt.length * 1.5);
        }
        return estimateVirtualWorldPromptTokens(options.characterProfile);

      case "butler":
        return estimateButlerPromptTokens();

      case "execution":
        return estimateExecutionPromptTokens();

      default:
        return Math.ceil(prompt.length * 1.5);
    }
  }

  /**
   * 获取缓存键
   */
  private getCacheKey(layer: AgentLayer, options?: { characterProfile?: CharacterProfile }): string {
    if (layer === "virtual-world" && options?.characterProfile) {
      return `${layer}:${options.characterProfile.name}`;
    }
    return layer;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
