/**
 * V9: 智能摘要引擎 (Smart Summarizer)
 *
 * 基于 llm_light 策略的轻量级摘要生成器，解决三个核心问题：
 * 1. 子任务完成后缺乏智能摘要 — siblings 只看截断原文不看摘要
 * 2. 父子任务之间缺乏目标传递 — 子任务不清楚父任务的统一目标
 * 3. 流水线子任务之间缺乏摘要传递 — 前序任务的成果无法精炼传递
 *
 * 设计原则：
 * - 用 llm_light（低 maxTokens、低 timeout）生成摘要，省 token
 * - 摘要存入 SubTaskMetadata.smartSummary，一次生成多处复用
 * - 支持批量摘要（单次 LLM 调用处理多个子任务），进一步降低开销
 * - 降级友好：LLM 不可用时回退到规则截断摘要
 *
 * @module agents/intelligent-task-decomposition/smart-summarizer
 */

import { createSystemLLMCaller } from "./system-llm-caller.js";
import type { SubTask, TaskTree, TaskType } from "./types.js";
import type { ClawdbotConfig } from "../../config/config.js";

// ────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────

/** llm_light 最大输出 token（摘要不需要长输出） */
const LIGHT_MAX_TOKENS = 1024;

/** llm_light 超时（秒），摘要是短任务，30s 足够 */
const LIGHT_TIMEOUT_MS = 30_000;

/** llm_light 温度（低温 = 稳定摘要） */
const LIGHT_TEMPERATURE = 0.2;

/** 单个子任务摘要的目标字数上限（中文字符） */
const SUMMARY_TARGET_CHARS = 300;

/** 批量摘要单次最多处理子任务数 */
const BATCH_SUMMARY_MAX_TASKS = 8;

/** 父目标摘要的目标字数上限 */
const PARENT_GOAL_TARGET_CHARS = 500;

/** 流水线上下文摘要的目标字数上限 */
const PIPELINE_CONTEXT_TARGET_CHARS = 400;

/** 规则摘要回退：截断长度 */
const RULE_BASED_TRUNCATE_LEN = 250;

// ────────────────────────────────────────────────────────────
// llm_light 调用器缓存
// ────────────────────────────────────────────────────────────

let _lightCaller: ReturnType<typeof createSystemLLMCaller> | null = null;
let _lightCallerCacheKey: string | undefined;

/**
 * 获取或创建 llm_light 调用器（单例复用）
 *
 * P79: 增加 provider/modelId 参数，从运行时上下文继承实际使用的 provider，
 * 避免回退到硬编码的 DEFAULT_PROVIDER（anthropic）导致 "No API key found" 错误。
 */
export function getLightCaller(
  config?: ClawdbotConfig,
  provider?: string,
  modelId?: string,
): ReturnType<typeof createSystemLLMCaller> {
  const cacheKey = `${provider ?? ""}_${modelId ?? ""}_${config ? "cfg" : "nocfg"}`;
  if (_lightCaller && _lightCallerCacheKey === cacheKey) return _lightCaller;
  _lightCaller = createSystemLLMCaller({
    config,
    provider,
    modelId,
    maxTokens: LIGHT_MAX_TOKENS,
    temperature: LIGHT_TEMPERATURE,
    timeoutMs: LIGHT_TIMEOUT_MS,
  });
  _lightCallerCacheKey = cacheKey;
  return _lightCaller;
}

// ────────────────────────────────────────────────────────────
// 核心：单任务智能摘要
// ────────────────────────────────────────────────────────────

/**
 * 为已完成的子任务生成智能摘要
 *
 * 摘要包含：任务做了什么 + 关键产出 + 对后续任务的价值
 * 比截断原文信息密度高 5-10 倍，且 token 消耗极低。
 *
 * @param subTask - 已完成的子任务
 * @param fileContent - 实际文件内容（优先于 subTask.output）
 * @param config - Clawdbot 配置
 * @returns 智能摘要文本（失败时返回规则摘要）
 */
