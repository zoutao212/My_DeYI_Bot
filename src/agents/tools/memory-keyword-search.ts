import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface KeywordSearchResult {
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  text: string;
}

const CONTEXT_LINES = 5;
const SUPPORTED_EXTENSIONS = [".md", ".txt"];
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const TITLE_BONUS = 0.15;

/**
 * 智能分词：支持中英文混合
 */
function tokenizeKeywords(query: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  // 英文/数字 token
  const alphaMatches = query.match(/[A-Za-z0-9_]+/gi) ?? [];
  for (const t of alphaMatches) {
    const lower = t.toLowerCase();
    if (lower.length >= 2 && !seen.has(lower)) {
      seen.add(lower);
      tokens.push(lower);
    }
  }

  // CJK 连续片段（2字及以上）+ bigram
  const cjkMatches = query.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g) ?? [];
  for (const segment of cjkMatches) {
    if (segment.length < 2) continue;
    if (!seen.has(segment)) {
      seen.add(segment);
      tokens.push(segment);
    }
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

/**
 * 递归收集目录中的记忆文件
 */
async function collectFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        result.push(...(await collectFiles(full)));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          result.push(full);
        }
      }
    }
  } catch {
    // 目录不存在或无权限
  }
  return result;
}

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
}): Promise<KeywordSearchResult[]> {
  const keywords = tokenizeKeywords(params.query);
  if (keywords.length === 0) return [];

  const results: KeywordSearchResult[] = [];

  try {
    const files = await collectFiles(params.memoryDir);

    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;

        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n");
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
