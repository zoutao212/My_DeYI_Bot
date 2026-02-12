/**
 * 任务产出验证器 — V6 核心组件
 *
 * 可插拔的验证策略框架，替代 postProcessSubTaskCompletion 中
 * 硬编码的写作专属字数检查。
 *
 * 设计原则：
 * - 策略注册制：每种验证策略独立实现，按 taskType 自动选取
 * - 零 LLM 调用：所有前置验证为规则驱动，LLM 质检仍由 quality-reviewer 负责
 * - 向后兼容：写作类任务的 word_count 验证行为不变
 * - 可组合：一个子任务可以有多个验证策略，全部通过才算通过
 */

import type { SubTask, TaskTree, PostProcessResult } from "./types.js";
import { classifyTaskType, isWordCountCritical, requiresFileOutput } from "./task-type-classifier.js";

// ========================================
// 验证策略接口
// ========================================

/**
 * 单个验证结果
 */
export interface ValidationResult {
  /** 策略名称 */
  strategy: string;
  /** 是否通过 */
  passed: boolean;
  /** 失败原因（passed=false 时必填） */
  reason?: string;
  /** 严重程度：critical 必须修复，warning 可以忽略 */
  severity: "critical" | "warning";
  /** 建议的决策（仅当 passed=false 时有意义） */
  suggestedDecision?: "restart" | "decompose" | "continue";
  /** 定量数据（如实际字数、文件数等） */
  metrics?: Record<string, number | string>;
}

/**
 * 综合验证结果
 */
export interface AggregatedValidationResult {
  /** 所有验证结果 */
  results: ValidationResult[];
  /** 是否全部通过 */
  allPassed: boolean;
  /** 是否有 critical 级别的失败 */
  hasCriticalFailure: boolean;
  /** 最严重的建议决策 */
  suggestedDecision: "continue" | "restart" | "decompose";
}

/**
 * 验证策略接口
 */
interface ValidationStrategy {
  /** 策略名称（唯一标识） */
  name: string;
  /** 执行验证 */
  validate(subTask: SubTask, taskTree: TaskTree, context: ValidationContext): Promise<ValidationResult>;
}

/**
 * 验证上下文（传递给每个策略的共享信息）
 */
export interface ValidationContext {
  /** 实际文件内容（如果已读取） */
  actualContent?: string;
  /** 实际内容长度 */
  actualLength?: number;
  /** 已产出的文件路径 */
  producedFilePaths?: string[];
  /** 兜底文件路径 */
  fallbackFilePath?: string;
  /** 工具调用记录 */
  toolCalls?: Array<{ name: string; args?: unknown }>;
  /** 🔧 P31: 覆盖要执行的验证策略列表（优先于 subTask.metadata.validationStrategies） */
  overrideStrategies?: string[];
}

// ========================================
// 🔧 P51: 公共字数阈值计算（统一标准）
// ========================================

/**
 * 根据子任务类型计算字数达标阈值比例
 * 
 * 🔧 P51 修复：quality-reviewer 和 task-output-validator 曾各自维护阈值，
 * 导致同一子任务被两个验证器用不同标准判定（OutputValidator 通过但 QualityReviewer 拒绝）。
 * 提取为公共函数，确保全系统使用同一标准。
 * 
 * @param subTask 待验证的子任务
 * @returns 字数达标比例阈值（0-1），低于此比例判定为不达标
 */
export function calculateWordCountThreshold(subTask: SubTask): number {
  if (subTask.metadata?.isSegment) {
    return 0.6; // 分段子任务：LLM 短文产出波动更大
  } else if (subTask.metadata?.isContinuation) {
    return 0.55; // 续写子任务：补充性质，目标精度低
  } else if (subTask.metadata?.isChunkTask) {
    return 0.5; // Map-Reduce chunk：分析类输出长度不可预测
  }
  return 0.7; // 默认基线
}

// ========================================
// 内置验证策略
// ========================================

