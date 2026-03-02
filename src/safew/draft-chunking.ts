import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { getChannelDock } from "../channels/dock.js";
import type { ClawdbotConfig } from "../config/config.js";
import { normalizeAccountId } from "../routing/session-key.js";

const DEFAULT_SAFEW_DRAFT_STREAM_MIN = 200;
const DEFAULT_SAFEW_DRAFT_STREAM_MAX = 800;

export function resolveSafewDraftStreamingChunking(
  cfg: ClawdbotConfig | undefined,
  accountId?: string | null,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const providerChunkLimit = getChannelDock("safew")?.outbound?.textChunkLimit;
  const textLimit = resolveTextChunkLimit(cfg, "safew", accountId, {
    fallbackLimit: providerChunkLimit,
  });
  const normalizedAccountId = normalizeAccountId(accountId);
  const draftCfg =
    cfg?.channels?.safew?.accounts?.[normalizedAccountId]?.draftChunk ??
    cfg?.channels?.safew?.draftChunk;

  const maxRequested = Math.max(
    1,
    Math.floor(draftCfg?.maxChars ?? DEFAULT_SAFEW_DRAFT_STREAM_MAX),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(
    1,
    Math.floor(draftCfg?.minChars ?? DEFAULT_SAFEW_DRAFT_STREAM_MIN),
  );
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence"
      ? draftCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}
