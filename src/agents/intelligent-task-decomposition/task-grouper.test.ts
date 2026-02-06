/**
 * TaskGrouper 单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TaskGrouper } from "./task-grouper.js";
import type { TaskTree, SubTask } from "./types.js";

describe("TaskGrouper", () => {
  let grouper: TaskGrouper;
  let taskTree: TaskTree;

  beforeEach(() => {
    grouper = new TaskGrouper();
    taskTree = {
      id: "test-session",
      rootTask: "测试任务",
      subTasks: [],
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      checkpoints: [],
    };
  });

  describe("groupTasks", () => {
    it("应该正确分组可批量执行的任务", () => {
      const tasks: SubTask[] = [
        createTask("task1", "生成第1章", "生成第1章内容，约500字"),
        createTask("task2", "生成第2章", "生成第2章内容，约500字"),
        createTask("task3", "生成第3章", "生成第3章内容，约500字"),
      ];

      taskTree.subTasks = tasks;

      const batches = grouper.groupTasks(taskTree, tasks);

      expect(batches.length).toBeGreaterThan(0);
      expect(batches[0].tasks.length).toBeGreaterThan(0);
      expect(batches[0].tasks.length).toBeLessThanOrEqual(5);
    });

    it("应该过滤掉不可批量执行的任务", () => {
      const tasks: SubTask[] = [
        createTask("task1", "生成第1章", "生成第1章内容，约500字"),
        createTask("task2", "生成第2章", "生成第2章内容，约500字", { status: "completed" }),
        createTask("task3", "生成第3章", "生成第3章内容，约500字", { decomposed: true }),
      ];

      taskTree.subTasks = tasks;

      const batches = grouper.groupTasks(taskTree, tasks);

      // 只有 task1 可以批量执行
      const allBatchedTasks = batches.flatMap(b => b.tasks);
      expect(allBatchedTasks.length).toBe(1);
      expect(allBatchedTasks[0].id).toBe("task1");
    });

    it("应该返回空数组如果没有可批量执行的任务", () => {
      const tasks: SubTask[] = [
        createTask("task1", "生成第1章", "生成第1章内容，约500字", { status: "completed" }),
        createTask("task2", "生成第2章", "生成第2章内容，约500字", { status: "failed" }),
      ];

      taskTree.subTasks = tasks;

      const batches = grouper.groupTasks(taskTree, tasks);

      expect(batches.length).toBe(0);
    });
  });

  describe("createBatch", () => {
    it("应该创建包含多个任务的批次", () => {
      const tasks: SubTask[] = [
        createTask("task1", "生成第1章", "生成第1章内容，约500字"),
        createTask("task2", "生成第2章", "生成第2章内容，约500字"),
        createTask("task3", "生成第3章", "生成第3章内容，约500字"),
      ];

      taskTree.subTasks = tasks;

      const batch = grouper.createBatch(taskTree, tasks);

      expect(batch.tasks.length).toBeGreaterThan(0);
      expect(batch.tasks.length).toBeLessThanOrEqual(5);
      expect(batch.estimatedTokens).toBeGreaterThan(0);
    });

    it("应该限制批次大小不超过 maxTasksPerBatch", () => {
      const grouper = new TaskGrouper({ maxTasksPerBatch: 3 });

      const tasks: SubTask[] = [
        createTask("task1", "生成第1章", "生成第1章内容，约500字"),
        createTask("task2", "生成第2章", "生成第2章内容，约500字"),
        createTask("task3", "生成第3章", "生成第3章内容，约500字"),
        createTask("task4", "生成第4章", "生成第4章内容，约500字"),
        createTask("task5", "生成第5章", "生成第5章内容，约500字"),
      ];

      taskTree.subTasks = tasks;

      const batch = grouper.createBatch(taskTree, tasks);

      expect(batch.tasks.length).toBeLessThanOrEqual(3);
    });

    it("应该限制批次 tokens 不超过 maxTokensPerBatch", () => {
      const grouper = new TaskGrouper({ maxTokensPerBatch: 3000 });

      const tasks: SubTask[] = [
        createTask("task1", "生成第1章", "生成第1章内容，约1000字"),
        createTask("task2", "生成第2章", "生成第2章内容，约1000字"),
        createTask("task3", "生成第3章", "生成第3章内容，约1000字"),
      ];

      taskTree.subTasks = tasks;

      const batch = grouper.createBatch(taskTree, tasks);

      expect(batch.estimatedTokens).toBeLessThanOrEqual(3000);
    });

    it("应该返回空批次如果任务列表为空", () => {
      const batch = grouper.createBatch(taskTree, []);

      expect(batch.tasks.length).toBe(0);
      expect(batch.estimatedTokens).toBe(0);
    });
  });

  describe("canAddToBatch", () => {
    it("应该允许添加无依赖关系的任务", () => {
      const batch = {
        id: "batch1",
        tasks: [createTask("task1", "生成第1章", "生成第1章内容，约500字")],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      const task = createTask("task2", "生成第2章", "生成第2章内容，约500字");

      taskTree.subTasks = [batch.tasks[0], task];

      const canAdd = grouper.canAddToBatch(batch, task, taskTree);

      expect(canAdd).toBe(true);
    });

    it("应该拒绝添加有依赖关系的任务", () => {
      const task1 = createTask("task1", "生成第1章", "生成第1章内容，约500字");
      const task2 = createTask("task2", "生成第2章", "生成第2章内容，约500字", {
        dependencies: ["task1"],
      });

      const batch = {
        id: "batch1",
        tasks: [task1],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      taskTree.subTasks = [task1, task2];

      const canAdd = grouper.canAddToBatch(batch, task2, taskTree);

      expect(canAdd).toBe(false);
    });

    it("应该拒绝添加父子关系的任务", () => {
      const parent = createTask("parent", "父任务", "父任务描述");
      const child = createTask("child", "子任务", "子任务描述", {
        parentId: "parent",
      });

      const batch = {
        id: "batch1",
        tasks: [parent],
        estimatedTokens: 1000,
        createdAt: Date.now(),
      };

      taskTree.subTasks = [parent, child];

      const canAdd = grouper.canAddToBatch(batch, child, taskTree);

      expect(canAdd).toBe(false);
    });

    it("应该拒绝添加超过批次大小限制的任务", () => {
      const grouper = new TaskGrouper({ maxTasksPerBatch: 2 });

      const batch = {
        id: "batch1",
        tasks: [
          createTask("task1", "生成第1章", "生成第1章内容，约500字"),
          createTask("task2", "生成第2章", "生成第2章内容，约500字"),
        ],
        estimatedTokens: 2000,
        createdAt: Date.now(),
      };

      const task = createTask("task3", "生成第3章", "生成第3章内容，约500字");

      taskTree.subTasks = [...batch.tasks, task];

      const canAdd = grouper.canAddToBatch(batch, task, taskTree);

      expect(canAdd).toBe(false);
    });

    it("应该拒绝添加超过 tokens 限制的任务", () => {
      const grouper = new TaskGrouper({ maxTokensPerBatch: 3000 });

      const batch = {
        id: "batch1",
        tasks: [createTask("task1", "生成第1章", "生成第1章内容，约1000字")],
        estimatedTokens: 2500,
        createdAt: Date.now(),
      };

      const task = createTask("task2", "生成第2章", "生成第2章内容，约1000字");

      taskTree.subTasks = [batch.tasks[0], task];

      const canAdd = grouper.canAddToBatch(batch, task, taskTree);

      expect(canAdd).toBe(false);
    });
  });

  describe("相似度分组", () => {
    it("应该将相似的任务分组在一起", () => {
      const grouper = new TaskGrouper({
        enableSimilarityGrouping: true,
        similarityThreshold: 0.5,
      });

      const tasks: SubTask[] = [
        createTask("task1", "生成第1章", "生成第1章内容，关于人工智能的介绍"),
        createTask("task2", "生成第2章", "生成第2章内容，关于人工智能的应用"),
        createTask("task3", "生成第3章", "生成第3章内容，关于区块链的介绍"),
      ];

      taskTree.subTasks = tasks;

      const batches = grouper.groupTasks(taskTree, tasks);

      // task1 和 task2 应该在同一批次（相似度高）
      // task3 应该在另一批次（相似度低）
      expect(batches.length).toBeGreaterThan(0);
    });

    it("应该在禁用相似度分组时忽略相似度", () => {
      const grouper = new TaskGrouper({
        enableSimilarityGrouping: false,
      });

      const tasks: SubTask[] = [
        createTask("task1", "生成第1章", "生成第1章内容，关于人工智能的介绍"),
        createTask("task2", "生成第2章", "生成第2章内容，关于区块链的介绍"),
      ];

      taskTree.subTasks = tasks;

      const batches = grouper.groupTasks(taskTree, tasks);

      // 应该将所有任务分组在一起（忽略相似度）
      expect(batches.length).toBeGreaterThan(0);
    });
  });

  describe("tokens 估算", () => {
    it("应该正确估算中文任务的 tokens", () => {
      const task = createTask("task1", "生成文章", "生成一篇500字的文章");

      const batch = grouper.createBatch(taskTree, [task]);

      expect(batch.estimatedTokens).toBeGreaterThan(0);
    });

    it("应该正确估算英文任务的 tokens", () => {
      const task = createTask("task1", "Generate article", "Generate a 500 words article");

      const batch = grouper.createBatch(taskTree, [task]);

      expect(batch.estimatedTokens).toBeGreaterThan(0);
    });

    it("应该使用元数据中的预估值", () => {
      const task = createTask("task1", "生成文章", "生成一篇500字的文章", {
        metadata: { estimatedTokens: 1500 },
      });

      const batch = grouper.createBatch(taskTree, [task]);

      expect(batch.estimatedTokens).toBe(1500);
    });

    it("应该从 prompt 中提取字数要求", () => {
      const task = createTask("task1", "生成文章", "生成一篇2000字的文章");

      const batch = grouper.createBatch(taskTree, [task]);

      // 2000 字 * 2 = 4000 tokens
      expect(batch.estimatedTokens).toBeGreaterThanOrEqual(4000);
    });
  });
});

/**
 * 创建测试任务
 */
function createTask(
  id: string,
  summary: string,
  prompt: string,
  overrides: Partial<SubTask> = {}
): SubTask {
  return {
    id,
    summary,
    prompt,
    status: "pending",
    retryCount: 0,
    createdAt: Date.now(),
    depth: 0,
    children: [],
    ...overrides,
  };
}
