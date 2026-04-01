/**
 * 定义文件加载器 - Definition Loader
 *
 * 从用户目录加载 SOUL/CONTEXT/PHASE 定义文件
 * 支持多路径查找：用户目录优先，插件内置定义作为回退
 *
 * @module persona-3d-fusion/utils/definition-loader
 */

import * as path from "path";
import * as fs from "fs";
import { loadYaml } from "./yaml-loader.js";
import type { SoulDefinition, ContextDefinition, PhaseDefinition, CharacterConfig } from "../types.js";

// =============================================================================
// 常量
// =============================================================================

/** 默认用户定义目录（Windows） */
const DEFAULT_USER_DEFINITIONS_PATH = "C:\\Users\\zouta\\clawd";

/** 角色定义入口目录（相对于 clawd 根目录） */
const PERSONA_3D_FUSION_DIR = "persona-3d-fusion";

/** 通用工作指导入口目录（相对于 clawd 根目录） */
const WORKPHASES_DIR = "workphases";

/** 插件内置定义目录（相对于插件根目录） */
const PLUGIN_DEFINITIONS_PATH = "definitions";

// =============================================================================
// 定义加载器
// =============================================================================

/**
 * 定义文件加载器配置
 */
export interface DefinitionLoaderConfig {
  /** 用户定义目录（clawd 根目录） */
  userDefinitionsPath?: string;
  /** 是否启用插件内置定义作为回退 */
  enableBuiltinFallback?: boolean;
  /** 插件内置定义目录 */
  builtinDefinitionsPath?: string;
  /** 是否启用缓存 */
  enableCache?: boolean;
}

/**
 * 定义文件加载器
 *
 * 查找顺序：
 * 1. 角色专用定义：{clawd}/persona-3d-fusion/{character}/{type}s/{id}.yaml
 * 2. 通用工作指导：{clawd}/workphases/{type}s/{id}.yaml
 * 3. 插件内置：{builtinDefinitionsPath}/{type}s/{id}.yaml
 */
export class DefinitionLoader {
  private cache: Map<string, { data: unknown; timestamp: number }>;
  private userDefinitionsPath: string;
  private builtinDefinitionsPath: string;
  private enableBuiltinFallback: boolean;
  private cacheTTL: number;

  constructor(config: DefinitionLoaderConfig = {}) {
    this.cache = new Map();
    this.userDefinitionsPath = config.userDefinitionsPath || DEFAULT_USER_DEFINITIONS_PATH;
    this.enableBuiltinFallback = config.enableBuiltinFallback ?? true;

    // 插件内置定义目录（相对于插件根目录）
    this.builtinDefinitionsPath = config.builtinDefinitionsPath ||
      path.resolve(__dirname, "..", "..", PLUGIN_DEFINITIONS_PATH);
    
    this.cacheTTL = 60000; // 60 秒
  }

