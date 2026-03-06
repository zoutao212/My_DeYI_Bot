import type { SkillSnapshot } from "../../../agents/skills.js";
import type { ClawdbotConfig } from "../../../config/config.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../directives.js";
import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { ExecutionContext } from "../../../agents/intelligent-task-decomposition/types.js";

export type QueueMode = "steer" | "followup" | "collect" | "steer-backlog" | "interrupt" | "queue";

export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type QueueDedupeMode = "message-id" | "prompt" | "none";

export type FollowupRun = {
  prompt: string;
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  enqueuedAt: number;
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using the session's lastChannel.
   */
  originatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  originatingTo?: string;
  /** Provider account id (multi-account). */
  originatingAccountId?: string;
  /** Thread id for reply routing (Telegram topic id or Matrix thread event id). */
  originatingThreadId?: string | number;
  /** Chat type for context-aware threading (e.g., DM vs channel). */
  originatingChatType?: string;
  run: {
    agentId: string;
    agentDir: string;
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    agentAccountId?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    sessionFile: string;
    workspaceDir: string;
    config: ClawdbotConfig;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    thinkLevel?: ThinkLevel;
    verboseLevel?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    extraSystemPrompt?: string;
    enforceFinalTag?: boolean;
  };
  /**
   * 标记这是否是队列任务（而不是用户直接发送的消息）
   * 
   * - true: 队列任务（不允许调用 enqueue_task）
   * - false/undefined: 用户消息（允许调用 enqueue_task）
   */
  isQueueTask?: boolean;
  
  /**
   * 标记这是否是根任务（允许分解子任务）
   * 
   * - true: 根任务（允许调用 enqueue_task 分解子任务）
   * - false/undefined: 子任务（不允许调用 enqueue_task）
   * 
   * 🆕 用于区分"根任务"和"子任务"：
   * - 根任务：用户直接发送的消息，或第一次调用 enqueue_task 创建的任务
   * - 子任务：根任务分解出的子任务
   */
  isRootTask?: boolean;

  /**
   * 标记这是否是通过 isNewRootTask=true 创建的新根任务树
   * 
   * 当 LLM 调用 enqueue_task({ isNewRootTask: true }) 时设置为 true。
   * 在 followup-runner drain 时用于正确恢复 isRootTask 语义，
   * 确保新根任务在被消费执行时仍然允许分解子任务。
   */
  isNewRootTask?: boolean;

  /**
   * 入队时记录的任务树深度（方案 3 兜底）
   * 
   * 用于在循环检测时做深度兜底判断：
   * - depth=0 或 undefined：根任务级别，允许 enqueue
   * - depth>=maxDepth(3)：禁止继续分解
   */
  taskDepth?: number;

  /**
   * 子任务 ID（用于精确匹配）
   * 
   * 当任务来自任务树时，记录对应的子任务 ID。
   * 用于在队列中精确匹配任务，避免 prompt 相同时的误匹配。
   * 
   * - 有值：来自任务树的子任务，使用 ID 进行精确匹配
   * - undefined：普通任务或旧版本任务，回退到 prompt 匹配
   * 
   * @since v2026.2.6 - 任务系统改进
   */
  subTaskId?: string;

  /**
   * 轮次 ID（用于隔离不同用户请求产生的子任务）
   * 
   * 同一次用户消息触发的所有子任务（包括递归分解）共享同一个 rootTaskId。
   * 在 drain 守卫和 allDone 检查中，用于只检查当前轮次的子任务，
   * 避免多轮累积导致 allDone 永远为 false。
   * 
   * 传播链：
   * 1. 首次 enqueue_task → 生成 rootTaskId → 存到 currentFollowupRunContext
   * 2. 后续 enqueue_task（同一 LLM 执行）→ 从 context 继承
   * 3. 子任务执行 → followup-runner 从 queued.rootTaskId 继承
   * 4. 递归分解 → 子任务的 enqueue_task 继承父的 rootTaskId
   * 
   * @since v2026.2.6 - 任务系统轮次隔离
   */
  rootTaskId?: string;

  // 🆕 V2: ExecutionContext（Phase 2 新增，替代 isQueueTask/isRootTask/isNewRootTask/taskDepth）
  // 过渡期：旧布尔标记保留（@deprecated），优先读取 executionContext
  executionContext?: ExecutionContext;

  // 🆕 V8 P0: 模型上下文窗口信息（ContextBudgetManager 用）
  // 由 enqueue-task-tool 构建 FollowupRun 时从 config 填入。
  // followup-runner 构建 prompt 时传给 ContextBudgetManager 做预算分配。

  /** 模型 context window 大小 (tokens) */
  modelContextWindow?: number;

  /** 模型最大输出 token 数 */
  modelMaxOutputTokens?: number;

  // 🚨 Bug #2 修复: 全局中断信号
  /** 用于 /stop 命令能中断子任务的 AbortSignal */
  abortSignal?: AbortSignal;
};

export type ResolveQueueSettingsParams = {
  cfg: ClawdbotConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
};
