/**
 * 工具调用执行守卫测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectPseudoToolCall,
  verifyFileWrite,
  withRetry,
  recordToolCallMetric,
  getToolCallStats,
  clearToolCallHistory,
} from "./tool-execution-guard.js";

describe("tool-execution-guard", () => {
  describe("detectPseudoToolCall", () => {
    it("不检测 Historical context 引用性文本", () => {
      const text = `[Historical context: a different model called tool "write" with arguments: {"path": "test.md", "content": "hello"}. Do not mimic this format.]Successfully wrote 100 bytes.`;
      
      const result = detectPseudoToolCall(text);
      
      // Historical context 是引用性文本，不应被当作伪工具调用
      // "Successfully wrote 100 bytes." 没有路径，也不匹配伪成功消息模式
      expect(result.detected).toBe(false);
    });

    it("不检测 Historical context 引用性文本（exec 工具）", () => {
      const text = `[Historical context: a different model called tool "exec" with arguments: {
  "command": "Get-ChildItem -Path . -Filter \\"*.txt\\" -Recurse"
}. Do not mimic this format - use proper function calling.]`;
      
      const result = detectPseudoToolCall(text);
      
      expect(result.detected).toBe(false);
    });

    it("检测 Historical context 后跟完整伪成功消息", () => {
      const text = `[Historical context: ...]Successfully wrote 1276 bytes to characters/lina/memory/core-memories.md`;
      
      const result = detectPseudoToolCall(text);
      
      // 伪成功消息模式仍应被检测
      expect(result.detected).toBe(true);
      expect(result.toolName).toBe("write");
      expect(result.args?.path).toBe("characters/lina/memory/core-memories.md");
    });

    it("检测伪成功消息", () => {
      const text = "Successfully wrote 1276 bytes to characters/lina/memory/core-memories.md";
      
      const result = detectPseudoToolCall(text);
      
      expect(result.detected).toBe(true);
      expect(result.toolName).toBe("write");
      expect(result.args?.path).toBe("characters/lina/memory/core-memories.md");
    });

    it("不检测正常文本", () => {
      const text = "这是一段正常的文本，没有工具调用。";
      
      const result = detectPseudoToolCall(text);
      
      expect(result.detected).toBe(false);
    });

    it("不检测真正的代码示例", () => {
      const text = `
\`\`\`python
def write_file():
    with open("test.txt", "w") as f:
        f.write("hello")
\`\`\`
      `;
      
      const result = detectPseudoToolCall(text);
      
      expect(result.detected).toBe(false);
    });
  });

  describe("verifyFileWrite", () => {
    const testDir = join(tmpdir(), "tool-guard-test-" + Date.now());
    
    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
    });
    
    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it("验证成功写入的文件", async () => {
      const filePath = join(testDir, "test.txt");
      const content = "Hello, World!";
      await writeFile(filePath, content);
      
      const result = await verifyFileWrite({
        filePath,
        expectedContent: content,
      });
      
      expect(result.verified).toBe(true);
    });

    it("检测不存在的文件", async () => {
      const result = await verifyFileWrite({
        filePath: join(testDir, "nonexistent.txt"),
      });
      
      expect(result.verified).toBe(false);
      expect(result.reason).toContain("文件不存在");
    });

    it("检测内容不匹配", async () => {
      const filePath = join(testDir, "test.txt");
      await writeFile(filePath, "actual content");
      
      const result = await verifyFileWrite({
        filePath,
        expectedContent: "expected content",
      });
      
      expect(result.verified).toBe(false);
      expect(result.reason).toContain("内容不匹配");
    });

    it("检测文件大小不足", async () => {
      const filePath = join(testDir, "small.txt");
      await writeFile(filePath, "hi");
      
      const result = await verifyFileWrite({
        filePath,
        expectedMinBytes: 100,
      });
      
      expect(result.verified).toBe(false);
      expect(result.reason).toContain("文件大小不符");
    });
  });

  describe("withRetry", () => {
    it("成功时不重试", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      
      const result = await withRetry(fn, { maxRetries: 3, delayMs: 10 });
      
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("失败后重试直到成功", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ code: "EBUSY" })
        .mockRejectedValueOnce({ code: "EBUSY" })
        .mockResolvedValue("success");
      
      const result = await withRetry(fn, { maxRetries: 3, delayMs: 10 });
      
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("超过重试次数后抛出错误", async () => {
      const error = { code: "EBUSY" };
      const fn = vi.fn().mockRejectedValue(error);
      
      await expect(withRetry(fn, { maxRetries: 2, delayMs: 10 })).rejects.toEqual(error);
      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it("不可重试的错误立即抛出", async () => {
      const error = { code: "ENOENT" };
      const fn = vi.fn().mockRejectedValue(error);
      
      await expect(withRetry(fn, { maxRetries: 3, delayMs: 10 })).rejects.toEqual(error);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("工具调用指标", () => {
    beforeEach(() => {
      clearToolCallHistory();
    });

    it("记录和统计工具调用", () => {
      recordToolCallMetric({
        toolName: "write",
        startTime: Date.now() - 100,
        endTime: Date.now(),
        durationMs: 100,
        success: true,
        verified: true,
      });
      
      recordToolCallMetric({
        toolName: "write",
        startTime: Date.now() - 200,
        endTime: Date.now(),
        durationMs: 200,
        success: false,
        error: "文件不存在",
      });
      
      recordToolCallMetric({
        toolName: "read",
        startTime: Date.now() - 50,
        endTime: Date.now(),
        durationMs: 50,
        success: true,
      });
      
      const stats = getToolCallStats();
      
      expect(stats.totalCalls).toBe(3);
      expect(stats.successRate).toBeCloseTo(2 / 3);
      expect(stats.byTool.write.calls).toBe(2);
      expect(stats.byTool.read.calls).toBe(1);
    });
  });
});

