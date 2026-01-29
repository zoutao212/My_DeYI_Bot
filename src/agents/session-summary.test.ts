import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { formatSessionSummary, generateSessionSummary } from "./session-summary.js";

describe("session-summary", () => {
  describe("generateSessionSummary", () => {
    it("should return null for empty messages", () => {
      const summary = generateSessionSummary([]);
      expect(summary).toBeNull();
    });

    it("should extract task goal from first user message", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "写一个角色卡" }],
        },
      ];

      const summary = generateSessionSummary(messages);
      expect(summary).not.toBeNull();
      expect(summary?.taskGoal).toContain("角色卡");
    });

    it("should extract key actions from tool calls", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "写一个文件" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "好的" }],
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: { name: "write", arguments: "{}" },
            },
          ],
        },
      ];

      const summary = generateSessionSummary(messages);
      expect(summary?.keyActions).toContain("write");
    });

    it("should extract key decisions from assistant messages", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "写一个角色卡" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "好的，我决定使用 Markdown 格式来创建角色卡。" }],
        },
      ];

      const summary = generateSessionSummary(messages);
      expect(summary?.keyDecisions).toContain("好的，我决定使用 Markdown 格式来创建角色卡");
    });

    it("should extract blockers from tool results", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "读取文件" }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "error: file not found" }],
        },
      ];

      const summary = generateSessionSummary(messages);
      expect(summary?.blockers).toContain("error: file not found");
    });

    it("should count total user turns", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "第一条消息" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "回复" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "第二条消息" }],
        },
      ];

      const summary = generateSessionSummary(messages);
      expect(summary?.totalTurns).toBe(2);
    });

    it("should deduplicate key actions", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "写文件" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "好的" }],
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: { name: "write", arguments: "{}" },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "再写一个" }],
          tool_calls: [
            {
              id: "2",
              type: "function",
              function: { name: "write", arguments: "{}" },
            },
          ],
        },
      ];

      const summary = generateSessionSummary(messages);
      expect(summary?.keyActions).toEqual(["write"]);
    });

    it("should limit key actions to 10", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "执行多个操作" }],
        },
      ];

      // Add 15 different tool calls
      for (let i = 0; i < 15; i++) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "执行" }],
          tool_calls: [
            {
              id: `${i}`,
              type: "function",
              function: { name: `tool_${i}`, arguments: "{}" },
            },
          ],
        });
      }

      const summary = generateSessionSummary(messages);
      expect(summary?.keyActions.length).toBe(10);
    });

    it("should limit key decisions to 5", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "做决策" }],
        },
      ];

      // Add 10 decision messages
      for (let i = 0; i < 10; i++) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: `我决定采用方案 ${i}。这是一个很好的选择。` }],
        });
      }

      const summary = generateSessionSummary(messages);
      expect(summary?.keyDecisions.length).toBe(5);
    });

    it("should limit blockers to 3", () => {
      const messages: AgentMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "执行操作" }],
        },
      ];

      // Add 5 error messages
      for (let i = 0; i < 5; i++) {
        messages.push({
          role: "toolResult",
          content: [{ type: "text", text: `error: operation ${i} failed` }],
        });
      }

      const summary = generateSessionSummary(messages);
      expect(summary?.blockers.length).toBe(3);
    });
  });

  describe("formatSessionSummary", () => {
    it("should format summary with all sections", () => {
      const summary = {
        taskGoal: "写一个角色卡",
        keyActions: ["write", "read"],
        keyDecisions: ["使用 Markdown 格式"],
        blockers: ["error: file not found"],
        totalTurns: 3,
        createdAt: Date.now(),
      };

      const formatted = formatSessionSummary(summary);

      expect(formatted).toContain("## 会话上下文（Session Context）");
      expect(formatted).toContain("**任务目标**：写一个角色卡");
      expect(formatted).toContain("**对话轮数**：3 轮");
      expect(formatted).toContain("**已执行操作**：");
      expect(formatted).toContain("- write");
      expect(formatted).toContain("- read");
      expect(formatted).toContain("**关键决策**：");
      expect(formatted).toContain("1. 使用 Markdown 格式");
      expect(formatted).toContain("**遇到的问题**：");
      expect(formatted).toContain("1. error: file not found");
    });

    it("should format summary without optional sections", () => {
      const summary = {
        taskGoal: "简单任务",
        keyActions: [],
        keyDecisions: [],
        blockers: [],
        totalTurns: 1,
        createdAt: Date.now(),
      };

      const formatted = formatSessionSummary(summary);

      expect(formatted).toContain("## 会话上下文（Session Context）");
      expect(formatted).toContain("**任务目标**：简单任务");
      expect(formatted).toContain("**对话轮数**：1 轮");
      expect(formatted).not.toContain("**已执行操作**：");
      expect(formatted).not.toContain("**关键决策**：");
      expect(formatted).not.toContain("**遇到的问题**：");
    });
  });
});
