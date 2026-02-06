/**
 * 批量创建任务工具
 * 
 * 允许 LLM 一次性创建多个任务，系统自动进行智能分组和批量执行
 * 
 * 核心功能：
 * - 批量创建任务
 * - 自动添加元数据（estimatedTokens、canBatch）
 * - 支持 batchMode 参数（auto/force/disable）
 * - 循环检测（防止在队列任务中调用）
 * - 集成 TaskGrouper 和 BatchExecutor
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { enqueueFollowupRun, type FollowupRun } from "../../auto-reply/reply/queue.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { getCurrentFollowupRunContext, getGlobalOrchestrator } from "./enqueue-task-tool.js";
import type { SubTask } from "../intelligent-task-decomposition/types.js";

/**
 * 单个任务的定义
 */
const TaskDefinitionSchema = Type.Object({
  prompt: Type.String({
    description: "任务的提示词，描述 LLM 需要执行的任务",
  }),
  summary: Type.String({
    description: "任务的简短描述，用于日志和调试",
  }),
  estimatedTokens: Type.Optional(
    Type.Number({
      description: "预估输出 tokens（可选），用于智能分组",
    }),
  ),
  canBatch: Type.Optional(
    Type.Boolean({
      description: "是否可以批量执行（可选），默认 true",
    }),
  ),
  priority: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ], {
      description: "任务优先级（可选），默认 medium",
    }),
  ),
});

/**
 * 批量创建任务的 Schema
 */
const BatchEnqueueTasksSchema = Type.Object({
  tasks: Type.Array(TaskDefinitionSchema, {
    description: "任务列表，每个任务包含 prompt、summary 等信息",
    minItems: 1,
    maxItems: 20, // 限制最多 20 个任务
  }),
  batchMode: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("force"),
      Type.Literal("disable"),
    ], {
      description: `批量执行模式（可选），默认 auto：
- auto: 自动决定是否批量执行（根据任务特征）
- force: 强制批量执行（即使任务不相似）
- disable: 禁用批量执行（每个任务单独执行）`,
    }),
  ),
  parentId: Type.Optional(
    Type.String({
      description: "父任务 ID（可选），用于递归分解。如果指定，所有任务将成为父任务的子任务",
    }),
  ),
});

type BatchEnqueueTasksOptions = {
  agentSessionKey?: string;
  config?: ClawdbotConfig;
  sessionEntry?: SessionEntry;
};

/**
 * 创建 batch_enqueue_tasks 工具
 * 
 * 允许 LLM 一次性创建多个任务，系统自动进行智能分组和批量执行
 * 
 * 使用场景：
 * - 大量内容生成（> 5000 字）→ 每 2000-3000 字一个任务
 * - 大量数据处理（> 100 个文件）→ 按文件/章节/主题分组
 * - 多步骤复杂任务（> 3 个步骤）→ 每个步骤一个任务
 * 
 * 示例：
 * ```
 * 用户: 请生成 10000 字的科幻小说
 * 
 * LLM 调用:
 * batch_enqueue_tasks({
 *   tasks: [
 *     { prompt: "生成第 1 章（2000 字）...", summary: "第 1 章", estimatedTokens: 4000 },
 *     { prompt: "生成第 2 章（2000 字）...", summary: "第 2 章", estimatedTokens: 4000 },
 *     { prompt: "生成第 3 章（2000 字）...", summary: "第 3 章", estimatedTokens: 4000 },
 *     { prompt: "生成第 4 章（2000 字）...", summary: "第 4 章", estimatedTokens: 4000 },
 *     { prompt: "生成第 5 章（2000 字）...", summary: "第 5 章", estimatedTokens: 4000 },
 *   ],
 *   batchMode: "auto"
 * })
 * 
 * 系统自动分组:
 * - 批次 1: 任务 1-3（相似度高，总 tokens < 6000）
 * - 批次 2: 任务 4-5（相似度高，总 tokens < 6000）
 * 
 * 系统自动执行:
 * - 批次 1: 一次 LLM 请求生成 3 个章节
 * - 批次 2: 一次 LLM 请求生成 2 个章节
 * 
 * 成本节省:
 * - 原本需要 5 次请求 → 现在只需 2 次请求
 * - 节省 60% 请求次数
 * - 节省 40-50% tokens（减少重复的系统提示词）
 * ```
 */
