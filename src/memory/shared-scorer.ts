/**
 * 共享关键词匹配打分模块（Shared Scorer）
 *
 * 统一 W1-W8 + A3(IDF) 打分逻辑，供所有搜索路径复用：
 * - novel-assets-searcher.ts（段落级小说素材检索）
 * - local-search.ts（localGrepSearch / deepGrepSearch）
 * - hybrid.ts（FTS 通道辅助）
 *
 * 一次优化，全链路受益。零外部依赖。
 *
 * @module memory/shared-scorer
 */

// ─── W11: 共享停用字集合 ─────────────────────────────────────

/**
 * CJK n-gram 首字停用集 — 以这些字开头的 bigram/trigram 大概率无意义
 * 例："的剑"/"了一"/"在这"
 */
export const CJK_STOPCHAR_HEAD = new Set(
  "的了在是我有和就不人都一上也很到说要去你会着没看好这他她它们那被从而对以但与或",
);

/**
 * CJK n-gram 尾字停用集 — 以这些字结尾的 bigram/trigram 大概率无意义
 * 例："剑的"/"高了"/"好吗"
 */
export const CJK_STOPCHAR_TAIL = new Set(
  "的了在是着过吗呢吧啊呀哦嘛啦嗯哈",
);

/**
 * 判断 CJK n-gram 是否为无意义碎片（W4）
 */
export function isMeaninglessNgram(ngram: string): boolean {
  if (ngram.length < 2) return true;
  if (CJK_STOPCHAR_HEAD.has(ngram[0])) return true;
  if (CJK_STOPCHAR_TAIL.has(ngram[ngram.length - 1])) return true;
  return false;
}

// ─── W1: 子串出现次数统计 ────────────────────────────────────

/**
 * 统计 text 中 sub 出现的次数（大小写不敏感版本需调用方预 lower）
 */
