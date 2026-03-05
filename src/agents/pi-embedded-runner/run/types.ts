import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model } from "@mariozechner/pi-ai";
import type { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";

import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import type { ClawdbotConfig } from "../../../config/config.js";
import type { AgentStreamParams } from "../../../commands/agent/types.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../../bash-tools.js";
import type { MessagingToolSend } from "../../pi-embedded-messaging.js";
import type { BlockReplyChunking, ToolResultFormat } from "../../pi-embedded-subscribe.js";
import type { SkillSnapshot } from "../../skills.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import type { ClientToolDefinition } from "./params.js";
import type { PromptProfile } from "../prompt-profiles.js";

type AuthStorage = ReturnType<typeof discoverAuthStorage>;
type ModelRegistry = ReturnType<typeof discoverModels>;

export type AttemptOutcomeKind =
  | "ok"
  | "timeout"
  | "aborted"
  | "context_overflow"
  | "compaction_failure"
  | "rate_limit"
  | "provider_error"
  | "tool_error"
  | "tool_calling_degraded"
  | "cloud_code_assist_format_error"
  | "unknown_error";

export type AttemptOutcome = {
  kind: AttemptOutcomeKind;
  ok: boolean;
  retryable: boolean;
  suggestedAction: "continue" | "retry" | "degrade" | "shrink_context" | "fail";
  suggestedDelayMs?: number;
  details?: {
    message?: string;
    stopReason?: string;
    provider?: string;
    modelId?: string;
    toolName?: string;
  };
  hints?: {
    needsTextToolMode?: boolean;
    needsContextShrink?: boolean;
    shouldUseContinueGeneration?: boolean;
  };
};

export type EmbeddedRunAttemptParams = {
  sessionId: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: ClawdbotConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  images?: ImageContent[];
  promptProfile?: PromptProfile;
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Disable built-in tools for this run (LLM-only mode). */
  disableTools?: boolean;
  /** 子任务工具白名单：只保留列表中的工具，大幅减少 system prompt 体积。 */
  toolAllowlist?: string[];
  /** 跳过 bootstrap/context 文件加载（AGENTS.md、SOUL.md 等），子任务不需要这些。 */
  skipBootstrapContext?: boolean;
  provider: string;
  modelId: string;
  model: Model<Api>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  thinkLevel: ThinkLevel;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
  bashElevated?: ExecElevatedDefaults;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  extraSystemPrompt?: string;
  streamParams?: AgentStreamParams;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
};

export type EmbeddedRunAttemptResult = {
  aborted: boolean;
  timedOut: boolean;
  promptError: unknown;
  sessionIdUsed: string;
  systemPromptReport?: SessionSystemPromptReport;
  messagesSnapshot: AgentMessage[];
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  lastAssistant: AssistantMessage | undefined;
  lastToolError?: { toolName: string; meta?: string; error?: string };
  /**
   * 统一失败分类与恢复建议（激进长程连续改造的核心契约）。
   * 由 attempt 层生成，供 run.ts / followup-runner / orchestrator 统一消费。
   */
  attemptOutcome?: AttemptOutcome;
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentTargets: MessagingToolSend[];
  cloudCodeAssistFormatError: boolean;
  /** 🔧 P98: P88 Spot Recovery 成功执行后为 true，通知 OutputValidator 跳过幻觉检测 */
  spotRecoveryExecuted?: boolean;
  /** Client tool call detected (OpenResponses hosted tools). */
  clientToolCall?: { name: string; params: Record<string, unknown> };
};
