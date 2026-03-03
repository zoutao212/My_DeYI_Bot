import type { ClawdbotConfig } from "../config/config.js";
import type { SafewAccountConfig } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { listBoundAccountIds, resolveDefaultAgentBoundAccountId } from "../routing/bindings.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { resolveSafewToken } from "./token.js";

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DEBUG_SAFEW_ACCOUNTS)) {
    console.warn("[safew:accounts]", ...args);
  }
};

export type ResolvedSafewAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: SafewAccountConfig;
};

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = cfg.channels?.safew?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) continue;
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listSafewAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = Array.from(
    new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "safew")]),
  );
  debugAccounts("listSafewAccountIds", ids);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultSafewAccountId(cfg: ClawdbotConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "safew");
  if (boundDefault) return boundDefault;
  const ids = listSafewAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): SafewAccountConfig | undefined {
  const accounts = cfg.channels?.safew?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const direct = accounts[accountId] as SafewAccountConfig | undefined;
  if (direct) return direct;
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as SafewAccountConfig | undefined) : undefined;
}

function mergeSafewAccountConfig(cfg: ClawdbotConfig, accountId: string): SafewAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.safew ??
    {}) as SafewAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveSafewAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedSafewAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.safew?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeSafewAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveSafewToken(params.cfg, { accountId });
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source,
    });
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      config: merged,
    } satisfies ResolvedSafewAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) return primary;
  if (primary.tokenSource !== "none") return primary;

  const fallbackId = resolveDefaultSafewAccountId(params.cfg);
  if (fallbackId === primary.accountId) return primary;
  const fallback = resolve(fallbackId);
  if (fallback.tokenSource === "none") return primary;
  return fallback;
}

export function listEnabledSafewAccounts(cfg: ClawdbotConfig): ResolvedSafewAccount[] {
  return listSafewAccountIds(cfg)
    .map((accountId) => resolveSafewAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
