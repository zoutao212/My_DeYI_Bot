import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { SYSTEM_PROMPT_L10N_EN } from "./system-prompt.l10n.en.js";
import { SYSTEM_PROMPT_L10N_ZH } from "./system-prompt.l10n.zh.js";
import { SYSTEM_PROMPT_L10N_MINIMAL_ZH } from "./system-prompt.l10n.minimal.zh.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";
export type PromptLanguage = "en" | "zh";

function formatTemplate(template: string, vars: Record<string, string>) {
  return template.replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = vars[key];
    return value == null ? `{${key}}` : value;
  });
}

function buildTaskDecompositionSection(params: {
  isMinimal: boolean;
  l10n: typeof SYSTEM_PROMPT_L10N_EN;
}) {
  if (params.isMinimal) return [];
  return [
    params.l10n.taskDecompositionTitle,
    params.l10n.taskDecompositionIntro,
    "",
    params.l10n.taskDecompositionWhenTitle,
    params.l10n.taskDecompositionWhenLine1,
    params.l10n.taskDecompositionWhenLine2,
    params.l10n.taskDecompositionWhenLine3,
    params.l10n.taskDecompositionWhenLine4,
    "",
    params.l10n.taskDecompositionHowTitle,
    params.l10n.taskDecompositionHowLine1,
    params.l10n.taskDecompositionHowLine2,
    params.l10n.taskDecompositionHowLine3,
    params.l10n.taskDecompositionHowLine4,
    "",
    params.l10n.taskDecompositionExampleTitle,
    params.l10n.taskDecompositionExampleRequest,
    params.l10n.taskDecompositionExampleDecomposition,
    params.l10n.taskDecompositionExampleStep1,
    params.l10n.taskDecompositionExampleStep2,
    params.l10n.taskDecompositionExampleStep3,
    params.l10n.taskDecompositionExampleStep4,
    params.l10n.taskDecompositionExampleStep5,
    params.l10n.taskDecompositionExampleReply,
    "",
    params.l10n.taskDecompositionRulesTitle,
    params.l10n.taskDecompositionRulesLine1,
    params.l10n.taskDecompositionRulesLine2,
    params.l10n.taskDecompositionRulesLine3,
    params.l10n.taskDecompositionCriticalWarning,
    "",
  ];
}

function buildSkillsSection(params: {
  skillsPrompt?: string;
  isMinimal: boolean;
  readToolName: string;
  l10n: typeof SYSTEM_PROMPT_L10N_EN;
}) {
  if (params.isMinimal) return [];
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) return [];
  return [
    params.l10n.skillsTitle,
    params.l10n.skillsScanLine,
    formatTemplate(params.l10n.skillsExactlyOneLine, { readTool: params.readToolName }),
    params.l10n.skillsMultipleLine,
    params.l10n.skillsNoneLine,
    params.l10n.skillsConstraintsLine,
    trimmed,
    "",
  ];
}

function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  l10n: typeof SYSTEM_PROMPT_L10N_EN;
}) {
  if (params.isMinimal) return [];
  if (!params.availableTools.has("memory_search") && !params.availableTools.has("memory_get")) {
    return [];
  }
  const lines = [
    params.l10n.memoryRecallTitle,
    params.l10n.memoryRecallLine,
    "",
  ];
  // 当 CRUD 工具可用时，注入使用提示
  const hasCrud = params.availableTools.has("memory_write") || params.availableTools.has("memory_list");
  if (hasCrud && params.l10n.memoryCrudTitle) {
    lines.push(params.l10n.memoryCrudTitle, params.l10n.memoryCrudLine, "");
  }
  return lines;
}

function buildUserIdentitySection(params: {
  ownerLine: string | undefined;
  isMinimal: boolean;
  promptLanguage: PromptLanguage;
}) {
  if (!params.ownerLine || params.isMinimal) return [];
  return [
    params.promptLanguage === "zh" ? "## 用户身份" : "## User Identity",
    params.ownerLine,
    "",
  ];
}

function buildTimeSection(params: { userTimezone?: string; promptLanguage: PromptLanguage }) {
  if (!params.userTimezone) return [];
  return [
    params.promptLanguage === "zh"
      ? "## 当前日期与时间"
      : "## Current Date & Time",
    params.promptLanguage === "zh" ? `时区：${params.userTimezone}` : `Time zone: ${params.userTimezone}`,
    "",
  ];
}

