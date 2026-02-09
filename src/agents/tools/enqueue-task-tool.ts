import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { enqueueFollowupRun, type FollowupRun } from "../../auto-reply/reply/queue.js";
import { resolveQueueSettings } from "../../auto-reply/reply/queue/settings.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { Orchestrator } from "../intelligent-task-decomposition/orchestrator.js";
import { deriveExecutionRole, createExecutionContext } from "../intelligent-task-decomposition/execution-context.js";
import { PERMISSION_MATRIX } from "../intelligent-task-decomposition/types.js";

const EnqueueTaskSchema = Type.Object({
  prompt: Type.String({
    description: "任务的提示词，描述 LLM 需要执行的任务",
  }),
  summary: Type.Optional(
    Type.String({
      description: "任务的简短描述（可选），用于日志和调试",
    }),
  ),
  parentId: Type.Optional(
    Type.String({
      description: "父任务 ID（可选），用于递归分解。如果指定，当前任务将成为父任务的子任务",
    }),
  ),
  waitForChildren: Type.Optional(
    Type.Boolean({
      description: "是否等待子任务完成（可选），默认 false。如果为 true，当前任务会等待所有子任务完成后才执行",
    }),
  ),
  isNewRootTask: Type.Optional(
    Type.Boolean({
      description: `是否创建新的根任务树（可选），默认 false。

**判断标准**：
- true：用户提出了全新的、与当前任务树完全无关的任务
- false：当前任务是现有任务树的分解或细化

**示例**：
- "写一篇关于东京的游记" → isNewRootTask=true（全新任务）
- "将第一章分为三个小节" → isNewRootTask=false（当前任务的分解）
- "现在写一个完全不同的故事" → isNewRootTask=true（全新任务）

**重要**：如果设置为 true，parentId 必须为空`,
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
let llmCallerProvider = "";
let llmCallerModel = "";

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
- 新任务识别：自动区分"新任务"和"子任务"，避免混淆
- 质量评估：AI 自主评估每个阶段的质量（初始分解、子任务完成、整体完成）
- 动态调整：根据质量评估结果动态调整任务树（continue/adjust/restart/overthrow）
- 失败学习：从失败中学习，避免重复错误

**使用场景 1：创建新任务树**（isNewRootTask=true）
- 用户提出了全新的、与当前任务树完全无关的任务
- 示例：
  - 当前任务："写一篇科幻小说"
  - 用户新请求："现在写一篇关于东京的游记"
  - 判断：完全不同的主题 → isNewRootTask=true

**使用场景 2：分解现有任务**（isNewRootTask=false，默认）
- 当前任务需要分解成多个子任务
- 示例：
  - 当前任务："写一篇 10000 字的科幻小说"
  - 分解：5 个子任务，每个 2000 字
  - 判断：是当前任务的分解 → isNewRootTask=false

**判断标准**：
✅ 新任务树（isNewRootTask=true）：
- 用户明确提出了新的、不同的任务
- 新任务与当前任务树的主题完全无关
- 新任务不是当前任务的细化或分解

❌ 子任务（isNewRootTask=false）：
- 当前任务需要分解成多个步骤
- 当前任务需要生成多段内容
- 当前任务需要处理多个文件/章节

**重要规则**：
- ✅ 用户直接请求时：可以调用 enqueue_task 创建多个任务
- ❌ 执行队列任务时：不要调用 enqueue_task（除非递归分解）
- ✅ 递归分解：如果子任务仍然太复杂（> 3000 字、> 2 步骤），可以继续分解

**参数说明**：
- prompt：任务的详细提示词，必须清晰、具体、可执行、有标准（包含上下文、要求、质量标准）
- summary：任务的简短描述，用于任务看板显示
- isNewRootTask：是否创建新任务树（true=新任务，false=子任务）
- parentId：父任务 ID（仅在 isNewRootTask=false 时使用）
- waitForChildren：是否等待子任务完成（用于汇总任务）

**示例 1：创建新任务树**
用户：现在写一篇关于东京的游记
→ 调用 enqueue_task({ prompt: "...", summary: "东京游记", isNewRootTask: true })
→ 系统创建新的任务树

**示例 2：分解现有任务**
用户：请生成 10000 字的科幻小说
→ 调用 enqueue_task 5 次，每次 2000 字，isNewRootTask=false
→ 系统自动执行，自动评估质量，自动调整

**任务树存储**：
- 自动保存到：~/.clawdbot/tasks/{sessionId}/TASK_TREE.json
- 支持断点恢复、版本回滚、失败学习`,
    parameters: EnqueueTaskSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const prompt = readStringParam(params, "prompt", { required: true });
      const summary = readStringParam(params, "summary");
      const parentId = readStringParam(params, "parentId");
      const waitForChildren = params.waitForChildren === true;
      const isNewRootTask = params.isNewRootTask === true;

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

      // 🔧 延迟注入 LLM 调用器：使用当前 session 的 provider/model（而非硬编码的 anthropic 默认值）
      // 当 provider 或 model 变化时重新初始化，确保始终匹配当前会话
      const runProvider = currentFollowupRun.run.provider;
      const runModel = currentFollowupRun.run.model;
      if (config && (llmCallerProvider !== runProvider || llmCallerModel !== runModel)) {
        console.log(`[enqueue_task] 🔄 初始化系统 LLM 调用器: provider=${runProvider}, model=${runModel}`);
        globalOrchestrator.initializeLLMCaller(config, runProvider, runModel);
        llmCallerProvider = runProvider;
        llmCallerModel = runModel;
      }

      // 🆕 V2: 使用 ExecutionContext 替代布尔标记组合判断
      // 从旧字段推导执行角色，通过 PERMISSION_MATRIX 获取权限
      const isQueueTask = currentFollowupRun.isQueueTask ?? false;
      const isCurrentRootTask = currentFollowupRun.isRootTask ?? false;
      const isCurrentNewRoot = currentFollowupRun.isNewRootTask ?? false;
      const currentDepth = currentFollowupRun.taskDepth ?? 0;
      const MAX_ENQUEUE_DEPTH = 3;

      // 🆕 V2: 优先从 ExecutionContext 获取权限，回退到旧逻辑推导
      const executionRole = currentFollowupRun.executionContext?.role
        ?? deriveExecutionRole({
          isQueueTask,
          isRootTask: isCurrentRootTask,
          isNewRootTask: isCurrentNewRoot,
          taskDepth: currentDepth,
        });
      const permissions = currentFollowupRun.executionContext?.permissions
        ?? PERMISSION_MATRIX[executionRole];
      const canEnqueue = permissions.canEnqueue;
      
      // 深度兜底：即使角色允许，深度超限也拒绝（防止根任务无限递归）
      if (canEnqueue && currentDepth >= MAX_ENQUEUE_DEPTH) {
        console.warn(`[enqueue_task] ⚠️ Task depth ${currentDepth} >= ${MAX_ENQUEUE_DEPTH}, refusing to enqueue (depth guard)`);
        return jsonResult({
          success: false,
          error: `❌ 任务分解深度已达上限（${currentDepth}/${MAX_ENQUEUE_DEPTH}），不能继续分解。\n\n✅ 正确做法：直接生成当前任务要求的内容。`,
        });
      }
      
      if (!canEnqueue) {
        console.warn(`[enqueue_task] ⚠️ Cannot enqueue: role=${executionRole}, canEnqueue=false (isQueueTask=${isQueueTask}, isRootTask=${isCurrentRootTask}, depth=${currentDepth})`);
        return jsonResult({
          success: false,
          error: `❌ 不能在执行子任务时创建新的子任务（防止套娃分解）。

✅ 正确做法：
1. 直接使用 write 工具生成当前任务要求的内容并写入文件
2. 在聊天中回复简短确认
3. 完成后系统会自动执行下一个任务

⚠️ 如果任务太复杂需要分解，系统会自动判断并处理，无需你手动调用 enqueue_task。`,
        });
      }

      try {
        // 🔧 验证参数：isNewRootTask=true 时，parentId 必须为空
        if (isNewRootTask && parentId) {
          return jsonResult({
            success: false,
            error: "❌ 参数错误：isNewRootTask=true 时，parentId 必须为空（新根任务不能有父任务）",
          });
        }

        // 🔧 使用 Orchestrator 管理任务树
        const sessionId = currentFollowupRun.run.sessionId;
        
        // 🔧 统一使用原始 sessionId，靠 rootTaskId 隔离轮次
        // 旧版用后缀 sessionId 会导致任务树分裂（isNewRootTask=true 写入新树，其余写入旧树）
        const targetSessionId = sessionId;
        
        // 加载或初始化任务树（必须在 rootTaskId 确定前完成，以便检查旧 round 状态）
        let taskTree = await globalOrchestrator.loadTaskTree(targetSessionId);
        if (!taskTree) {
          // 第一次调用 enqueue_task，初始化任务树
          const rootTaskPrompt = isNewRootTask 
            ? prompt // 新根任务：使用当前 prompt 作为根任务
            : currentFollowupRun.prompt; // 子任务：使用原始用户消息作为根任务
          
          taskTree = await globalOrchestrator.initializeTaskTree(
            rootTaskPrompt,
            targetSessionId,
          );
          console.log(`[enqueue_task] ✅ Task tree initialized: sessionId=${targetSessionId}, isNewRootTask=${isNewRootTask}`);
        }
        
        // 🆕 Step 4b: 自适应深度控制 — 初始化任务树后自动设置 maxDepth
        if (taskTree.maxDepth === undefined || taskTree.maxDepth === null) {
          const adaptiveDepth = globalOrchestrator.calculateAdaptiveMaxDepth(
            taskTree.rootTask,
            taskTree.subTasks.length,
          );
          taskTree.maxDepth = adaptiveDepth;
          console.log(`[enqueue_task] 📏 Adaptive maxDepth set to ${adaptiveDepth}`);
        }

        // 🆕 轮次隔离：生成或继承 rootTaskId（在 tree 加载后执行，可检查旧 round 状态）
        // - 新根任务 → 始终生成新的 rootTaskId
        // - 继承的 rootTaskId 对应 round 已完成 → 生成新的（防止被 drain Guard B 误杀）
        // - 同一轮首次 enqueue → 生成新的 rootTaskId 并存到 context
        // - 同一轮后续 enqueue → 从 context 继承
        let rootTaskId = currentFollowupRun.rootTaskId;
        if (rootTaskId && !isNewRootTask && globalOrchestrator.isRoundCompleted(taskTree, rootTaskId)) {
          console.log(`[enqueue_task] 🔄 Inherited rootTaskId ${rootTaskId} round already completed, generating new one`);
          rootTaskId = undefined;
        }
        if (!rootTaskId || isNewRootTask) {
          rootTaskId = crypto.randomUUID();
          // 存到 context，后续同一 LLM 执行中的 enqueue 调用会继承
          currentFollowupRun.rootTaskId = rootTaskId;
          console.log(`[enqueue_task] 🆔 New rootTaskId generated: ${rootTaskId} (isNewRootTask=${isNewRootTask})`);
        } else {
          console.log(`[enqueue_task] 🆔 Inherited rootTaskId: ${rootTaskId}`);
        }

        // 🆕 V2: 确保 Round 对象存在（幂等操作：已存在则复用，不存在则创建）
        // Round.goal 使用用户原始 prompt 或 summary，作为质量评审的对比基准
        const roundGoal = isNewRootTask
          ? (summary || prompt.substring(0, 200))   // 新根任务：用 summary 或 prompt 截断
          : (currentFollowupRun.summaryLine || currentFollowupRun.prompt?.substring(0, 200) || prompt.substring(0, 200));  // 子任务：用原始用户消息
        globalOrchestrator.getOrCreateRound(taskTree, rootTaskId, roundGoal);

        // 添加子任务到任务树（携带 rootTaskId 实现轮次隔离）
        const subTask = await globalOrchestrator.addSubTask(
          taskTree, 
          prompt, 
          summary || prompt,
          parentId,           // 传递父任务 ID
          waitForChildren,    // 传递是否等待子任务完成
          rootTaskId,         // 🆕 轮次隔离 ID
        );
        console.log(`[enqueue_task] ✅ Sub task added to tree: ${subTask.id} (${summary || "none"}) [parent=${parentId || "none"}, waitForChildren=${waitForChildren}, isNewRootTask=${isNewRootTask}]`);
        
        // 构建 FollowupRun（融合方案 1+2+3 + 精确匹配）
        // - isRootTask：新根任务允许分解子任务（方案 1）
        // - isNewRootTask：显式传播，drain 时双保险恢复语义（方案 2）
        // - taskDepth：记录入队时的深度，drain 时做兜底检查（方案 3）
        // - subTaskId：记录子任务 ID，用于精确匹配（任务系统改进）
        const subTaskDepth = subTask.depth ?? 0;
        const followupRun: FollowupRun = {
          prompt,
          summaryLine: summary,
          enqueuedAt: Date.now(),
          run: currentFollowupRun.run,
          isQueueTask: true,
          isRootTask: isNewRootTask,  // 🔧 只有新根任务标记为根任务，子任务通过 depth guard 控制递归分解
          isNewRootTask: isNewRootTask,    // 方案 2：显式传播标记
          taskDepth: subTaskDepth,          // 方案 3：记录任务树深度
          subTaskId: subTask.id,            // 精确匹配：记录子任务 ID
          rootTaskId,                         // 🆕 轮次隔离：传播 rootTaskId
          // 🔧 继承 originating 路由信息，确保子任务回复能发送到用户的聊天频道
          originatingChannel: currentFollowupRun.originatingChannel,
          originatingTo: currentFollowupRun.originatingTo,
          originatingAccountId: currentFollowupRun.originatingAccountId,
          originatingThreadId: currentFollowupRun.originatingThreadId,
          originatingChatType: currentFollowupRun.originatingChatType,
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
        const message = isNewRootTask
          ? `✅ 新任务树已创建${summary ? `：${summary}` : ""}`
          : `✅ 任务已加入队列${summary ? `：${summary}` : ""}`;
        
        return jsonResult({
          success: true,
          message,
          queueKey: agentSessionKey,
          subTaskId: subTask.id,
          taskTreePath: `~/.clawdbot/tasks/${targetSessionId}/TASK_TREE.json`,
          isNewRootTask,
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
