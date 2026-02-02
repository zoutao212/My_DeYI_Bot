/**
 * 记忆归档器单元测试
 * 
 * @module agents/memory/archiver.test
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { MemoryArchiver } from "./archiver.js";
import type { MemoryServiceConfig, MemoryArchivalRequest } from "./types.js";
import type { SessionSummary } from "../session-summary.js";

describe("MemoryArchiver", () => {
  const testDir = join(process.cwd(), "test-memory-archive");
  
  const defaultConfig: MemoryServiceConfig = {
    retrieval: {
      maxResults: 5,
      minScore: 0.7,
      sources: ["memory", "sessions"],
      timeoutMs: 5000,
    },
    archival: {
      strategy: "always",
      path: testDir,
      format: "markdown",
      frequency: 5,
    },
  };

  const testSummary: SessionSummary = {
    taskGoal: "测试任务目标",
    keyActions: ["action1", "action2"],
    keyDecisions: ["决策1", "决策2"],
    blockers: ["问题1"],
    totalTurns: 5,
    createdAt: new Date("2026-01-31T10:00:00Z").getTime(),
    progress: {
      completed: 3,
      total: 5,
      percentage: 60,
    },
    nextSteps: ["下一步1", "下一步2"],
    keyFiles: ["file1.ts", "file2.ts"],
  };

  beforeEach(async () => {
    // 清理测试目录
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // 忽略错误
    }
  });

  afterEach(async () => {
    // 清理测试目录
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // 忽略错误
    }
  });

  describe("archive", () => {
    it("should archive session summary in markdown format", async () => {
      const archiver = new MemoryArchiver(defaultConfig);
      
      const request: MemoryArchivalRequest = {
        summary: testSummary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await archiver.archive(request);

      expect(result.success).toBe(true);
      expect(result.path).toContain("2026-01-31");
      expect(result.path).toContain("test-session.md");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // 验证文件存在
      const content = await fs.readFile(result.path, "utf-8");
      expect(content).toContain("# 会话总结 - test-session");
      expect(content).toContain("测试任务目标");
      expect(content).toContain("action1");
      expect(content).toContain("决策1");
      expect(content).toContain("问题1");
      expect(content).toContain("3/5 (60%)");
      expect(content).toContain("下一步1");
      expect(content).toContain("file1.ts");
    });

    it("should archive session summary in json format", async () => {
      const config: MemoryServiceConfig = {
        ...defaultConfig,
        archival: {
          ...defaultConfig.archival,
          format: "json",
        },
      };
      
      const archiver = new MemoryArchiver(config);
      
      const request: MemoryArchivalRequest = {
        summary: testSummary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await archiver.archive(request);

      expect(result.success).toBe(true);
      expect(result.path).toContain("test-session.json");

      // 验证文件内容
      const content = await fs.readFile(result.path, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.taskGoal).toBe("测试任务目标");
      expect(parsed.userId).toBe("test-user");
      expect(parsed.sessionId).toBe("test-session");
    });

    it("should respect custom archive path", async () => {
      const archiver = new MemoryArchiver(defaultConfig);
      
      const customPath = join(testDir, "custom");
      const request: MemoryArchivalRequest = {
        summary: testSummary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
        params: {
          path: customPath,
        },
      };

      const result = await archiver.archive(request);

      expect(result.success).toBe(true);
      expect(result.path).toContain("custom");
    });

    it("should handle archival errors gracefully", async () => {
      const config: MemoryServiceConfig = {
        ...defaultConfig,
        archival: {
          ...defaultConfig.archival,
          path: "/invalid/path/that/does/not/exist",
        },
      };
      
      const archiver = new MemoryArchiver(config);
      
      const request: MemoryArchivalRequest = {
        summary: testSummary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await archiver.archive(request);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.path).toBe("");
    });
  });

  describe("shouldArchive", () => {
    it("should always archive with 'always' strategy", async () => {
      const config: MemoryServiceConfig = {
        ...defaultConfig,
        archival: {
          ...defaultConfig.archival,
          strategy: "always",
        },
      };
      
      const archiver = new MemoryArchiver(config);
      
      const request: MemoryArchivalRequest = {
        summary: { ...testSummary, totalTurns: 1 },
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await archiver.archive(request);
      expect(result.success).toBe(true);
      expect(result.path).not.toBe("");
    });

    it("should not archive with 'on-demand' strategy", async () => {
      const config: MemoryServiceConfig = {
        ...defaultConfig,
        archival: {
          ...defaultConfig.archival,
          strategy: "on-demand",
        },
      };
      
      const archiver = new MemoryArchiver(config);
      
      const request: MemoryArchivalRequest = {
        summary: testSummary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await archiver.archive(request);
      expect(result.success).toBe(true);
      expect(result.path).toBe("");
    });

    it("should archive only when threshold is met", async () => {
      const config: MemoryServiceConfig = {
        ...defaultConfig,
        archival: {
          ...defaultConfig.archival,
          strategy: "threshold",
          frequency: 5,
        },
      };
      
      const archiver = new MemoryArchiver(config);

      // 未达到阈值
      const request1: MemoryArchivalRequest = {
        summary: { ...testSummary, totalTurns: 3 },
        context: {
          userId: "test-user",
          sessionId: "test-session-1",
        },
      };

      const result1 = await archiver.archive(request1);
      expect(result1.success).toBe(true);
      expect(result1.path).toBe("");

      // 达到阈值
      const request2: MemoryArchivalRequest = {
        summary: { ...testSummary, totalTurns: 5 },
        context: {
          userId: "test-user",
          sessionId: "test-session-2",
        },
      };

      const result2 = await archiver.archive(request2);
      expect(result2.success).toBe(true);
      expect(result2.path).not.toBe("");
    });
  });

  describe("formatSummary", () => {
    it("should format summary with all fields", async () => {
      const archiver = new MemoryArchiver(defaultConfig);
      
      const request: MemoryArchivalRequest = {
        summary: testSummary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await archiver.archive(request);
      const content = await fs.readFile(result.path, "utf-8");

      // 验证所有字段都被包含
      expect(content).toContain("任务目标");
      expect(content).toContain("关键操作");
      expect(content).toContain("关键决策");
      expect(content).toContain("遇到的问题");
      expect(content).toContain("进度");
      expect(content).toContain("下一步计划");
      expect(content).toContain("关键文件");
    });

    it("should format summary without optional fields", async () => {
      const archiver = new MemoryArchiver(defaultConfig);
      
      const minimalSummary: SessionSummary = {
        taskGoal: "最小任务",
        keyActions: [],
        keyDecisions: [],
        blockers: [],
        totalTurns: 1,
        createdAt: Date.now(),
      };

      const request: MemoryArchivalRequest = {
        summary: minimalSummary,
        context: {
          userId: "test-user",
          sessionId: "test-session",
        },
      };

      const result = await archiver.archive(request);
      const content = await fs.readFile(result.path, "utf-8");

      // 验证基本字段存在
      expect(content).toContain("任务目标");
      expect(content).toContain("最小任务");
      
      // 验证可选字段不存在
      expect(content).not.toContain("关键操作");
      expect(content).not.toContain("进度");
    });
  });
});
