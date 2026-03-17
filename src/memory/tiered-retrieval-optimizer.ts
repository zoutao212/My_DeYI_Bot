/**
 * 分层检索优化器 (Tiered Retrieval Optimizer)
 *
 * 核心理念：不同相关性的检索结果应该有不同的用途和注入位置
 *
 * 分层策略：
 * - Tier 1 (高相关性 > 0.7): 直接注入 prompt 核心区，LLM 必读
 * - Tier 2 (中相关性 0.4-0.7): 注入参考区，LLM 可选参考
 * - Tier 3 (低相关性 < 0.4): 后台索引备用，不占用 prompt 空间
 *
 * @module memory/tiered-retrieval-optimizer
 */

import type { RetrievalSnippet } from "../agents/proactive-retrieval.js";

/** 分层结果 */
export interface TieredRetrievalResult {
  /** Tier 1: 高相关性片段（直接注入核心区） */
  tier1Core: RetrievalSnippet[];
  /** Tier 2: 中相关性片段（注入参考区） */
  tier2Reference: RetrievalSnippet[];
  /** Tier 3: 低相关性片段（后台备用） */
  tier3Backup: RetrievalSnippet[];
  /** 格式化后的核心上下文（必选） */
  coreContext: string;
  /** 格式化后的参考上下文（可选） */
  referenceContext: string;
  /** 总体统计 */
  stats: {
    total: number;
    tier1: number;
    tier2: number;
    tier3: number;
  };
}

/** 分层配置 */
export interface TieredConfig {
  /** Tier 1 最低分数阈值 */
  tier1Threshold: number;
  /** Tier 2 最低分数阈值 */
  tier2Threshold: number;
  /** Tier 1 最大片段数 */
  maxTier1Snippets: number;
  /** Tier 2 最大片段数 */
  maxTier2Snippets: number;
}

const DEFAULT_CONFIG: TieredConfig = {
  tier1Threshold: 0.7,
  tier2Threshold: 0.4,
  maxTier1Snippets: 3,
  maxTier2Snippets: 5,
};

/**
 * 对检索结果进行分层
 */
export function tieredRetrieval(
  snippets: RetrievalSnippet[],
  config: TieredConfig = DEFAULT_CONFIG,
): TieredRetrievalResult {
  // 按分数降序排序
  const sorted = [...snippets].sort((a, b) => b.score - a.score);
  
  // 分层
  const tier1: RetrievalSnippet[] = [];
  const tier2: RetrievalSnippet[] = [];
  const tier3: RetrievalSnippet[] = [];
  
  for (const snippet of sorted) {
    if (snippet.score >= config.tier1Threshold && tier1.length < config.maxTier1Snippets) {
      tier1.push(snippet);
    } else if (snippet.score >= config.tier2Threshold && tier2.length < config.maxTier2Snippets) {
      tier2.push(snippet);
    } else {
      tier3.push(snippet);
    }
  }
  
  // 格式化输出
  const coreContext = formatTierContext(tier1, "core");
  const referenceContext = formatTierContext(tier2, "reference");
  
  return {
    tier1Core: tier1,
    tier2Reference: tier2,
    tier3Backup: tier3,
    coreContext,
    referenceContext,
    stats: {
      total: snippets.length,
      tier1: tier1.length,
      tier2: tier2.length,
      tier3: tier3.length,
    },
  };
}

/**
 * 格式化某一分层的上下文
 */
