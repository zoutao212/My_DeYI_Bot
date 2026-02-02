/**
 * 管家层 Agent 记忆集成测试
 * 
 * @module agents/butler/agent.memory.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ButlerAgent } from "./agent.js";
import type { TaskDelegator } from "./task-delegator.js";
import type { LLMProvider, SkillCaller } from "./agent.js";
import type { ConversationContext } from "../multi-layer/types.js";
import type { IMemoryService, MemoryRetrievalResult, MemoryArchivalResult } from "../memory/types.js";

describe("ButlerAgent Memory Integration", () => {
  let mockTaskDelegator: TaskDelegator;
  let mockSkillCaller: SkillCaller;
  let mockLLMProvider: LLMProvider;
  let mockMemoryService: IMemoryService;

  beforeEach(() => {
    // Mock TaskDelegator
    mockTaskDelegator = {
      delegate: vi.fn().mockResolvedValue({
        status: "completed",
        result: { success: true },
      }),
    } as any;

    // Mock SkillCaller
    mockSkillCaller = {
      call: vi.fn().mockResolvedValue({ result: "skill result" }),
    } as any;

    // Mock LLMProvider
    mockLLMProvider = {
      chat: vi.fn().mockResolvedValue(
        JSON.stringify({
          type: "conversation",
          description: "普通对话",
        }),
      ),
    } as any;

    // Mock MemoryService
    mockMemoryService = {
      retrieve: vi.fn().mockResolvedValue({
        memories: [
          {
            path: "memory/test.md",
            snippet: "Test memory content",
            score: 0.85,
            source: "memory",
            startLine: 1,
            endLine: 10,
          },
        ],
        formattedContext: "## 相关记忆\n\nTest memory content",
        durationMs: 100,
      } as MemoryRetrievalResult),
      archive: vi.fn().mockResolvedValue({
        path: "memory/sessions/2026-01-31/test-session.md",
        success: true,
        durationMs: 50,
      } as MemoryArchivalResult),
      status: vi.fn().mockReturnValue({
        enabled: true,
        retrieval: { enabled: true, available: true },
        archival: { enabled: true, available: true },
      }),
    };
  });

  describe("Memory Retrieval Integration", () => {
    it("should retrieve memories before conversation", async () => {
      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "继续之前的任务" },
        ],
      };

      await agent.handleMessage("继续之前的任务", context);

      // Verify memory retrieval was called
      expect(mockMemoryService.retrieve).toHaveBeenCalledWith({
        query: "继续之前的任务",
        context: {
          userId: "test-user",
          sessionId: "test-session",
          layer: "butler",
        },
      });

      // Verify memories were injected into context
      expect((context as any).memories).toBeDefined();
      expect((context as any).memories.length).toBe(1);
      expect((context as any).memoryContext).toContain("相关记忆");
    });

    it("should handle memory retrieval failure gracefully", async () => {
      // Mock retrieval failure
      mockMemoryService.retrieve = vi.fn().mockRejectedValue(new Error("Retrieval failed"));

      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test message" },
        ],
      };

      // Should not throw
      await expect(agent.handleMessage("test message", context)).resolves.toBeDefined();

      // Context should not have memories
      expect((context as any).memories).toBeUndefined();
    });

    it("should skip memory retrieval when no memory service is provided", async () => {
      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        undefined, // No memory service
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test message" },
        ],
      };

      await agent.handleMessage("test message", context);

      // Context should not have memories
      expect((context as any).memories).toBeUndefined();
    });

    it("should skip memory retrieval when message is empty", async () => {
      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [],
      };

      await agent.handleMessage("", context);

      // Memory retrieval should not be called
      expect(mockMemoryService.retrieve).not.toHaveBeenCalled();
    });
  });

  describe("Memory Archival Integration", () => {
    it("should archive session summary after conversation", async () => {
      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "创建一个新项目" },
          { role: "assistant", content: "好的，我来帮你创建项目" },
          { role: "user", content: "添加 README 文件" },
          { role: "assistant", content: "已添加 README 文件" },
        ],
      };

      await agent.handleMessage("完成了吗", context);

      // Wait for async archival
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify archival was called
      expect(mockMemoryService.archive).toHaveBeenCalled();

      const archiveCall = (mockMemoryService.archive as any).mock.calls[0][0];
      expect(archiveCall.context.userId).toBe("test-user");
      expect(archiveCall.context.sessionId).toBe("test-session");
      expect(archiveCall.summary).toBeDefined();
    });

    it("should handle archival failure gracefully", async () => {
      // Mock archival failure
      mockMemoryService.archive = vi.fn().mockRejectedValue(new Error("Archival failed"));

      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test message" },
          { role: "assistant", content: "test response" },
        ],
      };

      // Should not throw
      await expect(agent.handleMessage("test message", context)).resolves.toBeDefined();
    });

    it("should skip archival when no memory service is provided", async () => {
      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        undefined, // No memory service
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test message" },
          { role: "assistant", content: "test response" },
        ],
      };

      await agent.handleMessage("test message", context);

      // Archival should not be called (no memory service)
      // No assertion needed as mockMemoryService is not provided
    });

    it("should skip archival when no summary is generated", async () => {
      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [], // Empty messages, no summary
      };

      await agent.handleMessage("test message", context);

      // Wait for async archival
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Archival should not be called (no summary)
      expect(mockMemoryService.archive).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should continue conversation even if memory retrieval fails", async () => {
      mockMemoryService.retrieve = vi.fn().mockRejectedValue(new Error("Retrieval error"));

      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test message" },
        ],
      };

      const result = await agent.handleMessage("test message", context);

      // Should return a response despite retrieval failure
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should continue conversation even if archival fails", async () => {
      mockMemoryService.archive = vi.fn().mockRejectedValue(new Error("Archival error"));

      const agent = new ButlerAgent(
        mockTaskDelegator,
        mockSkillCaller,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test message" },
          { role: "assistant", content: "test response" },
        ],
      };

      const result = await agent.handleMessage("test message", context);

      // Should return a response despite archival failure
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });
});