  /**
   * 从缓存获取数据
   */
  private getFromCache<T>(key: string, forceRefresh: boolean): T | null {
    if (forceRefresh) {
      return null;
    }
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.cacheTTL) {
      return entry.data as T;
    }
    return null;
  }

  /**
   * 设置缓存数据
   */
  private setCache(key: string, data: unknown): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * 加载角色配置
   */
  async loadCharacterConfig(characterId: string, forceRefresh = false): Promise<CharacterConfig | null> {
    const cacheKey = `character-config/${characterId}`;

    const cached = this.getFromCache<CharacterConfig>(cacheKey, forceRefresh);
    if (cached) {
      return cached;
    }

    // 尝试加载角色目录下的 config.json
    const configPath = path.join(
      this.userDefinitionsPath,
      PERSONA_3D_FUSION_DIR,
      characterId,
      "config.json"
    );

    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(content) as CharacterConfig;
        this.setCache(cacheKey, config);
        return config;
      } catch (error) {
        console.error(`Failed to load character config: ${configPath}`, error);
      }
    }

    return null;
  }

  /**
   * 加载 SOUL 定义（从角色专用目录）
   */
  async loadSoul(characterId: string, soulId: string, forceRefresh = false): Promise<SoulDefinition | null> {
    const cacheKey = `souls/${characterId}/${soulId}`;

    const cached = this.getFromCache<SoulDefinition>(cacheKey, forceRefresh);
    if (cached) {
      return cached;
    }

    // 从角色专用目录加载
    const characterSoulPath = path.join(
      this.userDefinitionsPath,
      PERSONA_3D_FUSION_DIR,
      characterId,
      "souls",
      `${soulId}.yaml`
    );

    if (fs.existsSync(characterSoulPath)) {
      const definition = await loadYaml<SoulDefinition>(characterSoulPath);
      if (definition) {
        this.setCache(cacheKey, definition);
        return definition;
      }
    }

    // 回退到插件内置定义
    if (this.enableBuiltinFallback) {
      const builtinPath = path.join(this.builtinDefinitionsPath, "souls", `${soulId}.yaml`);
      if (fs.existsSync(builtinPath)) {
        const definition = await loadYaml<SoulDefinition>(builtinPath);
        if (definition) {
          this.setCache(cacheKey, definition);
          return definition;
        }
      }
    }

    return null;
  }

  /**
   * 加载 CONTEXT 定义（通用 + 角色特有融合）
   */
  async loadContext(
    characterId: string,
    contextId: string,
    forceRefresh = false,
  ): Promise<{ generic: ContextDefinition | null; character: ContextDefinition | null }> {
    const cacheKey = `contexts/${characterId}/${contextId}`;

    const cached = this.getFromCache<{ generic: ContextDefinition | null; character: ContextDefinition | null }>(cacheKey, forceRefresh);
    if (cached) {
      return cached;
    }

    // 1. 加载通用 CONTEXT
    const genericPath = path.join(
      this.userDefinitionsPath,
      WORKPHASES_DIR,
      "contexts",
      `${contextId}.yaml`
    );

    let generic: ContextDefinition | null = null;
    if (fs.existsSync(genericPath)) {
      generic = await loadYaml<ContextDefinition>(genericPath);
    }

    // 2. 加载角色特有 CONTEXT
    const characterPath = path.join(
      this.userDefinitionsPath,
      PERSONA_3D_FUSION_DIR,
      characterId,
      "contexts",
      `${contextId}.yaml`
    );

    let character: ContextDefinition | null = null;
    if (fs.existsSync(characterPath)) {
      character = await loadYaml<ContextDefinition>(characterPath);
    }

    // 3. 回退到插件内置定义（如果都没有）
    if (!generic && !character && this.enableBuiltinFallback) {
      const builtinPath = path.join(this.builtinDefinitionsPath, "contexts", `${contextId}.yaml`);
      if (fs.existsSync(builtinPath)) {
        generic = await loadYaml<ContextDefinition>(builtinPath);
      }
    }

    const result = { generic, character };
    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * 加载 PHASE 定义（通用 + 角色特有融合）
   */
  async loadPhase(
    characterId: string,
    phaseId: string,
    forceRefresh = false,
  ): Promise<{ generic: PhaseDefinition | null; character: PhaseDefinition | null }> {
    const cacheKey = `phases/${characterId}/${phaseId}`;

    const cached = this.getFromCache<{ generic: PhaseDefinition | null; character: PhaseDefinition | null }>(cacheKey, forceRefresh);
    if (cached) {
      return cached;
    }

    // 1. 加载通用 PHASE
    const genericPath = path.join(
      this.userDefinitionsPath,
      WORKPHASES_DIR,
      "phases",
      `${phaseId}.yaml`
    );

    let generic: PhaseDefinition | null = null;
    if (fs.existsSync(genericPath)) {
      generic = await loadYaml<PhaseDefinition>(genericPath);
    }

    // 2. 加载角色特有 PHASE
    const characterPath = path.join(
      this.userDefinitionsPath,
      PERSONA_3D_FUSION_DIR,
      characterId,
      "phases",
      `${phaseId}.yaml`
    );

    let character: PhaseDefinition | null = null;
    if (fs.existsSync(characterPath)) {
      character = await loadYaml<PhaseDefinition>(characterPath);
    }

    // 3. 回退到插件内置定义（如果都没有）
    if (!generic && !character && this.enableBuiltinFallback) {
      const builtinPath = path.join(this.builtinDefinitionsPath, "phases", `${phaseId}.yaml`);
      if (fs.existsSync(builtinPath)) {
        generic = await loadYaml<PhaseDefinition>(builtinPath);
      }
    }

    const result = { generic, character };
    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * 列出所有可用的 SOUL 定义（从角色目录）
   */
  async listSouls(characterId: string): Promise<string[]> {
    const characterDir = path.join(
      this.userDefinitionsPath,
      PERSONA_3D_FUSION_DIR,
      characterId,
      "souls"
    );

    return this.listYamlFiles(characterDir);
  }

  /**
   * 列出所有可用的 CONTEXT 定义（通用 + 角色）
   */
  async listContexts(characterId: string): Promise<string[]> {
    const ids = new Set<string>();

    // 从通用目录收集
    const genericDir = path.join(this.userDefinitionsPath, WORKPHASES_DIR, "contexts");
    if (fs.existsSync(genericDir)) {
      const files = await this.listYamlFiles(genericDir);
      files.forEach((f) => ids.add(f));
    }

    // 从角色目录收集
    const characterDir = path.join(
      this.userDefinitionsPath,
      PERSONA_3D_FUSION_DIR,
      characterId,
      "contexts"
    );
    if (fs.existsSync(characterDir)) {
      const files = await this.listYamlFiles(characterDir);
      files.forEach((f) => ids.add(f));
    }

    return Array.from(ids);
  }

  /**
   * 列出所有可用的 PHASE 定义（通用 + 角色）
   */
  async listPhases(characterId: string): Promise<string[]> {
    const ids = new Set<string>();

    // 从通用目录收集
    const genericDir = path.join(this.userDefinitionsPath, WORKPHASES_DIR, "phases");
    if (fs.existsSync(genericDir)) {
      const files = await this.listYamlFiles(genericDir);
      files.forEach((f) => ids.add(f));
    }

    // 从角色目录收集
    const characterDir = path.join(
      this.userDefinitionsPath,
      PERSONA_3D_FUSION_DIR,
      characterId,
      "phases"
    );
    if (fs.existsSync(characterDir)) {
      const files = await this.listYamlFiles(characterDir);
      files.forEach((f) => ids.add(f));
    }

    return Array.from(ids);
  }

  /**
   * 列出目录中的所有 YAML 文件（不带扩展名）
   */
  private async listYamlFiles(dir: string): Promise<string[]> {
    try {
      const files = fs.readdirSync(dir);
      return files
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => path.basename(f, path.extname(f)));
    } catch {
      return [];
    }
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取用户定义目录
   */
  getUserDefinitionsPath(): string {
    return this.userDefinitionsPath;
  }

  /**
   * 设置用户定义目录
   */
  setUserDefinitionsPath(path: string): void {
    this.userDefinitionsPath = path;
    this.clearCache();
  }
}

// =============================================================================
// 默认实例
// =============================================================================

/**
 * 默认定义加载器
 */
export const defaultDefinitionLoader = new DefinitionLoader();

export default DefinitionLoader;