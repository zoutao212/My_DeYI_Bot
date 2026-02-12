/**
 * M5: 智能查询路由器（Query Router）
 *
 * 根据查询特征（长度、语言、精确度、意图）自动路由到最优检索通道，
 * 替代 memory-tool.ts 中固定的三级回退（embedding→deepGrep→keyword）。
 *
 * 路由策略：
 * - 精确查找（文件名/路径/日期/ID）→ grep 优先
 * - 短关键词（<20字）→ keyword + grep 并行
 * - 语义查询（问句/概念性描述）→ embedding 优先 + grep 补充
 * - 长文本查询（>100字）→ deepGrep（自动关键词抽取）
 * - 中文为主 → grep 加权（FTS bigram 召回有限）
 *
 * @module memory/query-router
 */

// ─── 类型定义 ───────────────────────────────────────────────

/** 检索通道 */
export type SearchChannel = "embedding" | "grep" | "deepGrep" | "keyword" | "fts";

/** 查询特征分析结果 */
export interface QueryProfile {
  /** 查询长度（字符数） */
  length: number;
  /** 中文字符占比 (0-1) */
  cjkRatio: number;
  /** 是否包含精确查找信号（文件名/路径/日期/ID） */
  hasExactSignal: boolean;
  /** 是否是问句/语义查询 */
  isSemanticQuery: boolean;
  /** 是否是长文本查询（>100字） */
  isLongQuery: boolean;
  /** 推断的查询意图 */
  intent: QueryIntent;
  /** 有效关键词数量 */
  effectiveTermCount: number;
}

/** 查询意图 */
export type QueryIntent =
  | "exact_lookup"     // 精确查找（文件/路径/ID）
  | "keyword_search"   // 关键词搜索
  | "semantic_search"  // 语义搜索（问答/概念）
  | "long_context"     // 长文本上下文搜索
  | "exploratory";     // 探索性查询（模糊/宽泛）

/** 路由决策 */
export interface RouteDecision {
  /** 主通道 */
  primary: SearchChannel;
  /** 辅助通道（并行执行） */
  secondary: SearchChannel[];
  /** 各通道权重（用于结果合并） */
  weights: Partial<Record<SearchChannel, number>>;
  /** 查询特征分析 */
  profile: QueryProfile;
  /** 路由原因（调试用） */
  reason: string;
}

// ─── 常量 ──────────────────────────────────────────────────

/** 精确查找信号正则 */
const EXACT_PATTERNS = [
  /\.\w{2,4}$/,                                    // 文件扩展名
  /[\\\/]/,                                         // 路径分隔符
  /\d{4}[-\/]\d{2}[-\/]\d{2}/,                     // 日期格式
  /[0-9a-f]{8}-[0-9a-f]{4}-/i,                     // UUID 片段
  /(?:memory|characters|clawd)[\\\/]/i,             // 记忆目录关键路径
  /\.md\b|\.txt\b|\.json\b/,                       // 文件类型
  /MEMORY\.md|core-memories|SOUL/i,                 // 特定记忆文件
];

/** 语义查询信号 */
const SEMANTIC_PATTERNS_ZH = [
  /^(?:什么|为什么|怎么|如何|哪些|哪个|谁|何时|多少)/,  // 疑问词开头
  /[？?]$/,                                            // 问号结尾
  /(?:的意思|含义|区别|关系|原因|影响|作用)/,
  /(?:解释|描述|说明|总结|概括|分析)/,
  /(?:关于|有关|涉及|相关)/,
];

const SEMANTIC_PATTERNS_EN = [
  /^(?:what|why|how|when|where|who|which|explain|describe|summarize)/i,
  /\?$/,
  /(?:difference|relationship|meaning|impact|effect|cause)/i,
  /(?:about|regarding|related to|concerning)/i,
];

/** CJK 字符范围 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

// ─── 查询分析 ──────────────────────────────────────────────

/**
 * 分析查询特征，生成 QueryProfile
 */
export function analyzeQuery(query: string): QueryProfile {
  const trimmed = query.trim();
  const length = trimmed.length;

  // 中文占比
  const cjkMatches = trimmed.match(CJK_RE);
  const cjkCount = cjkMatches?.length ?? 0;
  const cjkRatio = length > 0 ? cjkCount / length : 0;

  // 精确查找信号
  const hasExactSignal = EXACT_PATTERNS.some(p => p.test(trimmed));

  // 语义查询信号
  const semanticPatterns = cjkRatio > 0.3 ? SEMANTIC_PATTERNS_ZH : SEMANTIC_PATTERNS_EN;
  const isSemanticQuery = semanticPatterns.some(p => p.test(trimmed));

  // 长文本
  const isLongQuery = length > 100;

  // 有效关键词数
  const alphaTokens = trimmed.match(/[A-Za-z0-9_]+/g)?.filter(t => t.length >= 2) ?? [];
  const cjkSegments = trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]{2,}/g) ?? [];
  const effectiveTermCount = alphaTokens.length + cjkSegments.length;

  // 推断意图
  let intent: QueryIntent;
  if (hasExactSignal) {
    intent = "exact_lookup";
  } else if (isLongQuery) {
    intent = "long_context";
  } else if (isSemanticQuery) {
    intent = "semantic_search";
  } else if (effectiveTermCount <= 2 && length < 30) {
    intent = "keyword_search";
  } else if (effectiveTermCount <= 1 && length > 5) {
    intent = "exploratory";
  } else {
    // 默认：关键词足够多时用关键词搜索，否则语义搜索
    intent = effectiveTermCount >= 3 ? "keyword_search" : "semantic_search";
  }

  return {
    length,
    cjkRatio,
    hasExactSignal,
    isSemanticQuery,
    isLongQuery,
    intent,
    effectiveTermCount,
  };
}