export function countOccurrences(text: string, sub: string): number {
  if (sub.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}

// ─── W2+W9: 邻近度计算（双指针优化）────────────────────────

/**
 * 收集子串在 text 中的所有出现位置（已天然升序）
 */
function collectPositions(text: string, sub: string): number[] {
  const positions: number[] = [];
  let pos = 0;
  while ((pos = text.indexOf(sub, pos)) !== -1) {
    positions.push(pos);
    pos += sub.length;
  }
  return positions;
}

/**
 * 计算两个关键词在文本中的最小邻近距离（W2）
 * 使用双指针 O(n+m) 替代暴力 O(n×m)（W9）
 * 返回 -1 表示至少有一个词不存在
 */
export function minProximity(textLower: string, termA: string, termB: string): number {
  const posA = collectPositions(textLower, termA);
  const posB = collectPositions(textLower, termB);
  if (posA.length === 0 || posB.length === 0) return -1;

  // W9: 双指针归并 — 两个数组都已升序
  let i = 0;
  let j = 0;
  let minDist = Infinity;
  while (i < posA.length && j < posB.length) {
    const dist = Math.abs(posA[i] - posB[j]);
    if (dist < minDist) minDist = dist;
    if (minDist === 0) return 0; // 提前退出
    if (posA[i] < posB[j]) i++;
    else j++;
  }
  return minDist;
}

// ─── W5: 文件名相关性加分 ────────────────────────────────────

/**
 * 计算文件名与搜索词的相关性加分
 * 文件名中包含关键词 → 该文件所有段落获得额外加分（最高 0.2）
 */
export function computeFileNameBonus(fileName: string, tokens: string[]): number {
  const nameLower = fileName.toLowerCase().replace(/\.[^.]+$/, "");
  let bonus = 0;
  for (const token of tokens) {
    if (token.length >= 2 && nameLower.includes(token)) {
      bonus += Math.min(0.15, token.length / Math.max(nameLower.length, 1) * 0.3);
    }
  }
  return Math.min(0.2, bonus);
}

// ─── W8: 句子边界搜索 ───────────────────────────────────────

/** 中文句末标点（支持多种标点作为句子边界） */
export const SENTENCE_END_RE = /[。！？!?」』…\n]/;

/**
 * 向前搜索最近的句子边界（从 pos 向左搜索）
 * 返回边界字符的下一个位置（即新内容的起始位置），-1 表示未找到
 */
export function findSentenceBoundaryBackward(text: string, pos: number, maxDistance: number): number {
  const searchStart = Math.max(0, pos - maxDistance);
  for (let i = pos; i >= searchStart; i--) {
    if (SENTENCE_END_RE.test(text[i])) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * 向后搜索最近的句子边界（从 pos 向右搜索）
 * 返回边界字符的下一个位置（即截取的结束位置），-1 表示未找到
 */
export function findSentenceBoundaryForward(text: string, pos: number, maxDistance: number): number {
  const searchEnd = Math.min(text.length - 1, pos + maxDistance);
  for (let i = pos; i <= searchEnd; i++) {
    if (SENTENCE_END_RE.test(text[i])) {
      return i + 1;
    }
  }
  return -1;
}

// ─── A3: 轻量 IDF 计算 ──────────────────────────────────────

/**
 * 预计算每个 token 的文档频率（DF）
 * 返回 Map<token, docFrequency>
 *
 * @param tokens - 搜索词列表（已 lowercased）
 * @param documents - 文档文本列表（已 lowercased）
 */
export function computeDocumentFrequency(
  tokens: string[],
  documents: string[],
): Map<string, number> {
  const df = new Map<string, number>();
  for (const token of tokens) {
    let count = 0;
    for (const doc of documents) {
      if (doc.includes(token)) count++;
    }
    df.set(token, count);
  }
  return df;
}

/**
 * 计算 IDF 权重（对数平滑）
 * IDF = log(totalDocs / (1 + df))
 * 归一化到 0.3-1.0 区间（避免极端值）
 */
export function computeIdfWeight(df: number, totalDocs: number): number {
  if (totalDocs <= 0) return 1.0;
  const raw = Math.log((totalDocs + 1) / (1 + df));
  const maxIdf = Math.log(totalDocs + 1); // df=0 时的最大 IDF
  if (maxIdf <= 0) return 1.0;
  // 归一化到 0.3 - 1.0
  return 0.3 + 0.7 * (raw / maxIdf);
}

// ─── 统一打分函数 ────────────────────────────────────────────

/** H5: 时间衰减最大加分（近期记忆的最高额外权重） */
const RECENCY_MAX_BONUS = 0.1;
/** H5: 半衰期天数（修改后 N 天分数衰减到一半） */
const RECENCY_HALF_LIFE_DAYS = 30;

/** 打分选项 */
export interface ScoreOptions {
  /** 文件名（用于 W5 文件名加分） */
  fileName?: string;
  /** 是否是标题段落 */
  isTitle?: boolean;
  /** 段落字符数（用于长度加权） */
  charCount?: number;
  /** IDF 权重 Map（token → idfWeight），不传则不使用 IDF */
  idfWeights?: Map<string, number>;
  /** H5: 文件最后修改时间（ms epoch），用于时间衰减加权 */
  modifiedAtMs?: number;
}

/** 打分结果 */
export interface ScoreResult {
  /** 综合分数 0-1 */
  score: number;
  /** 匹配到的 token 列表（已 lowercased） */
  matchedTerms: string[];
  /** 各维度分数（调试用） */
  breakdown: {
    coverage: number;
    freqDensity: number;
    proximityBonus: number;
    titleBonus: number;
    fileNameBonus: number;
    lengthScore: number;
    /** H5: 时间衰减加分（近期记忆 ≈ 0.1，30天 ≈ 0.05，90天 ≈ 0.025） */
    recencyBonus: number;
  };
}

/**
 * 统一打分函数 — 所有搜索路径的核心打分逻辑
 *
 * 打分维度（W1-W8 + A3）：
 * 1. 覆盖率（coverage）：匹配到多少不同的关键词（按词长×IDF 加权）
 * 2. 频次密度（freqDensity）：关键词出现总次数 / 段落千字（W1+W6）
 * 3. 邻近度（proximityBonus）：多个关键词彼此靠近时加分（W2）
 * 4. 标题加权（titleBonus）：标题段落额外加分
 * 5. 文件名相关性（fileNameBonus）：文件名含关键词时全段加分（W5）
 * 6. 段落长度适中加权（lengthScore）
 *
 * @param textLower - 段落文本（已 toLowerCase）
 * @param tokens - 搜索词列表（已 toLowerCase）
 * @param options - 额外选项
 */
export function scoreText(
  textLower: string,
  tokens: string[],
  options: ScoreOptions = {},
): ScoreResult | null {
  if (tokens.length === 0 || textLower.length === 0) return null;

  const idfWeights = options.idfWeights;
  const charCount = options.charCount ?? textLower.length;

  // 预计算总权重（按词长 × IDF 加权的分母）
  let totalWeight = 0;
  for (const t of tokens) {
    const lenW = Math.min(1, t.length / 4);
    const idfW = idfWeights?.get(t) ?? 1.0;
    totalWeight += lenW * idfW;
  }
  if (totalWeight === 0) return null;

  const matched: string[] = [];
  let matchWeight = 0;
  let totalOccurrences = 0;

  for (const token of tokens) {
    // W1: 计数而非仅检测存在性
    const occurrences = countOccurrences(textLower, token);
    if (occurrences > 0) {
      matched.push(token);
      const lenW = Math.min(1, token.length / 4);
      const idfW = idfWeights?.get(token) ?? 1.0;
      matchWeight += lenW * idfW;
      // W1: 对数平滑的出现次数
      totalOccurrences += Math.log(1 + occurrences);
    }
  }

  if (matched.length === 0) return null;

  // 覆盖率
  const coverage = matchWeight / totalWeight;

  // W1+W6: 频次密度 — 每千字出现次数
  const freqDensity = Math.min(1, totalOccurrences / Math.max(charCount / 1000, 0.5) * 0.3);

  // W2: 邻近度加分（W9: 双指针优化）
  let proximityBonus = 0;
  if (matched.length >= 2) {
    let closeCount = 0;
    const maxPairs = Math.min(matched.length * (matched.length - 1) / 2, 10);
    let pairsChecked = 0;
    for (let i = 0; i < matched.length && pairsChecked < maxPairs; i++) {
      for (let j = i + 1; j < matched.length && pairsChecked < maxPairs; j++) {
        pairsChecked++;
        // W10: matched[] 已经是 lowered，无需再 toLowerCase
        const dist = minProximity(textLower, matched[i], matched[j]);
        if (dist >= 0 && dist < 50) closeCount++;
        else if (dist >= 0 && dist < 150) closeCount += 0.3;
      }
    }
    proximityBonus = Math.min(0.15, closeCount / Math.max(pairsChecked, 1) * 0.2);
  }

  // 标题加权
  const titleBonus = options.isTitle ? 0.15 : 0;

  // W5: 文件名加分
  const fileNameBonus = options.fileName
    ? computeFileNameBonus(options.fileName, tokens)
    : 0;

  // 段落长度适中加权（100-800字最佳）
  const lengthScore = charCount >= 100 && charCount <= 800
    ? 0.03
    : charCount < 50 ? -0.1 : 0;

  // H5: 时间衰减加分 — 近期记忆权重更高
  let recencyBonus = 0;
  if (options.modifiedAtMs && options.modifiedAtMs > 0) {
    const daysSinceModified = Math.max(0, (Date.now() - options.modifiedAtMs) / 86_400_000);
    recencyBonus = RECENCY_MAX_BONUS / (1 + daysSinceModified / RECENCY_HALF_LIFE_DAYS);
  }

  // 综合打分
  const score = Math.min(1,
    coverage * 0.45
    + freqDensity * 0.2
    + proximityBonus
    + titleBonus
    + fileNameBonus
    + lengthScore
    + recencyBonus
    + 0.05,
  );

  if (score <= 0.05) return null;

  return {
    score,
    matchedTerms: matched,
    breakdown: {
      coverage,
      freqDensity,
      proximityBonus,
      titleBonus,
      fileNameBonus,
      lengthScore,
      recencyBonus,
    },
  };
}

/**
 * 批量打分辅助 — 预计算 IDF 后对多个文档评分
 *
 * 适用于 localGrepSearch / deepGrepSearch 等需要对多个片段评分的场景。
 *
 * @param tokens - 搜索词列表（已 toLowerCase）
 * @param documents - 待评分文档列表 { textLower, ... }
 * @returns 带分数的文档列表（过滤掉 score=null 的）
 */
export function scoreBatch<T extends { textLower: string }>(
  tokens: string[],
  documents: T[],
  options?: {
    /** 是否启用 IDF（默认 true，文档数 >= 5 时生效） */
    enableIdf?: boolean;
    /** 从文档中提取文件名的函数 */
    getFileName?: (doc: T) => string | undefined;
    /** 从文档中判断是否标题 */
    getIsTitle?: (doc: T) => boolean;
    /** 从文档中获取字符数 */
    getCharCount?: (doc: T) => number;
  },
): Array<T & { _score: ScoreResult }> {
  if (tokens.length === 0 || documents.length === 0) return [];

  const enableIdf = options?.enableIdf ?? true;

  // A3: 预计算 IDF
  let idfWeights: Map<string, number> | undefined;
  if (enableIdf && documents.length >= 5) {
    const docTexts = documents.map(d => d.textLower);
    const df = computeDocumentFrequency(tokens, docTexts);
    idfWeights = new Map<string, number>();
    for (const [token, freq] of df) {
      idfWeights.set(token, computeIdfWeight(freq, documents.length));
    }
  }

  const results: Array<T & { _score: ScoreResult }> = [];
  for (const doc of documents) {
    const result = scoreText(doc.textLower, tokens, {
      idfWeights,
      fileName: options?.getFileName?.(doc),
      isTitle: options?.getIsTitle?.(doc),
      charCount: options?.getCharCount?.(doc) ?? doc.textLower.length,
    });
    if (result) {
      results.push({ ...doc, _score: result });
    }
  }

  return results;
}
