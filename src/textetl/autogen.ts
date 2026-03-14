import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../memory/internal.js";
import type { NovelSnippet } from "../memory/novel-assets-searcher.js";

function safeName(raw: string): string {
  const value = (raw || "").trim();
  if (!value) return "snippet";
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
}

function buildSnippetId(params: {
  query: string;
  absPath: string;
  startLine: number;
  endLine: number;
}): string {
  const base = `${params.query}::${params.absPath}::${params.startLine}::${params.endLine}`;
  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
}

export async function materializeNovelSnippetsToChunkAssets(params: {
  chunkAssetsDir: string;
  query: string;
  snippets: NovelSnippet[];
  maxWrite?: number;
}): Promise<{ written: number; outputDir: string }> {
  const maxWrite = Math.min(30, Math.max(0, params.maxWrite ?? 8));
  const outputDir = path.join(params.chunkAssetsDir, "_autogen");
  ensureDir(outputDir);

  let written = 0;

  for (const s of params.snippets.slice(0, maxWrite)) {
    const id = buildSnippetId({
      query: params.query,
      absPath: s.absPath,
      startLine: s.startLine,
      endLine: s.endLine,
    });

    const nameHint = safeName(s.fileName || path.basename(s.absPath));
    const fileName = `${id}_${nameHint}_L${s.startLine}-${s.endLine}.md`;
    const abs = path.join(outputDir, fileName);

    try {
      await fs.access(abs);
      continue;
    } catch {
      // file not exist
    }

    const content = [
      `# 自动切片（TextETL）`,
      "",
      `- query: ${params.query}`,
      `- source: ${s.absPath}`,
      `- lines: ${s.startLine}-${s.endLine}`,
      `- score: ${s.score.toFixed(4)}`,
      s.chapterHint ? `- chapterHint: ${s.chapterHint}` : "",
      "",
      "---",
      "",
      s.text,
      "",
    ]
      .filter(Boolean)
      .join("\n");

    await fs.writeFile(abs, content, "utf-8");
    written += 1;
  }

  return { written, outputDir };
}
