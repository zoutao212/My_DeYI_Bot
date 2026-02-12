/**
 * V8 P1: 任务模板系统 (Task Template)
 *
 * 为每种 TaskType 预定义标准化的：
 * - 分解策略（推荐的子任务拆分方式）
 * - 命名规范（子任务 summary、文件名的格式化规则）
 * - 验证规则（OutputContract 默认值）
 * - 执行策略偏好（preferredStrategy）
 *
 * 消除的问题：
 * - LLM 自由命名导致的文件名混乱（P37/P68/P69）
 * - 合并/交付任务浪费 LLM token（P36）
 * - 续写任务丢失父任务元数据（S1/L2）
 * - 分解粒度不合理（V4 分段常量硬编码）
 *
 * 设计原则：
 * - 模板是"建议"而非"强制"，LLM 分解结果优先
 * - 模板只在 LLM 未提供信息时作为兜底填充
 * - 零 LLM 调用，纯配置驱动
 */

import type { TaskType, OutputContract } from "./types.js";
import type { ExecutionStrategy } from "./strategy-router.js";

// ────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────

/**
 * 任务模板 — 为特定 TaskType 提供标准化配置
 */
export interface TaskTemplate {
  /** 任务类型 */
  taskType: TaskType;

  /** 显示名称（用于日志） */
  displayName: string;

  // ── 分解策略 ──

  /** 推荐的子任务拆分粒度（字数/步骤数） */
  decomposition: {
    /** 单个子任务的目标字数（写作类） */
    segmentTargetChars?: number;
    /** 单个子任务的最小字数 */
    segmentMinChars?: number;
    /** 单个子任务的最大字数 */
    segmentMaxChars?: number;
    /** 默认总字数（未指定时） */
    defaultTotalChars?: number;
    /** 是否建议自动分解 */
    autoDecompose: boolean;
    /** 自动分解的 prompt 长度阈值（字符数） */
    autoDecomposeThreshold: number;
  };

  // ── 命名规范 ──

  /** 子任务 summary 的命名模板（支持 {index}, {total}, {chapterNum} 占位符） */
  summaryTemplate?: string;
  /** 文件名模板（支持 {bookName}, {chapterNum}, {segmentIndex} 占位符） */
  fileNameTemplate?: string;
  /** 合并后的文件名模板 */
  mergedFileNameTemplate?: string;

  // ── 验证规则 ──

  /** OutputContract 默认值 */
  defaultOutputContract: Partial<OutputContract>;
  /** 默认验证策略列表 */
  validationStrategies: string[];

  // ── 执行偏好 ──

  /** 推荐的执行策略 */
  preferredStrategy: ExecutionStrategy;
  /** 工具白名单（如果需要额外工具） */
  additionalTools?: string[];
  /** 建议的 maxOutputTokens（override） */
  suggestedMaxOutputTokens?: number;
}

