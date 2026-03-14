import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { extractKeywords } from "../memory/keyword-extractor.js";
import { ensureDir } from "../memory/internal.js";
import type { BuildBookIdParams, ChapterSplit, TextEtlBookMetaV1 } from "./types.js";

function slugify(raw: string): string {
  const value = (raw || "").trim();
  if (!value) return "book";
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

function buildKeywordsTop(text: string): string[] {
  const raw = (text || "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const body = (lines.length > 1 ? lines.slice(1).join("\n") : raw).trim();
  const base = body || raw.trim();
  if (!base) return [];

  const stop = new Set([
    "的",
    "了",
    "我",
    "你",
    "他",
    "她",
    "它",
    "我们",
    "你们",
    "他们",
    "她们",
    "而",
    "但",
    "不过",
    "就是",
    "这个",
    "那个",
    "这样",
    "那样",
    "什么",
    "怎么",
    "以及",
    "一个",
    "没有",
    "自己",
    "时候",
    "现在",
    "今天",
    "今晚",
    "可以",
  ]);

  const terms = extractKeywords(base, { maxKeywords: 18 })
    .map((k) => String(k.term || "").trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2 && t.length <= 16)
    .filter((t) => !stop.has(t))
    .filter((t) => !/[\s]/.test(t))
    .filter((t) => !/[。，、；：!?！？…（）()【】\[\]{}<>"“”'‘’]/.test(t))
    .filter((t) => !/^(把我|各个方|个方面|方面|一下|一下她|一样|一样光芒|这么|那么|不是|不会|不能|可以|只是|还有|因为|所以)$/.test(t));

  return terms.slice(0, 10);
}

export function buildBookId(params: BuildBookIdParams): string {
  const base = `${params.inputAbsPath}::${params.bookTitle}::${params.stat.size}::${params.stat.mtimeMs}`;
  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
}

export async function writeBookArtifacts(params: {
  workspaceDir: string;
  outputRootDir?: string;
  storageMode?: "files" | "jsonl" | "both";
  bookId: string;
  bookTitle: string;
  inputAbsPath: string;
  stat: { size: number; mtimeMs: number };
  chapters: ChapterSplit[];
}): Promise<{ outputDir: string; meta: TextEtlBookMetaV1 }> {
  const outputRootDir = params.outputRootDir?.trim();
  const storageMode = params.storageMode ?? "files";
  const writeFiles = storageMode === "files" || storageMode === "both";
  const writeJsonl = storageMode === "jsonl" || storageMode === "both";
  const baseDir = outputRootDir
    ? path.join(outputRootDir, "books", params.bookId)
    : path.join(params.workspaceDir, "memory", "textetl", "books", params.bookId);
  const chaptersDir = path.join(baseDir, "chapters");
  const jsonlPath = path.join(baseDir, "chunks.jsonl");
  const indexPath = path.join(baseDir, "index.json");
  ensureDir(baseDir);

  try {
    await fs.rm(chaptersDir, { recursive: true, force: true });
  } catch {
  }
  try {
    await fs.rm(path.join(baseDir, "_meta.json"), { force: true });
  } catch {
  }
  try {
    await fs.rm(jsonlPath, { force: true });
  } catch {
  }
  try {
    await fs.rm(indexPath, { force: true });
  } catch {
  }

  if (writeFiles) {
    ensureDir(chaptersDir);
  }

  const chapterEntries: TextEtlBookMetaV1["chapters"] = [];

  const jsonlLines: string[] = [];
  const invertedIndex = new Map<string, Set<number>>();

  for (const ch of params.chapters) {
    const safeTitle = slugify(ch.title);

    if (writeFiles) {
      const fileName = `${String(ch.index).padStart(3, "0")}_${safeTitle}.md`;
      const rel = path.join("chapters", fileName).replace(/\\/g, "/");
      const abs = path.join(chaptersDir, fileName);

      const content = [
        `# ${params.bookTitle}`,
        "",
        `## 第${ch.index}章 ${ch.title}`,
        "",
        ch.text,
        "",
      ].join("\n");

      await fs.writeFile(abs, content, "utf-8");

      chapterEntries.push({
        index: ch.index,
        title: ch.title,
        file: rel,
        charCount: ch.charCount,
        startLine: ch.startLine,
        endLine: ch.endLine,
      });
    } else {
      // jsonl-only：用“jsonl 行号锚点”表示位置
      chapterEntries.push({
        index: ch.index,
        title: ch.title,
        file: `chunks.jsonl#${ch.index}`,
        charCount: ch.charCount,
        startLine: ch.startLine,
        endLine: ch.endLine,
      });
    }

    if (writeJsonl) {
      const keywordsTop = buildKeywordsTop(ch.text);

      for (const term of keywordsTop) {
        const key = String(term).trim();
        if (!key) continue;
        let set = invertedIndex.get(key);
        if (!set) {
          set = new Set<number>();
          invertedIndex.set(key, set);
        }
        set.add(ch.index);
      }

      jsonlLines.push(
        JSON.stringify({
          idx: ch.index,
          title: ch.title,
          startLine: ch.startLine,
          endLine: ch.endLine,
          charCount: ch.charCount,
          keywordsTop,
          text: ch.text,
        }),
      );
    }
  }

  if (writeJsonl) {
    await fs.writeFile(jsonlPath, jsonlLines.join("\n") + "\n", "utf-8");

    const indexObj: Record<string, number[]> = {};
    for (const [term, set] of invertedIndex.entries()) {
      const arr = Array.from(set.values()).sort((a, b) => a - b);
      if (arr.length > 0) indexObj[term] = arr;
    }
    await fs.writeFile(indexPath, JSON.stringify(indexObj), "utf-8");
  }

  const now = Date.now();
  const meta: TextEtlBookMetaV1 = {
    version: 1,
    bookId: params.bookId,
    title: params.bookTitle,
    input: {
      absPath: params.inputAbsPath,
      size: params.stat.size,
      mtimeMs: params.stat.mtimeMs,
    },
    createdAt: now,
    updatedAt: now,
    chapters: chapterEntries,
  };

  await fs.writeFile(path.join(baseDir, "_meta.json"), JSON.stringify(meta, null, 2), "utf-8");

  return { outputDir: baseDir, meta };
}
