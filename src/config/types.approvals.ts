export type ExecApprovalForwardingMode = "session" | "targets" | "both";

export type ExecApprovalForwardTarget = {
  /** Channel id (e.g. "discord", "slack", or plugin channel id). */
  channel: string;
  /** Destination id (channel id, user id, etc. depending on channel). */
  to: string;
  /** Optional account id for multi-account channels. */
  accountId?: string;
  /** Optional thread id to reply inside a thread. */
  threadId?: string | number;
};

export type ExecApprovalForwardingConfig = {
  /** Enable forwarding exec approvals to chat channels. Default: false. */
  enabled?: boolean;
  /** Delivery mode (session=origin chat, targets=config targets, both=both). Default: session. */
  mode?: ExecApprovalForwardingMode;
  /** Only forward approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only forward approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Explicit delivery targets (used when mode includes targets). */
  targets?: ExecApprovalForwardTarget[];
};

export type LlmApprovalConfig = {
  /** 是否启用 LLM 审批。默认 false（不审批，自动允许）。 */
  enabled?: boolean;
  /** 是否自动批准所有请求。默认 false。 */
  autoApprove?: boolean;
};

export type ToolApprovalConfig = {
  /** 是否启用 Tool 审批。默认 false（不审批，自动允许）。 */
  enabled?: boolean;
  /** 
   * 审批模式：
   * - "before-and-after": 执行前后都审批（阻塞执行）
   * - "after-only": 只在执行后展示（不阻塞，推荐）
   * - "off": 关闭审批
   * 默认 "after-only"
   */
  mode?: "before-and-after" | "after-only" | "off";
};

export type ApprovalsConfig = {
  exec?: ExecApprovalForwardingConfig;
  llm?: LlmApprovalConfig;
  tools?: ToolApprovalConfig;
};
