import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResolvedTimeFormat } from "../date-time.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { buildAgentSystemPrompt, type PromptMode } from "../system-prompt.js";
import { buildToolSummaryMap } from "../tool-summaries.js";
import type { AgentLayer } from "../multi-layer/layer-resolver.js";
import type { EmbeddedSandboxInfo } from "./types.js";
import type { ReasoningLevel, ThinkLevel } from "./utils.js";
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
  
  // 角色设定已统一由 persona-injector -> CharacterService 处理，
  // 通过 extraSystemPrompt 传入，此处不再重复加载。
  
  // 构建公共参数
  const commonParams = {
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
    characterName: params.characterName,
    runtimeInfo: params.runtimeInfo,
    messageToolHints: params.messageToolHints,
    sandboxInfo: params.sandboxInfo,
    modelAliasLines: params.modelAliasLines,
    userTimezone: params.userTimezone,
    userTime: params.userTime,
    userTimeFormat: params.userTimeFormat,
    contextFiles: params.contextFiles,
    sessionSummary: params.sessionSummary,
    taskBoard: params.taskBoard,
  };

  // 虚拟世界层：只包含角色设定，不包含工具提示词
  if (layer === 'virtual-world') {
    return buildAgentSystemPrompt({
      ...commonParams,
      toolNames: [],
      toolSummaries: {},
    });
  }
  
  // 管家层：包含任务委托提示词，但不包含详细的工具说明
  if (layer === 'butler') {
    const basePrompt = buildAgentSystemPrompt({
      ...commonParams,
      toolNames: [],
      toolSummaries: {},
    });
    
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
    
    return basePrompt + delegationPrompt;
  }
  
  // 执行层：包含完整的工具使用提示词（默认行为）
  return buildAgentSystemPrompt({
    ...commonParams,
    toolNames: params.tools.map((tool) => tool.name),
    toolSummaries: buildToolSummaryMap(params.tools),
  });
}

export function createSystemPromptOverride(
  systemPrompt: string,
): (defaultPrompt: string) => string {
  const trimmed = systemPrompt.trim();
  return () => trimmed;
}
