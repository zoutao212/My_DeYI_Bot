import type { ClawdbotConfig } from "../config/config.js";
import type { SafewGroupConfig } from "../config/types.safew.js";
import { normalizeAccountId } from "../routing/session-key.js";

type SafewGroups = Record<string, SafewGroupConfig>;

type MigrationScope = "account" | "global";

export type SafewGroupMigrationResult = {
  migrated: boolean;
  skippedExisting: boolean;
  scopes: MigrationScope[];
};

function resolveAccountGroups(
  cfg: ClawdbotConfig,
  accountId?: string | null,
): { groups?: SafewGroups } {
  if (!accountId) return {};
  const normalized = normalizeAccountId(accountId);
  const accounts = cfg.channels?.safew?.accounts;
  if (!accounts || typeof accounts !== "object") return {};
  const exact = accounts[normalized];
  if (exact?.groups) return { groups: exact.groups };
  const matchKey = Object.keys(accounts).find(
    (key) => key.toLowerCase() === normalized.toLowerCase(),
  );
  return { groups: matchKey ? accounts[matchKey]?.groups : undefined };
}

export function migrateSafewGroupsInPlace(
  groups: SafewGroups | undefined,
  oldChatId: string,
  newChatId: string,
): { migrated: boolean; skippedExisting: boolean } {
  if (!groups) return { migrated: false, skippedExisting: false };
  if (oldChatId === newChatId) return { migrated: false, skippedExisting: false };
  if (!Object.hasOwn(groups, oldChatId)) return { migrated: false, skippedExisting: false };
  if (Object.hasOwn(groups, newChatId)) return { migrated: false, skippedExisting: true };
  groups[newChatId] = groups[oldChatId];
  delete groups[oldChatId];
  return { migrated: true, skippedExisting: false };
}

export function migrateSafewGroupConfig(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  oldChatId: string;
  newChatId: string;
}): SafewGroupMigrationResult {
  const scopes: MigrationScope[] = [];
  let migrated = false;
  let skippedExisting = false;

  const accountGroups = resolveAccountGroups(params.cfg, params.accountId).groups;
  if (accountGroups) {
    const result = migrateSafewGroupsInPlace(accountGroups, params.oldChatId, params.newChatId);
    if (result.migrated) {
      migrated = true;
      scopes.push("account");
    }
    if (result.skippedExisting) skippedExisting = true;
  }

  const globalGroups = params.cfg.channels?.safew?.groups;
  if (globalGroups) {
    const result = migrateSafewGroupsInPlace(globalGroups, params.oldChatId, params.newChatId);
    if (result.migrated) {
      migrated = true;
      scopes.push("global");
    }
    if (result.skippedExisting) skippedExisting = true;
  }

  return { migrated, skippedExisting, scopes };
}
