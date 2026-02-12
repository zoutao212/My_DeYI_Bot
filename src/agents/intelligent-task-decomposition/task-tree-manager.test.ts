/**
 * TaskTreeManager 单元测试
 * 
 * 测试任务树管理器的核心功能
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskTreeManager } from "./task-tree-manager.js";
import type { TaskTree, SubTask } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("TaskTreeManager", () => {
  let manager: TaskTreeManager;
  let testSessionId: string;
  let testDir: string;

  beforeEach(() => {
    manager = new TaskTreeManager();
    testSessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const homeDir = os.homedir();
    testDir = path.join(homeDir, ".clawdbot", "tasks", testSessionId);
  });

  afterEach(async () => {
    // 清理测试文件
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  describe("removeSubTask", () => {
    it("应该删除根级子任务", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 添加一个根级子任务
      const subTask: SubTask = {
        id: "task-1",
        prompt: "Task 1 prompt",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      await manager.addSubTask(taskTree, null, subTask);

      // 验证任务已添加
      expect(taskTree.subTasks).toHaveLength(1);
      expect(taskTree.subTasks[0].id).toBe("task-1");

      // 删除任务
      await manager.removeSubTask(taskTree, "task-1");

      // 验证任务已删除
      expect(taskTree.subTasks).toHaveLength(0);
    });

    it("应该级联删除子任务及其所有子孙任务", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务层级：
      // task-1 (root)
      //   ├─ task-2 (child of task-1)
      //   │   └─ task-3 (child of task-2)
      //   └─ task-4 (child of task-1)

      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      const task3: SubTask = {
        id: "task-3",
        prompt: "Task 3",
        summary: "Task 3",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 2,
        parentId: "task-2",
        children: [],
      };

      const task4: SubTask = {
        id: "task-4",
        prompt: "Task 4",
        summary: "Task 4",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      // 添加任务
      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, "task-1", task2);
      await manager.addSubTask(taskTree, "task-2", task3);
      await manager.addSubTask(taskTree, "task-1", task4);

      // 验证任务已添加
      expect(taskTree.subTasks).toHaveLength(4);

      // 删除 task-2（应该级联删除 task-3）
      await manager.removeSubTask(taskTree, "task-2");

      // 验证 task-2 和 task-3 都被删除，task-1 和 task-4 保留
      expect(taskTree.subTasks).toHaveLength(2);
      expect(taskTree.subTasks.find((t) => t.id === "task-1")).toBeDefined();
      expect(taskTree.subTasks.find((t) => t.id === "task-2")).toBeUndefined();
      expect(taskTree.subTasks.find((t) => t.id === "task-3")).toBeUndefined();
      expect(taskTree.subTasks.find((t) => t.id === "task-4")).toBeDefined();

      // 验证 task-1 的 children 数组已更新
      const task1After = taskTree.subTasks.find((t) => t.id === "task-1");
      expect(task1After?.children).toHaveLength(1);
      expect(task1After?.children?.[0].id).toBe("task-4");
    });

    it("应该清理对已删除任务的依赖引用", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务：task-2 依赖 task-1
      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
        dependencies: ["task-1"], // task-2 依赖 task-1
      };

      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, null, task2);

      // 验证依赖关系
      const task2Before = taskTree.subTasks.find((t) => t.id === "task-2");
      expect(task2Before?.dependencies).toEqual(["task-1"]);

      // 删除 task-1
      await manager.removeSubTask(taskTree, "task-1");

      // 验证 task-2 的依赖引用已清理
      const task2After = taskTree.subTasks.find((t) => t.id === "task-2");
      expect(task2After?.dependencies).toEqual([]);
    });

    it("应该在删除不存在的任务时抛出错误", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 尝试删除不存在的任务
      await expect(manager.removeSubTask(taskTree, "non-existent-task")).rejects.toThrow(
        "SubTask not found: non-existent-task"
      );
    });

    it("应该正确处理删除有多个子孙任务的任务", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建复杂的任务层级：
      // task-1 (root)
      //   ├─ task-2
      //   │   ├─ task-3
      //   │   └─ task-4
      //   └─ task-5
      //       └─ task-6

      const tasks: SubTask[] = [
        {
          id: "task-1",
          prompt: "Task 1",
          summary: "Task 1",
          status: "pending",
          retryCount: 0,
          createdAt: Date.now(),
          depth: 0,
          parentId: null,
          children: [],
        },
        {
          id: "task-2",
          prompt: "Task 2",
          summary: "Task 2",
          status: "pending",
          retryCount: 0,
          createdAt: Date.now(),
          depth: 1,
          parentId: "task-1",
          children: [],
        },
        {
          id: "task-3",
          prompt: "Task 3",
          summary: "Task 3",
          status: "pending",
          retryCount: 0,
          createdAt: Date.now(),
          depth: 2,
          parentId: "task-2",
          children: [],
        },
        {
          id: "task-4",
          prompt: "Task 4",
          summary: "Task 4",
          status: "pending",
          retryCount: 0,
          createdAt: Date.now(),
          depth: 2,
          parentId: "task-2",
          children: [],
        },
        {
          id: "task-5",
          prompt: "Task 5",
          summary: "Task 5",
          status: "pending",
          retryCount: 0,
          createdAt: Date.now(),
          depth: 1,
          parentId: "task-1",
          children: [],
        },
        {
          id: "task-6",
          prompt: "Task 6",
          summary: "Task 6",
          status: "pending",
          retryCount: 0,
          createdAt: Date.now(),
          depth: 2,
          parentId: "task-5",
          children: [],
        },
      ];

      // 添加所有任务
      await manager.addSubTask(taskTree, null, tasks[0]);
      await manager.addSubTask(taskTree, "task-1", tasks[1]);
      await manager.addSubTask(taskTree, "task-2", tasks[2]);
      await manager.addSubTask(taskTree, "task-2", tasks[3]);
      await manager.addSubTask(taskTree, "task-1", tasks[4]);
      await manager.addSubTask(taskTree, "task-5", tasks[5]);

      // 验证所有任务已添加
      expect(taskTree.subTasks).toHaveLength(6);

      // 删除 task-1（应该级联删除所有子孙任务）
      await manager.removeSubTask(taskTree, "task-1");

      // 验证所有任务都被删除
      expect(taskTree.subTasks).toHaveLength(0);
    });
  });

  describe("modifySubTask", () => {
    it("应该成功修改子任务的基本字段", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 添加一个子任务
      const subTask: SubTask = {
        id: "task-1",
        prompt: "Original prompt",
        summary: "Original summary",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      await manager.addSubTask(taskTree, null, subTask);

      // 修改子任务
      await manager.modifySubTask(taskTree, "task-1", {
        summary: "Updated summary",
        prompt: "Updated prompt",
        status: "active",
      });

      // 验证修改成功
      const updatedTask = taskTree.subTasks.find((t) => t.id === "task-1");
      expect(updatedTask?.summary).toBe("Updated summary");
      expect(updatedTask?.prompt).toBe("Updated prompt");
      expect(updatedTask?.status).toBe("active");
    });

    it("应该在修改 status 为 completed 时自动设置 completedAt", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 添加一个子任务
      const subTask: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      await manager.addSubTask(taskTree, null, subTask);

      // 修改状态为 completed
      await manager.modifySubTask(taskTree, "task-1", {
        status: "completed",
      });

      // 验证 completedAt 已设置
      const updatedTask = taskTree.subTasks.find((t) => t.id === "task-1");
      expect(updatedTask?.status).toBe("completed");
      expect(updatedTask?.completedAt).toBeDefined();
      expect(updatedTask?.completedAt).toBeGreaterThan(0);
    });

    it("应该拒绝修改任务 id", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 添加一个子任务
      const subTask: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      await manager.addSubTask(taskTree, null, subTask);

      // 尝试修改 id
      await expect(
        manager.modifySubTask(taskTree, "task-1", {
          id: "new-id",
        })
      ).rejects.toThrow("Cannot modify task id: task-1");
    });

    it("应该验证新的 parentId 是否存在", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 添加一个子任务
      const subTask: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      await manager.addSubTask(taskTree, null, subTask);

      // 尝试设置不存在的父任务
      await expect(
        manager.modifySubTask(taskTree, "task-1", {
          parentId: "non-existent-parent",
        })
      ).rejects.toThrow("New parent task not found: non-existent-parent");
    });

    it("应该防止循环依赖（parentId）", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务层级：task-1 -> task-2
      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, "task-1", task2);

      // 尝试将 task-1 的父任务设置为 task-2（会导致循环）
      await expect(
        manager.modifySubTask(taskTree, "task-1", {
          parentId: "task-2",
        })
      ).rejects.toThrow("Cannot set parent to a descendant task: task-2");
    });

    it("应该防止循环依赖（dependencies）", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务层级：task-1 -> task-2
      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, "task-1", task2);

      // 尝试让 task-1 依赖 task-2（会导致循环）
      await expect(
        manager.modifySubTask(taskTree, "task-1", {
          dependencies: ["task-2"],
        })
      ).rejects.toThrow("Cannot depend on a descendant task: task-2");
    });

    it("应该验证 dependencies 中的任务是否存在", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 添加一个子任务
      const subTask: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      await manager.addSubTask(taskTree, null, subTask);

      // 尝试设置不存在的依赖任务
      await expect(
        manager.modifySubTask(taskTree, "task-1", {
          dependencies: ["non-existent-task"],
        })
      ).rejects.toThrow("Dependency task not found: non-existent-task");
    });
  });

  describe("moveSubTask", () => {
    it("应该成功移动子任务到新的父任务", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务层级：
      // task-1 (root)
      // task-2 (root)
      // task-3 (child of task-1)

      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task3: SubTask = {
        id: "task-3",
        prompt: "Task 3",
        summary: "Task 3",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, null, task2);
      await manager.addSubTask(taskTree, "task-1", task3);

      // 验证初始状态
      const task1Before = taskTree.subTasks.find((t) => t.id === "task-1");
      const task2Before = taskTree.subTasks.find((t) => t.id === "task-2");
      const task3Before = taskTree.subTasks.find((t) => t.id === "task-3");
      expect(task1Before?.children).toHaveLength(1);
      expect(task2Before?.children).toHaveLength(0);
      expect(task3Before?.parentId).toBe("task-1");
      expect(task3Before?.depth).toBe(1);

      // 移动 task-3 从 task-1 到 task-2
      await manager.moveSubTask(taskTree, "task-3", "task-2");

      // 验证移动后的状态
      const task1After = taskTree.subTasks.find((t) => t.id === "task-1");
      const task2After = taskTree.subTasks.find((t) => t.id === "task-2");
      const task3After = taskTree.subTasks.find((t) => t.id === "task-3");
      expect(task1After?.children).toHaveLength(0);
      expect(task2After?.children).toHaveLength(1);
      expect(task2After?.children?.[0].id).toBe("task-3");
      expect(task3After?.parentId).toBe("task-2");
      expect(task3After?.depth).toBe(1);
    });

    it("应该成功移动子任务到根级", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务层级：
      // task-1 (root)
      //   └─ task-2 (child of task-1)

      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, "task-1", task2);

      // 验证初始状态
      const task1Before = taskTree.subTasks.find((t) => t.id === "task-1");
      const task2Before = taskTree.subTasks.find((t) => t.id === "task-2");
      expect(task1Before?.children).toHaveLength(1);
      expect(task2Before?.parentId).toBe("task-1");
      expect(task2Before?.depth).toBe(1);

      // 移动 task-2 到根级
      await manager.moveSubTask(taskTree, "task-2", null);

      // 验证移动后的状态
      const task1After = taskTree.subTasks.find((t) => t.id === "task-1");
      const task2After = taskTree.subTasks.find((t) => t.id === "task-2");
      expect(task1After?.children).toHaveLength(0);
      expect(task2After?.parentId).toBeNull();
      expect(task2After?.depth).toBe(0);
    });

    it("应该递归更新子孙任务的 depth", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务层级：
      // task-1 (root, depth=0)
      //   └─ task-2 (depth=1)
      //       └─ task-3 (depth=2)
      // task-4 (root, depth=0)

      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      const task3: SubTask = {
        id: "task-3",
        prompt: "Task 3",
        summary: "Task 3",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 2,
        parentId: "task-2",
        children: [],
      };

      const task4: SubTask = {
        id: "task-4",
        prompt: "Task 4",
        summary: "Task 4",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, "task-1", task2);
      await manager.addSubTask(taskTree, "task-2", task3);
      await manager.addSubTask(taskTree, null, task4);

      // 验证初始深度
      expect(taskTree.subTasks.find((t) => t.id === "task-2")?.depth).toBe(1);
      expect(taskTree.subTasks.find((t) => t.id === "task-3")?.depth).toBe(2);

      // 移动 task-2 到 task-4 下
      await manager.moveSubTask(taskTree, "task-2", "task-4");

      // 验证深度已更新
      expect(taskTree.subTasks.find((t) => t.id === "task-2")?.depth).toBe(1);
      expect(taskTree.subTasks.find((t) => t.id === "task-3")?.depth).toBe(2);
    });

    it("应该防止循环依赖", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务层级：task-1 -> task-2
      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, "task-1", task2);

      // 尝试将 task-1 移动到 task-2 下（会导致循环）
      await expect(manager.moveSubTask(taskTree, "task-1", "task-2")).rejects.toThrow(
        "Cannot move task to a descendant: task-2"
      );
    });

    it("应该在移动到不存在的父任务时抛出错误", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 添加一个子任务
      const subTask: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      await manager.addSubTask(taskTree, null, subTask);

      // 尝试移动到不存在的父任务
      await expect(manager.moveSubTask(taskTree, "task-1", "non-existent-parent")).rejects.toThrow(
        "New parent task not found: non-existent-parent"
      );
    });

    it("应该在移动不存在的任务时抛出错误", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 尝试移动不存在的任务
      await expect(manager.moveSubTask(taskTree, "non-existent-task", null)).rejects.toThrow(
        "SubTask not found: non-existent-task"
      );
    });

    it("应该在移动到相同父任务时跳过操作", async () => {
      // 初始化任务树
      const taskTree = await manager.initialize("Test root task", testSessionId);

      // 创建任务层级：task-1 -> task-2
      const task1: SubTask = {
        id: "task-1",
        prompt: "Task 1",
        summary: "Task 1",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 0,
        parentId: null,
        children: [],
      };

      const task2: SubTask = {
        id: "task-2",
        prompt: "Task 2",
        summary: "Task 2",
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        depth: 1,
        parentId: "task-1",
        children: [],
      };

      await manager.addSubTask(taskTree, null, task1);
      await manager.addSubTask(taskTree, "task-1", task2);

      // 尝试移动到相同的父任务（应该跳过）
      await manager.moveSubTask(taskTree, "task-2", "task-1");

      // 验证状态未改变
      const task2After = taskTree.subTasks.find((t) => t.id === "task-2");
      expect(task2After?.parentId).toBe("task-1");
      expect(task2After?.depth).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // P32: merge-on-save regression tests
  // ════════════════════════════════════════════════════════════════
  describe("P32: merge-on-save", () => {
    it("should preserve both status changes when two stale copies save sequentially", async () => {
      const taskTree = await manager.initialize("root", testSessionId);

      const taskA: SubTask = {
        id: "p32-a", prompt: "A", summary: "A",
        status: "pending", retryCount: 0, createdAt: Date.now(),
        depth: 0, parentId: null, children: [],
      };
      const taskB: SubTask = {
        id: "p32-b", prompt: "B", summary: "B",
        status: "pending", retryCount: 0, createdAt: Date.now(),
        depth: 0, parentId: null, children: [],
      };
      await manager.addSubTask(taskTree, null, taskA);
      await manager.addSubTask(taskTree, null, taskB);

      // Simulate two parallel runners each loading their own copy
      const copy1 = await manager.load(testSessionId);
      const copy2 = await manager.load(testSessionId);

      // Runner 1 completes task A
      const a1 = copy1!.subTasks.find(t => t.id === "p32-a")!;
      a1.status = "completed";
      a1.completedAt = Date.now();

      // Runner 2 completes task B (loaded before runner 1 saved)
      const b2 = copy2!.subTasks.find(t => t.id === "p32-b")!;
      b2.status = "completed";
      b2.completedAt = Date.now();

      // Sequential saves (simulates lock serialization)
      await manager.save(copy1!);
      await manager.save(copy2!);

      // Without P32 fix: copy2 overwrites copy1, task A reverts to pending
      // With P32 fix: merge preserves both completions
      const result = await manager.load(testSessionId);
      expect(result!.subTasks.find(t => t.id === "p32-a")!.status).toBe("completed");
      expect(result!.subTasks.find(t => t.id === "p32-b")!.status).toBe("completed");
    });

    it("should preserve decomposition data when a stale copy saves later", async () => {
      const taskTree = await manager.initialize("root", testSessionId);

      const taskA: SubTask = {
        id: "p32-dec-a", prompt: "A", summary: "A",
        status: "pending", retryCount: 0, createdAt: Date.now(),
        depth: 0, parentId: null, children: [],
      };
      const taskB: SubTask = {
        id: "p32-dec-b", prompt: "B", summary: "B",
        status: "pending", retryCount: 0, createdAt: Date.now(),
        depth: 0, parentId: null, children: [],
      };
      await manager.addSubTask(taskTree, null, taskA);
      await manager.addSubTask(taskTree, null, taskB);

      // Both runners load the same version
      const copy1 = await manager.load(testSessionId);
      const copy2 = await manager.load(testSessionId);

      // Runner 1: decompose task A (fast path — creates segments)
      const a1 = copy1!.subTasks.find(t => t.id === "p32-dec-a")!;
      a1.decomposed = true;
      a1.status = "active";
      a1.waitForChildren = true;
      const seg1: SubTask = {
        id: "p32-dec-a-seg-1", prompt: "Seg 1", summary: "Seg 1",
        status: "pending", retryCount: 0, createdAt: Date.now(),
        depth: 1, parentId: "p32-dec-a", children: [],
      };
      const seg2: SubTask = {
        id: "p32-dec-a-seg-2", prompt: "Seg 2", summary: "Seg 2",
        status: "pending", retryCount: 0, createdAt: Date.now(),
        depth: 1, parentId: "p32-dec-a", children: [],
        dependencies: ["p32-dec-a-seg-1"],
      };
      copy1!.subTasks.push(seg1, seg2);

      // Runner 1 saves first (decomposition is fast)
      await manager.save(copy1!);

      // Runner 2: complete task B (slow path — LLM execution)
      // copy2 is stale — does NOT have decomposition data
      const b2 = copy2!.subTasks.find(t => t.id === "p32-dec-b")!;
      b2.status = "completed";
      b2.completedAt = Date.now();
      b2.output = "Result of B";

      // Runner 2 saves (stale copy that lacks decomposition)
      await manager.save(copy2!);

      // Verify: both decomposition AND completion are preserved
      const result = await manager.load(testSessionId);
      const ra = result!.subTasks.find(t => t.id === "p32-dec-a")!;
      expect(ra.decomposed).toBe(true);
      expect(ra.status).toBe("active");

      expect(result!.subTasks.find(t => t.id === "p32-dec-a-seg-1")).toBeDefined();
      expect(result!.subTasks.find(t => t.id === "p32-dec-a-seg-2")).toBeDefined();

      const rb = result!.subTasks.find(t => t.id === "p32-dec-b")!;
      expect(rb.status).toBe("completed");
      expect(rb.output).toBe("Result of B");
    });

    it("should handle restart (status regression with higher retryCount)", async () => {
      const taskTree = await manager.initialize("root", testSessionId);

      const task: SubTask = {
        id: "p32-restart", prompt: "T", summary: "T",
        status: "pending", retryCount: 0, createdAt: Date.now(),
        depth: 0, parentId: null, children: [],
      };
      await manager.addSubTask(taskTree, null, task);

      // Runner loads, sets active, then restarts (pending + retryCount++)
      const copy = await manager.load(testSessionId);
      const t = copy!.subTasks.find(t => t.id === "p32-restart")!;
      t.status = "pending";
      t.retryCount = 1;

      await manager.save(copy!);

      const result = await manager.load(testSessionId);
      const rt = result!.subTasks.find(t => t.id === "p32-restart")!;
      expect(rt.status).toBe("pending");
      expect(rt.retryCount).toBe(1);
    });
  });
});
