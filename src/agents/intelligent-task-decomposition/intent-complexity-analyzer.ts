/**
 * P102+UTIL: 统一任务智能层 — 意图复杂度分析器 (Intent Complexity Analyzer)
 *
 * 解决的核心问题：
 * 用户发送"短 prompt + 高隐含复杂度"的请求时（如"参考 NovelsAssets 构建美学服饰品味"），
 * LLM 往往低估任务规模，直接尝试单轮处理而不调用 enqueue_task。
 *
 * UTIL 升级（5 个检查点 + 1 个共享上下文）：
 * - CP0: 用户消息入口预判（本模块核心，LLM/规则/模板三路）
 * - CP1: enqueue_task 入队校验（validateEntryAgainstCP0）
 * - CP2: shouldAutoDecompose 消费 CP0 信号（getActiveContext）
 * - CP3: postProcess 动态质检严格度（deriveStrictnessFromComplexity）
 * - CP4: onRoundCompleted 回顾学习（buildRetrospective）
 * - TaskIntelligenceContext: 共享上下文，贯穿全生命周期
 *
 * 设计原则：
 * - CP0: 模板加速（零 LLM） → 规则过滤 → 长消息摘要 → 轻量 LLM
 * - CP1-CP4: 全部零 LLM，纯内存操作
 * - 失败静默降级（不阻塞主流程）
 *
 * @module agents/intelligent-task-decomposition/intent-complexity-analyzer
 */

import { createSystemLLMCaller } from "./system-llm-caller.js";
import type { ClawdbotConfig } from "../../config/config.js";

// ────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────

/** 预判 LLM 最大输出 token（JSON 结果不需要长输出） */
const ANALYZER_MAX_TOKENS = 512;

/** 预判超时（毫秒）— 必须快，不能拖慢主流程 */
const ANALYZER_TIMEOUT_MS = 20_000;

/** 预判温度（极低温 = 稳定判断） */
const ANALYZER_TEMPERATURE = 0.1;

/** 跳过预判的最短消息长度（太短的消息几乎不可能是复杂任务） */
const MIN_ANALYSIS_LENGTH = 8;

/** 长消息不再跳过 LLM 预判，而是截取首尾摘要后仍然做预判 */
const LONG_MESSAGE_SUMMARY_THRESHOLD = 5000;

/** Context 自动过期时间（毫秒）— 防止内存泄漏 */
const CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 分钟

/** Context 最大存储数（防止内存膨胀） */
const CONTEXT_MAX_SIZE = 50;

// ────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────

/** 复杂度等级 */
export type ComplexityLevel = "simple" | "moderate" | "complex" | "very_complex";

/** 推荐执行策略 */
export type RecommendedStrategy = "direct" | "suggest_decompose" | "force_decompose";

/** 预判结果 */
export interface IntentComplexityResult {
  /** 复杂度等级 */
  complexity: ComplexityLevel;
  /** 推荐策略 */
  strategy: RecommendedStrategy;
  /** LLM 给出的简短理由（用于日志） */
  reason: string;
  /** 建议的子任务数量（仅 suggest/force 时有值） */
  suggestedSubTaskCount?: number;
  /** 建议的任务分解方向（简要描述） */
  decompositionHint?: string;
  /** 预判来源 */
  source: "llm" | "rule_skip" | "template_match";
}

/** CP1: 入队校验结果 */
export interface EntryValidationResult {
  /** 校验通过 */
  ok: boolean;
  /** 期望后续有更多子任务 */
  expectMoreTasks?: boolean;
  /** CP0 建议的子任务数量 */
  suggestedCount?: number;
  /** 当子任务数远少于建议时的警告文本 */
  warning?: string;
  /** 建议进一步分解 */
  suggestFurtherDecomposition?: boolean;
}

/** CP3: 质检严格度等级 */
export type StrictnessLevel = "relaxed" | "normal" | "strict";

/** CP4: 回顾学习结果 */
export interface RetrospectiveResult {
  /** 实际复杂度（基于执行结果推算） */
  actualComplexity: ComplexityLevel;
  /** CP0 预判准确度 */
  predictionAccuracy: "accurate" | "underestimated" | "overestimated";
  /** 经验条目（写入经验池） */
  lessonsLearned: string[];
}

