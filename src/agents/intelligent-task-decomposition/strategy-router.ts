/**
 * V8 P2: 执行策略路由器 (Strategy Router)
 *
 * 在子任务执行前决定执行策略：
 * - "llm": 标准 LLM 执行（当前默认路径）
 * - "llm_light": 轻量 LLM（简化 prompt，低 timeout）
 * - "system_merge": 系统直接合并文件（不走 LLM，零 token 消耗）
 * - "system_deliver": 系统直接发送/交付（不走 LLM）
 *
 * 核心原则：LLM 是执行者，不是搬运工。
 * 合并文件、发送文件等机械操作不应消耗 LLM token。
 */

import type { SubTask, TaskTree, TaskType } from "./types.js";
import { LIGHT_CONFIG } from "./smart-summarizer.js";

// ────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────

/**
 * 执行策略
 */
export type ExecutionStrategy =
  | "llm"             // 标准 LLM 执行（当前默认）
  | "llm_light"       // 轻量 LLM（低 timeout、简化 prompt）
  | "system_merge"    // 系统直接合并文件（不走 LLM）
  | "system_deliver"; // 系统直接发送/交付（不走 LLM）

/**
 * 系统策略执行结果
 */
export interface SystemStrategyResult {
  /** 输出文本（存入 subTask.output） */
  output: string;
  /** 产出的文件路径列表 */
  producedFilePaths: string[];
  /** 是否成功 */
  success: boolean;
  /** 失败原因 */
  error?: string;
}

// ────────────────────────────────────────────────────────────
// llm_light 配置
// ────────────────────────────────────────────────────────────

/**
 * llm_light 执行参数 — 比标准 LLM 省 80%+ token
 *
 * 使用场景：
 * 1. 智能摘要生成（子任务完成后、批量摘要）
 * 2. 简单分类/元数据提取
 * 3. 短 prompt 的简单任务（如格式转换、简短回复）
 *
 * 与标准 LLM 的差异：
 * - maxTokens: 1024 (vs 8192)
 * - timeout: 30s (vs 120s)
 * - temperature: 0.2 (vs 0.3)
 * - 无 bootstrap context（AGENTS.md 等）
 * - 无 skills 注入
 * - 最小工具集（仅 write/read）
 */
export interface LlmLightConfig {
  maxTokens: number;
  timeoutMs: number;
  temperature: number;
}

/** llm_light 的默认参数（来自 smart-summarizer） */
export const LLM_LIGHT_DEFAULTS: LlmLightConfig = {
  maxTokens: LIGHT_CONFIG.maxTokens,
  timeoutMs: LIGHT_CONFIG.timeoutMs,
  temperature: LIGHT_CONFIG.temperature,
};

/** llm_light 的工具白名单（最小集，降低 prompt 体积） */
export const LLM_LIGHT_TOOL_ALLOWLIST = ["write", "read"];

/** llm_light 适用的 prompt 最大长度（超过此长度视为需要标准 LLM） */
const LLM_LIGHT_MAX_PROMPT_LEN = 500;

/** llm_light 适用的简单任务关键词 */
const LIGHT_TASK_PATTERNS = [
  /(?:摘要|总结|概括|归纳|提炼)/,
  /(?:summarize|summarise|recap|abstract|digest)/i,
  /(?:分类|归类|识别类型|标注)/,
  /(?:classify|categorize|label|tag)/i,
  /(?:格式化|转换格式|重新格式)/,
  /(?:format|convert|transform).*(?:to|into)/i,
  /(?:翻译|translate)/i,
  /(?:提取|抽取).*(?:关键词|标签|要点)/,
  /(?:extract).*(?:keywords|tags|key\s*points)/i,
];

// ────────────────────────────────────────────────────────────
// 策略匹配模式
// ────────────────────────────────────────────────────────────

/** 合并类任务的关键词模式 */
const MERGE_PATTERNS = [
  /合并.*(?:文件|章节|内容|输出|产出)/,
  /(?:merge|combine|concat).*(?:files|chapters|outputs)/i,
  /将.*(?:合并|拼接|汇总).*(?:成|为|到)/,
  /汇总.*(?:所有|全部).*(?:章节|文件|内容)/,
];

/** 交付类任务的关键词模式 */
const DELIVER_PATTERNS = [
  /发送.*(?:文件|结果|报告|产出)/,
  /(?:send|deliver).*(?:file|result|report)/i,
  /交付.*(?:给|到|至)/,
];

// ────────────────────────────────────────────────────────────
// 核心路由逻辑
// ────────────────────────────────────────────────────────────

/**
 * 为子任务选择执行策略
 *
 * 决策依据（优先级从高到低）：
 * 1. SubTask.preferredStrategy（如果已被模板/用户显式设置）
 * 2. SubTask.taskType（merge/delivery 类型直接路由到系统策略）
 * 3. Prompt 关键词匹配（兜底检测）
 *
 * @returns 执行策略
 */
