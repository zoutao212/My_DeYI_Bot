/**
 * Orchestrator 单元测试
 * 
 * 测试批量执行功能的集成
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { TaskTree, SubTask, TaskBatch } from "./types.js";

describe("Orchestrator - 批量执行功能", () => {
  let orchestrator: Orchestrator;
  let taskTree: TaskTree;

  beforeEach(() => {
    // 创建 Orchestrator 实例（纯规则驱动，不依赖独立 LLM 调用）
    orchestrator = new Orchestrator({
      maxTasksPerBatch: 5,
      maxTokensPerBatch: 6000,
    });

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
    it("应该在批量执行器未初始化时抛出错误", async () => {
      const batch: TaskBatch = {
        id: "test-batch-1",
        tasks: [],
        estimatedTokens: 0,
        createdAt: Date.now(),
      };

      await expect(orchestrator.executeBatches(taskTree, [batch])).rejects.toThrow(
        "批量执行器未初始化"
      );
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
      await orchestrator.addSubTask(taskTree, "任务 1", "任务 1");
      await orchestrator.addSubTask(taskTree, "任务 2", "任务 2");
      orchestrator.getExecutableTasks(taskTree, true);

      // 获取待执行的批次
      const pendingBatches = orchestrator.getPendingBatches(taskTree);
      expect(pendingBatches.length).toBeGreaterThan(0);
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
    });
  });
});
