/**
 * 爱姬聊天室 — 单角色 LLM 调用封装
 *
 * 复用现有的 CharacterService 加载角色人格，
 * 复用 SystemLLMCaller(completeSimple) 做轻量级 LLM 调用。
 *
 * 不走完整的 runEmbeddedPiAgent 流程（太重），
 * 只做"角色人格 system prompt + 用户消息 → 角色风格回复"。
 *
 * @module agents/chatroom/character-agent
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runEmbeddedPiAgent } from "../pi-embedded.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { getCharacterService } from "../pipeline/characters/character-service.js";
import type {
  ChatRoomMessage,
  CharacterResponse,
  ChatRoomConfig,
  CollaborativeTaskContext,
  ReplyStyle,
} from "./types.js";
import { DEFAULT_CHATROOM_CONFIG, CHARACTER_ICONS } from "./types.js";
import {
  fetchMemoryContext,
  formatMemoryContextForPrompt,
} from "./memory-bridge.js";
import { fillTemplate } from "./character-agent.l10n.types.js";
import { getCharacterAgentL10n } from "./detector-l10n-loader.js";

const log = createSubsystemLogger("chatroom:agent");

const CHATROOM_TOOL_ALLOWLIST: string[] = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "memory_write",
  "memory_update",
  "memory_patch",
  "memory_delete",
  "memory_list",
  "memory_deep_search",
  "supermemory_recall",
  "supermemory_store", // 角色可主动存储记忆
  "supermemory_forget", // 角色可主动遗忘记忆
];

function resolveProviderModel(config?: ClawdbotConfig): { provider?: string; model?: string } {
  const agentDefaults = (config as Record<string, any> | undefined)?.agents?.defaults;
  const modelCfg = agentDefaults?.model;
  const provider = modelCfg?.primaryProviderId ?? agentDefaults?.provider;
  const model = modelCfg?.primaryModelId ?? modelCfg?.id;
  return {
    provider: typeof provider === "string" ? provider : undefined,
    model: typeof model === "string" ? model : undefined,
  };
}

function resolveChatroomWorkspaceDir(params: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): string {
  const { config, agentSessionKey } = params;
  if (!config) return process.cwd();
  try {
    const agentId = resolveSessionAgentId({ sessionKey: agentSessionKey, config });
    return resolveAgentWorkspaceDir(config, agentId);
  } catch {
    return process.cwd();
  }
}

// ============================================================================
// 角色缓存（prompt + displayName 一体化，避免缓存命中时仍调 loadCharacter）
// ============================================================================

interface CachedPersona {
  systemPrompt: string;
  displayName: string;
}

function buildReplyStyleInstruction(style: ReplyStyle): string {
  switch (style) {
    case "dialogue":
      return [
        "## 🎭 回复风格要求",
        "本轮优先使用自然口语化对话回复，不要大段舞台动作描写。",
        "可以有少量动作点缀，但主体必须是角色说的话。",
      ].join("\n");
    case "action":
      return [
        "## 🎭 回复风格要求",
        "本轮优先使用动作/场景描写式表达（可含心理活动与舞台说明）。",
        "可以夹带少量台词，但主体应是动作与氛围描写。",
      ].join("\n");
    case "mixed":
    default:
      return [
        "## 🎭 回复风格要求",
        "本轮允许你自由选择“对话”或“动作描写”风格，也可以混合使用。",
        "根据上下文选择最自然、最有角色感的表达方式。",
      ].join("\n");
  }
}

/** 角色 persona 缓存：characterId → { systemPrompt, displayName } */
const personaCache = new Map<string, CachedPersona>();

/**
 * 加载角色的完整 system prompt（含人格+知识库+记忆）
 *
 * 复用 CharacterService.loadCharacter()，与单角色模式使用完全相同的
 * 角色加载链：config.json → persona.md → profile.md → knowledge/* → memory/*
 */
