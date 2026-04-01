/**
 * 消息标准化器测试
 * 
 * 验证 normalizeMessagesForAPI 的核心功能
 */

import { describe, it, expect } from "vitest";
import {
  normalizeMessagesForAPI,
  needsNormalization,
  type AgentMessage,
} from "./message-normalizer.js";

// 辅助函数：创建简单的消息
function createAssistantMessage(toolCalls: Array<{ id: string; name?: string }>): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "I will help you" },
      ...toolCalls.map(tc => ({
        type: "toolCall" as const,
        id: tc.id,
        name: tc.name || "test_tool",
        arguments: {},
      })),
    ],
    timestamp: Date.now(),
  } as any;
}

function createToolResultMessage(toolCallId: string, content: string = "result"): AgentMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content,
    timestamp: Date.now(),
  } as any;
}

function createUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as any;
}

describe("normalizeMessagesForAPI", () => {
  describe("基本功能", () => {
    it("应该保留空消息数组", () => {
      const result = normalizeMessagesForAPI([]);
      expect(result.messages).toEqual([]);
      expect(result.report.changed).toBe(false);
    });

    it("应该保留格式正确的消息", () => {
      const messages: AgentMessage[] = [
        createUserMessage("Hello"),
        createAssistantMessage([]),
      ];

      const result = normalizeMessagesForAPI(messages);
      expect(result.messages.length).toBe(2);
      expect(result.report.changed).toBe(false);
    });
  });

  describe("tool_use 和 tool_result 配对", () => {
    it("应该检测未配对的 tool_use 并添加假结果", () => {
      const messages: AgentMessage[] = [
        createUserMessage("Test"),
        createAssistantMessage([{ id: "call_123", name: "test_tool" }]),
      ];

      const result = normalizeMessagesForAPI(messages, {
        unpairedToolUsePolicy: "add_fake_result"
      });

      expect(result.messages.length).toBe(3); // user + assistant + fake_tool_result
      expect(result.messages[2].role).toBe("tool");
      expect(result.report.addedFakeToolResults).toBe(1);
      expect(result.report.changed).toBe(true);
    });

    it("应该检测并移除孤立的 tool_result", () => {
      const messages: AgentMessage[] = [
        createUserMessage("Test"),
        createToolResultMessage("orphan_id", "orphan result"),
      ];

      const result = normalizeMessagesForAPI(messages, {
        orphanToolResultPolicy: "drop"
      });

      expect(result.messages.length).toBe(1); // only user message
      expect(result.report.droppedOrphanToolResults).toBe(1);
      expect(result.report.changed).toBe(true);
    });

    it("应该检测并移除重复的 tool_result", () => {
      const messages: AgentMessage[] = [
        createUserMessage("Test"),
        createAssistantMessage([{ id: "call_123" }]),
        createToolResultMessage("call_123", "result 1"),
        createToolResultMessage("call_123", "result 2"), // 重复
      ];

      const result = normalizeMessagesForAPI(messages);

      expect(result.messages.length).toBe(3); // user + assistant + first_tool_result
      expect(result.report.droppedDuplicateToolResults).toBe(1);
      expect(result.report.changed).toBe(true);
    });

    it("应该保留正确配对的 tool_use 和 tool_result", () => {
      const messages: AgentMessage[] = [
        createUserMessage("Test"),
        createAssistantMessage([{ id: "call_123" }]),
        createToolResultMessage("call_123"),
      ];

      const result = normalizeMessagesForAPI(messages);
      expect(result.messages.length).toBe(3);
      expect(result.report.changed).toBe(false);
    });
  });

  describe("内容净化", () => {
    it("应该处理 null content", () => {
      const messages: AgentMessage[] = [
        {
          role: "tool",
          tool_call_id: "test",
          content: null,
          timestamp: Date.now(),
        } as any,
      ];

      const result = normalizeMessagesForAPI(messages, {
        sanitizeToolResults: true
      });

      expect(result.messages[0].content).not.toBeNull();
      expect(result.report.sanitizedToolResults).toBe(1);
    });

    it("应该截断过长的内容", () => {
      const longContent = "x".repeat(60000);
      const messages: AgentMessage[] = [
        createToolResultMessage("test", longContent),
      ];

      const result = normalizeMessagesForAPI(messages, {
        sanitizeToolResults: true
      });

      const content = result.messages[0].content as string;
      expect(content.length).toBeLessThan(60000);
      expect(result.report.sanitizedToolResults).toBe(1);
    });
  });

  describe("严格模式", () => {
    it("严格模式下应该抛出错误当发现未配对的 tool_use", () => {
      const messages: AgentMessage[] = [
        createAssistantMessage([{ id: "call_123" }]),
      ];

      expect(() => {
        normalizeMessagesForAPI(messages, {
          strict: true,
          unpairedToolUsePolicy: "error"
        });
      }).toThrow();
    });

    it("严格模式下应该抛出错误当发现孤立的 tool_result", () => {
      const messages: AgentMessage[] = [
        createToolResultMessage("orphan"),
      ];

      expect(() => {
        normalizeMessagesForAPI(messages, {
          strict: true,
          orphanToolResultPolicy: "error"
        });
      }).toThrow();
    });
  });

  describe("复杂场景", () => {
    it("应该处理多个 tool_use 和 tool_result", () => {
      const messages: AgentMessage[] = [
        createUserMessage("Test"),
        createAssistantMessage([
          { id: "call_1" },
          { id: "call_2" },
          { id: "call_3" },
        ]),
        createToolResultMessage("call_1"),
        createToolResultMessage("call_2"),
        // call_3 缺少结果
      ];

      const result = normalizeMessagesForAPI(messages, {
        unpairedToolUsePolicy: "add_fake_result"
      });

      expect(result.messages.length).toBe(5); // user + assistant + 3 tool_results
      expect(result.report.addedFakeToolResults).toBe(1);
    });

    it("应该处理交替的 user/assistant/tool 消息", () => {
      const messages: AgentMessage[] = [
        createUserMessage("Turn 1"),
        createAssistantMessage([{ id: "call_1" }]),
        createToolResultMessage("call_1"),
        createUserMessage("Turn 2"),
        createAssistantMessage([{ id: "call_2" }]),
        createToolResultMessage("call_2"),
      ];

      const result = normalizeMessagesForAPI(messages);
      expect(result.messages.length).toBe(6);
      expect(result.report.changed).toBe(false);
    });
  });
});

describe("needsNormalization", () => {
  it("应该返回 false 对于格式正确的消息", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Test"),
      createAssistantMessage([{ id: "call_123" }]),
      createToolResultMessage("call_123"),
    ];

    expect(needsNormalization(messages)).toBe(false);
  });

  it("应该返回 true 对于未配对的 tool_use", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([{ id: "call_123" }]),
    ];

    expect(needsNormalization(messages)).toBe(true);
  });

  it("应该返回 true 对于孤立的 tool_result", () => {
    const messages: AgentMessage[] = [
      createToolResultMessage("orphan"),
    ];

    expect(needsNormalization(messages)).toBe(true);
  });

  it("应该返回 true 对于重复的 tool_result", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([{ id: "call_123" }]),
      createToolResultMessage("call_123"),
      createToolResultMessage("call_123"), // 重复
    ];

    expect(needsNormalization(messages)).toBe(true);
  });
});