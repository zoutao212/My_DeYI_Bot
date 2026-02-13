/**
 * H5: 记忆生命周期管理
 *
 * 三大能力：
 * - 冲突检测：写入前检查是否有语义相似的已有条目，提醒 LLM 考虑更新而非新增
 * - 归档机制：超过 N 天未修改的记忆自动移到 memory/archive/
 * - 恢复机制：从 archive/ 恢复文件到原位置
 *
 * 零外部依赖：纯 Node.js fs + 本地搜索。
 *
 * @module memory/memory-lifecycle
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { localGrepSearch, getDefaultMemoryDirs } from "./local-search.js";

// ─── 常量 ──────────────────────────────────────────────────

/** 默认归档阈值（天数）：超过此天数未修改的文件被视为可归档 */
const DEFAULT_ARCHIVE_THRESHOLD_DAYS = 90;

/** 归档子目录名 */
const ARCHIVE_DIR_NAME = "archive";

/** 冲突检测最低分数阈值（低于此分数的结果不视为冲突） */
const CONFLICT_MIN_SCORE = 0.35;

/** 冲突检测最大结果数 */
const CONFLICT_MAX_RESULTS = 5;

// ─── 冲突检测 ──────────────────────────────────────────────

/** 冲突检测结果 */
export interface ConflictEntry {
  /** 文件相对路径 */
  path: string;
  /** 匹配分数 (0-1) */
  score: number;
  /** 匹配到的文本片段（前 200 字） */
  snippet: string;
  /** 起始行号 */
  startLine: number;
}

/**
 * 检测即将写入的内容是否与已有记忆存在语义冲突/重复
 *
 * 从 content 中提取前 150 字符 + 第一行作为查询，在记忆目录中搜索相似条目。
 * 如果找到高分匹配（score > CONFLICT_MIN_SCORE），返回冲突列表，
 * LLM 可据此决定是"更新已有"还是"新增"。
 *
 * @param content - 即将写入的新内容
 * @param workspaceDir - clawd 工作区根目录
 * @param targetPath - 目标文件绝对路径（排除自身匹配）
 */
