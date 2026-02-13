/**
 * 爱姬聊天室 — 编排器
 *
 * 聊天室的总调度中枢：
 * 1. 协调多角色的 LLM 调用（支持错峰/串行/并行策略）
 * 2. 管理聊天室会话生命周期
 * 3. 处理互评/自由聊天互动轮次
 * 4. 执行对话次数限制
 *
 * 设计原则：
 * - 复用 CharacterService + SystemLLMCaller，不引入新依赖
 * - 错峰调用为默认策略，防止 API 并发限流
 * - 每位角色的 LLM 调用完全独立，一个失败不影响其他
 *
 * @module agents/chatroom/orchestrator
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { generateCharacterResponse, getCharacterDisplayName } from "./character-agent.js";
import {
  formatOpeningMessage,
  formatResponses,
  formatInteractionResponses,
  formatClosingMessage,
  formatLimitReachedMessage,
} from "./formatter.js";
import {
  getOrCreateSession,
  getActiveSession,
  addUserMessage,
  addCharacterMessage,
  canCharacterReply,
  canContinue,
  setInteractionMode,
  closeSession,
  getRecentMessages,
} from "./session.js";
import type {
  CallStrategy,
  CharacterResponse,
  ChatRoomConfig,
  ChatRoomHandleParams,
  InteractionMode,
  MemoryActionResult,
} from "./types.js";
import { DEFAULT_CHATROOM_CONFIG, CHARACTER_ICONS } from "./types.js";

const log = createSubsystemLogger("chatroom:orchestrator");

// ============================================================================
// 核心编排器
// ============================================================================

/**
 * 处理聊天室消息（主入口）
 *
 * 完整流程：
 * 1. 发送开场白（首次进入时）
 * 2. 记录用户消息到会话历史
 * 3. 按策略调用多角色 LLM
 * 4. 收集回答 → 记录到会话 → 格式化 → 发送
 * 5. (可选) 触发互动轮次
 * 6. 检查限制，必要时关闭聊天室
 */
export async function handleChatRoomMessage(
  params: ChatRoomHandleParams,
  config?: ClawdbotConfig,
  chatroomConfig?: Partial<ChatRoomConfig>,
): Promise<void> {
  const cfg = { ...DEFAULT_CHATROOM_CONFIG, ...chatroomConfig };
  const {
    userMessage,
    participants,
    sessionKey,
    sendReply,
    callStrategy = "staggered",
    interactionMode = null,
    agentSessionKey,
  } = params;

  log.info(
    `[Orchestrator] 聊天室消息: participants=${participants.join(",")}, ` +
    `strategy=${callStrategy}, interaction=${interactionMode ?? "none"}`,
  );

  // ── 1. 获取/创建会话 ──
  const existingSession = getActiveSession(sessionKey);
  const isNewSession = !existingSession;
  const session = getOrCreateSession(sessionKey, participants, cfg);

  // ── 2. 加载角色显示名（轻量操作，只读 CharacterService 不调 LLM） ──
  const displayNames: Record<string, string> = {};
  await Promise.all(
    session.participants.map(async (id) => {
      displayNames[id] = await getCharacterDisplayName(id);
    }),
  );
  // 写入 session 供 formatter/stats 全局使用
  session.displayNames = displayNames;

  // ── 3. 首次进入：发送开场白 ──
  if (isNewSession) {
    const opening = formatOpeningMessage(participants, displayNames);
    await sendReply(opening);
    log.info(`[Orchestrator] 聊天室开启: ${session.sessionId}`);
  }

  // ── 4. 记录用户消息 ──
  addUserMessage(session, userMessage);

  // ── 5. 检查是否还能继续 ──
  if (!canContinue(session, cfg)) {
    const closing = formatClosingMessage(session);
    await sendReply(closing);
    closeSession(sessionKey);
    log.info(`[Orchestrator] 聊天室达到上限，关闭: ${session.sessionId}`);
    return;
  }

  // ── 6. 设置互动模式 ──
  if (interactionMode) {
    setInteractionMode(session, interactionMode);
  }

  // ── 7. 调用多角色 LLM ──
  const recentMessages = getRecentMessages(session, 10);

  // 过滤掉已达上限的角色
  const activeParticipants = session.participants.filter((id) =>
    canCharacterReply(session, id, cfg),
  );

  if (activeParticipants.length === 0) {
    await sendReply(formatLimitReachedMessage("", "", "total"));
    const closing = formatClosingMessage(session);
    await sendReply(closing);
    closeSession(sessionKey);
    return;
  }

  // 提示已达上限的角色
  for (const id of session.participants) {
    if (!activeParticipants.includes(id)) {
      await sendReply(formatLimitReachedMessage(id, displayNames[id] ?? id, "character"));
    }
  }

  const responses = await callMultipleAgents({
    characterIds: activeParticipants,
    userMessage,
    participants: session.participants,
    recentMessages,
    config,
    chatroomConfig: cfg,
    callStrategy,
    isInteraction: false,
    agentSessionKey,
  });

  // ── 7.5 汇总记忆动作结果（诊断日志）──
  logMemoryActions(responses);

  // ── 8. 记录角色回答到会话 ──
  for (const resp of responses) {
    addCharacterMessage(session, resp.characterId, resp.displayName, resp.content);
  }

  // ── 9. 格式化并发送回答 ──
  const formattedResponse = formatResponses(responses, session);
  await sendReply(formattedResponse);

  // ── 10. 触发互动轮次（如果请求了） ──
  if (interactionMode && session.interactionRoundsExecuted < cfg.maxInteractionRounds) {
    await executeInteractionRound({
      session,
      responses,
      mode: interactionMode,
      config,
      chatroomConfig: cfg,
      callStrategy,
      sendReply,
      agentSessionKey,
    });
    session.interactionRoundsExecuted++;
  }

  // ── 11. 再次检查限制 ──
  if (!canContinue(session, cfg)) {
    const closing = formatClosingMessage(session);
    await sendReply(closing);
    closeSession(sessionKey);
    log.info(`[Orchestrator] 聊天室达到上限，关闭: ${session.sessionId}`);
  }
}