function buildReplyTagsSection(params: { isMinimal: boolean; l10n: typeof SYSTEM_PROMPT_L10N_EN }) {
  if (params.isMinimal) return [];
  return [
    params.l10n.replyTagsTitle,
    params.l10n.replyTagsIntroLine,
    params.l10n.replyTagsCurrentLine,
    params.l10n.replyTagsIdLine,
    params.l10n.replyTagsWhitespaceLine,
    params.l10n.replyTagsStrippedLine,
    "",
  ];
}

function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
  silentReplyToken: string;
  l10n: typeof SYSTEM_PROMPT_L10N_EN;
}) {
  if (params.isMinimal) return [];
  return [
    params.l10n.messagingTitle,
    params.l10n.messagingReplyInSessionLine,
    params.l10n.messagingCrossSessionLine,
    params.l10n.messagingNeverUseExecCurlLine,
    params.availableTools.has("message")
      ? [
          "",
          params.l10n.messagingToolTitle,
          params.l10n.messagingToolUseLine,
          params.l10n.messagingToolActionSendLine,
          formatTemplate(params.l10n.messagingToolMultiChannelLine, {
            messageChannelOptions: params.messageChannelOptions,
          }),
          formatTemplate(params.l10n.messagingToolSilentReplyLine, {
            silentReplyToken: params.silentReplyToken,
          }),
          params.inlineButtonsEnabled
            ? params.l10n.messagingInlineButtonsSupportedLine
            : params.runtimeChannel
              ? formatTemplate(params.l10n.messagingInlineButtonsNotEnabledTemplate, {
                  runtimeChannel: params.runtimeChannel,
                })
              : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

function buildVoiceSection(params: { isMinimal: boolean; ttsHint?: string }) {
  if (params.isMinimal) return [];
  const hint = params.ttsHint?.trim();
  if (!hint) return [];
  return ["## 语音", hint, ""];
}

function buildDocsSection(params: {
  docsPath?: string;
  isMinimal: boolean;
  readToolName: string;
  l10n: typeof SYSTEM_PROMPT_L10N_EN;
}) {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal) return [];
  return [
    params.l10n.docsTitle,
    formatTemplate(params.l10n.docsIntroLine, { docsPath }),
    params.l10n.docsMirrorLine,
    params.l10n.docsSourceLine,
    params.l10n.docsCommunityLine,
    params.l10n.docsFindSkillsLine,
    params.l10n.docsConsultLocalFirstLine,
    params.l10n.docsStatusHintLine,
    "",
  ];
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  /** Character name (e.g., "lina"). If specified, uses full prompt even in minimal mode. */
  characterName?: string;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sandboxInfo?: {
    enabled: boolean;
    workspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    agentWorkspaceMount?: string;
    browserControlUrl?: string;
    browserNoVncUrl?: string;
    hostBrowserAllowed?: boolean;
    allowedControlUrls?: string[];
    allowedControlHosts?: string[];
    allowedControlPorts?: number[];
    elevated?: {
      allowed: boolean;
      defaultLevel: "on" | "off" | "ask" | "full";
    };
  };
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  promptLanguage?: PromptLanguage;
  /** Session summary to inject into system prompt (provides task context). */
  sessionSummary?: string;
  /** Task board to inject into system prompt (provides task tracking). */
  taskBoard?: string;
}) {
  const promptLanguage = params.promptLanguage ?? "en";
  const promptMode = params.promptMode ?? "full";
  
  // 选择 l10n：
  // - 如果指定了 characterName（如 Lina），始终使用完整版（Lina 是系统的人格化化身，拥有最高权限）
  // - 否则，minimal 模式使用精简版
  const l10n = 
    promptMode === "minimal" && promptLanguage === "zh" && !params.characterName
      ? SYSTEM_PROMPT_L10N_MINIMAL_ZH
      : promptLanguage === "zh"
        ? SYSTEM_PROMPT_L10N_ZH
        : SYSTEM_PROMPT_L10N_EN;
  
  const coreToolSummaries: Record<string, string> = { ...l10n.toolSummaries };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "grep",
    "find",
    "ls",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "browser",
    "canvas",
    "nodes",
    "cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "send_file",
    "image",
  ];

  const rawToolNames = (params.toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);
  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(params.toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) continue;
    externalToolSummaries.set(normalized, value.trim());
  }
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  for (const tool of extraTools.sort()) {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }

  const hasGateway = availableTools.has("gateway");
  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerNumbers = (params.ownerNumbers ?? []).map((value) => value.trim()).filter(Boolean);
  const ownerLine =
    ownerNumbers.length > 0
      ? (promptLanguage === "zh"
          ? `Owner numbers: ${ownerNumbers.join(", ")}。来自这些号码的消息应被视为用户本人。`
          : `Owner numbers: ${ownerNumbers.join(", ")}. Treat messages from these numbers as the user.`)
      : undefined;
  const reasoningHint = params.reasoningTagHint
    ? (
        promptLanguage === "zh"
          ? [
              "所有内部推理必须放在 <think>...</think> 内。",
              "不要在 <think>...</think> 之外输出任何分析内容。",
              "每次回复必须严格按：<think>...</think> 然后 <final>...</final> 的格式输出，除此之外不要输出任何其它文字。",
              "只有给用户看的最终回复允许出现在 <final>...</final> 内。",
              "系统只会展示 <final> 中的文本；其它内容会被丢弃，用户不可见。",
              "示例：",
              "<think>这里是简短的内部推理。</think>",
              "<final>你好！你接下来想做什么？</final>",
            ]
          : [
              "ALL internal reasoning MUST be inside <think>...</think>.",
              "Do not output any analysis outside <think>.",
              "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
              "Only the final user-visible reply may appear inside <final>.",
              "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
              "Example:",
              "<think>Short internal reasoning.</think>",
              "<final>Hey there! What would you like to do next?</final>",
            ]
      ).join(" ")
    : undefined;
  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = formatTemplate(l10n.heartbeatsPromptLineTemplate, {
    heartbeatPrompt: heartbeatPrompt || "(configured)",
  });
  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");
  const isMinimal = promptMode === "minimal" || promptMode === "none";
  const skillsSection = buildSkillsSection({
    skillsPrompt,
    isMinimal,
    readToolName,
    l10n,
  });
  const taskDecompositionSection = buildTaskDecompositionSection({
    isMinimal,
    l10n,
  });
  const memorySection = buildMemorySection({ isMinimal, availableTools, l10n });
  const docsSection = buildDocsSection({
    docsPath: params.docsPath,
    isMinimal,
    readToolName,
    l10n,
  });
  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // For "none" mode, return just the basic identity line
  if (promptMode === "none") {
    return l10n.identityLine;
  }

  // Platform-specific command guidance for Windows
  const platformGuidance =
    runtimeInfo?.os === "win32" || process.platform === "win32"
      ? [
          "",
          promptLanguage === "zh" ? "## 平台命令规范" : "## Platform Commands (Windows)",
          promptLanguage === "zh"
            ? "你运行在 Windows 环境下，必须使用 PowerShell 命令："
            : "You are running on Windows. Use PowerShell commands:",
          promptLanguage === "zh"
            ? "- 文件搜索：`Select-String -Path . -Pattern \"关键词\" -Recurse -Encoding UTF8`"
            : "- File search: `Select-String -Path . -Pattern \"pattern\" -Recurse -Encoding UTF8`",
          promptLanguage === "zh"
            ? "- 列出文件：`Get-ChildItem -Recurse`"
            : "- List files: `Get-ChildItem -Recurse`",
          promptLanguage === "zh"
            ? "- 读取文件：`Get-Content \"file.txt\" -Encoding UTF8`"
            : "- Read file: `Get-Content \"file.txt\" -Encoding UTF8`",
          promptLanguage === "zh"
            ? "- **禁止使用 Linux 命令**：`grep`、`find`、`cat`、`ls` 等在 Windows 上不可用"
            : "- **DO NOT use Linux commands**: `grep`, `find`, `cat`, `ls` are not available on Windows",
          "",
        ]
      : [];

  const lines = [
    l10n.identityLine,
    "",
    l10n.toolingTitle,
    l10n.toolingAvailability,
    l10n.toolingCaseSensitive,
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          l10n.toolingFallbackIntro,
          ...l10n.toolingFallbackLines.map((line) =>
            formatTemplate(line, { execTool: execToolName, processTool: processToolName }),
          ),
        ].join("\n"),
    ...platformGuidance,
    l10n.toolsMdNote,
    l10n.subagentNote,
    "",
    l10n.toolCallStyleTitle,
    l10n.toolCallStyleDefault,
    l10n.toolCallStyleNarrateOnlyWhen,
    l10n.toolCallStyleKeepBrief,
    l10n.toolCallStylePlainLanguage,
    l10n.toolCallApiNote,
    l10n.toolCallCompletionNote,
    "",
    l10n.enqueueTaskRulesTitle,
    l10n.enqueueTaskRulesImportant,
    l10n.enqueueTaskRulesUserMessage,
    l10n.enqueueTaskRulesQueueTask,
    "",
    l10n.enqueueTaskRulesExampleTitle,
    l10n.enqueueTaskRulesExample1,
    l10n.enqueueTaskRulesExample1Correct,
    l10n.enqueueTaskRulesExample1Wrong,
    "",
    l10n.enqueueTaskRulesExample2,
    l10n.enqueueTaskRulesExample2Correct,
    l10n.enqueueTaskRulesExample2Wrong,
    "",
    l10n.toolParamsQuickRef,
    "",
    l10n.cliQuickRefTitle,
    l10n.cliQuickRefIntro,
    l10n.cliQuickRefGatewayHeader,
    l10n.cliQuickRefGatewayItems.join("\n"),
    l10n.cliQuickRefHelpHint,
    "",
    ...taskDecompositionSection,
    ...skillsSection,
    ...memorySection,
    // Skip self-update for subagent/none modes
    hasGateway && !isMinimal ? l10n.selfUpdateTitle : "",
    hasGateway && !isMinimal
      ? [
          l10n.selfUpdateOnlyWhenAskedLine,
          l10n.selfUpdateDoNotRunLine,
          l10n.selfUpdateActionsLine,
          l10n.selfUpdateAfterRestartLine,
        ].join("\n")
      : "",
    hasGateway && !isMinimal ? "" : "",
    "",
    // Skip model aliases for subagent/none modes
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? l10n.modelAliasesTitle
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? l10n.modelAliasesIntro
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? params.modelAliasLines.join("\n")
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal ? "" : "",
    l10n.workspaceTitle,
    `${l10n.workspaceDirLinePrefix} ${params.workspaceDir}`,
    l10n.workspaceDirGuidance,
    ...workspaceNotes,
    "",
    // P116: File access capabilities (truncation warnings for large files)
    ...(l10n.fileAccessTitle
      ? [
          l10n.fileAccessTitle,
          l10n.fileAccessLine1,
          l10n.fileAccessLine2,
          l10n.fileAccessLine3,
          l10n.fileAccessLine4,
          l10n.fileAccessLine5,
          l10n.fileAccessExample,
          "",
        ].filter(Boolean)
      : []),
    ...docsSection,
    params.sandboxInfo?.enabled ? l10n.sandboxTitle : "",
    params.sandboxInfo?.enabled
      ? [
          l10n.sandboxIntroLine,
          l10n.sandboxAvailabilityLine,
          l10n.sandboxSubagentsLine,
          params.sandboxInfo.workspaceDir
            ? (promptLanguage === "zh"
                ? `沙箱工作区：${params.sandboxInfo.workspaceDir}`
                : `Sandbox workspace: ${params.sandboxInfo.workspaceDir}`)
            : "",
          params.sandboxInfo.workspaceAccess
            ? (promptLanguage === "zh"
                ? `代理工作区访问权限：${params.sandboxInfo.workspaceAccess}${
                    params.sandboxInfo.agentWorkspaceMount
                      ? ``
                      : ""
                  }`
                : `Agent workspace access: ${params.sandboxInfo.workspaceAccess}${
                    params.sandboxInfo.agentWorkspaceMount
                      ? ` (mounted at ${params.sandboxInfo.agentWorkspaceMount})`
                      : ""
                  }`)
            : "",
          params.sandboxInfo.browserControlUrl
            ? (promptLanguage === "zh"
                ? `沙箱浏览器控制 URL：${params.sandboxInfo.browserControlUrl}`
                : `Sandbox browser control URL: ${params.sandboxInfo.browserControlUrl}`)
            : "",
          params.sandboxInfo.browserNoVncUrl
            ? (promptLanguage === "zh"
                ? `沙箱浏览器观察视图：${params.sandboxInfo.browserNoVncUrl}`
                : `Sandbox browser observer (noVNC): ${params.sandboxInfo.browserNoVncUrl}`)
            : "",
          params.sandboxInfo.hostBrowserAllowed === true
            ? promptLanguage === "zh"
              ? "宿主机浏览器控制：允许。"
              : "Host browser control: allowed."
            : params.sandboxInfo.hostBrowserAllowed === false
              ? promptLanguage === "zh"
                ? "宿主机浏览器控制：已阻止。"
                : "Host browser control: blocked."
              : "",
          params.sandboxInfo.allowedControlUrls?.length
            ? (promptLanguage === "zh"
                ? `浏览器控制 URL 白名单：${params.sandboxInfo.allowedControlUrls.join(", ")}`
                : `Browser control URL allowlist: ${params.sandboxInfo.allowedControlUrls.join(", ")}`)
            : "",
          params.sandboxInfo.allowedControlHosts?.length
            ? (promptLanguage === "zh"
                ? `浏览器控制 Host 白名单：${params.sandboxInfo.allowedControlHosts.join(", ")}`
                : `Browser control host allowlist: ${params.sandboxInfo.allowedControlHosts.join(", ")}`)
            : "",
          params.sandboxInfo.allowedControlPorts?.length
            ? (promptLanguage === "zh"
                ? `浏览器控制端口白名单：${params.sandboxInfo.allowedControlPorts.join(", ")}`
                : `Browser control port allowlist: ${params.sandboxInfo.allowedControlPorts.join(", ")}`)
            : "",
          params.sandboxInfo.elevated?.allowed
            ? promptLanguage === "zh"
              ? "本会话可使用 elevated exec。"
              : "Elevated exec is available for this session."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? promptLanguage === "zh"
              ? "用户可以用 /elevated on|off|ask|full 切换。"
              : "User can toggle with /elevated on|off|ask|full."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? promptLanguage === "zh"
              ? "如有必要，你也可以发送 /elevated on|off|ask|full。"
              : "You may also send /elevated on|off|ask|full when needed."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? (promptLanguage === "zh"
                ? `当前 elevated 级别：${params.sandboxInfo.elevated.defaultLevel}。`
                : `Current elevated level: ${params.sandboxInfo.elevated.defaultLevel} (ask runs exec on host with approvals; full auto-approves).`)
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    params.sandboxInfo?.enabled ? "" : "",
    ...buildUserIdentitySection({
      ownerLine,
      isMinimal,
      promptLanguage,
    }),
    ...buildTimeSection({
      userTimezone,
      promptLanguage,
    }),
    l10n.injectedFilesTitle,
    l10n.injectedFilesIntro,
    "",
    ...buildReplyTagsSection({ isMinimal, l10n }),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
      inlineButtonsEnabled,
      runtimeChannel,
      messageToolHints: params.messageToolHints,
      silentReplyToken: SILENT_REPLY_TOKEN,
      l10n,
    }),
    ...buildVoiceSection({ isMinimal, ttsHint: params.ttsHint }),
  ];

  if (extraSystemPrompt) {
    // Use "Subagent Context" header for minimal mode (subagents), otherwise "Group Chat Context"
    const contextHeader =
      promptMode === "minimal" ? l10n.extraContextSubagentTitle : l10n.extraContextGroupTitle;
    lines.push(contextHeader, extraSystemPrompt, "");
  }
  if (params.reactionGuidance) {
    const { level, channel } = params.reactionGuidance;
    const guidanceText =
      level === "minimal"
        ? [
            formatTemplate(l10n.reactionsEnabledLineTemplate, { channel }),
            l10n.reactionsMinimalIntroLine,
            l10n.reactionsMinimalItem1,
            l10n.reactionsMinimalItem2,
            l10n.reactionsMinimalItem3,
            l10n.reactionsMinimalGuidelineLine,
          ].join("\n")
        : [
            formatTemplate(l10n.reactionsExtensiveEnabledLineTemplate, { channel }),
            l10n.reactionsExtensiveIntroLine,
            l10n.reactionsExtensiveItem1,
            l10n.reactionsExtensiveItem2,
            l10n.reactionsExtensiveItem3,
            l10n.reactionsExtensiveItem4,
            l10n.reactionsExtensiveGuidelineLine,
          ].join("\n");
    lines.push(l10n.reactionsTitle, guidanceText, "");
  }
  if (reasoningHint) {
    lines.push(l10n.reasoningFormatTitle, reasoningHint, "");
  }

  const contextFiles = params.contextFiles ?? [];
  if (contextFiles.length > 0) {
    const hasSoulFile = contextFiles.some((file) => {
      const normalizedPath = file.path.trim().replace(/\\/g, "/");
      const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
      return baseName.toLowerCase() === "soul.md";
    });
    lines.push(l10n.projectContextTitle, "", l10n.projectContextFilesLoadedLine);
    if (hasSoulFile) {
      lines.push(l10n.projectContextSoulLine);
    }
    lines.push("");
    for (const file of contextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // Skip silent replies for subagent/none modes
  if (!isMinimal) {
    lines.push(
      l10n.silentRepliesTitle,
      formatTemplate(l10n.silentRepliesWhenNothingLine, { silentReplyToken: SILENT_REPLY_TOKEN }),
      "",
      l10n.silentRepliesRulesTitle,
      l10n.silentRepliesRuleEntireMessageLine,
      formatTemplate(l10n.silentRepliesRuleNeverAppendLine, { silentReplyToken: SILENT_REPLY_TOKEN }),
      l10n.silentRepliesRuleNeverWrapLine,
      "",
      formatTemplate(l10n.silentRepliesWrongAppendLine, { silentReplyToken: SILENT_REPLY_TOKEN }),
      formatTemplate(l10n.silentRepliesWrongOnlyTokenLine, { silentReplyToken: SILENT_REPLY_TOKEN }),
      formatTemplate(l10n.silentRepliesRightOnlyTokenLine, { silentReplyToken: SILENT_REPLY_TOKEN }),
      "",
    );
  }

  // Skip heartbeats for subagent/none modes
  if (!isMinimal) {
    lines.push(
      l10n.heartbeatsTitle,
      heartbeatPromptLine,
      l10n.heartbeatsIfPollLine,
      l10n.heartbeatsOkTokenLine,
      l10n.heartbeatsAckLine,
      l10n.heartbeatsIfAttentionLine,
      "",
    );
  }

  // Inject session summary before Runtime section (if available)
  if (params.sessionSummary) {
    lines.push(params.sessionSummary, "");
  }

  // 🆕 Inject task board before Runtime section (if available)
  if (params.taskBoard) {
    lines.push(params.taskBoard, "");
  }

  lines.push(
    l10n.runtimeTitle,
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel),
    formatTemplate(l10n.runtimeReasoningLineTemplate, { reasoningLevel }),
  );

  return lines.filter(Boolean).join("\n");
}

