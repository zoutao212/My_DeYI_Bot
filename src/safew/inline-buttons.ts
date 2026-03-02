import type { ClawdbotConfig } from "../config/config.js";
import type { SafewInlineButtonsScope } from "../config/types.safew.js";
import { listSafewAccountIds, resolveSafewAccount } from "./accounts.js";
import { parseSafewTarget } from "./targets.js";

const DEFAULT_INLINE_BUTTONS_SCOPE: SafewInlineButtonsScope = "allowlist";

function normalizeInlineButtonsScope(value: unknown): SafewInlineButtonsScope | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "off" ||
    trimmed === "dm" ||
    trimmed === "group" ||
    trimmed === "all" ||
    trimmed === "allowlist"
  ) {
    return trimmed as SafewInlineButtonsScope;
  }
  return undefined;
}

function resolveInlineButtonsScopeFromCapabilities(
  capabilities: unknown,
): SafewInlineButtonsScope {
  if (!capabilities) return DEFAULT_INLINE_BUTTONS_SCOPE;
  if (Array.isArray(capabilities)) {
    const enabled = capabilities.some(
      (entry) => String(entry).trim().toLowerCase() === "inlinebuttons",
    );
    return enabled ? "all" : "off";
  }
  if (typeof capabilities === "object") {
    const inlineButtons = (capabilities as { inlineButtons?: unknown }).inlineButtons;
    return normalizeInlineButtonsScope(inlineButtons) ?? DEFAULT_INLINE_BUTTONS_SCOPE;
  }
  return DEFAULT_INLINE_BUTTONS_SCOPE;
}

export function resolveSafewInlineButtonsScope(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): SafewInlineButtonsScope {
  const account = resolveSafewAccount({ cfg: params.cfg, accountId: params.accountId });
  return resolveInlineButtonsScopeFromCapabilities(account.config.capabilities);
}

export function isSafewInlineButtonsEnabled(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): boolean {
  if (params.accountId) {
    return resolveSafewInlineButtonsScope(params) !== "off";
  }
  const accountIds = listSafewAccountIds(params.cfg);
  if (accountIds.length === 0) {
    return resolveSafewInlineButtonsScope(params) !== "off";
  }
  return accountIds.some(
    (accountId) => resolveSafewInlineButtonsScope({ cfg: params.cfg, accountId }) !== "off",
  );
}

export function resolveSafewTargetChatType(target: string): "direct" | "group" | "unknown" {
  if (!target.trim()) return "unknown";
  const parsed = parseSafewTarget(target);
  const chatId = parsed.chatId.trim();
  if (!chatId) return "unknown";
  if (/^-?\d+$/.test(chatId)) {
    return chatId.startsWith("-") ? "group" : "direct";
  }
  return "unknown";
}