/**
 * 字数验证策略（写作类专用）
 *
 * 逻辑与原 postProcessSubTaskCompletion 中的字数前置检查一致：
 * - 提取 prompt 中的字数要求
 * - 对比实际产出长度
 * - 低于 70% 判定失败
 */
const wordCountStrategy: ValidationStrategy = {
  name: "word_count",
  async validate(subTask, _taskTree, context) {
    // 只对写作类任务生效
    if (!isWordCountCritical(subTask.taskType ?? "generic")) {
      return { strategy: "word_count", passed: true, severity: "warning" };
    }

    // 提取字数要求（使用与 quality-reviewer 相同的逻辑）
    const wcMatch = subTask.prompt.match(/(?:约|大约|至少|不少于|≥|>=)?\s*(\d{3,})\s*(?:字|词|个字|characters?|words?)/i);
    if (!wcMatch) {
      return { strategy: "word_count", passed: true, severity: "warning", reason: "无明确字数要求" };
    }

    const required = parseInt(wcMatch[1], 10);
    const actual = context.actualLength ?? 0;
    const ratio = actual / Math.max(required, 1);
    // 🔧 P51: 使用公共阈值计算函数（替代各自维护的硬编码阈值）
    const threshold = calculateWordCountThreshold(subTask);

    if (ratio < threshold) {
      return {
        strategy: "word_count",
        passed: false,
        severity: "critical",
        reason: `字数不达标：要求 ${required} 字，实际 ${actual} 字（${Math.round(ratio * 100)}%，阈值 ${Math.round(threshold * 100)}%）`,
        suggestedDecision: actual >= 500 ? "decompose" : "restart",
        metrics: { required, actual, ratio: Math.round(ratio * 100) },
      };
    }

    return {
      strategy: "word_count",
      passed: true,
      severity: "warning",
      metrics: { required, actual, ratio: Math.round(ratio * 100) },
    };
  },
};

/**
 * 文件产出验证策略
 *
 * 检查任务是否产出了预期的文件。
 * 适用于写作、编码、数据处理等需要文件输出的任务类型。
 */
const fileOutputStrategy: ValidationStrategy = {
  name: "file_output",
  async validate(subTask, _taskTree, context) {
    if (!requiresFileOutput(subTask.taskType ?? "generic")) {
      return { strategy: "file_output", passed: true, severity: "warning" };
    }

    // 检查是否有文件产出
    const hasProducedFiles = (context.producedFilePaths?.length ?? 0) > 0;
    const hasFallback = !!context.fallbackFilePath;
    const hasContent = (context.actualLength ?? 0) > 0;

    if (!hasProducedFiles && !hasFallback && !hasContent) {
      return {
        strategy: "file_output",
        passed: false,
        severity: "critical",
        reason: "任务要求文件输出，但未检测到任何文件产出",
        suggestedDecision: "restart",
      };
    }

    return {
      strategy: "file_output",
      passed: true,
      severity: "warning",
      metrics: {
        fileCount: context.producedFilePaths?.length ?? 0,
        contentLength: context.actualLength ?? 0,
      },
    };
  },
};

/**
 * 完成度验证策略（通用）
 *
 * 检查任务输出是否为空或过短（可能是 LLM 偷懒）。
 * 适用于所有任务类型。
 */
