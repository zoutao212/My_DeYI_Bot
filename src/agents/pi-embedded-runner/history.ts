import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

import type { ClawdbotConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 * 
 * NEW: Preserves the first user message (task goal) to prevent task loss in long conversations.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) return messages;

  // Step 1: Extract task goal (first user message)
  const taskGoalIndex = messages.findIndex(m => m.role === "user");
  const taskGoal = taskGoalIndex >= 0 ? messages[taskGoalIndex] : null;

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        // Step 2: If task goal would be discarded, preserve it
        const limited = messages.slice(lastUserIndex);
        
        // Check if task goal is already in the limited messages
        if (taskGoal && !limited.some(m => m === taskGoal)) {
          // Only preserve task goal if it has content (user or assistant message)
          if ("content" in taskGoal && taskGoal.content !== undefined) {
            // Filter content to only include text and image (exclude thinking and tool calls)
            const filteredContent = Array.isArray(taskGoal.content)
              ? taskGoal.content.filter(
                  (item): item is TextContent | ImageContent =>
                    item.type === "text" || item.type === "image"
                )
              : [];
            
            // Create a new user message with the task goal content
            const taskGoalMessage: AgentMessage = {
              role: "user",
              content: [
                { type: "text", text: "[任务目标 - 保留自对话开始]\n" },
                ...filteredContent
              ],
              timestamp: taskGoal.timestamp
            };
            return [taskGoalMessage, ...limited];
          }
        }
        
        return limited;
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 */
export function getDmHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: ClawdbotConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) return undefined;

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = providerParts[0]?.toLowerCase();
  if (!provider) return undefined;

  const kind = providerParts[1]?.toLowerCase();
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);
  if (kind !== "dm") return undefined;

  const getLimit = (
    providerConfig:
      | {
          dmHistoryLimit?: number;
          dms?: Record<string, { historyLimit?: number }>;
        }
      | undefined,
  ): number | undefined => {
    if (!providerConfig) return undefined;
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  };

  const resolveProviderConfig = (
    cfg: ClawdbotConfig | undefined,
    providerId: string,
  ): { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> } | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") return undefined;
    const entry = (channels as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    return entry as { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> };
  };

  return getLimit(resolveProviderConfig(config, provider));
}
