/**
 * Orchestrator 单元测试
 * 
 * 测试批量执行功能的集成
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { TaskTree, SubTask, TaskBatch } from "./types.js";
import type { LLMCaller } from "./batch-executor.js";

describe("Orchestrator - 批量执行功能", () => {
  let orchestrator: Orchestrator;
  let mockLLMCaller: LLMCaller;
  let taskTree: TaskTree;

  beforeEach(() => {
    // 创建 mock LLM 调用器
    mockLLMCaller = {
      call: vi.fn(async (prompt: string) => {
        // 模拟 LLM 响应（使用分隔符分隔多个任务的输出）
        return `任务 1 的输出内容
---TASK-SEPARATOR---
任务 2 的输出内容
---TASK-SEPARATOR---
任务 3 的输出内容`;
      }),
    };

    // 创建 Orchestrator 实例
    orchestrator = new Orchestrator(
      {
        maxTasksPerBatch: 5,
        maxTokensPerBatch: 6000,
      },
      {
        separator: "---TASK-SEPARATOR---",
      },
      mockLLMCaller
    );

    // 创建测试任务树
    taskTree = {
      id: "test-session",
      rootTask: "测试根任务",
      subTasks: [],
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      checkpoints: [],
    };
  });

  describe("setLLMCaller", () => {
    it("应该正确设置 LLM 调用器", () => {
      const newOrchestrator = new Orchestrator();
      
      // 初始状态下，批量执行器未初始化
      expect(() => {
        newOrchestrator.executeBatches(taskTree, []);
      }).rejects.toThrow("批量执行器未初始化");

      // 设置 LLM 调用器后，应该可以使用批量执行功能
      newOrchestrator.setLLMCaller(mockLLMCaller);
      
      // 不应该再抛出错误
      expect(async () => {
        await newOrchestrator.executeBatches(taskTree, []);
      }).not.toThrow();
    });
  });

  describe("getExecutableTasks", () => {
    it("应该返回可执行的任务列表（不启用批量执行）", async () => {
      // 添加一些测试任务
      const task1 = await orchestrator.addSubTask(
        taskTree,
        "任务 1 的 prompt",
        "任务 1"
      );
      const task2 = await orchestrator.addSubTask(
        taskTree,
        "任务 2 的 prompt",
        "任务 2"
      );
      const task3 = await orchestrator.addSubTask(
        taskTree,
        "任务 3 的 prompt",
        "任务 3"
      );

      // 获取可执行任务（不启用批量执行）
      const executableTasks = orchestrator.getExecutableTasks(taskTree, false);

      // 应该返回所有 pending 状态的任务
      expect(executableTasks).toHaveLength(3);
      expect(executableTasks.map(t => t.id)).toEqual([task1.id, task2.id, task3.id]);

      // 任务树中不应该有批次
      expect(taskTree.batches).toBeUndefined();
    });

    it("应该返回可执行的任务列表（启用批量执行）", async () => {
      // 添加一些测试任务
      const task1 = await orchestrator.addSubTask(
        taskTree,
        "任务 1 的 prompt",
        "任务 1"
      );
      const task2 = await orchestrator.addSubTask(
        taskTree,
        "任务 2 的 prompt",
        "任务 2"
      );
      const task3 = await orchestrator.addSubTask(
        taskTree,
        "任务 3 的 prompt",
        "任务 3"
      );

      // 获取可执行任务（启用批量执行）
      const executableTasks = orchestrator.getExecutableTasks(taskTree, true);

      // 应该返回所有 pending 状态的任务
      expect(executableTasks).toHaveLength(3);

      // 任务树中应该有批次
      expect(taskTree.batches).toBeDefined();
      expect(taskTree.batches!.length).toBeGreaterThan(0);

      // 每个任务应该被分配到批次
      for (const task of executableTasks) {
        expect(task.metadata?.batchId).toBeDefined();
        expect(task.metadata?.batchIndex).toBeDefined();
      }
    });

    it("应该正确处理依赖关系", async () => {
      // 添加任务 1
      const task1 = await orchestrator.addSubTask(
        taskTree,
        "任务 1 的 prompt",
        "任务 1"
      );

      // 添加任务 2（依赖任务 1）
      const task2 = await orchestrator.addSubTask(
        taskTree,
        "任务 2 的 prompt",
        "任务 2"
      );
      task2.dependencies = [task1.id];

      // 获取可执行任务
      const executableTasks = orchestrator.getExecutableTasks(taskTree, false);

      // 只有任务 1 可以执行（任务 2 依赖任务 1）
      expect(executableTasks).toHaveLength(1);
      expect(executableTasks[0].id).toBe(task1.id);

      // 完成任务 1
      task1.status = "completed";

      // 再次获取可执行任务
      const executableTasks2 = orchestrator.getExecutableTasks(taskTree, false);

      // 现在任务 2 可以执行了
      expect(executableTasks2).toHaveLength(1);
      expect(executableTasks2[0].id).toBe(task2.id);
    });

    it("应该正确处理父子关系（waitForChildren）", async () => {
      // 添加父任务
      const parentTask = await orchestrator.addSubTask(
        taskTree,
        "父任务的 prompt",
        "父任务"
      );
      parentTask.waitForChildren = true;

      // 添加子任务
      const childTask1 = await orchestrator.addSubTask(
        taskTree,
        "子任务 1 的 prompt",
        "子任务 1",
        parentTask.id
      );
      const childTask2 = await orchestrator.addSubTask(
        taskTree,
        "子任务 2 的 prompt",
        "子任务 2",
        parentTask.id
      );

      // 获取可执行任务
      const executableTasks = orchestrator.getExecutableTasks(taskTree, false);

      // 只有子任务可以执行（父任务等待子任务完成）
      expect(executableTasks).toHaveLength(2);
      expect(executableTasks.map(t => t.id)).toEqual([childTask1.id, childTask2.id]);

      // 完成所有子任务
      childTask1.status = "completed";
      childTask1.output = "子任务 1 的输出";
      childTask2.status = "completed";
      childTask2.output = "子任务 2 的输出";

      // 再次获取可执行任务
      const executableTasks2 = orchestrator.getExecutableTasks(taskTree, false);

      // 现在父任务可以执行了
      expect(executableTasks2).toHaveLength(1);
      expect(executableTasks2[0].id).toBe(parentTask.id);

      // 父任务的 prompt 应该包含子任务的输出
      expect(executableTasks2[0].prompt).toContain("子任务输出");
      expect(executableTasks2[0].prompt).toContain("子任务 1 的输出");
      expect(executableTasks2[0].prompt).toContain("子任务 2 的输出");
    });
  });

  describe("executeBatches", () => {
    it("应该成功执行单个批次", async () => {
      // 添加测试任务
      const task1 = await orchestrator.addSubTask(
        taskTree,
        "任务 1 的 prompt",
        "任务 1"
      );
      const task2 = await orchestrator.addSubTask(
        taskTree,
        "任务 2 的 prompt",
        "任务 2"
      );
      const task3 = await orchestrator.addSubTask(
        taskTree,
        "任务 3 的 prompt",
        "任务 3"
      );

      // 创建批次
      const batch: TaskBatch = {
        id: "test-batch-1",
        tasks: [task1, task2, task3],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      // 执行批次
      const results = await orchestrator.executeBatches(taskTree, [batch]);

      // 验证结果
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].outputs.size).toBe(3);

      // 验证任务状态
      expect(task1.status).toBe("completed");
      expect(task2.status).toBe("completed");
      expect(task3.status).toBe("completed");

      // 验证任务输出
      expect(task1.output).toBe("任务 1 的输出内容");
      expect(task2.output).toBe("任务 2 的输出内容");
      expect(task3.output).toBe("任务 3 的输出内容");

      // 验证批次状态
      expect(batch.status).toBe("completed");
      expect(batch.completedAt).toBeDefined();
    });

    it("应该成功执行多个批次", async () => {
      // 添加测试任务
      const tasks: SubTask[] = [];
      for (let i = 1; i <= 6; i++) {
        const task = await orchestrator.addSubTask(
          taskTree,
          `任务 ${i} 的 prompt`,
          `任务 ${i}`
        );
        tasks.push(task);
      }

      // 创建两个批次
      const batch1: TaskBatch = {
        id: "test-batch-1",
        tasks: [tasks[0], tasks[1], tasks[2]],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      const batch2: TaskBatch = {
        id: "test-batch-2",
        tasks: [tasks[3], tasks[4], tasks[5]],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      // 执行批次
      const results = await orchestrator.executeBatches(taskTree, [batch1, batch2]);

      // 验证结果
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);

      // 验证所有任务都已完成
      for (const task of tasks) {
        expect(task.status).toBe("completed");
        expect(task.output).toBeDefined();
      }

      // 验证批次状态
      expect(batch1.status).toBe("completed");
      expect(batch2.status).toBe("completed");
    });

    it("应该正确处理批次执行失败", async () => {
      // 创建会失败的 mock LLM 调用器
      const failingLLMCaller: LLMCaller = {
        call: vi.fn(async () => {
          throw new Error("LLM 调用失败");
        }),
      };

      // 创建新的 Orchestrator
      const failingOrchestrator = new Orchestrator(
        undefined,
        undefined,
        failingLLMCaller
      );

      // 添加测试任务
      const task1 = await failingOrchestrator.addSubTask(
        taskTree,
        "任务 1 的 prompt",
        "任务 1"
      );
      const task2 = await failingOrchestrator.addSubTask(
        taskTree,
        "任务 2 的 prompt",
        "任务 2"
      );

      // 创建批次
      const batch: TaskBatch = {
        id: "test-batch-1",
        tasks: [task1, task2],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      // 执行批次
      const results = await failingOrchestrator.executeBatches(taskTree, [batch]);

      // 验证结果
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBeDefined();

      // 验证任务状态
      expect(task1.status).toBe("failed");
      expect(task2.status).toBe("failed");

      // 验证任务错误信息
      expect(task1.error).toContain("批次执行");
      expect(task2.error).toContain("批次执行");

      // 验证批次状态
      expect(batch.status).toBe("failed");
      expect(batch.error).toBeDefined();
    });

    it("应该正确处理输出拆分失败（回退到单任务执行）", async () => {
      // 创建返回错误格式的 mock LLM 调用器
      const badFormatLLMCaller: LLMCaller = {
        call: vi.fn(async () => {
          // 返回没有分隔符的输出
          return "所有任务的输出混在一起，没有分隔符";
        }),
      };

      // 创建新的 Orchestrator
      const badFormatOrchestrator = new Orchestrator(
        undefined,
        {
          separator: "---TASK-SEPARATOR---",
          enableFallbackSplit: true, // 启用后备拆分
        },
        badFormatLLMCaller
      );

      // 添加测试任务
      const task1 = await badFormatOrchestrator.addSubTask(
        taskTree,
        "任务 1 的 prompt",
        "任务 1"
      );
      const task2 = await badFormatOrchestrator.addSubTask(
        taskTree,
        "任务 2 的 prompt",
        "任务 2"
      );

      // 创建批次
      const batch: TaskBatch = {
        id: "test-batch-1",
        tasks: [task1, task2],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      // 执行批次
      const results = await badFormatOrchestrator.executeBatches(taskTree, [batch]);

      // 验证结果（应该失败，因为无法正确拆分）
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("拆分失败");
    });
  });

  describe("getBatches", () => {
    it("应该返回任务树中的所有批次", async () => {
      // 初始状态下没有批次
      expect(orchestrator.getBatches(taskTree)).toEqual([]);

      // 添加任务并启用批量执行
      await orchestrator.addSubTask(taskTree, "任务 1", "任务 1");
      await orchestrator.addSubTask(taskTree, "任务 2", "任务 2");
      orchestrator.getExecutableTasks(taskTree, true);

      // 现在应该有批次
      const batches = orchestrator.getBatches(taskTree);
      expect(batches.length).toBeGreaterThan(0);
    });
  });

  describe("getPendingBatches", () => {
    it("应该返回待执行的批次", async () => {
      // 添加任务并创建批次
      const task1 = await orchestrator.addSubTask(taskTree, "任务 1", "任务 1");
      const task2 = await orchestrator.addSubTask(taskTree, "任务 2", "任务 2");
      orchestrator.getExecutableTasks(taskTree, true);

      // 获取待执行的批次
      const pendingBatches = orchestrator.getPendingBatches(taskTree);
      expect(pendingBatches.length).toBeGreaterThan(0);

      // 执行批次
      await orchestrator.executeBatches(taskTree, pendingBatches);

      // 现在应该没有待执行的批次
      const pendingBatches2 = orchestrator.getPendingBatches(taskTree);
      expect(pendingBatches2).toEqual([]);
    });
  });

  describe("getBatchStatistics", () => {
    it("应该返回正确的批次统计信息", async () => {
      // 初始状态
      let stats = orchestrator.getBatchStatistics(taskTree);
      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);

      // 添加任务并创建批次
      await orchestrator.addSubTask(taskTree, "任务 1", "任务 1");
      await orchestrator.addSubTask(taskTree, "任务 2", "任务 2");
      await orchestrator.addSubTask(taskTree, "任务 3", "任务 3");
      orchestrator.getExecutableTasks(taskTree, true);

      // 检查统计信息
      stats = orchestrator.getBatchStatistics(taskTree);
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.pending).toBe(stats.total);
      expect(stats.completed).toBe(0);

      // 执行批次
      const pendingBatches = orchestrator.getPendingBatches(taskTree);
      await orchestrator.executeBatches(taskTree, pendingBatches);

      // 检查统计信息
      stats = orchestrator.getBatchStatistics(taskTree);
      expect(stats.completed).toBe(stats.total);
      expect(stats.pending).toBe(0);
    });
  });
});
