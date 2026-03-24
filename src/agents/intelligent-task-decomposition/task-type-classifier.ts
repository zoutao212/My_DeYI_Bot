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
      "角色卡", "人物卡", "人设", "世界观", "设定集",
      // 🔧 P109: 增加中文创作常用动词/名词
      // 根因："生成剧情" "描写场景" 等常见写作 prompt 不含 "写/创作"，
      // 导致被 analysis("剧情"/"风格") 抢走分类，不触发 V4 分段写作
      "生成", "剧情", "渲染", "描写", "描述", "叙事", "情节",
      "write", "novel", "story", "chapter", "essay", "article", "blog",
      "translate", "script", "poem", "draft", "compose", "author",
      "character card", "character sheet", "generate",
    ],
    structuralPatterns: [
      /(?:写|创作|撰写|生成)\s*(?:\d+|[一二三四五六七八九十百千万]+)\s*(?:字|章|篇)/,
      // 🔧 P109: 支持 "字数：约 6000 字" 等带修饰词的格式
      /(?:word\s*count|字数)[：:]\s*(?:约|大约|至少|不少于|不低于|超过)?\s*\d+/i,
      /第\s*\d+\s*章/,
      /chapter\s*\d+/i,
      // 🔧 P109: 独立的 "约 N 字" / "N 字" 字数要求模式（无需前缀）
      /(?:约|大约|至少)?\s*\d{4,}\s*(?:字|词)/,
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
      "代码", "编程", "实现", "开发", "修复", "bug", "特性",
      // 🔧 P104: 移除单字 "类"（"分类" 中的 "类" 误匹配 coding）
      // 根因："材质分类审计" 中的 "类" 匹配 coding 关键词 "类"(class)，
      // 但 "分类" 是 classification 不是 class。保留英文 "class" 和结构模式。
      "函数", "接口", "API", "模块", "组件", "测试", "单元测试",
      "code", "program", "implement", "develop", "fix", "refactor",
      "function", "class", "interface", "module", "component", "test",
      "feature", "debug", "compile", "build", "deploy",
    ],
    structuralPatterns: [
      /(?:```|~~~)\s*(?:js|ts|py|java|go|rust|cpp|c\+\+|ruby|swift|kotlin)/i,
      /(?:import|require|from)\s+['"][^'"]+['"]/,
      /(?:function|class|interface|type|const|let|var)\s+\w+/,
      /\.(?:ts|js|py|java|go|rs|cpp|rb|swift|kt)(?:\s|$)/,
      // P80: 「重构/优化/注入」只有在代码上下文中才加分
      /(?:重构|优化|注入)\s*(?:代码|函数|类|接口|模块|组件|系统|服务|架构)/,
      /(?:refactor|optimize|inject)\s+(?:code|function|class|module|service)/i,
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
      // 🔧 P109: 移除 "剧情"（已移入 writing，创作剧情是写作而非分析）
      // "风格" 和 "角色" 保留："分析风格" "分析角色" 仍是分析任务
      "模仿", "风格", "角色", "人物", "审查", "审阅", "评估",
      "analyze", "extract", "summarize", "review", "evaluate",
      "study", "learn", "character", "style", "plot",
    ],
    structuralPatterns: [
      /(?:分析|学习|提取)\s*(?:以下|这个|这篇|该)/,
      /(?:analyze|extract|summarize)\s+(?:the|this|these)/i,
    ],
    validationStrategies: ["completeness", "structured_output", "file_output"],
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
      // P104: 记忆工具 CRUD 操作属于自动化类
      "memory_search", "memory_write", "memory_update", "memory_delete",
      "memory_list", "memory_deep_search", "memory_get",
      "记忆检索", "记忆写入", "记忆更新", "记忆删除",
    ],
    structuralPatterns: [
      /(?:自动|批量)\s*(?:化|执行|处理|部署)/,
      /(?:automate|batch)\s+(?:the|this|these)/i,
      // P104: 检测 memory 工具调用意图
      /(?:调用|使用|用)\s*(?:memory_\w+|记忆\s*(?:工具|检索|搜索|写入|更新|删除))/,
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

// 🆕 P93: 操作意图检测（防止内容名词误导分类）
// ========================================

/**
 * 文件操作/数据迁移意图的强信号模式（近距离匹配）
 *
 * 当 prompt 的核心动作是“整理文件/读取写入目录/迁移数据”时，
 * prompt 中提到的被操作对象名称（如“角色卡”、“人物”）不应导致 writing 分类。
 */
const FILE_OPERATION_INTENT_PATTERNS_CLOSE: RegExp[] = [
  /(?:整理|读取|写入|迁移|同步|归档|备份|复制|移动)\s*(?:到|至|进|入)?\s*(?:目录|文件夹|路径|memory|记忆)/i,
  /(?:整理|提取|处理|分析)\s*(?:workspace|产出|输出|文件)/i,
  /(?:创建|构建|更新)\s*(?:索引|目录|文件夹|记忆|memory)/i,
  /(?:写入|保存|存放|沉淀)\s*(?:到|至|进)?\s*(?:characters|memory|clawd)/i,
  /\bworkspace\/[\w-]+/i,
  /(?:读取|处理)\s*chunk_\d+/i,
];

/**
 * 🔧 P101: 文件操作意图的拆分检测（远距离匹配）
 *
 * 问题：原有模式要求操作动词和目标词相邻（\s*），但实际 prompt 中它们常被文件路径隔开
 * （如“整理 C:\Users\...\workspace\... 的产出”），导致正则无法匹配。
 *
 * 修复：拆分为“操作动词”和“目标概念”两层独立检测，两者同时出现在全文中即视为文件操作意图。
 */
// 🔧 P104: 移除 "构建" — "构建美学架构" 不是文件操作
// 近距离模式 FILE_OPERATION_INTENT_PATTERNS_CLOSE 已覆盖 "构建索引/目录/记忆"
const FILE_OP_VERBS = /(?:整理|读取|写入|迁移|同步|归档|备份|复制|移动|提取|处理|分析|创建|更新|保存|存放|沉淀)/;
const FILE_OP_TARGETS = /(?:目录|文件夹|路径|memory|记忆|记忆库|workspace|产出|输出|文件|索引|characters|clawd|chunk_\d+)/i;
/** 路径强信号：prompt 包含绝对路径或明确的目录引用 */
const FILE_PATH_SIGNAL = /(?:[A-Z]:\\|~\/|\/home\/|\\users\\|characters\\|memory\\|workspace[\\/])/i;

/**
 * writing 规则中经常作为"被操作对象"出现的关键词
 *
 * 这些词在文件操作上下文中不应作为 writing 信号。
 * 例如："整理角色卡到记忆库" 中的"角色卡"是被操作的对象，不是要创作角色卡。
 */
const WRITING_OBJECT_KEYWORDS = new Set([
  "角色卡", "人物卡", "人设", "世界观", "设定集",
  "character card", "character sheet",
  "角色", "人物", "剧情",
  "小说", "故事", "章节",
  // 🔧 P101: 扩展覆盖 — 这些词在文件操作 prompt 中频繁作为被操作对象出现
  "剧情增补", "续写", "感官资产", "资产",
  "人物卡", "角色文件", "记忆文档",
  "分析文档", "分析文件",
]);

/**
 * 检测 prompt 是否以文件操作/数据迁移为主要意图
 *
 * 🔧 P101 增强：三层检测（近距离→远距离→路径信号）
 * 原有逻辑只匹配近距离模式，当操作动词和目标词被文件路径隔开时失败。
 */
function hasFileOperationIntent(prompt: string): boolean {
  // 层 1：近距离模式（操作动词和目标词相邻，最强信号）
  if (FILE_OPERATION_INTENT_PATTERNS_CLOSE.some(p => p.test(prompt))) return true;
  // 层 2：远距离模式（操作动词和目标概念分別出现在全文中）
  if (FILE_OP_VERBS.test(prompt) && FILE_OP_TARGETS.test(prompt)) return true;
  // 层 3：路径强信号 + 操作动词（prompt 含绝对路径 + 操作动词）
  if (FILE_PATH_SIGNAL.test(prompt) && FILE_OP_VERBS.test(prompt)) return true;
  return false;
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
  const isFileOpContext = hasFileOperationIntent(prompt);

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

    // 🆕 P93: 操作意图检测 — 过滤"被操作对象"关键词
    // 当 prompt 主要意图是文件操作时，writing 的"对象关键词"不计入加分
    let effectiveKeywords = matchedKeywords;
    let intentPenalty = 0;
    if (rule.type === "writing" && isFileOpContext) {
      effectiveKeywords = matchedKeywords.filter(kw => !WRITING_OBJECT_KEYWORDS.has(kw));
      if (effectiveKeywords.length === 0) continue; // 所有命中词都是"被操作对象" → 跳过 writing
      // 即使有非对象关键词命中，也施加惩罚（文件操作上下文中 writing 不应是首选）
      // 🔧 P101: 加大惩罚力度（从 20 → 40）
      // 原因：当 prompt 包含大量 writing 内容名词（如“续写/剧情/角色/感官资产”）时，
      // writing 得分可能达 60+，20 分惩罚不足以压低。
      // 🔧 P104: 当 writing 有结构信号匹配（字数要求/章节号等强信号）时，减半惩罚。
      // 根因："构建报告，约 2000 字" 同时命中文件操作意图（路径+动词）和写作结构信号，
      // 40 分惩罚把 writing 从 98 压到 58，被 coding 88 反超（"分类" 中 "类" 误匹配）。
      intentPenalty = structuralMatches > 0 ? 20 : 40;
    }

    // 综合得分 = 基础权重 + 关键词命中数加成 + 结构信号加成 - 意图惩罚
    const keywordBonus = Math.min(effectiveKeywords.length * 3, 15); // 每个关键词 +3，上限 15
    const structuralBonus = structuralMatches * 10; // 每个结构信号 +10
    const score = rule.weight + keywordBonus + structuralBonus - intentPenalty;

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

// ========================================
// 🆕 任务子类型检测（用于智能分段决策）
// ========================================

/**
 * 写作任务子类型
 * 
 * 用于更精细地判断任务的内在结构，从而决定是否分段以及如何分段。
 */
export type WritingSubtype = 
  | "character_card"     // 人物卡/角色卡 — 按人物维度分段或不分段
  | "plot_writing"       // 剧情写作 — 按场景/章节分段
  | "creative_writing"   // 创意写作（小说、故事）— 按自然段落分段
  | "technical_doc"      // 技术文档 — 按章节分段
  | "translation"        // 翻译 — 按段落分段（可并行）
  | "article"            // 文章/博客 — 按自然段落分段
  | "generic_writing";   // 通用写作

/**
 * 任务子类型检测结果
 */
export interface SubtypeDetection {
  /** 检测到的子类型 */
  subtype: WritingSubtype;
  /** 检测置信度 0-100 */
  confidence: number;
  /** 匹配的关键信号 */
  matchedSignals: string[];
  /** 推荐的分段策略 */
  recommendedStrategy: {
    shouldSegment: boolean;
    segmentThreshold: number;     // 触发分段的字数阈值
    segmentApproach: "chronological" | "character_focused" | "scene_based" | "chapter_based" | "none";
    allowParallel: boolean;       // 是否允许并行分段
    // 🔧 P113: 追加写入策略
    appendMode: boolean;          // 是否使用追加写入模式（节省 token）
    appendChunkSize: number;      // 每次追加的字数大小
  };
}

/**
 * 写作子类型检测规则
 */
const WRITING_SUBTYPE_RULES: Array<{
  subtype: WritingSubtype;
  keywords: string[];
  patterns: RegExp[];
  threshold: number;
  approach: "chronological" | "character_focused" | "scene_based" | "chapter_based" | "none";
  allowParallel: boolean;
  // 🔧 P113: 追加写入策略
  appendMode: boolean;      // 是否使用追加模式
  appendChunkSize: number;  // 每次追加的字数
}> = [
  {
    subtype: "character_card",
    keywords: [
      "人物卡", "角色卡", "人设卡", "character card", "character sheet",
      "人物设定", "角色设定", "人物介绍", "角色介绍",
      "人物档案", "角色档案", "人物资料", "角色资料",
    ],
    patterns: [
      /(?:人物|角色|人设)\s*(?:卡|设定|介绍|档案|资料)/i,
      /(?:为|给|创作|写)\s*[^，。！？]+(?:和|与|、)[^，。！？]+\s*(?:写|创作|制作)?\s*(?:人物|角色)\s*卡/i,
      /(?:双人物卡|多人物卡|母女.*人物卡|父子.*人物卡)/i,
      /character\s*card/i,
    ],
    threshold: 8000,  // 人物卡 8000 字以下不分段
    approach: "character_focused",  // 按人物维度分段
    allowParallel: true,  // 不同人物可以并行写作
    // 🔧 P113: 人物卡使用追加写入模式
    appendMode: true,
    appendChunkSize: 2000,  // 每次追加约 2000 字
  },
  {
    subtype: "plot_writing",
    keywords: [
      "剧情", "情节", "故事情节", "叙事", "剧情发展",
      "场景描写", "情节推进", "剧情续写", "故事续写",
      "plot", "scenario", "scene",
    ],
    patterns: [
      /(?:剧情|情节|故事)\s*(?:写作|创作|续写|描写)/i,
      /(?:写|创作|续写)\s*[^，。！？]*剧情/i,
      /(?:第\s*\d+\s*[章节篇])|(?:chapter\s*\d+)/i,
    ],
    threshold: 5000,  // 剧情写作 5000 字以下不分段
    approach: "scene_based",
    allowParallel: false,  // 剧情需要保持连贯性
    // 🔧 P113: 剧情写作使用追加写入模式
    appendMode: true,
    appendChunkSize: 1500,  // 每次追加约 1500 字（场景为单位）
  },
  {
    subtype: "translation",
    keywords: [
      "翻译", "译文", "translate", "translation",
      "译成", "翻译成", "中译", "英译",
    ],
    patterns: [
      /(?:翻译|translate)\s*(?:成|为|into)?\s*(?:中文|英文|日文|中|英|日)/i,
      /(?:把|将|把[^，。！？]+)\s*翻译/i,
    ],
    threshold: 3000,
    approach: "chronological",
    allowParallel: true,  // 翻译可以并行
    // 翻译不适合追加模式（段落独立性）
    appendMode: false,
    appendChunkSize: 0,
  },
  {
    subtype: "technical_doc",
    keywords: [
      "文档", "技术文档", "设计文档", "需求文档", "API文档",
      "说明书", "手册", "指南", "规范", "标准",
      "document", "documentation", "spec", "specification", "manual",
    ],
    patterns: [
      /(?:技术|设计|需求|API|开发)?\s*文档/i,
      /(?:编写|撰写|制作)\s*(?:技术|设计|需求)?\s*文档/i,
    ],
    threshold: 3000,
    approach: "chapter_based",
    allowParallel: true,
    // 🔧 P113: 技术文档使用追加写入模式
    appendMode: true,
    appendChunkSize: 1500,  // 每个章节/小节约 1500 字
  },
  {
    subtype: "article",
    keywords: [
      "文章", "博客", "blog", "论文", "essay",
      "报告", "report", "新闻稿", "press release",
    ],
    patterns: [
      /(?:写|创作|撰写)\s*(?:一篇|一个)?\s*(?:文章|博客|论文|报告)/i,
      /(?:文章|博客|论文|报告)\s*(?:写作|创作)/i,
    ],
    threshold: 4000,
    approach: "chronological",
    allowParallel: false,
    // 文章较短，不启用追加模式
    appendMode: false,
    appendChunkSize: 0,
  },
  {
    subtype: "creative_writing",
    keywords: [
      "小说", "故事", "散文", "诗歌", "剧本", "童话",
      "novel", "story", "fiction", "prose", "poem", "script",
      "创作", "续写", "改写", "仿写",
    ],
    patterns: [
      /(?:写|创作|续写)\s*(?:一个|一篇|一部)?\s*(?:小说|故事|散文|剧本)/i,
      /(?:小说|故事|散文|剧本)\s*(?:写作|创作)/i,
    ],
    threshold: 5000,
    approach: "chapter_based",
    allowParallel: false,
    // 🔧 P113: 创意写作使用追加写入模式
    appendMode: true,
    appendChunkSize: 2000,  // 每次追加约 2000 字
  },
];

/**
 * 检测写作任务的子类型
 * 
 * 根据任务内容智能判断任务的内在结构，从而决定：
 * 1. 是否应该分段
 * 2. 分段阈值应该是多少
 * 3. 采用什么分段策略
 * 
 * @param prompt 任务 prompt
 * @returns 子类型检测结果
 */
export function detectWritingSubtype(prompt: string): SubtypeDetection {
  const lowerPrompt = prompt.toLowerCase();
  
  // 遍历所有子类型规则，找到最佳匹配
  let bestMatch: SubtypeDetection | null = null;
  let bestScore = 0;
  
  for (const rule of WRITING_SUBTYPE_RULES) {
    // 关键词匹配
    const matchedKeywords = rule.keywords.filter(kw => 
      lowerPrompt.includes(kw.toLowerCase())
    );
    
    // 结构模式匹配
    const matchedPatterns = rule.patterns.filter(p => p.test(prompt));
    
    // 计算得分
    const keywordScore = matchedKeywords.length * 15;
    const patternScore = matchedPatterns.length * 25;
    const totalScore = keywordScore + patternScore;
    
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestMatch = {
        subtype: rule.subtype,
        confidence: Math.min(100, totalScore + 30),  // 基础置信度 30
        matchedSignals: [
          ...matchedKeywords,
          ...matchedPatterns.map(p => `[pattern:${p.source.substring(0, 20)}]`),
        ],
        recommendedStrategy: {
          shouldSegment: true,  // 后续会根据字数阈值判断
          segmentThreshold: rule.threshold,
          segmentApproach: rule.approach,
          allowParallel: rule.allowParallel,
          // 🔧 P113: 追加写入策略
          appendMode: rule.appendMode,
          appendChunkSize: rule.appendChunkSize,
        },
      };
    }
  }
  
  // 如果没有匹配到特定子类型，返回通用写作
  if (!bestMatch) {
    return {
      subtype: "generic_writing",
      confidence: 50,
      matchedSignals: [],
      recommendedStrategy: {
        shouldSegment: true,
        segmentThreshold: 3000,  // 默认阈值 3000
        segmentApproach: "chronological",
        allowParallel: false,
        // 🔧 P113: 默认不使用追加模式
        appendMode: false,
        appendChunkSize: 0,
      },
    };
  }
  
  return bestMatch;
}

/**
 * 获取任务的实际分段阈值
 * 
 * 综合考虑任务子类型和字数要求，返回最适合的分段触发阈值。
 * 
 * @param prompt 任务 prompt
 * @param wordCount 字数要求（可选）
 * @returns 分段阈值
 */
export function getSegmentThreshold(prompt: string, wordCount?: number): number {
  const subtypeDetection = detectWritingSubtype(prompt);
  return subtypeDetection.recommendedStrategy.segmentThreshold;
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
