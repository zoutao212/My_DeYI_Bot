import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractSearchTerms } from "../memory/keyword-extractor.js";

export type TextEtlSearchHit = {
  bookId: string;
  absPath: string;
  relPath: string;
  idx: number;
  title: string;
  keywordsTop: string[];
  text: string;
  score: number;
};

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  return fallback;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

function normalizeChunkAssetsDir(): string {
  const fromEnv = process.env.CLAWDBOT_NOVELS_CHUNK_ASSETS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(path.resolve(os.homedir(), "clawd"), "NovelsChunkAssets");
}

function scoreHit(params: {
  terms: string[];
  title: string;
  keywordsTop: string[];
  text: string;
}): number {
  let score = 0;
  const title = params.title || "";
  const keywords = params.keywordsTop || [];
  const text = params.text || "";

  for (const term of params.terms) {
    if (!term) continue;
    const inKeywords = keywords.some((k) => k === term || k.includes(term) || term.includes(k));
    const inTitle = title.includes(term);
    const inText = text.includes(term);
    if (inKeywords) score += 3;
    if (inTitle) score += 2;
    if (inText) score += 1;
  }

  if (text.length > 0) score += Math.min(1, text.length / 2000);
  return score;
}

export async function searchTextEtlBooks(query: string, options?: {
  maxResults?: number;
  maxTextChars?: number;
  maxBooksScanned?: number;
}): Promise<TextEtlSearchHit[]> {
  const enabled = readBoolEnv("CLAWDBOT_TEXTETL_FEDERATED_ENABLED", true);
  if (!enabled) return [];

  const q = (query || "").trim();
  if (!q) return [];

  const maxResults = Math.max(1, options?.maxResults ?? readIntEnv("CLAWDBOT_TEXTETL_FEDERATED_MAX_RESULTS", 6));
  const maxTextChars = Math.max(200, options?.maxTextChars ?? readIntEnv("CLAWDBOT_TEXTETL_FEDERATED_MAX_TEXT_CHARS", 900));
  const maxBooksScanned = Math.max(1, options?.maxBooksScanned ?? readIntEnv("CLAWDBOT_TEXTETL_FEDERATED_MAX_BOOKS", 80));

  const chunkAssetsDir = normalizeChunkAssetsDir();
  const booksRoot = path.join(chunkAssetsDir, "books");

  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(booksRoot, { withFileTypes: true }) as any;
  } catch {
    return [];
  }

  const terms = extractSearchTerms(q, 12)
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 12);
  if (terms.length === 0) return [];

  const hits: TextEtlSearchHit[] = [];
  const dirs = entries.filter((e: any) => e.isDirectory()).slice(0, maxBooksScanned);

  for (const e of dirs as any[]) {
    const bookId = String(e.name);
    const baseDir = path.join(booksRoot, bookId);
    const indexPath = path.join(baseDir, "index.json");
    const jsonlPath = path.join(baseDir, "chunks.jsonl");

    let indexObj: Record<string, number[]> | null = null;
    try {
      const raw = await fs.readFile(indexPath, "utf-8");
      indexObj = JSON.parse(raw);
    } catch {
      continue;
    }

    const candidate = new Set<number>();
    for (const term of terms) {
      const arr = indexObj?.[term];
      if (Array.isArray(arr)) {
        for (const n of arr) {
          if (typeof n === "number" && Number.isFinite(n)) candidate.add(n);
        }
      }
    }
    if (candidate.size === 0) continue;

    let jsonlRaw = "";
    try {
      jsonlRaw = await fs.readFile(jsonlPath, "utf-8");
    } catch {
      continue;
    }

    const lines = jsonlRaw.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = (lines[i] ?? "").trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const idx = typeof obj?.idx === "number" ? obj.idx : Number.parseInt(String(obj?.idx ?? ""), 10);
        if (!Number.isFinite(idx)) continue;
        if (!candidate.has(idx)) continue;

        const title = typeof obj?.title === "string" ? obj.title.trim() : "";
        const keywordsTop = Array.isArray(obj?.keywordsTop)
          ? obj.keywordsTop.map((x: unknown) => String(x)).filter(Boolean).slice(0, 10)
          : [];
        const text = typeof obj?.text === "string" ? obj.text.trim() : "";
        const clippedText = text.length > maxTextChars ? text.slice(0, maxTextChars).trim() : text;

        const score = scoreHit({ terms, title, keywordsTop, text: clippedText });
        const relPath = path.relative(path.resolve(os.homedir(), "clawd"), jsonlPath).replace(/\\/g, "/");
        hits.push({
          bookId,
          absPath: jsonlPath,
          relPath,
          idx,
          title,
          keywordsTop,
          text: clippedText,
          score,
        });

        if (hits.length >= maxResults * 6) break;
      } catch {
        // ignore
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxResults);
}

export function formatTextEtlHitsForMemoryContext(hits: TextEtlSearchHit[]): string {
  if (!hits || hits.length === 0) return "";
  const parts: string[] = [];
  parts.push("## 文学素材参考（TextETL）");
  parts.push("");

  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i];
    const title = h.title || `#${h.idx}`;
    const kw = h.keywordsTop?.length ? `关键词：${h.keywordsTop.join("、")}` : "";
    parts.push(`### 素材 ${i + 1}（score=${h.score.toFixed(2)}）`);
    parts.push(`**来源**: ${h.relPath} (#${h.idx})`);
    if (kw) parts.push(kw);
    parts.push("");
    parts.push(h.text);
    parts.push("");
  }

  return parts.join("\n");
}