const completenessStrategy: ValidationStrategy = {
  name: "completeness",
  async validate(subTask, _taskTree, context) {
    const output = subTask.output ?? "";
    const content = context.actualContent ?? output;

    // 极端情况：完全无输出
    if (!content || content.trim().length === 0) {
      return {
        strategy: "completeness",
        passed: false,
        severity: "critical",
        reason: "任务产出为空",
        suggestedDecision: "restart",
      };
    }

    // 检测 LLM 偷懒模式：输出只有确认消息（如"已完成"、"Done"），无实质内容
    const lazyPatterns = [
      /^(?:已完成|完成了?|好的|Done|Completed|OK|Sure)[\s。.!！]*$/i,
      /^(?:任务已完成|我已经完成了)[\s。.!！]*$/i,
    ];
    if (lazyPatterns.some(p => p.test(content.trim())) && !context.producedFilePaths?.length) {
      return {
        strategy: "completeness",
        passed: false,
        severity: "critical",
        reason: "输出疑似 LLM 偷懒：仅有确认消息，无实质内容",
        suggestedDecision: "restart",
      };
    }

    // 过短检测：prompt 很长但输出很短
    const promptLength = subTask.prompt.length;
    const contentLength = content.length;
    if (promptLength > 500 && contentLength < 50 && !context.producedFilePaths?.length) {
      return {
        strategy: "completeness",
        passed: false,
        severity: "warning",
        reason: `输出可能不完整：prompt ${promptLength} 字符，输出仅 ${contentLength} 字符`,
        suggestedDecision: "restart",
      };
    }

    return { strategy: "completeness", passed: true, severity: "warning" };
  },
};

/**
 * 结构化输出验证策略
 *
 * 检查分析/数据/研究类任务是否产出了有结构的内容
 * （而非随意堆砌文字）。
 */