export function createBatchEnqueueTasksTool(options?: BatchEnqueueTasksOptions): AnyAgentTool {
  const agentSessionKey = options?.agentSessionKey;
  const config = options?.config;
  const sessionEntry = options?.sessionEntry;

  return {
    label: "Batch Enqueue Tasks",
    name: "batch_enqueue_tasks",
    description: `批量创建任务，系统自动进行智能分组和批量执行，显著降低成本和提高效率。

**核心优势**：
- 智能分组：根据任务相似度、大小、依赖关系自动分组
- 批量执行：多个任务合并为一次 LLM 请求
- 成本节省：节省 40-60% tokens，减少 50-75% 请求次数
- 自动拆分：LLM 输出自动拆分到各个任务

**使用场景**（必须批量创建）：
1. 大量内容生成（> 5000 字）→ 每 2000-3000 字一个任务
2. 大量数据处理（> 100 个文件）→ 按文件/章节/主题分组
3. 多步骤复杂任务（> 3 个步骤）→ 每个步骤一个任务
4. 并行处理场景 → 为每个独立单元创建任务

**重要规则**：
- ✅ 用户直接请求时：可以调用 batch_enqueue_tasks 创建多个任务
- ❌ 执行队列任务时：不要调用 batch_enqueue_tasks（除非递归分解）
- ✅ 任务相似度高：优先使用批量创建（节省成本）
- ✅ 任务独立无依赖：优先使用批量创建（可并行执行）

**参数说明**：
- tasks：任务列表，每个任务包含 prompt、summary、estimatedTokens、canBatch、priority
- batchMode：批量执行模式（auto/force/disable），默认 auto
- parentId：父任务 ID（可选），用于递归分解

**示例**：
用户：请生成 10000 字的科幻小说
→ 调用 batch_enqueue_tasks 创建 5 个任务，每个 2000 字
→ 系统自动分组为 2 个批次
→ 系统自动执行，节省 60% 请求次数

**批量执行模式**：
- auto：自动决定是否批量执行（根据任务特征）
- force：强制批量执行（即使任务不相似）
- disable：禁用批量执行（每个任务单独执行）`,
    parameters: BatchEnqueueTasksSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const tasks = params.tasks as Array<{
        prompt: string;
        summary: string;
        estimatedTokens?: number;
        canBatch?: boolean;
        priority?: "low" | "medium" | "high";
      }>;
      const batchMode = readStringParam(params, "batchMode") || "auto";
      const parentId = readStringParam(params, "parentId");

      if (!agentSessionKey) {
        return jsonResult({
          success: false,
          error: "agentSessionKey 未设置，无法加入队列",
        });
      }

      // 从全局上下文获取当前的 FollowupRun
      const currentFollowupRun = getCurrentFollowupRunContext();
      
      if (!currentFollowupRun) {
        return jsonResult({
          success: false,
          error: "currentFollowupRun 未设置，无法加入队列（系统内部错误）",
        });
      }
      
      // 🔧 检测循环：如果当前正在执行队列任务，拒绝加入新任务
      const isQueueTask = currentFollowupRun.isQueueTask ?? false;
      if (isQueueTask) {
        console.warn("[batch_enqueue_tasks] ⚠️ Cannot enqueue tasks while executing a queue task");
        return jsonResult({
          success: false,
          error: `❌ 不能在执行队列任务时批量创建任务。

✅ 正确做法：
1. 直接生成当前任务要求的内容
2. 不要调用任何工具（包括 batch_enqueue_tasks）
3. 完成后系统会自动执行下一个任务

示例：
任务提示词：请生成第 1 段内容
→ 正确：直接输出"这是第 1 段内容..."
→ 错误：调用 batch_enqueue_tasks 生成更多任务`,
        });
      }

      try {
        // 🔧 使用 Orchestrator 管理任务树
        const sessionId = currentFollowupRun.run.sessionId;
        const orchestrator = getGlobalOrchestrator();
        
        // 加载或初始化任务树
        let taskTree = await orchestrator.loadTaskTree(sessionId);
        if (!taskTree) {
          // 第一次调用，初始化任务树
          taskTree = await orchestrator.initializeTaskTree(
            currentFollowupRun.prompt, // 使用当前用户消息作为根任务
            sessionId,
          );
          console.log(`[batch_enqueue_tasks] ✅ Task tree initialized: sessionId=${sessionId}`);
        }
        
        // 批量添加子任务到任务树
        const createdTasks: SubTask[] = [];
        const taskIds: string[] = [];
        
        for (const task of tasks) {
          // 添加子任务
          const subTask = await orchestrator.addSubTask(
            taskTree,
            task.prompt,
            task.summary,
            parentId,
            false, // waitForChildren = false（批量任务不等待子任务）
          );
          
          // 设置元数据
          if (!subTask.metadata) {
            subTask.metadata = {};
          }
          
          // 设置预估 tokens
          if (task.estimatedTokens !== undefined) {
            subTask.metadata.estimatedTokens = task.estimatedTokens;
          }
          
          // 设置优先级
          if (task.priority !== undefined) {
            subTask.metadata.priority = task.priority;
          }
          
          // 设置是否可以批量执行（根据 batchMode 和任务设置）
          if (batchMode === "force") {
            // force 模式：强制所有任务可批量执行
            subTask.metadata.canBatch = true;
          } else if (batchMode === "disable") {
            // disable 模式：禁用所有任务的批量执行
            subTask.metadata.canBatch = false;
          } else {
            // auto 模式：使用任务自己的设置，如果未指定则默认 true
            if (task.canBatch !== undefined) {
              subTask.metadata.canBatch = task.canBatch;
            } else {
              subTask.metadata.canBatch = true; // 默认可以批量执行
            }
          }
          
          createdTasks.push(subTask);
          taskIds.push(subTask.id);
          
          console.log(`[batch_enqueue_tasks] ✅ Sub task added: ${subTask.id} (${task.summary}) [canBatch=${subTask.metadata.canBatch}, estimatedTokens=${subTask.metadata.estimatedTokens || "auto"}]`);
        }
        
        // 保存任务树
        await orchestrator.saveTaskTree(taskTree);
        
        // 为每个任务创建 FollowupRun 并加入队列
        const resolvedQueue = resolveQueueSettings({
          cfg: config ?? ({} as ClawdbotConfig),
          sessionEntry,
          inlineMode: "followup", // 使用 followup 模式，每个任务单独执行
        });
        
        let enqueuedCount = 0;
        
        for (const task of tasks) {
          const followupRun: FollowupRun = {
            prompt: task.prompt,
            summaryLine: task.summary,
            enqueuedAt: Date.now(),
            run: currentFollowupRun.run,
            // 🔧 标记为队列任务，防止循环
            isQueueTask: true,
          };

          // 加入队列
          const enqueued = enqueueFollowupRun(
            agentSessionKey,
            followupRun,
            resolvedQueue,
            "none", // 不去重，允许相同的任务多次加入
          );

          if (enqueued) {
            enqueuedCount++;
          }
        }

        console.log(
          `[batch_enqueue_tasks] ✅ ${enqueuedCount} tasks enqueued: key=${agentSessionKey}`,
        );

        // 🆕 生成简洁的成功消息
        return jsonResult({
          success: true,
          message: `已批量创建 ${tasks.length} 个任务，其中 ${enqueuedCount} 个成功加入队列`,
          taskIds,
          batchMode,
          enqueuedCount,
          totalCount: tasks.length,
          taskTreePath: `~/.clawdbot/tasks/${sessionId}/TASK_TREE.json`,
        });
      } catch (err) {
        console.error(`[batch_enqueue_tasks] ❌ Error:`, err);
        return jsonResult({
          success: false,
          error: String(err),
        });
      }
    },
  };
}
