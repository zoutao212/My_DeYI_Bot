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
  /** 风格重排：只对前 N 个候选做风格画像分析并重排（默认从环境变量读取；0 表示禁用） */
  rerankTopK?: number;
  /** 多样性：同一主导类型最多选几个（默认从环境变量读取） */
  maxSnippetsPerDominantType?: number;
  /** 多样性：同一章节提示最多选几个（默认从环境变量读取） */
  maxSnippetsPerChapterHint?: number;
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

// ─── 段落索引缓存（内存 + H6 磁盘持久化）───────────────────────

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

/** 手动清空全部索引缓存（内存 + 磁盘） */
export function clearNovelIndexCache(): void {
  indexCache.clear();
}

// ─── H6: 磁盘持久化 ──────────────────────────────────────────

/** H6: 持久化段落边界（不含 text/textLower，从文件重建） */
interface PersistedParagraphBoundary {
  paraIndex: number;
  startLine: number;
  endLine: number;
  charCount: number;
  chapterHint?: string;
  isTitle: boolean;
}

/** H6: 磁盘索引文件格式 */
interface PersistedNovelIndex {
  version: 1;
  absPath: string;
  fileName: string;
  totalChars: number;
  totalLines: number;
  mtimeMs: number;
  size: number;
  createdAt: number;
  paragraphs: PersistedParagraphBoundary[];
}

/**
 * H6: 简单路径哈希（用于生成缓存文件名）
 * 产生一个包含文件名 + 路径哈希的唯一标识符
 */
function hashForCacheFile(absPath: string): string {
  const baseName = path.basename(absPath, path.extname(absPath));
  let hash = 0;
  for (let i = 0; i < absPath.length; i++) {
    hash = ((hash << 5) - hash + absPath.charCodeAt(i)) | 0;
  }
  const hashStr = Math.abs(hash).toString(36).padStart(6, "0");
  // 清洗文件名（移除特殊字符）
  const safeName = baseName.replace(/[^\w\u4e00-\u9fff-]/g, "_").substring(0, 30);
  return `${safeName}_${hashStr}`;
}

/**
 * H6: 从磁盘加载持久化索引
 * 返回 null 表示磁盘缓存不存在或已过期
 */
