/**
 * 任务意图分类器
 * 
 * 在用户消息到达时，如果存在旧任务树，使用轻量级 LLM 调用判断：
 * - new_task：用户发起了全新任务（与旧任务无关）
 * - continue_task：用户想继续/跟进旧任务
 * - adjust_task：用户想调整/修改旧任务
 * 
 * 这解决了"系统总是把新任务塞进旧任务树"的核心问题。
 * 
 * 设计原则：
 * - 轻量：prompt 尽量短，使用低温度快速模型
 * - 降级安全：LLM 调用失败时默认 new_task（宁可创新树也不污染旧树）
 * - 不阻塞：超时 10 秒自动降级
 */

import type { TaskTree } from "./types.js";
import type { LLMCaller } from "./batch-executor.js";

/**
 * 意图分类结果
 */
export type TaskIntent = "new_task" | "continue_task" | "adjust_task";

export interface TaskIntentResult {
  /** 分类结果 */
  intent: TaskIntent;
  /** 置信度 0-1 */
  confidence: number;
  /** 分类理由（用于日志） */
  reason: string;
  /** 是否为降级结果（LLM 调用失败时） */
  isFallback: boolean;
}

/**
 * 从任务树中提取用于意图分类的摘要信息
 * 
 * 只提取关键信息，控制 prompt 长度
 */