export async function generateSmartSummary(
  subTask: SubTask,
  fileContent?: string,
  config?: ClawdbotConfig,
  provider?: string,
  modelId?: string,
): Promise<string> {
  const effectiveContent = fileContent || subTask.output || "";
  if (!effectiveContent || effectiveContent.length < 50) {
    return buildRuleBasedSummary(subTask, effectiveContent);
  }

  try {
    const caller = getLightCaller(config, provider, modelId);
    const taskType = subTask.taskType ?? "generic";
    const prompt = buildSummaryPrompt(subTask, effectiveContent, taskType);
    const result = await caller.call(prompt);
    const summary = result.trim();

    if (summary.length > 0 && summary.length <= SUMMARY_TARGET_CHARS * 2) {
      console.log(
        `[smart-summarizer] ✅ 生成智能摘要: ${subTask.id} (${summary.length} chars)`,
      );
      return summary;
    }
    // LLM 输出过长或为空，回退
    return summary.length > 0
      ? summary.substring(0, SUMMARY_TARGET_CHARS) + "..."
      : buildRuleBasedSummary(subTask, effectiveContent);
  } catch (err) {
    console.warn(
      `[smart-summarizer] ⚠️ LLM 摘要失败，降级为规则摘要: ${err}`,
    );
    return buildRuleBasedSummary(subTask, effectiveContent);
  }
}

// ────────────────────────────────────────────────────────────
// 核心：批量智能摘要
// ────────────────────────────────────────────────────────────

/**
 * 批量生成多个子任务的智能摘要（单次 LLM 调用）
 *
 * 适用场景：轮次完成后一次性为所有已完成子任务生成摘要。
 * 比逐个调用省 N-1 次 LLM 请求开销。
 *
 * @param tasks - 子任务及其文件内容的数组
 * @param config - Clawdbot 配置
 * @returns Map<subTaskId, summary>
 */