/**
 * 关闭聊天室并发送关闭消息
 */
export async function closeChatRoom(
  sessionKey: string,
  sendReply: (text: string) => Promise<void>,
): Promise<void> {
  const session = getActiveSession(sessionKey);
  if (session) {
    const closing = formatClosingMessage(session);
    await sendReply(closing);
    closeSession(sessionKey);
    log.info(`[Orchestrator] 聊天室手动关闭: ${session.sessionId}`);
  }
}

// ============================================================================
// LLM 调用策略
// ============================================================================

interface MultiAgentCallParams {
  characterIds: string[];
  userMessage: string;
  participants: string[];
  recentMessages: import("./types.js").ChatRoomMessage[];
  config?: ClawdbotConfig;
  chatroomConfig: ChatRoomConfig;
  callStrategy: CallStrategy;
  isInteraction: boolean;
  interactionHint?: string;
  /** 原始回答列表（互动轮次用，sequential 模式下构建渐进式上下文） */
  previousResponses?: CharacterResponse[];
  /** 互动模式类型（sequential 渐进式构建需要） */
  interactionMode?: InteractionMode;
  /** agent session key（记忆工具工作区路径解析） */
  agentSessionKey?: string;
}

/**
 * 按策略调用多个角色的 LLM
 *
 * 三种策略：
 * - staggered（默认）：错峰调用，每个间隔 callStaggerDelayMs 启动
 * - sequential：完全串行，逐个调用等待结果
 * - parallel：完全并行（Promise.allSettled）
 */
