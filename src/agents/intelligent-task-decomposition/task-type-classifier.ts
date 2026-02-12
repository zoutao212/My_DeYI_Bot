/**
 * 统一任务类型分类器 — V6 核心组件
 *
 * 替代散落在 orchestrator / shouldAutoDecompose / decomposeSubTask 中的
 * 各种独立关键词匹配逻辑，提供单一入口进行任务类型推导。
 *
 * 设计原则：
 * - 快速路径：纯规则驱动（零 LLM 调用），用于热路径
 * - LLM 辅助：低置信度时用轻量 LLM 消歧（异步路径，用于关键决策点）
 * - 多维度匹配：关键词 + 结构信号 + prompt 模式
 * - 可扩展：新增任务类型只需在 TASK_TYPE_RULES 中添加规则
 * - 向后兼容：原有 isWritingPrompt / isAnalysisPrompt 的能力完全覆盖
 */

import type { TaskType, SubTask } from "./types.js";
import type { LLMCaller } from "./batch-executor.js";
import { extractJsonFromResponse } from "./json-extractor.js";

// ========================================
// 任务类型分类规则
// ========================================

/**
 * 单条分类规则
 */
interface TaskTypeRule {
  /** 任务类型 */
  type: TaskType;
  /** 匹配权重（多个规则命中时取权重最高的） */
  weight: number;
  /** 关键词列表（prompt 包含任一即可） */
  keywords: string[];
  /** 结构信号（prompt 中出现的模式，比"关键词"更强的信号） */
  structuralPatterns?: RegExp[];
  /** 默认验证策略（命中后自动填充到 metadata.validationStrategies） */
  validationStrategies: string[];
  /** 是否适合自动分解（作为 shouldAutoDecompose 的维度之一） */
  autoDecomposeHeuristic: (prompt: string) => boolean;
}

/**
 * 分类规则表（按权重降序排列）
 *
 * 权重设计：
 * - 90+: 强信号类型（有明确结构标志）
 * - 70-89: 中等信号（关键词匹配）
 * - 50-69: 弱信号（宽泛关键词）
 * - 0: 兜底 generic
 */