export async function detectSimilarMemories(
  content: string,
  workspaceDir: string,
  targetPath?: string,
): Promise<ConflictEntry[]> {
  if (!content || content.length < 20) return [];

  // 提取查询文本：第一行（通常是标题）+ 前 150 字符
  const firstLine = content.split("\n")[0].replace(/^#+\s*/, "").trim();
  const preview = content.substring(0, 150).replace(/\n/g, " ").trim();
  const query = firstLine.length > 10
    ? `${firstLine} ${preview}`
    : preview;

  if (query.length < 10) return [];

  const dirs = getDefaultMemoryDirs(workspaceDir);

  try {
    const results = await localGrepSearch(query, {
      dirs,
      maxResults: CONFLICT_MAX_RESULTS + 2, // 多取几个，排除自身后截断
      contextLines: 3,
      workspaceDir,
    });

    // 过滤：排除目标文件自身 + 低分结果
    const targetNorm = targetPath ? path.normalize(targetPath) : "";
    const conflicts: ConflictEntry[] = [];

    for (const r of results) {
      if (r.score < CONFLICT_MIN_SCORE) continue;
      if (targetNorm && path.normalize(r.absPath) === targetNorm) continue;
      // 排除 archive 目录中的文件
      if (r.path.includes(`/${ARCHIVE_DIR_NAME}/`) || r.path.includes(`\\${ARCHIVE_DIR_NAME}\\`)) continue;

      conflicts.push({
        path: r.path,
        score: Math.round(r.score * 100) / 100,
        snippet: r.snippet.length > 200 ? r.snippet.substring(0, 200) + "…" : r.snippet,
        startLine: r.startLine,
      });

      if (conflicts.length >= CONFLICT_MAX_RESULTS) break;
    }

    return conflicts;
  } catch {
    // 搜索失败不阻塞写入
    return [];
  }
}

// ─── 归档机制 ──────────────────────────────────────────────

/** 归档操作结果 */
export interface ArchiveResult {
  /** 已归档的文件列表（相对路径） */
  archived: string[];
  /** 跳过的文件数（活跃/近期修改） */
  skipped: number;
  /** 归档目录 */
  archiveDir: string;
  /** 阈值天数 */
  thresholdDays: number;
}

/**
 * 归档过期记忆文件
 *
 * 扫描 memory/ 目录，将超过 thresholdDays 未修改的文件移动到 memory/archive/。
 * 保留原始目录结构（如 memory/preferences.md → memory/archive/preferences.md）。
 *
 * @param workspaceDir - clawd 工作区根目录
 * @param options - 归档选项
 */
export async function archiveStaleMemories(
  workspaceDir: string,
  options?: {
    /** 过期阈值天数（默认 90） */
    thresholdDays?: number;
    /** 是否模拟运行（只返回列表不实际移动，默认 false） */
    dryRun?: boolean;
    /** 要扫描的子目录（默认 memory/） */
    scanDir?: string;
    /** 排除的文件名模式（正则字符串列表） */
    excludePatterns?: string[];
  },
): Promise<ArchiveResult> {
  const thresholdDays = options?.thresholdDays ?? DEFAULT_ARCHIVE_THRESHOLD_DAYS;
  const dryRun = options?.dryRun ?? false;
  const scanDir = options?.scanDir ?? path.join(workspaceDir, "memory");
  const excludePatterns = (options?.excludePatterns ?? ["MEMORY\\.md$", "core-memories\\.md$"])
    .map(p => new RegExp(p, "i"));

  const archiveDir = path.join(scanDir, ARCHIVE_DIR_NAME);
  const thresholdMs = thresholdDays * 86_400_000;
  const now = Date.now();

  const archived: string[] = [];
  let skipped = 0;

  async function scanRecursive(dir: string): Promise<void> {
    // 跳过 archive 目录本身
    if (path.basename(dir) === ARCHIVE_DIR_NAME) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await scanRecursive(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (![".md", ".txt", ".json"].includes(ext)) continue;

      // 排除模式检查
      if (excludePatterns.some(p => p.test(entry.name))) {
        skipped++;
        continue;
      }

      try {
        const stat = await fs.stat(fullPath);
        const daysSinceModified = (now - stat.mtimeMs) / 86_400_000;

        if (daysSinceModified < thresholdDays) {
          skipped++;
          continue;
        }

        // 计算归档目标路径（保留相对目录结构）
        const relToScan = path.relative(scanDir, fullPath);
        const archivePath = path.join(archiveDir, relToScan);

        if (!dryRun) {
          await fs.mkdir(path.dirname(archivePath), { recursive: true });
          await fs.rename(fullPath, archivePath);
        }

        archived.push(relToScan);
      } catch {
        skipped++;
      }
    }
  }

  await scanRecursive(scanDir);

  return { archived, skipped, archiveDir, thresholdDays };
}

/**
 * 从归档恢复文件到原位置
 *
 * @param workspaceDir - clawd 工作区根目录
 * @param relPath - 文件在归档中的相对路径（如 preferences.md）
 * @param scanDir - 原始扫描目录（默认 memory/）
 */
export async function restoreFromArchive(
  workspaceDir: string,
  relPath: string,
  scanDir?: string,
): Promise<{ success: boolean; from: string; to: string; error?: string }> {
  const baseScanDir = scanDir ?? path.join(workspaceDir, "memory");
  const archiveDir = path.join(baseScanDir, ARCHIVE_DIR_NAME);
  const archivePath = path.join(archiveDir, relPath);
  const restorePath = path.join(baseScanDir, relPath);

  try {
    await fs.access(archivePath);
    await fs.mkdir(path.dirname(restorePath), { recursive: true });
    await fs.rename(archivePath, restorePath);
    return { success: true, from: archivePath, to: restorePath };
  } catch (err) {
    return {
      success: false,
      from: archivePath,
      to: restorePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 列出已归档的记忆文件
 */
export async function listArchivedMemories(
  workspaceDir: string,
  scanDir?: string,
): Promise<Array<{ path: string; size: number; archivedAt: number }>> {
  const baseScanDir = scanDir ?? path.join(workspaceDir, "memory");
  const archiveDir = path.join(baseScanDir, ARCHIVE_DIR_NAME);
  const results: Array<{ path: string; size: number; archivedAt: number }> = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          results.push({
            path: path.relative(archiveDir, fullPath).replace(/\\/g, "/"),
            size: stat.size,
            archivedAt: stat.mtimeMs,
          });
        } catch { /* skip */ }
      }
    }
  }

  await walk(archiveDir);
  return results;
}