async function loadCharacterSystemPrompt(characterId: string): Promise<CachedPersona | null> {
  // 缓存命中直接返回（displayName 一起缓存，无需再调 loadCharacter）
  const cached = personaCache.get(characterId);
  if (cached) return cached;

  try {
    const svc = getCharacterService();
    const loaded = await svc.loadCharacter(characterId);
    if (!loaded || !loaded.formattedSystemPrompt) {
      log.warn(`[CharacterAgent] 角色 ${characterId} 加载失败或无 system prompt`);
      return null;
    }

    const entry: CachedPersona = {
      systemPrompt: loaded.formattedSystemPrompt,
      displayName: loaded.config.displayName,
    };
    personaCache.set(characterId, entry);
    log.info(`[CharacterAgent] 角色加载成功: ${characterId} (${entry.displayName})`);
    return entry;
  } catch (err) {
    log.error(`[CharacterAgent] 角色 ${characterId} 加载异常: ${err}`);
    return null;
  }
}

/**
 * 仅获取角色显示名（不触发 LLM，轻量操作）
 *
 * 优先从缓存获取；缓存未命中则调 CharacterService 加载。
 * 用于开场白等只需要显示名的场景。
 */
export async function getCharacterDisplayName(characterId: string): Promise<string> {
  const cached = personaCache.get(characterId);
  if (cached) return cached.displayName;

  // 轻量加载（同时填充缓存，后续 generateCharacterResponse 可复用）
  const loaded = await loadCharacterSystemPrompt(characterId);
  return loaded?.displayName ?? characterId;
}

// ============================================================================
// 聊天室上下文构建
// ============================================================================

/**
 * 构建聊天室特有的 system prompt 补丁
 *
 * 包含：
 * 1. 聊天室场景说明
 * 2. 参与者介绍
 * 3. 近期聊天历史
 * 4. 行为指引（回复长度、角色一致性等）
 */
function buildChatRoomContextPrompt(params: {
  characterId: string;
  displayName: string;
  participants: string[];
  recentMessages: ChatRoomMessage[];
  isInteraction: boolean;
  interactionHint?: string;
}): string {
  const { characterId, displayName, participants, recentMessages, isInteraction, interactionHint } = params;
  const t = getCharacterAgentL10n();

  const parts: string[] = [];

  // ── 1. 场景说明 ──
  parts.push(t.chatRoomTitle);
  parts.push(t.chatRoomIntro);
  parts.push(fillTemplate(t.chatRoomYouAre, { displayName }));
  parts.push(fillTemplate(t.chatRoomParticipants, { participants: participants.join(t.participantSeparator) }));
  parts.push(``);

  // ── 2. 近期聊天历史 ──
  if (recentMessages.length > 0) {
    parts.push(t.chatHistoryTitle);
    for (const msg of recentMessages) {
      const icon = msg.senderType === "user"
        ? "👤"
        : (CHARACTER_ICONS[msg.senderId]?.icon ?? "💬");
      parts.push(`${icon} ${msg.senderDisplayName}：${msg.content}`);
    }
    parts.push(``);
  }

  // ── 3. 互动指引（互评/自由聊天时） ──
  if (isInteraction && interactionHint) {
    parts.push(interactionHint);
    parts.push(``);
  }

  // ── 4. 行为守则 ──
  parts.push(t.chatRulesTitle);
  for (const rule of t.chatRules) {
    parts.push(rule);
  }

  return parts.join("\n");
}

// ============================================================================
// 核心：生成角色回复
// ============================================================================

/**
 * 以指定角色身份生成聊天室回复
 *
 * @param characterId - 角色 ID（如 "lina"、"demerzel"、"dolores"）
 * @param userMessage - 用户消息
 * @param participants - 参与者 ID 列表
 * @param recentMessages - 近期聊天历史
 * @param config - Clawdbot 配置（用于 LLM 调用）
 * @param chatroomConfig - 聊天室配置
 * @param isInteraction - 是否为互动轮次
 * @param interactionHint - 互动指引文本
 * @returns 角色响应
 */