/**
 * UTIL: 统一的任务智能上下文 — 贯穿整个任务生命周期
 * 在 CP0 创建，逐步丰富，所有检查点共享
 */
export interface TaskIntelligenceContext {
  /** CP0 的原始预判结果 */
  intentAnalysis: IntentComplexityResult;
  /** 用户原始消息（用于后续检查点回溯） */
  userMessage: string;
  /** 创建时间戳 */
  createdAt: number;
  /** CP1 入队时的校验结果 */
  entryValidation?: {
    /** LLM 创建的子任务数 vs CP0 建议数 */
    taskCountAlignment: "aligned" | "under" | "over";
    /** 是否注入了额外引导 */
    guidanceInjected: boolean;
  };
  /** CP2 分解决策记录 */
  decompositionDecisions?: Array<{
    subTaskId: string;
    decision: "decompose" | "execute_directly";
    reason: string;
    source: "cp0_force" | "cp0_suggest" | "rule" | "template";
  }>;
  /** CP3 质检调整记录 */
  qualityAdjustments?: Array<{
    subTaskId: string;
    strictnessLevel: StrictnessLevel;
    reason: string;
  }>;
  /** CP4 回顾学习产出 */
  retrospective?: RetrospectiveResult;
}

// ────────────────────────────────────────────────────────────
// UTIL: TaskIntelligenceContext 全局存储
// ────────────────────────────────────────────────────────────

/** 按 sessionKey 索引的活跃上下文（生命周期 = 一次用户消息处理周期） */
const _activeContexts = new Map<string, TaskIntelligenceContext>();

/** 获取活跃的任务智能上下文 */
export function getActiveContext(sessionKey: string): TaskIntelligenceContext | undefined {
  const ctx = _activeContexts.get(sessionKey);
  if (!ctx) return undefined;
  // TTL 过期检查
  if (Date.now() - ctx.createdAt > CONTEXT_TTL_MS) {
    _activeContexts.delete(sessionKey);
    return undefined;
  }
  return ctx;
}

/** 设置活跃的任务智能上下文 */
export function setActiveContext(sessionKey: string, ctx: TaskIntelligenceContext): void {
  // 容量保护：超过上限时清理最旧的
  if (_activeContexts.size >= CONTEXT_MAX_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of _activeContexts) {
      if (v.createdAt < oldestTime) {
        oldestTime = v.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) _activeContexts.delete(oldestKey);
  }
  _activeContexts.set(sessionKey, ctx);
}

/** 清理活跃上下文（轮次结束后调用） */
export function clearActiveContext(sessionKey: string): void {
  _activeContexts.delete(sessionKey);
}

// ────────────────────────────────────────────────────────────
// 规则前置过滤（零 LLM 消耗快速跳过）
// ────────────────────────────────────────────────────────────

/**
 * 明确的简单交互模式 — 命中则直接跳过 LLM 预判
 *
 * 包含：问候、闲聊、简单指令、状态查询、系统命令
 */
const SIMPLE_INTERACTION_PATTERNS: RegExp[] = [
  // 问候/闲聊
  /^(?:你好|hi|hello|hey|嗨|早|晚安|早安|午安|在吗|在不在)/i,
  // 状态查询
  /^(?:自检|状态|status|ping|test)/i,
  // 系统命令
  /^(?:\/new|\/reset|\/think|\/model|\/verbose)/i,
  // 极短确认/感叹
  /^(?:好|ok|嗯|行|是|对|不|没|哦|啊|呢|吧|了|谢谢|thanks|thx)$/i,
  // 单词提问
  /^(?:什么|为什么|怎么|how|what|why|where|when)\s*[？?]?\s*$/i,
];

/**
 * UTIL CP0 模板加速：高复杂度任务模式
 * 命中则直接返回 force_decompose / suggest_decompose，零 LLM 消耗
 */