// ────────────────────────────────────────────────────────────
// 模板注册表
// ────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, TaskTemplate> = {
  writing: {
    taskType: "writing",
    displayName: "写作",
    decomposition: {
      segmentTargetChars: 1200,
      segmentMinChars: 800,
      segmentMaxChars: 1600,
      defaultTotalChars: 6000,
      autoDecompose: true,
      autoDecomposeThreshold: 500,
    },
    summaryTemplate: "创作第{chapterNum}章：{title}",
    fileNameTemplate: "{bookName}_第{chapterNum}章_第{segmentIndex}节.txt",
    mergedFileNameTemplate: "{bookName}_第{chapterNum}章.txt",
    defaultOutputContract: {
      expectedLanguage: "zh-CN",
      minChars: 800,
      maxChars: 2000,
    },
    validationStrategies: ["word_count", "file_output", "completeness"],
    preferredStrategy: "llm",
    suggestedMaxOutputTokens: 4096,
  },

  coding: {
    taskType: "coding",
    displayName: "编码",
    decomposition: {
      autoDecompose: true,
      autoDecomposeThreshold: 800,
    },
    defaultOutputContract: {
      expectedLanguage: "en",
    },
    validationStrategies: ["file_output", "syntax_check"],
    preferredStrategy: "llm",
    additionalTools: ["test"],
    suggestedMaxOutputTokens: 8192,
  },

  analysis: {
    taskType: "analysis",
    displayName: "分析",
    decomposition: {
      autoDecompose: false,
      autoDecomposeThreshold: 1500,
    },
    defaultOutputContract: {},
    validationStrategies: ["file_output", "completeness"],
    preferredStrategy: "llm",
    additionalTools: ["web", "fetch"],
  },

  research: {
    taskType: "research",
    displayName: "研究",
    decomposition: {
      autoDecompose: false,
      autoDecomposeThreshold: 1500,
    },
    defaultOutputContract: {},
    validationStrategies: ["file_output"],
    preferredStrategy: "llm",
    additionalTools: ["web", "fetch"],
  },

  automation: {
    taskType: "automation",
    displayName: "自动化",
    decomposition: {
      autoDecompose: false,
      autoDecomposeThreshold: 2000,
    },
    defaultOutputContract: {},
    validationStrategies: ["file_output"],
    preferredStrategy: "llm",
    additionalTools: ["browser", "web", "fetch"],
  },

  data: {
    taskType: "data",
    displayName: "数据处理",
    decomposition: {
      autoDecompose: false,
      autoDecomposeThreshold: 1500,
    },
    defaultOutputContract: {},
    validationStrategies: ["file_output"],
    preferredStrategy: "llm",
  },

  merge: {
    taskType: "merge",
    displayName: "合并",
    decomposition: {
      autoDecompose: false,
      autoDecomposeThreshold: Infinity,
    },
    defaultOutputContract: {},
    validationStrategies: [],
    preferredStrategy: "system_merge",
  },

  delivery: {
    taskType: "delivery",
    displayName: "交付",
    decomposition: {
      autoDecompose: false,
      autoDecomposeThreshold: Infinity,
    },
    defaultOutputContract: {},
    validationStrategies: [],
    preferredStrategy: "system_deliver",
  },

  generic: {
    taskType: "generic",
    displayName: "通用",
    decomposition: {
      autoDecompose: false,
      autoDecomposeThreshold: 1000,
    },
    defaultOutputContract: {},
    validationStrategies: ["file_output"],
    preferredStrategy: "llm",
  },
};

// ────────────────────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────────────────────

/**
 * 获取指定任务类型的模板
 */
export function getTaskTemplate(taskType: TaskType | string): TaskTemplate {
  return TEMPLATES[taskType] ?? TEMPLATES["generic"]!;
}

/**
 * 获取所有已注册的模板
 */
export function getAllTemplates(): TaskTemplate[] {
  return Object.values(TEMPLATES);
}

/**
 * 应用命名模板 — 将占位符替换为实际值
 *
 * @param template 模板字符串（含 {bookName}, {chapterNum} 等占位符）
 * @param vars 变量映射
 * @returns 替换后的字符串
 */
export function applyNamingTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
  }
  // 清洗 Windows 非法文件名字符
  result = result.replace(/[：:*?"<>|]/g, "_");
  return result;
}

/**
 * 生成标准化的 OutputContract（用模板默认值兜底）
 *
 * 优先使用 overrides 中的值，未提供的用模板默认值填充。
 */
export function buildOutputContract(
  taskType: TaskType | string,
  overrides?: Partial<OutputContract>,
): OutputContract {
  const template = getTaskTemplate(taskType);
  return {
    ...template.defaultOutputContract,
    ...overrides,
  } as OutputContract;
}

/**
 * 根据模板判断子任务是否应该自动分解
 *
 * 比 shouldAutoDecompose 更精确：考虑任务模板的阈值配置。
 */
export function templateSuggestsDecompose(
  taskType: TaskType | string,
  promptLength: number,
): boolean {
  const template = getTaskTemplate(taskType);
  return template.decomposition.autoDecompose && promptLength >= template.decomposition.autoDecomposeThreshold;
}