const TASK_TYPE_RULES: TaskTypeRule[] = [
  // ── 写作类 ──
  {
    type: "writing",
    weight: 85,
    keywords: [
      "写", "创作", "撰写", "小说", "文章", "故事", "章节", "散文", "诗", "剧本",
      "续写", "改写", "仿写", "翻译", "论文", "报告", "文案", "博客", "日记",
      "write", "novel", "story", "chapter", "essay", "article", "blog",
      "translate", "script", "poem", "draft", "compose", "author",
    ],
    structuralPatterns: [
      /(?:写|创作|撰写)\s*(?:\d+|[一二三四五六七八九十百千万]+)\s*(?:字|章|篇)/,
      /(?:word\s*count|字数)[：:]\s*\d+/i,
      /第\s*\d+\s*章/,
      /chapter\s*\d+/i,
    ],
    validationStrategies: ["word_count", "file_output", "completeness"],
    autoDecomposeHeuristic: (prompt) => {
      // 写作类：字数要求 >= 1500 或 prompt 很长
      const wcMatch = prompt.match(/(\d{4,})\s*(?:字|词|words?|characters?)/i);
      if (wcMatch && parseInt(wcMatch[1]) >= 1500) return true;
      return prompt.length > 800;
    },
  },

  // ── 编码类 ──
  {
    type: "coding",
    weight: 85,
    keywords: [
      "代码", "编程", "实现", "开发", "修复", "重构", "优化", "bug", "特性",
      "函数", "类", "接口", "API", "模块", "组件", "测试", "单元测试",
      "code", "program", "implement", "develop", "fix", "refactor",
      "function", "class", "interface", "module", "component", "test",
      "feature", "debug", "compile", "build", "deploy",
    ],
    structuralPatterns: [
      /(?:```|~~~)\s*(?:js|ts|py|java|go|rust|cpp|c\+\+|ruby|swift|kotlin)/i,
      /(?:import|require|from)\s+['"][^'"]+['"]/,
      /(?:function|class|interface|type|const|let|var)\s+\w+/,
      /\.(?:ts|js|py|java|go|rs|cpp|rb|swift|kt)(?:\s|$)/,
    ],
    validationStrategies: ["file_output", "completeness"],
    autoDecomposeHeuristic: (prompt) => {
      // 编码类：多文件/多模块信号 或 prompt 很长
      const multiFileSignals = [
        /(?:多个|several|multiple)\s*(?:文件|模块|组件|files?|modules?|components?)/i,
        /(?:前端|后端|frontend|backend|full.?stack)/i,
        /(?:数据库|database|schema|migration)/i,
        /(?:步骤|steps?)\s*[：:]\s*\n/i,
      ];
      if (multiFileSignals.some(p => p.test(prompt))) return true;
      return prompt.length > 1000;
    },
  },

  // ── 设计类 ──
  {
    type: "design",
    weight: 80,
    keywords: [
      "设计", "架构", "规划", "方案", "蓝图", "系统设计", "技术方案",
      "设计文档", "PRD", "需求文档", "产品需求",
      "design", "architecture", "blueprint", "solution", "spec",
      "technical design", "system design", "RFC",
    ],
    structuralPatterns: [
      /(?:系统|技术|架构|产品)\s*(?:设计|方案|规划)/,
      /(?:design|architect)\s+(?:a|the|this)\s+/i,
    ],
    validationStrategies: ["completeness", "structured_output"],
    autoDecomposeHeuristic: (prompt) => {
      return prompt.length > 600;
    },
  },

  // ── 研究类 ──
  {
    type: "research",
    weight: 75,
    keywords: [
      "研究", "调查", "调研", "搜索", "查找", "探索", "考察", "比较",
      "对比", "评测", "竞品", "行业分析", "市场分析",
      "research", "investigate", "explore", "survey", "compare",
      "benchmark", "competitor", "market analysis",
    ],
    structuralPatterns: [
      /(?:调研|研究|对比)\s*(?:报告|分析)/,
      /(?:research|investigate)\s+(?:about|on|into)/i,
    ],
    validationStrategies: ["completeness", "structured_output", "file_output"],
    autoDecomposeHeuristic: (prompt) => {
      // 研究类：多个研究维度或对象
      const multiDimSignals = [
        /(?:从|包括|涵盖)\s*(?:\d+|[多几])\s*(?:个|方面|维度|角度)/,
        /(?:分别|respectively|each)/i,
      ];
      if (multiDimSignals.some(p => p.test(prompt))) return true;
      return prompt.length > 800;
    },
  },

  // ── 数据处理类 ──
  {
    type: "data",
    weight: 75,
    keywords: [
      "数据", "处理", "统计", "计算", "转换", "ETL", "清洗", "导入", "导出",
      "CSV", "JSON", "Excel", "表格", "图表",
      "data", "process", "calculate", "transform", "parse", "convert",
      "csv", "json", "excel", "spreadsheet", "chart",
    ],
    structuralPatterns: [
      /\.(?:csv|xlsx?|json|tsv|parquet|sql)(?:\s|$)/i,
      /(?:数据|data)\s*(?:处理|清洗|转换|分析|导入|导出)/,
    ],
    validationStrategies: ["file_output", "structured_output", "completeness"],
    autoDecomposeHeuristic: (prompt) => {
      return prompt.length > 600;
    },
  },

  // ── 分析类 ──
  {
    type: "analysis",
    weight: 70,
    keywords: [
      "分析", "学习", "提取", "总结", "摘要", "归纳", "梳理", "整理",
      "模仿", "风格", "角色", "人物", "剧情", "审查", "审阅", "评估",
      "analyze", "extract", "summarize", "review", "evaluate",
      "study", "learn", "character", "style", "plot",
    ],
    structuralPatterns: [
      /(?:分析|学习|提取)\s*(?:以下|这个|这篇|该)/,
      /(?:analyze|extract|summarize)\s+(?:the|this|these)/i,
    ],
    validationStrategies: ["completeness", "structured_output"],
    autoDecomposeHeuristic: (prompt) => {
      // 分析类：大文件或多文件输入
      const filePattern = /(?:[A-Za-z]:[\\\/][^\s]+|\/[^\s]+|\.\/[^\s]+)\.(?:txt|md|csv|json)/i;
      if (filePattern.test(prompt)) return true;
      return prompt.length > 800;
    },
  },

  // ── 自动化/操作类 ──
  {
    type: "automation",
    weight: 70,
    keywords: [
      "自动化", "批量", "流水线", "工作流", "脚本", "定时", "监控",
      "部署", "发布", "迁移", "安装", "配置", "设置",
      "automate", "batch", "pipeline", "workflow", "script",
      "deploy", "release", "migrate", "install", "configure", "setup",
    ],
    structuralPatterns: [
      /(?:自动|批量)\s*(?:化|执行|处理|部署)/,
      /(?:automate|batch)\s+(?:the|this|these)/i,
    ],
    validationStrategies: ["tool_usage", "completeness"],
    autoDecomposeHeuristic: (prompt) => {
      // 自动化类：多步骤信号
      const multiStepSignals = [
        /(?:步骤|steps?|阶段|phases?)\s*[：:]/i,
        /(?:然后|接着|最后|first|then|finally)/i,
        /\d+\.\s+/,
      ];
      const stepCount = (prompt.match(/\d+\.\s+/g) || []).length;
      if (stepCount >= 3) return true;
      return multiStepSignals.filter(p => p.test(prompt)).length >= 2;
    },
  },

  // ── 规划类 ──
  {
    type: "planning",
    weight: 65,
    keywords: [
      "计划", "规划", "大纲", "提纲", "路线图", "里程碑",
      "plan", "outline", "roadmap", "milestone", "strategy",
    ],
    validationStrategies: ["completeness", "structured_output"],
    autoDecomposeHeuristic: () => false, // 规划类通常不需要分解
  },

  // ── 审校类 ──
  {
    type: "review",
    weight: 65,
    keywords: [
      "校对", "审校", "校稿", "润色", "修改", "纠错", "校验",
      "proofread", "review", "revise", "edit", "polish", "correct",
    ],
    validationStrategies: ["completeness", "file_output"],
    autoDecomposeHeuristic: (prompt) => {
      return prompt.length > 1000;
    },
  },
];

// ========================================
// 分类结果
// ========================================

/**
 * 任务类型分类结果
 */
export interface TaskTypeClassification {
  /** 推断的任务类型 */
  type: TaskType;
  /** 置信度 0-100 */
  confidence: number;
  /** 命中的规则权重 */
  weight: number;
  /** 命中的关键词（用于日志） */
  matchedKeywords: string[];
  /** 命中的结构信号数 */
  structuralMatches: number;
  /** 推荐的验证策略 */
  validationStrategies: string[];
  /** 是否建议自动分解 */
  shouldAutoDecompose: boolean;
}

// ========================================
// 核心分类函数
// ========================================

/**
 * 对 prompt 进行任务类型分类
 *
 * 零 LLM 调用，纯规则驱动。
 * 多规则命中时取综合得分最高的类型。
 *
 * @param prompt 任务 prompt
 * @returns 分类结果
 */
export function classifyTaskType(prompt: string): TaskTypeClassification {
  const lowerPrompt = prompt.toLowerCase();

  let bestResult: TaskTypeClassification | null = null;

  for (const rule of TASK_TYPE_RULES) {
    // 关键词匹配
    const matchedKeywords = rule.keywords.filter(kw => lowerPrompt.includes(kw.toLowerCase()));
    if (matchedKeywords.length === 0) continue;

    // 结构信号匹配
    let structuralMatches = 0;
    if (rule.structuralPatterns) {
      structuralMatches = rule.structuralPatterns.filter(p => p.test(prompt)).length;
    }

    // 综合得分 = 基础权重 + 关键词命中数加成 + 结构信号加成
    const keywordBonus = Math.min(matchedKeywords.length * 3, 15); // 每个关键词 +3，上限 15
    const structuralBonus = structuralMatches * 10; // 每个结构信号 +10
    const score = rule.weight + keywordBonus + structuralBonus;

    // 置信度 = score / 120 * 100（上限 100）
    const confidence = Math.min(100, Math.round(score / 120 * 100));

    // 自动分解建议
    const shouldAutoDecompose = rule.autoDecomposeHeuristic(prompt);

    const result: TaskTypeClassification = {
      type: rule.type,
      confidence,
      weight: score,
      matchedKeywords,
      structuralMatches,
      validationStrategies: rule.validationStrategies,
      shouldAutoDecompose,
    };

    if (!bestResult || score > bestResult.weight) {
      bestResult = result;
    }
  }

  // 兜底：generic
  if (!bestResult) {
    return {
      type: "generic",
      confidence: 30,
      weight: 0,
      matchedKeywords: [],
      structuralMatches: 0,
      validationStrategies: ["completeness"],
      shouldAutoDecompose: prompt.length > 1500,
    };
  }

  return bestResult;
}

/**
 * 为 SubTask 分类并填充 metadata
 *
 * 自动设置 taskType 和 validationStrategies。
 * 如果子任务已有 taskType 则不覆盖。
 *
 * @param subTask 子任务
 * @returns 分类结果
 */
export function classifyAndEnrich(subTask: SubTask): TaskTypeClassification {
  const classification = classifyTaskType(subTask.prompt);

  // 设置 taskType（不覆盖已有值）
  if (!subTask.taskType) {
    subTask.taskType = classification.type;
  }

  // 设置验证策略（不覆盖已有值）
  if (!subTask.metadata) {
    subTask.metadata = {};
  }
  if (!subTask.metadata.validationStrategies) {
    subTask.metadata.validationStrategies = classification.validationStrategies;
  }

  return classification;
}

/**
 * 获取任务类型对应的 blueprint 类型提示 key
 *
 * 将细分的 TaskType 映射到 blueprintTypeHints 中的 key。
 *
 * @param taskType 任务类型
 * @returns blueprint 类型 key
 */
export function getBlueprintTypeKey(taskType: TaskType): string {
  switch (taskType) {
    case "writing":
      return "writing";
    case "coding":
      return "coding";
    case "design":
      return "design";
    case "research":
      return "research";
    case "data":
      return "data";
    case "analysis":
      return "analysis";
    default:
      return "generic";
  }
}

/**
 * 判断任务类型是否需要文件产出
 */
export function requiresFileOutput(taskType: TaskType): boolean {
  return ["writing", "coding", "data", "analysis", "research"].includes(taskType);
}

/**
 * 判断任务类型是否以文字量为主要质量指标
 */
export function isWordCountCritical(taskType: TaskType): boolean {
  return taskType === "writing";
}

// ========================================
// 向后兼容：替代原有的散落方法
// ========================================

/**
 * 兼容原 orchestrator.isWritingPrompt()
 */
export function isWritingPrompt(prompt: string): boolean {
  const result = classifyTaskType(prompt);
  return result.type === "writing";
}

/**
 * 兼容原 orchestrator.isAnalysisPrompt()
 */
export function isAnalysisPrompt(prompt: string): boolean {
  const result = classifyTaskType(prompt);
  return result.type === "analysis" || result.type === "research";
}

// ========================================
// 🆕 LLM 辅助分类（低置信度消歧）
// ========================================

/** LLM 消歧的置信度阈值 — 低于此值触发 LLM 调用 */
const LLM_DISAMBIGUATION_THRESHOLD = 60;

/** 简单的分类结果缓存（避免对相同 prompt 重复调用 LLM） */
const classificationCache = new Map<string, TaskTypeClassification>();
const CACHE_MAX_SIZE = 100;

/**
 * 🆕 LLM 辅助任务分类 — 低置信度时用轻量 LLM 消歧
 *
 * 先走纯规则的快速路径（classifyTaskType），如果置信度 < 60%
 * 且 LLM 可用，则用极短 prompt 让 LLM 从候选类型中选择。
 *
 * 典型场景："写一个 Python 脚本来分析销售数据并生成报告"
 * → 规则匹配命中 writing(写)/coding(脚本)/data(数据)/analysis(分析)
 * → 置信度 55%（多类型竞争）
 * → LLM 消歧 → coding（核心动作是写代码）
 *
 * @param prompt 任务 prompt
 * @param llmCaller 可选的 LLM 调用器（无则退化为纯规则）
 * @returns 分类结果（可能被 LLM 修正）
 */
export async function classifyTaskTypeWithLLM(
  prompt: string,
  llmCaller?: LLMCaller | null,
): Promise<TaskTypeClassification> {
  // 快速路径：纯规则分类
  const ruleResult = classifyTaskType(prompt);

  // 高置信度 → 直接返回，不消耗 LLM
  if (ruleResult.confidence >= LLM_DISAMBIGUATION_THRESHOLD) {
    return ruleResult;
  }

  // 无 LLM → 退化为纯规则
  if (!llmCaller) {
    return ruleResult;
  }

  // 检查缓存
  const cacheKey = prompt.substring(0, 200);
  const cached = classificationCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 收集所有命中的候选类型（包括低分的）
  const candidates = collectCandidateTypes(prompt);
  if (candidates.length <= 1) {
    // 只有一个候选或没有候选，无需消歧
    return ruleResult;
  }

  try {
    const candidateList = candidates
      .map(c => `- ${c.type}（${c.matchedKeywords.slice(0, 3).join(", ")}）`)
      .join("\n");

    const llmPrompt = `请判断以下任务的核心类型。

【任务描述】${prompt.substring(0, 500)}

【候选类型】
${candidateList}

请根据任务的"核心动作"（而非涉及的领域）选择最准确的类型。
用 JSON 回答（仅此格式）：
\`\`\`json
{"type":"选中的类型","reason":"一句话理由"}
\`\`\``;

    console.log(
      `[TaskTypeClassifier] 🔄 低置信度 (${ruleResult.confidence}%)，LLM 消歧: ` +
      `候选=[${candidates.map(c => c.type).join(",")}]`,
    );

    const response = await llmCaller.call(llmPrompt);
    const parsed = extractJsonFromResponse(response) as { type?: string; reason?: string } | null;

    if (parsed?.type) {
      const validTypes: TaskType[] = [
        "writing", "coding", "analysis", "research", "data",
        "design", "automation", "planning", "review", "generic",
      ];
      const llmType = parsed.type as TaskType;
      if (validTypes.includes(llmType)) {
        // 用 LLM 结果覆盖规则结果，但保留规则的验证策略等信息
        const matchingCandidate = candidates.find(c => c.type === llmType);
        const enhanced: TaskTypeClassification = {
          ...ruleResult,
          type: llmType,
          confidence: Math.max(ruleResult.confidence + 20, 75),
          validationStrategies: matchingCandidate?.validationStrategies ?? ruleResult.validationStrategies,
          shouldAutoDecompose: matchingCandidate?.shouldAutoDecompose ?? ruleResult.shouldAutoDecompose,
        };

        console.log(
          `[TaskTypeClassifier] ✅ LLM 消歧完成: ${ruleResult.type} → ${llmType} ` +
          `(reason: ${parsed.reason ?? "N/A"})`,
        );

        // 缓存结果
        if (classificationCache.size >= CACHE_MAX_SIZE) {
          const firstKey = classificationCache.keys().next().value;
          if (firstKey !== undefined) classificationCache.delete(firstKey);
        }
        classificationCache.set(cacheKey, enhanced);

        return enhanced;
      }
    }

    console.warn(`[TaskTypeClassifier] ⚠️ LLM 消歧返回无效类型，保留规则结果: ${ruleResult.type}`);
  } catch (err) {
    console.warn(`[TaskTypeClassifier] ⚠️ LLM 消歧失败，保留规则结果:`, err);
  }

  return ruleResult;
}

/**
 * 🆕 异步版 classifyAndEnrich — 关键决策点使用
 *
 * 在分解、纲领生成等关键路径调用，低置信度时用 LLM 消歧。
 * 热路径（shouldAutoDecompose 等频繁调用）仍使用同步版本。
 */
export async function classifyAndEnrichWithLLM(
  subTask: SubTask,
  llmCaller?: LLMCaller | null,
): Promise<TaskTypeClassification> {
  const classification = await classifyTaskTypeWithLLM(subTask.prompt, llmCaller);

  if (!subTask.taskType) {
    subTask.taskType = classification.type;
  }
  if (!subTask.metadata) {
    subTask.metadata = {};
  }
  if (!subTask.metadata.validationStrategies) {
    subTask.metadata.validationStrategies = classification.validationStrategies;
  }

  return classification;
}

/**
 * 收集所有命中关键词的候选类型（不只是最高分的）
 *
 * 用于 LLM 消歧时提供候选列表。
 */
function collectCandidateTypes(prompt: string): TaskTypeClassification[] {
  const lowerPrompt = prompt.toLowerCase();
  const results: TaskTypeClassification[] = [];

  for (const rule of TASK_TYPE_RULES) {
    const matchedKeywords = rule.keywords.filter(kw => lowerPrompt.includes(kw.toLowerCase()));
    if (matchedKeywords.length === 0) continue;

    let structuralMatches = 0;
    if (rule.structuralPatterns) {
      structuralMatches = rule.structuralPatterns.filter(p => p.test(prompt)).length;
    }

    const keywordBonus = Math.min(matchedKeywords.length * 3, 15);
    const structuralBonus = structuralMatches * 10;
    const score = rule.weight + keywordBonus + structuralBonus;
    const confidence = Math.min(100, Math.round(score / 120 * 100));

    results.push({
      type: rule.type,
      confidence,
      weight: score,
      matchedKeywords,
      structuralMatches,
      validationStrategies: rule.validationStrategies,
      shouldAutoDecompose: rule.autoDecomposeHeuristic(prompt),
    });
  }

  // 按得分降序
  return results.sort((a, b) => b.weight - a.weight);
}