const structuredOutputStrategy: ValidationStrategy = {
  name: "structured_output",
  async validate(subTask, _taskTree, context) {
    const taskType = subTask.taskType ?? "generic";
    if (!["analysis", "research", "data", "design"].includes(taskType)) {
      return { strategy: "structured_output", passed: true, severity: "warning" };
    }

    const content = context.actualContent ?? subTask.output ?? "";
    if (content.length < 100) {
      return { strategy: "structured_output", passed: true, severity: "warning" };
    }

    // 检查结构化信号（Markdown 标题、列表、表格等）
    const structuralSignals = [
      /^#+\s/m,           // Markdown 标题
      /^\s*[-*]\s/m,      // 无序列表
      /^\s*\d+\.\s/m,     // 有序列表
      /\|.*\|.*\|/m,      // 表格
      /```/m,             // 代码块
      /\*\*[^*]+\*\*/m,   // 加粗关键字
    ];

    const signalCount = structuralSignals.filter(p => p.test(content)).length;

    if (signalCount < 2 && content.length > 500) {
      return {
        strategy: "structured_output",
        passed: false,
        severity: "warning",
        reason: `分析/研究类产出缺乏结构化格式（仅检测到 ${signalCount} 个结构信号），建议使用标题、列表或表格组织内容`,
        suggestedDecision: "continue", // 非致命，不阻塞
        metrics: { signalCount },
      };
    }

    return {
      strategy: "structured_output",
      passed: true,
      severity: "warning",
      metrics: { signalCount },
    };
  },
};

/**
 * 工具调用验证策略
 *
 * 检查自动化类任务是否实际调用了工具（而不是只生成了描述）。
 */
const toolUsageStrategy: ValidationStrategy = {
  name: "tool_usage",
  async validate(subTask, _taskTree, context) {
    if ((subTask.taskType ?? "generic") !== "automation") {
      return { strategy: "tool_usage", passed: true, severity: "warning" };
    }

    const toolCallCount = context.toolCalls?.length ?? 0;

    if (toolCallCount === 0) {
      return {
        strategy: "tool_usage",
        passed: false,
        severity: "warning",
        reason: "自动化任务未检测到工具调用，可能只生成了描述而未实际执行",
        suggestedDecision: "restart",
        metrics: { toolCallCount },
      };
    }

    return {
      strategy: "tool_usage",
      passed: true,
      severity: "warning",
      metrics: { toolCallCount },
    };
  },
};

// ========================================
// 策略注册表
// ========================================

const STRATEGY_REGISTRY = new Map<string, ValidationStrategy>();

// 注册内置策略
[
  wordCountStrategy,
  fileOutputStrategy,
  completenessStrategy,
  structuredOutputStrategy,
  toolUsageStrategy,
].forEach(s => STRATEGY_REGISTRY.set(s.name, s));

/**
 * 注册自定义验证策略
 */
export function registerValidationStrategy(strategy: ValidationStrategy): void {
  STRATEGY_REGISTRY.set(strategy.name, strategy);
}

// ========================================
// 核心验证函数
// ========================================

/**
 * 对子任务执行所有适用的验证策略
 *
 * @param subTask 已完成的子任务
 * @param taskTree 任务树
 * @param context 验证上下文
 * @returns 综合验证结果
 */
export async function validateTaskOutput(
  subTask: SubTask,
  taskTree: TaskTree,
  context: ValidationContext,
): Promise<AggregatedValidationResult> {
  // 确定要执行的验证策略
  // 🔧 P31 修复：优先使用 context.overrideStrategies（调用方已过滤掉不适用的策略）
  const strategyNames = context.overrideStrategies ?? subTask.metadata?.validationStrategies ?? ["completeness"];

  const results: ValidationResult[] = [];

  for (const name of strategyNames) {
    const strategy = STRATEGY_REGISTRY.get(name);
    if (!strategy) {
      console.warn(`[TaskOutputValidator] ⚠️ 未知验证策略: ${name}，跳过`);
      continue;
    }

    try {
      const result = await strategy.validate(subTask, taskTree, context);
      results.push(result);
    } catch (err) {
      console.warn(`[TaskOutputValidator] ⚠️ 验证策略 ${name} 执行失败:`, err);
      results.push({
        strategy: name,
        passed: true, // 验证出错时不阻塞
        severity: "warning",
        reason: `验证执行出错: ${err}`,
      });
    }
  }

  // 汇总结果
  const allPassed = results.every(r => r.passed);
  const hasCriticalFailure = results.some(r => !r.passed && r.severity === "critical");

  // 计算最严重的建议决策
  let suggestedDecision: "continue" | "restart" | "decompose" = "continue";
  for (const r of results) {
    if (!r.passed && r.suggestedDecision) {
      if (r.suggestedDecision === "restart" && suggestedDecision === "continue") {
        suggestedDecision = "restart";
      }
      if (r.suggestedDecision === "decompose") {
        suggestedDecision = "decompose";
      }
    }
  }

  // 写入 metadata（供后续质检和日志使用）
  if (!subTask.metadata) subTask.metadata = {};
  subTask.metadata.passedValidations = results.filter(r => r.passed).map(r => r.strategy);
  subTask.metadata.failedValidations = results
    .filter(r => !r.passed)
    .map(r => ({ strategy: r.strategy, reason: r.reason ?? "未知原因" }));

  // 日志
  const passCount = results.filter(r => r.passed).length;
  const failCount = results.filter(r => !r.passed).length;
  if (failCount > 0) {
    console.log(
      `[TaskOutputValidator] ⚠️ 子任务 ${subTask.id} 验证结果: ${passCount} 通过, ${failCount} 失败` +
      ` (critical=${hasCriticalFailure}, decision=${suggestedDecision})` +
      `\n  失败详情: ${results.filter(r => !r.passed).map(r => `[${r.strategy}] ${r.reason}`).join("; ")}`,
    );
  } else {
    console.log(
      `[TaskOutputValidator] ✅ 子任务 ${subTask.id} 验证全部通过 (${passCount} 策略)`,
    );
  }

  return { results, allPassed, hasCriticalFailure, suggestedDecision };
}

/**
 * 快速检查：子任务是否需要前置验证
 *
 * 用于在进入 LLM 质检之前快速判断是否需要执行规则驱动的验证。
 * 如果没有配置 validationStrategies，默认至少执行 completeness 检查。
 */
export function shouldRunPreValidation(subTask: SubTask): boolean {
  return (subTask.metadata?.validationStrategies?.length ?? 0) > 0 || true;
}