export async function generateCharacterResponse(params: {
  characterId: string;
  userMessage: string;
  participants: string[];
  recentMessages: ChatRoomMessage[];
  config?: ClawdbotConfig;
  chatroomConfig?: Partial<ChatRoomConfig>;
  isInteraction?: boolean;
  /** 回复风格（dialogue/action/mixed） */
  replyStyle?: ReplyStyle;
  interactionHint?: string;
  /** agent session key（用于记忆工具的工作区路径解析） */
  agentSessionKey?: string;
  /** 是否启用记忆桥接（默认 true） */
  enableMemory?: boolean;
  /** 复杂度感知提示（来自 register.ts 的意图复杂度分析） */
  complexityHint?: string;
}): Promise<CharacterResponse> {
  const {
    characterId,
    userMessage,
    participants,
    recentMessages,
    config,
    chatroomConfig,
    isInteraction = false,
    replyStyle = "mixed",
    interactionHint,
    agentSessionKey,
    enableMemory = true,
    complexityHint,
  } = params;
  const cfg = { ...DEFAULT_CHATROOM_CONFIG, ...chatroomConfig };
  const started = Date.now();

  try {
    // 0. 获取 l10n 配置
    const t = getCharacterAgentL10n();

    // 1. 加载角色人格
    const loaded = await loadCharacterSystemPrompt(characterId);
    if (!loaded) {
      return {
        characterId,
        displayName: characterId,
        content: fillTemplate(t.characterUnavailable, { name: characterId }),
        durationMs: Date.now() - started,
        ok: false,
        error: t.characterLoadFailed,
      };
    }

    // 2. 预取记忆上下文（Phase A）
    let memoryContextText = "";
    let memoryContextCount = 0;
    if (enableMemory && config) {
      const snippets = await fetchMemoryContext(
        characterId,
        userMessage,
        config,
        agentSessionKey,
      );
      memoryContextCount = snippets.length;
      if (snippets.length > 0) {
        memoryContextText = formatMemoryContextForPrompt(snippets, characterId);
      }
    }

    // 3. 构建聊天室上下文补丁
    const chatRoomContext = buildChatRoomContextPrompt({
      characterId,
      displayName: loaded.displayName,
      participants: participants.map((id) => {
        const icon = CHARACTER_ICONS[id]?.icon ?? "";
        return `${icon}${id}`;
      }),
      recentMessages,
      isInteraction,
      interactionHint,
    });

    // 4. 组装完整 prompt（system prompt + 记忆上下文 + 记忆写入指引 + 聊天室上下文 + 用户消息）
    const promptParts = [
      `${t.roleSettingTitle}\n\n${loaded.systemPrompt}`,
    ];
    // 注入记忆上下文（如有）
    if (memoryContextText) {
      promptParts.push(`\n\n${memoryContextText}`);
    }
    promptParts.push(`\n\n${chatRoomContext}`);
    // 注入复杂度感知提示（如有）
    if (complexityHint) {
      promptParts.push(`\n\n${complexityHint}`);
    }
    promptParts.push(`\n\n${buildReplyStyleInstruction(replyStyle)}`);
    promptParts.push(`\n\n${t.masterMessageTitle}\n\n${userMessage}`);
    promptParts.push(`\n\n${fillTemplate(t.replyInstruction, { displayName: loaded.displayName })}`);
    const fullPrompt = promptParts.join("");

    // 5. 调用 LLM（工具模式：runEmbeddedPiAgent + toolAllowlist）
    // chatroom 中要求：允许有限工具（文件读写/编辑/补丁 + memory CRUD），屏蔽网络/exec 等。
    log.info(
      `[CharacterAgent] 调用 LLM(tool-runner): ${characterId} (${loaded.displayName}), ` +
        `prompt长度=${fullPrompt.length}, allowlist=${CHATROOM_TOOL_ALLOWLIST.join(",")}`,
    );

    // 为每次角色调用创建隔离 session 文件，避免污染主 session
    const taskId = crypto.randomUUID().slice(0, 8);
    const sessionDir = path.join(os.homedir(), ".clawdbot", "chatroom-runs");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `chat_${characterId}_${taskId}.jsonl`);
    const sessionId = `chatroom-${characterId}-${taskId}`;

    const { provider, model } = resolveProviderModel(config);
    const workspaceDir = resolveChatroomWorkspaceDir({ config, agentSessionKey });

    const runResult = await runEmbeddedPiAgent({
      sessionId,
      sessionKey: agentSessionKey,
      messageProvider: "chatroom",
      sessionFile,
      workspaceDir,
      config,
      prompt: fullPrompt,
      provider,
      model,
      timeoutMs: cfg.llmTimeoutMs,
      runId: crypto.randomUUID(),
      toolAllowlist: CHATROOM_TOOL_ALLOWLIST,
      skipBootstrapContext: true,
      enqueue: (task) => task(),
    });

    const contentParts: string[] = [];
    if (runResult.payloads) {
      for (const p of runResult.payloads) {
        if (p.text && !p.isError) contentParts.push(p.text);
      }
    }
    const rawResponseText = contentParts.join("\n\n");
    const durationMs = Date.now() - started;

    log.info(
      `[CharacterAgent] ${characterId} 响应完成(tool-runner): ${rawResponseText.length}字, ` +
        `${durationMs}ms, tools=${runResult.toolMetas?.length ?? 0}`,
    );

    const cleanedText = rawResponseText.trim();
    const memoryActionResults = undefined;

    return {
      characterId,
      displayName: loaded.displayName,
      content: cleanedText.trim(),
      durationMs,
      ok: true,
      memoryActions: memoryActionResults,
      memoryContextCount: memoryContextCount || undefined,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    log.error(`[CharacterAgent] ${characterId} 调用失败 (${durationMs}ms): ${err}`);

    // 加载 displayName 用于错误响应
    let displayName = characterId;
    try {
      const svc = getCharacterService();
      const loaded = await svc.loadCharacter(characterId);
      if (loaded) displayName = loaded.config.displayName;
    } catch { /* 忽略 */ }

    return {
      characterId,
      displayName,
      content: fillTemplate(getCharacterAgentL10n().characterThinking, { displayName }),
      durationMs,
      ok: false,
      error: String(err),
    };
  }
}

