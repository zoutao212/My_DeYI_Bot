/**
 * 零依赖关键词抽取器（Keyword Extractor）
 *
 * 从大段文本中快速提取高价值关键词，用于驱动多层级记忆检索。
 * 核心算法：TF-IDF 变体 + 位置加权 + CJK bigram/trigram + 停用词过滤。
 * 纯 Node.js 实现，不依赖任何外部模型或 API。
 *
 * @module memory/keyword-extractor
 */

import { isMeaninglessNgram as isLowValueNgram } from "./shared-scorer.js";

// ─── 类型定义 ───────────────────────────────────────────────

export interface ExtractedKeyword {
  /** 关键词文本 */
  term: string;
  /** 综合得分 (0-1) */
  score: number;
  /** 出现频次 */
  frequency: number;
  /** 是否出现在标题 */
  inTitle: boolean;
  /** 类型：cjk 连续片段 / alpha 英文词 / bigram CJK 二字组 */
  type: "cjk" | "alpha" | "bigram" | "trigram" | "phrase";
}

export interface ExtractionOptions {
  /** 最大关键词数（默认 30） */
  maxKeywords?: number;
  /** 是否启用 bigram/trigram（默认 true） */
  enableNgrams?: boolean;
  /** 最小词频（默认 1） */
  minFrequency?: number;
  /** 是否保留英文停用词（默认 false） */
  keepStopwords?: boolean;
  /** 额外停用词 */
  extraStopwords?: string[];
  /** 是否提取短语（"词+词"连续模式）（默认 true） */
  enablePhrases?: boolean;
}

// ─── 停用词 ─────────────────────────────────────────────────

/** 中文停用词（高频虚词、连接词） */
const CJK_STOPWORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那", "被",
  "从", "而", "对", "以", "但", "与", "或", "这个", "那个", "什么",
  "怎么", "为什么", "如何", "可以", "应该", "需要", "能够", "已经",
  "正在", "还是", "虽然", "因为", "所以", "如果", "那么", "然后",
  "但是", "而且", "或者", "以及", "等等", "其他", "之间", "之后",
  "之前", "这些", "那些", "关于", "通过", "进行", "使用", "目前",
  "其中", "以下", "以上", "以及", "并且", "不是", "没有",
]);

/** 英文停用词 */
const EN_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "that", "this", "these",
  "those", "it", "its", "he", "she", "we", "they", "you", "i", "me",
  "my", "your", "his", "her", "our", "their", "what", "which", "who",
  "whom", "when", "where", "why", "how", "about", "up", "down",
]);

/** 预构建的合并停用词集（避免每次 extractKeywords 调用都重建） */
const DEFAULT_STOPWORDS = new Set<string>([...CJK_STOPWORDS, ...EN_STOPWORDS]);

// ─── 分词 ───────────────────────────────────────────────────

/** CJK 字符范围正则 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const CJK_SEGMENT_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;
const ALPHA_WORD_RE = /[A-Za-z][A-Za-z0-9_-]{1,}/g;
const NUMBER_RE = /^\d+$/;

// W11: 停用字集合和 isLowValueNgram 已移至 shared-scorer.ts（导入为 isMeaninglessNgram -> isLowValueNgram）

interface RawToken {
  text: string;
  type: "cjk" | "alpha";
  lineIndex: number;
  isTitle: boolean;
}

/**
 * 从文本中提取原始 token
 */
function tokenize(text: string): RawToken[] {
  const lines = text.split("\n");
  const tokens: RawToken[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTitle = /^\s*#{1,6}\s/.test(line) || /^[=\-]{3,}\s*$/.test(line);

    // CJK 连续片段
    const cjkMatches = line.match(CJK_SEGMENT_RE);
    if (cjkMatches) {
      for (const segment of cjkMatches) {
        if (segment.length >= 2) {
          tokens.push({ text: segment, type: "cjk", lineIndex: i, isTitle });
        }
      }
    }

    // 英文单词
    const alphaMatches = line.match(ALPHA_WORD_RE);
    if (alphaMatches) {
      for (const word of alphaMatches) {
        if (word.length >= 2 && !NUMBER_RE.test(word)) {
          tokens.push({ text: word.toLowerCase(), type: "alpha", lineIndex: i, isTitle });
        }
      }
    }
  }

  return tokens;
}

// ─── TF-IDF 变体 ────────────────────────────────────────────

