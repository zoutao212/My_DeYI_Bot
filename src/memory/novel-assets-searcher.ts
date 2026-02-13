/**
 * 小说素材参考片段检索引擎（Novel Assets Searcher）
 *
 * 专为大文件（几十万~百万字长篇小说 TXT）设计的段落级检索系统。
 * 核心思路：首次访问时将大文件切分为段落级索引（200-800字），
 * 后续查询只在段落索引上做关键词匹配，避免每次全文扫描。
 *
 * 三层使用：
 * - L1: 本模块 — 段落索引 + 关键词检索 + 智能片段提取
 * - L2: novel-reference-tool.ts — LLM 工具，主动调用
 * - L3: followup-runner.ts — 写作/角色扮演子任务自动注入
 *
 * 零外部依赖：纯 Node.js fs + 字符串操作。
 *
 * @module memory/novel-assets-searcher
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tokenizeQuery } from "./local-search.js";
import { extractSearchTerms } from "./keyword-extractor.js";
import {
  scoreText,
  computeDocumentFrequency,
  computeIdfWeight,
  computeFileNameBonus,
  findSentenceBoundaryBackward,
  findSentenceBoundaryForward,
  SENTENCE_END_RE,
} from "./shared-scorer.js";

// ─── 类型定义 ───────────────────────────────────────────────

/** 段落索引条目（内存中的最小检索单元） */
export interface ParagraphEntry {
  /** 文件内唯一序号（0-indexed） */
  paraIndex: number;
  /** 起始行号（1-indexed） */
  startLine: number;
  /** 结束行号（1-indexed） */
  endLine: number;
  /** 段落纯文本 */
  text: string;
  /** 段落字符数 */
  charCount: number;
  /** 所属章节标题（如果能识别） */
  chapterHint?: string;
  /** 是否是标题段落 */
  isTitle: boolean;
  /** 段落文本的小写缓存（避免重复 toLowerCase） */
  textLower: string;
}

/** 文件段落索引缓存 */
interface FileIndex {
  /** 绝对路径 */
  absPath: string;
  /** 文件名（不含路径） */
  fileName: string;
  /** 段落列表 */
  paragraphs: ParagraphEntry[];
  /** 总字符数 */
  totalChars: number;
  /** 总行数 */
  totalLines: number;
  /** 缓存时间 */
  cachedAt: number;
  /** 文件 mtime（用于缓存校验） */
  mtimeMs: number;
  /** 文件大小 */
  size: number;
}

/** 搜索选项 */
export interface NovelSearchOptions {
  /** 素材目录列表（绝对路径，默认 [NovelsAssets]） */
  dirs?: string[];
  /** 最大返回片段数（默认 5） */
  maxSnippets?: number;
  /** 单个片段目标长度（字符数，默认 400） */
  snippetTargetChars?: number;
  /** 单个片段最小长度（默认 100） */
  snippetMinChars?: number;
  /** 单个片段最大长度（默认 800） */
  snippetMaxChars?: number;
  /** 单个文件最多取几个片段（默认 3，保证来源多样性） */
  maxSnippetsPerFile?: number;
  /** 最低匹配分数（0-1，默认 0.1） */
  minScore?: number;
  /** 额外搜索关键词（手动指定） */
  extraTerms?: string[];
  /** 是否自动从查询中提取关键词扩展（默认 true） */
  autoExtractKeywords?: boolean;
}

/** 搜索结果片段 */
export interface NovelSnippet {
  /** 来源文件名（不含路径） */
  fileName: string;
  /** 来源文件绝对路径 */
  absPath: string;
  /** 起始行号（1-indexed） */
  startLine: number;
  /** 结束行号（1-indexed） */
  endLine: number;
  /** 片段文本 */
  text: string;
  /** 片段字符数 */
  charCount: number;
  /** 匹配分数（0-1） */
  score: number;
  /** 匹配到的关键词 */
  matchedTerms: string[];
  /** 所属章节标题（如果有） */
  chapterHint?: string;
}