function extractTaskTreeSummary(taskTree: TaskTree): string {
  const status = taskTree.status ?? "unknown";
  const rootTask = taskTree.rootTask ?? "（无描述）";
  const totalTasks = taskTree.subTasks?.length ?? 0;
  const completedTasks = taskTree.subTasks?.filter(t => t.status === "completed").length ?? 0;
  const failedTasks = taskTree.subTasks?.filter(t => t.status === "failed").length ?? 0;
  const pendingTasks = taskTree.subTasks?.filter(t => t.status === "pending" || t.status === "active").length ?? 0;

  // 提取子任务摘要（最多 5 个，避免 prompt 过长）
  const subTaskSummaries = (taskTree.subTasks ?? [])
    .slice(0, 5)
    .map(t => `  - [${t.status}] ${t.summary || t.prompt?.substring(0, 60) || "无描述"}`)
    .join("\n");

  return [
    `任务目标：${rootTask.substring(0, 200)}`,
    `全局状态：${status}`,
    `子任务统计：共${totalTasks}个（完成${completedTasks}，失败${failedTasks}，待处理${pendingTasks}）`,
    subTaskSummaries ? `子任务列表（前5个）：\n${subTaskSummaries}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * 构建意图分类 prompt
 * 
 * 设计要点：
 * - 极简，控制在 500 token 以内
 * - 明确的 JSON 输出格式
 * - 偏向 new_task 的判定标准（避免污染旧树）
 */
function buildClassificationPrompt(userMessage: string, taskTreeSummary: string): string {
  return `你是一个任务意图分类器。判断用户的新消息是"全新任务"还是"继续/调整旧任务"。

【当前任务树摘要】
${taskTreeSummary}

【用户新消息】
${userMessage.substring(0, 500)}

【分类规则】
- new_task：用户提出了与当前任务树主题/目标完全不同的新任务。关键信号：不同的主题、不同的产出物、不同的目标对象。
- continue_task：用户想继续推进当前任务，如"继续写"、"下一步"、"还没写完"。
- adjust_task：用户想修改当前任务，如"第3章太短了"、"把主角名字改一下"。

【重要】如果无法确定，默认选 new_task（宁可创建新任务树，也不要把无关任务塞进旧树）。

请只返回一行 JSON（不要 markdown 代码块）：
{"intent":"new_task|continue_task|adjust_task","confidence":0.0-1.0,"reason":"一句话理由"}`;
}

/**
 * 解析分类结果
 */
function parseClassificationResponse(response: string): TaskIntentResult | null {
  try {
    // 尝试从响应中提取 JSON
    const jsonMatch = response.match(/\{[^}]*"intent"\s*:\s*"[^"]*"[^}]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const intent = parsed.intent;
    
    if (intent !== "new_task" && intent !== "continue_task" && intent !== "adjust_task") {
      return null;
    }

    return {
      intent: intent as TaskIntent,
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      reason: typeof parsed.reason === "string" ? parsed.reason : "未提供理由",
      isFallback: false,
    };
  } catch {
    return null;
  }
}

/**
 * 规则驱动的快速预分类（不调用 LLM）
 * 
 * 对于明显的场景直接返回结果，节省 LLM 调用：
 * - 旧任务树已完成/失败 → 大概率是新任务
 * - 用户消息包含明显的"继续"关键词 → continue_task
 * - 旧任务树没有任何子任务 → 可能是空树，当作新任务
 */
function quickPreClassify(userMessage: string, taskTree: TaskTree): TaskIntentResult | null {
  const msg = userMessage.toLowerCase();
  
  // 规则 1：旧任务树已终结（completed/failed）且无 pending 子任务 → 新任务
  const hasPending = taskTree.subTasks?.some(
    t => t.status === "pending" || t.status === "active" || t.status === "interrupted"
  );
  if ((taskTree.status === "completed" || taskTree.status === "failed") && !hasPending) {
    return {
      intent: "new_task",
      confidence: 0.95,
      reason: "旧任务树已终结（status=" + taskTree.status + "），无待处理子任务",
      isFallback: false,
    };
  }

  // 规则 2：旧任务树为空（没有子任务） → 新任务
  if (!taskTree.subTasks || taskTree.subTasks.length === 0) {
    return {
      intent: "new_task",
      confidence: 0.9,
      reason: "旧任务树为空（无子任务）",
      isFallback: false,
    };
  }

  // 规则 3：明显的"继续"关键词
  const continueKeywords = ["继续", "接着", "下一步", "还没完", "继续写", "接着写", "continue", "next", "go on"];
  if (continueKeywords.some(kw => msg.includes(kw))) {
    return {
      intent: "continue_task",
      confidence: 0.85,
      reason: "用户消息包含'继续'类关键词",
      isFallback: false,
    };
  }

  // 规则 4：明显的"调整"关键词
  const adjustKeywords = ["修改", "调整", "改一下", "太短", "太长", "重写", "改成", "换成"];
  if (adjustKeywords.some(kw => msg.includes(kw))) {
    return {
      intent: "adjust_task",
      confidence: 0.8,
      reason: "用户消息包含'调整'类关键词",
      isFallback: false,
    };
  }

  // 规则 5：所有子任务都已完成但全局状态未更新 → 大概率是新任务
  const allDone = taskTree.subTasks.every(
    t => t.status === "completed" || t.status === "failed"
  );
  if (allDone) {
    return {
      intent: "new_task",
      confidence: 0.9,
      reason: "所有子任务均已终结，用户消息大概率是新任务",
      isFallback: false,
    };
  }

  // 无法快速判定，需要 LLM
  return null;
}

/**
 * 分类用户消息的任务意图
 * 
 * 流程：
 * 1. 快速规则预分类（不调用 LLM）
 * 2. 如果规则无法判定 → 调用 LLM 分类
 * 3. LLM 失败 → 降级为 new_task
 * 
 * @param userMessage 用户新消息
 * @param taskTree 当前存在的任务树
 * @param llmCaller LLM 调用器（可选，为 null 时只用规则）
 * @returns 意图分类结果
 */
export async function classifyTaskIntent(
  userMessage: string,
  taskTree: TaskTree,
  llmCaller: LLMCaller | null,
): Promise<TaskIntentResult> {
  // Step 1：快速规则预分类
  const quickResult = quickPreClassify(userMessage, taskTree);
  if (quickResult) {
    console.log(
      `[TaskIntentClassifier] ⚡ 规则预分类：${quickResult.intent}（置信度=${quickResult.confidence}）` +
      `，理由：${quickResult.reason}`
    );
    return quickResult;
  }

  // Step 2：LLM 分类
  if (!llmCaller) {
    console.log(`[TaskIntentClassifier] ⚠️ 无 LLM 调用器，降级为 new_task`);
    return {
      intent: "new_task",
      confidence: 0.5,
      reason: "无 LLM 调用器可用，降级为新任务",
      isFallback: true,
    };
  }

  try {
    const summary = extractTaskTreeSummary(taskTree);
    const prompt = buildClassificationPrompt(userMessage, summary);
    
    console.log(`[TaskIntentClassifier] 🔍 调用 LLM 进行意图分类...`);
    const response = await llmCaller.call(prompt);
    
    const result = parseClassificationResponse(response);
    if (result) {
      console.log(
        `[TaskIntentClassifier] ✅ LLM 分类：${result.intent}（置信度=${result.confidence}）` +
        `，理由：${result.reason}`
      );
      return result;
    }

    // LLM 返回了无法解析的结果
    console.warn(`[TaskIntentClassifier] ⚠️ LLM 响应无法解析，降级为 new_task。响应：${response.substring(0, 200)}`);
    return {
      intent: "new_task",
      confidence: 0.5,
      reason: "LLM 响应无法解析，降级为新任务",
      isFallback: true,
    };
  } catch (err) {
    console.warn(`[TaskIntentClassifier] ⚠️ LLM 调用失败，降级为 new_task:`, err);
    return {
      intent: "new_task",
      confidence: 0.5,
      reason: `LLM 调用失败：${err}`,
      isFallback: true,
    };
  }
}
