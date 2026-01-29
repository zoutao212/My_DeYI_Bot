import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import { ensureClawdbotModelsJson } from "./models-config.js";
import { limitHistoryTurns } from "./pi-embedded-runner.js";

// Mock removed - not needed for these tests

const _makeOpenAiConfig = (modelIds: string[]) =>
  ({
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  }) satisfies ClawdbotConfig;

const _ensureModels = (cfg: ClawdbotConfig, agentDir: string) =>
  ensureClawdbotModelsJson(cfg, agentDir) as unknown;

const _textFromContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const _readSessionMessages = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as { role?: string; content?: unknown });
};

describe("limitHistoryTurns", () => {
  const makeMessages = (roles: ("user" | "assistant")[]): AgentMessage[] =>
    roles.map((role, i) => {
      if (role === "user") {
        return {
          role: "user",
          content: [{ type: "text", text: `message ${i}` }],
          timestamp: Date.now() + i,
        };
      } else {
        return {
          role: "assistant",
          content: [{ type: "text", text: `message ${i}` }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-4",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now() + i,
        };
      }
    });

  it("returns all messages when limit is undefined", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, undefined)).toBe(messages);
  });
  it("returns all messages when limit is 0", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 0)).toBe(messages);
  });
  it("returns all messages when limit is negative", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, -1)).toBe(messages);
  });
  it("returns empty array when messages is empty", () => {
    expect(limitHistoryTurns([], 5)).toEqual([]);
  });
  it("keeps all messages when fewer user turns than limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 10)).toBe(messages);
  });
  it("limits to last N user turns", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 2);
    // Now includes task goal + last 2 user turns = 5 messages
    expect(limited.length).toBe(5);
    // First message is task goal with marker
    const firstMsg = limited[0];
    if ("content" in firstMsg && Array.isArray(firstMsg.content)) {
      const firstContent = firstMsg.content[0];
      if (firstContent && "text" in firstContent) {
        expect(firstContent.text).toContain("任务目标");
      }
    }
    // Rest are the last 2 user turns
    const secondMsg = limited[1];
    if ("content" in secondMsg && Array.isArray(secondMsg.content)) {
      expect(secondMsg.content).toEqual([{ type: "text", text: "message 2" }]);
    }
  });
  it("handles single user turn limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    // Now includes task goal + last 1 user turn = 3 messages
    expect(limited.length).toBe(3);
    // First message is task goal with marker
    const firstMsg = limited[0];
    if ("content" in firstMsg && Array.isArray(firstMsg.content)) {
      const firstContent = firstMsg.content[0];
      if (firstContent && "text" in firstContent) {
        expect(firstContent.text).toContain("任务目标");
      }
    }
    // Rest are the last user turn
    const secondMsg = limited[1];
    const thirdMsg = limited[2];
    if ("content" in secondMsg && Array.isArray(secondMsg.content)) {
      expect(secondMsg.content).toEqual([{ type: "text", text: "message 4" }]);
    }
    if ("content" in thirdMsg && Array.isArray(thirdMsg.content)) {
      expect(thirdMsg.content).toEqual([{ type: "text", text: "message 5" }]);
    }
  });
  it("handles messages with multiple assistant responses per user turn", () => {
    const messages = makeMessages(["user", "assistant", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    // Now includes task goal + last 1 user turn = 3 messages
    expect(limited.length).toBe(3);
    // First message is task goal
    expect(limited[0].role).toBe("user");
    const firstMsg = limited[0];
    if ("content" in firstMsg && Array.isArray(firstMsg.content)) {
      const firstContent = firstMsg.content[0];
      if (firstContent && "text" in firstContent) {
        expect(firstContent.text).toContain("任务目标");
      }
    }
    // Rest are the last user turn
    expect(limited[1].role).toBe("user");
    expect(limited[2].role).toBe("assistant");
  });
  it("preserves message content integrity", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "exec", arguments: {} }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: [{ type: "text", text: "second" }], timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 4,
      },
    ];
    const limited = limitHistoryTurns(messages, 1);
    // Now includes task goal + last 1 user turn = 3 messages
    expect(limited.length).toBe(3);
    // First message is task goal with marker
    const firstMsg = limited[0];
    if ("content" in firstMsg && Array.isArray(firstMsg.content)) {
      const firstContent = firstMsg.content[0];
      const secondContent = firstMsg.content[1];
      if (firstContent && "text" in firstContent) {
        expect(firstContent.text).toContain("任务目标");
      }
      if (secondContent && "text" in secondContent) {
        expect(secondContent.text).toBe("first");
      }
    }
    // Rest are the last user turn
    const secondMsg = limited[1];
    const thirdMsg = limited[2];
    if ("content" in secondMsg && Array.isArray(secondMsg.content)) {
      expect(secondMsg.content).toEqual([{ type: "text", text: "second" }]);
    }
    if ("content" in thirdMsg && Array.isArray(thirdMsg.content)) {
      expect(thirdMsg.content).toEqual([{ type: "text", text: "response" }]);
    }
  });

  it("preserves task goal (first user message) when history is limited", () => {
    const messages = makeMessages([
      "user",      // 0: task goal
      "assistant", // 1
      "user",      // 2
      "assistant", // 3
      "user",      // 4
      "assistant", // 5
      "user",      // 6
      "assistant", // 7
    ]);
    
    // Limit to last 2 user turns (should be messages 4-7)
    const limited = limitHistoryTurns(messages, 2);
    
    // Should have: task goal + last 2 user turns + their responses = 5 messages
    expect(limited.length).toBe(5);
    
    // First message should be task goal with marker
    expect(limited[0].role).toBe("user");
    const firstMsg = limited[0];
    if ("content" in firstMsg && Array.isArray(firstMsg.content)) {
      const firstContent = firstMsg.content[0];
      const secondContent = firstMsg.content[1];
      if (firstContent && "text" in firstContent) {
        expect(firstContent.text).toContain("任务目标");
      }
      if (secondContent && "text" in secondContent) {
        expect(secondContent.text).toBe("message 0");
      }
    }
    
    // Rest should be the last 2 user turns
    const msg1 = limited[1];
    const msg2 = limited[2];
    const msg3 = limited[3];
    const msg4 = limited[4];
    if ("content" in msg1 && Array.isArray(msg1.content)) {
      expect(msg1.content).toEqual([{ type: "text", text: "message 4" }]);
    }
    if ("content" in msg2 && Array.isArray(msg2.content)) {
      expect(msg2.content).toEqual([{ type: "text", text: "message 5" }]);
    }
    if ("content" in msg3 && Array.isArray(msg3.content)) {
      expect(msg3.content).toEqual([{ type: "text", text: "message 6" }]);
    }
    if ("content" in msg4 && Array.isArray(msg4.content)) {
      expect(msg4.content).toEqual([{ type: "text", text: "message 7" }]);
    }
  });

  it("does not duplicate task goal if it's already in limited messages", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    
    // Limit to last 2 user turns (all messages)
    const limited = limitHistoryTurns(messages, 2);
    
    // Should not add task goal marker since all messages are kept
    expect(limited.length).toBe(4);
    const firstMsg = limited[0];
    if ("content" in firstMsg) {
      expect(firstMsg.content).toEqual([{ type: "text", text: "message 0" }]);
    }
  });

  it("handles task goal preservation with string content", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "task goal text" as never, timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: [{ type: "text", text: "second" }], timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "response 2" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 4,
      },
    ];
    
    const limited = limitHistoryTurns(messages, 1);
    
    // Should have task goal + last user turn + response = 3 messages
    expect(limited.length).toBe(3);
    expect(limited[0].role).toBe("user");
    const firstMsg = limited[0];
    if ("content" in firstMsg && Array.isArray(firstMsg.content)) {
      const firstContent = firstMsg.content[0];
      if (firstContent && "text" in firstContent) {
        expect(firstContent.text).toContain("任务目标");
      }
    }
  });
});