/** 搜索结果 */
export interface NovelSearchResult {
  /** 匹配片段列表（按分数降序） */
  snippets: NovelSnippet[];
  /** 搜索耗时 ms */
  durationMs: number;
  /** 扫描的文件数 */
  filesScanned: number;
  /** 扫描的段落数 */
  paragraphsScanned: number;
  /** 使用的搜索词 */
  searchTerms: string[];
}

// ─── 常量 ──────────────────────────────────────────────────

/** 默认素材目录（用户 clawd 工作区下） */
const DEFAULT_NOVEL_ASSETS_DIR = "NovelsAssets";

/** 支持的文件扩展名 */
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md"]);

/** 段落最小字符数（太短的跳过） */
const PARA_MIN_CHARS = 30;

/** 段落最大字符数（超长段落会被拆分） */
const PARA_MAX_CHARS = 1500;

/** 单文件最大尺寸（50MB） */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** 段落索引缓存 TTL（10分钟） */
const INDEX_CACHE_TTL_MS = 10 * 60 * 1000;

/** 目录文件列表缓存 TTL（60秒） */
const DIR_LIST_CACHE_TTL_MS = 60_000;

/** 标题行正则（中文章节标题 / Markdown 标题） */
const CHAPTER_TITLE_RE = /(?:^\s*#{1,3}\s|^第[一二三四五六七八九十百千\d]+[章节篇回幕卷集部]|^[（(]?\d+[)）]?\s*[、.．]|^Chapter\s+\d|^CHAPTER\s+\d)/i;

/** 段落分隔正则（连续空行 / 章节标题前的分隔） */
const PARA_SPLIT_RE = /\n\s*\n/;

// ─── 段落索引缓存 ──────────────────────────────────────────

const indexCache = new Map<string, FileIndex>();

/** 清除过期的索引缓存 */
function clearExpiredIndexCache(): void {
  const now = Date.now();
  for (const [key, entry] of indexCache) {
    if (now - entry.cachedAt > INDEX_CACHE_TTL_MS) {
      indexCache.delete(key);
    }
  }
}

/** 手动清空全部索引缓存 */
export function clearNovelIndexCache(): void {
  indexCache.clear();
}

// ─── 目录文件列表缓存 ──────────────────────────────────────

interface DirListCache {
  files: string[];
  cachedAt: number;
}

const dirListCache = new Map<string, DirListCache>();

/** 递归遍历目录，只返回支持的文件 */
async function listNovelFiles(dir: string): Promise<string[]> {
  const now = Date.now();
  const cached = dirListCache.get(dir);
  if (cached && now - cached.cachedAt < DIR_LIST_CACHE_TTL_MS) {
    return cached.files;
  }

  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      } else if (entry.isDirectory()) {
        // 递归子目录
        const subFiles = await listNovelFiles(fullPath);
        results.push(...subFiles);
      }
    }
  } catch {
    // 目录不存在或无权限
  }

  dirListCache.set(dir, { files: [...results], cachedAt: now });
  return results;
}

// ─── 段落切分引擎 ──────────────────────────────────────────

/**
 * 将大文件内容切分为段落级索引
 *
 * 切分策略：
 * 1. 优先按连续空行分段
 * 2. 识别章节标题行，在标题前强制分段
 * 3. 超长段落按句子边界二次切分
 * 4. 太短的段落合并到上一段
 */
