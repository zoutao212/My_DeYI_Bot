import { resolveEmbeddedSessionLane } from "../../../agents/pi-embedded.js";
import { clearCommandLane } from "../../../process/command-queue.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import { clearFollowupQueue } from "./state.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
};

export function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  const clearedKeys: string[] = [];

  for (const key of keys) {
    const cleaned = key?.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    followupCleared += clearFollowupQueue(cleaned);
    laneCleared += clearCommandLane(resolveEmbeddedSessionLane(cleaned));
  }

  return { followupCleared, laneCleared, keys: clearedKeys };
}

export function clearSessionQueuesByPrefix(prefixes: Array<string | undefined>): ClearSessionQueueResult {
  const cleanedPrefixes = prefixes
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => Boolean(p));
  if (cleanedPrefixes.length === 0) {
    return { followupCleared: 0, laneCleared: 0, keys: [] };
  }

  const keysToClear: string[] = [];
  for (const key of FOLLOWUP_QUEUES.keys()) {
    for (const prefix of cleanedPrefixes) {
      if (key === prefix || key.startsWith(`${prefix}:`)) {
        keysToClear.push(key);
        break;
      }
    }
  }

  return clearSessionQueues(keysToClear);
}
