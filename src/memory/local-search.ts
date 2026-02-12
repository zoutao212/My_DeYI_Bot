/**
 * 本地快速文本搜索（零外部依赖）
 *
 * 类 ripgrep 的本地检索能力，作为向量搜索的并行通道和离线兜底。
 * 纯 Node.js fs + 字符串操作，不依赖任何 API。
 *
 * @module memory/local-search
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { extractSearchTerms } from "./keyword-extractor.js";

// ─── 类型定义 ───────────────────────────────────────────────

export interface LocalSearchOptions {
  /** 搜索目录列表（绝对路径） */
  dirs: string[];
  /** 文件扩展名过滤（默认 [".md", ".txt"]） */
  extensions?: string[];
  /** 是否递归搜索（默认 true） */
  recursive?: boolean;
  /** 上下文行数（默认 5） */
  contextLines?: number;
  /** 最大结果数（默认 20） */
  maxResults?: number;
  /** 最大文件大小（字节，默认 1MB，跳过超大文件） */
  maxFileSize?: number;
  /** 工作区根目录（用于生成相对路径） */
  workspaceDir?: string;
}

export interface LocalSearchResult {
  /** 文件相对路径（相对于 workspaceDir） */
  path: string;
  /** 绝对路径 */
  absPath: string;
  /** 起始行（1-indexed） */
  startLine: number;
  /** 结束行（1-indexed） */
  endLine: number;
  /** 归一化分数 0-1 */
  score: number;
  /** 上下文片段 */
  snippet: string;
  /** 来源标识 */
  source: "grep";
}

// ─── 常量 ──────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = [".md", ".txt"];
const DEFAULT_CONTEXT_LINES = 5;
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1MB
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const TITLE_WEIGHT_BONUS = 0.15; // 标题行额外加权

// ─── 文件缓存 ─────────────────────────────────────────────

interface CachedFile {
  content: string;
  lines: string[];
  hash: string;
  cachedAt: number;
  size: number;
}

const fileCache = new Map<string, CachedFile>();

function clearExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of fileCache) {
    if (now - entry.cachedAt > CACHE_TTL_MS) {
      fileCache.delete(key);
    }
  }
}

/** 手动使指定文件的缓存失效 */
export function invalidateFileCache(absPath: string): void {
  fileCache.delete(absPath);
}

/** 清空全部缓存 */
export function clearFileCache(): void {
  fileCache.clear();
}

async function readFileWithCache(absPath: string, maxSize: number): Promise<CachedFile | null> {
  // 先检查缓存
  const cached = fileCache.get(absPath);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size > maxSize || stat.size === 0) return null;

    const content = await fs.readFile(absPath, "utf-8");
    const hash = createHash("md5").update(content).digest("hex");

    // 如果缓存中有且 hash 没变，只更新时间戳
    if (cached && cached.hash === hash) {
      cached.cachedAt = Date.now();
      return cached;
    }

    const lines = content.split("\n");
    const entry: CachedFile = {
      content,
      lines,
      hash,
      cachedAt: Date.now(),
      size: stat.size,
    };
    fileCache.set(absPath, entry);
    return entry;
  } catch {
    return null;
  }
}

// ─── 分词 ─────────────────────────────────────────────────

/**
 * 智能分词：支持中英文混合
 * - 英文按空格/标点分词
 * - 中文按连续字符保持完整（2字及以上作为搜索词）
 * - 去重 + 过滤短 token
 */
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  // 提取英文/数字 token
  const alphaMatches = query.match(/[A-Za-z0-9_]+/gi) ?? [];
  for (const t of alphaMatches) {
    const lower = t.toLowerCase();
    if (lower.length >= 2 && !seen.has(lower)) {
      seen.add(lower);
      tokens.push(lower);
    }
  }

  // 提取 CJK 连续片段，按 bigram 切分提高召回率
  const cjkMatches = query.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g) ?? [];
  for (const segment of cjkMatches) {
    if (segment.length < 2) continue;
    // 完整片段
    if (!seen.has(segment)) {
      seen.add(segment);
      tokens.push(segment);
    }
    // 长于 2 字的片段额外生成 bigram（2 字滑动窗口）提高部分匹配召回
    if (segment.length > 2) {
      for (let i = 0; i <= segment.length - 2; i++) {
        const bigram = segment.substring(i, i + 2);
        if (!seen.has(bigram)) {
          seen.add(bigram);
          tokens.push(bigram);
        }
      }
    }
  }

  return tokens;
}

