/**
 * P102: 上游意图复杂度预判器 (Intent Complexity Analyzer)
 *
 * 解决的核心问题：
 * 用户发送"短 prompt + 高隐含复杂度"的请求时（如"参考 NovelsAssets 构建美学服饰品味"），
 * LLM 往往低估任务规模，直接尝试单轮处理而不调用 enqueue_task。
 *
 * 本模块在主 agent LLM 调用之前，用一次轻量 LLM 调用（~500 token 输出）
 * 快速分析用户意图和任务复杂度，产出：
 * 1. 复杂度等级（simple / moderate / complex / very_complex）
 * 2. 推荐执行策略（direct / suggest_decompose / force_decompose）
 * 3. 结构化注入提示（注入 extraSystemPrompt，引导主 LLM 使用 enqueue_task）
 *
 * 设计原则：
 * - 用 llm_light（低 maxTokens=512, 低 timeout=20s）做预判，开销极小
 * - 失败静默降级（不阻塞主流程）
 * - 对简单闲聊/问候/短指令快速跳过（规则前置过滤）
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

/** 跳过预判的最长消息长度（超长消息本身就会触发 shouldAutoDecompose） */
const MAX_ANALYSIS_LENGTH = 5000;

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
  source: "llm" | "rule_skip";
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
 * 规则前置过滤：判断是否应该跳过 LLM 预判
 *
 * @returns true = 跳过预判（简单消息），false = 需要 LLM 预判
 */
function shouldSkipAnalysis(userMessage: string): boolean {
  const trimmed = userMessage.trim();

  // 太短
  if (trimmed.length < MIN_ANALYSIS_LENGTH) return true;

  // 太长（超长消息本身会触发 shouldAutoDecompose，不需要预判）
  if (trimmed.length > MAX_ANALYSIS_LENGTH) return true;

  // 命中简单交互模式
  if (SIMPLE_INTERACTION_PATTERNS.some(p => p.test(trimmed))) return true;

  return false;
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
// 主入口
// ────────────────────────────────────────────────────────────

/** LLMCaller 单例缓存（避免每次请求重建） */
let _cachedCaller: { call: (prompt: string) => Promise<string> } | null = null;
let _cachedCallerConfigKey: string | null = null;

/**
 * 分析用户消息的意图和复杂度
 *
 * 在主 agent LLM 调用之前运行，用轻量 LLM 快速预判。
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
  // 规则前置过滤
  if (shouldSkipAnalysis(userMessage)) {
    return {
      complexity: "simple",
      strategy: "direct",
      reason: "规则跳过：消息过短/过长或匹配简单交互模式",
      source: "rule_skip",
    };
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

    const prompt = buildAnalysisPrompt(userMessage);
    console.log(`[IntentComplexityAnalyzer] 🔍 开始预判用户意图复杂度 (消息长度=${userMessage.length})`);

    const startTime = Date.now();
    const response = await _cachedCaller.call(prompt);
    const elapsed = Date.now() - startTime;

    console.log(`[IntentComplexityAnalyzer] ⏱️ LLM 预判完成 (${elapsed}ms, 响应长度=${response.length})`);

    const result = parseAnalysisResponse(response);
    if (result) {
      console.log(
        `[IntentComplexityAnalyzer] 📊 预判结果: complexity=${result.complexity}, ` +
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
    console.warn(`[IntentComplexityAnalyzer] ⚠️ 预判失败，静默降级: ${msg}`);
    return {
      complexity: "moderate",
      strategy: "direct",
      reason: `预判失败: ${msg}`,
      source: "llm",
    };
  }
}
