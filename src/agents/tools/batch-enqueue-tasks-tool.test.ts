/**
 * 批量创建任务工具 - 单元测试
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createBatchEnqueueTasksTool } from "./batch-enqueue-tasks-tool.js";
import { setCurrentFollowupRunContext, getGlobalOrchestrator } from "./enqueue-task-tool.js";
import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import type { TaskTree } from "../intelligent-task-decomposition/types.js";

// Mock dependencies
vi.mock("../../auto-reply/reply/queue.js", () => ({
  enqueueFollowupRun: vi.fn(() => true),
}));

vi.mock("../../auto-reply/reply/queue/settings.js", () => ({
  resolveQueueSettings: vi.fn(() => ({})),
}));

describe("batch_enqueue_tasks 工具", () => {
  let testCounter = 0;
  
  const getUniqueSessionId = () => {
    testCounter++;
    return `test-session-${testCounter}-${Date.now()}`;
  };
  
  const mockAgentSessionKey = "test-agent-key";
  
  beforeEach(() => {
    // 清理全局状态
    setCurrentFollowupRunContext(null);
    vi.clearAllMocks();
  });

  describe("基本功能", () => {
    it("应该成功创建批量任务", async () => {
      const mockSessionId = getUniqueSessionId();
      
      // 准备测试数据
      const mockFollowupRun: FollowupRun = {
        prompt: "用户请求",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: false,
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      // 创建工具
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      // 准备任务列表
      const tasks = [
        {
          prompt: "生成第 1 章（2000 字）",
          summary: "第 1 章",
          estimatedTokens: 4000,
          canBatch: true,
          priority: "high" as const,
        },
        {
          prompt: "生成第 2 章（2000 字）",
          summary: "第 2 章",
          estimatedTokens: 4000,
          canBatch: true,
          priority: "high" as const,
        },
        {
          prompt: "生成第 3 章（2000 字）",
          summary: "第 3 章",
          estimatedTokens: 4000,
          canBatch: true,
          priority: "high" as const,
        },
      ];
      
      // 执行工具
      const result = await tool.execute("test-call-id", {
        tasks,
        batchMode: "auto",
      });
      
      // 验证结果
      expect(result).toBeDefined();
      expect(result.details).toBeDefined();
      const resultObj = result.details as any;
      expect(resultObj.success).toBe(true);
      expect(resultObj.taskIds).toHaveLength(3);
      expect(resultObj.enqueuedCount).toBe(3);
      expect(resultObj.totalCount).toBe(3);
      expect(resultObj.batchMode).toBe("auto");
    });

    it("应该正确设置任务元数据", async () => {
      const mockSessionId = getUniqueSessionId();
      
      // 准备测试数据
      const mockFollowupRun: FollowupRun = {
        prompt: "用户请求",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: false,
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      // 创建工具
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      // 准备任务列表
      const tasks = [
        {
          prompt: "任务 1",
          summary: "任务 1",
          estimatedTokens: 2000,
          canBatch: true,
          priority: "high" as const,
        },
        {
          prompt: "任务 2",
          summary: "任务 2",
          estimatedTokens: 3000,
          canBatch: false,
          priority: "low" as const,
        },
      ];
      
      // 执行工具
      const result = await tool.execute("test-call-id", {
        tasks,
        batchMode: "auto",
      });
      
      // 验证结果
      const resultObj = result.details as any;
      expect(resultObj.success).toBe(true);
      
      // 验证任务树中的元数据
      const orchestrator = getGlobalOrchestrator();
      const taskTree = await orchestrator.loadTaskTree(mockSessionId);
      
      expect(taskTree).toBeDefined();
      expect(taskTree!.subTasks).toHaveLength(2);
      
      const task1 = taskTree!.subTasks[0];
      expect(task1.metadata?.estimatedTokens).toBe(2000);
      expect(task1.metadata?.canBatch).toBe(true);
      expect(task1.metadata?.priority).toBe("high");
      
      const task2 = taskTree!.subTasks[1];
      expect(task2.metadata?.estimatedTokens).toBe(3000);
      expect(task2.metadata?.canBatch).toBe(false);
      expect(task2.metadata?.priority).toBe("low");
    });
  });

  describe("批量执行模式", () => {
    it("batchMode=auto 应该保持原始 canBatch 设置", async () => {
      const mockSessionId = getUniqueSessionId();
      
      const mockFollowupRun: FollowupRun = {
        prompt: "用户请求",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: false,
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      const tasks = [
        { prompt: "任务 1", summary: "任务 1", canBatch: true },
        { prompt: "任务 2", summary: "任务 2", canBatch: false },
      ];
      
      await tool.execute("test-call-id", {
        tasks,
        batchMode: "auto",
      });
      
      const orchestrator = getGlobalOrchestrator();
      const taskTree = await orchestrator.loadTaskTree(mockSessionId);
      
      expect(taskTree!.subTasks[0].metadata?.canBatch).toBe(true);
      expect(taskTree!.subTasks[1].metadata?.canBatch).toBe(false);
    });

    it("batchMode=force 应该强制所有任务可批量执行", async () => {
      const mockSessionId = getUniqueSessionId();
      
      const mockFollowupRun: FollowupRun = {
        prompt: "用户请求",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: false,
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      const tasks = [
        { prompt: "任务 1", summary: "任务 1", canBatch: false },
        { prompt: "任务 2", summary: "任务 2", canBatch: false },
      ];
      
      await tool.execute("test-call-id", {
        tasks,
        batchMode: "force",
      });
      
      const orchestrator = getGlobalOrchestrator();
      const taskTree = await orchestrator.loadTaskTree(mockSessionId);
      
      expect(taskTree!.subTasks[0].metadata?.canBatch).toBe(true);
      expect(taskTree!.subTasks[1].metadata?.canBatch).toBe(true);
    });

    it("batchMode=disable 应该禁用所有任务的批量执行", async () => {
      const mockSessionId = getUniqueSessionId();
      
      const mockFollowupRun: FollowupRun = {
        prompt: "用户请求",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: false,
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      const tasks = [
        { prompt: "任务 1", summary: "任务 1", canBatch: true },
        { prompt: "任务 2", summary: "任务 2", canBatch: true },
      ];
      
      await tool.execute("test-call-id", {
        tasks,
        batchMode: "disable",
      });
      
      const orchestrator = getGlobalOrchestrator();
      const taskTree = await orchestrator.loadTaskTree(mockSessionId);
      
      expect(taskTree!.subTasks[0].metadata?.canBatch).toBe(false);
      expect(taskTree!.subTasks[1].metadata?.canBatch).toBe(false);
    });
  });

  describe("循环检测", () => {
    it("应该拒绝在队列任务中创建批量任务", async () => {
      const mockSessionId = getUniqueSessionId();
      
      // 准备测试数据（isQueueTask = true）
      const mockFollowupRun: FollowupRun = {
        prompt: "队列任务",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: true, // 标记为队列任务
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      // 创建工具
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      // 尝试创建任务
      const result = await tool.execute("test-call-id", {
        tasks: [
          { prompt: "任务 1", summary: "任务 1" },
        ],
        batchMode: "auto",
      });
      
      // 验证结果
      const resultObj = result.details as any;
      expect(resultObj.success).toBe(false);
      expect(resultObj.error).toContain("不能在执行队列任务时批量创建任务");
    });
  });

  describe("错误处理", () => {
    it("应该处理 agentSessionKey 未设置的情况", async () => {
      const tool = createBatchEnqueueTasksTool({
        // agentSessionKey 未设置
      });
      
      const result = await tool.execute("test-call-id", {
        tasks: [
          { prompt: "任务 1", summary: "任务 1" },
        ],
      });
      
      const resultObj = result.details as any;
      expect(resultObj.success).toBe(false);
      expect(resultObj.error).toContain("agentSessionKey 未设置");
    });

    it("应该处理 currentFollowupRun 未设置的情况", async () => {
      // currentFollowupRun 未设置
      setCurrentFollowupRunContext(null);
      
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      const result = await tool.execute("test-call-id", {
        tasks: [
          { prompt: "任务 1", summary: "任务 1" },
        ],
      });
      
      const resultObj = result.details as any;
      expect(resultObj.success).toBe(false);
      expect(resultObj.error).toContain("currentFollowupRun 未设置");
    });
  });

  describe("父任务关联", () => {
    it("应该正确关联父任务", async () => {
      const mockSessionId = getUniqueSessionId();
      
      const mockFollowupRun: FollowupRun = {
        prompt: "用户请求",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: false,
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      // 先创建父任务
      const orchestrator = getGlobalOrchestrator();
      let taskTree = await orchestrator.loadTaskTree(mockSessionId);
      if (!taskTree) {
        taskTree = await orchestrator.initializeTaskTree("根任务", mockSessionId);
      }
      
      const parentTask = await orchestrator.addSubTask(
        taskTree,
        "父任务",
        "父任务",
        undefined,
        true, // waitForChildren = true
      );
      
      // 创建子任务
      await tool.execute("test-call-id", {
        tasks: [
          { prompt: "子任务 1", summary: "子任务 1" },
          { prompt: "子任务 2", summary: "子任务 2" },
        ],
        parentId: parentTask.id,
      });
      
      // 验证父子关系
      taskTree = await orchestrator.loadTaskTree(mockSessionId);
      const childTasks = taskTree!.subTasks.filter(t => t.parentId === parentTask.id);
      
      expect(childTasks).toHaveLength(2);
      expect(childTasks[0].summary).toBe("子任务 1");
      expect(childTasks[1].summary).toBe("子任务 2");
    });
  });

  describe("默认值处理", () => {
    it("应该为未指定 canBatch 的任务设置默认值 true", async () => {
      const mockSessionId = getUniqueSessionId();
      
      const mockFollowupRun: FollowupRun = {
        prompt: "用户请求",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: false,
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      await tool.execute("test-call-id", {
        tasks: [
          { prompt: "任务 1", summary: "任务 1" }, // 未指定 canBatch
        ],
      });
      
      const orchestrator = getGlobalOrchestrator();
      const taskTree = await orchestrator.loadTaskTree(mockSessionId);
      
      expect(taskTree!.subTasks[0].metadata?.canBatch).toBe(true);
    });

    it("应该为未指定 batchMode 的请求使用默认值 auto", async () => {
      const mockSessionId = getUniqueSessionId();
      
      const mockFollowupRun: FollowupRun = {
        prompt: "用户请求",
        enqueuedAt: Date.now(),
        run: {
          sessionId: mockSessionId,
        } as any,
        isQueueTask: false,
      };
      
      setCurrentFollowupRunContext(mockFollowupRun);
      
      const tool = createBatchEnqueueTasksTool({
        agentSessionKey: mockAgentSessionKey,
      });
      
      const result = await tool.execute("test-call-id", {
        tasks: [
          { prompt: "任务 1", summary: "任务 1" },
        ],
        // 未指定 batchMode
      });
      
      const resultObj = result.details as any;
      expect(resultObj.batchMode).toBe("auto");
    });
  });
});
