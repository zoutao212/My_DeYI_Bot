import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  collectSafewStatusIssues,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  listSafewAccountIds,
  listSafewDirectoryGroupsFromConfig,
  listSafewDirectoryPeersFromConfig,
  looksLikeSafewTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeSafewMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveDefaultSafewAccountId,
  resolveSafewAccount,
  resolveSafewGroupRequireMention,
  resolveSafewGroupToolPolicy,
  setAccountEnabledInConfigSection,
  safewOnboardingAdapter,
  SafewConfigSchema,
  type ChannelMessageActionAdapter,
  type ChannelMessageActionContext,
  type ChannelGatewayContext,
  type ChannelPlugin,
  type ClawdbotConfig,
  type ResolvedSafewAccount,
} from "clawdbot/plugin-sdk";

import { getSafewRuntime } from "./runtime.js";

const meta = getChatChannelMeta("safew");

type SafewListActionsParams = { cfg: ClawdbotConfig };
type SafewExtractToolSendParams = { args: Record<string, unknown> };

const safewMessageActions: ChannelMessageActionAdapter = {
  listActions: (params: SafewListActionsParams) =>
    getSafewRuntime().channel.safew.messageActions.listActions?.(params) ?? [],
  extractToolSend: (params: SafewExtractToolSendParams) =>
    getSafewRuntime().channel.safew.messageActions.extractToolSend?.(params) ?? null,
  handleAction: async (ctx: ChannelMessageActionContext) =>
    await (getSafewRuntime().channel.safew.messageActions.handleAction?.(ctx) ??
      Promise.reject(new Error("Safew message action handler not configured"))),
};

