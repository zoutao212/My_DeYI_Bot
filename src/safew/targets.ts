export type SafewTarget = {
  chatId: string;
  messageThreadId?: number;
};

export function stripSafewInternalPrefixes(to: string): string {
  let trimmed = to.trim();
  let strippedSafewPrefix = false;
  while (true) {
    const next = (() => {
      if (/^(safew|tg):/i.test(trimmed)) {
        strippedSafewPrefix = true;
        return trimmed.replace(/^(safew|tg):/i, "").trim();
      }
      // Legacy internal form: `safew:group:<id>` (still emitted by session keys).
      if (strippedSafewPrefix && /^group:/i.test(trimmed)) {
        return trimmed.replace(/^group:/i, "").trim();
      }
      return trimmed;
    })();
    if (next === trimmed) return trimmed;
    trimmed = next;
  }
}

/**
 * Parse a Safew delivery target into chatId and optional topic/thread ID.
 *
 * Supported formats:
 * - `chatId` (plain chat ID, t.me link, @username, or internal prefixes like `safew:...`)
 * - `chatId:topicId` (numeric topic/thread ID)
 * - `chatId:topic:topicId` (explicit topic marker; preferred)
 */
export function parseSafewTarget(to: string): SafewTarget {
  const normalized = stripSafewInternalPrefixes(to);

  const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
  if (topicMatch) {
    return {
      chatId: topicMatch[1],
      messageThreadId: Number.parseInt(topicMatch[2], 10),
    };
  }

  const colonMatch = /^(.+):(\d+)$/.exec(normalized);
  if (colonMatch) {
    return {
      chatId: colonMatch[1],
      messageThreadId: Number.parseInt(colonMatch[2], 10),
    };
  }

  return { chatId: normalized };
}
