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
    description: `将任务加入队列，稍后自动执行。这是一个强大的递归任务分解系统。

**核心能力**：
- 递归分解：任务可以分解成子任务，子任务可以继续分解（最多 3 层）
- 质量评估：AI 自主评估每个阶段的质量（初始分解、子任务完成、整体完成）
- 动态调整：根据质量评估结果动态调整任务树（continue/adjust/restart/overthrow）
- 失败学习：从失败中学习，避免重复错误

**使用场景**（必须分解）：
1. 大量内容生成（> 5000 字）→ 每 2000-3000 字一个子任务
2. 大量数据处理（> 100 个文件或 > 50 万字）→ 按文件/章节/主题分组
3. 多步骤复杂任务（> 3 个步骤）→ 每个步骤一个子任务
4. 并行处理场景 → 为每个独立单元创建子任务

**重要规则**：
- ✅ 用户直接请求时：可以调用 enqueue_task 创建多个任务
- ❌ 执行队列任务时：不要调用 enqueue_task（除非递归分解）
- ✅ 递归分解：如果子任务仍然太复杂（> 3000 字、> 2 步骤），可以继续分解

**参数说明**：
- prompt：任务的详细提示词，必须清晰、具体、可执行、有标准（包含上下文、要求、质量标准）
- summary：任务的简短描述，用于任务看板显示

**示例**：
用户：请生成 10000 字的科幻小说
→ 调用 enqueue_task 5 次，每次 2000 字，每个 prompt 包含详细要求
→ 系统自动执行，自动评估质量，自动调整

**任务树存储**：
- 自动保存到：~/.clawdbot/tasks/{sessionId}/TASK_TREE.json
- 支持断点恢复、版本回滚、失败学习`,
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

        // 🆕 生成简洁的成功消息（不包含任务看板）
        // 任务看板会在子任务完成后由 followup-runner 自动发送
        return jsonResult({
          success: true,
          message: `任务已加入队列${summary ? `：${summary}` : ""}`,
          queueKey: agentSessionKey,
          subTaskId: subTask.id,
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