// ─── 文件遍历 ──────────────────────────────────────────────

async function walkDirectory(
  dir: string,
  extensions: string[],
  recursive: boolean,
): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          results.push(fullPath);
        }
      } else if (entry.isDirectory() && recursive) {
        // 跳过隐藏目录和常见无用目录
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const subFiles = await walkDirectory(fullPath, extensions, recursive);
        results.push(...subFiles);
      }
    }
  } catch {
    // 目录不存在或无权限，静默跳过
  }
  return results;
}

// ─── 核心搜索 ──────────────────────────────────────────────

interface LineMatch {
  lineIndex: number; // 0-indexed
  matchCount: number;
  isTitle: boolean;
}

function searchInLines(lines: string[], tokens: string[]): LineMatch[] {
  const matches: LineMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let matchCount = 0;
    for (const token of tokens) {
      if (lineLower.includes(token.toLowerCase())) {
        matchCount++;
      }
    }
    if (matchCount > 0) {
      const isTitle = /^\s*#{1,6}\s/.test(lines[i]);
      matches.push({ lineIndex: i, matchCount, isTitle });
    }
  }
  return matches;
}

/**
 * 将相邻的匹配行合并为上下文窗口，避免重叠片段
 */
function mergeMatchWindows(
  matches: LineMatch[],
  totalLines: number,
  contextLines: number,
): Array<{ start: number; end: number; totalMatches: number; hasTitle: boolean }> {
  if (matches.length === 0) return [];

  const windows: Array<{
    start: number;
    end: number;
    totalMatches: number;
    hasTitle: boolean;
  }> = [];

  for (const match of matches) {
    const start = Math.max(0, match.lineIndex - contextLines);
    const end = Math.min(totalLines - 1, match.lineIndex + contextLines);

    const lastWindow = windows[windows.length - 1];
    if (lastWindow && start <= lastWindow.end + 1) {
      // 合并相邻窗口
      lastWindow.end = Math.max(lastWindow.end, end);
      lastWindow.totalMatches += match.matchCount;
      if (match.isTitle) lastWindow.hasTitle = true;
    } else {
      windows.push({
        start,
        end,
        totalMatches: match.matchCount,
        hasTitle: match.isTitle,
      });
    }
  }

  return windows;
}

// ─── 公共 API ──────────────────────────────────────────────

/**
 * 本地快速文本搜索
 *
 * 类 ripgrep 实现：遍历指定目录，逐行扫描关键词，返回带上下文的匹配结果。
 * 零远程依赖，延迟 <50ms（热缓存）。
 */
