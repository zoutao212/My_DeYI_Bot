/**
 * 虚拟世界层 Agent 记忆集成测试
 * 
 * @module agents/virtual-world/agent.memory.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { VirtualWorldAgent } from "./agent.js";
import type { CharacterProfile } from "./character-profiles.js";
import type { LLMProvider } from "./agent.js";
import type { ConversationContext } from "../multi-layer/types.js";
import type { IMemoryService, MemoryRetrievalResult } from "../memory/types.js";

describe("VirtualWorldAgent Memory Integration", () => {
  let mockLLMProvider: LLMProvider;
  let mockMemoryService: IMemoryService;
  let characterProfile: CharacterProfile;

  beforeEach(() => {
    // Mock LLMProvider
    mockLLMProvider = {
      chat: vi.fn().mockResolvedValue("这是角色的回复"),
    } as any;

    // Mock MemoryService
    mockMemoryService = {
      retrieve: vi.fn().mockResolvedValue({
        memories: [
          {
            path: "memory/character/test.md",
            snippet: "主人喜欢喝咖啡",
            score: 0.85,
            source: "memory",
            startLine: 1,
            endLine: 5,
          },
          {
            path: "memory/technical/config.md",
            snippet: "系统配置文件路径：/etc/config",
            score: 0.75,
            source: "memory",
            startLine: 10,
            endLine: 15,
          },
        ],
        formattedContext: "## 相关记忆\n\n主人喜欢喝咖啡\n系统配置文件路径：/etc/config",
        durationMs: 100,
      } as MemoryRetrievalResult),
      archive: vi.fn(),
      status: vi.fn().mockReturnValue({
        enabled: true,
        retrieval: { enabled: true, available: true },
        archival: { enabled: true, available: true },
      }),
    };

    // Character profile
    characterProfile = {
      name: "丽丝",
      description: "主人的虚拟女友",
      personality: ["温柔", "体贴", "善解人意"],
      background: "一个温柔的虚拟女友",
      worldView: "只关心主人的情感和生活",
      restrictions: [
        "不知道任何技术细节",
        "不能执行技术操作",
        "不能访问系统文件",
      ],
    };
  });

  describe("Memory Retrieval Integration", () => {
    it("should retrieve memories when handling message", async () => {
      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "你还记得我喜欢什么吗？" },
        ],
      };

      await agent.handleMessage("你还记得我喜欢什么吗？", context);

      // Verify memory retrieval was called
      expect(mockMemoryService.retrieve).toHaveBeenCalledWith({
        query: "你还记得我喜欢什么吗？",
        context: {
          userId: "test-user",
          sessionId: "test-session",
          layer: "virtual-world",
        },
      });
    });

    it("should filter technical details from memories", async () => {
      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "聊聊天吧" },
        ],
      };

      await agent.handleMessage("聊聊天吧", context);

      // Verify LLM was called
      expect(mockLLMProvider.chat).toHaveBeenCalled();

      // Get the system prompt passed to LLM
      const chatCall = (mockLLMProvider.chat as any).mock.calls[0][0];
      const systemPrompt = chatCall.systemPrompt;

      // System prompt should contain character profile
      expect(systemPrompt).toContain("丽丝");
      expect(systemPrompt).toContain("温柔");

      // System prompt should contain filtered memories (role-appropriate)
      // Technical details should be filtered out
      expect(systemPrompt).toContain("主人喜欢喝咖啡");
      expect(systemPrompt).not.toContain("系统配置文件");
      expect(systemPrompt).not.toContain("/etc/config");
    });

    it("should handle memory retrieval failure gracefully", async () => {
      // Mock retrieval failure
      mockMemoryService.retrieve = vi.fn().mockRejectedValue(new Error("Retrieval failed"));

      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
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
      const result = await agent.handleMessage("test message", context);

      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should skip memory retrieval when no memory service is provided", async () => {
      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
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

      const result = await agent.handleMessage("test message", context);

      // Should still work without memory service
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("Memory Formatting", () => {
    it("should format memories from role perspective", async () => {
      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "你还记得吗？" },
        ],
      };

      await agent.handleMessage("你还记得吗？", context);

      // Verify LLM was called with formatted memories
      expect(mockLLMProvider.chat).toHaveBeenCalled();

      const chatCall = (mockLLMProvider.chat as any).mock.calls[0][0];
      const systemPrompt = chatCall.systemPrompt;

      // Memories should be formatted for role
      expect(systemPrompt).toContain("记得");
      expect(systemPrompt).toContain("主人");
    });

    it("should not include empty memory context when no memories found", async () => {
      // Mock empty retrieval result
      mockMemoryService.retrieve = vi.fn().mockResolvedValue({
        memories: [],
        formattedContext: "",
        durationMs: 50,
      } as MemoryRetrievalResult);

      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
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

      await agent.handleMessage("test message", context);

      // Verify LLM was called
      expect(mockLLMProvider.chat).toHaveBeenCalled();

      const chatCall = (mockLLMProvider.chat as any).mock.calls[0][0];
      const systemPrompt = chatCall.systemPrompt;

      // System prompt should only contain character profile (no memory section)
      expect(systemPrompt).toContain("丽丝");
      expect(systemPrompt).not.toContain("相关记忆");
    });
  });

  describe("Technical Details Filtering", () => {
    it("should filter out file paths from memories", async () => {
      mockMemoryService.retrieve = vi.fn().mockResolvedValue({
        memories: [
          {
            path: "memory/test.md",
            snippet: "文件路径：/home/user/project/src/main.ts",
            score: 0.8,
            source: "memory",
            startLine: 1,
            endLine: 5,
          },
        ],
        formattedContext: "文件路径：/home/user/project/src/main.ts",
        durationMs: 100,
      } as MemoryRetrievalResult);

      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test" },
        ],
      };

      await agent.handleMessage("test", context);

      const chatCall = (mockLLMProvider.chat as any).mock.calls[0][0];
      const systemPrompt = chatCall.systemPrompt;

      // File paths should be filtered out
      expect(systemPrompt).not.toContain("/home/user/project");
      expect(systemPrompt).not.toContain("src/main.ts");
    });

    it("should filter out command syntax from memories", async () => {
      mockMemoryService.retrieve = vi.fn().mockResolvedValue({
        memories: [
          {
            path: "memory/test.md",
            snippet: "执行命令：npm run build",
            score: 0.8,
            source: "memory",
            startLine: 1,
            endLine: 5,
          },
        ],
        formattedContext: "执行命令：npm run build",
        durationMs: 100,
      } as MemoryRetrievalResult);

      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test" },
        ],
      };

      await agent.handleMessage("test", context);

      const chatCall = (mockLLMProvider.chat as any).mock.calls[0][0];
      const systemPrompt = chatCall.systemPrompt;

      // Command syntax should be filtered out
      expect(systemPrompt).not.toContain("npm run build");
      expect(systemPrompt).not.toContain("执行命令");
    });

    it("should keep emotional and personal memories", async () => {
      mockMemoryService.retrieve = vi.fn().mockResolvedValue({
        memories: [
          {
            path: "memory/test.md",
            snippet: "主人今天心情很好，我们一起聊了很久",
            score: 0.9,
            source: "memory",
            startLine: 1,
            endLine: 5,
          },
        ],
        formattedContext: "主人今天心情很好，我们一起聊了很久",
        durationMs: 100,
      } as MemoryRetrievalResult);

      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
        mockLLMProvider,
        mockMemoryService,
      );

      const context: ConversationContext = {
        userId: "test-user",
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test" },
        ],
      };

      await agent.handleMessage("test", context);

      const chatCall = (mockLLMProvider.chat as any).mock.calls[0][0];
      const systemPrompt = chatCall.systemPrompt;

      // Emotional memories should be kept
      expect(systemPrompt).toContain("主人今天心情很好");
      expect(systemPrompt).toContain("一起聊了很久");
    });
  });

  describe("Error Handling", () => {
    it("should continue conversation even if memory retrieval fails", async () => {
      mockMemoryService.retrieve = vi.fn().mockRejectedValue(new Error("Retrieval error"));

      const agent = new VirtualWorldAgent(
        "丽丝",
        characterProfile,
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
      expect(result).toBe("这是角色的回复");
    });
  });
});