function splitIntoParagraphs(content: string): ParagraphEntry[] {
  const lines = content.split("\n");
  const paragraphs: ParagraphEntry[] = [];

  let currentLines: string[] = [];
  let currentStartLine = 1;
  let currentChapter = "";

  function flushParagraph(): void {
    if (currentLines.length === 0) return;
    const text = currentLines.join("\n").trim();
    if (text.length < PARA_MIN_CHARS) {
      // 太短，尝试合并到上一段
      if (paragraphs.length > 0 && !CHAPTER_TITLE_RE.test(text)) {
        const prev = paragraphs[paragraphs.length - 1];
        prev.text += "\n" + text;
        prev.textLower = prev.text.toLowerCase();
        prev.charCount = prev.text.length;
        prev.endLine = currentStartLine + currentLines.length - 1;
        currentLines = [];
        return;
      }
      // 如果确实太短（少于 10 字）且不是标题，直接丢弃
      if (text.length < 10 && !CHAPTER_TITLE_RE.test(text)) {
        currentLines = [];
        return;
      }
    }

    const endLine = currentStartLine + currentLines.length - 1;
    const isTitle = CHAPTER_TITLE_RE.test(text);

    // 检测章节标题更新
    if (isTitle) {
      currentChapter = text.substring(0, 50).replace(/\n.*/s, "");
    }

    // 超长段落拆分
    if (text.length > PARA_MAX_CHARS && !isTitle) {
      const subParas = splitLongParagraph(text, currentStartLine);
      for (const sp of subParas) {
        sp.chapterHint = currentChapter || undefined;
        paragraphs.push(sp);
      }
    } else {
      paragraphs.push({
        paraIndex: paragraphs.length,
        startLine: currentStartLine,
        endLine,
        text,
        charCount: text.length,
        chapterHint: currentChapter || undefined,
        isTitle,
        textLower: text.toLowerCase(),
      });
    }

    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // 空行 → 分段
    if (line.trim() === "") {
      if (currentLines.length > 0) {
        flushParagraph();
      }
      currentStartLine = lineNum + 1;
      continue;
    }

    // 章节标题行 → 在标题前强制分段
    if (CHAPTER_TITLE_RE.test(line) && currentLines.length > 0) {
      flushParagraph();
      currentStartLine = lineNum;
    }

    if (currentLines.length === 0) {
      currentStartLine = lineNum;
    }
    currentLines.push(line);
  }

  // 最后一段
  flushParagraph();

  // 重新编号 paraIndex
  for (let i = 0; i < paragraphs.length; i++) {
    paragraphs[i].paraIndex = i;
  }

  return paragraphs;
}

/**
 * 超长段落按句子边界拆分
 */
function splitLongParagraph(text: string, baseStartLine: number): ParagraphEntry[] {
  const results: ParagraphEntry[] = [];
  // 按中文句号/叹号/问号/英文句号+空格 分句
  const sentences = text.split(/(?<=[。！？!?])\s*|(?<=\.\s)/);

  let chunk = "";
  let chunkStartOffset = 0;

  for (const sentence of sentences) {
    if (chunk.length + sentence.length > PARA_MAX_CHARS && chunk.length >= PARA_MIN_CHARS) {
      // 估算行号（简单按字符比例）
      const lineEstimate = Math.round((chunkStartOffset / Math.max(text.length, 1)) * 20);
      results.push({
        paraIndex: 0,
        startLine: baseStartLine + lineEstimate,
        endLine: baseStartLine + lineEstimate + Math.ceil(chunk.length / 80),
        text: chunk.trim(),
        charCount: chunk.trim().length,
        isTitle: false,
        textLower: chunk.trim().toLowerCase(),
      });
      chunkStartOffset += chunk.length;
      chunk = "";
    }
    chunk += sentence;
  }

  if (chunk.trim().length >= PARA_MIN_CHARS) {
    const lineEstimate = Math.round((chunkStartOffset / Math.max(text.length, 1)) * 20);
    results.push({
      paraIndex: 0,
      startLine: baseStartLine + lineEstimate,
      endLine: baseStartLine + lineEstimate + Math.ceil(chunk.length / 80),
      text: chunk.trim(),
      charCount: chunk.trim().length,
      isTitle: false,
      textLower: chunk.trim().toLowerCase(),
    });
  }

  return results;
}

// ─── 文件索引构建 ──────────────────────────────────────────

/**
 * 获取或构建文件的段落索引（带缓存）
 */
