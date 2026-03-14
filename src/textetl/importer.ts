import fs from "node:fs/promises";
import path from "node:path";

import type { TextEtlImportResult } from "./types.js";
import { splitChaptersFromTxt } from "./splitter.js";
import { buildBookId, writeBookArtifacts } from "./writer.js";

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  return fallback;
}

export async function importNovelTxtToTextEtl(params: {
  workspaceDir: string;
  inputAbsPath: string;
  bookTitle?: string;
  outputRootDir?: string;
  storageMode?: "files" | "jsonl" | "both";
}): Promise<TextEtlImportResult> {
  const stat = await fs.stat(params.inputAbsPath);
  if (!stat.isFile()) {
    throw new Error(`输入不是文件: ${params.inputAbsPath}`);
  }

  const raw = await fs.readFile(params.inputAbsPath, "utf-8");
  const content = raw.replace(/\r\n/g, "\n");

  const inferredTitle = params.bookTitle?.trim() || path.basename(params.inputAbsPath, path.extname(params.inputAbsPath));
  const bookId = buildBookId({
    inputAbsPath: params.inputAbsPath,
    bookTitle: inferredTitle,
    stat,
  });

  // TextETL 两级切片参数（可用环境变量覆盖）
  // - 宏切片：先切到 targetChunkChars（默认 3000）
  // - 微切片：再切到 microChunkChars（默认 300，默认开启）
  const targetChunkChars = Math.max(800, readIntEnv("CLAWDBOT_TEXTETL_TARGET_CHUNK_CHARS", 3000));
  const maxChapterChars = Math.max(1200, readIntEnv("CLAWDBOT_TEXTETL_MAX_CHAPTER_CHARS", 6000));
  const enableMicroChunks = readBoolEnv("CLAWDBOT_TEXTETL_ENABLE_MICRO_CHUNKS", true);
  const microChunkChars = Math.max(120, readIntEnv("CLAWDBOT_TEXTETL_MICRO_CHUNK_CHARS", 300));

  const chapters = splitChaptersFromTxt({
    content,
    minChapterChars: 900,
    maxChapterChars,
    targetChunkChars,
    enableMicroChunks,
    microChunkChars,
  });

  const { outputDir } = await writeBookArtifacts({
    workspaceDir: params.workspaceDir,
    outputRootDir: params.outputRootDir,
    storageMode: params.storageMode,
    bookId,
    bookTitle: inferredTitle,
    inputAbsPath: params.inputAbsPath,
    stat: { size: stat.size, mtimeMs: stat.mtimeMs },
    chapters,
  });

  const totalChars = chapters.reduce((sum, ch) => sum + ch.charCount, 0);

  return {
    bookId,
    bookTitle: inferredTitle,
    inputPath: params.inputAbsPath,
    outputDir,
    chaptersWritten: chapters.length,
    totalChars,
  };
}

async function walkTxtFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkTxtFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase().endsWith(".txt")) results.push(full);
  }
  return results;
}

export async function importNovelTxtPathToTextEtl(params: {
  workspaceDir: string;
  inputAbsPath: string;
  outputRootDir?: string;
  storageMode?: "files" | "jsonl" | "both";
}): Promise<{ imported: TextEtlImportResult[]; skipped: number }> {
  const stat = await fs.stat(params.inputAbsPath);
  if (stat.isFile()) {
    const one = await importNovelTxtToTextEtl({
      workspaceDir: params.workspaceDir,
      inputAbsPath: params.inputAbsPath,
      outputRootDir: params.outputRootDir,
      storageMode: params.storageMode,
    });
    return { imported: [one], skipped: 0 };
  }
  if (!stat.isDirectory()) {
    throw new Error(`输入不是文件或目录: ${params.inputAbsPath}`);
  }

  const files = await walkTxtFiles(params.inputAbsPath);
  const imported: TextEtlImportResult[] = [];
  let skipped = 0;

  for (const abs of files) {
    try {
      imported.push(
        await importNovelTxtToTextEtl({
          workspaceDir: params.workspaceDir,
          inputAbsPath: abs,
          outputRootDir: params.outputRootDir,
          storageMode: params.storageMode,
        }),
      );
    } catch {
      skipped += 1;
    }
  }

  return { imported, skipped };
}
