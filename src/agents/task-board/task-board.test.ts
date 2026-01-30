/**
 * 任务看板基本功能测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createTaskDecomposer,
  createProgressTracker,
  createTaskExecutor,
  createFailureHandler,
  createOrchestrator,
  createSelfImprovementEngine,
  saveTaskBoard,
  loadTaskBoard,
  taskBoardExists,
  deleteTaskBoard,
  renderToJSON,
  renderToMarkdown
} from "./index.js";
import type { MainTask, SubTask, TaskBoard } from "./types.js";

describe("TaskBoard - Basic Functionality", () => {
  const testSessionId = "test_session_" + Date.now();
  const testTaskBoardDir = join(homedir(), ".clawdbot", "tasks", testSessionId);

  beforeEach(() => {
    // 清理测试目录
    if (existsSync(testTaskBoardDir)) {
      rmSync(testTaskBoardDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testTaskBoardDir)) {
      rmSync(testTaskBoardDir, { recursive: true, force: true });
    }
  });

  describe("TaskDecomposer", () => {
    it("should identify complex tasks", async () => {
      const decomposer = createTaskDecomposer();
      
      // 简单任务
      const simpleTask = "创建一个文件";
      expect(await decomposer.shouldDecompose(simpleTask)).toBe(false);
      
      // 复杂任务（长度 > 200）
      const longTask = "a".repeat(201);
      expect(await decomposer.shouldDecompose(longTask)).toBe(true);
      
      // 复杂任务（多个动词）
      const multiVerbTask = "创建、修改、测试和部署应用";
      expect(await decomposer.shouldDecompose(multiVerbTask)).toBe(true);
    });

    it("should decompose tasks into sub-tasks", async () => {
      const decomposer = createTaskDecomposer();
      const task = "创建任务分解和跟踪机制";
      const context = {
        codebase: process.cwd(),
        recentMessages: []
      };

      const subTasks = await decomposer.decompose(task, context);
      
      expect(subTasks.length).toBeGreaterThanOrEqual(2);
      expect(subTasks.length).toBeLessThanOrEqual(8);
      expect(subTasks[0]).toHaveProperty("id");
      expect(subTasks[0]).toHaveProperty("title");
      expect(subTasks[0]).toHaveProperty("description");
      expect(subTasks[0]).toHaveProperty("status");
      expect(subTasks[0]).toHaveProperty("dependencies");
    });
  });

  describe("ProgressTracker", () => {
    it("should initialize task board", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      const subTasks: SubTask[] = [
        {
          id: "T1",
          title: "子任务 1",
          description: "测试子任务 1",
          status: "pending",
          progress: "0%",
          dependencies: [],
          outputs: [],
          notes: ""
        }
      ];

      const taskBoard = await tracker.initialize(mainTask, subTasks);
      
      expect(taskBoard.sessionId).toBe(testSessionId);
      expect(taskBoard.mainTask).toEqual(mainTask);
      expect(taskBoard.subTasks).toEqual(subTasks);
      expect(taskBoard.checkpoints).toEqual([]);
      expect(taskBoard.risksAndBlocks).toEqual([]);
    });

    it("should update sub-task status", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      const subTasks: SubTask[] = [
        {
          id: "T1",
          title: "子任务 1",
          description: "测试子任务 1",
          status: "pending",
          progress: "0%",
          dependencies: [],
          outputs: [],
          notes: ""
        }
      ];

      await tracker.initialize(mainTask, subTasks);
      await tracker.updateSubTaskStatus("T1", "completed", "100%");
      
      const taskBoard = await tracker.getTaskBoard();
      expect(taskBoard.subTasks[0].status).toBe("completed");
      expect(taskBoard.subTasks[0].progress).toBe("100%");
    });

    it("should create checkpoints", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      await tracker.initialize(mainTask, []);
      await tracker.createCheckpoint(
        "测试检查点",
        ["决策 1", "决策 2"],
        ["问题 1"]
      );
      
      const taskBoard = await tracker.getTaskBoard();
      expect(taskBoard.checkpoints.length).toBe(1);
      expect(taskBoard.checkpoints[0].summary).toBe("测试检查点");
      expect(taskBoard.checkpoints[0].decisions).toEqual(["决策 1", "决策 2"]);
      expect(taskBoard.checkpoints[0].openQuestions).toEqual(["问题 1"]);
    });

    it("should add context anchors", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      await tracker.initialize(mainTask, []);
      await tracker.addContextAnchor("code_location", "src/test.ts::testFunction");
      await tracker.addContextAnchor("command", "pnpm test");
      
      const taskBoard = await tracker.getTaskBoard();
      expect(taskBoard.contextAnchors.codeLocations).toContain("src/test.ts::testFunction");
      expect(taskBoard.contextAnchors.commands).toContain("pnpm test");
    });

    it("should limit context anchors to 10", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      await tracker.initialize(mainTask, []);
      
      // 添加 15 个锚点
      for (let i = 0; i < 15; i++) {
        await tracker.addContextAnchor("code_location", `src/test${i}.ts`);
      }
      
      const taskBoard = await tracker.getTaskBoard();
      expect(taskBoard.contextAnchors.codeLocations.length).toBe(10);
    });
  });

  describe("Persistence", () => {
    it("should save and load task board", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      const subTasks: SubTask[] = [
        {
          id: "T1",
          title: "子任务 1",
          description: "测试子任务 1",
          status: "pending",
          progress: "0%",
          dependencies: [],
          outputs: [],
          notes: ""
        }
      ];

      const originalBoard = await tracker.initialize(mainTask, subTasks);
      await tracker.persist();
      
      // 验证文件存在
      expect(taskBoardExists(testSessionId)).toBe(true);
      
      // 加载任务看板
      const loadedBoard = await loadTaskBoard(testSessionId);
      
      expect(loadedBoard).not.toBeNull();
      expect(loadedBoard!.sessionId).toBe(originalBoard.sessionId);
      expect(loadedBoard!.mainTask).toEqual(originalBoard.mainTask);
      expect(loadedBoard!.subTasks).toEqual(originalBoard.subTasks);
    });

    it("should delete task board", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      await tracker.initialize(mainTask, []);
      await tracker.persist();
      
      expect(taskBoardExists(testSessionId)).toBe(true);
      
      await deleteTaskBoard(testSessionId);
      
      expect(taskBoardExists(testSessionId)).toBe(false);
    });
  });

  describe("Renderer", () => {
    it("should render task board to JSON", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      const taskBoard = await tracker.initialize(mainTask, []);
      const json = renderToJSON(taskBoard);
      
      expect(json).toContain('"sessionId"');
      expect(json).toContain('"mainTask"');
      expect(json).toContain('"subTasks"');
      
      // 验证可以解析回对象
      const parsed = JSON.parse(json);
      expect(parsed.sessionId).toBe(testSessionId);
    });

    it("should render task board to Markdown", async () => {
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      const taskBoard = await tracker.initialize(mainTask, []);
      const markdown = renderToMarkdown(taskBoard);
      
      expect(markdown).toContain("# 任务看板");
      expect(markdown).toContain("## 主任务");
      expect(markdown).toContain("## 子任务");
      expect(markdown).toContain("## 当前焦点");
      expect(markdown).toContain("## 检查点");
      expect(markdown).toContain("## 风险和阻塞");
      expect(markdown).toContain("## 上下文锚点");
    });
  });

  describe("FailureHandler", () => {
    it("should analyze failure", async () => {
      const handler = createFailureHandler();
      
      const subTask: SubTask = {
        id: "T1",
        title: "测试子任务",
        description: "测试失败处理",
        status: "active",
        progress: "50%",
        dependencies: [],
        outputs: [],
        notes: ""
      };

      const error = new Error("ENOENT: file not found");
      const summary = await handler.analyzeFailure(subTask, error);
      
      expect(summary.subTaskId).toBe("T1");
      expect(summary.errorType).toBe("file_not_found");
      expect(summary.rootCause).toContain("文件或目录不存在");
      expect(summary.suggestedFix).toContain("检查文件路径");
    });

    it("should suggest rule creation for reusable patterns", async () => {
      const handler = createFailureHandler();
      
      const summary = {
        subTaskId: "T1",
        errorType: "file_not_found",
        rootCause: "文件不存在",
        context: "...",
        suggestedFix: "..."
      };

      const shouldCreate = await handler.suggestRuleCreation(summary);
      expect(shouldCreate).toBe(true);
    });
  });

  describe("SelfImprovementEngine", () => {
    it("should identify reusable patterns", async () => {
      const engine = createSelfImprovementEngine();
      const tracker = createProgressTracker(testSessionId);
      
      const mainTask: MainTask = {
        title: "测试任务",
        objective: "测试任务看板功能",
        status: "active",
        progress: "0%"
      };

      const subTasks: SubTask[] = [
        {
          id: "T1",
          title: "分析需求",
          description: "分析任务需求",
          status: "completed",
          progress: "100%",
          dependencies: [],
          outputs: [],
          notes: ""
        },
        {
          id: "T2",
          title: "设计方案",
          description: "设计技术方案",
          status: "completed",
          progress: "100%",
          dependencies: ["T1"],
          outputs: [],
          notes: ""
        },
        {
          id: "T3",
          title: "实现功能",
          description: "实现功能",
          status: "completed",
          progress: "100%",
          dependencies: ["T2"],
          outputs: [],
          notes: ""
        },
        {
          id: "T4",
          title: "测试验证",
          description: "测试功能",
          status: "completed",
          progress: "100%",
          dependencies: ["T3"],
          outputs: [],
          notes: ""
        }
      ];

      const taskBoard = await tracker.initialize(mainTask, subTasks);
      const patterns = engine.identifyReusablePatterns(taskBoard);
      
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0]).toHaveProperty("name");
      expect(patterns[0]).toHaveProperty("description");
      expect(patterns[0]).toHaveProperty("steps");
    });
  });
});