export async function localGrepSearch(
  query: string,
  options: LocalSearchOptions,
): Promise<LocalSearchResult[]> {
  // 定期清理过期缓存
  clearExpiredCache();

  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const recursive = options.recursive ?? true;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const workspaceDir = options.workspaceDir;

  // 收集所有待搜索文件
  const allFiles: string[] = [];
  for (const dir of options.dirs) {
    const files = await walkDirectory(dir, extensions, recursive);
    allFiles.push(...files);
  }

  // 搜索每个文件
  const allResults: LocalSearchResult[] = [];

  for (const absPath of allFiles) {
    const cached = await readFileWithCache(absPath, maxFileSize);
    if (!cached) continue;

    const matches = searchInLines(cached.lines, tokens);
    if (matches.length === 0) continue;

    const windows = mergeMatchWindows(matches, cached.lines.length, contextLines);

    for (const window of windows) {
      const snippet = cached.lines.slice(window.start, window.end + 1).join("\n");
      // 归一化分数：匹配率 × (1 + 标题加权)
      const matchRatio = Math.min(1, window.totalMatches / tokens.length);
      const titleBonus = window.hasTitle ? TITLE_WEIGHT_BONUS : 0;
      const score = Math.min(1, matchRatio + titleBonus);

      const relPath = workspaceDir
        ? path.relative(workspaceDir, absPath).replace(/\\/g, "/")
        : path.basename(absPath);

      allResults.push({
        path: relPath,
        absPath,
        startLine: window.start + 1, // 1-indexed
        endLine: window.end + 1,
        score,
        snippet,
        source: "grep",
      });
    }
  }

  // 按分数降序排序，截断到 maxResults
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, maxResults);
}

// ─── 深度搜索（关键词抽取驱动）─────────────────────────────

export interface DeepSearchOptions extends LocalSearchOptions {
  /** 是否从查询中自动提取关键词扩展搜索（默认 true） */
  autoExtractKeywords?: boolean;
  /** 自动提取的关键词最大数量（默认 15） */
  maxExtractedTerms?: number;
  /** 额外的搜索关键词（手动指定） */
  extraTerms?: string[];
  /** 支持 .json / .jsonl 文件（默认 false） */
  includeJson?: boolean;
}

export interface DeepSearchResult extends LocalSearchResult {
  /** 匹配到的关键词列表 */
  matchedTerms: string[];
  /** 文件总行数 */
  fileTotalLines?: number;
}

/**
 * 深度搜索：从大段文本/查询中自动提取关键词，并行在多层级目录中全面检索
 *
 * 与 localGrepSearch 的区别：
 * - 自动从查询中提取高价值关键词（TF-IDF），扩展搜索面
 * - 返回每个结果匹配到的具体关键词
 * - 支持 .json/.jsonl 文件
 * - 分数算法更精细（考虑关键词覆盖率 + 密度）
 */
export async function deepGrepSearch(
  query: string,
  options: DeepSearchOptions,
): Promise<DeepSearchResult[]> {
  clearExpiredCache();

  const autoExtract = options.autoExtractKeywords ?? true;
  const maxExtracted = options.maxExtractedTerms ?? 15;
  const extraTerms = options.extraTerms ?? [];
  const includeJson = options.includeJson ?? false;

  // Step 1: 基础分词
  const baseTokens = tokenizeQuery(query);

  // Step 2: 自动关键词抽取（对长查询特别有效）
  let expandedTokens: string[] = [...baseTokens];
  if (autoExtract && query.length > 50) {
    const extracted = extractSearchTerms(query, maxExtracted);
    for (const term of extracted) {
      const lower = term.toLowerCase();
      if (!expandedTokens.includes(lower)) {
        expandedTokens.push(lower);
      }
    }
  }

  // Step 3: 合并额外关键词
  for (const term of extraTerms) {
    const lower = term.toLowerCase();
    if (!expandedTokens.includes(lower)) {
      expandedTokens.push(lower);
    }
  }

  if (expandedTokens.length === 0) return [];

  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const allExtensions = includeJson
    ? [...new Set([...extensions, ".json", ".jsonl"])]
    : extensions;
  const recursive = options.recursive ?? true;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const workspaceDir = options.workspaceDir;

  // Step 4: 并行收集所有目录的文件
  const fileListPromises = options.dirs.map(dir =>
    walkDirectory(dir, allExtensions, recursive),
  );
  const fileLists = await Promise.all(fileListPromises);
  const allFiles = fileLists.flat();

  // Step 5: 并行搜索所有文件（分批避免打开过多文件句柄）
  const BATCH_SIZE = 50;
  const allResults: DeepSearchResult[] = [];

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(absPath => searchFileDeep(absPath, expandedTokens, contextLines, maxFileSize, workspaceDir)),
    );
    for (const results of batchResults) {
      allResults.push(...results);
    }
  }

  // Step 6: 按分数排序 + 截断
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, maxResults);
}