async function loadPersistedIndex(
  absPath: string,
  stat: { mtimeMs: number; size: number },
  cacheDir: string,
): Promise<FileIndex | null> {
  try {
    const cacheFile = path.join(cacheDir, hashForCacheFile(absPath) + ".json");
    const raw = await fs.readFile(cacheFile, "utf-8");
    const persisted: PersistedNovelIndex = JSON.parse(raw);

    // 校验版本 + mtime + size
    if (persisted.version !== 1) return null;
    if (persisted.mtimeMs !== stat.mtimeMs || persisted.size !== stat.size) return null;
    if (persisted.absPath !== absPath) return null;

    // 从文件重建 text/textLower（只读文件，不重新解析）
    const content = await fs.readFile(absPath, "utf-8");
    const lines = content.split("\n");

    const paragraphs: ParagraphEntry[] = persisted.paragraphs.map(pb => {
      const startIdx = Math.max(0, pb.startLine - 1);
      const endIdx = Math.min(lines.length, pb.endLine);
      const text = lines.slice(startIdx, endIdx).join("\n").trim();
      return {
        paraIndex: pb.paraIndex,
        startLine: pb.startLine,
        endLine: pb.endLine,
        text,
        charCount: text.length,
        chapterHint: pb.chapterHint,
        isTitle: pb.isTitle,
        textLower: text.toLowerCase(),
      };
    });

    return {
      absPath,
      fileName: persisted.fileName,
      paragraphs,
      totalChars: persisted.totalChars,
      totalLines: persisted.totalLines,
      cachedAt: Date.now(),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * H6: 将段落索引持久化到磁盘（fire-and-forget）
 */
async function persistIndex(index: FileIndex, cacheDir: string): Promise<void> {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, hashForCacheFile(index.absPath) + ".json");

    const persisted: PersistedNovelIndex = {
      version: 1,
      absPath: index.absPath,
      fileName: index.fileName,
      totalChars: index.totalChars,
      totalLines: index.totalLines,
      mtimeMs: index.mtimeMs,
      size: index.size,
      createdAt: Date.now(),
      paragraphs: index.paragraphs.map(p => ({
        paraIndex: p.paraIndex,
        startLine: p.startLine,
        endLine: p.endLine,
        charCount: p.charCount,
        chapterHint: p.chapterHint,
        isTitle: p.isTitle,
      })),
    };

    // 原子写入（tmp -> rename）
    const tmpFile = cacheFile + ".tmp";
    await fs.writeFile(tmpFile, JSON.stringify(persisted), "utf-8");
    await fs.rename(tmpFile, cacheFile);
  } catch {
    // 持久化失败不影响功能
  }
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
 * 获取或构建文件的段落索引（三层缓存：内存 → H6磁盘 → 重建）
 *
 * @param absPath - 文件绝对路径
 * @param cacheDir - H6 磁盘缓存目录（不传则不使用磁盘缓存）
 */
async function getFileIndex(absPath: string, cacheDir?: string): Promise<FileIndex | null> {
  clearExpiredIndexCache();

  const cached = indexCache.get(absPath);

  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) return null;

    // L1: 内存缓存命中（mtime+size 未变）
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.cachedAt = Date.now(); // 刷新 TTL
      return cached;
    }

    // L2: H6 磁盘缓存命中（冷启动时避免重新解析）
    if (cacheDir) {
      const fromDisk = await loadPersistedIndex(absPath, stat, cacheDir);
      if (fromDisk) {
        indexCache.set(absPath, fromDisk);
        return fromDisk;
      }
    }

    // L3: 完整重建（读取文件 + splitIntoParagraphs）
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

    // H6: fire-and-forget 持久化到磁盘（首次切分只做一次）
    if (cacheDir) {
      void persistIndex(index, cacheDir);
    }

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

// 素材 TXT 常见噪音段落（书名/作者/打包区/网址/温馨提示等）。
// 这些段落会显著降低“风格化学习样本”的纯度，因此在打分阶段直接跳过。
const JUNK_PARAGRAPH_RE =
  /(?:^|\s)(?:书名|作者|排版|打包区|TXT\s*文学|温馨提示|更多小说|欢迎广大书友)(?:\s|$)|https?:\/\/|www\.|forumdisplay\.php|fid=/i;

function looksLikeJunkParagraph(textLower: string): boolean {
  return JUNK_PARAGRAPH_RE.test(textLower);
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
    if (looksLikeJunkParagraph(para.textLower)) continue;
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
  {
    // 文学性/高级作家风格 (W9)
    detect: /(?:高级作家|文学性|细腻|意境|神韵|神态|心理|留白|隐喻|象征|质感|深度|笔触|余韵|况味|颗粒感|生命力)/,
    terms: ["神色", "端详", "若有所思", "况味", "氤氲", "斑驳", "虚实", "疏离", "寂静", "深邃", "呼吸", "起伏", "底色", "余温", "凝视", "捕捉", "交织", "褶皱", "脉络", "沉浮"],
  },
  {
    // 修辞手法与写作技巧 (W11)
    detect: /(?:修辞|比喻|拟人|通感|对比|衬托|排比|节奏|韵律|文字技巧|叙事手法)/,
    terms: ["犹如", "仿佛", "正如", "交响", "剥落", "错位", "重叠", "某种", "无声", "张裂", "消融", "映射", "投射", "定格"],
  },
  {
    // 情感张力与戏剧冲突 (W12)
    detect: /(?:张力|冲突|对抗|压抑|爆发|暗流|博弈|情感高峰|心理博弈)/,
    terms: ["紧绷", "对峙", "撕裂", "焦灼", "颤动", "迸发", "暗潮", "汹涌", "窒息", "挣扎", "角力", "拉扯"],
  },
  {
    // 五感意象检索增强 (W10)
    detect: /(?:氛围|意象|感官|视觉|听觉|嗅觉|触觉|味觉|描写|动态|静态)/,
    terms: [
      "微光", "清冷", "喧嚣", "幽香", "温润", "凛冽", "沉闷", "跳动", "静谧", // 氛围词
      "色彩", "构图", "轮廓", "剪影", "明暗", // 视觉
      "余音", "低吟", "破碎", "回响", "摩挲", // 听觉/动态
      "潮湿", "粗糙", "质地", "纹理", "张力" // 触觉/质感
    ],
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
  const rerankTopKFromOpt = options.rerankTopK;
  const rerankTopKFromEnv = Number.parseInt(process.env.CLAWDBOT_NOVEL_REF_RERANK_TOP_K ?? "", 10);
  const rerankTopK = typeof rerankTopKFromOpt === "number" && Number.isFinite(rerankTopKFromOpt)
    ? Math.max(0, rerankTopKFromOpt)
    : (Number.isFinite(rerankTopKFromEnv) ? Math.max(0, rerankTopKFromEnv) : 160);

  const maxPerTypeFromOpt = options.maxSnippetsPerDominantType;
  const maxPerTypeFromEnv = Number.parseInt(process.env.CLAWDBOT_NOVEL_REF_MAX_SNIPPETS_PER_TYPE ?? "", 10);
  const maxSnippetsPerDominantType = typeof maxPerTypeFromOpt === "number" && Number.isFinite(maxPerTypeFromOpt)
    ? Math.min(8, Math.max(1, maxPerTypeFromOpt))
    : (Number.isFinite(maxPerTypeFromEnv) ? Math.min(8, Math.max(1, maxPerTypeFromEnv)) : 3);

  const maxPerChapterFromOpt = options.maxSnippetsPerChapterHint;
  const maxPerChapterFromEnv = Number.parseInt(process.env.CLAWDBOT_NOVEL_REF_MAX_SNIPPETS_PER_CHAPTER ?? "", 10);
  const maxSnippetsPerChapterHint = typeof maxPerChapterFromOpt === "number" && Number.isFinite(maxPerChapterFromOpt)
    ? Math.min(8, Math.max(1, maxPerChapterFromOpt))
    : (Number.isFinite(maxPerChapterFromEnv) ? Math.min(8, Math.max(1, maxPerChapterFromEnv)) : 2);

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

  // H6: 磁盘缓存目录（冷启动时避免重新切分百万字大文件）
  const novelIndexCacheDir = path.join(workspaceDir, ".cache", "novel-index");

  // Step 3: 并行构建索引 + 搜索（分批避免同时打开太多文件）
  const BATCH_SIZE = 20;
  let allScored: ScoredParagraph[] = [];
  let totalParagraphs = 0;

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const indexes = await Promise.all(batch.map(f => getFileIndex(f, novelIndexCacheDir)));

    for (const idx of indexes) {
      if (!idx) continue;
      totalParagraphs += idx.paragraphs.length;
      const scored = scoreParagraphs(idx, tokens);
      allScored.push(...scored);
    }
  }

  // Step 4: 按分数排序
  allScored.sort((a, b) => b.score - a.score);

  if (rerankTopK > 0 && allScored.length > 0) {
    const desired = inferDesiredStyleProfile(query);
    const topK = Math.min(allScored.length, Math.max(20, rerankTopK));
    const head = allScored.slice(0, topK).map(item => {
      const profile = analyzeSnippetStyle(item.paragraph.text);
      const bonus = computeStyleMatchBonus(desired, profile);
      return {
        item,
        adjusted: Math.min(1, item.score + bonus),
        profile,
      };
    });
    head.sort((a, b) => b.adjusted - a.adjusted);
    const tail = allScored.slice(topK);
    allScored = [...head.map(h => ({ ...h.item, score: h.adjusted })), ...tail];
  }

  // Step 5: 多样性控制 — 单文件限额 + 去重
  const fileSnippetCount = new Map<string, number>();
  const dominantTypeCount = new Map<string, number>();
  const chapterHintCount = new Map<string, number>();
  const selected: ScoredParagraph[] = [];

  for (const item of allScored) {
    if (selected.length >= maxSnippets * 2) break; // 收集足够多候选
    if (item.score < minScore) break;

    const fileKey = item.fileIndex.absPath;
    const count = fileSnippetCount.get(fileKey) ?? 0;
    if (count >= maxSnippetsPerFile) continue;

    const profile = analyzeSnippetStyle(item.paragraph.text);
    const typeKey = profile.dominantType;
    const typeCount = dominantTypeCount.get(typeKey) ?? 0;
    if (typeCount >= maxSnippetsPerDominantType) continue;

    const chapterKey = item.paragraph.chapterHint ? item.paragraph.chapterHint.substring(0, 60) : "";
    if (chapterKey) {
      const chCount = chapterHintCount.get(chapterKey) ?? 0;
      if (chCount >= maxSnippetsPerChapterHint) continue;
    }

    // 去重：与已选片段有行号重叠的跳过
    const overlaps = selected.some(
      s => s.fileIndex.absPath === fileKey &&
        s.paragraph.startLine <= item.paragraph.endLine &&
        s.paragraph.endLine >= item.paragraph.startLine,
    );
    if (overlaps) continue;

    fileSnippetCount.set(fileKey, count + 1);
    dominantTypeCount.set(typeKey, typeCount + 1);
    if (chapterKey) {
      chapterHintCount.set(chapterKey, (chapterHintCount.get(chapterKey) ?? 0) + 1);
    }
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

// ─── W13: 片段风格智能分析引擎（纯正则，零 LLM 调用）──────────

/**
 * 片段文本特征分析结果
 *
 * 通过轻量正则分析文本的写作特征，用于生成差异化引导语。
 * 核心思路：不同类型的样本需要不同的学习重点，
 * 通用引导语 = 无效引导语 = 提示疲劳。
 */
interface SnippetStyleProfile {
  /** 主导类型：对白驱动 / 描写沉浸 / 心理刻画 / 动作叙事 / 混合叙事 */
  dominantType: "dialogue" | "description" | "psychology" | "action" | "mixed";
  /** 对话密度（引号对数 / 总字数 × 100） */
  dialogueDensity: number;
  /** 平均句长（字符） */
  avgSentenceLen: number;
  /** 感官词密度（感官词数 / 总字数 × 100） */
  sensoryDensity: number;
  /** 动作词密度 */
  actionDensity: number;
  /** 心理词密度 */
  psychDensity: number;
  /** 句式节奏类型：短促型 / 舒展型 / 交替型 */
  rhythmType: "staccato" | "flowing" | "alternating";
}

interface DesiredStyleProfile {
  preferredDominantTypes: Array<SnippetStyleProfile["dominantType"]>;
  preferredRhythmTypes: Array<SnippetStyleProfile["rhythmType"]>;
  preferHighSensory?: boolean;
  preferHighPsych?: boolean;
}

// 感官词库（视觉/听觉/嗅觉/触感/味觉）
const SENSORY_WORDS_RE = /(?:光|影|暗|亮|明|灭|色|红|白|黑|金|银|碧|翠|声|响|低吟|呼啸|寂静|沉默|气息|香|腥|潮湿|冰冷|温热|滚烫|粗糙|光滑|柔软|坚硬|苦|甜|涩|酸|咸)/g;
// 动作词库
const ACTION_WORDS_RE = /(?:跑|跳|闪|躲|扑|挡|击|劈|刺|冲|退|转|抓|握|推|拉|踢|甩|砸|挥|掷|撞|翻|滚|摔)/g;
// 心理词库（内心活动标记）
const PSYCH_WORDS_RE = /(?:想|觉得|以为|明白|理解|记得|回忆|恐惧|害怕|担心|犹豫|疑惑|困惑|不安|焦虑|期待|渴望|矛盾|挣扎|释然|释怀|心底|心中|脑海|意识到|感受到|一阵|某种|莫名)/g;
// 对话标记（中文引号对）
const DIALOGUE_PAIR_RE = /[\u201c\u201d\u300c\u300d\u300e\u300f]/g;

/**
 * W13: 分析单个片段的写作风格特征
 *
 * 纯正则分析，O(n) 复杂度，不产生任何外部调用。
 * 返回精确的风格画像，供引导语模板选择器使用。
 */
function analyzeSnippetStyle(text: string): SnippetStyleProfile {
  const totalChars = Math.max(text.length, 1);

  // 1. 对话密度：统计引号对数
  const quoteMarks = text.match(DIALOGUE_PAIR_RE);
  const dialoguePairs = quoteMarks ? Math.floor(quoteMarks.length / 2) : 0;
  const dialogueDensity = (dialoguePairs / totalChars) * 100;

  // 2. 句子切分与平均句长
  const sentences = text.split(/[\u3002\uff01\uff1f!?;;\u2026]+/).filter(s => s.trim().length > 2);
  const avgSentenceLen = sentences.length > 0
    ? Math.round(sentences.reduce((sum, s) => sum + s.trim().length, 0) / sentences.length)
    : totalChars;

  // 3. 句式节奏分析：短句占比（< 15 字）vs 长句占比（> 40 字）
  const shortSentences = sentences.filter(s => s.trim().length < 15).length;
  const longSentences = sentences.filter(s => s.trim().length > 40).length;
  const sentenceCount = Math.max(sentences.length, 1);
  const shortRatio = shortSentences / sentenceCount;
  const longRatio = longSentences / sentenceCount;
  let rhythmType: SnippetStyleProfile["rhythmType"] = "alternating";
  if (shortRatio > 0.6) rhythmType = "staccato";
  else if (longRatio > 0.5) rhythmType = "flowing";

  // 4. 各类词密度
  const sensoryHits = text.match(SENSORY_WORDS_RE);
  const sensoryDensity = sensoryHits ? (sensoryHits.length / totalChars) * 100 : 0;

  const actionHits = text.match(ACTION_WORDS_RE);
  const actionDensity = actionHits ? (actionHits.length / totalChars) * 100 : 0;

  const psychHits = text.match(PSYCH_WORDS_RE);
  const psychDensity = psychHits ? (psychHits.length / totalChars) * 100 : 0;

  // 5. 确定主导类型（按优先级判断）
  let dominantType: SnippetStyleProfile["dominantType"] = "mixed";
  if (dialogueDensity > 0.8) {
    dominantType = "dialogue";
  } else if (actionDensity > 1.5) {
    dominantType = "action";
  } else if (psychDensity > 1.2) {
    dominantType = "psychology";
  } else if (sensoryDensity > 1.0 || (longRatio > 0.4 && dialogueDensity < 0.3)) {
    dominantType = "description";
  }

  return {
    dominantType,
    dialogueDensity: Math.round(dialogueDensity * 100) / 100,
    avgSentenceLen,
    sensoryDensity: Math.round(sensoryDensity * 100) / 100,
    actionDensity: Math.round(actionDensity * 100) / 100,
    psychDensity: Math.round(psychDensity * 100) / 100,
    rhythmType,
  };
}

function inferDesiredStyleProfile(query: string): DesiredStyleProfile {
  const q = query.toLowerCase();
  const preferredDominantTypes: DesiredStyleProfile["preferredDominantTypes"] = [];
  const preferredRhythmTypes: DesiredStyleProfile["preferredRhythmTypes"] = [];
  let preferHighSensory = false;
  let preferHighPsych = false;

  const wantsLiterary = /(?:高级作家|文学性|细腻|意境|神韵|留白|隐喻|象征|余韵|况味|颗粒感|生命力)/i.test(query);
  const wantsScene = /(?:环境|景色|风景|氛围|气氛|天气|夜晚|黎明|黄昏|意象|五感|感官|质感)/i.test(query);
  const wantsPsych = /(?:心理|内心|心绪|情绪|克制|压抑|隐忍|挣扎|矛盾|释然|释怀|疏离)/i.test(query);
  const wantsDialogue = /(?:对话|台词|交谈|争吵|谈判|劝说|质问|密谈|商议|辩论)/i.test(query);
  const wantsAction = /(?:打斗|战斗|交手|厮杀|追逐|逃跑|伏击|暗杀|冲突|对抗|爆发)/i.test(query);

  if (wantsDialogue) preferredDominantTypes.push("dialogue");
  if (wantsAction) preferredDominantTypes.push("action");

  if (wantsLiterary || wantsScene) {
    preferredDominantTypes.push("description");
    preferHighSensory = true;
  }
  if (wantsLiterary || wantsPsych) {
    preferredDominantTypes.push("psychology");
    preferHighPsych = true;
  }

  const wantsStaccato = /(?:短句|急促|凌厉|干脆|碎裂|爆发|刀锋|脉冲)/i.test(query);
  const wantsFlowing = /(?:舒展|绵长|氤氲|缓慢|余韵|回旋|呼吸感|铺陈|层叠|沉浸)/i.test(query);
  if (wantsStaccato) preferredRhythmTypes.push("staccato");
  if (wantsFlowing) preferredRhythmTypes.push("flowing");
  if (preferredRhythmTypes.length === 0) {
    if (wantsAction) preferredRhythmTypes.push("staccato");
    if (wantsLiterary || wantsScene || wantsPsych) preferredRhythmTypes.push("flowing");
  }

  if (preferredDominantTypes.length === 0) preferredDominantTypes.push("mixed");
  if (preferredRhythmTypes.length === 0) preferredRhythmTypes.push("alternating");

  return {
    preferredDominantTypes: Array.from(new Set(preferredDominantTypes)),
    preferredRhythmTypes: Array.from(new Set(preferredRhythmTypes)),
    preferHighSensory,
    preferHighPsych,
  };
}

function computeStyleMatchBonus(desired: DesiredStyleProfile, profile: SnippetStyleProfile): number {
  let bonus = 0;
  if (desired.preferredDominantTypes.includes(profile.dominantType)) bonus += 0.08;
  if (desired.preferredRhythmTypes.includes(profile.rhythmType)) bonus += 0.06;
  if (desired.preferHighSensory && profile.sensoryDensity >= 1.2) bonus += 0.05;
  if (desired.preferHighPsych && profile.psychDensity >= 1.1) bonus += 0.05;
  return bonus;
}

/**
 * W13: 根据片段风格画像生成差异化引导语
 *
 * 核心设计：不同类型的样本需要不同的学习焦点。
 * 消灭"提示疲劳"——8 个片段不再贴同一套引导词。
 */
function buildSnippetGuidance(profile: SnippetStyleProfile, matchedTerms: string[]): string {
  const termHint = matchedTerms.length > 0
    ? `\uff08\u6d89\u53ca\uff1a${matchedTerms.slice(0, 3).join("\u3001")}\uff09`
    : "";

  // 节奏描述
  const rhythmDesc = profile.rhythmType === "staccato"
    ? "\u77ed\u53e5\u6025\u4fc3\uff0c\u5236\u9020\u7d27\u8feb\u611f"
    : profile.rhythmType === "flowing"
      ? "\u957f\u53e5\u8212\u5c55\uff0c\u8425\u9020\u6c89\u6d78\u611f"
      : "\u957f\u77ed\u4ea4\u66ff\uff0c\u547c\u5438\u6709\u81f4";

  switch (profile.dominantType) {
    case "dialogue":
      return `[\u5b66\u4e60\u7126\u70b9\u00b7\u5bf9\u767d\u9a71\u52a8]${termHint}\n` +
        `\u89c2\u5bdf\uff1a\u2460 \u89d2\u8272\u8bed\u6c14\u5dee\u5f02\u5982\u4f55\u901a\u8fc7\u7528\u8bcd\u800c\u975e\u201c\u8bf4\u8bdd\u6807\u7b7e\u201d\u6765\u4f53\u73b0 ` +
        `\u2461 \u5bf9\u8bdd\u95f4\u7684\u6c89\u9ed8/\u52a8\u4f5c\u63cf\u5199\u5982\u4f55\u4f20\u9012\u6f5c\u53f0\u8bcd ` +
        `\u2462 \u5bf9\u767d\u8282\u594f\uff08${rhythmDesc}\uff09`;

    case "description":
      return `[\u5b66\u4e60\u7126\u70b9\u00b7\u4e94\u611f\u6c89\u6d78]${termHint}\n` +
        `\u89c2\u5bdf\uff1a\u2460 \u611f\u5b98\u5c42\u6b21\u5982\u4f55\u4ea4\u66ff\uff08\u89c6\u89c9\u2192\u542c\u89c9\u2192\u89e6\u611f\uff09\u6784\u5efa\u7a7a\u95f4\u611f ` +
        `\u2461 \u73af\u5883\u7ec6\u8282\u5982\u4f55\u6620\u5c04\u4eba\u7269\u5185\u5728\u60c5\u7eea ` +
        `\u2462 \u53d9\u4e8b\u8282\u594f\uff08${rhythmDesc}\uff09`;

    case "psychology":
      return `[\u5b66\u4e60\u7126\u70b9\u00b7\u5fc3\u7406\u523b\u753b]${termHint}\n` +
        `\u89c2\u5bdf\uff1a\u2460 \u5185\u5fc3\u6d3b\u52a8\u5982\u4f55\u901a\u8fc7\u7ec6\u5fae\u52a8\u4f5c/\u611f\u5b98\u788e\u7247\u5448\u73b0\u800c\u975e\u76f4\u767d\u9648\u8ff0 ` +
        `\u2461 \u601d\u7ef4\u7684\u8df3\u8dc3\u4e0e\u65ad\u88c2\u5982\u4f55\u5236\u9020\u771f\u5b9e\u611f ` +
        `\u2462 \u53d9\u8ff0\u8ddd\u79bb\u7684\u8fdc\u8fd1\u5207\u6362`;

    case "action":
      return `[\u5b66\u4e60\u7126\u70b9\u00b7\u52a8\u6001\u53d9\u4e8b]${termHint}\n` +
        `\u89c2\u5bdf\uff1a\u2460 \u52a8\u4f5c\u94fe\u6761\u7684\u8282\u594f\u63a7\u5236\uff08\u5feb\u6162\u4ea4\u66ff\u3001\u6025\u505c\uff09 ` +
        `\u2461 \u52a8\u8bcd\u7cbe\u5ea6\uff08\u5177\u4f53\u3001\u9510\u5229\uff0c\u907f\u514d\u6cdb\u5316\uff09 ` +
        `\u2462 \u611f\u5b98\u6355\u6349\uff08\u75bc\u75db/\u51b2\u51fb\u529b/\u58f0\u54cd\u7684\u5373\u65f6\u611f\uff09`;

    case "mixed":
    default:
      return `[\u5b66\u4e60\u7126\u70b9\u00b7\u7efc\u5408\u53d9\u4e8b]${termHint}\n` +
        `\u89c2\u5bdf\uff1a\u2460 \u53d9\u4e8b\u89c6\u89d2\u7684\u5207\u6362\u5982\u4f55\u4fdd\u6301\u6d41\u7545 ` +
        `\u2461 \u63cf\u5199\u4e0e\u5bf9\u767d\u7684\u4ea4\u7ec7\u6bd4\u4f8b ` +
        `\u2462 \u6bb5\u843d\u8282\u594f\uff08${rhythmDesc}\uff09`;
  }
}

// ─── W14: 块级综合创作指令 + AI 写作陷阱反例 ────────────────

/**
 * AI 常见写作陷阱反例库
 *
 * 分为多组，每个块注入不同组的反例，避免重复。
 * 设计原则：不仅告诉 AI "学什么"，更要告诉它"绝对不要写成什么"。
 */
const AI_WRITING_ANTIPATTERNS: string[][] = [
  [
    `\u274c \u7981\u6b62\u201c\u4ed6\u7684\u773c\u7738\u6df1\u9083\u5982\u661f\u8fb0\u5927\u6d77\u201d\u5f0f\u6ee5\u7528\u6bd4\u55bb \u2014 \u6bd4\u55bb\u8981\u7cbe\u786e\u951a\u5b9a\uff0c\u4e0d\u8981\u534e\u800c\u4e0d\u5b9e`,
    `\u274c \u7981\u6b62\u6bcf\u6bb5\u90fd\u4ee5\u201c\u4ed6/\u5979\u201d\u5f00\u5934 \u2014 \u7528\u73af\u5883\u3001\u611f\u5b98\u3001\u52a8\u4f5c\u8d77\u5934\u5236\u9020\u53d8\u5316`,
    `\u274c \u7981\u6b62\u201c\u67d0\u79cd\u8bf4\u4e0d\u6e05\u9053\u4e0d\u660e\u7684\u60c5\u611b\u201d \u2014 \u5982\u679c\u8bf4\u4e0d\u6e05\uff0c\u5c31\u7528\u5177\u4f53\u7684\u8eab\u4f53\u611f\u53d7\u66ff\u4ee3`,
  ],
  [
    `\u274c \u7981\u6b62\u6bb5\u843d\u7ed3\u5c3e\u505a\u603b\u7ed3\u6027\u5347\u534e\uff08\u201c\u4e5f\u8bb8\u8fd9\u5c31\u662f\u4eba\u751f\u5427\u201d\uff09 \u2014 \u5b66\u6837\u672c\u4e2d\u7684\u621b\u7136\u800c\u6b62`,
    `\u274c \u7981\u6b62\u4f7f\u7528\u201c\u603b\u4e4b/\u7136\u800c/\u4e0d\u4ec5\u5982\u6b64/\u4e0e\u6b64\u540c\u65f6\u201d\u7b49\u903b\u8f91\u8fde\u63a5\u8bcd \u2014 \u7528\u753b\u9762\u5207\u6362\u66ff\u4ee3`,
    `\u274c \u7981\u6b62\u8fde\u7eed\u4f7f\u7528\u4e09\u4e2a\u4ee5\u4e0a\u5f62\u5bb9\u8bcd\u5806\u780c \u2014 \u9009\u6700\u7cbe\u51c6\u7684\u4e00\u4e2a\u5c31\u591f\u4e86`,
  ],
  [
    `\u274c \u7981\u6b62\u201c\u7a7a\u6c14\u4eff\u4f5b\u51dd\u56fa\u4e86\u201d \u2014 \u8fd9\u662f\u6700\u6cdb\u6ee5\u7684 AI \u53e5\u5f0f\uff0c\u6539\u7528\u5177\u4f53\u611f\u5b98\uff08\u547c\u5438\u53d8\u6d45\u3001\u58f0\u97f3\u6d88\u5931\uff09`,
    `\u274c \u7981\u6b62\u5728\u63cf\u5199\u5916\u8c8c\u65f6\u5217\u51fa\u4e94\u5b98\u6e05\u5355 \u2014 \u53ea\u6355\u6349\u4e00\u4e2a\u6700\u6709\u8fa8\u8bc6\u5ea6\u7684\u7279\u5f81`,
    `\u274c \u7981\u6b62\u7528\u201c\u4e0d\u77e5\u4e0d\u89c9\u201d\u63a8\u8fdb\u65f6\u95f4 \u2014 \u7528\u573a\u666f\u53d8\u5316\u6216\u611f\u5b98\u53d8\u5316\u6765\u6807\u8bb0\u65f6\u95f4\u6d41\u901d`,
  ],
  [
    `\u274c \u7981\u6b62\u5728\u9ad8\u6f6e\u573a\u666f\u4f7f\u7528\u6162\u52a8\u4f5c\u5206\u955c\u00d73 \u2014 \u4e00\u6b21\u8db3\u77e3\uff0c\u8fc7\u591a\u4f1a\u6d88\u89e3\u5f20\u529b`,
    `\u274c \u7981\u6b62\u89d2\u8272\u201c\u5634\u89d2\u4e0a\u626c/\u5fae\u5fae\u4e00\u7b11\u201d\u8d85\u8fc7 2 \u6b21 \u2014 \u6362\u6210\u5176\u4ed6\u5fae\u8868\u60c5\u6216\u538b\u6839\u4e0d\u5199`,
    `\u274c \u7981\u6b62\u7528\u6392\u6bd4\u53e5\u6292\u60c5 \u2014 \u6392\u6bd4\u662f\u6f14\u8bb2\u4f53\uff0c\u4e0d\u662f\u5c0f\u8bf4\u4f53`,
  ],
  [
    `\u274c \u7981\u6b62\u5199\u201c\u4e00\u80a1\u6696\u6d41\u6d8c\u4e0a\u5fc3\u5934\u201d \u2014 \u8fd9\u662f\u4e2d\u5b66\u4f5c\u6587\u53e5\uff0c\u7528\u7cbe\u51c6\u7684\u8eab\u4f53\u53cd\u5e94\u66ff\u4ee3`,
    `\u274c \u7981\u6b62\u89d2\u8272\u201c\u6df1\u5438\u4e00\u53e3\u6c14\u201d\u8d85\u8fc7 1 \u6b21 \u2014 \u627e\u5176\u4ed6\u7f13\u51b2\u52a8\u4f5c\uff08\u6518\u62f3\u3001\u79fb\u5f00\u89c6\u7ebf\u3001\u62bf\u5507\uff09`,
    `\u274c \u7981\u6b62\u5728\u6bcf\u6bb5\u60c5\u611f\u63cf\u5199\u540e\u52a0\u201c\u4ed6/\u5979\u4e0d\u77e5\u9053\u7684\u662f\u2026\u201d \u2014 \u8fd9\u662f\u5ec9\u4ef7\u60ac\u5ff5`,
  ],
  [
    `\u274c \u7981\u6b62\u201c\u4eff\u4f5b\u56de\u5230\u4e86\u90a3\u4e2aXYZ\u7684\u591c\u665a\u201d \u2014 \u56de\u5fc6\u8981\u901a\u8fc7\u611f\u5b98\u89e6\u53d1\uff0c\u4e0d\u8981\u76f4\u767d\u5ba3\u544a`,
    `\u274c \u7981\u6b62\u4e3a\u89d2\u8272 tagline \u5f0f\u5730\u91cd\u590d\u4eba\u8bbe \u2014 \u6027\u683c\u901a\u8fc7\u884c\u52a8\u4f53\u73b0\uff0c\u4e0d\u9700\u8981\u65c1\u767d\u70b9\u8bc4`,
    `\u274c \u7981\u6b62\u7528\u201c\u5fc3\u5982\u5200\u5272/\u5fc3\u5982\u6b7b\u7070/\u4e94\u5473\u6742\u9648\u201d\u7b49\u56db\u5b57\u6210\u8bed \u2014 \u7528\u72ec\u521b\u7684\u8eab\u4f53\u611f\u53d7\u66ff\u4ee3`,
  ],
];

/**
 * W14: 根据块内样本的综合风格画像，生成块级创作指令
 *
 * 关键区别：
 * - 旧方案：每个 snippet 重复贴同一套 4 条规则（提示疲劳）
 * - 新方案：每个块只出一次综合指令，内容根据该块样本特征动态生成
 */
function buildBlockDirective(profiles: SnippetStyleProfile[], blockIndex: number): string {
  // 统计该块内的主导类型分布
  let totalDialogue = 0;
  let totalSensory = 0;
  let totalAction = 0;
  let totalPsych = 0;
  let staccatoCount = 0;
  let flowingCount = 0;

  for (const p of profiles) {
    totalDialogue += p.dialogueDensity;
    totalSensory += p.sensoryDensity;
    totalAction += p.actionDensity;
    totalPsych += p.psychDensity;
    if (p.rhythmType === "staccato") staccatoCount++;
    if (p.rhythmType === "flowing") flowingCount++;
  }
  const n = Math.max(profiles.length, 1);

  // 选择 2-3 条最相关的创作指令
  const directives: string[] = [];

  // 核心指令：Show Don't Tell（始终保留，但措辞根据场景微调）
  if (totalSensory / n > 0.5 || totalPsych / n > 0.5) {
    directives.push("\u2705 **Show, Don't Tell**\uff1a\u901a\u8fc7\u611f\u5b98\u7ec6\u8282\uff08\u6c14\u5473\u3001\u6e29\u5ea6\u3001\u89e6\u611f\u3001\u5149\u5f71\u53d8\u5316\uff09\u6620\u5c04\u4eba\u7269\u5185\u5fc3\uff0c\u7981\u6b62\u201c\u4ed6\u611f\u5230\u60b2\u4f24/\u5f00\u5fc3/\u7d27\u5f20\u201d\u5f0f\u76f4\u767d\u9648\u8ff0");
  }

  // 节奏指令：根据块内主流节奏选择
  if (staccatoCount > flowingCount) {
    directives.push("\u2705 **\u7d27\u51d1\u8282\u594f**\uff1a\u6a21\u4eff\u6837\u672c\u4e2d\u77ed\u53e5\u5bc6\u96c6\u8f70\u51fb\u7684\u8282\u594f\u611f\uff0c\u7528\u65ad\u53e5\u5236\u9020\u538b\u8feb\u611f\u548c\u901f\u5ea6\u611f");
  } else if (flowingCount > staccatoCount) {
    directives.push("\u2705 **\u547c\u5438\u8282\u594f**\uff1a\u6a21\u4eff\u6837\u672c\u4e2d\u957f\u53e5\u7684\u8212\u5c55\u94fa\u6392\uff0c\u5229\u7528\u9017\u53f7\u548c\u5206\u53e5\u5236\u9020\u7ef5\u5ef6\u611f\u3001\u6c89\u6d78\u611f");
  } else {
    directives.push("\u2705 **\u8282\u594f\u4ea4\u66ff**\uff1a\u6a21\u4eff\u6837\u672c\u4e2d\u957f\u77ed\u53e5\u7684\u4ea4\u66ff\u547c\u5438\u2014\u2014\u77ed\u53e5\u5236\u9020\u7d27\u8feb\uff0c\u957f\u53e5\u91ca\u653e\u538b\u529b");
  }

  // 场景特异指令
  if (totalDialogue / n > 0.5) {
    directives.push("\u2705 **\u5bf9\u767d\u827a\u672f**\uff1a\u6bcf\u4e2a\u89d2\u8272\u7684\u7528\u8bcd\u3001\u65ad\u53e5\u3001\u53e3\u7656\u5fc5\u987b\u6709\u8fa8\u8bc6\u5ea6\u5dee\u5f02\uff0c\u5bf9\u8bdd\u8981\u6709\u6f5c\u53f0\u8bcd\u5c42");
  }
  if (totalAction / n > 0.8) {
    directives.push("\u2705 **\u52a8\u8bcd\u7cbe\u5ea6**\uff1a\u52a8\u4f5c\u63cf\u5199\u7528\u7cbe\u786e\u7684\u5355\u4e00\u52a8\u8bcd\uff08\u201c\u6518\u201d\u800c\u975e\u201c\u7d27\u7d27\u63e1\u4f4f\u201d\uff09\uff0c\u4e00\u4e2a\u52a8\u4f5c\u4e00\u4e2a\u753b\u9762");
  }
  if (totalPsych / n > 0.6) {
    directives.push("\u2705 **\u5185\u5fc3\u5916\u5316**\uff1a\u5fc3\u7406\u6d3b\u52a8\u5fc5\u987b\u901a\u8fc7\u5916\u90e8\u884c\u4e3a/\u611f\u5b98\u788e\u7247\u5448\u73b0\uff08\u6518\u7d27\u7684\u624b\u3001\u79fb\u5f00\u7684\u89c6\u7ebf\uff09\uff0c\u4e0d\u8981\u5199\u201c\u4ed6\u5fc3\u60f3/\u4ed6\u89c9\u5f97\u201d");
  }

  // 限制到 3 条，避免指令过多
  const selectedDirectives = directives.slice(0, 3);

  // 反例注入（每个块用不同组，避免重复）
  const antiPatternGroup = AI_WRITING_ANTIPATTERNS[blockIndex % AI_WRITING_ANTIPATTERNS.length];

  const selfCheck = [
    "[\u2705 \u751f\u6210\u540e\u81ea\u68c0 (\u5fc5\u987b)]",
    "- \u662f\u5426\u5f53\u524d\u4e2d\u6709\u201c\u7a7a\u6c14\u4eff\u4f5b\u51dd\u56fa\u4e86\u201d (\u5982\u679c\u6709\uff0c\u5220\u9664\u5e76\u7528\u5177\u4f53\u611f\u5b98\u66ff\u4ee3)",
    "- \u662f\u5426\u6bcf\u6bb5\u90fd\u4ee5\u201c\u4ed6/\u5979\u201d\u5f00\u5934 (\u5982\u679c\u6709\uff0c\u6539\u6210\u73af\u5883/\u611f\u5b98/\u52a8\u4f5c\u8d77\u5934\u5236\u9020\u53d8\u5316)",
    "- \u662f\u5426\u5f53\u524d\u4e2d\u6709\u201c\u67d0\u79cd\u8bf4\u4e0d\u6e05\u9053\u4e0d\u660e\u7684\u60c5\u611b\u201d (\u5982\u679c\u6709\uff0c\u5c31\u7528\u5177\u4f53\u7684\u8eab\u4f53\u611f\u53d7\u66ff\u4ee3)",
  ].join("\n");

  return [
    `[\ud83d\udcdd \u672c\u7ec4\u5199\u4f5c\u8981\u9886]`,
    ...selectedDirectives,
    ``,
    `[ \u26a0\ufe0f AI \u5e38\u89c1\u5199\u6cd5\u9677\u9631 \u2014 \u5fc5\u987b\u89c4\u907f]`,
    ...antiPatternGroup,
    ``,
    selfCheck,
  ].join("\n");
}

/**
 * 格式化搜索结果为 Markdown（用于注入 system prompt）
 *
 * W13 升级：每个 snippet 根据文本特征生成差异化引导语，
 * 取代之前每段重复的固定 [高级写作指令]。
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
    // W13: 智能风格分析 + 差异化引导语
    const profile = analyzeSnippetStyle(snippet.text);
    const guidance = buildSnippetGuidance(profile, snippet.matchedTerms);

    const header = `\ud83d\udcd6 [${snippet.fileName}${snippet.chapterHint ? ` / ${snippet.chapterHint}` : ""}] (\u8bc4\u5206:${snippet.score})`;
    const entry = `${header}\n${guidance}\n${snippet.text}`;

    if (totalChars + entry.length > maxTotalChars) {
      // 截断到句子边界
      const remaining = maxTotalChars - totalChars - header.length - guidance.length - 10;
      if (remaining > 100) {
        const truncated = snippet.text.substring(0, remaining);
        const lastSentence = Math.max(
          truncated.lastIndexOf("\u3002"),
          truncated.lastIndexOf("\uff01"),
          truncated.lastIndexOf("\uff1f"),
          truncated.lastIndexOf("\n"),
        );
        const cutText = lastSentence > remaining * 0.5
          ? truncated.substring(0, lastSentence + 1) + "\u2026"
          : truncated + "\u2026";
        parts.push(`${header}\n${guidance}\n${cutText}`);
      }
      break;
    }

    parts.push(entry);
    totalChars += entry.length;
  }

  return parts.join("\n---\n");
}

/**
 * 格式化搜索结果为分块 Markdown（用于分散注入 system prompt 不同位置）
 *
 * W13+W14 升级：
 * - 每个 snippet 已带差异化引导语（来自 formatNovelSnippetsForPrompt）
 * - 每个块额外注入块级综合创作指令（动态生成，非重复模板）
 * - 每个块注入不同的 AI 写作陷阱反例（杀掉重复感）
 */
export function formatNovelSnippetsForPromptBlocks(
  result: NovelSearchResult,
  options?: {
    maxTotalChars?: number;
    blocks?: number;
  },
): string[] {
  if (result.snippets.length === 0) return [];

  const maxTotalChars = options?.maxTotalChars ?? 5000;
  const blocks = Math.min(6, Math.max(1, options?.blocks ?? 3));

  const all = formatNovelSnippetsForPrompt(result, maxTotalChars);
  if (!all) return [];

  const entries = all.split("\n---\n").map(s => s.trim()).filter(Boolean);
  if (entries.length === 0) return [];

  // 为每个 snippet 分析风格画像（用于块级指令生成）
  const snippetProfiles = result.snippets.slice(0, entries.length).map(s => analyzeSnippetStyle(s.text));

  // Round-robin 分配，确保高分样本分散到不同块里，减少“把最强样本都塞在 A 块”的偏置。
  const buckets: Array<{ entries: string[]; profiles: SnippetStyleProfile[] }> = Array.from(
    { length: blocks },
    () => ({ entries: [], profiles: [] }),
  );
  for (let i = 0; i < entries.length; i++) {
    const bucketIdx = i % blocks;
    buckets[bucketIdx]!.entries.push(entries[i]!);
    buckets[bucketIdx]!.profiles.push(snippetProfiles[i]!);
  }

  const blockParts: string[] = [];
  for (let blockIdx = 0; blockIdx < buckets.length; blockIdx++) {
    const bucket = buckets[blockIdx]!;
    if (bucket.entries.length === 0) continue;
    const directive = buildBlockDirective(bucket.profiles, blockIdx);
    blockParts.push(`${directive}\n\n${bucket.entries.join("\n---\n")}`);
  }
  return blockParts;
}
