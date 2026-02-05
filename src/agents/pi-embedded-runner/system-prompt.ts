import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResolvedTimeFormat } from "../date-time.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { buildAgentSystemPrompt, type PromptMode } from "../system-prompt.js";
import { buildToolSummaryMap } from "../tool-summaries.js";
import type { AgentLayer } from "../multi-layer/layer-resolver.js";
import type { EmbeddedSandboxInfo } from "./types.js";
import type { ReasoningLevel, ThinkLevel } from "./utils.js";
import { loadCharacterConfig, loadCharacterProfile } from "../lina/config/loader.js";
import { generateSystemPrompt } from "../lina/prompts/system-prompt-generator.js";
import { log } from "../pi-embedded-runner/logger.js";

export async function buildEmbeddedSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint: boolean;
  heartbeatPrompt?: string;
  skillsPrompt?: string;
  docsPath?: string;
  ttsHint?: string;
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  workspaceNotes?: string[];
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  /** Agent layer (virtual-world, butler, execution). Defaults to execution. */
  agentLayer?: AgentLayer;
  /** Character name for personality (e.g., "lina"). If specified, loads character config. */
  characterName?: string;
  /** Base path for character config. Defaults to workspaceDir. */
  characterBasePath?: string;
  runtimeInfo: {
    agentId?: string;
    host: string;
    os: string;
    arch: string;
    node: string;
    model: string;
    provider?: string;
    capabilities?: string[];
    channel?: string;
    /** Supported message actions for the current channel (e.g., react, edit, unsend) */
    channelActions?: string[];
  };
  messageToolHints?: string[];
  sandboxInfo?: EmbeddedSandboxInfo;
  tools: AgentTool[];
  modelAliasLines: string[];
  userTimezone: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  promptLanguage?: "en" | "zh";
  /** Session summary to inject into system prompt (provides task context). */
  sessionSummary?: string;
  /** Task board to inject into system prompt (provides task tracking). */
  taskBoard?: string;
}): Promise<string> {
  const layer = params.agentLayer || 'execution';
  
  // 🆕 如果指定了角色名称，加载角色设定并生成人格化提示词
  let characterPrompt: string | undefined;
  if (params.characterName) {
    try {
      const basePath = params.characterBasePath || params.workspaceDir;
      log.info(`[buildEmbeddedSystemPrompt] 加载角色设定: ${params.characterName} (basePath: ${basePath})`);
      
      const config = await loadCharacterConfig(params.characterName, basePath);
      const profile = await loadCharacterProfile(params.characterName, basePath);
      
      characterPrompt = generateSystemPrompt({
        config,
        profile,
        currentDate: new Date().toLocaleDateString("zh-CN"),
        userName: params.ownerNumbers?.[0], // 使用第一个 owner number 作为用户名
      });
      
      log.info(`[buildEmbeddedSystemPrompt] 角色设定加载成功: ${params.characterName} v${config.version}`);
    } catch (error: unknown) {
      log.error(`[buildEmbeddedSystemPrompt] 加载角色设定失败: ${params.characterName}`, error as Record<string, unknown>);
      // 失败时继续使用默认提示词
    }
  }
  
  // 虚拟世界层：只包含角色设定，不包含工具提示词
  if (layer === 'virtual-world') {
    const basePrompt = buildAgentSystemPrompt({
      workspaceDir: params.workspaceDir,
      defaultThinkLevel: params.defaultThinkLevel,
      reasoningLevel: params.reasoningLevel,
      extraSystemPrompt: params.extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      reasoningTagHint: params.reasoningTagHint,
      heartbeatPrompt: params.heartbeatPrompt,
      skillsPrompt: params.skillsPrompt,
      docsPath: params.docsPath,
      ttsHint: params.ttsHint,
      workspaceNotes: params.workspaceNotes,
      reactionGuidance: params.reactionGuidance,
      promptMode: params.promptMode,
      promptLanguage: params.promptLanguage,
      characterName: params.characterName, // 🆕 传递 characterName
      runtimeInfo: params.runtimeInfo,
      messageToolHints: params.messageToolHints,
      sandboxInfo: params.sandboxInfo,
      toolNames: [], // 虚拟世界层不包含工具
      toolSummaries: {}, // 虚拟世界层不包含工具摘要
      modelAliasLines: params.modelAliasLines,
      userTimezone: params.userTimezone,
      userTime: params.userTime,
      userTimeFormat: params.userTimeFormat,
      contextFiles: params.contextFiles,
      sessionSummary: params.sessionSummary,
      taskBoard: params.taskBoard,
    });
    
    // 🆕 如果有角色设定，将其注入到提示词开头
    if (characterPrompt) {
      return `${characterPrompt}\n\n---\n\n${basePrompt}`;
    }
    
    return basePrompt;
  }
  
  // 管家层：包含任务委托提示词，但不包含详细的工具说明
  if (layer === 'butler') {
    const basePrompt = buildAgentSystemPrompt({
      workspaceDir: params.workspaceDir,
      defaultThinkLevel: params.defaultThinkLevel,
      reasoningLevel: params.reasoningLevel,
      extraSystemPrompt: params.extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      reasoningTagHint: params.reasoningTagHint,
      heartbeatPrompt: params.heartbeatPrompt,
      skillsPrompt: params.skillsPrompt,
      docsPath: params.docsPath,
      ttsHint: params.ttsHint,
      workspaceNotes: params.workspaceNotes,
      reactionGuidance: params.reactionGuidance,
      promptMode: params.promptMode,
      promptLanguage: params.promptLanguage,
      characterName: params.characterName, // 🆕 传递 characterName
      runtimeInfo: params.runtimeInfo,
      messageToolHints: params.messageToolHints,
      sandboxInfo: params.sandboxInfo,
      toolNames: [], // 管家层不直接调用工具
      toolSummaries: {},
      modelAliasLines: params.modelAliasLines,
      userTimezone: params.userTimezone,
      userTime: params.userTime,
      userTimeFormat: params.userTimeFormat,
      contextFiles: params.contextFiles,
      sessionSummary: params.sessionSummary,
      taskBoard: params.taskBoard,
    });
    
    // 添加任务委托相关提示词
    const delegationPrompt = `

## 任务委托能力

你可以调用以下能力：
- delegateTask(): 委托任务给底层执行系统
- callSkill(): 调用独立技能（记忆检索、知识查询等）

注意：你不直接执行工具调用，而是委托给底层系统。你的职责是：
1. 理解用户意图
2. 分解复杂任务
3. 调度底层执行
4. 整合执行结果`;
    
    // 🆕 如果有角色设定，将其注入到提示词开头
    if (characterPrompt) {
      return `${characterPrompt}\n\n---\n\n${basePrompt}${delegationPrompt}`;
    }
    
    return basePrompt + delegationPrompt;
  }
  
  // 执行层：包含完整的工具使用提示词（默认行为）
  const basePrompt = buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    reasoningLevel: params.reasoningLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: params.reasoningTagHint,
    heartbeatPrompt: params.heartbeatPrompt,
    skillsPrompt: params.skillsPrompt,
    docsPath: params.docsPath,
    ttsHint: params.ttsHint,
    workspaceNotes: params.workspaceNotes,
    reactionGuidance: params.reactionGuidance,
    promptMode: params.promptMode,
    promptLanguage: params.promptLanguage,
    characterName: params.characterName, // 🆕 传递 characterName
    runtimeInfo: params.runtimeInfo,
    messageToolHints: params.messageToolHints,
    sandboxInfo: params.sandboxInfo,
    toolNames: params.tools.map((tool) => tool.name),
    toolSummaries: buildToolSummaryMap(params.tools),
    modelAliasLines: params.modelAliasLines,
    userTimezone: params.userTimezone,
    userTime: params.userTime,
    userTimeFormat: params.userTimeFormat,
    contextFiles: params.contextFiles,
    sessionSummary: params.sessionSummary,
    taskBoard: params.taskBoard,
  });
  
  // 🆕 如果有角色设定，将其注入到提示词开头
  if (characterPrompt) {
    return `${characterPrompt}\n\n---\n\n${basePrompt}`;
  }
  
  return basePrompt;
}

export function createSystemPromptOverride(
  systemPrompt: string,
): (defaultPrompt: string) => string {
  const trimmed = systemPrompt.trim();
  return () => trimmed;
}