export async function batchGenerateSummaries(
  tasks: Array<{ subTask: SubTask; fileContent?: string }>,
  config?: ClawdbotConfig,
  provider?: string,
  modelId?: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (tasks.length === 0) return result;

  // 小批量直接逐个处理
  if (tasks.length <= 2) {
    for (const { subTask, fileContent } of tasks) {
      const summary = await generateSmartSummary(subTask, fileContent, config, provider, modelId);
      result.set(subTask.id, summary);
    }
    return result;
  }

  // 大批量：单次 LLM 调用批量处理
  const batch = tasks.slice(0, BATCH_SUMMARY_MAX_TASKS);
  try {
    const caller = getLightCaller(config, provider, modelId);
    const prompt = buildBatchSummaryPrompt(batch);
    const llmResult = await caller.call(prompt);
    const parsed = parseBatchSummaryResponse(llmResult, batch);

    for (const { subTask } of batch) {
      const summary = parsed.get(subTask.id);
      if (summary && summary.length > 10) {
        result.set(subTask.id, summary);
      } else {
        // 该任务的摘要解析失败，回退
        result.set(
          subTask.id,
          buildRuleBasedSummary(
            subTask,
            tasks.find((t) => t.subTask.id === subTask.id)?.fileContent || subTask.output || "",
          ),
        );
      }
    }

    console.log(
      `[smart-summarizer] ✅ 批量摘要完成: ${result.size}/${batch.length} 成功`,
    );
  } catch (err) {
    console.warn(
      `[smart-summarizer] ⚠️ 批量摘要失败，逐个降级: ${err}`,
    );
    // 全部降级为规则摘要
    for (const { subTask, fileContent } of batch) {
      result.set(
        subTask.id,
        buildRuleBasedSummary(subTask, fileContent || subTask.output || ""),
      );
    }
  }

  // 超出批量上限的部分
  for (let i = BATCH_SUMMARY_MAX_TASKS; i < tasks.length; i++) {
    const { subTask, fileContent } = tasks[i];
    result.set(
      subTask.id,
      buildRuleBasedSummary(subTask, fileContent || subTask.output || ""),
    );
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// 核心：父任务目标摘要
// ────────────────────────────────────────────────────────────

/**
 * 为子任务生成父目标上下文
 *
 * 让子任务清晰地知道：
 * 1. 父任务（整个项目）的最终目标是什么
 * 2. 当前子任务在整体中扮演什么角色
 * 3. 完成标准是什么
 *
 * @param taskTree - 任务树
 * @param subTask - 当前子任务
 * @param config - Clawdbot 配置
 * @returns 格式化的父目标上下文（可直接注入 extraSystemPrompt）
 */
export async function generateParentGoalContext(
  taskTree: TaskTree,
  subTask: SubTask,
  config?: ClawdbotConfig,
): Promise<string> {
  const rootGoal = taskTree.rootTask;
  if (!rootGoal || rootGoal.length < 10) return "";

  // 对于短目标，直接格式化即可，无需 LLM
  if (rootGoal.length <= 200) {
    return formatParentGoalContext(rootGoal, subTask);
  }

  // 长目标需要 LLM 提炼
  try {
    const caller = getLightCaller(config);
    const prompt = buildParentGoalPrompt(rootGoal, subTask);
    const result = await caller.call(prompt);
    const condensed = result.trim();

    if (condensed.length > 0 && condensed.length <= PARENT_GOAL_TARGET_CHARS * 2) {
      return formatParentGoalContext(condensed, subTask);
    }
    // 回退到截断
    return formatParentGoalContext(
      rootGoal.substring(0, PARENT_GOAL_TARGET_CHARS) + "...",
      subTask,
    );
  } catch {
    // LLM 失败，直接截断
    return formatParentGoalContext(
      rootGoal.length > PARENT_GOAL_TARGET_CHARS
        ? rootGoal.substring(0, PARENT_GOAL_TARGET_CHARS) + "..."
        : rootGoal,
      subTask,
    );
  }
}

// ────────────────────────────────────────────────────────────
// 核心：流水线上下文摘要
// ────────────────────────────────────────────────────────────

/**
 * 为流水线中的下一个子任务生成前序任务的上下文摘要
 *
 * 适用于有依赖关系的串行任务（如分段写作、数据管线的 map→reduce）。
 * 比截断原文更精炼，且突出对后续任务有价值的信息。
 *
 * @param predecessors - 前序已完成任务列表
 * @param currentTask - 当前即将执行的任务
 * @param config - Clawdbot 配置
 * @returns 格式化的流水线上下文
 */
export async function generatePipelineContext(
  predecessors: Array<{ subTask: SubTask; fileContent?: string }>,
  currentTask: SubTask,
  config?: ClawdbotConfig,
): Promise<string> {
  if (predecessors.length === 0) return "";

  // 如果前序任务已有 smartSummary，直接使用（零 LLM 消耗）
  const hasSummaries = predecessors.every(
    (p) => p.subTask.metadata?.smartSummary && p.subTask.metadata.smartSummary.length > 20,
  );

  if (hasSummaries) {
    return formatPipelineContext(
      predecessors.map((p) => ({
        summary: p.subTask.summary,
        smartSummary: p.subTask.metadata!.smartSummary!,
      })),
      currentTask,
    );
  }

  // 无缓存摘要，尝试 LLM 生成
  try {
    const caller = getLightCaller(config);
    const prompt = buildPipelineContextPrompt(predecessors, currentTask);
    const result = await caller.call(prompt);
    const context = result.trim();

    if (context.length > 0) {
      return `\n\n[🔗 前序任务成果摘要]\n${context}`;
    }
  } catch {
    // LLM 失败
  }

  // 回退：使用已有的 smartSummary 或截断
  return formatPipelineContext(
    predecessors.map((p) => ({
      summary: p.subTask.summary,
      smartSummary:
        p.subTask.metadata?.smartSummary ||
        buildRuleBasedSummary(
          p.subTask,
          p.fileContent || p.subTask.output || "",
        ),
    })),
    currentTask,
  );
}

// ────────────────────────────────────────────────────────────
// Prompt 构建器
// ────────────────────────────────────────────────────────────

function buildSummaryPrompt(
  subTask: SubTask,
  content: string,
  taskType: TaskType | string,
): string {
  // 截断过长内容，摘要只需看关键部分
  const maxContentLen = 4000;
  const truncatedContent =
    content.length > maxContentLen
      ? content.substring(0, maxContentLen * 0.6) +
        "\n...[中间部分已省略]...\n" +
        content.substring(content.length - maxContentLen * 0.4)
      : content;

  const typeHint = getTypeSpecificSummaryHint(taskType);

  return `你是一个专业的任务摘要生成器。请为以下已完成的子任务生成一段精炼的智能摘要。

## 任务信息
- 任务名称：${subTask.summary}
- 任务类型：${taskType}

## 任务产出内容
${truncatedContent}

## 摘要要求
1. 控制在 ${SUMMARY_TARGET_CHARS} 字以内
2. 包含：做了什么 + 关键产出/结论 + 对后续任务的关联价值
3. ${typeHint}
4. 不要重复任务名称，直接描述核心成果
5. 使用与原文相同的语言

请直接输出摘要，不要加任何前缀或标签。`;
}

function buildBatchSummaryPrompt(
  tasks: Array<{ subTask: SubTask; fileContent?: string }>,
): string {
  const taskDescriptions = tasks
    .map((t, i) => {
      const content = t.fileContent || t.subTask.output || "";
      const truncated =
        content.length > 2000
          ? content.substring(0, 1200) + "\n...[已截断]...\n" + content.substring(content.length - 800)
          : content;
      return `### 任务 ${i + 1} [ID: ${t.subTask.id}]
- 名称：${t.subTask.summary}
- 类型：${t.subTask.taskType ?? "generic"}
- 产出：
${truncated}`;
    })
    .join("\n\n");

  return `你是一个专业的批量任务摘要生成器。请为以下 ${tasks.length} 个已完成的子任务分别生成精炼摘要。

${taskDescriptions}

## 输出格式要求
对每个任务输出一行，格式为：
[ID: xxx] 摘要内容

每条摘要控制在 ${SUMMARY_TARGET_CHARS} 字以内，包含核心成果和关键产出。
使用与原文相同的语言。不要添加额外标签或编号。`;
}

function buildParentGoalPrompt(rootGoal: string, subTask: SubTask): string {
  return `请提炼以下任务的核心目标，生成一段简洁的目标摘要。

## 原始任务描述
${rootGoal}

## 当前子任务
${subTask.summary}

## 要求
1. 控制在 ${PARENT_GOAL_TARGET_CHARS} 字以内
2. 提炼：最终要交付什么 + 核心质量标准 + 当前子任务在整体中的位置
3. 使用与原文相同的语言

请直接输出目标摘要。`;
}

function buildPipelineContextPrompt(
  predecessors: Array<{ subTask: SubTask; fileContent?: string }>,
  currentTask: SubTask,
): string {
  const predDescriptions = predecessors
    .map((p) => {
      const content = p.fileContent || p.subTask.output || "";
      const truncated =
        content.length > 1500
          ? content.substring(content.length - 1500)
          : content;
      return `- [${p.subTask.summary}]: ${truncated}`;
    })
    .join("\n");

  return `请为即将执行的任务总结前序任务的关键成果。

## 前序已完成任务
${predDescriptions}

## 即将执行的任务
${currentTask.summary}

## 要求
1. 控制在 ${PIPELINE_CONTEXT_TARGET_CHARS} 字以内
2. 重点突出对当前任务有帮助的信息（如前文结尾情节/接口定义/数据格式）
3. 使用与原文相同的语言

请直接输出成果摘要。`;
}

// ────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────

function getTypeSpecificSummaryHint(taskType: TaskType | string): string {
  switch (taskType) {
    case "writing":
      return "重点概括情节走向、关键场景、人物发展，以及末尾的故事状态（为续写提供衔接点）";
    case "coding":
      return "重点概括实现了什么功能、关键接口/函数签名、依赖变化";
    case "analysis":
    case "research":
      return "重点概括核心发现、关键数据点、结论";
    case "data":
      return "重点概括数据处理结果、输入输出格式、关键统计指标";
    case "design":
      return "重点概括设计方案的核心决策、架构要点、约束条件";
    default:
      return "重点概括核心产出和关键决策";
  }
}

/**
 * 规则摘要回退 — 无 LLM 时的纯规则截断摘要
 *
 * 策略：
 * - 写作类：取结尾段落（续写需要衔接）
 * - 编码类：取开头（通常是函数签名/导出）
 * - 其他：取开头
 */
export function buildRuleBasedSummary(
  subTask: SubTask,
  content: string,
): string {
  if (!content || content.length === 0) {
    return subTask.summary || "(无内容)";
  }

  const taskType = subTask.taskType ?? "generic";
  const maxLen = RULE_BASED_TRUNCATE_LEN;

  if (content.length <= maxLen) {
    return `[${subTask.summary}] ${content}`;
  }

  let snippet: string;
  if (taskType === "writing") {
    // 写作类取结尾（续写衔接需要结尾内容）
    snippet = content.substring(content.length - maxLen);
    // 找最近的段落边界
    const paraIdx = snippet.indexOf("\n\n");
    if (paraIdx > 0 && paraIdx < maxLen * 0.3) {
      snippet = snippet.substring(paraIdx + 2);
    }
    snippet = "..." + snippet;
  } else {
    // 其他类型取开头
    snippet = content.substring(0, maxLen);
    const lastSent = Math.max(
      snippet.lastIndexOf("。"),
      snippet.lastIndexOf("."),
      snippet.lastIndexOf("\n"),
    );
    if (lastSent > maxLen * 0.5) {
      snippet = snippet.substring(0, lastSent + 1);
    } else {
      snippet += "...";
    }
  }

  return `[${subTask.summary}] ${snippet}`;
}

/**
 * 格式化父目标上下文（注入到 extraSystemPrompt）
 */
function formatParentGoalContext(goalSummary: string, subTask: SubTask): string {
  const role = subTask.summary
    ? `你当前负责的是：「${subTask.summary}」`
    : "";

  return `\n\n[🎯 总任务目标]\n以下是整个项目的核心目标，请确保你的产出服务于此目标：\n---\n${goalSummary}\n---\n${role}\n请确保你的输出与总目标保持一致，在质量和风格上统一。`;
}

/**
 * 格式化流水线上下文
 */
function formatPipelineContext(
  predecessors: Array<{ summary: string; smartSummary: string }>,
  _currentTask: SubTask,
): string {
  if (predecessors.length === 0) return "";

  const lines = predecessors.map(
    (p) => `- [${p.summary}]: ${p.smartSummary}`,
  );

  return `\n\n[🔗 前序任务成果摘要]\n以下是已完成的前序任务的智能摘要，请基于这些成果继续工作：\n${lines.join("\n")}`;
}

/**
 * 解析批量摘要 LLM 响应
 */
function parseBatchSummaryResponse(
  response: string,
  tasks: Array<{ subTask: SubTask; fileContent?: string }>,
): Map<string, string> {
  const result = new Map<string, string>();

  // 尝试按 [ID: xxx] 格式解析
  const idPattern = /\[ID:\s*([^\]]+)\]\s*(.+)/g;
  let match;
  while ((match = idPattern.exec(response)) !== null) {
    const id = match[1].trim();
    const summary = match[2].trim();
    if (id && summary) {
      result.set(id, summary);
    }
  }

  // 如果 ID 解析不够，按行序回退
  if (result.size < tasks.length) {
    const lines = response
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 10 && !l.startsWith("#"));

    for (let i = 0; i < tasks.length && i < lines.length; i++) {
      const taskId = tasks[i].subTask.id;
      if (!result.has(taskId)) {
        // 去掉可能的序号前缀
        let line = lines[i].replace(/^\d+[\.\)]\s*/, "");
        // 去掉可能的 [ID: xxx] 前缀
        line = line.replace(/^\[ID:\s*[^\]]*\]\s*/, "");
        if (line.length > 10) {
          result.set(taskId, line);
        }
      }
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// 导出常量（供 strategy-router 等模块引用）
// ────────────────────────────────────────────────────────────

export const LIGHT_CONFIG = {
  maxTokens: LIGHT_MAX_TOKENS,
  timeoutMs: LIGHT_TIMEOUT_MS,
  temperature: LIGHT_TEMPERATURE,
} as const;
