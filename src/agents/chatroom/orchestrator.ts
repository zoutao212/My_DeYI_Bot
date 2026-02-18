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
import { generateCharacterResponse, getCharacterDisplayName, executeLeadCharacterWithTools } from "./character-agent.js";
import {
  formatOpeningMessage,
  formatResponses,
  formatInteractionResponses,
  formatClosingMessage,
  formatLimitReachedMessage,
  formatCollaborativeBanner,
  formatPlanningPhase,
  formatExecutionPhase,
  formatReviewPhase,
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
  CollaborativeTaskContext,
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
    complexityHint,
    collaborativeTaskMode,
    collaborativeContext,
    abortSignal,
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

  // ── 7. 协作任务模式 vs 普通模式 ──
  if (collaborativeTaskMode && collaborativeContext && await activeParticipantsCheck(session, cfg, sendReply, sessionKey, displayNames)) {
    // 🤝 协作任务三阶段流程（force_decompose 触发）
    await executeCollaborativeTask({
      session,
      userMessage,
      config,
      chatroomConfig: cfg,
      callStrategy,
      sendReply,
      agentSessionKey,
      collaborativeContext,
      displayNames,
    });
  } else if (!collaborativeTaskMode) {
    // 普通聊天室模式
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

    // ── 串行调用：每个角色回答后立即写入 session 并推送给用户，
    //    让后发言的角色能在 recentMessages 中看到前面姐妹的内容。
    //    每轮开始前检查中断信号，中断后停止后续角色的调用。
    const responses: CharacterResponse[] = [];
    let abortedBySignal = false;

    for (const characterId of activeParticipants) {
      // 中断检查：用户点击"中断"后停止后续角色
      if (abortSignal?.aborted) {
        abortedBySignal = true;
        log.info(`[Orchestrator] 🛑 中断信号触发，跳过角色: ${characterId}`);
        break;
      }

      const recentMessages = getRecentMessages(session, 10);
      const icon = CHARACTER_ICONS[characterId]?.icon ?? "💬";
      const displayName = displayNames[characterId] ?? characterId;

      // 发送"角色正在思考"的即时提示，让用户知道当前在等哪个角色
      await sendReply(`${icon} **${displayName}** 正在思考…`);

      try {
        const resp = await generateCharacterResponse({
          characterId,
          userMessage,
          participants: session.participants,
          recentMessages,
          config,
          chatroomConfig: cfg,
          isInteraction: false,
          agentSessionKey,
          complexityHint,
        });
        responses.push(resp);
        // 立即写入 session，让下一个角色能看到
        addCharacterMessage(session, resp.characterId, resp.displayName, resp.content);
        // 立即推送该角色的回答（不等其他角色）
        await sendReply(formatSingleCharacterResponse(resp, session, cfg));
      } catch (err) {
        const fallback: CharacterResponse = {
          characterId,
          displayName,
          content: `（${displayName} 暂时无法回应）`,
          durationMs: 0,
          ok: false,
          error: String(err),
        };
        responses.push(fallback);
        await sendReply(`${icon} **${displayName}**：（暂时无法回应）`);
      }
    }

    // 中断时发送提示
    if (abortedBySignal) {
      await sendReply(`🛑 **聊天室已中断**\n\n您可以继续发送新消息，角色们会重新回应。`);
    }

    // ── 7.5 汇总记忆动作结果（诊断日志）──
    logMemoryActions(responses);

    // ── 10. 触发互动轮次（未中断时才执行）──
    // 有明确互动模式时用指定模式；普通聊天室消息默认触发一轮 free_chat 互动，
    // 让角色之间互相回应，形成真正的多轮对话感。
    if (!abortedBySignal && responses.length > 0) {
      const effectiveInteractionMode = interactionMode ?? "free_chat";
      if (session.interactionRoundsExecuted < cfg.maxInteractionRounds) {
        await executeInteractionRound({
          session,
          responses,
          mode: effectiveInteractionMode,
          config,
          chatroomConfig: cfg,
          callStrategy,
          sendReply,
          agentSessionKey,
          abortSignal,
        });
        session.interactionRoundsExecuted++;
      }
    }
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
  /** 复杂度感知提示（注入角色 prompt，让角色知道任务的复杂度） */
  complexityHint?: string;
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
    complexityHint: params.complexityHint,
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
  abortSignal?: AbortSignal;
}

/**
 * 执行一轮互动（互评/自由聊天/辩论）
 *
 * 将前一轮所有回答注入每位角色的上下文，让她们"看到"彼此的回答。
 */
async function executeInteractionRound(params: InteractionRoundParams): Promise<void> {
  const { session, responses, mode, config, chatroomConfig, sendReply, abortSignal } = params;

  log.info(`[Orchestrator] 互动轮次: mode=${mode}, round=${session.interactionRoundsExecuted + 1}`);

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

  // 发送互动轮次标题
  await sendReply(`🔄 **${getModeLabel(mode)}** ———`);

  // 串行调用：逐角色推送，后发言者能看到前面姐妹的互动内容
  const interactionResponses: CharacterResponse[] = [];

  for (let i = 0; i < activeParticipants.length; i++) {
    const characterId = activeParticipants[i];

    // 中断检查
    if (abortSignal?.aborted) {
      log.info(`[Orchestrator] 🛑 互动轮次中断，跳过角色: ${characterId}`);
      break;
    }

    const icon = CHARACTER_ICONS[characterId]?.icon ?? "💬";
    const displayName = session.displayNames?.[characterId] ?? characterId;

    // 渐进式上下文：后发言者能看到前面姐妹已完成的互评内容
    const interactionHint = i === 0
      ? buildInteractionHint(responses, mode)
      : buildProgressiveInteractionHint(
          responses,
          interactionResponses.filter((r) => r.ok),
          mode,
        );

    // 发送"正在思考"提示
    await sendReply(`${icon} **${displayName}** 正在回应…`);

    try {
      const resp = await generateCharacterResponse({
        characterId,
        userMessage: `（互动轮次 — ${getModeLabel(mode)}）`,
        participants: session.participants,
        recentMessages,
        config,
        chatroomConfig,
        isInteraction: true,
        interactionHint,
        agentSessionKey: params.agentSessionKey,
      });
      interactionResponses.push(resp);
      addCharacterMessage(session, resp.characterId, resp.displayName, resp.content, true);

      // 立即推送该角色的互动回复
      const otherNames = responses
        .filter((r) => r.characterId !== resp.characterId)
        .map((r) => {
          const rIcon = CHARACTER_ICONS[r.characterId]?.icon ?? "💬";
          return `${rIcon}${r.displayName}`;
        })
        .join(" & ");
      const header = (mode === "review" || mode === "debate")
        ? `${icon} **${resp.displayName}** → 评 ${otherNames}：`
        : `${icon} **${resp.displayName}**：`;
      await sendReply(`${header}\n\n${resp.content}`);
    } catch (err) {
      const fallback: CharacterResponse = {
        characterId,
        displayName,
        content: `（${displayName} 暂时无法回应）`,
        durationMs: 0,
        ok: false,
        error: String(err),
      };
      interactionResponses.push(fallback);
      await sendReply(`${icon} **${displayName}**：（暂时无法回应）`);
    }
  }

  await sendReply(`🔄 ${getModeLabel(mode)}结束 ———`);
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
// 协作任务三阶段流程
// ============================================================================

/** 协作任务审查上下文截断上限（避免 Phase 3 prompt 过长） */
const REVIEW_CONTEXT_MAX_CHARS = 3000;

/**
 * 检查活跃参与者（公共守卫，协作/普通模式复用）
 */
async function activeParticipantsCheck(
  session: import("./types.js").ChatRoomSession,
  cfg: ChatRoomConfig,
  sendReply: (text: string) => Promise<void>,
  sessionKey: string,
  displayNames: Record<string, string>,
): Promise<boolean> {
  const activeParticipants = session.participants.filter((id) =>
    canCharacterReply(session, id, cfg),
  );
  if (activeParticipants.length === 0) {
    await sendReply(formatLimitReachedMessage("", "", "total"));
    await sendReply(formatClosingMessage(session));
    closeSession(sessionKey);
    return false;
  }
  return true;
}

interface CollaborativeTaskParams {
  session: import("./types.js").ChatRoomSession;
  userMessage: string;
  config?: ClawdbotConfig;
  chatroomConfig: ChatRoomConfig;
  callStrategy: CallStrategy;
  sendReply: (text: string) => Promise<void>;
  agentSessionKey?: string;
  collaborativeContext: CollaborativeTaskContext;
  displayNames: Record<string, string>;
}

/**
 * 协作任务三阶段执行流程
 *
 * Phase 1（规划）：所有角色讨论任务方案（completeSimple，轻量快速）
 * Phase 2（执行）：领头角色使用 runEmbeddedPiAgent（全工具 agent loop）
 * Phase 3（互检）：其他角色审查领头角色的产出（completeSimple）
 *
 * 整个流程在聊天室内完成，不退出聊天室。
 */
async function executeCollaborativeTask(params: CollaborativeTaskParams): Promise<void> {
  const {
    session,
    userMessage,
    config,
    chatroomConfig,
    callStrategy,
    sendReply,
    agentSessionKey,
    collaborativeContext,
    displayNames,
  } = params;

  const leadCharacterId = session.participants[0];
  const reviewerIds = session.participants.filter((id) => id !== leadCharacterId);

  log.info(
    `[Orchestrator] 🤝 协作任务启动: lead=${leadCharacterId}, ` +
    `reviewers=${reviewerIds.join(",")}, msg=${userMessage.slice(0, 100)}`,
  );

  // ── 0. 发送协作任务横幅 ──
  await sendReply(formatCollaborativeBanner(
    session.participants,
    displayNames,
    leadCharacterId,
  ));

  // ── Phase 1: 规划讨论（所有角色简短讨论方案） ──
  log.info(`[Orchestrator] 🤝 Phase 1: 规划讨论`);
  const recentMessages = getRecentMessages(session, 10);
  const activeParticipants = session.participants.filter((id) =>
    canCharacterReply(session, id, chatroomConfig),
  );

  const planningHint =
    `## 🤝 协作任务 — 规划阶段\n` +
    `主人交给聊天室一项复杂任务，姐妹们需要协作完成。\n` +
    `请简要分析这个任务，提出你的方案建议（100-300字）。\n` +
    `你的分析将供负责执行的姐妹参考。\n` +
    `注意：你现在只需要讨论方案，不需要执行。执行由主导姐妹负责。`;

  const planningResponses = await callMultipleAgents({
    characterIds: activeParticipants,
    userMessage,
    participants: session.participants,
    recentMessages,
    config,
    chatroomConfig,
    callStrategy,
    isInteraction: false,
    interactionHint: planningHint,
    agentSessionKey,
  });

  // 记录到会话 + 发送
  for (const resp of planningResponses) {
    addCharacterMessage(session, resp.characterId, resp.displayName, resp.content);
  }
  await sendReply(formatPlanningPhase(planningResponses));

  // 汇总规划内容供 Phase 2 使用
  const planningContext = planningResponses
    .filter((r) => r.ok)
    .map((r) => {
      const icon = CHARACTER_ICONS[r.characterId]?.icon ?? "💬";
      return `${icon} ${r.displayName}：${r.content}`;
    })
    .join("\n\n");

  // ── Phase 2: 领头角色执行（全工具 agent loop） ──
  log.info(`[Orchestrator] 🤝 Phase 2: ${leadCharacterId} 执行任务`);
  const executionStarted = Date.now();

  const leadResponse = await executeLeadCharacterWithTools({
    characterId: leadCharacterId,
    userMessage,
    participants: session.participants,
    planningContext,
    collaborativeContext,
    config,
  });

  const executionDurationMs = Date.now() - executionStarted;

  // 记录到会话 + 发送
  addCharacterMessage(
    session,
    leadResponse.characterId,
    leadResponse.displayName,
    leadResponse.content,
  );
  await sendReply(formatExecutionPhase(leadResponse, executionDurationMs));

  // ── Phase 3: 姐妹互检（其他角色审查产出） ──
  if (reviewerIds.length > 0 && leadResponse.ok) {
    log.info(`[Orchestrator] 🤝 Phase 3: 互检 (${reviewerIds.join(",")})`);

    // 截断执行产出供审查（避免 prompt 过长）
    const outputForReview = leadResponse.content.length > REVIEW_CONTEXT_MAX_CHARS
      ? leadResponse.content.slice(0, REVIEW_CONTEXT_MAX_CHARS) + "\n\n...（产出已截断，完整内容请查看文件）"
      : leadResponse.content;

    const leadIcon = CHARACTER_ICONS[leadCharacterId]?.icon ?? "💬";
    const leadName = displayNames[leadCharacterId] ?? leadCharacterId;
    const reviewHint =
      `## 🔍 协作任务 — 互检阶段\n` +
      `${leadIcon}${leadName} 已完成任务执行，以下是她的产出：\n\n` +
      `---\n${outputForReview}\n---\n\n` +
      `请审查以上产出，给出你的评价和建议（100-300字）：\n` +
      `- 是否完成了主人的需求？\n` +
      `- 有没有遗漏或可以改进的地方？\n` +
      `- 质量如何？`;

    const reviewMessages = getRecentMessages(session, 15);
    const activeReviewers = reviewerIds.filter((id) =>
      canCharacterReply(session, id, chatroomConfig),
    );

    if (activeReviewers.length > 0) {
      const reviewResponses = await callMultipleAgents({
        characterIds: activeReviewers,
        userMessage: `（协作任务互检）`,
        participants: session.participants,
        recentMessages: reviewMessages,
        config,
        chatroomConfig,
        callStrategy,
        isInteraction: true,
        interactionHint: reviewHint,
        agentSessionKey,
      });

      // 记录到会话 + 发送
      for (const resp of reviewResponses) {
        addCharacterMessage(session, resp.characterId, resp.displayName, resp.content, true);
      }
      await sendReply(formatReviewPhase(reviewResponses));
    }
  } else if (!leadResponse.ok) {
    log.warn(`[Orchestrator] 🤝 Phase 2 执行失败，跳过互检`);
  }

  log.info(`[Orchestrator] 🤝 协作任务完成`);
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

/**
 * 格式化单个角色的回答（逐角色即时推送专用）
 *
 * 与 formatResponses 不同，此函数只格式化一个角色的内容，
 * 用于串行调用时每个角色完成后立即推送。
 */
function formatSingleCharacterResponse(
  resp: CharacterResponse,
  session: import("./types.js").ChatRoomSession,
  cfg: ChatRoomConfig,
): string {
  const icon = CHARACTER_ICONS[resp.characterId]?.icon ?? "💬";
  const parts: string[] = [];

  parts.push(`${icon} **${resp.displayName}**：`);
  parts.push(resp.content);

  // 记忆操作提示
  if (resp.memoryActions?.length) {
    const okCount = resp.memoryActions.filter((a) => a.ok).length;
    parts.push(`\n📝 记忆操作 ×${okCount}`);
  }

  // 发言统计（仅在最后一个角色时显示，通过 session 判断）
  const count = session.replyCounters[resp.characterId] ?? 0;
  parts.push(`\n📊 ${icon}${resp.displayName} ${count}/${cfg.maxRepliesPerCharacter}`);

  return parts.join("\n");
}