async function getFileIndex(absPath: string): Promise<FileIndex | null> {
  clearExpiredIndexCache();

  const cached = indexCache.get(absPath);

  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) return null;

    // 缓存命中：mtime+size 未变
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.cachedAt = Date.now(); // 刷新 TTL
      return cached;
    }

    // 读取文件（大文件用 utf-8 流式）
    const content = await fs.readFile(absPath, "utf-8");
    const lines = content.split("\n");
    const paragraphs = splitIntoParagraphs(content);

    const index: FileIndex = {
      absPath,
      fileName: path.basename(absPath),
      paragraphs,
      totalChars: content.length,
      totalLines: lines.length,
      cachedAt: Date.now(),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };

    indexCache.set(absPath, index);
    return index;
  } catch {
    return null;
  }
}

// ─── 段落匹配打分 ──────────────────────────────────────────

interface ScoredParagraph {
  paragraph: ParagraphEntry;
  fileIndex: FileIndex;
  score: number;
  matchedTerms: string[];
}

/**
 * 对段落列表做关键词匹配打分（委托 shared-scorer.scoreText）
 *
 * A1: 统一使用 shared-scorer 的打分逻辑，包含 W1-W8 + A3(IDF) + W9(双指针) 全部优化。
 * A3: 当段落数 >= 5 时自动启用 IDF 加权，稀有词（角色名/地名）获得更高权重。
 */
function scoreParagraphs(
  fileIndex: FileIndex,
  tokens: string[],
): ScoredParagraph[] {
  const results: ScoredParagraph[] = [];
  const paragraphs = fileIndex.paragraphs;

  // A3: 预计算 IDF — 稀有词（角色名/地名/独特概念）自动获得更高权重
  let idfWeights: Map<string, number> | undefined;
  if (paragraphs.length >= 5) {
    const docTexts = paragraphs.map(p => p.textLower);
    const df = computeDocumentFrequency(tokens, docTexts);
    idfWeights = new Map<string, number>();
    for (const [token, freq] of df) {
      idfWeights.set(token, computeIdfWeight(freq, paragraphs.length));
    }
  }

  for (const para of paragraphs) {
    const result = scoreText(para.textLower, tokens, {
      fileName: fileIndex.fileName,
      isTitle: para.isTitle,
      charCount: para.charCount,
      idfWeights,
      modifiedAtMs: fileIndex.mtimeMs, // H5: 时间衰减
    });

    if (result) {
      results.push({
        paragraph: para,
        fileIndex,
        score: result.score,
        matchedTerms: result.matchedTerms,
      });
    }
  }

  return results;
}

// ─── 片段提取（智能截断到目标长度）─────────────────────────

/**
 * 从段落中提取目标长度的片段
 *
 * 策略：
 * - 段落长度 <= maxChars → 完整返回
 * - 段落长度 > maxChars → 从匹配关键词位置开始，截取到最近的句子边界
 */
// W8: SENTENCE_END_RE + findSentenceBoundaryBackward/Forward 已移至 shared-scorer.ts

function extractSnippet(
  para: ParagraphEntry,
  tokens: string[],
  targetChars: number,
  maxChars: number,
): string {
  const text = para.text;
  if (text.length <= maxChars) return text;

  // 找到第一个匹配关键词的位置，以此为中心截取
  let centerPos = 0;
  for (const token of tokens) {
    const idx = para.textLower.indexOf(token.toLowerCase());
    if (idx >= 0) {
      centerPos = idx;
      break;
    }
  }

  // 计算截取范围：以 centerPos 为中心，前后各取一半
  const halfLen = Math.floor(targetChars / 2);
  let start = Math.max(0, centerPos - halfLen);
  let end = Math.min(text.length, start + targetChars);

  // 调整 start 确保不超出
  if (end - start < targetChars && start > 0) {
    start = Math.max(0, end - targetChars);
  }

  // W8: 向前找到最近的句子边界（支持。！？」等多种标点）
  if (start > 0) {
    const boundary = findSentenceBoundaryBackward(text, start + 30, 80);
    if (boundary > 0 && boundary > start - 50) {
      start = boundary;
    }
  }

  // W8: 向后找到最近的句子边界
  if (end < text.length) {
    const boundary = findSentenceBoundaryForward(text, end - 30, 80);
    if (boundary > 0 && boundary < end + 50) {
      end = boundary;
    }
  }

  let snippet = text.substring(start, end).trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";

  return snippet;
}

