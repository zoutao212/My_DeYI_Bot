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
