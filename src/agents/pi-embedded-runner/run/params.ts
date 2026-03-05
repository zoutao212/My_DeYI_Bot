import type { ImageContent } from "@mariozechner/pi-ai";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import type { ClawdbotConfig } from "../../../config/config.js";
import type { AgentStreamParams } from "../../../commands/agent/types.js";
import type { enqueueCommand } from "../../../process/command-queue.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../../bash-tools.js";
import type { BlockReplyChunking, ToolResultFormat } from "../../pi-embedded-subscribe.js";
import type { SkillSnapshot } from "../../skills.js";
import type { PromptProfile } from "../prompt-profiles.js";

// Simplified tool definition for client-provided tools (OpenResponses hosted tools)
export type ClientToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type RunEmbeddedPiAgentParams = {
  sessionId: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  messageTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  messageThreadId?: string | number;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
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
  /** 子任务工具白名单：只保留列表中的工具，大幅减少 system prompt 体积。
   *  例如创作子任务只需 ["write","read","edit"]，可将 42KB prompt 降到 ~10KB。 */
  toolAllowlist?: string[];
  /** 跳过 bootstrap/context 文件加载（AGENTS.md、SOUL.md 等），子任务不需要这些。 */
  skipBootstrapContext?: boolean;
  provider?: string;
  model?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: ThinkLevel;
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
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  streamParams?: AgentStreamParams;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
};