// ─── 场景类型识别与关键词扩展（W7）─────────────────────────

/**
 * 场景类型 → 额外搜索关键词映射
 *
 * 当检测到查询含有特定场景意图时，自动注入该场景常见的描写关键词，
 * 提高对「写一段打斗场景」这类抽象查询的召回率。
 */
interface ScenePattern {
  /** 检测正则（匹配查询文本） */
  detect: RegExp;
  /** 注入的额外关键词（无需重复查询中已有的词） */
  terms: string[];
}

const SCENE_PATTERNS: ScenePattern[] = [
  {
    // 打斗/战斗/武侠场景
    detect: /(?:打斗|战斗|武斗|交手|对决|比武|厮杀|剑法|拳法|掌法|武功|内力|真气|出剑|出拳|格斗|血战|激战|决斗|拼杀)/,
    terms: ["剑", "刀", "拳", "掌", "血", "杀", "击", "挡", "闪", "攻", "退", "怒", "吼", "剑气", "内力", "真气", "身形", "招式", "凌厉", "凶猛"],
  },
  {
    // 情感/浪漫/感情场景
    detect: /(?:情感|爱情|浪漫|表白|亲密|温柔|思念|心动|暧昧|深情|告白|相爱|离别|重逢|相思|缠绵)/,
    terms: ["心", "泪", "眼", "唇", "手", "拥", "吻", "柔", "暖", "红", "笑", "颤", "温柔", "心跳", "目光", "脸颊", "轻声", "低语"],
  },
  {
    // 对话/交流场景
    detect: /(?:对话|交谈|争吵|谈判|劝说|质问|审问|密谈|商议|辩论|嘲讽|威胁)/,
    terms: ["说", "道", "问", "答", "笑", "怒", "冷", "声", "语气", "冷笑", "沉声", "淡淡", "嘴角", "皱眉"],
  },
  {
    // 环境/景色描写
    detect: /(?:环境|景色|风景|描写场景|氛围|气氛|天气|夜晚|黎明|黄昏|山水|城镇|宫殿|密室|森林|荒野)/,
    terms: ["风", "月", "云", "雨", "雪", "光", "影", "暗", "静", "寒", "冷", "雾", "夜色", "阳光", "天空", "远处", "四周"],
  },
  {
    // 悬疑/紧张/恐怖
    detect: /(?:悬疑|紧张|恐怖|惊悚|阴谋|秘密|危险|陷阱|伏击|暗杀|追踪|逃跑|潜入)/,
    terms: ["暗", "影", "血", "冷", "寒", "声", "静", "突然", "猛然", "一惊", "心沉", "不妙", "杀意", "寒意", "脚步"],
  },
];

/**
 * 检测查询中的场景类型，返回额外的搜索关键词
 * 返回空数组表示未检测到特定场景意图
 */
function detectSceneKeywords(query: string): string[] {
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const pattern of SCENE_PATTERNS) {
    if (pattern.detect.test(query)) {
      for (const term of pattern.terms) {
        if (!seen.has(term) && !query.includes(term)) {
          seen.add(term);
          extra.push(term);
        }
      }
    }
  }
  // 限制注入数量，避免过多噪音词稀释原始查询
  return extra.slice(0, 12);
}

// ─── 公共 API ──────────────────────────────────────────────

/**
 * 获取默认素材目录路径
 *
 * 用户的 clawd 工作区下的 NovelsAssets/
 */