/**
 * 对单个文件执行深度搜索，返回匹配结果
 */
async function searchFileDeep(
  absPath: string,
  tokens: string[],
  contextLines: number,
  maxFileSize: number,
  workspaceDir?: string,
): Promise<DeepSearchResult[]> {
  const cached = await readFileWithCache(absPath, maxFileSize);
  if (!cached) return [];

  const matches = searchInLines(cached.lines, tokens);
  if (matches.length === 0) return [];

  const windows = mergeMatchWindows(matches, cached.lines.length, contextLines);
  const results: DeepSearchResult[] = [];

  for (const window of windows) {
    const snippet = cached.lines.slice(window.start, window.end + 1).join("\n");

    // 精确记录匹配到了哪些关键词
    const snippetLower = snippet.toLowerCase();
    const matchedTerms = tokens.filter(t => snippetLower.includes(t.toLowerCase()));

    // 综合分数：覆盖率(匹配词数/总词数) × 密度(匹配行数/窗口行数) + 标题加权
    const coverage = matchedTerms.length / tokens.length;
    const windowSize = window.end - window.start + 1;
    const density = Math.min(1, window.totalMatches / windowSize);
    const titleBonus = window.hasTitle ? TITLE_WEIGHT_BONUS : 0;
    const score = Math.min(1, coverage * 0.6 + density * 0.3 + titleBonus + 0.1);

    const relPath = workspaceDir
      ? path.relative(workspaceDir, absPath).replace(/\\/g, "/")
      : path.basename(absPath);

    results.push({
      path: relPath,
      absPath,
      startLine: window.start + 1,
      endLine: window.end + 1,
      score,
      snippet,
      source: "grep",
      matchedTerms,
      fileTotalLines: cached.lines.length,
    });
  }

  return results;
}

// ─── 批量搜索 ───────────────────────────────────────────────

export interface BatchSearchQuery {
  /** 查询标识（用于关联结果） */
  id: string;
  /** 查询文本 */
  query: string;
  /** 每个查询的最大结果数（默认 5） */
  maxResults?: number;
}

export interface BatchSearchResult {
  id: string;
  results: LocalSearchResult[];
}

/**
 * 批量搜索：一次性对多个查询在相同目录集执行搜索
 *
 * 优化：共享文件缓存，只遍历一次目录树
 */
export async function batchGrepSearch(
  queries: BatchSearchQuery[],
  options: LocalSearchOptions,
): Promise<BatchSearchResult[]> {
  clearExpiredCache();

  if (queries.length === 0) return [];

  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const recursive = options.recursive ?? true;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const workspaceDir = options.workspaceDir;

  // 只遍历一次目录树
  const allFiles: string[] = [];
  for (const dir of options.dirs) {
    const files = await walkDirectory(dir, extensions, recursive);
    allFiles.push(...files);
  }

  // 预加载所有文件到缓存
  const loadPromises = allFiles.map(f => readFileWithCache(f, maxFileSize));
  await Promise.all(loadPromises);

  // 对每个查询复用缓存执行搜索
  const batchResults: BatchSearchResult[] = [];
  for (const q of queries) {
    const tokens = tokenizeQuery(q.query);
    if (tokens.length === 0) {
      batchResults.push({ id: q.id, results: [] });
      continue;
    }

    const maxR = q.maxResults ?? 5;
    const queryResults: LocalSearchResult[] = [];

    for (const absPath of allFiles) {
      const cached = fileCache.get(absPath);
      if (!cached) continue;

      const matches = searchInLines(cached.lines, tokens);
      if (matches.length === 0) continue;

      const windows = mergeMatchWindows(matches, cached.lines.length, contextLines);
      for (const window of windows) {
        const snippet = cached.lines.slice(window.start, window.end + 1).join("\n");
        const matchRatio = Math.min(1, window.totalMatches / tokens.length);
        const titleBonus = window.hasTitle ? TITLE_WEIGHT_BONUS : 0;
        const score = Math.min(1, matchRatio + titleBonus);
        const relPath = workspaceDir
          ? path.relative(workspaceDir, absPath).replace(/\\/g, "/")
          : path.basename(absPath);

        queryResults.push({
          path: relPath,
          absPath,
          startLine: window.start + 1,
          endLine: window.end + 1,
          score,
          snippet,
          source: "grep",
        });
      }
    }

    queryResults.sort((a, b) => b.score - a.score);
    batchResults.push({ id: q.id, results: queryResults.slice(0, maxR) });
  }

  return batchResults;
}