const HIGH_COMPLEXITY_PATTERNS: Array<{ pattern: RegExp; complexity: ComplexityLevel; strategy: RecommendedStrategy; reason: string }> = [
  // 大规模创作（字数 >= 5000）
  { pattern: /(?:创作|写|撰写|编写)[^。\n]{0,30}(?:\d{4,})\s*字/i, complexity: "very_complex", strategy: "force_decompose", reason: "大规模写作任务（>5000字）" },
  // 多章节创作
  { pattern: /(?:第[一二三四五六七八九十\d]+章|\d+\s*章)/i, complexity: "complex", strategy: "force_decompose", reason: "多章节创作任务" },
  // 参考大量数据构建产物
  { pattern: /(?:参考|基于|根据)[^。\n]{0,20}(?:资产|Assets|文件|数据|目录)[^。\n]{0,30}(?:构建|生成|整理|分析|创建|编写)/i, complexity: "complex", strategy: "force_decompose", reason: "需要扫描大量数据并构建结构化产物" },
  // 多维度分析/报告
  { pattern: /(?:全面|系统|综合|深度)[^。\n]{0,10}(?:分析|调研|报告|评估|审计)/i, complexity: "complex", strategy: "suggest_decompose", reason: "多维度分析/报告任务" },
  // 多步骤自动化
  { pattern: /(?:整理|迁移|同步|归档)[^。\n]{0,20}(?:到|至)[^。\n]{0,20}(?:记忆|memory|目录|文件夹)/i, complexity: "complex", strategy: "suggest_decompose", reason: "多步骤文件操作任务" },
  // 多文件处理
  { pattern: /(?:所有|全部|每个|批量)[^。\n]{0,15}(?:文件|章节|任务|子任务)/i, complexity: "complex", strategy: "suggest_decompose", reason: "批量文件/任务处理" },
];

/**
 * 规则前置过滤：判断是否应该跳过 LLM 预判
 *
 * @returns true = 跳过预判（简单消息），false = 需要 LLM 预判
 */
function shouldSkipAnalysis(userMessage: string): boolean {
  const trimmed = userMessage.trim();

  // 太短
  if (trimmed.length < MIN_ANALYSIS_LENGTH) return true;

  // 命中简单交互模式
  if (SIMPLE_INTERACTION_PATTERNS.some(p => p.test(trimmed))) return true;

  return false;
}

/**
 * UTIL CP0 P2: 模板加速 — 高复杂度模式零 LLM 快速匹配
 *
 * @returns 命中的结果，或 null 需要 LLM 预判
 */
function tryTemplateMatch(userMessage: string): IntentComplexityResult | null {
  for (const { pattern, complexity, strategy, reason } of HIGH_COMPLEXITY_PATTERNS) {
    if (pattern.test(userMessage)) {
      console.log(`[IntentComplexityAnalyzer] ⚡ 模板加速命中: ${reason}`);
      return {
        complexity,
        strategy,
        reason: `模板匹配: ${reason}`,
        source: "template_match",
      };
    }
  }
  return null;
}

/**
 * UTIL CP0 P5: 长消息摘要 — 截取首尾用于 LLM 预判
 * 不再跳过长消息，而是摘要后仍然做 LLM 预判
 */
function summarizeLongMessage(userMessage: string): string {
  if (userMessage.length <= LONG_MESSAGE_SUMMARY_THRESHOLD) return userMessage;
  const head = userMessage.substring(0, 400);
  const tail = userMessage.substring(userMessage.length - 200);
  return `${head}\n\n[...中间省略 ${userMessage.length - 600} 字符...]\n\n${tail}`;
}

// ────────────────────────────────────────────────────────────
// LLM 预判提示词
// ────────────────────────────────────────────────────────────

/**
 * 构建预判 prompt
 *
 * 极短 prompt（~800 字符），让 LLM 快速输出 JSON 判断
 */
function buildAnalysisPrompt(userMessage: string): string {
  return `你是一个任务复杂度分析器。分析用户消息，判断这个请求的实际复杂度。

**关键**：不要只看消息长度！短消息可能隐含极高复杂度。重点分析：
1. 完成这个任务实际需要多少步骤？
2. 是否需要处理大量数据/文件？（如"参考XX中的资产"意味着需要全面扫描）
3. 是否需要综合分析、分类、构建结构化产物？
4. 单次 LLM 调用能否完成？（如果需要多次搜索/读取/写入，就不是简单任务）

用户消息：
"""
${userMessage}
"""

以 JSON 格式回复（不要包含 markdown 代码块标记）：
{
  "complexity": "simple|moderate|complex|very_complex",
  "strategy": "direct|suggest_decompose|force_decompose",
  "reason": "一句话理由",
  "suggestedSubTaskCount": 数字或null,
  "decompositionHint": "建议的分解方向或null"
}

判断标准：
- simple: 闲聊/问答/简单查询，一次回复即可
- moderate: 需要几步操作但不复杂（如读文件+总结），direct 即可
- complex: 需要多步操作、处理多个文件/大量数据、构建结构化产物，建议用任务分解系统
- very_complex: 大规模创作/分析/构建，必须用任务分解系统

strategy:
- direct: 直接回复即可
- suggest_decompose: 建议使用 enqueue_task 分解，但不强制
- force_decompose: 强烈建议使用 enqueue_task，单轮处理几乎不可能完成`;
}

