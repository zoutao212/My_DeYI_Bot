/**
 * 角色服务
 * 智能加载、初始化、更新角色配置
 */

import { readFile, writeFile, mkdir, readdir, stat, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { CharacterRecognitionConfig } from "../types.js";
import { renderTemplate, buildTemplateContextFromCharacter, type TemplateContext } from "./template-engine.js";

const log = createSubsystemLogger("pipeline:character");

// ==============================================================================
// 类型定义
// ==============================================================================

export interface FullCharacterConfig {
  // 基本信息
  name: string;
  displayName: string;
  version: string;
  type: "system-persona" | "virtual-character" | "custom-aiji";
  enabled: boolean;

  // 识别配置
  recognition: {
    names: string[];
    triggers: string[];
    contexts: string[];
  };

  // 功能配置
  features: Record<string, boolean>;

  // 系统提示词配置
  systemPrompt: {
    role: string;
    personality: string[];
    addressUser: string;
    addressSelf: string;
  };

  // 记忆配置
  memory: {
    coreMemoriesFile: string;
    sessionArchiveDir: string;
    maxRetrievalResults: number;
  };

  // 提示词配置
  prompts: {
    systemPromptTemplate: string;
  };

  // 知识库配置
  knowledge: {
    files: string[];
  };

  // 场景配置（新增）
  scenes?: {
    files: string[];
  };

  // 文件路径配置（新增）
  files?: {
    persona?: string;
    systemPrompt?: string;
    profile?: string;
    knowledge?: string[];
    scenes?: string[]; // 新增
    coreMemories?: string;
    sessionArchiveDir?: string;
    sceneArchiveDir?: string; // 新增
  };

  // Workspace 文件覆盖声明（新增）
  overrides?: Record<string, boolean>;

  // 提醒配置（仅系统人格）
  reminders?: {
    enabled: boolean;
    checkInterval: number;
    advanceNotice: number;
  };

  // 关系配置（仅虚拟角色）
  relationship?: {
    enabled: boolean;
    initialIntimacy: number;
    trackEmotions: boolean;
  };
}

export interface CharacterProfile {
  background: string;
  personality: string;
  capabilities: string;
  interactionStyle: string;
  rawContent: string;
}

export interface CharacterKnowledge {
  files: Record<string, string>;
  combinedContent: string;
  /** 知识库文件名列表（用于延迟加载/检索指引） */
  fileNames: string[];
}

export interface CharacterScenes {
  files: Record<string, string>;
  combinedContent: string;
  fileNames: string[];
}

export interface CharacterMemories {
  coreMemories: string;
  recentSessions: string[];
}

/** persona.md 解析结果 */
export interface CharacterPersona {
  identity: string;
  personality: string;
  speakingStyle: string;
  values: string;
  rawContent: string;
}

export interface LoadedCharacter {
  config: FullCharacterConfig;
  profile: CharacterProfile;
  knowledge: CharacterKnowledge;
  scenes: CharacterScenes; // 新增
  memories: CharacterMemories;
  persona: CharacterPersona;
  systemPromptTemplate: string;
  /** 未渲染的原始模板（延迟渲染用） */
  rawTemplate: string;
  /** 向后兼容：提前渲染的 system prompt（不含延迟注入的记忆） */
  formattedSystemPrompt: string;
  isSystemPersona: boolean;
  characterDir: string;
  /** 声明此角色覆盖的 Workspace 文件列表（如 ["SOUL.md"]） */
  overridesWorkspaceFiles: string[];
}

// ==============================================================================
// 角色服务类
// ==============================================================================

export class CharacterService {
  private charactersDir: string;
  private templatesDir: string;
  private loadedCharacters = new Map<string, LoadedCharacter>();
  /** P78: 惰性解析后的实际角色目录（避免双重 clawd 嵌套） */
  private _resolvedCharactersDir: string | null = null;

  constructor(
    private readonly basePath: string = process.cwd(),
    private readonly clawdDir: string = "clawd",
  ) {
    this.charactersDir = join(basePath, clawdDir, "characters");
    // 模板目录在代码中
    const currentDir = dirname(fileURLToPath(import.meta.url));
    this.templatesDir = join(currentDir, "templates");
    log.debug(`[CharacterService] primaryCharactersDir=${this.charactersDir}, basePath=${basePath}, clawdDir=${clawdDir}`);
  }

  /**
   * P78: 惰性解析实际的角色目录路径。
   * 当 basePath 已包含 clawdDir 时（如 process.cwd() = ~/clawd），
   * join(basePath, "clawd", "characters") 产生双重嵌套。
   * 此方法检测并回退到 basePath/characters。
   */
  private async resolveCharactersDir(): Promise<string> {
    if (this._resolvedCharactersDir) return this._resolvedCharactersDir;

    // 主路径：basePath/clawdDir/characters
    if (await this.directoryExists(this.charactersDir)) {
      this._resolvedCharactersDir = this.charactersDir;
      return this.charactersDir;
    }

    // 回退1：basePath/characters（basePath 已包含 clawdDir 的情况）
    const fallback1 = join(this.basePath, "characters");
    if (await this.directoryExists(fallback1)) {
      log.info(`[CharacterService] P78 路径回退: ${this.charactersDir} → ${fallback1}`);
      this._resolvedCharactersDir = fallback1;
      this.charactersDir = fallback1;
      return fallback1;
    }

    // 回退2：basePath 的父目录/clawdDir/characters（basePath 可能是子目录）
    const parentPath = dirname(this.basePath);
    const fallback2 = join(parentPath, this.clawdDir, "characters");
    if (parentPath !== this.basePath && await this.directoryExists(fallback2)) {
      log.info(`[CharacterService] P78 路径回退: ${this.charactersDir} → ${fallback2}`);
      this._resolvedCharactersDir = fallback2;
      this.charactersDir = fallback2;
      return fallback2;
    }

    // 均不存在，保留主路径（initializeCharacter 会尝试创建）
    log.warn(`[CharacterService] P78 角色目录不存在: ${this.charactersDir} (回退路径也不存在: ${fallback1})`);
    this._resolvedCharactersDir = this.charactersDir;
    return this.charactersDir;
  }

  /**
   * 加载完整的角色配置
   */
  async loadCharacter(characterId: string): Promise<LoadedCharacter | null> {
    // 检查缓存
    if (this.loadedCharacters.has(characterId)) {
      return this.loadedCharacters.get(characterId)!;
    }

    // P78: 惰性解析正确的角色目录路径
    const resolvedDir = await this.resolveCharactersDir();
    const characterDir = join(resolvedDir, characterId);

    // 检查角色目录是否存在，不存在则尝试初始化
    if (!(await this.directoryExists(characterDir))) {
      const initialized = await this.initializeCharacter(characterId);
      if (!initialized) {
        log.warn(`[CharacterService] Character ${characterId} not found and could not be initialized`);
        return null;
      }
    }

    try {
      // 1. 加载配置
      const config = await this.loadConfig(characterDir);
      if (!config) {
        log.warn(`[CharacterService] Failed to load config for ${characterId}`);
        return null;
      }

      // 2. 加载角色档案
      const profile = await this.loadProfile(characterDir);

      // 3. 加载知识库 (custom-aiji: 延迟加载模式，只记录文件列表)
      const isCustomAiji = config.type === "custom-aiji";
      const knowledgeFiles = config.knowledge?.files ?? config.files?.knowledge ?? [];
      const knowledge = await this.loadKnowledge(
        characterDir,
        knowledgeFiles,
        !isCustomAiji // 如果是 custom-aiji，不加载内容
      );

      // 3.5 加载场景库
      const sceneFiles = config.scenes?.files ?? config.files?.scenes ?? [];
      const scenes = await this.loadScenes(
        characterDir,
        sceneFiles,
        !isCustomAiji
      );

      // 4. 加载记忆
      const memories = await this.loadMemories(characterDir, config.memory ?? { coreMemoriesFile: "core-memories.md", sessionArchiveDir: "sessions", maxRetrievalResults: 10 });

      // 5. 加载系统提示词模板
      const systemPromptTemplate = await this.loadSystemPromptTemplate(characterDir, config.prompts ?? { systemPromptTemplate: "system.md" });

      // 5.5 加载 persona.md（新增）
      const persona = await this.loadPersona(characterDir, config);

      // 6. 生成格式化的系统提示词（向后兼容，不含延迟记忆）
      const formattedSystemPrompt = this.formatSystemPrompt(systemPromptTemplate, {
        config,
        profile,
        knowledge,
        scenes,
        memories,
        persona,
      });

      // 7. 解析 overrides
      const overridesWorkspaceFiles = config.overrides
        ? Object.entries(config.overrides)
            .filter(([, v]) => v === true)
            .map(([k]) => k)
        : [];

      const loaded: LoadedCharacter = {
        config,
        profile,
        knowledge,
        scenes,
        memories,
        persona,
        systemPromptTemplate,
        rawTemplate: systemPromptTemplate,
        formattedSystemPrompt,
        isSystemPersona: config.type === "system-persona",
        characterDir,
        overridesWorkspaceFiles,
      };

      // 缓存
      this.loadedCharacters.set(characterId, loaded);

      log.info(`[CharacterService] Loaded character: ${characterId} (${config.displayName})`);
      return loaded;
    } catch (error) {
      log.error(`[CharacterService] Failed to load character ${characterId}: ${error}`);
      return null;
    }
  }

  /**
   * 获取所有角色的识别配置（用于意图分析）
   */
  async getAllRecognitionConfigs(): Promise<CharacterRecognitionConfig[]> {
    const configs: CharacterRecognitionConfig[] = [];

    try {
      // P78: 使用解析后的路径
      const resolvedDir = await this.resolveCharactersDir();
      const entries = await readdir(resolvedDir).catch(() => []);
      
      for (const entry of entries) {
        const characterDir = join(this.charactersDir, entry);
        if (!(await this.directoryExists(characterDir))) continue;

        const config = await this.loadConfig(characterDir);
        
        // 验证配置完整性
        if (!config || !config.enabled) continue;
        if (!config.recognition || !config.recognition.names) {
          log.warn(`[CharacterService] Skipping ${entry}: missing recognition config`);
          continue;
        }

        configs.push({
          id: config.name,
          displayName: config.displayName,
          isSystemPersona: config.type === "system-persona",
          recognition: {
            names: config.recognition.names || [],
            triggers: config.recognition.triggers || [],
            contexts: config.recognition.contexts || [],
          },
        });
      }
    } catch (error) {
      log.warn(`[CharacterService] Failed to load recognition configs: ${error}`);
    }

    log.info(`[CharacterService] Loaded ${configs.length} character recognition configs`);
    return configs;
  }

  /**
   * 初始化角色目录（从模板）
   */
  async initializeCharacter(characterId: string): Promise<boolean> {
    const templatePrefix = `${characterId}-`;
    const characterDir = join(this.charactersDir, characterId);

    try {
      // 检查是否有对应的模板
      const templateFiles = await readdir(this.templatesDir).catch(() => []);
      const relevantTemplates = templateFiles.filter((f) => f.startsWith(templatePrefix));

      if (relevantTemplates.length === 0) {
        log.warn(`[CharacterService] No templates found for character: ${characterId}`);
        return false;
      }

      // 创建角色目录结构
      await mkdir(characterDir, { recursive: true });
      await mkdir(join(characterDir, "memory"), { recursive: true });
      await mkdir(join(characterDir, "memory", "sessions"), { recursive: true });
      await mkdir(join(characterDir, "prompts"), { recursive: true });
      await mkdir(join(characterDir, "knowledge"), { recursive: true });

      // 复制模板文件
      for (const templateFile of relevantTemplates) {
        const templatePath = join(this.templatesDir, templateFile);
        const targetFileName = templateFile.replace(templatePrefix, "").replace(".json", ".json");

        let targetPath: string;
        if (templateFile.endsWith("-config.json")) {
          targetPath = join(characterDir, "config.json");
        } else if (templateFile.endsWith("-profile.md")) {
          targetPath = join(characterDir, "profile.md");
        } else if (templateFile.endsWith("-system-prompt.md")) {
          targetPath = join(characterDir, "prompts", "system.md");
        } else if (templateFile.endsWith("-core-memories.md")) {
          targetPath = join(characterDir, "memory", "core-memories.md");
        } else if (templateFile.endsWith("-capabilities.md")) {
          targetPath = join(characterDir, "knowledge", "capabilities.md");
        } else if (templateFile.endsWith("-guidelines.md")) {
          targetPath = join(characterDir, "knowledge", "guidelines.md");
        } else {
          // 其他知识库文件
          const fileName = templateFile.replace(templatePrefix, "");
          targetPath = join(characterDir, "knowledge", fileName);
        }

        await copyFile(templatePath, targetPath);
        log.debug(`[CharacterService] Copied template: ${templateFile} -> ${targetPath}`);
      }

      log.info(`[CharacterService] Initialized character directory: ${characterId}`);
      return true;
    } catch (error) {
      log.error(`[CharacterService] Failed to initialize character ${characterId}: ${error}`);
      return false;
    }
  }

  /**
   * 更新角色核心记忆
   */
  async updateCoreMemories(characterId: string, content: string, append: boolean = true): Promise<boolean> {
    try {
      const characterDir = join(this.charactersDir, characterId);
      const memoriesPath = join(characterDir, "memory", "core-memories.md");

      if (append) {
        const existing = await readFile(memoriesPath, "utf-8").catch(() => "");
        const timestamp = new Date().toLocaleString("zh-CN");
        const newContent = `${existing}\n\n## ${timestamp}\n\n${content}`;
        await writeFile(memoriesPath, newContent, "utf-8");
      } else {
        await writeFile(memoriesPath, content, "utf-8");
      }

      // 清除缓存
      this.loadedCharacters.delete(characterId);

      log.info(`[CharacterService] Updated core memories for ${characterId}`);
      return true;
    } catch (error) {
      log.error(`[CharacterService] Failed to update core memories for ${characterId}: ${error}`);
      return false;
    }
  }

  /**
   * 归档会话到角色记忆
   */
  async archiveSession(
    characterId: string,
    sessionId: string,
    summary: string,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const characterDir = join(this.charactersDir, characterId);
      const sessionsDir = join(characterDir, "memory", "sessions");
      await mkdir(sessionsDir, { recursive: true });

      const timestamp = new Date().toISOString().split("T")[0];
      const sessionFile = join(sessionsDir, `${timestamp}_${sessionId}.md`);

      const content = [
        `# 会话归档`,
        ``,
        `- **会话ID**: ${sessionId}`,
        `- **时间**: ${new Date().toLocaleString("zh-CN")}`,
        metadata ? `- **元数据**: ${JSON.stringify(metadata)}` : "",
        ``,
        `## 会话总结`,
        ``,
        summary,
      ]
        .filter(Boolean)
        .join("\n");

      await writeFile(sessionFile, content, "utf-8");

      // 清除缓存
      this.loadedCharacters.delete(characterId);

      log.info(`[CharacterService] Archived session ${sessionId} for ${characterId}`);
      return true;
    } catch (error) {
      log.error(`[CharacterService] Failed to archive session for ${characterId}: ${error}`);
      return false;
    }
  }

  /**
   * 获取角色目录路径
   */
  getCharacterDir(characterId: string): string {
    return join(this.charactersDir, characterId);
  }

  /**
   * 检查角色是否存在
   */
  async characterExists(characterId: string): Promise<boolean> {
    const characterDir = join(this.charactersDir, characterId);
    return this.directoryExists(characterDir);
  }

  /**
   * 清除缓存
   */
  clearCache(characterId?: string): void {
    if (characterId) {
      this.loadedCharacters.delete(characterId);
    } else {
      this.loadedCharacters.clear();
    }
  }

  // ==============================================================================
  // 私有方法
  // ==============================================================================

  private async loadConfig(characterDir: string): Promise<FullCharacterConfig | null> {
    try {
      const configPath = join(characterDir, "config.json");
      const content = await readFile(configPath, "utf-8");
      return JSON.parse(content) as FullCharacterConfig;
    } catch {
      return null;
    }
  }

  private async loadProfile(characterDir: string): Promise<CharacterProfile> {
    try {
      const profilePath = join(characterDir, "profile.md");
      const content = await readFile(profilePath, "utf-8");
      const sections = this.parseMarkdownSections(content);

      return {
        background: sections["背景故事"] || sections["Background"] || "",
        personality: sections["性格特点"] || sections["Personality"] || "",
        capabilities: sections["核心能力"] || sections["Capabilities"] || "",
        interactionStyle: sections["互动风格"] || sections["Interaction Style"] || "",
        rawContent: content,
      };
    } catch {
      return {
        background: "",
        personality: "",
        capabilities: "",
        interactionStyle: "",
        rawContent: "",
      };
    }
  }

  private async loadKnowledge(
    characterDir: string,
    files: string[],
    loadContent: boolean = true,
  ): Promise<CharacterKnowledge> {
    const knowledge: CharacterKnowledge = {
      files: {},
      combinedContent: "",
      fileNames: files,
    };

    if (!loadContent) return knowledge;

    const knowledgeDir = join(characterDir, "knowledge");
    for (const file of files) {
      try {
        const filePath = join(knowledgeDir, file);
        const content = await readFile(filePath, "utf-8");
        knowledge.files[file] = content;
      } catch {
        // 文件不存在，跳过
      }
    }

    knowledge.combinedContent = Object.values(knowledge.files).join("\n\n---\n\n");
    return knowledge;
  }

  private async loadScenes(
    characterDir: string,
    files: string[],
    loadContent: boolean = true,
  ): Promise<CharacterScenes> {
    const scenes: CharacterScenes = {
      files: {},
      combinedContent: "",
      fileNames: files,
    };

    if (!loadContent) return scenes;

    const scenesDir = join(characterDir, "scenes");
    for (const file of files) {
      try {
        const filePath = join(scenesDir, file);
        const content = await readFile(filePath, "utf-8");
        scenes.files[file] = content;
      } catch {
        // 文件不存在，跳过
      }
    }

    scenes.combinedContent = Object.values(scenes.files).join("\n\n---\n\n");
    return scenes;
  }

  private async loadMemories(
    characterDir: string,
    memoryConfig: FullCharacterConfig["memory"],
  ): Promise<CharacterMemories> {
    const memories: CharacterMemories = {
      coreMemories: "",
      recentSessions: [],
    };

    try {
      // 加载核心记忆
      const coreMemoriesPath = join(characterDir, "memory", memoryConfig.coreMemoriesFile);
      memories.coreMemories = await readFile(coreMemoriesPath, "utf-8").catch(() => "");

      // 加载最近的会话归档
      const sessionsDir = join(characterDir, "memory", memoryConfig.sessionArchiveDir);
      const sessionFiles = await readdir(sessionsDir).catch(() => []);

      // 按文件名排序（最新的在前）
      const sortedFiles = sessionFiles
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 5); // 只取最近5个

      for (const file of sortedFiles) {
        try {
          const content = await readFile(join(sessionsDir, file), "utf-8");
          memories.recentSessions.push(content);
        } catch {
          // 跳过
        }
      }
    } catch {
      // 忽略错误
    }

    return memories;
  }

  private async loadSystemPromptTemplate(
    characterDir: string,
    promptsConfig: FullCharacterConfig["prompts"],
  ): Promise<string> {
    try {
      const templatePath = join(characterDir, "prompts", promptsConfig.systemPromptTemplate);
      return await readFile(templatePath, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * 加载 persona.md（人格声明文件）
   * 如果 persona.md 不存在，fallback 到 config.json 的 systemPrompt 字段
   */
  private async loadPersona(
    characterDir: string,
    config: FullCharacterConfig,
  ): Promise<CharacterPersona> {
    const personaFile = config.files?.persona ?? "persona.md";
    try {
      const personaPath = join(characterDir, personaFile);
      const content = await readFile(personaPath, "utf-8");
      const sections = this.parseMarkdownSections(content);
      return {
        identity: sections["身份"] || sections["Identity"] || "",
        personality: sections["性格"] || sections["Personality"] || "",
        speakingStyle: sections["说话风格"] || sections["Speaking Style"] || "",
        values: sections["价值观"] || sections["Values"] || "",
        rawContent: content,
      };
    } catch {
      // fallback: 从 config.json 的 systemPrompt 字段构建
      return {
        identity: `${config.displayName}`,
        personality: config.systemPrompt.personality.join("、"),
        speakingStyle: "",
        values: "",
        rawContent: "",
      };
    }
  }

  private formatSystemPrompt(
    template: string,
    context: {
      config: FullCharacterConfig;
      profile: CharacterProfile;
      knowledge: CharacterKnowledge;
      scenes: CharacterScenes;
      memories: CharacterMemories;
      persona: CharacterPersona;
    },
  ): string {
    const { config, profile, knowledge, scenes, memories, persona } = context;

    // 使用统一模板引擎渲染
    const templateCtx: Partial<TemplateContext> = {
      ...buildTemplateContextFromCharacter({
        config,
        profileRawContent: profile.rawContent,
        profileCapabilities: profile.capabilities,
        knowledgeCombined: knowledge.combinedContent,
      }),
      // persona.md 优先覆盖 config.json 的 personality
      personality: persona.personality || config.systemPrompt.personality.join("、"),
      coreMemories: memories.coreMemories || "暂无核心记忆",
      relevantMemories: memories.recentSessions.join("\n\n") || "暂无相关记忆",
    };

    let result = renderTemplate(template, templateCtx);

    // 如果有场景库内容，追加到末尾
    if (scenes.combinedContent) {
      result += `\n\n## 场景库\n\n${scenes.combinedContent}`;
    }

    // 如果有知识库内容，追加到末尾
    if (knowledge.combinedContent) {
      result += `\n\n## 知识库\n\n${knowledge.combinedContent}`;
    } else if (knowledge.fileNames.length > 0) {
      // 延迟加载模式：告知 LLM 有哪些知识可供召回
      result += `\n\n## 知识索引\n你拥有以下领域的专业知识，已导入记忆数据库。系统会根据对话关键词自动召回相关片段。你也可以使用 supermemory_recall 工具主动搜索这些主题：\n${knowledge.fileNames.map(f => `- ${f}`).join("\n")}`;
    }

    if (scenes.fileNames.length > 0 && !scenes.combinedContent) {
      result += `\n\n## 场景索引\n你拥有以下预设场景和互动剧本，已导入记忆数据库：\n${scenes.fileNames.map(f => `- ${f}`).join("\n")}`;
    }

    return result;
  }

  private parseMarkdownSections(content: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const lines = content.split("\n");

    let currentSection = "";
    let currentContent: string[] = [];

    for (const line of lines) {
      if (line.startsWith("## ")) {
        if (currentSection) {
          sections[currentSection] = currentContent.join("\n").trim();
        }
        currentSection = line.replace("## ", "").trim();
        currentContent = [];
      } else if (currentSection) {
        currentContent.push(line);
      }
    }

    if (currentSection) {
      sections[currentSection] = currentContent.join("\n").trim();
    }

    return sections;
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      const stats = await stat(path);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
}

// ==============================================================================
// 工厂函数
// ==============================================================================

let defaultService: CharacterService | null = null;

export function getCharacterService(basePath?: string, clawdDir?: string): CharacterService {
  if (!defaultService || basePath || clawdDir) {
    defaultService = new CharacterService(basePath, clawdDir);
  }
  return defaultService;
}

export function createCharacterService(basePath?: string, clawdDir?: string): CharacterService {
  return new CharacterService(basePath, clawdDir);
}