interface TermStat {
  frequency: number;
  inTitle: boolean;
  firstPosition: number; // 0-1 归一化（越靠前越重要）
  type: "cjk" | "alpha" | "bigram" | "trigram" | "phrase";
}

/**
 * 计算单文档 TF-IDF 变体分数
 * - TF: 对数词频 log(1 + freq)
 * - 位置加权: 标题 ×2.0，文档前 20% ×1.5
 * - 长度加权: 3-6 字的 CJK 词组额外加权（更可能是有意义的专有名词）
 */
function computeScore(stat: TermStat, totalTerms: number): number {
  // TF（对数平滑）
  const tf = Math.log(1 + stat.frequency) / Math.log(1 + totalTerms);

  // 位置加权：越靠前越重要
  const positionBoost = stat.firstPosition < 0.2 ? 1.5 : stat.firstPosition < 0.5 ? 1.2 : 1.0;

  // 标题加权
  const titleBoost = stat.inTitle ? 2.0 : 1.0;

  // 长度加权：3-6 字 CJK 更可能是有意义的词
  let lengthBoost = 1.0;
  if (stat.type === "cjk" || stat.type === "trigram" || stat.type === "phrase") {
    const len = stat.frequency; // 用于 ngram 时 len 不准，下面会在调用处用 term.length
    if (stat.type === "phrase") lengthBoost = 1.4;
    else if (stat.type === "trigram") lengthBoost = 1.3;
  }

  // ngram 类型不同权重
  let typeWeight = 1.0;
  if (stat.type === "bigram") typeWeight = 0.8;
  else if (stat.type === "trigram") typeWeight = 1.1;
  else if (stat.type === "phrase") typeWeight = 1.3;
  else if (stat.type === "cjk") typeWeight = 1.0;
  else if (stat.type === "alpha") typeWeight = 0.9;

  return tf * positionBoost * titleBoost * lengthBoost * typeWeight;
}

// ─── 公共 API ───────────────────────────────────────────────

/**
 * 从大段文本中快速提取关键词
 *
 * 核心流程：
 * 1. 分词（CJK 连续片段 + 英文单词）
 * 2. 停用词过滤
 * 3. 生成 bigram/trigram（CJK 二/三字组滑动窗口）
 * 4. TF-IDF 变体打分 + 位置/标题加权
 * 5. 去重合并 + 按分数排序截断
 *
 * @param text - 输入文本（可以是上万字的大段文本）
 * @param options - 配置选项
 * @returns 排序后的关键词列表
 */
