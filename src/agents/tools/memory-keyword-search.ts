import * as path from "node:path";
import { tokenizeQuery, readFileWithCache } from "../../memory/local-search.js";

export interface KeywordSearchResult {
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  text: string;
}

const CONTEXT_LINES = 5;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const TITLE_BONUS = 0.15;

/**
 * Keyword-based search for memory files with CJK support.
 * Used as fallback when embedding API is unavailable.
 * Supports recursive directory traversal, .md + .txt files,
 * ±5 lines context, title weighting, and adjacent window merging.
 */
export async function keywordSearch(params: {
  query: string;
  memoryDir: string;
  maxResults?: number;
  /** 预收集的文件列表（避免重复遍历目录） */
  files?: string[];
}): Promise<KeywordSearchResult[]> {
  const keywords = tokenizeQuery(params.query);
  if (keywords.length === 0) return [];

  const results: KeywordSearchResult[] = [];

  try {
    // 复用 local-search 的目录遍历缓存（如果调用方未提供文件列表）
    const files = params.files ?? await (async () => {
      const { default: fs } = await import("node:fs/promises");
      const collected: string[] = [];
      async function collect(dir: string): Promise<void> {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
              await collect(full);
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (ext === ".md" || ext === ".txt") collected.push(full);
            }
          }
        } catch { /* 目录不存在 */ }
      }
      await collect(params.memoryDir);
      return collected;
    })();

    for (const filePath of files) {
      try {
        // 复用 local-search 的文件缓存（mtime+size 校验，避免重复磁盘 I/O）
        const cached = await readFileWithCache(filePath, MAX_FILE_SIZE);
        if (!cached) continue;

        const lines = cached.lines;
        const relPath = path.relative(params.memoryDir, filePath).replace(/\\/g, "/");

        // 找到所有匹配行
        const matchedLines: Array<{
          index: number;
          matchCount: number;
          isTitle: boolean;
        }> = [];

        for (let i = 0; i < lines.length; i++) {
          const lineLower = lines[i].toLowerCase();
          let matchCount = 0;
          for (const kw of keywords) {
            if (lineLower.includes(kw.toLowerCase())) matchCount++;
          }
          if (matchCount > 0) {
            const isTitle = /^\s*#{1,6}\s/.test(lines[i]);
            matchedLines.push({ index: i, matchCount, isTitle });
          }
        }

        if (matchedLines.length === 0) continue;

        // 合并相邻匹配行的上下文窗口
        const windows: Array<{
          start: number;
          end: number;
          totalMatches: number;
          hasTitle: boolean;
        }> = [];

        for (const match of matchedLines) {
          const start = Math.max(0, match.index - CONTEXT_LINES);
          const end = Math.min(lines.length - 1, match.index + CONTEXT_LINES);
          const last = windows[windows.length - 1];

          if (last && start <= last.end + 1) {
            last.end = Math.max(last.end, end);
            last.totalMatches += match.matchCount;
            if (match.isTitle) last.hasTitle = true;
          } else {
            windows.push({
              start,
              end,
              totalMatches: match.matchCount,
              hasTitle: match.isTitle,
            });
          }
        }

        for (const window of windows) {
          const snippet = lines.slice(window.start, window.end + 1).join("\n");
          const matchRatio = Math.min(1, window.totalMatches / keywords.length);
          const score = Math.min(1, matchRatio + (window.hasTitle ? TITLE_BONUS : 0));

          results.push({
            path: relPath,
            lineStart: window.start + 1,
            lineEnd: window.end + 1,
            score,
            text: snippet,
          });
        }
      } catch {
        continue;
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, params.maxResults ?? 10);
  } catch (err) {
    console.error("Keyword search failed:", err);
    return [];
  }
}