async function callMultipleAgents(params: MultiAgentCallParams): Promise<CharacterResponse[]> {
  const {
    characterIds,
    userMessage,
    participants,
    recentMessages,
    config,
    chatroomConfig,
    callStrategy,
    isInteraction,
    interactionHint,
  } = params;

  const callParams = characterIds.map((id) => ({
    characterId: id,
    userMessage,
    participants,
    recentMessages,
    config,
    chatroomConfig,
    isInteraction,
    interactionHint,
    agentSessionKey: params.agentSessionKey,
  }));

  switch (callStrategy) {
    case "parallel": {
      log.info(`[Orchestrator] 并行调用 ${characterIds.length} 个角色`);
      const settled = await Promise.allSettled(
        callParams.map((p) => generateCharacterResponse(p)),
      );
      return settled.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : {
              characterId: characterIds[i],
              displayName: characterIds[i],
              content: `（${characterIds[i]} 暂时无法回应）`,
              durationMs: 0,
              ok: false,
              error: String(r.reason),
            },
      );
    }

    case "sequential": {
      log.info(`[Orchestrator] 串行调用 ${characterIds.length} 个角色`);
      const results: CharacterResponse[] = [];
      for (let i = 0; i < callParams.length; i++) {
        const p = callParams[i];

        // 渐进式上下文：互动模式下，后发言者能看到前面姐妹的互评内容
        if (isInteraction && params.previousResponses && params.interactionMode && i > 0) {
          const progressiveHint = buildProgressiveInteractionHint(
            params.previousResponses,
            results.filter((r) => r.ok), // 前面姐妹已完成的互评
            params.interactionMode,
          );
          p.interactionHint = progressiveHint;
        }

        try {
          const resp = await generateCharacterResponse(p);
          results.push(resp);
        } catch (err) {
          results.push({
            characterId: p.characterId,
            displayName: p.characterId,
            content: `（${p.characterId} 暂时无法回应）`,
            durationMs: 0,
            ok: false,
            error: String(err),
          });
        }
      }
      return results;
    }

    case "staggered":
    default: {
      // 错峰调用：启动每个调用之间间隔 callStaggerDelayMs
      // 但不等待前一个完成——相当于"延迟启动的并行"
      log.info(
        `[Orchestrator] 错峰调用 ${characterIds.length} 个角色, ` +
        `间隔=${chatroomConfig.callStaggerDelayMs}ms`,
      );

      const promises: Promise<CharacterResponse>[] = [];
      for (let i = 0; i < callParams.length; i++) {
        const p = callParams[i];
        // 第一个立即启动，后续延迟
        if (i > 0) {
          await sleep(chatroomConfig.callStaggerDelayMs);
        }
        promises.push(
          generateCharacterResponse(p).catch((err) => ({
            characterId: p.characterId,
            displayName: p.characterId,
            content: `（${p.characterId} 暂时无法回应）`,
            durationMs: 0,
            ok: false,
            error: String(err),
          })),
        );
      }
      return Promise.all(promises);
    }
  }
}

// ============================================================================
// 互动轮次
// ============================================================================

interface InteractionRoundParams {
  session: import("./types.js").ChatRoomSession;
  responses: CharacterResponse[];
  mode: InteractionMode;
  config?: ClawdbotConfig;
  chatroomConfig: ChatRoomConfig;
  callStrategy: CallStrategy;
  sendReply: (text: string) => Promise<void>;
  agentSessionKey?: string;
}

/**
 * 执行一轮互动（互评/自由聊天/辩论）
 *
 * 将前一轮所有回答注入每位角色的上下文，让她们"看到"彼此的回答。
 */
async function executeInteractionRound(params: InteractionRoundParams): Promise<void> {
  const { session, responses, mode, config, chatroomConfig, callStrategy, sendReply } = params;

  log.info(`[Orchestrator] 互动轮次: mode=${mode}, round=${session.interactionRoundsExecuted + 1}`);

  // 构建互动上下文提示
  const interactionHint = buildInteractionHint(responses, mode);

  // 收集最近消息（含刚才的回答）
  const recentMessages = getRecentMessages(session, 15);

  // 过滤掉已达上限的角色
  const activeParticipants = session.participants.filter((id) =>
    canCharacterReply(session, id, chatroomConfig),
  );

  if (activeParticipants.length < 2) {
    log.info(`[Orchestrator] 活跃参与者不足 2 人，跳过互动轮次`);
    return;
  }

  // 调用（互评模式：串行更自然；自由聊天/辩论：错峰）
  const effectiveStrategy: CallStrategy = mode === "review" ? "sequential" : callStrategy;

  const interactionResponses = await callMultipleAgents({
    characterIds: activeParticipants,
    userMessage: `（互动轮次 — ${getModeLabel(mode)}）`,
    participants: session.participants,
    recentMessages,
    config,
    chatroomConfig,
    callStrategy: effectiveStrategy,
    isInteraction: true,
    interactionHint,
    previousResponses: responses,
    interactionMode: mode,
    agentSessionKey: params.agentSessionKey,
  });

  // 记录到会话
  for (const resp of interactionResponses) {
    addCharacterMessage(session, resp.characterId, resp.displayName, resp.content, true);
  }

  // 格式化并发送
  const formatted = formatInteractionResponses(interactionResponses, mode);
  await sendReply(formatted);
}