// ─── 路由决策 ──────────────────────────────────────────────

/**
 * 根据查询特征和可用通道生成路由决策
 *
 * @param query - 原始查询文本
 * @param available - 可用的检索通道（embedding 需要 API key，可能不可用）
 */
export function routeQuery(
  query: string,
  available: { embedding: boolean; fts: boolean; grep: boolean },
): RouteDecision {
  const profile = analyzeQuery(query);

  // ── 路由策略 ──────────────────────────────────

  // 策略1: 精确查找 → grep 优先（文件名/路径/日期等结构化信息）
  if (profile.intent === "exact_lookup") {
    return {
      primary: "grep",
      secondary: available.fts ? ["fts"] : [],
      weights: { grep: 0.7, fts: 0.3 },
      profile,
      reason: "精确查找信号（文件名/路径/日期/ID）→ grep 优先",
    };
  }

  // 策略2: 长文本查询 → deepGrep（自动关键词抽取最有效）
  if (profile.intent === "long_context") {
    const secondary: SearchChannel[] = [];
    const weights: Partial<Record<SearchChannel, number>> = { deepGrep: 0.5 };
    if (available.embedding) {
      secondary.push("embedding");
      weights.embedding = 0.3;
    }
    if (available.fts) {
      secondary.push("fts");
      weights.fts = 0.2;
    }
    return {
      primary: "deepGrep",
      secondary,
      weights,
      profile,
      reason: "长文本查询（>100字）→ deepGrep 关键词抽取驱动",
    };
  }

  // 策略3: 语义查询 + embedding 可用 → embedding 优先
  if (profile.intent === "semantic_search" && available.embedding) {
    const secondary: SearchChannel[] = ["grep"];
    const weights: Partial<Record<SearchChannel, number>> = {
      embedding: 0.6,
      grep: 0.25,
    };
    if (available.fts) {
      secondary.push("fts");
      weights.fts = 0.15;
    }
    return {
      primary: "embedding",
      secondary,
      weights,
      profile,
      reason: "语义查询 + embedding 可用 → embedding 优先 + grep 补充",
    };
  }

  // 策略4: 中文为主 + 短查询 → grep + fts 并行（FTS bigram 召回有限，grep 更可靠）
  if (profile.cjkRatio > 0.5 && profile.length < 50) {
    const secondary: SearchChannel[] = [];
    const weights: Partial<Record<SearchChannel, number>> = { grep: 0.5 };
    if (available.fts) {
      secondary.push("fts");
      weights.fts = 0.3;
    }
    if (available.embedding) {
      secondary.push("embedding");
      weights.embedding = 0.2;
    }
    return {
      primary: "grep",
      secondary,
      weights,
      profile,
      reason: "中文短查询 → grep 优先（FTS bigram 召回有限）",
    };
  }

  // 策略5: 关键词搜索 → 多通道并行
  if (profile.intent === "keyword_search") {
    if (available.embedding) {
      return {
        primary: "embedding",
        secondary: ["grep", ...(available.fts ? ["fts" as SearchChannel] : [])],
        weights: { embedding: 0.4, grep: 0.35, fts: 0.25 },
        profile,
        reason: "关键词搜索 + embedding 可用 → 三路并行",
      };
    }
    return {
      primary: "grep",
      secondary: available.fts ? ["fts"] : [],
      weights: { grep: 0.6, fts: 0.4 },
      profile,
      reason: "关键词搜索 + 无 embedding → grep + fts",
    };
  }

  // 策略6: 探索性查询 → 广撒网
  if (profile.intent === "exploratory") {
    if (available.embedding) {
      return {
        primary: "embedding",
        secondary: ["grep", "deepGrep"],
        weights: { embedding: 0.4, grep: 0.3, deepGrep: 0.3 },
        profile,
        reason: "探索性查询 → 全通道广撒网",
      };
    }
    return {
      primary: "deepGrep",
      secondary: available.fts ? ["fts"] : ["grep"],
      weights: { deepGrep: 0.5, fts: 0.3, grep: 0.3 },
      profile,
      reason: "探索性查询 + 无 embedding → deepGrep 扩展搜索",
    };
  }

  // 默认兜底：语义查询无 embedding → grep + fts
  return {
    primary: "grep",
    secondary: available.fts ? ["fts"] : [],
    weights: { grep: 0.6, fts: 0.4 },
    profile,
    reason: "默认兜底 → grep + fts",
  };
}

// ─── 搜索结果缓存 ───────────────────────────────────────────

interface CachedSearchResult {
  results: unknown[];
  cachedAt: number;
  queryHash: string;
}

const SEARCH_CACHE_TTL_MS = 30_000; // 30 秒
const SEARCH_CACHE_MAX_ENTRIES = 50;
const searchCache = new Map<string, CachedSearchResult>();

/**
 * 生成查询缓存 key（query + maxResults 组合）
 */
export function getSearchCacheKey(query: string, maxResults: number): string {
  return `${query.trim().substring(0, 200)}:${maxResults}`;
}

/**
 * 从缓存获取搜索结果
 */
export function getCachedSearchResult<T>(key: string): T[] | null {
  const cached = searchCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return cached.results as T[];
}

/**
 * 缓存搜索结果
 */
export function cacheSearchResult(key: string, results: unknown[]): void {
  // LRU 简易实现：超过上限时删除最旧的
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of searchCache) {
      if (v.cachedAt < oldestTime) {
        oldestTime = v.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, {
    results,
    cachedAt: Date.now(),
    queryHash: key,
  });
}

/**
 * 清空搜索缓存（写入操作后调用）
 */
export function invalidateSearchCache(): void {
  searchCache.clear();
}
