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
