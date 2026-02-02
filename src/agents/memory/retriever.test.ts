/**
 * 记忆检索器单元测试
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRetriever } from "./retriever.js";
import type { MemoryServiceConfig, MemoryRetrievalRequest } from "./types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { MemoryIndexManager } from "../../memory/manager.js";

// Mock MemoryIndexManager
vi.mock("../../memory/manager.js", () => ({
  MemoryIndexManager: {
    get: vi.fn(),
  },
}));

describe("MemoryRetriever", () => {
  let config: MemoryServiceConfig;
  let cfg: ClawdbotConfig;
  let retriever: MemoryRetriever;

  beforeEach(() => {
    config = {
      retrieval: {
        maxResults: 5,
        minScore: 0.7,
        sources: ["memory", "sessions"],
        timeoutMs: 5000,
      },
      archival: {
        strategy: "threshold",
        path: "memory/sessions",
        format: "markdown",
        frequency: 5,
      },
    };

    cfg = {} as ClawdbotConfig;
    retriever = new MemoryRetriever(config, cfg);

    // Reset mocks
    vi.clearAllMocks();
  });

  describe("retrieve", () => {
    it("should retrieve relevant memories", async () => {
      // Mock manager
      const mockManager = {
        search: vi.fn().mockResolvedValue([
          {
            path: "memory/test.md",
            snippet: "Test memory content",
            score: 0.85,
            source: "memory" as const,
            startLine: 1,
            endLine: 10,
          },
        ]),
      };

      vi.mocked(MemoryIndexManager.get).mockResolvedValue(mockManager as any);

      const request: MemoryRetrievalRequest = {
        query: "test query",
        context: {
          userId: "test-user",
          sessionId: "test-session",
          agentId: "main",
        },
      };

      const result = await retriever.retrieve(request);

      expect(result.memories.length).toBe(1);
      expect(result.memories[0].path).toBe("memory/test.md");
      expect(result.memories[0].score).toBe(0.85);
      expect(result.formattedContext).toContain("相关记忆");
      expect(result.formattedContext).toContain("Test memory content");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should return empty result when manager is not available", async () => {
      vi.mocked(MemoryIndexManager.get).mockResolvedValue(null);

      const request: MemoryRetrievalRequest = {
        query: "test query",
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await retriever.retrieve(request);

      expect(result.memories.length).toBe(0);
      expect(result.formattedContext).toBe("");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle retrieval timeout", async () => {
      // Mock manager with slow search
      const mockManager = {
        search: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve([]), 10000); // 10 seconds
            }),
        ),
      };

      vi.mocked(MemoryIndexManager.get).mockResolvedValue(mockManager as any);

      // Use short timeout
      const shortTimeoutRetriever = new MemoryRetriever(
        {
          ...config,
          retrieval: { ...config.retrieval, timeoutMs: 100 },
        },
        cfg,
      );

      const request: MemoryRetrievalRequest = {
        query: "test query",
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await shortTimeoutRetriever.retrieve(request);

      // Should return empty result on timeout
      expect(result.memories.length).toBe(0);
      expect(result.formattedContext).toBe("");
    });

    it("should use custom retrieval parameters", async () => {
      const mockManager = {
        search: vi.fn().mockResolvedValue([]),
      };

      vi.mocked(MemoryIndexManager.get).mockResolvedValue(mockManager as any);

      const request: MemoryRetrievalRequest = {
        query: "test query",
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
        params: {
          maxResults: 10,
          minScore: 0.8,
        },
      };

      await retriever.retrieve(request);

      expect(mockManager.search).toHaveBeenCalledWith("test query", {
        maxResults: 10,
        minScore: 0.8,
        sessionKey: "test-session",
      });
    });

    it("should format multiple memories correctly", async () => {
      const mockManager = {
        search: vi.fn().mockResolvedValue([
          {
            path: "memory/test1.md",
            snippet: "First memory",
            score: 0.9,
            source: "memory" as const,
            startLine: 1,
            endLine: 5,
          },
          {
            path: "memory/test2.md",
            snippet: "Second memory",
            score: 0.8,
            source: "sessions" as const,
            startLine: 10,
            endLine: 20,
          },
        ]),
      };

      vi.mocked(MemoryIndexManager.get).mockResolvedValue(mockManager as any);

      const request: MemoryRetrievalRequest = {
        query: "test query",
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await retriever.retrieve(request);

      expect(result.memories.length).toBe(2);
      expect(result.formattedContext).toContain("记忆 1");
      expect(result.formattedContext).toContain("记忆 2");
      expect(result.formattedContext).toContain("First memory");
      expect(result.formattedContext).toContain("Second memory");
      expect(result.formattedContext).toContain("相关性: 90%");
      expect(result.formattedContext).toContain("相关性: 80%");
    });

    it("should handle search errors gracefully", async () => {
      const mockManager = {
        search: vi.fn().mockRejectedValue(new Error("Search failed")),
      };

      vi.mocked(MemoryIndexManager.get).mockResolvedValue(mockManager as any);

      const request: MemoryRetrievalRequest = {
        query: "test query",
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await retriever.retrieve(request);

      // Should return empty result on error
      expect(result.memories.length).toBe(0);
      expect(result.formattedContext).toBe("");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
