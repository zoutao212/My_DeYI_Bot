import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { enqueueFollowupRun, type FollowupRun } from "../../auto-reply/reply/queue.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { Orchestrator } from "../intelligent-task-decomposition/orchestrator.js";

const EnqueueTaskSchema = Type.Object({
  prompt: Type.String({
    description: "任务的提示词，描述 LLM 需要执行的任务",
  }),
  summary: Type.Optional(
    Type.String({
      description: "任务的简短描述（可选），用于日志和调试",
    }),
  ),
});

type EnqueueTaskOptions = {
  agentSessionKey?: string;
  config?: ClawdbotConfig;
  sessionEntry?: SessionEntry;
};

/**
 * 全局上下文：存储当前正在执行的 FollowupRun
 * 
 * 这是一个临时解决方案，用于在工具执行时访问当前的 run 上下文。
 * 在 agent-runner 中设置，在 enqueue_task 工具中读取。
 */
let currentFollowupRunContext: FollowupRun | null = null;

/**
 * 全局 Orchestrator 实例
 * 
 * 用于管理任务树的持久化和恢复
 */
const globalOrchestrator = new Orchestrator();

/**
 * 设置当前的 FollowupRun 上下文
 * 
 * 应该在 agent-runner 开始执行时调用。
 * 
 * @param followupRun - 当前的 FollowupRun 对象
 */
export function setCurrentFollowupRunContext(followupRun: FollowupRun | null): void {
  currentFollowupRunContext = followupRun;
}

/**
 * 获取当前的 FollowupRun 上下文
 */
export function getCurrentFollowupRunContext(): FollowupRun | null {
  return currentFollowupRunContext;
}

/**
 * 获取全局 Orchestrator 实例
 */
export function getGlobalOrchestrator(): Orchestrator {
  return globalOrchestrator;
}

/**
 * 创建 enqueue_task 工具
 * 
 * 允许 LLM 主动将任务加入队列，实现连续任务生成。
 * 
 * 使用场景：
 * - LLM 需要生成多段内容，每段单独回复
 * - LLM 需要执行一系列关联任务
 * - LLM 需要分步骤完成复杂任务
 * 
 * 示例：
 * ```
 * 用户: 请生成 5 段内容
 * 
 * LLM 第 1 次回复:
 * → 调用 enqueue_task({ prompt: "生成第 2 段内容", summary: "第 2 段" })
 * → 调用 enqueue_task({ prompt: "生成第 3 段内容", summary: "第 3 段" })
 * → 调用 enqueue_task({ prompt: "生成第 4 段内容", summary: "第 4 段" })
 * → 调用 enqueue_task({ prompt: "生成第 5 段内容", summary: "第 5 段" })
 * → 回复第 1 段内容
 * 
 * 系统自动执行队列:
 * → 执行任务 2: LLM 生成第 2 段内容
 * → 执行任务 3: LLM 生成第 3 段内容
 * → 执行任务 4: LLM 生成第 4 段内容
 * → 执行任务 5: LLM 生成第 5 段内容
 * ```
 */
export function createEnqueueTaskTool(options?: EnqueueTaskOptions): AnyAgentTool {
  const agentSessionKey = options?.agentSessionKey;
  const config = options?.config;
  const sessionEntry = options?.sessionEntry;

  return {
    label: "Enqueue Task",
    name: "enqueue_task",
    description:
      "将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。",
    parameters: EnqueueTaskSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const prompt = readStringParam(params, "prompt", { required: true });
      const summary = readStringParam(params, "summary");

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
        console.warn("[enqueue_task] ⚠️ Cannot enqueue task while executing a queue task");
        return jsonResult({
          success: false,
          error: `❌ 不能在执行队列任务时加入新任务。

✅ 正确做法：
1. 直接生成当前任务要求的内容
2. 不要调用任何工具（包括 enqueue_task）
3. 完成后系统会自动执行下一个任务

示例：
任务提示词：请生成第 1 段内容
→ 正确：直接输出"这是第 1 段内容..."
→ 错误：调用 enqueue_task 生成更多任务`,
        });
      }

      try {
        // 🔧 使用 Orchestrator 管理任务树
        const sessionId = currentFollowupRun.run.sessionId;
        
        // 加载或初始化任务树
        let taskTree = await globalOrchestrator.loadTaskTree(sessionId);
        if (!taskTree) {
          // 第一次调用 enqueue_task，初始化任务树
          taskTree = await globalOrchestrator.initializeTaskTree(
            currentFollowupRun.prompt, // 使用当前用户消息作为根任务
            sessionId,
          );
          console.log(`[enqueue_task] ✅ Task tree initialized: sessionId=${sessionId}`);
        }
        
        // 添加子任务到任务树
        const subTask = await globalOrchestrator.addSubTask(taskTree, prompt, summary || prompt);
        console.log(`[enqueue_task] ✅ Sub task added to tree: ${subTask.id} (${summary || "none"})`);
        
        // 构建 FollowupRun
        const followupRun: FollowupRun = {
          prompt,
          summaryLine: summary,
          enqueuedAt: Date.now(),
          run: currentFollowupRun.run,
          // 🔧 标记为队列任务，防止循环
          isQueueTask: true,
        };

        // 解析队列设置
        const resolvedQueue = resolveQueueSettings({
          cfg: config ?? ({} as ClawdbotConfig),
          sessionEntry,
          inlineMode: "followup", // 使用 followup 模式，每个任务单独执行
        });

        // 加入队列
        const enqueued = enqueueFollowupRun(
          agentSessionKey,
          followupRun,
          resolvedQueue,
          "none", // 不去重，允许相同的任务多次加入
        );

        if (!enqueued) {
          return jsonResult({
            success: false,
            error: "任务加入队列失败（可能被去重或队列已满）",
          });
        }

        console.log(
          `[enqueue_task] ✅ Task enqueued: key=${agentSessionKey}, summary=${summary || "none"}`,
        );

        // 🆕 生成任务看板摘要
        const completedCount = taskTree.subTasks.filter(t => t.status === "completed").length;
        const activeCount = taskTree.subTasks.filter(t => t.status === "active").length;
        const pendingCount = taskTree.subTasks.filter(t => t.status === "pending").length;
        const totalCount = taskTree.subTasks.length;
        
        const taskBoardSummary = `
📋 任务看板
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 主任务: ${taskTree.rootTask}
📝 子任务: ${totalCount} 个
   ✅ 已完成: ${completedCount}
   🔄 进行中: ${activeCount}
   ⏳ 待执行: ${pendingCount}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💾 任务树保存位置: ~/.clawdbot/tasks/${sessionId}/TASK_TREE.json
📊 查看任务看板: 使用 show_task_board 工具
`.trim();

        return jsonResult({
          success: true,
          message: `任务已加入队列${summary ? `：${summary}` : ""}\n\n${taskBoardSummary}`,
          queueKey: agentSessionKey,
          subTaskId: subTask.id,
          taskBoardSummary,
          taskTreePath: `~/.clawdbot/tasks/${sessionId}/TASK_TREE.json`,
        });
      } catch (err) {
        console.error(`[enqueue_task] ❌ Error:`, err);
        return jsonResult({
          success: false,
          error: String(err),
        });
      }
    },
  };
}