function formatTierContext(
  snippets: RetrievalSnippet[],
  tierType: "core" | "reference",
): string {
  if (snippets.length === 0) return "";
  
  const header = tierType === "core"
    ? "[🎯 核心上下文 - 高度相关信息]"
    : "[📚 参考上下文 - 中度相关信息]";
  
  const importanceHint = tierType === "core"
    ? "\n⚠️ 以下内容与当前任务高度相关，请务必参考并使用。"
    : "\n💡 以下内容可能与当前任务相关，可供参考。";
  
  const formattedSnippets = snippets.map((snippet, idx) => {
    const sourceIcon = getSourceIcon(snippet.source);
    const scoreBadge = `[匹配度：${(snippet.score * 100).toFixed(0)}%]`;
    
    return `${idx + 1}. ${sourceIcon} ${scoreBadge}\n   来源：${formatSourcePath(snippet.path)}\n   ${truncateText(snippet.text, tierType === "core" ? 400 : 250)}`;
  }).join("\n\n");
  
  return `${header}${importanceHint}\n${formattedSnippets}`;
}

/**
 * 获取来源类型的图标
 */
function getSourceIcon(source: RetrievalSnippet["source"]): string {
  switch (source) {
    case "memory": return "💭";
    case "novel": return "📖";
    case "agent-def": return "🤖";
    case "tool-def": return "🛠️";
  }
}

/**
 * 格式化来源路径（缩短显示）
 */
function formatSourcePath(path: string): string {
  // 提取文件名
  const parts = path.split(/[\\/]/);
  const fileName = parts[parts.length - 1];
  
  // 如果路径很短，直接返回
  if (parts.length <= 2) return path;
  
  // 否则显示为：目录/.../文件名
  return `${parts[0]}/.../${fileName}`;
}

/**
 * 截断文本
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text.trim();
  return text.substring(0, maxLength).trim() + "\n   ...[内容已截断]";
}

/**
 * 优化后的主动检索结果（整合分层检索）
 */
export interface OptimizedRetrievalResult {
  /** 原始检索结果 */
  originalSnippets: RetrievalSnippet[];
  /** 分层后的结果 */
  tiered: TieredRetrievalResult;
  /** 使用的检索策略 */
  strategy?: string;
  /** 检索耗时 */
  durationMs: number;
  /** 推荐的 prompt 注入方式 */
  injectionRecommendation: InjectionRecommendation;
}

/** Prompt 注入方式推荐 */
export interface InjectionRecommendation {
  /** 是否注入核心区 */
  injectCore: boolean;
  /** 是否注入参考区 */
  injectReference: boolean;
  /** 预估额外 Token 消耗 */
  estimatedTokens: number;
  /** 注入建议 */
  suggestion: string;
}

/**
 * 优化检索结果，生成分层上下文
 */
export function optimizeRetrievalResult(
  snippets: RetrievalSnippet[],
  durationMs: number,
  strategy?: string,
): OptimizedRetrievalResult {
  const tiered = tieredRetrieval(snippets);
  
  // 估算 Token 消耗（粗略估算：每 4 个字符≈1 个 token）
  const coreTokens = Math.ceil(tiered.coreContext.length / 4);
  const refTokens = Math.ceil(tiered.referenceContext.length / 4);
  
  // 生成注入建议
  const recommendation: InjectionRecommendation = (() => {
    if (tiered.tier1Core.length === 0 && tiered.tier2Reference.length === 0) {
      return {
        injectCore: false,
        injectReference: false,
        estimatedTokens: 0,
        suggestion: "未检索到高相关性内容，建议不进行注入，节省 Token。",
      };
    }
    
    if (tiered.tier1Core.length > 0) {
      return {
        injectCore: true,
        injectReference: tiered.tier2Reference.length > 0,
        estimatedTokens: coreTokens + (tiered.tier2Reference.length > 0 ? refTokens : 0),
        suggestion: `发现 ${tiered.tier1Core.length} 条高相关性内容，强烈建议注入到 prompt 核心区。`,
      };
    }
    
    return {
      injectCore: false,
      injectReference: true,
      estimatedTokens: refTokens,
      suggestion: `仅有 ${tiered.tier2Reference.length} 条中等相关性内容，可选择性注入到参考区。`,
    };
  })();
  
  return {
    originalSnippets: snippets,
    tiered,
    strategy,
    durationMs,
    injectionRecommendation: recommendation,
  };
}