/**
 * 清除所有缓存（角色 persona + LLM caller）
 */
export function clearPersonaCache(): void {
  personaCache.clear();
  log.debug("[CharacterAgent] Persona + LLM caller cache cleared");
}

// ============================================================================
// 协作任务：领头角色带工具执行（runEmbeddedPiAgent）
// ============================================================================

/** 协作任务 LLM 超时：5 分钟（复杂任务需要更多时间） */
const COLLAB_TIMEOUT_MS = 300_000;

/**
 * 以指定角色身份执行带工具的完整 agent loop（协作任务专用）
 *
 * 与 generateCharacterResponse 不同，此方法使用 runEmbeddedPiAgent
 * 而非 completeSimple，让角色获得完整的工具能力：
 * enqueue_task / 记忆 CRUD / 文件操作 / Web / 技能 / continue_generation
 *
 * 调用时绕过 lane 排队（enqueue: inline），因为当前已在 hook 中执行。
 */
export async function executeLeadCharacterWithTools(params: {
  characterId: string;
  userMessage: string;
  participants: string[];
  /** 其他角色的规划讨论（Phase 1 产出，注入领头角色上下文） */
  planningContext: string;
  collaborativeContext: CollaborativeTaskContext;
  config?: ClawdbotConfig;
}): Promise<CharacterResponse> {
  const {
    characterId,
    userMessage,
    participants,
    planningContext,
    collaborativeContext,
    config,
  } = params;
  const started = Date.now();

  try {
    // 0. 获取 l10n 配置
    const t = getCharacterAgentL10n();

    // 1. 加载角色人格
    const loaded = await loadCharacterSystemPrompt(characterId);
    if (!loaded) {
      return {
        characterId,
        displayName: characterId,
        content: fillTemplate(t.collabCharacterLoadFailed, { name: characterId }),
        durationMs: Date.now() - started,
        ok: false,
        error: t.characterLoadFailed,
      };
    }

    // 2. 创建隔离的 session 文件（避免污染主 session）
    const taskId = crypto.randomUUID().slice(0, 8);
    const sessionDir = path.join(os.homedir(), ".clawdbot", "chatroom-collab");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `collab_${taskId}.jsonl`);
    const sessionId = `collab-${taskId}`;

    // 3. 构建增强 system prompt（角色人格 + 协作上下文 + 能力清单）
    const participantList = participants
      .map((id) => {
        const icon = CHARACTER_ICONS[id]?.icon ?? "💬";
        return `${icon}${id}`;
      })
      .join(t.participantSeparator);

    const extraParts: string[] = [
      `${t.roleSettingTitle}\n\n${loaded.systemPrompt}`,
      `\n\n${t.collabTitle}`,
      fillTemplate(t.collabLeadIntro, { displayName: loaded.displayName }),
      fillTemplate(t.chatRoomParticipants, { participants: participantList }),
    ];

    // 注入姐妹们的规划讨论
    if (planningContext) {
      extraParts.push(
        `\n\n${t.collabPlanningTitle}\n${t.collabPlanningIntro}`,
        planningContext,
      );
    }

    // 注入复杂度分析
    if (collaborativeContext.complexityReason) {
      extraParts.push(
        `\n\n${t.collabComplexityTitle}\n${collaborativeContext.complexityReason}`,
      );
    }

    extraParts.push(
      `\n\n${t.collabCapabilitiesTitle}`,
      t.collabCapabilitiesIntro,
      t.collabCapabilityEnqueue,
      t.collabCapabilityMemory,
      t.collabCapabilityContinue,
      t.collabCapabilityFile,
      t.collabCapabilityWeb,
      `\n${t.collabClosingInstruction}`,
    );

    const extraSystemPrompt = extraParts.filter(Boolean).join("\n");

    // 4. 解析 provider/model（优先使用显式指定，回退到 config 默认值）
    // 严格使用用户配置的 primaryProviderId/primaryModelId，不私自 fallback 到任何硬编码模型。
    const effectiveConfig = collaborativeContext.config ?? config;
    const agentDefaults = (effectiveConfig as Record<string, any>)?.agents?.defaults;
    const modelCfg = agentDefaults?.model;
    const provider =
      collaborativeContext.provider ??
      modelCfg?.primaryProviderId ??
      agentDefaults?.provider ??
      "pi-ai";
    const model =
      collaborativeContext.model ??
      modelCfg?.primaryModelId ??
      modelCfg?.id ??
      undefined;

    log.info(
      `[CharacterAgent] 🤝 协作任务执行: ${characterId} (${loaded.displayName}), ` +
      `provider=${provider}, model=${model}, prompt=${userMessage.length}字`,
    );

    // 5. 调用 runEmbeddedPiAgent（全工具 agent loop）
    //    enqueue: inline 绕过 lane 排队，避免与外层 hook 死锁
    const runResult = await runEmbeddedPiAgent({
      sessionId,
      sessionKey: `collab-${taskId}`,
      messageProvider: collaborativeContext.messageProvider,
      sessionFile,
      workspaceDir: collaborativeContext.workspaceDir,
      config: effectiveConfig,
      prompt: userMessage,
      provider,
      model,
      authProfileId: collaborativeContext.authProfileId,
      timeoutMs: COLLAB_TIMEOUT_MS,
      runId: crypto.randomUUID(),
      extraSystemPrompt,
      enqueue: (task) => task(),
    });

    // 6. 提取输出文本
    const contentParts: string[] = [];
    if (runResult.payloads) {
      for (const p of runResult.payloads) {
        if (p.text && !p.isError) contentParts.push(p.text);
      }
    }
    const outputText =
      contentParts.join("\n\n") || t.collabNoOutput;
    const durationMs = Date.now() - started;

    log.info(
      `[CharacterAgent] 🤝 协作执行完成: ${characterId}, ` +
      `${outputText.length}字, ${durationMs}ms, ` +
      `tools=${runResult.toolMetas?.length ?? 0}`,
    );

    return {
      characterId,
      displayName: loaded.displayName,
      content: outputText,
      durationMs,
      ok: true,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    log.error(`[CharacterAgent] 🤝 协作执行失败 (${characterId}, ${durationMs}ms): ${err}`);

    let displayName = characterId;
    try {
      const svc = getCharacterService();
      const loaded = await svc.loadCharacter(characterId);
      if (loaded) displayName = loaded.config.displayName;
    } catch { /* 忽略 */ }

    return {
      characterId,
      displayName,
      content: fillTemplate(getCharacterAgentL10n().collabError, { displayName, error: String(err).slice(0, 200) }),
      durationMs,
      ok: false,
      error: String(err),
    };
  }
}
