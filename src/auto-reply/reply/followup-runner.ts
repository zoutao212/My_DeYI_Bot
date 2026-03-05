import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveAgentIdFromSessionKey, type SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import { finalizeWithFollowup } from "./agent-runner-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { resolveQueueSettings } from "./queue/settings.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { incrementCompactionCount } from "./session-updates.js";
import type { TypingController } from "./typing.js";
import { createTypingSignaler } from "./typing-mode.js";
import { setCurrentFollowupRunContext, clearCurrentFollowupRunContext } from "../../agents/tools/enqueue-task-tool.js";
import { getGlobalOrchestrator } from "../../agents/tools/enqueue-task-tool.js";
import { buildSiblingContext } from "../../agents/memory/pipeline-integration.js";
import { createMemoryService } from "../../agents/memory/factory.js";
import { sendFallbackFile } from "./send-fallback-file.js";
import { collectTrackedFiles, clearTracking } from "../../agents/intelligent-task-decomposition/file-tracker.js";
import { deriveExecutionRole, createExecutionContext } from "../../agents/intelligent-task-decomposition/execution-context.js";
import { getPrompts } from "../../agents/intelligent-task-decomposition/prompts-loader.js";
import type { SubTask, TaskTree, ExecutionContext } from "../../agents/intelligent-task-decomposition/types.js";
import type { Orchestrator } from "../../agents/intelligent-task-decomposition/orchestrator.js";
import { TaskProgressReporter, getTaskProgressFromTree, formatDetailedProgress } from "../../agents/intelligent-task-decomposition/task-progress-reporter.js";
import { estimateTokens, allocateBudget, truncateToTokenBudget, type BudgetRequest } from "../../agents/intelligent-task-decomposition/context-budget-manager.js";
import { localGrepSearch, getDefaultMemoryDirs } from "../../memory/local-search.js";
import { searchNovelAssets, hasNovelAssets, formatNovelSnippetsForPrompt } from "../../memory/novel-assets-searcher.js";

const TOOL_PROGRESS_MIN_GAP_MS = 1200;
const TOOL_PROGRESS_ENABLED = process.env.CLAWDBOT_TASK_PROGRESS_TOOL_VERBOSE !== "0";

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function loadRecentPhaseContext(params: {
  sessionId: string;
  maxFiles: number;
  maxChars: number;
}): Promise<string> {
  try {
    const phaseDir = path.join(os.homedir(), ".clawdbot", "tasks", params.sessionId, "logs", "phases");
    const files = await fs.readdir(phaseDir);
    const phaseFiles = files
      .filter((f) => f.startsWith("phase_") && f.endsWith(".md"))
      // 文件名带 timestamp，按字符串逆序即可近似最新在前
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, Math.max(0, params.maxFiles));

    if (phaseFiles.length === 0) return "";

    let buf = "";
    for (const f of phaseFiles) {
      const p = path.join(phaseDir, f);
      const raw = await fs.readFile(p, "utf-8");
      const snippet = raw.length > 1600 ? `${raw.slice(0, 1600)}\n...[截断]` : raw;
      const entry = `\n\n---\n[phase:${f}]\n${snippet}`;
      if (buf.length + entry.length > params.maxChars) break;
      buf += entry;
    }

    return buf.trim();
  } catch {
    return "";
  }
}

// ── P10: 输出验证门（OutputValidator）──
// 规则驱动，零 LLM 调用。在标记 completed 之前拦截明显无效输出。
type OutputFailureCode = "hallucinated_tool_calls" | "output_too_short" | "context_overflow_signal" | "llm_refusal" | "excessive_repetition" | "delegation_attempt" | "api_content_block";
interface OutputValidationResult {
  valid: boolean;
  failureCode?: OutputFailureCode;
  failureReason?: string;
  suggestedAction?: "retry" | "skip" | "fail";
}

/**
 * 🔧 P103: 检测 outputText 是否实际上是 API 错误消息
 *
 * 根因：PI library 将 429/503 等 API 错误格式化为中文文本
 * "⚠️ API 返回了错误响应..." 放入 content[0].text。
 * buildEmbeddedRunPayloads 的 shouldSuppressRawErrorText 只对比英文格式的
 * formatAssistantErrorText 输出和 rawErrorMessage JSON，无法匹配中文格式，
 * 导致错误消息流入 contentPayloads（未标记 isError），绕过 P100 守卫。
 *
 * 检测条件：文本较短（<1500 字符）且匹配 API 错误模式。
 * 真正的 LLM 写作产出通常远超 1500 字符，不会误触发。
 */
