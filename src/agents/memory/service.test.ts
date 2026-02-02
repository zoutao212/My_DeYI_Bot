/**
 * 记忆服务测试
 * 
 * @module agents/memory/service.test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryService, createMemoryService, resolveMemoryServiceConfig } from "./service.js";
import type { MemoryServiceConfig, MemoryRetrievalRequest, MemoryArchivalRequest } from "./types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionSummary } from "../session-summary.js";

describe("MemoryService", () => {
  let config: MemoryServiceConfig;
  let cfg: ClawdbotConfig;

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

    cfg = {
      agents: {
        list: [
          {
            id: "main",
            memory: {
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
            },
          },
        ],
      },
    } as any;
  });

  describe("retrieve", () => {
    it("should return empty result when memory index manager is not available", async () => {
      const service = new MemoryService(config, cfg);

      const request: MemoryRetrievalRequest = {
        query: "test query",
        context: {
          userId: "test-user",
          sessionId: "test-session",
          layer: "butler",
        },
      };

      const result = await service.retrieve(request);

      expect(result.memories).toEqual([]);
      expect(result.formattedContext).toBe("");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle retrieval timeout gracefully", async () => {
      const shortTimeoutConfig: MemoryServiceConfig = {
        ...config,
        retrieval: {
          ...config.retrieval,
          timeoutMs: 1, // 1ms timeout
        },
      };

      const service = new MemoryService(shortTimeoutConfig, cfg);

      const request: MemoryRetrievalRequest = {
        query: "test query",
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await service.retrieve(request);

      // Should return empty result on timeout
      expect(result.memories).toEqual([]);
      expect(result.formattedContext).toBe("");
    });

    it("should use custom retrieval parameters when provided", async () => {
      const service = new MemoryService(config, cfg);

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

      const result = await service.retrieve(request);

      // Should not throw and return valid result structure
      expect(result).toHaveProperty("memories");
      expect(result).toHaveProperty("formattedContext");
      expect(result).toHaveProperty("durationMs");
    });
  });

  describe("archive", () => {
    it("should skip archival when strategy is on-demand", async () => {
      const onDemandConfig: MemoryServiceConfig = {
        ...config,
        archival: {
          ...config.archival,
          strategy: "on-demand",
        },
      };

      const service = new MemoryService(onDemandConfig, cfg);

      const summary: SessionSummary = {
        taskGoal: "Test task",
        keyActions: ["action1"],
        keyDecisions: [],
        blockers: [],
        totalTurns: 3,
        createdAt: Date.now(),
      };

      const request: MemoryArchivalRequest = {
        summary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await service.archive(request);

      expect(result.success).toBe(true);
      expect(result.path).toBe("");
    });

    it("should archive when strategy is always", async () => {
      const alwaysConfig: MemoryServiceConfig = {
        ...config,
        archival: {
          ...config.archival,
          strategy: "always",
        },
      };

      const service = new MemoryService(alwaysConfig, cfg);

      const summary: SessionSummary = {
        taskGoal: "Test task",
        keyActions: ["action1"],
        keyDecisions: [],
        blockers: [],
        totalTurns: 3,
        createdAt: Date.now(),
      };

      const request: MemoryArchivalRequest = {
        summary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await service.archive(request);

      // Should attempt to archive (may fail due to file system, but should not throw)
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("path");
      expect(result).toHaveProperty("durationMs");
    });

    it("should archive when threshold is met", async () => {
      const service = new MemoryService(config, cfg);

      const summary: SessionSummary = {
        taskGoal: "Test task",
        keyActions: ["action1"],
        keyDecisions: [],
        blockers: [],
        totalTurns: 5, // Meets threshold
        createdAt: Date.now(),
      };

      const request: MemoryArchivalRequest = {
        summary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await service.archive(request);

      // Should attempt to archive
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("durationMs");
    });

    it("should skip archival when threshold is not met", async () => {
      const service = new MemoryService(config, cfg);

      const summary: SessionSummary = {
        taskGoal: "Test task",
        keyActions: ["action1"],
        keyDecisions: [],
        blockers: [],
        totalTurns: 3, // Below threshold (5)
        createdAt: Date.now(),
      };

      const request: MemoryArchivalRequest = {
        summary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await service.archive(request);

      expect(result.success).toBe(true);
      expect(result.path).toBe("");
    });
  });

  describe("status", () => {
    it("should return service status", () => {
      const service = new MemoryService(config, cfg);

      const status = service.status();

      expect(status.enabled).toBe(true);
      expect(status.retrieval.enabled).toBe(true);
      expect(status.retrieval.available).toBe(true);
      expect(status.archival.enabled).toBe(true);
      expect(status.archival.available).toBe(true);
    });
  });

  describe("createMemoryService", () => {
    it("should create memory service with valid config", () => {
      const service = createMemoryService(config, cfg);

      expect(service).toBeInstanceOf(MemoryService);
    });

    it("should return null when config is null", () => {
      const service = createMemoryService(null, cfg);

      expect(service).toBeNull();
    });
  });

  describe("resolveMemoryServiceConfig", () => {
    it("should resolve config from Clawdbot config", () => {
      const resolved = resolveMemoryServiceConfig(cfg, "main");

      expect(resolved).not.toBeNull();
      expect(resolved?.retrieval.maxResults).toBe(5);
      expect(resolved?.retrieval.minScore).toBe(0.7);
      expect(resolved?.archival.strategy).toBe("threshold");
      expect(resolved?.archival.frequency).toBe(5);
    });

    it("should return null when agent config is not found", () => {
      const resolved = resolveMemoryServiceConfig(cfg, "non-existent");

      expect(resolved).toBeNull();
    });

    it("should return null when memory config is not present", () => {
      const cfgWithoutMemory: ClawdbotConfig = {
        agents: {
          list: [
            {
              id: "main",
            },
          ],
        },
      } as any;

      const resolved = resolveMemoryServiceConfig(cfgWithoutMemory, "main");

      expect(resolved).toBeNull();
    });

    it("should use default values when config fields are missing", () => {
      const partialCfg: ClawdbotConfig = {
        agents: {
          list: [
            {
              id: "main",
              memory: {
                retrieval: {},
                archival: {},
              },
            },
          ],
        },
      } as any;

      const resolved = resolveMemoryServiceConfig(partialCfg, "main");

      expect(resolved).not.toBeNull();
      expect(resolved?.retrieval.maxResults).toBe(5);
      expect(resolved?.retrieval.minScore).toBe(0.7);
      expect(resolved?.retrieval.sources).toEqual(["memory", "sessions"]);
      expect(resolved?.retrieval.timeoutMs).toBe(5000);
      expect(resolved?.archival.strategy).toBe("threshold");
      expect(resolved?.archival.path).toBe("memory/sessions");
      expect(resolved?.archival.format).toBe("markdown");
      expect(resolved?.archival.frequency).toBe(5);
    });
  });
});