// ─── 文件树索引 ─────────────────────────────────────────────

export interface MemoryFileInfo {
  /** 相对路径 */
  path: string;
  /** 绝对路径 */
  absPath: string;
  /** 文件大小（字节） */
  size: number;
  /** 最后修改时间 */
  modifiedAt: number;
  /** 行数（按需加载） */
  lineCount?: number;
  /** 文件类型 */
  extension: string;
}

/**
 * 列出记忆目录树中的所有文件（多层级递归）
 *
 * 用于 memory_list 工具，让 LLM 知道记忆库中有哪些文件。
 */
export async function listMemoryTree(
  dirs: string[],
  options?: {
    extensions?: string[];
    workspaceDir?: string;
    maxDepth?: number;
    includeLineCount?: boolean;
  },
): Promise<MemoryFileInfo[]> {
  const extensions = options?.extensions ?? [".md", ".txt", ".json"];
  const workspaceDir = options?.workspaceDir;
  const includeLineCount = options?.includeLineCount ?? false;
  const maxDepth = options?.maxDepth;

  const results: MemoryFileInfo[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (maxDepth !== undefined && depth > maxDepth) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!extensions.includes(ext)) continue;
          try {
            const stat = await fs.stat(fullPath);
            const relPath = workspaceDir
              ? path.relative(workspaceDir, fullPath).replace(/\\/g, "/")
              : path.basename(fullPath);
            const info: MemoryFileInfo = {
              path: relPath,
              absPath: fullPath,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
              extension: ext,
            };
            if (includeLineCount && stat.size < DEFAULT_MAX_FILE_SIZE) {
              const cached = await readFileWithCache(fullPath, DEFAULT_MAX_FILE_SIZE);
              if (cached) info.lineCount = cached.lines.length;
            }
            results.push(info);
          } catch {
            // stat 失败，跳过
          }
        } else if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          await walk(fullPath, depth + 1);
        }
      }
    } catch {
      // 目录不存在或无权限
    }
  }

  await Promise.all(dirs.map(dir => walk(dir, 0)));
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

// ─── 预设搜索目录 ───────────────────────────────────────────

/**
 * 获取标准记忆搜索目录列表
 *
 * 默认覆盖：memory/ + characters/ + MEMORY.md
 */
export function getDefaultMemoryDirs(workspaceDir: string): string[] {
  return [
    path.join(workspaceDir, "memory"),
    path.join(workspaceDir, "characters"),
    path.join(workspaceDir, "MEMORY.md"),
  ].filter(Boolean);
}

/**
 * 获取扩展记忆搜索目录列表（包含经验教训、任务产出等）
 */
export function getExtendedMemoryDirs(workspaceDir: string, projectDir?: string): string[] {
  const dirs = getDefaultMemoryDirs(workspaceDir);
  if (projectDir) {
    // 项目目录下的经验教训和记忆文件
    dirs.push(path.join(projectDir, ".kiro", "lessons-learned"));
    dirs.push(path.join(projectDir, "ProjectMemory"));
  }
  return dirs;
}
