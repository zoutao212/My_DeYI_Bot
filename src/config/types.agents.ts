import type { AgentDefaultsConfig } from "./types.agent-defaults.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
    };

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  memorySearch?: MemorySearchConfig;
  /** Memory service configuration for this agent. */
  memory?: MemoryServiceConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    /** Agent workspace access inside the sandbox. */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    workspaceRoot?: string;
    /** Docker-specific sandbox overrides for this agent. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser overrides for this agent. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune overrides for this agent. */
    prune?: SandboxPruneSettings;
  };
  tools?: AgentToolsConfig;
  /** 人格配置（配置驱动的角色系统，替代独立的 Butler/VirtualWorld/Lina 模块） */
  persona?: {
    /** 角色名称（如 "栗娜"） */
    name: string;
    /** 性格描述 */
    personality?: string;
    /** 说话风格 */
    speakingStyle?: string;
    /** 能力列表 */
    capabilities?: string[];
    /** 行为规则 */
    rules?: string[];
  };
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
  /** 动态管道配置 */
  dynamicPipeline?: {
    /** 是否启用动态管道。默认 false。 */
    enabled?: boolean;
    /** 角色配置目录。默认 "clawd/characters"。 */
    charactersDir?: string;
    /** 默认角色。默认 undefined（不使用角色）。 */
    defaultCharacter?: string;
    /** 系统人格。默认 undefined（使用默认人格）。 */
    systemPersona?: string;
  };
};

export type AgentBinding = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: "dm" | "group" | "channel"; id: string };
    guildId?: string;
    teamId?: string;
  };
};

/**
 * 记忆服务配置
 */
export type MemoryServiceConfig = {
  /** 检索配置 */
  retrieval?: {
    /** 最大结果数。默认 5 */
    maxResults?: number;
    /** 最小相关性分数 (0-1)。默认 0.7 */
    minScore?: number;
    /** 检索来源。默认 ["memory", "sessions"] */
    sources?: ("memory" | "sessions")[];
    /** 检索超时（毫秒）。默认 5000 */
    timeoutMs?: number;
  };
  /** 归档配置 */
  archival?: {
    /** 归档策略。默认 "on-demand" */
    strategy?: "always" | "on-demand" | "threshold";
    /** 归档路径。默认 "memory/sessions" */
    path?: string;
    /** 归档格式。默认 "markdown" */
    format?: "markdown" | "json";
    /** 归档频率（轮数）。默认 10 */
    frequency?: number;
  };
};