const _P103_API_ERROR_PATTERNS: RegExp[] = [
  /api\s*返回了?\s*错误/i,
  /too many requests/i,
  /rate[_ ]?limit/i,
  /["']?code["']?\s*:\s*429/,
  /["']?status["']?\s*:\s*["']?too many requests/i,
  /model[_ ]?not[_ ]?found/i,
  /上游负载[已已]饱和/,
  /请稍后再试/,
  /service unavailable/i,
  /["']?code["']?\s*:\s*503/,
  /overloaded/i,
  /upstream.*saturated/i,
];

function _isOutputApiError(text: string): boolean {
  if (!text || text.length > 1500) return false;
  // 至少匹配 2 个模式才确认（降低误判风险）
  let matchCount = 0;
  for (const pattern of _P103_API_ERROR_PATTERNS) {
    if (pattern.test(text)) {
      matchCount++;
      if (matchCount >= 2) return true;
    }
  }
  return false;
}

function validateSubTaskOutput(
  outputText: string,
  toolMetas: Array<{ toolName: string; [k: string]: unknown }>,
  context?: { isRootTask?: boolean; spotRecoveryExecuted?: boolean },
): OutputValidationResult {
  // 规则 1：检测 LLM 把 tool call 幻觉为纯文本
  // 🔧 P98 修复：当 P88 Spot Recovery 已成功执行时，跳过此检测。
  // 根因：P88 在 attempt.ts 中检测到幻觉工具调用并执行了它们，但原始幻觉文本
  // 仍留在 assistantTexts 中（session 历史不可变）。如果不跳过，OutputValidator
  // 会看到幻觉模式并拒绝整个输出，导致 P88 的修复无效。
  if (!context?.spotRecoveryExecuted) {
    const hallucinationPatterns = [
      /\[Historical context:.*called tool/i,
      /Do not mimic this format.*use proper function calling/i,
      /a different model called tool/i,
    ];
    if (hallucinationPatterns.some((p) => p.test(outputText))) {
      return {
        valid: false,
        failureCode: "hallucinated_tool_calls",
        failureReason: "LLM 将 tool call 幻觉为纯文本输出，非真实工具调用",
        suggestedAction: "retry",
      };
    }
  } else {
    console.log(
      `[OutputValidator] ℹ️ P98: spotRecoveryExecuted=true，跳过幻觉检测（P88 已处理）`,
    );
  }

  // 规则 1.5：检测 LLM 委派行为（调用 sessions_spawn/enqueue_task 而非直接执行）
  // 根因 P13/P14：LLM 在子任务中调用 sessions_spawn 绕过任务系统，
  // 导致输出不被追踪，只有 191 字元叙述被当作 output → 字数不达标 → 死循环
  const DELEGATION_TOOLS = new Set(["sessions_spawn", "enqueue_task", "batch_enqueue_tasks"]);
  const usedDelegationTool = toolMetas.some((m) => DELEGATION_TOOLS.has(m.toolName));
  // 根任务调用 enqueue_task 是正常分解行为，不拦截；只对非根子任务拦截
  if (usedDelegationTool && !context?.isRootTask) {
    const delegationToolNames = toolMetas
      .filter((m) => DELEGATION_TOOLS.has(m.toolName))
      .map((m) => m.toolName)
      .join(", ");
    return {
      valid: false,
      failureCode: "delegation_attempt",
      failureReason: `LLM 尝试委派任务（调用了 ${delegationToolNames}），而非直接执行。子任务必须亲自完成，禁止委派。`,
      suggestedAction: "retry",
    };
  }

  // 规则 2：上下文溢出信号 — 输出极短且无文件工具调用
  // 🔧 P0-C 修复：区分"明确上下文溢出"和"泛化 abort 信号"
  // 根因：原逻辑把所有 abort 信号（包括 API 限流、网络超时、临时性中断）
  // 都标记为 skip（不可重试），导致可恢复的临时失败直接放弃。
  // 修复：明确的上下文溢出（context length/overflow 关键词）→ skip
  //       泛化的 abort（"Request aborted"、"aborted"）→ retry（给一次重试机会）
  const FILE_TOOLS = new Set(["write", "send_file", "read", "exec"]);
  const usedAnyTool = toolMetas.some((m) => FILE_TOOLS.has(m.toolName));
  const contextOverflowPatterns = [
    /context.*(?:length|limit|overflow|exceeded)/i,
    /maximum.*(?:context|token)/i,
    /prompt.*too.*long/i,
    /request.*too.*large/i,
  ];
  const genericAbortPatterns = [
    /request\s*aborted/i,
    /aborted/i,
  ];
  const isContextOverflow = contextOverflowPatterns.some((p) => p.test(outputText));
  const isGenericAbort = !isContextOverflow && genericAbortPatterns.some((p) => p.test(outputText));
  const isAbortSignal = isContextOverflow || isGenericAbort;
  if (!usedAnyTool && (outputText.length < 200 && outputText.length > 0 || isAbortSignal)) {
    // 明确上下文溢出 → skip；泛化 abort → retry（临时性问题可恢复）
    const action = isContextOverflow ? "skip" : "retry";
    return {
      valid: false,
      failureCode: "context_overflow_signal",
      failureReason: isContextOverflow
        ? `检测到上下文溢出: "${outputText.substring(0, 80)}"，结构性问题不可重试`
        : isGenericAbort
          ? `检测到 abort 信号: "${outputText.substring(0, 80)}"，可能是临时性问题`
          : `输出仅 ${outputText.length} 字符且无工具调用，疑似上下文溢出`,
      suggestedAction: action,
    };
  }

  // 规则 3：检测 LLM 拒绝执行（常见的拒绝模式）
  const refusalPatterns = [
    /^(?:I (?:cannot|can't|am unable to|apologize)|抱歉|对不起|我无法|我不能)/i,
    /(?:I'm not able to|as an AI|作为AI|作为一个AI)/i,
  ];
  if (outputText.length < 500 && refusalPatterns.some((p) => p.test(outputText.trim()))) {
    return {
      valid: false,
      failureCode: "llm_refusal",
      failureReason: "LLM 拒绝执行任务",
      suggestedAction: "retry",
    };
  }

  // 规则 4：检测重复内容（同一段文字重复多次）
  // 🔧 P49: 根据任务类型动态调整重复检测阈值（替代一刀切 5 次）
  // 刻板问题：写作类任务正常使用排比/回声/重复修辞手法，5 次阈值容易误判
  // 分析/编码类任务几乎不会有正常重复，阈值应更低以更快检测 LLM 循环生成
  if (outputText.length > 500) {
    const lines = outputText.split("\n").filter(l => l.trim().length > 20);
    const lineSet = new Map<string, number>();
    for (const line of lines) {
      const trimmed = line.trim();
      lineSet.set(trimmed, (lineSet.get(trimmed) ?? 0) + 1);
    }
    const maxRepeat = Math.max(...lineSet.values(), 0);
    // 根据上下文推断任务类型（OutputValidator 没有直接的 taskType 参数）
    const looksLikeWriting = /[写作创作小说故事章节|翻译|诗歌|散文]/u.test(outputText.substring(0, 200));
    const repeatThreshold = looksLikeWriting ? 8 : (context?.isRootTask ? 5 : 4);
    if (maxRepeat >= repeatThreshold) {
      return {
        valid: false,
        failureCode: "excessive_repetition",
        failureReason: `检测到严重重复内容（同一行重复 ${maxRepeat} 次，阈值 ${repeatThreshold}），疑似 LLM 循环生成`,
        suggestedAction: "retry",
      };
    }
  }

  // 规则 5：🔧 P85 检测 API 错误/内容审查退回
  // 根因：LLM API 返回 PROHIBITED_CONTENT/SAFETY 等错误时，错误消息作为 outputText 传入，
  // 但前面的规则都不匹配（有文件工具调用 → 跳过规则2，不是拒绝模式 → 跳过规则3）。
  // 结果：错误输出被标记为 completed，任务看似成功但产出内容是错误消息。
  const apiErrorPatterns = [
    /PROHIBITED_CONTENT/i,
    /SAFETY.*block/i,
    /blocked\s+by\s+(?:Google|Gemini|OpenAI|Anthropic|content\s+filter)/i,
    /content.*(?:policy|moderation).*(?:violation|block|reject)/i,
    /LLM\s+error:\s*\{/i,
    /RECITATION/i,
  ];
  if (apiErrorPatterns.some((p) => p.test(outputText))) {
    // 如果有实际的文件工具调用，说明 LLM 在报错前已产出有效内容，降级放行
    const hasWriteTool = toolMetas.some((m) => m.toolName === "write");
    if (!hasWriteTool) {
      return {
        valid: false,
        failureCode: "api_content_block",
        failureReason: `检测到 API 内容审查/错误: "${outputText.substring(0, 120)}"`,
        // 🔧 P106: PROHIBITED_CONTENT/SAFETY 是永久性内容策略拒绝，同一 prompt 重试必然相同结果。
        // 修复前：suggestedAction="retry" → 浪费 3 次 API 调用才失败。
        // 修复后：直接 fail，不浪费 API 配额。
        suggestedAction: "fail",
      };
    }
    // 有 write 工具调用 → LLM 在报错前已写入文件，降级放行但记录警告
    console.warn(
      `[OutputValidator] ⚠️ P85: API 错误但有文件产出，降级放行: ${outputText.substring(0, 100)}`,
    );
  }

  return { valid: true };
}

// isRetryableError 已移至 Orchestrator.isRetryableError()（统一错误分类入口）

/**
 * 🔧 P12: FollowupRun 工厂函数
 * 
 * 从 queued（当前执行的 FollowupRun）和 subTask 构造新的 FollowupRun。
 * 替代 followup-runner 和 drain.ts 中 7 处重复的手动构造代码。
 */
function buildFollowupRun(
  queued: FollowupRun,
  subTask: SubTask,
  overrides?: Partial<FollowupRun>,
): FollowupRun {
  return {
    prompt: subTask.prompt,
    summaryLine: subTask.summary,
    enqueuedAt: Date.now(),
    run: queued.run,
    isQueueTask: true,
    isRootTask: false,
    isNewRootTask: false,
    taskDepth: subTask.depth ?? queued.taskDepth ?? 0,
    subTaskId: subTask.id,
    rootTaskId: subTask.rootTaskId ?? queued.rootTaskId,
    originatingChannel: queued.originatingChannel,
    originatingTo: queued.originatingTo,
    originatingAccountId: queued.originatingAccountId,
    originatingThreadId: queued.originatingThreadId,
    originatingChatType: queued.originatingChatType,
    ...overrides,
  };
}

/**
 * 🆕 V2 Phase 4: 兜底落盘（提取自主循环，减少嵌套深度）
 *
 * 检测 LLM 是否偷懒（生成了大段内容但未调用 write 工具落盘），
 * 如果偷懒则自动保存到兜底目录并发送给用户，同时截断 session 中的超长 assistant 消息。
 */
async function handleFallbackPersistence(opts: {
  subTask: SubTask;
  outputText: string;
  toolMetas: Array<{ toolName: string; [k: string]: unknown }>;
  sessionId: string;
  queued: FollowupRun;
  skipSend?: boolean; // 🔧 问题 JJ：跳过发送，仅保存文件
  llmSessionFile?: string; // 🔧 Session 隔离：隔离的 session 文件路径
}): Promise<void> {
  const FILE_TOOLS = new Set(["write", "send_file"]);
  const MIN_FALLBACK_CHARS = 500;
  const { subTask, outputText, toolMetas, sessionId, queued, skipSend, llmSessionFile } = opts;

  const usedFileTool = toolMetas.some((m) => FILE_TOOLS.has(m.toolName));
  if (usedFileTool || outputText.length < MIN_FALLBACK_CHARS) return;

  try {
    const taskDir = path.join(os.homedir(), ".clawdbot", "tasks", sessionId, "fallback-outputs");
    await fs.mkdir(taskDir, { recursive: true });
    const safeId = (subTask.id ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "_");
    const fallbackFile = path.join(taskDir, `${safeId}.txt`);
    await fs.writeFile(fallbackFile, outputText, "utf-8");
    console.log(
      `[followup-runner] 📝 兜底落盘：LLM 未调用 write 工具，已自动保存 ${outputText.length} 字到 ${fallbackFile}`,
    );

    if (!subTask.metadata) subTask.metadata = {};
    subTask.metadata.fallbackFilePath = fallbackFile;
    subTask.metadata.fallbackReason = "LLM 未调用 write 工具，系统自动兜底落盘";

    // 发送兜底文件到用户频道
    // 🔧 问题 JJ：如果 skipSend=true，跳过发送（等质检通过后再发）
    if (!skipSend) {
      const sendResult = await sendFallbackFile({
        filePath: fallbackFile,
        caption: subTask.summary
          ? `📝 ${subTask.summary}（系统自动保存）`
          : `📝 子任务输出（系统自动保存）`,
        queued,
      });
      if (!sendResult.ok) {
        console.warn(
          `[followup-runner] ⚠️ 兜底文件发送失败 (${sendResult.method}): ${sendResult.error}`,
        );
      }
    }

    // Session 瘦身：截断 session 文件中的最后一条超长 assistant 消息
    try {
      const sessionFilePath = llmSessionFile ?? queued.run.sessionFile;
      if (sessionFilePath) {
        const rawSession = await fs.readFile(sessionFilePath, "utf-8");
        const lines = rawSession.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.role === "assistant" && Array.isArray(entry.content)) {
              const textPart = entry.content.find((c: { type: string }) => c.type === "text");
              if (textPart && typeof textPart.text === "string" && textPart.text.length > 500) {
                const truncated = textPart.text.substring(0, 200) +
                  `\n\n[内容已落盘到文件: ${fallbackFile}，此处截断以控制 session 大小]`;
                textPart.text = truncated;
                lines[i] = JSON.stringify(entry);
                await fs.writeFile(sessionFilePath, lines.join("\n"), "utf-8");
                console.log(
                  `[followup-runner] ✂️ Session 瘦身：截断 assistant 消息 ${outputText.length} → ${truncated.length} 字`,
                );
              }
              break;
            }
          } catch { /* 非 JSON 行，跳过 */ }
        }
      }
    } catch (trimErr) {
      console.warn(`[followup-runner] ⚠️ Session 瘦身失败（不阻塞）: ${trimErr}`);
    }
  } catch (fallbackErr) {
    console.warn(`[followup-runner] ⚠️ 兜底落盘失败: ${fallbackErr}`);
  }
}

/**
 * 🆕 V2 Phase 4: 异步归档轮次记忆（提取自主循环，减少嵌套深度）
 *
 * fire-and-forget：归档失败不影响主流程。
 */
function archiveRoundMemory(
  orchestrator: Orchestrator,
  taskTree: TaskTree,
  roundId: string,
  queued: FollowupRun,
  sessionId: string,
): void {
  try {
    const memService = createMemoryService(queued.run.config, "main");
    if (!memService) return;
    const roundGoal = orchestrator.getRoundRootDescription(taskTree, roundId);
    const completedCount = taskTree.subTasks.filter((t) => t.status === "completed").length;
    const totalCount = taskTree.subTasks.length;
    memService.archive({
      summary: {
        taskGoal: roundGoal || taskTree.rootTask || "任务树",
        keyActions: taskTree.subTasks
          .filter((t) => t.status === "completed")
          .map((t) => t.summary ?? t.prompt?.substring(0, 60) ?? "子任务"),
        keyDecisions: [] as string[],
        blockers: taskTree.subTasks
          .filter((t) => t.status === "failed")
          .map((t) => t.error ?? "未知错误"),
        totalTurns: totalCount,
        createdAt: Date.now(),
        progress: {
          completed: completedCount,
          total: totalCount,
          percentage: totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0,
        },
      },
      context: { userId: queued.run.agentAccountId ?? "default", sessionId },
    }).catch((err: unknown) => console.warn(`[followup-runner] Memory archive failed: ${err}`));
  } catch { /* 归档失败不影响主流程 */ }
}

export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): (queued: FollowupRun) => Promise<void> {
  const {
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  } = params;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat: opts?.isHeartbeat === true,
  });

  /**
   * Sends followup payloads, routing to the originating channel if set.
   *
   * When originatingChannel/originatingTo are set on the queued run,
   * replies are routed directly to that provider instead of using the
   * session's current dispatcher. This ensures replies go back to
   * where the message originated.
   */
  const sendFollowupPayloads = async (payloads: ReplyPayload[], queued: FollowupRun) => {
    // Check if we should route to originating channel.
    const { originatingChannel, originatingTo } = queued;
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      logVerbose("followup queue: no onBlockReply handler; dropping payloads");
      return;
    }

    for (const payload of payloads) {
      if (!payload?.text && !payload?.mediaUrl && !payload?.mediaUrls?.length) {
        continue;
      }
      if (
        isSilentReplyText(payload.text, SILENT_REPLY_TOKEN) &&
        !payload.mediaUrl &&
        !payload.mediaUrls?.length
      ) {
        continue;
      }
      await typingSignals.signalTextDelta(payload.text);

      // Route to originating channel if set, otherwise fall back to dispatcher.
      if (shouldRouteToOriginating) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: queued.run.sessionKey,
          accountId: queued.originatingAccountId,
          threadId: queued.originatingThreadId,
          cfg: queued.run.config,
        });
        if (!result.ok) {
          // Log error and fall back to dispatcher if available.
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          // Fallback: try the dispatcher if routing failed.
          if (opts?.onBlockReply) {
            await opts.onBlockReply(payload);
          }
        }
      } else if (opts?.onBlockReply) {
        await opts.onBlockReply(payload);
      }
    }
  };

  return async (queued: FollowupRun) => {
    const runId = crypto.randomUUID();
    let progressReporter: TaskProgressReporter | null = null;
    try {
      if (queued.run.sessionKey) {
        registerAgentRunContext(runId, {
          sessionKey: queued.run.sessionKey,
          verboseLevel: queued.run.verboseLevel,
        });
      }
      
      // 🔧 获取 Orchestrator 实例
      const orchestrator = getGlobalOrchestrator();
      const sessionId = queued.run.sessionId;
      
      // 🔧 尝试从任务树中找到对应的子任务
      // 优先用 subTaskId 精确匹配，回退到 prompt 匹配（向后兼容）
      let taskTree = await orchestrator.loadTaskTree(sessionId);
      let subTask: SubTask | undefined;
      if (taskTree) {
        if (queued.subTaskId) {
          subTask = taskTree.subTasks.find((t) => t.id === queued.subTaskId);
        }
        if (!subTask) {
          subTask = taskTree.subTasks.find(
            (task) => task.prompt === queued.prompt && task.status === "pending",
          );
        }
      }
      
      // 🆕 V2 Phase 4: 通过 onTaskStarting 钩子统一处理任务启动前的准备
      let startDecisionCtx: ExecutionContext | undefined;
      if (taskTree && subTask) {
        console.log(`[followup-runner] 🔍 Found sub task in tree: ${subTask.id}`);

        // 🆕 初始化任务进度报告器
        const progressInfo = getTaskProgressFromTree(taskTree, queued.rootTaskId);
        progressReporter = new TaskProgressReporter(progressInfo.total);
        progressReporter.updateCounts(progressInfo.completed, progressInfo.failed, progressInfo.total);
        progressReporter.setSender(async (text: string) => {
          try { await sendFollowupPayloads([{ text }], queued); } catch { /* 进度消息发送失败不阻塞主流程 */ }
        });
        progressReporter.onTaskStart(subTask.summary ?? queued.summaryLine ?? "子任务");

        const startDecision = orchestrator.onTaskStarting(taskTree, subTask, {
          isQueueTask: queued.isQueueTask,
          isRootTask: queued.isRootTask ?? queued.isNewRootTask,
          isNewRootTask: queued.isNewRootTask,
          taskDepth: queued.taskDepth,
          rootTaskId: queued.rootTaskId,
        });
        startDecisionCtx = startDecision.executionContext;

        // 钩子判断应先自动分解 → 委托分解后跳过直接执行
        if (startDecision.shouldDecompose) {
          try {
            const decomposed = await orchestrator.decomposeSubTask(taskTree, subTask.id);
            if (decomposed.length > 0) {
              console.log(
                `[followup-runner] ✅ P2: 子任务 ${subTask.id} 已自动分解为 ${decomposed.length} 个子任务，跳过直接执行`,
              );
              // 🔧 问题 BB 修复：分解后 return 前清理文件追踪
              // onTaskStarting 中 beginTracking 已被调用，但分解后不会执行 LLM，
              // 也不会走到 collectTrackedFiles。如果不清理，activeTrackingStack 中
              // 会残留这个 taskId，后续任务的 trackFileWrite 可能误归到这里。
              clearTracking(subTask.id);
              // 🔧 BUG 修复：分解产生的子任务必须创建 FollowupRun 入队
              // 修复前：只调用 finalizeWithFollowup 触发 drain，但队列中没有对应的 FollowupRun
              // 导致分解后的子任务永远不会被执行
              if (queued.run.sessionKey) {
                for (const newSubTask of decomposed) {
                  if (newSubTask.status === "pending") {
                    const decompFollowupRun = buildFollowupRun(queued, newSubTask);
                    const resolvedQueue = resolveQueueSettings({
                      cfg: queued.run.config ?? ({} as any),
                      inlineMode: "followup",
                    });
                    enqueueFollowupRun(queued.run.sessionKey, decompFollowupRun, resolvedQueue, "none");
                    console.log(`[followup-runner] 🆕 分解子任务已入队: ${newSubTask.id} (${newSubTask.summary})`);
                  }
                }
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }
          } catch (decompErr) {
            console.warn(`[followup-runner] ⚠️ P2: 自动递归分解失败（继续正常执行）: ${decompErr}`);
          }
        }

        await orchestrator.saveTaskTree(taskTree);
      }

      // ── V8 P2: 执行策略路由 ──
      // 在 LLM 执行前决定策略。system_merge / system_deliver 直接由系统处理，零 LLM 消耗。
      if (taskTree && subTask && queued.subTaskId) {
        const { routeStrategy, strategyRequiresLLM, executeSystemStrategy } = await import(
          "../../agents/intelligent-task-decomposition/strategy-router.js"
        );
        const strategy = routeStrategy(subTask);
        if (!strategyRequiresLLM(strategy)) {
          console.log(`[followup-runner] 🔧 V8 P2: 子任务 ${subTask.id} 路由到系统策略 "${strategy}"，跳过 LLM`);
          const sysResult = executeSystemStrategy(strategy, subTask, { taskTree });
          subTask.output = sysResult.output;
          subTask.completedAt = Date.now();
          if (sysResult.producedFilePaths.length > 0) {
            if (!subTask.metadata) subTask.metadata = {};
            subTask.metadata.producedFilePaths = sysResult.producedFilePaths;
            subTask.metadata.producedFiles = sysResult.producedFilePaths.map((p: string) => path.basename(p));
          }
          await orchestrator.updateSubTaskStatus(taskTree, subTask.id, sysResult.success ? "completed" : "failed");
          // 进入统一后处理（质检 + 轮次完成检查）
          try {
            const postResult = await orchestrator.onTaskCompleted(taskTree, subTask, queued.rootTaskId);
            if (postResult.roundCompleted && postResult.completedRoundId) {
              console.log(`[followup-runner] 🏁 V8 P2: Round completed via system strategy: ${postResult.completedRoundId}`);
              taskTree = (await orchestrator.loadTaskTree(sessionId)) ?? taskTree;
              const roundResult = await orchestrator.onRoundCompleted(taskTree, postResult.completedRoundId);
              if (roundResult.mergedFilePath) {
                const mergedSendResult = await sendFallbackFile({ filePath: roundResult.mergedFilePath, caption: "📝 完整输出（子任务合并）", queued });
                if (!mergedSendResult.ok) {
                  await sendFollowupPayloads([{ text: `📝 子任务输出已合并保存到：\n${roundResult.mergedFilePath}` }], queued);
                }
              }
              if (roundResult.deliveryReportMarkdown) {
                await sendFollowupPayloads([{ text: roundResult.deliveryReportMarkdown }], queued);
              }
              archiveRoundMemory(orchestrator, taskTree, postResult.completedRoundId, queued, sessionId);
            }
          } catch (ppErr) {
            console.warn(`[followup-runner] ⚠️ V8 P2: 系统策略后处理异常（不阻塞）: ${ppErr}`);
          }
          // 触发队列继续执行下一个任务
          if (queued.run.sessionKey) {
            finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
          }
          return;
        }
      }
      
      // 🔧 Session 隔离：子任务使用独立的 session 文件，防止 LLM 上下文交叉污染
      // 根因：所有子任务共享同一个 session 文件（JSONL 对话历史），导致：
      // 1. 后续子任务的 LLM 上下文中包含前序子任务的完整对话
      // 2. 重试时 LLM 看到所有章节的历史，输出混入其他子任务的内容
      // 3. 质检正确检测到"内容归属错乱"，但根因是 session 污染
      let llmSessionFile = queued.run.sessionFile;
      if (queued.subTaskId && queued.isQueueTask) {
        const isolatedSessionDir = path.join(
          os.homedir(), ".clawdbot", "tasks", sessionId, "sessions"
        );
        await fs.mkdir(isolatedSessionDir, { recursive: true });
        // 重试时使用新的 session 文件，避免锚定到上次失败的输出
        // 迭代优化指令已通过 prompt 注入（previousOutput + lastFailureFindings），无需旧 session
        const retryCount = subTask?.retryCount ?? 0;
        const sessionSuffix = retryCount > 0 ? `_retry${retryCount}` : "";
        llmSessionFile = path.join(isolatedSessionDir, `${queued.subTaskId}${sessionSuffix}.jsonl`);
        console.log(
          `[followup-runner] 🔒 Session 隔离: 子任务 ${queued.subTaskId} 使用独立 session` +
          (retryCount > 0 ? ` (retry ${retryCount})` : ""),
        );
      }

      let autoCompactionCompleted = false;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      try {
        // 🆕 V2 Phase 4: ExecutionContext 由 onTaskStarting 钩子构建，回退到旧推导
        const isNewRoot = queued.isNewRootTask ?? false;
        const effectiveIsQueueTask = isNewRoot ? false : (queued.isQueueTask ?? true);
        const effectiveDepth = queued.taskDepth ?? 0;

        const execCtx = startDecisionCtx
          ?? queued.executionContext
          ?? createExecutionContext({
              role: deriveExecutionRole({ isQueueTask: effectiveIsQueueTask, isRootTask: isNewRoot, isNewRootTask: isNewRoot, taskDepth: effectiveDepth }),
              roundId: queued.rootTaskId ?? "",
              depth: effectiveDepth,
            });

        // 🔧 P12 修复：传入 runId 作为 contextId，防止并行 runner 的 finally 块互相清空上下文
        setCurrentFollowupRunContext({ 
          ...queued, 
          isQueueTask: effectiveIsQueueTask,
          isRootTask: isNewRoot,
          isNewRootTask: isNewRoot,
          taskDepth: effectiveDepth,
          rootTaskId: queued.rootTaskId,
          executionContext: execCtx,
        }, runId);
        
        // 🆕 进度报告：开始等待 LLM 回复
        progressReporter?.onLLMStart();

        const contextShrinkLevel = subTask?.metadata?.contextShrinkLevel ?? 0;
        const shouldInjectHeavyContext = contextShrinkLevel <= 0;
        const phaseContext = !shouldInjectHeavyContext
          ? await loadRecentPhaseContext({ sessionId, maxFiles: 2, maxChars: 3500 })
          : "";

        // 🆕 Gap2: 经验池注入执行 prompt — 让 LLM 在执行时避免已知错误模式
        let experienceHint = "";
        if (shouldInjectHeavyContext && subTask?.taskType) {
          try {
            const { generateExperienceSummary } = await import(
              "../../agents/intelligent-task-decomposition/experience-pool.js"
            );
            experienceHint = await generateExperienceSummary(subTask.taskType, 3);
            if (experienceHint) {
              console.log(`[followup-runner] 📚 经验池注入: ${experienceHint.length} chars (taskType=${subTask.taskType})`);
            }
          } catch {
            // 经验池不可用，不阻塞执行
          }
        }

        // 🆕 M10: 子任务记忆注入 — 用轻量本地搜索为子任务注入相关记忆
        // 仅对 writing/research/analysis/design 类型启用，零远程 API 调用
        let subTaskMemoryCtx = "";
        const isSubTaskForMemory = Boolean(queued.subTaskId) && !queued.isRootTask && !queued.isNewRootTask;
        if (shouldInjectHeavyContext && isSubTaskForMemory && queued.run.workspaceDir) {
          const memTaskType = subTask?.taskType ?? "generic";
          const MEMORY_TASK_TYPES = ["writing", "research", "analysis", "design"];
          if (MEMORY_TASK_TYPES.includes(memTaskType)) {
            try {
              const searchQuery = subTask?.summary || queued.prompt.substring(0, 200);
              const memDirs = getDefaultMemoryDirs(queued.run.workspaceDir);
              const memResults = await localGrepSearch(searchQuery, {
                dirs: memDirs,
                maxResults: 5,
                contextLines: 3,
                workspaceDir: queued.run.workspaceDir,
              });
              if (memResults.length > 0) {
                const MAX_MEMORY_CHARS = 2000;
                let memText = "";
                for (const r of memResults) {
                  if (r.score < 0.15) continue;
                  const entry = `[${r.path}:${r.startLine}-${r.endLine}] (score=${r.score.toFixed(2)})\n${r.snippet}`;
                  if (memText.length + entry.length > MAX_MEMORY_CHARS) break;
                  memText += (memText ? "\n---\n" : "") + entry;
                }
                if (memText) {
                  subTaskMemoryCtx = `\n\n[📚 相关记忆]\n以下是从记忆库中检索到的与当前任务相关的信息片段，供参考：\n${memText}`;
                  console.log(`[followup-runner] 📚 M10 子任务记忆注入: ${memResults.length} results, ${subTaskMemoryCtx.length} chars (taskType=${memTaskType})`);
                }
              }
            } catch {
              // 记忆检索失败不阻塞任务执行
            }
          }
        }

        // 🆕 NovelsAssets: 写作/角色扮演子任务自动注入小说素材参考片段
        // 从 NovelsAssets/ 目录检索与当前任务相关的原文片段（风格参考、情节参考）
        // 仅对 writing/design 类型子任务启用，零远程 API 调用
        let novelReferenceCtx = "";
        if (shouldInjectHeavyContext && isSubTaskForMemory && queued.run.workspaceDir) {
          const novelTaskTypes = ["writing", "design"];
          const taskType = subTask?.taskType ?? "generic";
          if (novelTaskTypes.includes(taskType)) {
            try {
              const novelAvailable = await hasNovelAssets(queued.run.workspaceDir);
              if (novelAvailable) {
                const searchQuery = subTask?.summary || queued.prompt.substring(0, 300);
                const novelResult = await searchNovelAssets(searchQuery, queued.run.workspaceDir, {
                  maxSnippets: 4,
                  snippetTargetChars: 400,
                  snippetMaxChars: 600,
                  maxSnippetsPerFile: 2,
                  minScore: 0.15,
                  autoExtractKeywords: true,
                });
                if (novelResult.snippets.length > 0) {
                  const MAX_NOVEL_REF_CHARS = 3000;
                  const formatted = formatNovelSnippetsForPrompt(novelResult, MAX_NOVEL_REF_CHARS);
                  if (formatted) {
                    novelReferenceCtx = `\n\n[📖 原文参考片段]\n以下是从小说素材库中检索到的与当前创作任务相关的原文片段，请参考其写作风格、描写手法和叙事节奏：\n${formatted}`;
                    console.log(`[followup-runner] 📖 NovelsAssets 参考注入: ${novelResult.snippets.length} snippets, ${novelReferenceCtx.length} chars, ${novelResult.durationMs}ms (taskType=${taskType})`);
                  }
                }
              }
            } catch {
              // 素材检索失败不阻塞任务执行
            }
          }
        }

        const fallbackResult = await runWithModelFallback({
          cfg: queued.run.config,
          provider: queued.run.provider,
          model: queued.run.model,
          fallbacksOverride: resolveAgentModelFallbacksOverride(
            queued.run.config,
            resolveAgentIdFromSessionKey(queued.run.sessionKey),
          ),
          run: (provider, model) => {
            const authProfileId =
              provider === queued.run.provider ? queued.run.authProfileId : undefined;
            // 🔧 并行子任务 session lane 隔离：
            // 根因：runEmbeddedPiAgent 内部用 sessionKey 作为 session lane 的 key，
            // maxConcurrent=1，导致同一 session 下的所有子任务被串行化。
            // drain 的 Promise.allSettled 并行只是让多个 runner 同时进入队列等待，
            // 但实际 LLM 调用是一个接一个的。
            // 修复：给子任务的 sessionKey 加上 subTaskId 后缀，让每个子任务有独立的
            // session lane，从而实现真正的并行 LLM 调用。
            const effectiveSessionKey = (queued.isQueueTask && queued.subTaskId)
              ? `${queued.run.sessionKey}:task:${queued.subTaskId}`
              : queued.run.sessionKey;
            // 🔧 子任务工具白名单：大幅裁剪 system prompt 体积（60KB → ~15KB）
            // 创作/执行子任务只需 write+read+edit+exec，无需 browser/web/slack/canvas 等
            const isSubTaskExec = Boolean(queued.subTaskId) && !queued.isRootTask && !queued.isNewRootTask;
            // 🔧 P46: 根据任务类型动态调整工具白名单（替代一刀切 5 工具）
            // 刻板问题：所有子任务统一只允许 write/read/edit/exec/process，
            // 但自动化/研究类子任务需要 browser/web 等工具才能完成任务。
            let subTaskToolAllowlist: string[] | undefined;
            if (isSubTaskExec) {
              const taskType = subTask?.taskType ?? "generic";
              if (taskType === "automation") {
                // 自动化类：需要浏览器、网络、命令执行等全套工具
                subTaskToolAllowlist = ["write", "read", "edit", "exec", "process", "browser", "web", "fetch"];
              } else if (taskType === "research" || taskType === "analysis") {
                // 研究/分析类：需要网络搜索和文件读写
                subTaskToolAllowlist = ["write", "read", "edit", "exec", "process", "web", "fetch"];
              } else if (taskType === "coding") {
                // 编码类：需要执行和测试
                subTaskToolAllowlist = ["write", "read", "edit", "exec", "process", "test"];
              } else {
                // 写作/通用类：基础工具即可
                subTaskToolAllowlist = ["write", "read", "edit", "exec", "process"];
              }
              // 🔧 P118: continue_generation 对所有任务类型可用（输出续传机制）
              if (!subTaskToolAllowlist.includes("continue_generation")) {
                subTaskToolAllowlist.push("continue_generation");
              }
              // 🔧 P102: prompt 驱动的 memory 工具动态注入
              // 根因：子任务 prompt 明确要求使用 memory_search/write/update/delete 等工具，
              // 但白名单中没有它们 → LLM 被迫用 exec 替代 → 路径不存在 → 退化为幻觉文本
              const MEMORY_TOOL_NAMES = [
                "memory_search", "memory_get", "memory_write", "memory_update",
                "memory_delete", "memory_list", "memory_deep_search",
              ];
              const promptLower = (subTask?.prompt ?? queued.prompt ?? "").toLowerCase();
              const needsMemoryTools = MEMORY_TOOL_NAMES.some((t) => promptLower.includes(t)) ||
                /(?:记忆|memory)\s*(?:检索|搜索|查询|写入|更新|删除|列表|工具)/.test(promptLower) ||
                /(?:使用|调用|用)\s*(?:记忆|memory)/.test(promptLower);
              if (needsMemoryTools) {
                for (const mt of MEMORY_TOOL_NAMES) {
                  if (!subTaskToolAllowlist.includes(mt)) {
                    subTaskToolAllowlist.push(mt);
                  }
                }
              }
            }

            let lastToolProgressSentAt = 0;
            let lastToolProgressText = "";
            const shouldEmitToolProgress = () =>
              Boolean(TOOL_PROGRESS_ENABLED && queued.isQueueTask && queued.subTaskId);
            const maybeSendToolProgress = async (text?: string) => {
              const msg = (text ?? "").trim();
              if (!msg) return;
              if (!shouldEmitToolProgress()) return;

              const now = Date.now();
              if (now - lastToolProgressSentAt < TOOL_PROGRESS_MIN_GAP_MS) return;
              if (msg === lastToolProgressText) return;

              const MAX_CHARS = 600;
              const clipped = msg.length > MAX_CHARS ? msg.slice(0, MAX_CHARS) + "…" : msg;

              lastToolProgressSentAt = now;
              lastToolProgressText = msg;
              try {
                await sendFollowupPayloads([{ text: `\n[🛠️ 工具进展]\n${clipped}` }], queued);
              } catch {
              }
            };

            return runEmbeddedPiAgent({
              sessionId: queued.run.sessionId,
              sessionKey: effectiveSessionKey,
              messageProvider: queued.run.messageProvider,
              agentAccountId: queued.run.agentAccountId,
              messageTo: queued.originatingTo,
              messageThreadId: queued.originatingThreadId,
              groupId: queued.run.groupId,
              groupChannel: queued.run.groupChannel,
              groupSpace: queued.run.groupSpace,
              sessionFile: llmSessionFile,
              workspaceDir: queued.run.workspaceDir,
              config: queued.run.config,
              // 🔧 子任务跳过 skills（省掉 skill 描述注入，减少 prompt 体积）
              skillsSnapshot: isSubTaskExec ? undefined : queued.run.skillsSnapshot,
              runMode: "tool_exec_compact",
              toolAllowlist: subTaskToolAllowlist,
              // 🔧 子任务跳过 bootstrap 文件（AGENTS.md/SOUL.md），减少 prompt 体积
              skipBootstrapContext: isSubTaskExec,
              shouldEmitToolResult: shouldEmitToolProgress,
              shouldEmitToolOutput: () => false,
              onToolResult: async (payload) => {
                await maybeSendToolProgress(payload?.text);
              },
              prompt: (() => {
                // 🔧 子任务强制落盘：在 prompt 本体注入指令（用户消息级，LLM 遵从度最高）
                const isSubTask = Boolean(queued.subTaskId);
                if (isSubTask) {
                  // 🔧 写入目录：workspace/{rootTaskId}/，避免污染工作目录根
                  const taskOutputDir = queued.rootTaskId
                    ? `workspace/${queued.rootTaskId}`
                    : "workspace";
                  
                  // 🆕 a4: 阶段归档上下文（轻量）
                  const phaseHint = phaseContext
                    ? `\n\n[🧾 最近阶段归档]\n以下是系统自动记录的最近阶段检查点摘要（用于长程连续与断点续跑）。请以它为准继续推进，不要重复已完成的工作：\n${phaseContext}`
                    : "";

                  // 🆕 A1: 迭代优化 — 如果有上次输出和失败原因，注入到 prompt
                  let iterationHint = "";
                  if (subTask?.metadata?.previousOutput || subTask?.metadata?.lastFailureFindings) {
                    const parts: string[] = ["\n\n[⚠️ 迭代优化指令] 这是重试执行。请基于上次的结果进行改进，不要从零开始。"];
                    if (subTask.metadata.lastFailureFindings && subTask.metadata.lastFailureFindings.length > 0) {
                      // 🔧 P108: 防御性类型检查 — lastFailureFindings 可能是字符串（LLM 质检返回不一致）
                      const findings = Array.isArray(subTask.metadata.lastFailureFindings)
                        ? subTask.metadata.lastFailureFindings
                        : [String(subTask.metadata.lastFailureFindings)];
                      parts.push(`上次被打回的原因：${findings.join("；")}`);
                      parts.push("请针对以上问题重点改进。");
                    }
                    if (subTask.metadata.previousOutput) {
                      // 🔧 P47: 根据任务类型动态调整 previousOutput 截断长度
                      // 刻板问题：固定 1500 字截断不区分任务类型——
                      // 写作类需要更多上下文保持风格/情节连贯，编码类 1000 字就够定位问题
                      const prevOutputTaskType = subTask.taskType ?? "generic";
                      let prevMaxLen = 1500; // 基线
                      if (prevOutputTaskType === "writing") {
                        prevMaxLen = 2500; // 写作类：需要更多上下文保连贯性
                      } else if (prevOutputTaskType === "coding" || prevOutputTaskType === "data") {
                        prevMaxLen = 1000; // 编码/数据类：关键错误信息通常在开头
                      }
                      // 🔧 P60: 智能截断 — 按内容结构找最近的完整边界，避免断在句子/函数中间
                      let prevSnippet: string;
                      if (subTask.metadata.previousOutput.length <= prevMaxLen) {
                        prevSnippet = subTask.metadata.previousOutput;
                      } else {
                        const raw = subTask.metadata.previousOutput.substring(0, prevMaxLen);
                        let cutIdx = prevMaxLen;
                        if (prevOutputTaskType === "writing") {
                          // 写作类：找最后一个段落边界或句号
                          const paraIdx = raw.lastIndexOf("\n\n");
                          const sentIdx = Math.max(raw.lastIndexOf("。"), raw.lastIndexOf("！"), raw.lastIndexOf("？"), raw.lastIndexOf(".")); 
                          cutIdx = paraIdx > prevMaxLen * 0.6 ? paraIdx : (sentIdx > prevMaxLen * 0.6 ? sentIdx + 1 : prevMaxLen);
                        } else if (prevOutputTaskType === "coding") {
                          // 编码类：找最后一个完整行
                          const lineIdx = raw.lastIndexOf("\n");
                          cutIdx = lineIdx > prevMaxLen * 0.5 ? lineIdx : prevMaxLen;
                        } else {
                          // 其他：找最后一个句子边界
                          const sentIdx = Math.max(raw.lastIndexOf("。"), raw.lastIndexOf("。"), raw.lastIndexOf("\n"), raw.lastIndexOf(". "));
                          cutIdx = sentIdx > prevMaxLen * 0.6 ? sentIdx + 1 : prevMaxLen;
                        }
                        prevSnippet = raw.substring(0, cutIdx) + "\n...[截断]";
                      }
                      parts.push(`上次的输出（供参考和改进）：\n---\n${prevSnippet}\n---`);
                      parts.push("请在上次输出的基础上改进，保留好的部分，修正问题部分。");
                    }
                    iterationHint = parts.join("\n");
                    console.log(`[followup-runner] 🔄 注入迭代优化指令 (previousOutput=${subTask.metadata.previousOutput?.length ?? 0} chars, findings=${subTask.metadata.lastFailureFindings?.length ?? 0})`);
                  }
                  
                  // 🆕 V5: chunk 子任务的落盘指令不指定 .txt 扩展名（chunk prompt 已指定 .md 格式）
                  const isChunkTask = subTask?.metadata?.isChunkTask ?? false;
                  const mrPrompts = getPrompts().mapReduce;
                  const fileTypeHint = isChunkTask ? mrPrompts.chunkFileTypeHint : mrPrompts.defaultFileTypeHint;
                  // 🔧 P87a: chunk 任务不注入冲突的写入目录指令
                  // 根因：decomposeIntoMapReduce 的 chunk prompt 已指定精确路径（~/.clawdbot/tasks/{sessionId}/chunk_XXX.md），
                  // 但此处注入的 "保存到 workspace/{rootTaskId}/" 与之冲突，LLM 有时遵循这里的指令写到 workspace 目录，
                  // 导致文件不在 finalize 预期的路径下（chunk-2/chunk-5 缺失问题）。
                  // 修复：chunk 任务跳过目录指定（chunk prompt 已有精确路径），只保留"必须用 write 工具"和"禁止委派"。
                  const dirHint = isChunkTask
                    ? "（请严格按照任务描述中指定的路径和文件名保存）"
                    : `，保存到 ${taskOutputDir}/ 目录下（文件名含任务摘要）`;
                  return `[⚠️ 强制规则] 你必须亲自使用 write 工具将生成内容写入${fileTypeHint}${dirHint}。然后在聊天中仅回复简短确认。禁止将完整内容直接输出到聊天。\n[🚫 禁止委派] 严禁调用 enqueue_task、sessions_spawn、batch_enqueue_tasks。你必须自己直接完成任务，不能把任务交给任何人。${iterationHint}${phaseHint}\n\n${queued.prompt}`;
                }
                return queued.prompt;
              })(),
              extraSystemPrompt: (() => {
                // 🆕 子任务间上下文共享：注入已完成兄弟任务的输出摘要
                // 🔧 传入 currentTaskId，让 buildSiblingContext 智能过滤：
                // 续写子任务只注入直接依赖的前序任务，避免 prompt 膨胀导致上下文溢出
                let siblingCtx = taskTree?.subTasks
                  ? buildSiblingContext(taskTree.subTasks, 200, subTask?.id)
                  : "";
                if (siblingCtx) {
                  console.log(`[followup-runner] 📋 Injecting sibling context (${siblingCtx.length} chars)`);
                }
                const base = queued.run.extraSystemPrompt ?? "";

                // 🔧 子任务强制落盘（二级强化，主指令已注入 prompt 本体）
                const isSubTask = Boolean(queued.subTaskId);
                const persistInstruction = isSubTask
                  ? "\n\n[SYSTEM] 子任务必须用 write 工具落盘，禁止纯文本输出。严禁使用 enqueue_task/sessions_spawn/batch_enqueue_tasks 委派任务，必须亲自完成。"
                  : "";

                // 🆕 V7: 结构化纲领精准注入（写作任务优先）
                // 当结构化纲领组件可用时，精准注入"人物卡 + 风格指南 + 该章纲要"
                // 替代原来的"大段截断纲领"，信息损失为零
                let blueprintCtx = "";
                let chapterOutlineCtx = "";
                const meta = taskTree?.metadata;
                const hasStructuredBlueprint = meta?.blueprintCharacterCards && meta.blueprintCharacterCards.length > 50;

                if (isSubTask && hasStructuredBlueprint) {
                  // ── V7 路径：结构化精准注入 ──
                  const parts: string[] = [];

                  // 1. 世界观设定（紧凑版，截断到 1500 字）
                  if (meta.blueprintWorldBuilding) {
                    const wb = meta.blueprintWorldBuilding.length > 1500
                      ? meta.blueprintWorldBuilding.substring(0, 1500) + "\n...[世界观设定已截断]"
                      : meta.blueprintWorldBuilding;
                    parts.push(`[🌍 世界观设定]\n${wb}`);
                  }

                  // 2. 风格指南（完整注入，通常较短）
                  if (meta.blueprintStyleGuide) {
                    parts.push(`[🎨 风格指南]\n${meta.blueprintStyleGuide}`);
                  }

                  // 3. 人物卡片（完整注入——这是创作一致性的关键）
                  if (meta.blueprintCharacterCards) {
                    parts.push(`[👤 人物卡片]\n以下是所有主要角色的详细档案，你必须严格遵循每个角色的性格特征、动机和语言习惯：\n${meta.blueprintCharacterCards}`);
                  }

                  // 4. 精准匹配该章节的剧情纲要（替代原来的大段截断）
                  if (meta.blueprintChapterSynopses && Object.keys(meta.blueprintChapterSynopses).length > 0) {
                    // 从 summary 中提取章节号
                    const cnMap: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
                    const chMatch = subTask?.summary?.match(/第\s*([一二三四五六七八九十\d]+)\s*[章节篇幕]/);
                    let chapterNum = 0;
                    if (chMatch) {
                      chapterNum = cnMap[chMatch[1]] ?? parseInt(chMatch[1], 10);
                    }
                    // 🔧 P51: 优先使用 chapterNumber（精确章节号），替代错误的 segmentIndex 回退
                    // segmentIndex 是段内序号（第几段），不是章节号，不能用于匹配章节纲要
                    if (!chapterNum && subTask?.metadata?.chapterNumber) {
                      chapterNum = subTask.metadata.chapterNumber;
                    }

                    const synopsis = chapterNum > 0
                      ? meta.blueprintChapterSynopses[String(chapterNum)]
                      : undefined;

                    if (synopsis) {
                      // 精准注入该章的剧情纲要
                      chapterOutlineCtx = `\n\n[📖 本章剧情纲要（第${chapterNum}章）]\n以下是你当前章节的详细剧情纲要，请严格按此纲要完成创作：\n---\n${synopsis}\n---`;
                      console.log(`[followup-runner] � V7 精准注入第${chapterNum}章纲要 (${synopsis.length} chars)`);

                      // 同时注入相邻章节的简要摘要（衔接用）
                      const prevSynopsis = chapterNum > 1 ? meta.blueprintChapterSynopses[String(chapterNum - 1)] : undefined;
                      const nextSynopsis = meta.blueprintChapterSynopses[String(chapterNum + 1)];
                      if (prevSynopsis || nextSynopsis) {
                        const adjacentParts: string[] = [];
                        if (prevSynopsis) {
                          // 上一章只取前 300 字作为衔接参考
                          adjacentParts.push(`[上一章（第${chapterNum - 1}章）简要]: ${prevSynopsis.substring(0, 300)}...`);
                        }
                        if (nextSynopsis) {
                          adjacentParts.push(`[下一章（第${chapterNum + 1}章）简要]: ${nextSynopsis.substring(0, 300)}...`);
                        }
                        chapterOutlineCtx += `\n\n[🔗 相邻章节参考]\n${adjacentParts.join("\n")}`;
                      }
                    } else {
                      // 未匹配到章节号，注入所有章节纲要概览
                      const allSynopses = Object.entries(meta.blueprintChapterSynopses)
                        .sort(([a], [b]) => Number(a) - Number(b))
                        .map(([num, syn]) => `第${num}章: ${syn.substring(0, 150)}...`)
                        .join("\n");
                      if (allSynopses) {
                        chapterOutlineCtx = `\n\n[📖 各章节纲要概览]\n${allSynopses}`;
                      }
                    }
                  }

                  blueprintCtx = parts.length > 0
                    ? `\n\n${parts.join("\n\n---\n\n")}`
                    : "";
                  const totalInjected = blueprintCtx.length + chapterOutlineCtx.length;
                  console.log(`[followup-runner] 🎼 V7 结构化纲领注入: worldBuilding=${meta.blueprintWorldBuilding?.length ?? 0}, styleGuide=${meta.blueprintStyleGuide?.length ?? 0}, characters=${meta.blueprintCharacterCards?.length ?? 0}, total=${totalInjected} chars`);

                } else if (isSubTask && meta?.masterBlueprint) {
                  // ── 回退路径：原有纲领截断注入（P48 位置感知截断） ──
                  const blueprint = meta.masterBlueprint;
                  const MAX_BLUEPRINT = 6000;
                  let truncated: string;
                  if (blueprint.length <= MAX_BLUEPRINT) {
                    truncated = blueprint;
                  } else {
                    const segIndex = subTask?.metadata?.segmentIndex ?? 0;
                    const totalSegs = subTask?.metadata?.totalSegments ?? 0;
                    const chMatch = subTask?.summary?.match(/第\s*(\d+)\s*章/);
                    const chapterNum = chMatch ? parseInt(chMatch[1], 10) : 0;
                    let positionRatio = 0.5;
                    if (totalSegs > 0 && segIndex > 0) {
                      positionRatio = (segIndex - 1) / Math.max(totalSegs - 1, 1);
                    } else if (chapterNum > 0) {
                      positionRatio = Math.min((chapterNum - 1) / 6, 1);
                    }
                    const headRatio = Math.max(0.3, 1 - positionRatio * 0.6);
                    const headLen = Math.floor(MAX_BLUEPRINT * headRatio);
                    const tailLen = MAX_BLUEPRINT - headLen;
                    truncated = blueprint.substring(0, headLen)
                      + "\n\n...[纲领中段已省略，保留首尾关键内容]...\n\n"
                      + blueprint.substring(blueprint.length - tailLen);
                  }
                  blueprintCtx = `\n\n[📋 总纲领 / Master Blueprint]\n以下是整体任务的详细规划纲领，你必须严格遵循其中与你当前子任务相关的部分。\n确保角色描述、世界观设定、风格要求与纲领一致。\n---\n${truncated}\n---`;
                  console.log(`[followup-runner] 🎼 注入总纲领 (${blueprint.length} chars, truncated=${blueprint.length > MAX_BLUEPRINT})`);

                  // 回退路径也注入 chapterOutline（如果有）
                  if (subTask?.metadata?.chapterOutline) {
                    chapterOutlineCtx = `\n\n[📖 本任务专属大纲]\n以下是你当前子任务的详细大纲，请严格按此大纲完成创作/执行：\n---\n${subTask.metadata.chapterOutline}\n---`;
                    console.log(`[followup-runner] 📖 注入章节大纲 (${subTask.metadata.chapterOutline.length} chars)`);
                  }
                }

                // ── V8 P0: 预算感知组装 ──
                // 在拼接前检查总 token 是否超预算，超预算时按优先级压缩低优先级组件。
                // 保留现有的每个组件构建逻辑（提供合理的"期望"大小），
                // 这里只做最终安全网——确保不超过模型 context window。
                const contextWindow = queued.modelContextWindow;
                const maxOutputTokens = queued.modelMaxOutputTokens;

                if (contextWindow && contextWindow > 0 && isSubTask) {
                  // 估算用户 prompt 消耗（已在外层 IIFE 构建完毕，这里用原始 prompt 估算）
                  const promptTokensEstimate = estimateTokens(queued.prompt) + 500; // +500 for 落盘/禁委派/迭代指令
                  const systemBaseTokens = estimateTokens(base) + estimateTokens(persistInstruction);

                  const requests: BudgetRequest[] = [
                    { slot: "systemBase", desired: systemBaseTokens, minimum: systemBaseTokens, priority: 0 },
                    { slot: "userPrompt", desired: promptTokensEstimate, minimum: promptTokensEstimate, priority: 2 },
                    { slot: "chapterOutline", desired: estimateTokens(chapterOutlineCtx), minimum: 200, priority: 3, content: chapterOutlineCtx },
                    { slot: "blueprint", desired: estimateTokens(blueprintCtx), minimum: 300, priority: 4, content: blueprintCtx },
                    { slot: "siblingContext", desired: estimateTokens(siblingCtx), minimum: 0, priority: 6, content: siblingCtx },
                  ];

                  const allocation = allocateBudget(contextWindow, maxOutputTokens ?? 4096, requests);

                  if (allocation.compressed) {
                    console.log(`[followup-runner] 📊 V8 P0 预算压缩触发:\n${allocation.compressionLog}`);
                    // 按分配结果截断被压缩的组件
                    if (estimateTokens(blueprintCtx) > allocation.slots.blueprint && allocation.slots.blueprint > 0) {
                      blueprintCtx = truncateToTokenBudget(blueprintCtx, allocation.slots.blueprint, {
                        direction: "both", headRatio: 0.7, contentType: "writing",
                      });
                      console.log(`[followup-runner] 📊 纲领截断: ${allocation.slots.blueprint} tokens`);
                    } else if (allocation.slots.blueprint === 0) {
                      blueprintCtx = "";
                      console.log(`[followup-runner] 📊 纲领完全丢弃（预算不足）`);
                    }
                    if (estimateTokens(chapterOutlineCtx) > allocation.slots.chapterOutline && allocation.slots.chapterOutline > 0) {
                      chapterOutlineCtx = truncateToTokenBudget(chapterOutlineCtx, allocation.slots.chapterOutline, {
                        direction: "head", contentType: "writing",
                      });
                    } else if (allocation.slots.chapterOutline === 0) {
                      chapterOutlineCtx = "";
                    }
                    if (allocation.slots.siblingContext === 0) {
                      siblingCtx = "";
                    }
                  }
                }

                // 🆕 V9: 父任务目标上下文注入
                // 让子任务清晰知道整体项目目标，确保产出服务于统一目标
                let parentGoalCtx = "";
                if (isSubTask && taskTree?.rootTask) {
                  // 优先使用已缓存的 parentGoalSummary（由 orchestrator 分解后生成）
                  const cachedGoal = subTask?.metadata?.parentGoalSummary;
                  if (cachedGoal && cachedGoal.length > 10) {
                    parentGoalCtx = `\n\n[🎯 总任务目标]\n${cachedGoal}`;
                  } else if (taskTree.rootTask.length <= 300) {
                    // 短目标直接注入
                    const role = subTask?.summary ? `你当前负责：「${subTask.summary}」` : "";
                    parentGoalCtx = `\n\n[🎯 总任务目标]\n${taskTree.rootTask}\n${role}`;
                  } else {
                    // 长目标截断（LLM 摘要在 orchestrator 分解时异步生成）
                    const role = subTask?.summary ? `你当前负责：「${subTask.summary}」` : "";
                    parentGoalCtx = `\n\n[🎯 总任务目标]\n${taskTree.rootTask.substring(0, 300)}...\n${role}`;
                  }
                }

                const combined = [base, siblingCtx, parentGoalCtx, subTaskMemoryCtx, novelReferenceCtx, persistInstruction, blueprintCtx, chapterOutlineCtx, experienceHint ? `\n\n${experienceHint}` : ""].filter(Boolean).join("");
                return combined || undefined;
              })(),
              ownerNumbers: queued.run.ownerNumbers,
              enforceFinalTag: queued.run.enforceFinalTag,
              provider,
              model,
              authProfileId,
              authProfileIdSource: authProfileId ? queued.run.authProfileIdSource : undefined,
              thinkLevel: queued.run.thinkLevel,
              verboseLevel: queued.run.verboseLevel,
              reasoningLevel: queued.run.reasoningLevel,
              execOverrides: queued.run.execOverrides,
              bashElevated: queued.run.bashElevated,
              timeoutMs: queued.run.timeoutMs,
              runId,
              blockReplyBreak: queued.run.blockReplyBreak,
              onAgentEvent: (evt) => {
                if (evt.stream !== "compaction") return;
                const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                const willRetry = Boolean(evt.data.willRetry);
                if (phase === "end" && !willRetry) {
                  autoCompactionCompleted = true;
                }
              },
            });
          },
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;

        // ── AttemptOutcome: attempt 层结构化恢复建议（激进长程连续改造契约）──
        // 在任何“输出净化/OutputValidator/落盘”之前优先处理，以避免错误被当作产出。
        if (taskTree && subTask && runResult.attemptOutcome) {
          const ao = runResult.attemptOutcome;
          // 记录到 metadata 以便后续诊断与回放
          if (!subTask.metadata) subTask.metadata = {};
          subTask.metadata.lastAttemptOutcome = ao;

          if (!ao.ok) {
            // degrade: 标记 provider 降级，让下一次从 attempt.ts Step 3.9 起就进入文本工具模式
            if (ao.suggestedAction === "degrade" && ao.hints?.needsTextToolMode && fallbackProvider) {
              try {
                const { markDegradedProvider } = await import("../../agents/text-tool-fallback.js");
                markDegradedProvider(fallbackProvider, fallbackModel ?? "unknown");
                console.log(
                  `[followup-runner] 🔧 AttemptOutcome degrade: 标记 provider ${fallbackProvider}/${fallbackModel} 为降级（下次启用文本工具模式）`,
                );
              } catch {
                // 降级模块加载失败不阻塞
              }
            }

            // shrink_context: 提升收缩等级并重试（下一轮自动减少上下文注入）
            if (ao.suggestedAction === "shrink_context" || ao.hints?.needsContextShrink) {
              subTask.metadata.contextShrinkLevel = (subTask.metadata.contextShrinkLevel ?? 0) + 1;
              console.warn(
                `[followup-runner] ⚠️ AttemptOutcome shrink_context: contextShrinkLevel=${subTask.metadata.contextShrinkLevel}, kind=${ao.kind}`,
              );
            }

            // retry/degrade/shrink_context：统一走“pending + 入队 + finalize”闭环
            const shouldRetry = (ao.suggestedAction === "retry" || ao.suggestedAction === "degrade" || ao.suggestedAction === "shrink_context")
              && ao.retryable !== false
              && (subTask.retryCount ?? 0) < 4;

            if (shouldRetry) {
              subTask.retryCount = (subTask.retryCount ?? 0) + 1;
              subTask.status = "pending";
              subTask.error = `AttemptOutcome(${ao.kind}): ${ao.details?.message ?? ""}`.trim();
              await orchestrator.saveTaskTree(taskTree);

              const delayMs = Math.min(Math.max(ao.suggestedDelayMs ?? 0, 0), 10_000);
              if (delayMs > 0) {
                console.log(`[followup-runner] ⏳ AttemptOutcome retry backoff: ${delayMs}ms`);
                await _sleep(delayMs);
              }

              if (queued.run.sessionKey) {
                const retryFollowupRun = buildFollowupRun(queued, subTask);
                const resolvedQueue = resolveQueueSettings({
                  cfg: queued.run.config ?? ({} as any),
                  inlineMode: "followup",
                });
                enqueueFollowupRun(queued.run.sessionKey, retryFollowupRun, resolvedQueue, "none");
                console.log(
                  `[followup-runner] 🔄 AttemptOutcome retry 已入队: ${subTask.id} (retryCount=${subTask.retryCount}, kind=${ao.kind})`,
                );
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }
          }
        }

        // 🆕 进度报告：LLM 回复完成
        {
          const outputChars = (fallbackResult.result.payloads ?? [])
            .reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
          progressReporter?.onLLMComplete(outputChars > 0 ? outputChars : undefined);
        }
        
        // 🔧 如果找到了子任务，更新状态为 "completed" 并保存输出
        if (taskTree && subTask) {
          // 🔧 竞态保护：重新加载最新的任务树，防止并行 runner 的修改被覆盖
          // 问题：多个 runner 并行执行时，各自持有不同时刻加载的 taskTree 快照。
          // 后保存的 runner 会覆盖先保存的修改（如 output、producedFilePaths 丢失）。
          const freshTree = await orchestrator.loadTaskTree(sessionId);
          if (freshTree && queued.subTaskId) {
            const freshSubTask = freshTree.subTasks.find(t => t.id === queued.subTaskId);
            if (freshSubTask) {
              taskTree = freshTree;
              subTask = freshSubTask;
            }
          }

          const payloadArray = runResult.payloads ?? [];
          // 🔧 P100 修复：排除 isError:true 的 payload（API 错误消息不应作为任务产出）
          // 根因：LLM 返回 stopReason="error" 时，errorMessage 通过 buildEmbeddedRunPayloads
          // 作为 isError:true 的 payload 传入。旧代码不区分正常输出和错误输出，
          // 导致 "Incomplete JSON segment at the end" 等错误消息被存为 subTask.output，
          // 进而触发字数不达标 → decomposeFailedTask → 生成无意义续写任务。
          let contentPayloads = payloadArray.filter((p) => !p.isError);
          let errorPayloads = payloadArray.filter((p) => p.isError);

          // 🔧 P110 修复：检测 contentPayloads 中的伪内容（API 错误格式化文本泄漏）
          // 根因：API adapter 在 assistant.content[0].text 中放入格式化错误文本
          // （如 "⚠️ API 返回了错误响应..."），但 formatAssistantErrorText 从 errorMessage
          // 解析生成不同格式（如 "HTTP 429 ..."）。shouldSuppressRawErrorText 比较两者不匹配，
          // 导致错误文本作为非 isError payload 通过。P100 检查 !outputText 失败。
          {
            const _p110IsApiErrorText = (text: string): boolean => {
              const t = text.trim();
              if (!t) return false;
              // 中文格式化错误消息（API adapter 生成）
              if (/^⚠️\s*API\s*返回了错误/.test(t)) return true;
              // 英文格式化错误消息
              if (/^⚠️\s*(?:The )?AI service returned an error/i.test(t)) return true;
              // 包含错误 JSON payload 的文本
              if (/错误信息[：:]\s*\{/.test(t) && /"(?:code|status)"/.test(t)) return true;
              // HTTP 状态码错误（buildEmbeddedRunPayloads 格式）
              if (/^HTTP\s+[45]\d{2}\b/i.test(t)) return true;
              // 纯 JSON API 错误 payload
              if (/^\{.*"error".*"(?:code|status|message)".*\}$/s.test(t)) return true;
              // 常见 429/5xx 模式
              if (/(?:Too Many Requests|rate.?limit|负载已饱和|upstream.*overloaded)/i.test(t) && t.length < 500) return true;
              return false;
            };
            const realContent = contentPayloads.filter(p => !_p110IsApiErrorText(p.text ?? ""));
            const pseudoErrors = contentPayloads.filter(p => _p110IsApiErrorText(p.text ?? ""));
            if (realContent.length === 0 && pseudoErrors.length > 0) {
              console.warn(
                `[followup-runner] ⚠️ P110: ${pseudoErrors.length} 个 contentPayload 为 API 错误伪内容，重新归类为 errorPayloads`,
              );
              contentPayloads = realContent;
              errorPayloads = [...errorPayloads, ...pseudoErrors];
            }
          }

          // 🔧 P111 修复：过滤 [Historical context: ...] 幻觉文本
          // 根因：LLM 成功执行工具后偶发输出幻觉工具调用文本（Gemini function calling 偶发失败），
          // P88 Spot Recovery 尝试恢复但可能失败，幻觉文本仍留在 assistantTexts 中被存为 output。
          // 修复：从内容中剥离 [Historical context: ...] 块，只保留真正的内容。
          const _p111StripHistoricalContext = (text: string): string => {
            return text.replace(
              /\[Historical context:.*?Do not mimic this format[^\]]*\]/gs,
              "",
            ).trim();
          };

          const outputText = (() => {
            const raw = contentPayloads.map((p) => p.text).filter(Boolean).join("\n");
            const stripped = _p111StripHistoricalContext(raw);
            if (stripped !== raw && stripped.length < raw.length * 0.5) {
              console.warn(
                `[followup-runner] ⚠️ P111: 输出中含 [Historical context:] 幻觉文本，已剥离 (${raw.length} → ${stripped.length} chars)`,
              );
            }
            return stripped;
          })();

          // P100: 如果正常内容为空但有错误 payload → API 临时故障，直接重试
          if (!outputText && errorPayloads.length > 0) {
            const errorSummary = errorPayloads.map((p) => p.text).filter(Boolean).join("; ").substring(0, 200);
            console.warn(
              `[followup-runner] ⚠️ P100: 无正常输出但有 API 错误: ${errorSummary}`,
            );
            subTask.retryCount = (subTask.retryCount ?? 0) + 1;
            const willRetryApiError = subTask.retryCount < 3;
            if (willRetryApiError) {
              subTask.status = "pending";
              subTask.error = `API 错误（无正常输出）: ${errorSummary}`;
              await orchestrator.saveTaskTree(taskTree);
              console.log(
                `[followup-runner] 🔄 P100: API 错误自动重试 (${subTask.retryCount}/3)`,
              );
              if (queued.run.sessionKey) {
                const retryFollowupRun = buildFollowupRun(queued, subTask);
                const resolvedQueue = resolveQueueSettings({
                  cfg: queued.run.config ?? ({} as any),
                  inlineMode: "followup",
                });
                enqueueFollowupRun(queued.run.sessionKey, retryFollowupRun, resolvedQueue, "none");
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }
            // 重试次数耗尽，标记失败
            subTask.status = "failed";
            subTask.error = `API 错误（重试耗尽）: ${errorSummary}`;
            await orchestrator.saveTaskTree(taskTree);
            if (queued.run.sessionKey) {
              finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
            }
            return;
          }

          // 🔧 P103: 防御性 API 错误检测 — 检测 outputText 本身是否实际是 API 错误消息
          // 根因：PI library 将 429 错误格式化为中文 "⚠️ API 返回了错误响应..." 放入 content[0].text，
          // buildEmbeddedRunPayloads 的 shouldSuppressRawErrorText 无法匹配该中文格式（它只对比
          // formatAssistantErrorText 的英文输出和 rawErrorMessage 的 JSON），导致错误文本流入
          // contentPayloads（未标记 isError），outputText 非空，P100 守卫被绕过。
          // 修复：对 outputText 做二次 API 错误模式检测，命中时走 P100 相同的重试/失败路径。
          if (outputText && _isOutputApiError(outputText)) {
            const errorSummary = outputText.substring(0, 200);
            console.warn(
              `[followup-runner] ⚠️ P103: output 实际为 API 错误消息: ${errorSummary}`,
            );
            subTask.retryCount = (subTask.retryCount ?? 0) + 1;
            const willRetryP103 = subTask.retryCount < 3;
            if (willRetryP103) {
              subTask.status = "pending";
              subTask.error = `API 错误（P103 检测）: ${errorSummary}`;
              await orchestrator.saveTaskTree(taskTree);
              console.log(
                `[followup-runner] 🔄 P103: API 错误自动重试 (${subTask.retryCount}/3)`,
              );
              if (queued.run.sessionKey) {
                const retryFollowupRun = buildFollowupRun(queued, subTask);
                const resolvedQueue = resolveQueueSettings({
                  cfg: queued.run.config ?? ({} as any),
                  inlineMode: "followup",
                });
                enqueueFollowupRun(queued.run.sessionKey, retryFollowupRun, resolvedQueue, "none");
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }
            subTask.status = "failed";
            subTask.error = `API 错误（P103 重试耗尽）: ${errorSummary}`;
            await orchestrator.saveTaskTree(taskTree);
            if (queued.run.sessionKey) {
              finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
            }
            return;
          }

          // 🆕 P10: 输出验证门 — 在标记 completed 之前拦截明显无效输出
          const isRootTaskExecution = Boolean(queued.isRootTask || queued.isNewRootTask);
          const validation = validateSubTaskOutput(outputText, runResult.toolMetas ?? [], {
            isRootTask: isRootTaskExecution,
            // 🔧 P98: P88 Spot Recovery 已处理幻觉工具调用时，跳过 OutputValidator 幻觉检测
            spotRecoveryExecuted: runResult.spotRecoveryExecuted,
          });
          if (!validation.valid) {
            console.warn(
              `[followup-runner] ⚠️ OutputValidator 拦截: ${validation.failureCode} — ${validation.failureReason}`,
            );
            subTask.output = outputText;
            subTask.retryCount = (subTask.retryCount ?? 0) + 1;

            // V8 P3: 记录质量经验（OutputValidator 拦截）
            import("../../agents/intelligent-task-decomposition/experience-pool.js").then(ep =>
              ep.recordExperience({
                category: "quality",
                pattern: `output_validator_${validation.failureCode}`,
                lesson: `OutputValidator 拦截: ${validation.failureReason}`,
                suggestion: validation.failureCode === "hallucinated_tool_calls"
                  ? "标记 provider 降级，启用文本工具模式"
                  : "检查子任务 prompt 是否过于模糊",
                taskType: subTask?.taskType,
                providerHint: fallbackProvider,
              }),
            ).catch(() => {});

            // 收集并清理文件追踪
            collectTrackedFiles(subTask.id);

            // 🔧 P92 修复：先决定是否重试，再设置最终状态并只保存一次
            // 根因：旧代码先 status="failed"+save，再 status="pending"+save。
            // P32 merge-on-save 的 _shouldTakeLocal 比较 ordinal(pending=0 < failed=2)，
            // 第二次 save 的 pending 被磁盘的 failed 静默覆盖。
            // 导致重试入队后 drain 的 isRoundCompleted 看到 failed → 轮次误判完成 → 重试被丢弃。
            // 修复：消除双保存，根据重试决策设置最终状态后只保存一次。
            const willRetry = validation.suggestedAction === "retry" && subTask.retryCount < 3;

            if (willRetry) {
              // 🔧 P35 修复：hallucinated_tool_calls 重试时主动标记 provider 降级
              // 根因：LLM 用纯文本输出 tool call，重试时同一 provider 仍然降级，
              // 但 text-tool-fallback 在 Step 5.5 才检测降级（太晚），导致重试同样失败。
              // 修复：提前标记降级，确保下次从 Step 3.9 就注入文本工具描述。
              if (validation.failureCode === "hallucinated_tool_calls" && fallbackProvider) {
                try {
                  const { markDegradedProvider } = await import("../../agents/text-tool-fallback.js");
                  markDegradedProvider(fallbackProvider, fallbackModel ?? "unknown");
                  console.log(
                    `[followup-runner] 🔧 P35: 标记 provider ${fallbackProvider}/${fallbackModel} 为降级，下次重试将启用文本工具模式`,
                  );
                } catch {
                  // text-tool-fallback 模块加载失败，不影响重试流程
                }
              }

              // P92: 直接设置 pending 并保存（不经过 failed 中间状态）
              subTask.status = "pending";
              subTask.error = `OutputValidator: ${validation.failureReason}`;
              await orchestrator.saveTaskTree(taskTree);
              console.log(
                `[followup-runner] 🔄 OutputValidator 建议重试 (${subTask.retryCount}/3)`,
              );
              if (queued.run.sessionKey) {
                // 🔧 P1 修复：OutputValidator retry 时必须创建新的 FollowupRun 入队
                // 修复前：只调用 finalizeWithFollowup 触发 drain，但队列中没有对应的 FollowupRun
                const retryFollowupRun = buildFollowupRun(queued, subTask);
                const resolvedQueue = resolveQueueSettings({
                  cfg: queued.run.config ?? ({} as any),
                  inlineMode: "followup",
                });
                enqueueFollowupRun(queued.run.sessionKey, retryFollowupRun, resolvedQueue, "none");
                console.log(`[followup-runner] 🔄 OutputValidator 重试已入队: ${subTask.id} (retryCount=${subTask.retryCount})`);
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }

            // 不重试：标记失败并保存
            subTask.status = "failed";
            subTask.error = `OutputValidator: ${validation.failureReason}`;
            await orchestrator.saveTaskTree(taskTree);

            // 🔧 P105: OutputValidator 最终失败后检查轮次完成
            // 根因：OutputValidator return 跳过 postProcessSubTaskCompletion，
            // 当轮次中所有子任务都通过此路径失败时（如 PROHIBITED_CONTENT），
            // 没有任何代码检查 isRoundCompleted → 轮次永远 stuck "active"。
            const ovFailRoundId = subTask.rootTaskId ?? queued.rootTaskId;
            if (ovFailRoundId && orchestrator.isRoundCompleted(taskTree, ovFailRoundId)) {
              const ovRound = taskTree.rounds?.find((r: any) => r.id === ovFailRoundId);
              if (ovRound && ovRound.status !== "completed" && ovRound.status !== "failed") {
                await orchestrator.markRoundCompleted(taskTree, ovFailRoundId);
                console.log(
                  `[followup-runner] 🔧 P105: OutputValidator 失败后触发 round ${ovFailRoundId} 完成`,
                );
              }
            }

            if (queued.run.sessionKey) {
              finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
            }
            return;
          }

          // 🔧 P106: Spot Recovery 后清理 output 中的幻觉文本
          // 根因：P88 成功执行了幻觉工具调用（文件已写入），但原始幻觉文本
          // "[Historical context: a different model called tool ...]" 仍留在
          // assistantTexts 中（session 历史不可变），被存入 output 字段。
          // 这污染了后续合并管线（mergeTaskOutputs 读 output 字段）和质检。
          // 修复：当 spotRecoveryExecuted 时，剥离 [Historical context: ...] 模式行。
          let cleanedOutputText = outputText;
          if (runResult.spotRecoveryExecuted && outputText) {
            const beforeLen = outputText.length;
            cleanedOutputText = outputText
              .split("\n")
              .filter(line => !/^\[Historical context:.*(?:called tool|Do not mimic)/i.test(line.trim()))
              .join("\n")
              .trim();
            if (cleanedOutputText.length < beforeLen) {
              console.log(
                `[followup-runner] 🔧 P106: 清理 Spot Recovery 幻觉文本 (${beforeLen} → ${cleanedOutputText.length} chars)`,
              );
            }
          }
          subTask.output = cleanedOutputText;
          subTask.completedAt = Date.now();

          // 🔧 P61c 时序修复：先收集文件追踪结果，再更新状态
          // 根因：updateSubTaskStatus("completed") 会触发 TaskTreeManager 保存。
          // 如果 producedFilePaths 在保存之后才设置，并行 runner 可能在两次保存之间
          // 重新加载 tree，拿到无 paths 的 completed 版本。P32 _shouldTakeLocal 对
          // 两个相同状态的 subtask 默认取磁盘版（无 paths），导致 paths 永久丢失。
          // 修复：先设置 producedFilePaths，再 updateSubTaskStatus，确保单次保存包含完整信息。
          const trackedFiles = collectTrackedFiles(subTask.id);
          if (trackedFiles.length > 0) {
            if (!subTask.metadata) subTask.metadata = {};
            subTask.metadata.producedFiles = trackedFiles.map(f => f.fileName);
            subTask.metadata.producedFilePaths = trackedFiles.map(f => f.filePath);
            console.log(
              `[followup-runner] 📂 收集到 ${trackedFiles.length} 个文件产出: ` +
              trackedFiles.map(f => f.fileName).join(", ")
            );
          }
          // 🔧 FileTracker 断裂回退：从 toolMetas 中提取 write 工具的文件路径
          if (trackedFiles.length === 0 && runResult.toolMetas) {
            const writeMetas = runResult.toolMetas.filter(
              (m) => m.toolName === "write" && typeof m.meta === "string" && m.meta.length > 0,
            );
            if (writeMetas.length > 0) {
              if (!subTask.metadata) subTask.metadata = {};
              const homedir = os.homedir();
              const recoveredPaths = writeMetas.map((m) => {
                let p = String(m.meta);
                if (p.startsWith("~/") || p.startsWith("~\\")) {
                  p = path.join(homedir, p.slice(2));
                }
                return p;
              });
              const recoveredNames = recoveredPaths.map((p) => path.basename(p));
              subTask.metadata.producedFiles = recoveredNames;
              subTask.metadata.producedFilePaths = recoveredPaths;
              console.log(
                `[followup-runner] 📂 FileTracker 回退：从 toolMetas 恢复 ${writeMetas.length} 个文件: ` +
                recoveredNames.join(", "),
              );
            }
          }

          // 🔧 S2: Post-execution OutputContract 文件名校验+自动重命名
          // 解决 L3（无后验产出校验）：LLM 用了错误文件名时系统自动修正
          const outputContract = subTask.metadata?.outputContract;
          if (outputContract?.expectedFileName && subTask.metadata?.producedFilePaths?.length) {
            const expectedName = outputContract.expectedFileName;
            const actualPaths = subTask.metadata.producedFilePaths;
            const actualNames = subTask.metadata.producedFiles ?? actualPaths.map(p => path.basename(p));
            
            // 检查第一个产出文件是否匹配契约（只校验主文件）
            const mainActualName = actualNames[0];
            if (mainActualName && mainActualName !== expectedName) {
              // 文件名不匹配 → 自动重命名
              const mainActualPath = actualPaths[0];
              const expectedPath = path.join(path.dirname(mainActualPath), expectedName);
              try {
                await fs.rename(mainActualPath, expectedPath);
                // 更新 metadata 中的路径
                subTask.metadata.producedFilePaths[0] = expectedPath;
                subTask.metadata.producedFiles![0] = expectedName;
                console.log(
                  `[followup-runner] 🔧 S2: OutputContract 文件重命名: "${mainActualName}" → "${expectedName}"`,
                );
                // V8 P3: 记录命名经验（LLM 产出了错误的文件名）
                import("../../agents/intelligent-task-decomposition/experience-pool.js").then(ep =>
                  ep.recordExperience({
                    category: "naming",
                    pattern: "wrong_filename_auto_renamed",
                    lesson: `LLM 产出文件名「${mainActualName}」与契约「${expectedName}」不符，已自动重命名`,
                    suggestion: "在 prompt 中更明确地指定输出文件名",
                    taskType: subTask?.taskType,
                  }),
                ).catch(() => {});
              } catch (renameErr) {
                // 重命名失败（文件不存在等），记录但不阻塞
                console.warn(
                  `[followup-runner] ⚠️ S2: 文件重命名失败 "${mainActualName}" → "${expectedName}": ${renameErr}`,
                );
              }
            }
          }

          // 🔧 P7 修复：通过 taskTreeManager 统一管理状态转换，而非直接赋值
          // 🔧 P61c：此时 producedFilePaths 已设置，保存时不会丢失
          await orchestrator.updateSubTaskStatus(taskTree, subTask.id, "completed");
          
          // 🆕 V2 Phase 4: 兜底落盘（委托提取的辅助函数）
          // 🔧 问题 JJ 修复：兜底落盘仅保存文件，不立即发送给用户
          // 原因：如果质检后决定 restart，用户会先收到不完整的文件，然后又收到重试后的文件。
          // 发送逻辑移到质检通过后（由 postProcessSubTaskCompletion 的 sendSubTaskFiles 处理）。
          await handleFallbackPersistence({
            subTask,
            outputText,
            toolMetas: runResult.toolMetas ?? [],
            sessionId,
            queued,
            skipSend: true, // 🔧 问题 JJ：不立即发送，等质检通过后再发
            llmSessionFile, // 🔧 Session 隔离：传递隔离的 session 文件路径
          });
          
          // 🆕 V2 Phase 4: 统一后处理（onTaskCompleted 钩子替代散装逻辑）
          // 内部编排：postProcess + 质量评估 + 轮次完成检查 + markRoundCompleted
          try {
            // 🆕 进度报告：开始质量评估
            progressReporter?.onQualityReviewStart();

            const postResult = await orchestrator.onTaskCompleted(taskTree, subTask, queued.rootTaskId);

            if (postResult.needsRequeue) {
              progressReporter?.onQualityReviewComplete(false);
              progressReporter?.onTaskRestart(subTask.retryCount ?? 1);
              console.log(
                `[followup-runner] 🔄 子任务 ${subTask.id} 质量不达标，重新入队 (restart): ` +
                `${JSON.stringify(postResult.findings)}`,
              );
              // 🔧 BUG 修复：restart 时必须创建新的 FollowupRun 入队
              // 修复前：只调用 finalizeWithFollowup 触发 drain，但队列中没有对应的 FollowupRun
              // 导致 drain 的 getNextExecutableTasksForDrain 返回 execute，但找不到匹配项，任务永远不会被重新执行
              if (queued.run.sessionKey) {
                const restartFollowupRun = buildFollowupRun(queued, subTask);
                const resolvedQueue = resolveQueueSettings({
                  cfg: queued.run.config ?? ({} as any),
                  inlineMode: "followup",
                });
                enqueueFollowupRun(queued.run.sessionKey, restartFollowupRun, resolvedQueue, "none");
                console.log(`[followup-runner] 🔄 restart 子任务已重新入队: ${subTask.id} (retryCount=${subTask.retryCount})`);
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }

            // 🆕 decompose 决策：增量分解产生的新子任务需要入队
            if (postResult.decision === "decompose" && postResult.decomposedTaskIds && postResult.decomposedTaskIds.length > 0 && taskTree) {
              console.log(
                `[followup-runner] 🔧 子任务 ${subTask.id} 转为增量分解，` +
                `${postResult.decomposedTaskIds.length} 个续写子任务需要入队`,
              );
              for (const newId of postResult.decomposedTaskIds) {
                const newSubTask = taskTree.subTasks.find(t => t.id === newId);
                if (newSubTask && newSubTask.status === "pending") {
                  const newFollowupRun = buildFollowupRun(queued, newSubTask);
                  if (queued.run.sessionKey) {
                    const resolvedQueue = resolveQueueSettings({
                      cfg: queued.run.config ?? ({} as any),
                      inlineMode: "followup",
                    });
                    enqueueFollowupRun(queued.run.sessionKey, newFollowupRun, resolvedQueue, "none");
                    console.log(`[followup-runner] 🆕 decompose 续写子任务已入队: ${newId} (${newSubTask.summary})`);
                  }
                }
              }
              if (queued.run.sessionKey) {
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              // 🔧 问题 N 修复：decompose 后必须 return，否则会继续执行到 sendFollowupPayloads
              // 发送 LLM 的原始不完整回复给用户，造成混乱。
              // 轮次完成检查由 onTaskCompleted 内部处理（decompose 分支已跳过）。
              return;
            }

            // 🔧 P88: 非 decompose 决策但有新任务需要调度（如 chunk map 完成后的 finalize）
            // 根因：checkChunkProgress 发现所有 map 完成时，将 finalize ID 加入 decomposedTaskIds，
            // 但 P84 跳过质检导致 decision="continue"，不会走上面的 decompose 分支。
            // 修复：独立检查 decomposedTaskIds，入队但不 return（当前任务已正常完成，继续后续流程）。
            if (postResult.decision !== "decompose" && postResult.decomposedTaskIds && postResult.decomposedTaskIds.length > 0 && taskTree) {
              console.log(
                `[followup-runner] 🚀 P88: ${postResult.decomposedTaskIds.length} 个后续任务需要调度（decision=${postResult.decision}）`,
              );
              for (const newId of postResult.decomposedTaskIds) {
                const newSubTask = taskTree.subTasks.find(t => t.id === newId);
                if (newSubTask && newSubTask.status === "pending") {
                  const newFollowupRun = buildFollowupRun(queued, newSubTask);
                  if (queued.run.sessionKey) {
                    const resolvedQueue = resolveQueueSettings({
                      cfg: queued.run.config ?? ({} as any),
                      inlineMode: "followup",
                    });
                    enqueueFollowupRun(queued.run.sessionKey, newFollowupRun, resolvedQueue, "none");
                    console.log(`[followup-runner] 🚀 P88: 后续任务已入队: ${newId} (${newSubTask.summary})`);
                  }
                }
              }
              // 不 return — 当前任务已正常完成，继续后续流程（进度报告、轮次检查等）
            }

            if (postResult.markedFailed) {
              progressReporter?.onQualityReviewComplete(false);
              progressReporter?.onTaskFailed("质量严重不通过 (overthrow)");
              console.error(
                `[followup-runner] ❌ 子任务 ${subTask.id} 质量严重不通过 (overthrow): ` +
                `${JSON.stringify(postResult.findings)}`,
              );
              // 🔧 即使当前子任务被 overthrow，也要触发队列继续执行剩余兄弟任务
              // 修复前：直接 return 导致队列停滞，drain 无法推进后续任务
              if (queued.run.sessionKey) {
                finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
              }
              return;
            }

            // 🆕 进度报告：质检通过 + 任务完成
            progressReporter?.onQualityReviewComplete(true);
            progressReporter?.onTaskComplete();

            // 🆕 V8 P5: 子任务完成后发送详细进度仪表盘
            if (taskTree && queued.rootTaskId) {
              const detailedProgress = formatDetailedProgress(taskTree, queued.rootTaskId);
              console.log(`[followup-runner] ${detailedProgress}`);
            }

            console.log(`[followup-runner] ✅ Sub task completed: ${subTask.id}`);

            // 🆕 V9: 子任务完成且质检通过后，fire-and-forget 生成智能摘要
            // 摘要存入 metadata.smartSummary，供后续兄弟/流水线任务的上下文注入使用
            // 使用 llm_light 策略（低 token、低 timeout），不阻塞主流程
            if (subTask && taskTree) {
              // 捕获当前引用到局部常量，避免闭包中 narrowing 丢失
              const completedSubTask = subTask;
              const currentTaskTree = taskTree;
              import("../../agents/intelligent-task-decomposition/smart-summarizer.js").then(async (ss) => {
                try {
                  // 读取实际文件内容（优先于 subTask.output）
                  let fileContent: string | undefined;
                  const paths = completedSubTask.metadata?.producedFilePaths;
                  if (paths && paths.length > 0) {
                    try {
                      const contents = await Promise.all(
                        paths.map(p => fs.readFile(p, "utf-8").catch(() => ""))
                      );
                      fileContent = contents.filter(c => c.length > 0).join("\n\n");
                    } catch { /* ignore */ }
                  }
                  const summary = await ss.generateSmartSummary(
                    completedSubTask,
                    fileContent || undefined,
                    queued.run.config,
                    fallbackProvider,
                    fallbackModel,
                  );
                  if (summary && summary.length > 10) {
                    if (!completedSubTask.metadata) completedSubTask.metadata = {};
                    completedSubTask.metadata.smartSummary = summary;
                    await orchestrator.saveTaskTree(currentTaskTree);
                    console.log(`[followup-runner] 📝 V9: 智能摘要已生成 (${summary.length} chars): ${completedSubTask.id}`);
                  }
                } catch (ssErr) {
                  console.warn(`[followup-runner] ⚠️ V9: 智能摘要生成失败（不影响主流程）: ${ssErr}`);
                }
              }).catch(() => {});
            }

            // 🆕 BUG3 修复：质检 adjust 新增的子任务需要入队到 drain 队列
            if (postResult.newTaskIds && postResult.newTaskIds.length > 0 && taskTree) {
              for (const newId of postResult.newTaskIds) {
                const newSubTask = taskTree.subTasks.find(t => t.id === newId);
                if (newSubTask && newSubTask.status === "pending") {
                  const newFollowupRun = buildFollowupRun(queued, newSubTask);
                  if (queued.run.sessionKey) {
                    const resolvedQueue = resolveQueueSettings({
                      cfg: queued.run.config ?? ({} as any),
                      inlineMode: "followup",
                    });
                    enqueueFollowupRun(queued.run.sessionKey, newFollowupRun, resolvedQueue, "none");
                    console.log(`[followup-runner] 🆕 adjust 新增子任务已入队: ${newId} (${newSubTask.summary})`);
                  }
                }
              }
            }

            // 轮次完成后续处理（由 onTaskCompleted 内部判定并设置标志）
            if (postResult.roundCompleted && postResult.completedRoundId) {
              console.log(`[followup-runner] 🏁 Round completed: ${postResult.completedRoundId} (tree: ${taskTree.id})`);
              taskTree = (await orchestrator.loadTaskTree(sessionId)) ?? taskTree;

              // 委托 onRoundCompleted 钩子：合并输出 + 交付报告
              const roundResult = await orchestrator.onRoundCompleted(taskTree, postResult.completedRoundId);

              // 发送合并文件 + 复制到用户工作目录
              if (roundResult.mergedFilePath) {
                // 🔧 将系统合并文件复制到用户工作目录 workspace/{rootTaskId}/
                let userCopyPath: string | undefined;
                try {
                  const wsDir = queued.run.workspaceDir;
                  if (wsDir) {
                    const taskOutputDir = queued.rootTaskId
                      ? path.join(wsDir, "workspace", queued.rootTaskId)
                      : path.join(wsDir, "workspace");
                    await fs.mkdir(taskOutputDir, { recursive: true });
                    // 🔧 P38+P83: 多层回退提取合理的完整版文件名
                    const rootTaskStr = taskTree.rootTask ?? "";
                    const sanitize = (s: string) => s.replace(/[\\/:*?"<>|\n\r\s]+/g, "_").replace(/^_+|_+$/g, "");
                    let rootGoal = "";
                    // 层1：《》书名号
                    const bookMatch = rootTaskStr.match(/[《\u300A]([^》\u300B]+)[》\u300B]/);
                    if (bookMatch) {
                      rootGoal = sanitize(bookMatch[1]);
                    }
                    // 层2：子任务 summary 中提取核心名词（取最短且有意义的 summary）
                    if (!rootGoal && taskTree.subTasks) {
                      const summaries = taskTree.subTasks
                        .filter(t => t.summary && t.summary.length > 4 && t.summary.length < 60 && !t.metadata?.isRootTask)
                        .map(t => t.summary!);
                      if (summaries.length > 0) {
                        // 从 summary 中提取《》或引号中的名称
                        for (const s of summaries) {
                          const m = s.match(/[《\u300A]([^》\u300B]+)[》\u300B]/) || s.match(/[「""]([^」""]+)[」""]/);
                          if (m) { rootGoal = sanitize(m[1]); break; }
                        }
                        // 回退：取第一个 summary 的前20字
                        if (!rootGoal) {
                          rootGoal = sanitize(summaries[0].substring(0, 20));
                        }
                      }
                    }
                    // 层3：rootTask 中提取文件路径里的文件名
                    if (!rootGoal) {
                      const fileMatch = rootTaskStr.match(/[\\\/]([^\s\\\/]+?)\.(?:txt|md)\b/);
                      if (fileMatch) rootGoal = sanitize(fileMatch[1]);
                    }
                    // 层4：rootTask 前20字清洗
                    if (!rootGoal) {
                      rootGoal = sanitize(rootTaskStr.substring(0, 20)) || "output";
                    }
                    const copyName = `${rootGoal}_完整版.txt`;
                    userCopyPath = path.join(taskOutputDir, copyName);
                    await fs.copyFile(roundResult.mergedFilePath, userCopyPath);
                    console.log(`[followup-runner] 📄 合并文件已复制到用户工作目录: ${userCopyPath}`);
                  }
                } catch (copyErr) {
                  console.warn(`[followup-runner] ⚠️ 复制合并文件到工作目录失败（不阻塞）: ${copyErr}`);
                }

                const mergedSendResult = await sendFallbackFile({
                  filePath: roundResult.mergedFilePath,
                  caption: `📝 完整输出（子任务合并）`,
                  queued,
                });
                if (!mergedSendResult.ok) {
                  const displayPath = userCopyPath ?? roundResult.mergedFilePath;
                  await sendFollowupPayloads([{
                    text: `📝 子任务输出已合并保存到：\n${displayPath}`,
                  }], queued);
                }
              }

              // 发送交付报告
              if (roundResult.deliveryReportMarkdown) {
                await sendFollowupPayloads([{ text: roundResult.deliveryReportMarkdown }], queued);
                console.log(`[followup-runner] 📦 Delivery report sent`);
              }

              // 异步归档（fire-and-forget，委托辅助函数）
              archiveRoundMemory(orchestrator, taskTree, postResult.completedRoundId, queued, sessionId);
            }
          } catch (ppErr) {
            console.warn(`[followup-runner] ⚠️ 子任务后处理异常（不阻塞）: ${ppErr}`);
            await orchestrator.saveTaskTree(taskTree);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        
        // 🆕 V2 Phase 4: 委托 onTaskFailed 钩子集中处理重试/级联/停止
        if (taskTree && subTask) {
          // 🔧 竞态保护：错误路径也需要重新加载最新的任务树
          const freshTreeOnErr = await orchestrator.loadTaskTree(sessionId);
          if (freshTreeOnErr && queued.subTaskId) {
            const freshSubTaskOnErr = freshTreeOnErr.subTasks.find(t => t.id === queued.subTaskId);
            if (freshSubTaskOnErr) {
              taskTree = freshTreeOnErr;
              subTask = freshSubTaskOnErr;
            }
          }
          clearTracking(subTask.id);
          const failDecision = await orchestrator.onTaskFailed(taskTree, subTask, err);

          if (failDecision.needsRequeue) {
            console.warn(`[followup-runner] ⚠️ ${failDecision.reason}`);
            if (queued.run.sessionKey) {
              // 🔧 P0 修复：needsRequeue 时必须创建新的 FollowupRun 入队
              // 修复前：只调用 finalizeWithFollowup 触发 drain，但队列中没有对应的 FollowupRun
              // 导致 drain 找不到匹配项，重试永远不会执行
              const retryFollowupRun = buildFollowupRun(queued, subTask);
              const resolvedQueue = resolveQueueSettings({
                cfg: queued.run.config ?? ({} as any),
                inlineMode: "followup",
              });
              enqueueFollowupRun(queued.run.sessionKey, retryFollowupRun, resolvedQueue, "none");
              console.log(`[followup-runner] 🔄 onTaskFailed 重试已入队: ${subTask.id} (retryCount=${subTask.retryCount})`);
              finalizeWithFollowup(undefined, queued.run.sessionKey, createFollowupRunner(params));
            }
          } else {
            console.error(`[followup-runner] ❌ ${failDecision.reason}`);
          }
        } else {
          // 没有找到子任务，继续执行下一个任务（保持原有行为）
          if (queued.run.sessionKey) {
            const queueKey = queued.run.sessionKey;
            finalizeWithFollowup(undefined, queueKey, createFollowupRunner(params));
          }
        }
        
        return;
      }

      if (storePath && sessionKey) {
        const usage = runResult.meta.agentMeta?.usage;
        const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
        const contextTokensUsed =
          agentCfgContextTokens ??
          lookupContextTokens(modelUsed) ??
          sessionEntry?.contextTokens ??
          DEFAULT_CONTEXT_TOKENS;

        await persistSessionUsageUpdate({
          storePath,
          sessionKey,
          usage,
          modelUsed,
          providerUsed: fallbackProvider,
          contextTokensUsed,
          logLabel: "followup",
        });
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) return;
      const sanitizedPayloads = payloadArray.flatMap((payload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) return [payload];
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) return [];
        return [{ ...payload, text: stripped.text }];
      });
      const replyToChannel =
        queued.originatingChannel ??
        (queued.run.messageProvider?.toLowerCase() as OriginatingChannelType | undefined);
      const replyToMode = resolveReplyToMode(
        queued.run.config,
        replyToChannel,
        queued.originatingAccountId,
        queued.originatingChatType,
      );

      const replyTaggedPayloads: ReplyPayload[] = applyReplyThreading({
        payloads: sanitizedPayloads,
        replyToMode,
        replyToChannel,
      });

      const dedupedPayloads = filterMessagingToolDuplicates({
        payloads: replyTaggedPayloads,
        sentTexts: runResult.messagingToolSentTexts ?? [],
      });
      const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
        messageProvider: queued.run.messageProvider,
        messagingToolSentTargets: runResult.messagingToolSentTargets,
        originatingTo: queued.originatingTo,
        accountId: queued.run.agentAccountId,
      });
      
      // 声明 finalPayloads（提前声明，避免作用域问题）
      let finalPayloads = suppressMessagingToolReplies ? [] : dedupedPayloads;

      if (finalPayloads.length === 0) return;

      if (autoCompactionCompleted) {
        const count = await incrementCompactionCount({
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
        });
        if (queued.run.verboseLevel && queued.run.verboseLevel !== "off") {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          finalPayloads.unshift({
            text: `🧹 Auto-compaction complete${suffix}.`,
          });
        }
      }

      await sendFollowupPayloads(finalPayloads, queued);

      // 🆕 触发队列继续执行下一个任务
      if (queued.run.sessionKey) {
        const queueKey = queued.run.sessionKey;
        finalizeWithFollowup(undefined, queueKey, createFollowupRunner(params));
      }
    } catch (outerErr) {
      // 🔧 外层 catch：防止未捕获的异常（orchestrator 操作、payload 处理等）
      // 泄漏到 drain 循环导致整个队列停止
      const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
      console.error(`[followup-runner] ❌ Unhandled error in followup runner: ${msg}`);
      defaultRuntime.error?.(`Followup runner unhandled error: ${msg}`);
    } finally {
      // 🆕 进度报告器清理（停止所有定时器）
      progressReporter?.dispose();
      typing.markRunComplete();
      // 🔧 P12 修复：安全清理上下文（仅当 contextId 匹配时才清空，防止并行 runner 覆盖）
      clearCurrentFollowupRunContext(runId);
    }
  };
}