function parseReplyToMessageId(replyToId?: string | null) {
  if (!replyToId) return undefined;
  const parsed = Number.parseInt(replyToId, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseThreadId(threadId?: string | number | null) {
  if (threadId == null) return undefined;
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
  }
  const trimmed = threadId.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
export const safewPlugin: ChannelPlugin<ResolvedSafewAccount> = {
  id: "safew",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  onboarding: safewOnboardingAdapter,
  pairing: {
    idLabel: "safewUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(safew|tg):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const { token } = getSafewRuntime().channel.safew.resolveSafewToken(cfg);
      if (!token) throw new Error("safew token not configured");
      await getSafewRuntime().channel.safew.sendMessageSafew(id, PAIRING_APPROVED_MESSAGE, {
        token,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.safew"] },
  configSchema: buildChannelConfigSchema(SafewConfigSchema),
  config: {
    listAccountIds: (cfg) => listSafewAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSafewAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSafewAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "safew",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "safew",
        accountId,
        clearBaseFields: ["botToken", "tokenFile", "name"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveSafewAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(safew|tg):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.safew?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.safew.accounts.${resolvedAccountId}.`
        : "channels.safew.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("safew"),
        normalizeEntry: (raw) => raw.replace(/^(safew|tg):/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      const groupAllowlistConfigured =
        account.config.groups && Object.keys(account.config.groups).length > 0;
      if (groupAllowlistConfigured) {
        return [
          `- Safew groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.safew.groupPolicy="allowlist" + channels.safew.groupAllowFrom to restrict senders.`,
        ];
      }
      return [
        `- Safew groups: groupPolicy="open" with no channels.safew.groups allowlist; any group can add + ping (mention-gated). Set channels.safew.groupPolicy="allowlist" + channels.safew.groupAllowFrom or configure channels.safew.groups.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveSafewGroupRequireMention,
    resolveToolPolicy: resolveSafewGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.safew?.replyToMode ?? "first",
  },
  messaging: {
    normalizeTarget: normalizeSafewMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeSafewTargetId,
      hint: "<chatId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) => listSafewDirectoryPeersFromConfig(params),
    listGroups: async (params) => listSafewDirectoryGroupsFromConfig(params),
  },
  actions: safewMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "safew",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "SAFEW_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Safew requires token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "safew",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "safew",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            safew: {
              ...next.channels?.safew,
              enabled: true,
              ...(input.useEnv
                ? {}
                : input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          safew: {
            ...next.channels?.safew,
            enabled: true,
            accounts: {
              ...next.channels?.safew?.accounts,
              [accountId]: {
                ...next.channels?.safew?.accounts?.[accountId],
                enabled: true,
                ...(input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getSafewRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, deps, replyToId, threadId }) => {
      const send =
        deps?.sendSafew ?? getSafewRuntime().channel.safew.sendMessageSafew;
      const replyToMessageId = parseReplyToMessageId(replyToId);
      const messageThreadId = parseThreadId(threadId);
      const result = await send(to, text, {
        verbose: false,
        messageThreadId,
        replyToMessageId,
        accountId: accountId ?? undefined,
      });
      return { channel: "safew", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, threadId }) => {
      const send =
        deps?.sendSafew ?? getSafewRuntime().channel.safew.sendMessageSafew;
      const replyToMessageId = parseReplyToMessageId(replyToId);
      const messageThreadId = parseThreadId(threadId);
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        messageThreadId,
        replyToMessageId,
        accountId: accountId ?? undefined,
      });
      return { channel: "safew", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectSafewStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      getSafewRuntime().channel.safew.probeSafew(
        account.token,
        timeoutMs,
        account.config.proxy,
      ),
    auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
      const groups =
        cfg.channels?.safew?.accounts?.[account.accountId]?.groups ??
        cfg.channels?.safew?.groups;
      const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } =
        getSafewRuntime().channel.safew.collectUnmentionedGroupIds(groups);
      if (!groupIds.length && unresolvedGroups === 0 && !hasWildcardUnmentionedGroups) {
        return undefined;
      }
      const botId =
        (probe as { ok?: boolean; bot?: { id?: number } })?.ok &&
        (probe as { bot?: { id?: number } }).bot?.id != null
          ? (probe as { bot: { id: number } }).bot.id
          : null;
      if (!botId) {
        return {
          ok: unresolvedGroups === 0 && !hasWildcardUnmentionedGroups,
          checkedGroups: 0,
          unresolvedGroups,
          hasWildcardUnmentionedGroups,
          groups: [],
          elapsedMs: 0,
        };
      }
      const audit = await getSafewRuntime().channel.safew.auditGroupMembership({
        token: account.token,
        botId,
        groupIds,
        proxyUrl: account.config.proxy,
        timeoutMs,
      });
      return { ...audit, unresolvedGroups, hasWildcardUnmentionedGroups };
    },
    buildAccountSnapshot: ({ account, cfg, runtime, probe, audit }) => {
      const configured = Boolean(account.token?.trim());
      const groups =
        cfg.channels?.safew?.accounts?.[account.accountId]?.groups ??
        cfg.channels?.safew?.groups;
      const allowUnmentionedGroups =
        Boolean(
          groups?.["*"] && (groups["*"] as { requireMention?: boolean }).requireMention === false,
        ) ||
        Object.entries(groups ?? {}).some(
          ([key, value]) =>
            key !== "*" &&
            Boolean(value) &&
            typeof value === "object" &&
            (value as { requireMention?: boolean }).requireMention === false,
        );
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
        probe,
        audit,
        allowUnmentionedGroups,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx: ChannelGatewayContext<ResolvedSafewAccount>) => {
      const account = ctx.account;
      const token = account.token.trim();
      let safewBotLabel = "";
      try {
        const probe = await getSafewRuntime().channel.safew.probeSafew(
          token,
          2500,
          account.config.proxy,
        );
        const username = probe.ok ? probe.bot?.username?.trim() : null;
        if (username) safewBotLabel = ` (@${username})`;
      } catch (err) {
        if (getSafewRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }
      ctx.log?.info(`[${account.accountId}] starting provider${safewBotLabel}`);
      return getSafewRuntime().channel.safew.monitorSafewProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        useWebhook: Boolean(account.config.webhookUrl),
        webhookUrl: account.config.webhookUrl,
        webhookSecret: account.config.webhookSecret,
        webhookPath: account.config.webhookPath,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const envToken = process.env.SAFEW_BOT_TOKEN?.trim() ?? "";
      const nextCfg = { ...cfg } as ClawdbotConfig;
      const nextSafew = cfg.channels?.safew ? { ...cfg.channels.safew } : undefined;
      let cleared = false;
      let changed = false;
      if (nextSafew) {
        if (accountId === DEFAULT_ACCOUNT_ID && nextSafew.botToken) {
          delete nextSafew.botToken;
          cleared = true;
          changed = true;
        }
        const accounts =
          nextSafew.accounts && typeof nextSafew.accounts === "object"
            ? { ...nextSafew.accounts }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...entry } as Record<string, unknown>;
            if ("botToken" in nextEntry) {
              const token = nextEntry.botToken;
              if (typeof token === "string" ? token.trim() : token) {
                cleared = true;
              }
              delete nextEntry.botToken;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry as typeof entry;
            }
          }
        }
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextSafew.accounts;
            changed = true;
          } else {
            nextSafew.accounts = accounts;
          }
        }
      }
      if (changed) {
        if (nextSafew && Object.keys(nextSafew).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, safew: nextSafew };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete nextChannels.safew;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
      }
      const resolved = resolveSafewAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";
      if (changed) {
        await getSafewRuntime().config.writeConfigFile(nextCfg);
      }
      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
};
