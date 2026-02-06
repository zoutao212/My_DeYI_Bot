/**
 * BatchExecutor 单元测试
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BatchExecutor, type LLMCaller } from "./batch-executor.js";
import type { TaskBatch, SubTask } from "./types.js";

describe("BatchExecutor", () => {
  let mockLLMCaller: LLMCaller;
  let batchExecutor: BatchExecutor;

  beforeEach(() => {
    // 创建模拟的 LLM 调用器
    mockLLMCaller = {
      call: vi.fn(),
    };

    batchExecutor = new BatchExecutor(mockLLMCaller);
  });

  describe("mergePrompts", () => {
    it("应该正确合并多个任务的 prompt", () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "写一篇关于 AI 的文章",
            summary: "AI 文章",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "写一篇关于区块链的文章",
            summary: "区块链文章",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      const mergedPrompt = batchExecutor.mergePrompts(batch);

      // 验证包含任务数量
      expect(mergedPrompt).toContain("2 个任务");

      // 验证包含分隔符说明
      expect(mergedPrompt).toContain("---TASK-SEPARATOR---");

      // 验证包含每个任务的 prompt
      expect(mergedPrompt).toContain("写一篇关于 AI 的文章");
      expect(mergedPrompt).toContain("写一篇关于区块链的文章");

      // 验证包含任务 ID
      expect(mergedPrompt).toContain("task_1");
      expect(mergedPrompt).toContain("task_2");
    });

    it("应该支持自定义分隔符", () => {
      const customExecutor = new BatchExecutor(mockLLMCaller, {
        separator: "===CUSTOM-SEP===",
      });

      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 500,
        createdAt: Date.now(),
      };

      const mergedPrompt = customExecutor.mergePrompts(batch);

      expect(mergedPrompt).toContain("===CUSTOM-SEP===");
      expect(mergedPrompt).not.toContain("---TASK-SEPARATOR---");
    });
  });

  describe("splitOutput", () => {
    it("应该正确拆分 LLM 输出", () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "任务 2",
            summary: "任务 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_3",
            prompt: "任务 3",
            summary: "任务 3",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1500,
        createdAt: Date.now(),
      };

      const llmOutput = `这是任务 1 的输出内容。
包含多行文本。

---TASK-SEPARATOR---

这是任务 2 的输出内容。
也包含多行文本。

---TASK-SEPARATOR---

这是任务 3 的输出内容。
同样包含多行文本。`;

      const outputs = batchExecutor.splitOutput(llmOutput, batch);

      expect(outputs.size).toBe(3);
      expect(outputs.get("task_1")).toContain("任务 1 的输出内容");
      expect(outputs.get("task_2")).toContain("任务 2 的输出内容");
      expect(outputs.get("task_3")).toContain("任务 3 的输出内容");
    });

    it("应该正确处理首尾空白", () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "任务 2",
            summary: "任务 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      const llmOutput = `
      
      任务 1 的输出
      
      ---TASK-SEPARATOR---
      
      任务 2 的输出
      
      `;

      const outputs = batchExecutor.splitOutput(llmOutput, batch);

      expect(outputs.size).toBe(2);
      expect(outputs.get("task_1")).toBe("任务 1 的输出");
      expect(outputs.get("task_2")).toBe("任务 2 的输出");
    });
  });

  describe("fallbackSplit", () => {
    it("应该能识别任务标记（中文）", () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "任务 2",
            summary: "任务 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      const llmOutput = `任务 1：
这是任务 1 的输出内容。

任务 2：
这是任务 2 的输出内容。`;

      const outputs = batchExecutor.fallbackSplit(llmOutput, batch);

      expect(outputs.size).toBe(2);
      expect(outputs.get("task_1")).toContain("任务 1 的输出内容");
      expect(outputs.get("task_2")).toContain("任务 2 的输出内容");
    });

    it("应该能识别任务标记（英文）", () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "Task 1",
            summary: "Task 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "Task 2",
            summary: "Task 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      const llmOutput = `Task 1:
This is the output for task 1.

Task 2:
This is the output for task 2.`;

      const outputs = batchExecutor.fallbackSplit(llmOutput, batch);

      expect(outputs.size).toBe(2);
      expect(outputs.get("task_1")).toContain("output for task 1");
      expect(outputs.get("task_2")).toContain("output for task 2");
    });

    it("应该能识别 Markdown 标题格式", () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "任务 2",
            summary: "任务 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      const llmOutput = `## 任务 1
这是任务 1 的输出内容。

## 任务 2
这是任务 2 的输出内容。`;

      const outputs = batchExecutor.fallbackSplit(llmOutput, batch);

      expect(outputs.size).toBe(2);
      expect(outputs.get("task_1")).toContain("任务 1 的输出内容");
      expect(outputs.get("task_2")).toContain("任务 2 的输出内容");
    });

    it("应该能按长度平均拆分（最后手段）", () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "任务 2",
            summary: "任务 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      // 没有任何标记的输出
      const llmOutput = "这是一段很长的文本，没有任何任务标记。".repeat(50);

      const outputs = batchExecutor.fallbackSplit(llmOutput, batch);

      expect(outputs.size).toBe(2);
      expect(outputs.get("task_1")).toBeTruthy();
      expect(outputs.get("task_2")).toBeTruthy();
    });
  });

  describe("estimateTokens", () => {
    it("应该正确估算中文 tokens", () => {
      const text = "这是一段中文文本，包含二十个汉字。";
      const tokens = batchExecutor.estimateTokens(text);

      // 20 个汉字 * 2 = 40 tokens（大约）
      expect(tokens).toBeGreaterThan(30);
      expect(tokens).toBeLessThan(50);
    });

    it("应该正确估算英文 tokens", () => {
      const text = "This is a sample English text with ten words here.";
      const tokens = batchExecutor.estimateTokens(text);

      // 10 个单词 * 1.3 = 13 tokens（大约）
      expect(tokens).toBeGreaterThan(10);
      expect(tokens).toBeLessThan(20);
    });

    it("应该正确估算中英文混合 tokens", () => {
      const text = "这是中文 and this is English 混合文本。";
      const tokens = batchExecutor.estimateTokens(text);

      // 中文部分：约 10 个汉字 * 2 = 20 tokens
      // 英文部分：约 5 个单词 * 1.3 = 6.5 tokens
      // 总计：约 26.5 tokens
      expect(tokens).toBeGreaterThan(20);
      expect(tokens).toBeLessThan(35);
    });
  });

  describe("executeBatch", () => {
    it("应该成功执行批次", async () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "任务 2",
            summary: "任务 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      const llmOutput = `任务 1 的输出
---TASK-SEPARATOR---
任务 2 的输出`;

      vi.mocked(mockLLMCaller.call).mockResolvedValue(llmOutput);

      const result = await batchExecutor.executeBatch(batch);

      expect(result.success).toBe(true);
      expect(result.batchId).toBe("batch_1");
      expect(result.outputs.size).toBe(2);
      expect(result.outputs.get("task_1")).toContain("任务 1 的输出");
      expect(result.outputs.get("task_2")).toContain("任务 2 的输出");
      expect(result.duration).toBeGreaterThan(0);
      expect(result.actualTokens).toBeGreaterThan(0);
    });

    it("应该在拆分失败时使用后备方法", async () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "任务 2",
            summary: "任务 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      // LLM 忘记使用分隔符，但使用了任务标记
      const llmOutput = `任务 1：
这是任务 1 的输出

任务 2：
这是任务 2 的输出`;

      vi.mocked(mockLLMCaller.call).mockResolvedValue(llmOutput);

      const result = await batchExecutor.executeBatch(batch);

      expect(result.success).toBe(true);
      expect(result.outputs.size).toBe(2);
    });

    it("应该在 LLM 调用失败时返回错误", async () => {
      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 500,
        createdAt: Date.now(),
      };

      vi.mocked(mockLLMCaller.call).mockRejectedValue(new Error("LLM 调用失败"));

      const result = await batchExecutor.executeBatch(batch);

      expect(result.success).toBe(false);
      expect(result.error).toContain("LLM 调用失败");
      expect(result.outputs.size).toBe(0);
    });

    it("应该在超时时返回错误", async () => {
      const shortTimeoutExecutor = new BatchExecutor(mockLLMCaller, {
        timeout: 100, // 100ms 超时
      });

      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 500,
        createdAt: Date.now(),
      };

      // 模拟一个很慢的 LLM 调用
      vi.mocked(mockLLMCaller.call).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("输出"), 200))
      );

      const result = await shortTimeoutExecutor.executeBatch(batch);

      expect(result.success).toBe(false);
      expect(result.error).toContain("超时");
    });

    it("应该在禁用后备拆分时直接失败", async () => {
      const noFallbackExecutor = new BatchExecutor(mockLLMCaller, {
        enableFallbackSplit: false,
      });

      const batch: TaskBatch = {
        id: "batch_1",
        tasks: [
          {
            id: "task_1",
            prompt: "任务 1",
            summary: "任务 1",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
          {
            id: "task_2",
            prompt: "任务 2",
            summary: "任务 2",
            status: "pending",
            retryCount: 0,
            createdAt: Date.now(),
          },
        ],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      // LLM 忘记使用分隔符
      const llmOutput = "任务 1 的输出\n任务 2 的输出";

      vi.mocked(mockLLMCaller.call).mockResolvedValue(llmOutput);

      const result = await noFallbackExecutor.executeBatch(batch);

      expect(result.success).toBe(false);
      expect(result.error).toContain("输出拆分失败");
    });
  });
});
