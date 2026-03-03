import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import {
  listSafewAccountIds,
  resolveDefaultSafewAccountId,
  resolveSafewAccount,
} from "../../../safew/accounts.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "safew" as const;

function setsafewDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.safew?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      safew: {
        ...cfg.channels?.safew,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function notesafewTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Open safew and chat with @BotFather (SafeW)",
      "2) Run /newbot (or /mybots)",
      "3) Copy the token (looks like 123456:ABC...)",
      "Tip: you can also set safew_BOT_TOKEN in your env.",
      `Docs: ${formatDocsLink("/safew")}`,
      "Website: https://clawd.bot",
    ].join("\n"),
    "safew bot token",
  );
}

async function notesafewUserIdHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      `1) DM your bot, then read from.id in \`${formatCliCommand("clawdbot logs --follow")}\` (safest)`,
      "2) Or call https://api.safew.org/bot<bot_token>/getUpdates and read message.from.id",
      "3) Third-party: DM @userinfobot or @getidsbot",
      `Docs: ${formatDocsLink("/safew")}`,
      "Website: https://clawd.bot",
    ].join("\n"),
    "safew user id",
  );
}

async function promptsafewAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<ClawdbotConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveSafewAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  await notesafewUserIdHelp(prompter);

  const token = resolved.token;
  if (!token) {
    await prompter.note("safew token missing; username lookup is unavailable.", "safew");
  }

  const resolveSafewUserId = async (raw: string): Promise<string | null> => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const stripped = trimmed.replace(/^(safew|tg):/i, "").trim();
    if (/^\d+$/.test(stripped)) return stripped;
    if (!token) return null;
    const username = stripped.startsWith("@") ? stripped : `@${stripped}`;
    const url = `https://api.safew.org/bot${token}/getChat?chat_id=${encodeURIComponent(username)}`;
    const res = await fetch(url);
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { id?: number | string };
    } | null;
    const id = data?.ok ? data?.result?.id : undefined;
    if (typeof id === "number" || typeof id === "string") return String(id);
    return null;
  };

  const parseInput = (value: string) =>
    value
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  let resolvedIds: string[] = [];
  while (resolvedIds.length === 0) {
    const entry = await prompter.text({
      message: "safew allowFrom (username or user id)",
      placeholder: "@username",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseInput(String(entry));
    const results = await Promise.all(parts.map((part) => resolveSafewUserId(part)));
    const unresolved = parts.filter((_, idx) => !results[idx]);
    if (unresolved.length > 0) {
      await prompter.note(
        `Could not resolve: ${unresolved.join(", ")}. Use @username or numeric id.`,
        "safew allowlist",
      );
      continue;
    }
    resolvedIds = results.filter(Boolean) as string[];
  }

  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    ...resolvedIds,
  ];
  const unique = [...new Set(merged)];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        safew: {
          ...cfg.channels?.safew,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      safew: {
        ...cfg.channels?.safew,
        enabled: true,
        accounts: {
          ...cfg.channels?.safew?.accounts,
          [accountId]: {
            ...cfg.channels?.safew?.accounts?.[accountId],
            enabled: cfg.channels?.safew?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  };
}

async function promptsafewAllowFromForAccount(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<ClawdbotConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultSafewAccountId(params.cfg);
  return promptsafewAllowFrom({
    cfg: params.cfg,
    prompter: params.prompter,
    accountId,
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "safew",
  channel,
  policyKey: "channels.safew.dmPolicy",
  allowFromKey: "channels.safew.allowFrom",
  getCurrent: (cfg) => cfg.channels?.safew?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setsafewDmPolicy(cfg, policy),
  promptAllowFrom: promptsafewAllowFromForAccount,
};

export const safewOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listSafewAccountIds(cfg).some((accountId) =>
      Boolean(resolveSafewAccount({ cfg, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`safew: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "recommended · configured" : "recommended · newcomer-friendly",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const safewOverride = accountOverrides.safew?.trim();
    const defaultsafewAccountId = resolveDefaultSafewAccountId(cfg);
    let safewAccountId = safewOverride
      ? normalizeAccountId(safewOverride)
      : defaultsafewAccountId;
    if (shouldPromptAccountIds && !safewOverride) {
      safewAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "safew",
        currentId: safewAccountId,
        listAccountIds: listSafewAccountIds,
        defaultAccountId: defaultsafewAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveSafewAccount({
      cfg: next,
      accountId: safewAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = safewAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.safew_BOT_TOKEN?.trim());
    const hasConfigToken = Boolean(
      resolvedAccount.config.botToken || resolvedAccount.config.tokenFile,
    );

    let token: string | null = null;
    if (!accountConfigured) {
      await notesafewTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.botToken) {
      const keepEnv = await prompter.confirm({
        message: "safew_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            safew: {
              ...next.channels?.safew,
              enabled: true,
            },
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter safew bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "safew token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter safew bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter safew bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (safewAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            safew: {
              ...next.channels?.safew,
              enabled: true,
              botToken: token,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            safew: {
              ...next.channels?.safew,
              enabled: true,
              accounts: {
                ...next.channels?.safew?.accounts,
                [safewAccountId]: {
                  ...next.channels?.safew?.accounts?.[safewAccountId],
                  enabled: next.channels?.safew?.accounts?.[safewAccountId]?.enabled ?? true,
                  botToken: token,
                },
              },
            },
          },
        };
      }
    }

    if (forceAllowFrom) {
      next = await promptsafewAllowFrom({
        cfg: next,
        prompter,
        accountId: safewAccountId,
      });
    }

    return { cfg: next, accountId: safewAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      safew: { ...cfg.channels?.safew, enabled: false },
    },
  }),
};