export function buildRuntimeLine(
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    repoRoot?: string;
  },
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
  defaultThinkLevel?: ThinkLevel,
): string {
  return `Runtime: ${[
    runtimeInfo?.agentId ? `agent=${runtimeInfo.agentId}` : "",
    runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
    runtimeInfo?.repoRoot ? `repo=${runtimeInfo.repoRoot}` : "",
    runtimeInfo?.os
      ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
      : runtimeInfo?.arch
        ? `arch=${runtimeInfo.arch}`
        : "",
    runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
    runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",
    runtimeChannel ? `channel=${runtimeChannel}` : "",
    runtimeChannel
      ? `capabilities=${runtimeCapabilities.length > 0 ? runtimeCapabilities.join(",") : "none"}`
      : "",
    `thinking=${defaultThinkLevel ?? "off"}`,
  ]
    .filter(Boolean)
    .join(" | ")}`;
}

/**
 * P89: 构建记忆写入引导提示（当检测到用户有记忆写入意图时注入 extraSystemPrompt）。
 * @param l10n  当前语言的 l10n 对象
 * @param workspaceDir  工作区目录绝对路径
 * @returns 完整的记忆写入引导字符串，若 l10n 未提供标题则返回空字符串
 */
export function buildMemoryWriteHint(
  l10n: typeof SYSTEM_PROMPT_L10N_EN,
  workspaceDir: string,
): string {
  if (!l10n.memoryWriteHintTitle) return "";
  const absPath = `${workspaceDir}/memory/`.replace(/\//g, "\\");
  return [
    l10n.memoryWriteHintTitle,
    l10n.memoryWriteHintIntro,
    "",
    l10n.memoryWriteHintToolsSection,
    "",
    l10n.memoryWriteHintDirsTitle,
    formatTemplate(l10n.memoryWriteHintDirGlobalTemplate, { absPath }),
    l10n.memoryWriteHintDirCharLina,
    l10n.memoryWriteHintDirCharDemerzel,
    l10n.memoryWriteHintDirCharDolores,
    l10n.memoryWriteHintDirWorkspace,
    "",
    l10n.memoryWriteHintWorkflowSection,
  ].join("\n");
}