// ────────────────────────────────────────────────────────────
// JSON 解析
// ────────────────────────────────────────────────────────────

/**
 * 从 LLM 响应中解析 JSON 结果
 *
 * 容错处理：支持带/不带 markdown 代码块的 JSON
 */
function parseAnalysisResponse(text: string): IntentComplexityResult | null {
  try {
    // 尝试提取 JSON 块
    let jsonStr = text.trim();

    // 去除 markdown 代码块
    const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1].trim();
    }

    // 尝试提取裸 JSON 对象
    const jsonObjMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonObjMatch) {
      jsonStr = jsonObjMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    // 验证必填字段
    const validComplexity: ComplexityLevel[] = ["simple", "moderate", "complex", "very_complex"];
    const validStrategy: RecommendedStrategy[] = ["direct", "suggest_decompose", "force_decompose"];

    const complexity = validComplexity.includes(parsed.complexity) ? parsed.complexity : "moderate";
    const strategy = validStrategy.includes(parsed.strategy) ? parsed.strategy : "direct";

    return {
      complexity,
      strategy,
      reason: String(parsed.reason ?? "未提供理由"),
      suggestedSubTaskCount: typeof parsed.suggestedSubTaskCount === "number" ? parsed.suggestedSubTaskCount : undefined,
      decompositionHint: typeof parsed.decompositionHint === "string" ? parsed.decompositionHint : undefined,
      source: "llm",
    };
  } catch {
    console.warn("[IntentComplexityAnalyzer] ⚠️ JSON 解析失败，降级为 moderate/direct");
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// 注入提示构建
// ────────────────────────────────────────────────────────────

/**
 * 根据预判结果生成注入 extraSystemPrompt 的引导文本
 *
 * @returns 引导文本（空字符串表示不需要注入）
 */
export function buildComplexityGuidance(result: IntentComplexityResult): string {
  if (result.strategy === "direct") return "";

  const lines: string[] = [];

  if (result.strategy === "force_decompose") {
    lines.push("[🧠 任务复杂度预判：高复杂度任务]");
    lines.push(`系统预判：这是一个**${result.complexity === "very_complex" ? "超高" : "高"}复杂度**任务。`);
    lines.push(`理由：${result.reason}`);
    lines.push("");
    lines.push("⚠️ **强烈建议**：你**必须**使用 `enqueue_task` 工具将此任务分解为多个子任务。");
    lines.push("单轮处理几乎不可能完成这个请求的所有要求。不要试图一次性回答，而是：");
    lines.push("1. 分析任务的各个维度和步骤");
    lines.push("2. 使用 `enqueue_task(isNewRootTask=true)` 创建任务树");
    lines.push("3. 将每个步骤作为独立子任务入队");
    lines.push("4. 系统会自动执行、质检、合并产出");
  } else {
    // suggest_decompose
    lines.push("[🧠 任务复杂度预判：中高复杂度任务]");
    lines.push(`系统预判：这个任务具有一定复杂度（${result.complexity}）。`);
    lines.push(`理由：${result.reason}`);
    lines.push("");
    lines.push("💡 **建议**：考虑使用 `enqueue_task` 工具将此任务分解。");
    lines.push("如果你评估可以单轮完成，可以直接回复；但如果涉及多步操作、大量数据或结构化产物，");
    lines.push("请优先使用任务分解系统以确保质量。");
  }

  if (result.suggestedSubTaskCount) {
    lines.push(`\n📊 建议分解为约 ${result.suggestedSubTaskCount} 个子任务。`);
  }
  if (result.decompositionHint) {
    lines.push(`📋 分解方向参考：${result.decompositionHint}`);
  }

  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// CP0 主入口
// ────────────────────────────────────────────────────────────

/** LLMCaller 单例缓存（避免每次请求重建） */
let _cachedCaller: { call: (prompt: string) => Promise<string> } | null = null;
let _cachedCallerConfigKey: string | null = null;

/**
 * CP0: 分析用户消息的意图和复杂度
 *
 * 三路预判：模板加速（零LLM） → 规则过滤 → 长消息摘要+轻量LLM
 * 失败时静默降级，不阻塞主流程。
 *
 * @param userMessage 用户消息文本
 * @param config Clawdbot 配置（用于创建 LLM caller）
 * @param provider 可选，指定 LLM provider
 * @param modelId 可选，指定模型 ID
 * @returns 预判结果
 */
export async function analyzeIntentComplexity(
  userMessage: string,
  config?: ClawdbotConfig,
  provider?: string,
  modelId?: string,
): Promise<IntentComplexityResult> {
  // 🔧 P128: 暂时禁用 LLM 预判（Grok 推理模型兼容性问题）
  // 直接返回默认结果，跳过所有 LLM 调用
  const CP0_LLM_PREDICTION_DISABLED = true;
  
  if (CP0_LLM_PREDICTION_DISABLED) {
    // 规则前置过滤仍然生效
    if (shouldSkipAnalysis(userMessage)) {
      return {
        complexity: "simple",
        strategy: "direct",
        reason: "规则跳过：消息过短或匹配简单交互模式",
        source: "rule_skip",
      };
    }
    
    // 模板加速仍然生效
    const templateResult = tryTemplateMatch(userMessage);
    if (templateResult) {
      return templateResult;
    }
    
    // LLM 预判已禁用，返回默认值
    console.log(`[IntentComplexityAnalyzer] 🔒 P128: LLM 预判已禁用，返回默认值`);
    return {
      complexity: "moderate",
      strategy: "direct",
      reason: "P128: LLM 预判暂时禁用（Grok 推理模型兼容性问题）",
      source: "rule_skip",
    };
  }
  
  // 规则前置过滤（极短/简单交互）
  if (shouldSkipAnalysis(userMessage)) {
    return {
      complexity: "simple",
      strategy: "direct",
      reason: "规则跳过：消息过短或匹配简单交互模式",
      source: "rule_skip",
    };
  }

  // UTIL P2: 模板加速 — 高复杂度模式零 LLM 快速命中
  const templateResult = tryTemplateMatch(userMessage);
  if (templateResult) {
    return templateResult;
  }

  try {
    // 复用或创建 LLM caller
    const configKey = `${provider ?? "auto"}:${modelId ?? "auto"}`;
    if (!_cachedCaller || _cachedCallerConfigKey !== configKey) {
      _cachedCaller = createSystemLLMCaller({
        config,
        provider,
        modelId,
        maxTokens: ANALYZER_MAX_TOKENS,
        temperature: ANALYZER_TEMPERATURE,
        timeoutMs: ANALYZER_TIMEOUT_MS,
      });
      _cachedCallerConfigKey = configKey;
    }

    // UTIL P5: 长消息不跳过，截取首尾摘要后仍然做 LLM 预判
    const effectiveMessage = summarizeLongMessage(userMessage);
    const prompt = buildAnalysisPrompt(effectiveMessage);
    console.log(`[IntentComplexityAnalyzer] 🔍 CP0 开始预判 (原始长度=${userMessage.length}, 有效长度=${effectiveMessage.length})`);

    const startTime = Date.now();
    const response = await _cachedCaller.call(prompt);
    const elapsed = Date.now() - startTime;

    console.log(`[IntentComplexityAnalyzer] ⏱️ LLM 预判完成 (${elapsed}ms, 响应长度=${response.length})`);

    const result = parseAnalysisResponse(response);
    if (result) {
      console.log(
        `[IntentComplexityAnalyzer] 📊 CP0 结果: complexity=${result.complexity}, ` +
        `strategy=${result.strategy}, reason="${result.reason}"`,
      );
      return result;
    }

    // JSON 解析失败，降级
    return {
      complexity: "moderate",
      strategy: "direct",
      reason: "LLM 响应解析失败，降级为 direct",
      source: "llm",
    };
  } catch (err) {
    // 任何错误都静默降级，不阻塞主流程
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[IntentComplexityAnalyzer] ⚠️ CP0 预判失败，静默降级: ${msg}`);
    return {
      complexity: "moderate",
      strategy: "direct",
      reason: `预判失败: ${msg}`,
      source: "llm",
    };
  }
}

// ────────────────────────────────────────────────────────────
// CP1: 入队校验（enqueue-task-tool 调用）
// ────────────────────────────────────────────────────────────

/**
 * CP1: 校验 LLM 的分解方案是否与 CP0 预判一致
 *
 * 纯规则驱动，零 LLM 调用。
 * 在 enqueue_task execute() 中 addSubTask 后调用。
 *
 * @param sessionKey 会话标识（用于查找 CP0 结果）
 * @param isNewRootTask 是否是新根任务
 * @param existingSubTaskCount 同一 rootTaskId 下已有多少子任务
 * @returns 校验结果
 */
export function validateEntryAgainstCP0(
  sessionKey: string,
  isNewRootTask: boolean,
  existingSubTaskCount: number,
): EntryValidationResult {
  const ctx = getActiveContext(sessionKey);
  if (!ctx || ctx.intentAnalysis.strategy === "direct") {
    return { ok: true };
  }

  const suggested = ctx.intentAnalysis.suggestedSubTaskCount ?? 3;

  // 第一个根任务入队 — 正常，标记后续需要检查是否有足够子任务
  if (isNewRootTask && existingSubTaskCount === 0) {
    return { ok: true, expectMoreTasks: true, suggestedCount: suggested };
  }

  // 所有子任务创建完毕后，数量远少于建议
  if (existingSubTaskCount > 0 && existingSubTaskCount < Math.ceil(suggested * 0.5)) {
    // 写入 CP1 结果到 Context
    if (!ctx.entryValidation) {
      ctx.entryValidation = {
        taskCountAlignment: "under",
        guidanceInjected: true,
      };
    }
    return {
      ok: true, // 不阻塞，但标记
      warning: `CP0 建议分解为 ~${suggested} 个子任务，当前仅 ${existingSubTaskCount} 个。系统将在子任务执行前尝试进一步分解。`,
      suggestFurtherDecomposition: true,
    };
  }

  // 数量合理
  if (ctx.entryValidation?.taskCountAlignment !== "under") {
    if (!ctx.entryValidation) {
      ctx.entryValidation = {
        taskCountAlignment: "aligned",
        guidanceInjected: false,
      };
    }
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────
// CP2: shouldAutoDecompose 辅助（orchestrator 调用）
// ────────────────────────────────────────────────────────────

/**
 * CP2 决策来源类型
 */
export type CP2DecisionSource = "cp0_force" | "cp0_suggest" | "rule" | "template";

/**
 * CP2: 获取 CP0 对 shouldAutoDecompose 的覆盖信号
 *
 * @param sessionKey 会话标识
 * @param subTaskDepth 子任务深度
 * @returns { force, lowerThreshold, source } 或 null（无覆盖）
 */
export function getCP0DecomposeSignal(
  sessionKey: string,
  subTaskDepth: number,
): { force: boolean; lowerThreshold: boolean; source: CP2DecisionSource } | null {
  const ctx = getActiveContext(sessionKey);
  if (!ctx) return null;

  // 仅对 depth=0（根级子任务）施加 CP0 影响
  if (subTaskDepth > 0) return null;

  if (ctx.intentAnalysis.strategy === "force_decompose") {
    return { force: true, lowerThreshold: true, source: "cp0_force" };
  }
  if (ctx.intentAnalysis.strategy === "suggest_decompose") {
    return { force: false, lowerThreshold: true, source: "cp0_suggest" };
  }
  return null;
}

/**
 * CP2: 记录分解决策到 Context
 */
export function recordDecompositionDecision(
  sessionKey: string,
  subTaskId: string,
  decision: "decompose" | "execute_directly",
  reason: string,
  source: CP2DecisionSource,
): void {
  const ctx = getActiveContext(sessionKey);
  if (!ctx) return;
  if (!ctx.decompositionDecisions) ctx.decompositionDecisions = [];
  ctx.decompositionDecisions.push({ subTaskId, decision, reason, source });
}

// ────────────────────────────────────────────────────────────
// CP3: 动态质检严格度（orchestrator.postProcess 调用）
// ────────────────────────────────────────────────────────────

/**
 * CP3: 根据 CP0 复杂度等级推导质检严格度
 *
 * @param sessionKey 会话标识
 * @param subTaskId 子任务 ID（用于记录）
 * @returns 严格度等级
 */
export function deriveStrictnessFromComplexity(
  sessionKey: string,
  subTaskId: string,
): StrictnessLevel {
  const ctx = getActiveContext(sessionKey);
  if (!ctx) return "normal";

  let level: StrictnessLevel;
  let reason: string;

  switch (ctx.intentAnalysis.complexity) {
    case "very_complex":
      level = "strict";
      reason = "CP0 预判超高复杂度，提高质检严格度";
      break;
    case "complex":
      level = "strict";
      reason = "CP0 预判高复杂度，提高质检严格度";
      break;
    case "simple":
      level = "relaxed";
      reason = "CP0 预判简单任务，降低质检严格度避免无意义 restart";
      break;
    default:
      level = "normal";
      reason = "CP0 预判中等复杂度，标准质检";
  }

  // 记录到 Context
  if (!ctx.qualityAdjustments) ctx.qualityAdjustments = [];
  ctx.qualityAdjustments.push({ subTaskId, strictnessLevel: level, reason });

  return level;
}

// ────────────────────────────────────────────────────────────
// CP4: 回顾学习（onRoundCompleted 调用）
// ────────────────────────────────────────────────────────────

/** 复杂度等级到数值映射（用于比较） */
const COMPLEXITY_ORD: Record<ComplexityLevel, number> = {
  simple: 0,
  moderate: 1,
  complex: 2,
  very_complex: 3,
};

/**
 * 根据执行统计推断实际复杂度
 */
function inferActualComplexity(stats: {
  totalTasks: number;
  completed: number;
  failed: number;
  totalRetries: number;
}): ComplexityLevel {
  const { totalTasks, failed, totalRetries } = stats;
  if (totalTasks >= 10 || totalRetries >= 5) return "very_complex";
  if (totalTasks >= 5 || failed >= 2 || totalRetries >= 3) return "complex";
  if (totalTasks >= 2) return "moderate";
  return "simple";
}

/**
 * CP4: 构建回顾学习结果
 *
 * @param sessionKey 会话标识
 * @param stats 轮次执行统计
 * @returns 回顾结果，或 null（无 CP0 上下文）
 */
export function buildRetrospective(
  sessionKey: string,
  stats: {
    totalTasks: number;
    completed: number;
    failed: number;
    totalRetries: number;
  },
): RetrospectiveResult | null {
  const ctx = getActiveContext(sessionKey);
  if (!ctx) return null;

  const actualComplexity = inferActualComplexity(stats);
  const predicted = COMPLEXITY_ORD[ctx.intentAnalysis.complexity];
  const actual = COMPLEXITY_ORD[actualComplexity];

  let predictionAccuracy: RetrospectiveResult["predictionAccuracy"];
  if (Math.abs(predicted - actual) <= 0) {
    predictionAccuracy = "accurate";
  } else if (predicted < actual) {
    predictionAccuracy = "underestimated";
  } else {
    predictionAccuracy = "overestimated";
  }

  const lessonsLearned: string[] = [];
  if (predictionAccuracy === "underestimated") {
    lessonsLearned.push(
      `CP0 预判 ${ctx.intentAnalysis.complexity}，实际执行为 ${actualComplexity}（低估）。` +
      `用户消息特征：「${ctx.userMessage.substring(0, 100)}」`,
    );
  } else if (predictionAccuracy === "overestimated") {
    lessonsLearned.push(
      `CP0 预判 ${ctx.intentAnalysis.complexity}，实际执行为 ${actualComplexity}（高估）。` +
      `可能增加了不必要的分解开销。`,
    );
  }

  const result: RetrospectiveResult = {
    actualComplexity,
    predictionAccuracy,
    lessonsLearned,
  };

  // 写入 Context
  ctx.retrospective = result;

  console.log(
    `[IntentComplexityAnalyzer] 📝 CP4 回顾: predicted=${ctx.intentAnalysis.complexity}, ` +
    `actual=${actualComplexity}, accuracy=${predictionAccuracy}`,
  );

  return result;
}