export function getDefaultNovelAssetsDir(workspaceDir: string): string {
  return path.join(workspaceDir, DEFAULT_NOVEL_ASSETS_DIR);
}

/**
 * 在小说素材库中搜索参考片段
 *
 * 核心流程：
 * 1. 遍历素材目录，获取/构建每个文件的段落索引
 * 2. 从查询中提取关键词
 * 3. 对每个段落做关键词匹配打分
 * 4. 去重+多样性控制（单文件限额）
 * 5. 按分数排序，截取片段到目标长度
 *
 * @param query - 查询文本（任务 prompt / summary / 用户查询）
 * @param workspaceDir - clawd 工作区根目录
 * @param options - 搜索选项
 */
export async function searchNovelAssets(
  query: string,
  workspaceDir: string,
  options: NovelSearchOptions = {},
): Promise<NovelSearchResult> {
  const startTime = Date.now();

  const dirs = options.dirs ?? [getDefaultNovelAssetsDir(workspaceDir)];
  const maxSnippets = options.maxSnippets ?? 5;
  const snippetTargetChars = options.snippetTargetChars ?? 400;
  const snippetMinChars = options.snippetMinChars ?? 100;
  const snippetMaxChars = options.snippetMaxChars ?? 800;
  const maxSnippetsPerFile = options.maxSnippetsPerFile ?? 3;
  const minScore = options.minScore ?? 0.1;
  const autoExtract = options.autoExtractKeywords ?? true;
  const extraTerms = options.extraTerms ?? [];

  // Step 1: 分词 + 关键词扩展
  let tokens = tokenizeQuery(query);

  if (autoExtract && query.length > 30) {
    const extracted = extractSearchTerms(query, 20);
    for (const term of extracted) {
      const lower = term.toLowerCase();
      if (!tokens.includes(lower)) {
        tokens.push(lower);
      }
    }
  }

  // W7: 场景类型关键词扩展 — 检测查询中的场景意图，注入场景描写常用词
  const sceneTerms = detectSceneKeywords(query);
  for (const term of sceneTerms) {
    if (!tokens.includes(term)) {
      tokens.push(term);
    }
  }

  for (const term of extraTerms) {
    const lower = term.toLowerCase();
    if (!tokens.includes(lower)) {
      tokens.push(lower);
    }
  }

  if (tokens.length === 0) {
    return {
      snippets: [],
      durationMs: Date.now() - startTime,
      filesScanned: 0,
      paragraphsScanned: 0,
      searchTerms: [],
    };
  }

  // Step 2: 遍历素材目录，收集所有文件
  const allFiles: string[] = [];
  for (const dir of dirs) {
    const files = await listNovelFiles(dir);
    allFiles.push(...files);
  }

  // Step 3: 并行构建索引 + 搜索（分批避免同时打开太多文件）
  const BATCH_SIZE = 20;
  let allScored: ScoredParagraph[] = [];
  let totalParagraphs = 0;

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const indexes = await Promise.all(batch.map(f => getFileIndex(f)));

    for (const idx of indexes) {
      if (!idx) continue;
      totalParagraphs += idx.paragraphs.length;
      const scored = scoreParagraphs(idx, tokens);
      allScored.push(...scored);
    }
  }

  // Step 4: 按分数排序
  allScored.sort((a, b) => b.score - a.score);

  // Step 5: 多样性控制 — 单文件限额 + 去重
  const fileSnippetCount = new Map<string, number>();
  const selected: ScoredParagraph[] = [];

  for (const item of allScored) {
    if (selected.length >= maxSnippets * 2) break; // 收集足够多候选
    if (item.score < minScore) break;

    const fileKey = item.fileIndex.absPath;
    const count = fileSnippetCount.get(fileKey) ?? 0;
    if (count >= maxSnippetsPerFile) continue;

    // 去重：与已选片段有行号重叠的跳过
    const overlaps = selected.some(
      s => s.fileIndex.absPath === fileKey &&
        s.paragraph.startLine <= item.paragraph.endLine &&
        s.paragraph.endLine >= item.paragraph.startLine,
    );
    if (overlaps) continue;

    fileSnippetCount.set(fileKey, count + 1);
    selected.push(item);
  }

  // Step 6: 截取到目标长度，构建最终结果
  const snippets: NovelSnippet[] = [];
  for (const item of selected.slice(0, maxSnippets)) {
    const text = extractSnippet(
      item.paragraph,
      tokens,
      snippetTargetChars,
      snippetMaxChars,
    );

    // 跳过截取后仍然太短的片段
    if (text.length < snippetMinChars) continue;

    const snippet: NovelSnippet = {
      fileName: item.fileIndex.fileName,
      absPath: item.fileIndex.absPath,
      startLine: item.paragraph.startLine,
      endLine: item.paragraph.endLine,
      text,
      charCount: text.length,
      score: Math.round(item.score * 100) / 100,
      matchedTerms: item.matchedTerms,
    };
    if (item.paragraph.chapterHint) {
      snippet.chapterHint = item.paragraph.chapterHint;
    }
    snippets.push(snippet);
  }

  return {
    snippets,
    durationMs: Date.now() - startTime,
    filesScanned: allFiles.length,
    paragraphsScanned: totalParagraphs,
    searchTerms: tokens,
  };
}

