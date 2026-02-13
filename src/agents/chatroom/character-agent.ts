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

import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCharacterService } from "../pipeline/characters/character-service.js";
import { createSystemLLMCaller } from "../intelligent-task-decomposition/system-llm-caller.js";
import type { ChatRoomMessage, CharacterResponse, ChatRoomConfig } from "./types.js";
import { DEFAULT_CHATROOM_CONFIG, CHARACTER_ICONS } from "./types.js";
import {
  fetchMemoryContext,
  formatMemoryContextForPrompt,
  buildMemoryWriteGuide,
  parseMemoryActions,
  executeMemoryActions,
} from "./memory-bridge.js";

const log = createSubsystemLogger("chatroom:agent");

// ============================================================================
// 角色缓存（prompt + displayName 一体化，避免缓存命中时仍调 loadCharacter）
// ============================================================================

interface CachedPersona {
  systemPrompt: string;
  displayName: string;
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

  const parts: string[] = [];

  // ── 1. 场景说明 ──
  parts.push(`## 🏠 爱姬聊天室`);
  parts.push(`你正在与主人和其他姐妹一起在聊天室中。`);
  parts.push(`你是 ${displayName}，请用你自己独特的风格和视角回答。`);
  parts.push(`参与者：${participants.join("、")}`);
  parts.push(``);

  // ── 2. 近期聊天历史 ──
  if (recentMessages.length > 0) {
    parts.push(`## 聊天记录`);
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
  parts.push(`## 聊天室守则`);
  parts.push(`- 用你自己的风格和视角回答主人的问题`);
  parts.push(`- 可以引用或回应其他姐妹的观点，但要有自己的见解`);
  parts.push(`- 回复控制在 200-500 字以内，简洁有力`);
  parts.push(`- 保持角色一致性，不要出戏`);
  parts.push(`- 不要重复其他姐妹已经说过的内容`);
  parts.push(`- 展现你独特的思维方式和知识背景`);

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
  interactionHint?: string;
  /** agent session key（用于记忆工具的工作区路径解析） */
  agentSessionKey?: string;
  /** 是否启用记忆桥接（默认 true） */
  enableMemory?: boolean;
}): Promise<CharacterResponse> {
  const {
    characterId,
    userMessage,
    participants,
    recentMessages,
    config,
    chatroomConfig,
    isInteraction = false,
    interactionHint,
    agentSessionKey,
    enableMemory = true,
  } = params;
  const cfg = { ...DEFAULT_CHATROOM_CONFIG, ...chatroomConfig };
  const started = Date.now();

  try {
    // 1. 加载角色人格
    const loaded = await loadCharacterSystemPrompt(characterId);
    if (!loaded) {
      return {
        characterId,
        displayName: characterId,
        content: `（${characterId} 暂时无法回应）`,
        durationMs: Date.now() - started,
        ok: false,
        error: "角色加载失败",
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
      `# 角色设定\n\n${loaded.systemPrompt}`,
    ];
    // 注入记忆上下文（如有）
    if (memoryContextText) {
      promptParts.push(`\n\n${memoryContextText}`);
    }
    // 注入记忆写入指引
    if (enableMemory && config) {
      promptParts.push(`\n\n${buildMemoryWriteGuide(characterId)}`);
    }
    promptParts.push(`\n\n${chatRoomContext}`);
    promptParts.push(`\n\n# 主人的消息\n\n${userMessage}`);
    promptParts.push(`\n\n请以 ${loaded.displayName} 的身份回复。直接输出回复内容，不要加任何前缀标签。`);
    const fullPrompt = promptParts.join("");

    // 5. 调用 LLM（复用缓存的 caller 实例）
    log.info(`[CharacterAgent] 调用 LLM: ${characterId} (${loaded.displayName}), prompt 长度=${fullPrompt.length}`);

    const llmCaller = getCachedLLMCaller(config, cfg);

    const rawResponseText = await llmCaller.call(fullPrompt);
    const durationMs = Date.now() - started;

    log.info(`[CharacterAgent] ${characterId} 响应完成: ${rawResponseText.length}字, ${durationMs}ms`);

    // 6. 解析并执行记忆动作（Phase B）
    const { actions, cleanedText } = parseMemoryActions(rawResponseText);
    let memoryActionResults: import("./types.js").MemoryActionResult[] | undefined;
    if (actions.length > 0 && enableMemory && config) {
      const results = await executeMemoryActions(actions, config, agentSessionKey);
      if (results.length > 0) memoryActionResults = results;
    }

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
      content: `（${displayName} 正在思考中，稍后再来……）`,
      durationMs,
      ok: false,
      error: String(err),
    };
  }
}

// ============================================================================
// LLM Caller 单例缓存（避免每次调用都重建）
// ============================================================================

let cachedLLMCaller: { caller: ReturnType<typeof createSystemLLMCaller>; key: string } | null = null;

/**
 * 获取缓存的 LLM caller 实例
 *
 * 当 config/chatroom 参数不变时复用同一实例，
 * 参数变化时自动重建。
 */
function getCachedLLMCaller(
  config: ClawdbotConfig | undefined,
  chatroomCfg: ChatRoomConfig,
): ReturnType<typeof createSystemLLMCaller> {
  // key 含 LLM 参数 + config 指纹（provider 变化时重建 caller）
  const cfgFingerprint = config ? JSON.stringify(config.models?.providers ?? {}).slice(0, 80) : "nocfg";
  const key = `${chatroomCfg.maxOutputTokens}:${chatroomCfg.temperature}:${chatroomCfg.llmTimeoutMs}:${cfgFingerprint}`;
  if (cachedLLMCaller && cachedLLMCaller.key === key) {
    return cachedLLMCaller.caller;
  }
  const caller = createSystemLLMCaller({
    config,
    maxTokens: chatroomCfg.maxOutputTokens,
    temperature: chatroomCfg.temperature,
    timeoutMs: chatroomCfg.llmTimeoutMs,
  });
  cachedLLMCaller = { caller, key };
  return caller;
}

/**
 * 清除所有缓存（角色 persona + LLM caller）
 */
export function clearPersonaCache(): void {
  personaCache.clear();
  cachedLLMCaller = null;
  log.debug("[CharacterAgent] Persona + LLM caller cache cleared");
}