/**
 * 构建互动上下文提示
 */
function buildInteractionHint(
  previousResponses: CharacterResponse[],
  mode: InteractionMode,
): string {
  const parts: string[] = [];

  parts.push(`## 其他姐妹的回答`);
  parts.push(`以下是姐妹们刚才的回答，你可以看到她们说了什么：`);
  parts.push(``);

  for (const resp of previousResponses) {
    const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
    parts.push(`### ${icon} ${resp.displayName} 说：`);
    parts.push(resp.content);
    parts.push(``);
  }

  parts.push(`---`);
  switch (mode) {
    case "review":
      parts.push(`请对姐妹们的回答发表你的看法。可以赞同、补充、或提出不同意见。保持你自己的风格，200-400字以内。`);
      break;
    case "free_chat":
      parts.push(`请自由回应。你可以接着聊、提出新观点、或对姐妹的话做出反应。像真实对话一样自然，200-400字以内。`);
      break;
    case "debate":
      parts.push(`请针对这个话题阐述你的立场。可以反驳其他姐妹的观点，但保持友好。200-400字以内。`);
      break;
  }

  return parts.join("\n");
}

/**
 * 构建渐进式互动上下文提示（sequential 专用）
 *
 * 在原始回答基础上，追加前面姐妹已完成的互评内容，
 * 让后发言者获得更丰富的上下文，对话更自然。
 */
function buildProgressiveInteractionHint(
  originalResponses: CharacterResponse[],
  completedInteractions: CharacterResponse[],
  mode: InteractionMode,
): string {
  const parts: string[] = [];

  // 第一部分：原始回答（所有姐妹对主人问题的回答）
  parts.push(`## 姐妹们对主人问题的回答`);
  parts.push(``);
  for (const resp of originalResponses) {
    const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
    parts.push(`### ${icon} ${resp.displayName} 说：`);
    parts.push(resp.content);
    parts.push(``);
  }

  // 第二部分：已完成的互评（前面姐妹的互动发言）
  if (completedInteractions.length > 0) {
    parts.push(`## 姐妹们的${getModeLabel(mode)}（已发言）`);
    parts.push(``);
    for (const resp of completedInteractions) {
      const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
      parts.push(`### ${icon} ${resp.displayName} 的${getModeLabel(mode)}：`);
      parts.push(resp.content);
      parts.push(``);
    }
  }

  // 第三部分：行动指引
  parts.push(`---`);
  switch (mode) {
    case "review":
      parts.push(`请对姐妹们的回答和互评发表你的看法。你可以回应她们的观点，也可以提出自己的独特见解。保持你自己的风格，200-400字以内。`);
      break;
    case "free_chat":
      parts.push(`请自由回应。你可以接着聊、回应前面姐妹的话，或提出新观点。像真实对话一样自然，200-400字以内。`);
      break;
    case "debate":
      parts.push(`请针对这个话题阐述你的立场。可以回应前面姐妹的论点，支持或反驳，但保持友好。200-400字以内。`);
      break;
  }

  return parts.join("\n");
}

// ============================================================================
// 记忆动作日志
// ============================================================================

/**
 * 汇总并记录角色响应中的记忆动作结果
 */
function logMemoryActions(responses: CharacterResponse[]): void {
  for (const resp of responses) {
    if (!resp.memoryActions?.length) continue;
    const ok = resp.memoryActions.filter((a) => a.ok).length;
    const fail = resp.memoryActions.length - ok;
    log.info(
      `[Orchestrator] ${resp.displayName} 记忆动作: ${ok} 成功, ${fail} 失败` +
      (resp.memoryContextCount ? `, 预取 ${resp.memoryContextCount} 条记忆` : ""),
    );
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getModeLabel(mode: InteractionMode): string {
  const labels: Record<InteractionMode, string> = {
    review: "姐妹互评",
    free_chat: "自由聊天",
    debate: "观点辩论",
  };
  return labels[mode] ?? mode;
}