export function extractKeywords(text: string, options: ExtractionOptions = {}): ExtractedKeyword[] {
  const {
    maxKeywords = 30,
    enableNgrams = true,
    minFrequency = 1,
    keepStopwords = false,
    extraStopwords = [],
    enablePhrases = true,
  } = options;

  if (!text || text.length < 5) return [];

  // 复用预构建的停用词集，仅在有额外停用词时才创建新 Set
  let stopwords: Set<string>;
  if (keepStopwords) {
    stopwords = extraStopwords.length > 0
      ? new Set(extraStopwords.map(w => w.toLowerCase()))
      : new Set<string>();
  } else if (extraStopwords.length > 0) {
    stopwords = new Set(DEFAULT_STOPWORDS);
    for (const w of extraStopwords) stopwords.add(w.toLowerCase());
  } else {
    stopwords = DEFAULT_STOPWORDS;
  }

  // Step 1: 分词
  const rawTokens = tokenize(text);
  if (rawTokens.length === 0) return [];

  const totalLines = text.split("\n").length;

  // Step 2: 统计词频（过滤停用词）
  const termStats = new Map<string, TermStat>();

  function addTerm(term: string, type: TermStat["type"], lineIndex: number, isTitle: boolean): void {
    if (stopwords.has(term)) return;
    // 过滤纯数字和过短 token
    if (term.length < 2) return;
    if (NUMBER_RE.test(term)) return;

    const existing = termStats.get(term);
    if (existing) {
      existing.frequency++;
      if (isTitle) existing.inTitle = true;
    } else {
      termStats.set(term, {
        frequency: 1,
        inTitle: isTitle,
        firstPosition: totalLines > 0 ? lineIndex / totalLines : 0,
        type,
      });
    }
  }

  for (const token of rawTokens) {
    if (token.type === "cjk") {
      const seg = token.text;
      // 完整片段作为关键词候选
      if (!stopwords.has(seg)) {
        addTerm(seg, "cjk", token.lineIndex, token.isTitle);
      }

      // 生成 bigram / trigram（W4: 过滤首尾为停用字的无意义碎片）
      if (enableNgrams && seg.length > 2) {
        for (let i = 0; i <= seg.length - 2; i++) {
          const bigram = seg.substring(i, i + 2);
          if (!stopwords.has(bigram) && !isLowValueNgram(bigram)) {
            addTerm(bigram, "bigram", token.lineIndex, token.isTitle);
          }
        }
        for (let i = 0; i <= seg.length - 3; i++) {
          const trigram = seg.substring(i, i + 3);
          if (!stopwords.has(trigram) && !isLowValueNgram(trigram)) {
            addTerm(trigram, "trigram", token.lineIndex, token.isTitle);
          }
        }
      }
    } else {
      // 英文
      addTerm(token.text, "alpha", token.lineIndex, token.isTitle);
    }
  }

  // Step 3: 提取相邻词短语（CJK 场景下连续 2-4 字的高频模式）
  if (enablePhrases) {
    const lines = text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const isTitle = /^\s*#{1,6}\s/.test(line);
      // 提取被标点/空格分隔的 CJK 短语（2-8字）
      const phraseMatches = line.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]{2,8}/g);
      if (phraseMatches) {
        for (const phrase of phraseMatches) {
          if (phrase.length >= 4 && !stopwords.has(phrase)) {
            addTerm(phrase, "phrase", li, isTitle);
          }
        }
      }
    }
  }

  // Step 4: 打分
  const totalTerms = termStats.size;
  const scored: ExtractedKeyword[] = [];

  for (const [term, stat] of termStats) {
    if (stat.frequency < minFrequency) continue;

    const rawScore = computeScore(stat, totalTerms);
    scored.push({
      term,
      score: rawScore,
      frequency: stat.frequency,
      inTitle: stat.inTitle,
      type: stat.type,
    });
  }

  // Step 5: 排序 + 归一化 + 去重子串
  scored.sort((a, b) => b.score - a.score);

  // 归一化到 0-1
  const maxScore = scored.length > 0 ? scored[0].score : 1;
  if (maxScore > 0) {
    for (const kw of scored) {
      kw.score = kw.score / maxScore;
    }
  }

  // 去重：如果一个短关键词是更高分长关键词的子串，降低短词优先级
  const deduped = deduplicateSubstrings(scored);

  return deduped.slice(0, maxKeywords);
}

/**
 * 从大段文本中快速提取搜索用关键词（只返回字符串列表）
 *
 * 便捷 API，适合直接传给 localGrepSearch / keywordSearch
 */
export function extractSearchTerms(text: string, maxTerms = 20): string[] {
  const keywords = extractKeywords(text, { maxKeywords: maxTerms * 2 });
  // 优先取 score > 0.3 的高分词，再补充到 maxTerms
  const highScore = keywords.filter(k => k.score > 0.3);
  const result = highScore.length >= maxTerms
    ? highScore.slice(0, maxTerms)
    : keywords.slice(0, maxTerms);
  return result.map(k => k.term);
}

/**
 * 批量关键词搜索：从文本中提取关键词，然后在多个目录中并行搜索
 *
 * 这是"大段文本 → 快速抽取关键词 → 多层级全面检索"的一站式 API。
 */
export function extractKeywordsForSearch(
  text: string,
  options?: ExtractionOptions & { maxSearchTerms?: number },
): { keywords: ExtractedKeyword[]; searchTerms: string[] } {
  const maxSearchTerms = options?.maxSearchTerms ?? 20;
  const keywords = extractKeywords(text, options);
  const searchTerms = extractSearchTerms(text, maxSearchTerms);
  return { keywords, searchTerms };
}

// ─── 内部工具函数 ────────────────────────────────────────────

/**
 * 去重子串：如果短词是高分长词的子串且分数较低，移除短词
 */
function deduplicateSubstrings(sorted: ExtractedKeyword[]): ExtractedKeyword[] {
  const result: ExtractedKeyword[] = [];
  const accepted = new Set<string>();

  for (const kw of sorted) {
    // 检查是否是已接受的更长词的子串
    let isSubstring = false;
    for (const acc of accepted) {
      if (acc !== kw.term && acc.includes(kw.term) && kw.score < 0.8) {
        isSubstring = true;
        break;
      }
    }
    if (!isSubstring) {
      result.push(kw);
      accepted.add(kw.term);
    }
  }

  return result;
}