/**
 * 检查素材目录是否存在且包含文件
 */
export async function hasNovelAssets(workspaceDir: string): Promise<boolean> {
  const dir = getDefaultNovelAssetsDir(workspaceDir);
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return false;
    const files = await listNovelFiles(dir);
    return files.length > 0;
  } catch {
    return false;
  }
}

/**
 * 获取素材库概览信息
 */
export async function getNovelAssetsOverview(workspaceDir: string): Promise<{
  dir: string;
  fileCount: number;
  files: Array<{ name: string; size: number; chars?: number }>;
}> {
  const dir = getDefaultNovelAssetsDir(workspaceDir);
  try {
    const files = await listNovelFiles(dir);
    const fileInfos = await Promise.all(
      files.map(async (f) => {
        try {
          const stat = await fs.stat(f);
          return { name: path.basename(f), size: stat.size };
        } catch {
          return { name: path.basename(f), size: 0 };
        }
      }),
    );
    return { dir, fileCount: files.length, files: fileInfos };
  } catch {
    return { dir, fileCount: 0, files: [] };
  }
}

/**
 * 格式化搜索结果为 Markdown（用于注入 system prompt）
 *
 * @param result - 搜索结果
 * @param maxTotalChars - 总输出字符上限（默认 3000）
 */
export function formatNovelSnippetsForPrompt(
  result: NovelSearchResult,
  maxTotalChars = 3000,
): string {
  if (result.snippets.length === 0) return "";

  const parts: string[] = [];
  let totalChars = 0;

  for (const snippet of result.snippets) {
    const header = `📖 [${snippet.fileName}${snippet.chapterHint ? ` / ${snippet.chapterHint}` : ""}] (L${snippet.startLine}-${snippet.endLine}, score=${snippet.score})`;
    const entry = `${header}\n${snippet.text}`;

    if (totalChars + entry.length > maxTotalChars) {
      // 截断到句子边界
      const remaining = maxTotalChars - totalChars - header.length - 10;
      if (remaining > 100) {
        const truncated = snippet.text.substring(0, remaining);
        const lastSentence = Math.max(
          truncated.lastIndexOf("。"),
          truncated.lastIndexOf("！"),
          truncated.lastIndexOf("？"),
          truncated.lastIndexOf("\n"),
        );
        const cutText = lastSentence > remaining * 0.5
          ? truncated.substring(0, lastSentence + 1) + "…"
          : truncated + "…";
        parts.push(`${header}\n${cutText}`);
      }
      break;
    }

    parts.push(entry);
    totalChars += entry.length;
  }

  return parts.join("\n---\n");
}