export function routeStrategy(subTask: SubTask): ExecutionStrategy {
  // 1. 显式设置优先
  if (subTask.preferredStrategy) {
    const explicit = subTask.preferredStrategy as ExecutionStrategy;
    if (["llm", "llm_light", "system_merge", "system_deliver"].includes(explicit)) {
      return explicit;
    }
  }

  // 2. 基于 taskType 路由
  if (subTask.taskType === "merge") {
    return "system_merge";
  }
  if (subTask.taskType === "delivery") {
    return "system_deliver";
  }

  // 3. Prompt/Summary 关键词兜底检测
  // 安全门：prompt 较长（>300字符）说明是实质性任务，跳过关键词匹配，避免误路由
  const promptLen = (subTask.prompt ?? "").length;
  if (promptLen <= 300) {
    const text = `${subTask.prompt ?? ""} ${subTask.summary ?? ""}`;

    for (const pattern of MERGE_PATTERNS) {
      if (pattern.test(text)) {
        console.log(`[strategy-router] 📋 关键词匹配到合并策略: "${subTask.summary?.substring(0, 40)}"`);
        return "system_merge";
      }
    }

    for (const pattern of DELIVER_PATTERNS) {
      if (pattern.test(text)) {
        console.log(`[strategy-router] 📬 关键词匹配到交付策略: "${subTask.summary?.substring(0, 40)}"`);
        return "system_deliver";
      }
    }
  }

  // 4. llm_light 检测：短 prompt + 简单任务模式
  if (promptLen > 0 && promptLen <= LLM_LIGHT_MAX_PROMPT_LEN) {
    const text = `${subTask.prompt ?? ""} ${subTask.summary ?? ""}`;
    for (const pattern of LIGHT_TASK_PATTERNS) {
      if (pattern.test(text)) {
        console.log(`[strategy-router] 💡 关键词匹配到 llm_light 策略: "${subTask.summary?.substring(0, 40)}"`);
        return "llm_light";
      }
    }
  }

  // 默认走标准 LLM
  return "llm";
}

/**
 * 判断策略是否需要 LLM
 */
export function strategyRequiresLLM(strategy: ExecutionStrategy): boolean {
  return strategy === "llm" || strategy === "llm_light";
}

/**
 * 执行系统策略（非 LLM 路径）
 *
 * 目前支持：
 * - system_merge: 将子任务标记为已完成（合并逻辑已由 mergeSegmentsIfComplete/mergeTaskOutputs 处理）
 * - system_deliver: 标记交付任务为已完成（实际交付由 onRoundCompleted 处理）
 *
 * @returns 执行结果
 */
/**
 * 判断策略是否为 llm_light
 */
export function isLlmLightStrategy(strategy: ExecutionStrategy): boolean {
  return strategy === "llm_light";
}

/**
 * 获取 llm_light 的执行参数
 *
 * followup-runner 根据此参数调整：
 * - 降低 maxTokens / timeout
 * - 跳过 bootstrap context 和 skills
 * - 使用最小工具集
 */
export function getLlmLightParams(): {
  toolAllowlist: string[];
  skipBootstrapContext: boolean;
  skipSkills: boolean;
  maxTokens: number;
  timeoutMs: number;
  temperature: number;
} {
  return {
    toolAllowlist: LLM_LIGHT_TOOL_ALLOWLIST,
    skipBootstrapContext: true,
    skipSkills: true,
    maxTokens: LLM_LIGHT_DEFAULTS.maxTokens,
    timeoutMs: LLM_LIGHT_DEFAULTS.timeoutMs,
    temperature: LLM_LIGHT_DEFAULTS.temperature,
  };
}

export function executeSystemStrategy(
  strategy: ExecutionStrategy,
  subTask: SubTask,
  _context: {
    taskTree: TaskTree;
    workspaceDir?: string;
  },
): SystemStrategyResult {
  switch (strategy) {
    case "system_merge": {
      console.log(`[strategy-router] 🔧 系统合并策略: "${subTask.summary}" — 标记为完成（合并由 orchestrator 处理）`);
      return {
        output: `[系统自动完成] 合并任务「${subTask.summary}」由系统自动处理，无需 LLM 执行。`,
        producedFilePaths: [],
        success: true,
      };
    }
    case "system_deliver": {
      console.log(`[strategy-router] 📬 系统交付策略: "${subTask.summary}" — 标记为完成（交付由 onRoundCompleted 处理）`);
      return {
        output: `[系统自动完成] 交付任务「${subTask.summary}」由系统自动处理，无需 LLM 执行。`,
        producedFilePaths: [],
        success: true,
      };
    }
    default:
      return {
        output: "",
        producedFilePaths: [],
        success: false,
        error: `未知的系统策略: ${strategy}`,
      };
  }
}
