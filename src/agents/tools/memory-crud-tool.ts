/**
 * 记忆系统 CRUD 工具集
 *
 * 提供 memory_write / memory_update / memory_delete / memory_list 四个 LLM 工具，
 * 让 Agent 拥有完整的记忆增删改查能力，零外部模型依赖。
 *
 * @module agents/tools/memory-crud-tool
 */

import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ClawdbotConfig } from "../../config/config.js";
import {
  deepGrepSearch,
  invalidateFileCache,
  invalidateDirCache,
  listMemoryTree,
  getDefaultMemoryDirs,
} from "../../memory/local-search.js";
import { invalidateSearchCache } from "../../memory/query-router.js";
import { getMemorySearchManager } from "../../memory/search-manager.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

// ─── Schema 定义 ──────────────────────────────────────────────

const MemoryWriteSchema = Type.Object({
  /** 记忆文件的相对路径（相对于工作区根，如 memory/preferences.md） */
  filePath: Type.String(),
  /** 要写入的内容 */
  content: Type.String(),
  /** 写入模式：overwrite（覆盖）/ append（追加）/ prepend（前置追加）*/
  mode: Type.Optional(Type.Union([
    Type.Literal("overwrite"),
    Type.Literal("append"),
    Type.Literal("prepend"),
  ])),
  /** 是否创建不存在的目录（默认 true） */
  createDirs: Type.Optional(Type.Boolean()),
});

const MemoryUpdateSchema = Type.Object({
  /** 记忆文件的相对路径 */
  filePath: Type.String(),
  /** 要替换的旧文本 */
  oldText: Type.String(),
  /** 替换为的新文本 */
  newText: Type.String(),
  /** 是否替换所有匹配（默认 false，只替换第一个） */
  replaceAll: Type.Optional(Type.Boolean()),
});

const MemoryDeleteSchema = Type.Object({
  /** 记忆文件的相对路径 */
  filePath: Type.String(),
  /** 是否确认删除（必须为 true 才执行） */
  confirm: Type.Boolean(),
});

const MemoryListSchema = Type.Object({
  /** 要列出的子目录（可选，默认列出所有记忆目录） */
  subDir: Type.Optional(Type.String()),
  /** 文件扩展名过滤（可选，默认 .md .txt .json） */
  extensions: Type.Optional(Type.Array(Type.String())),
  /** 最大目录深度（可选） */
  maxDepth: Type.Optional(Type.Number()),
  /** 是否包含行数信息（可选，默认 false） */
  includeLineCount: Type.Optional(Type.Boolean()),
});

const MemoryDeepSearchSchema = Type.Object({
  /** 搜索查询（支持长文本，会自动提取关键词） */
  query: Type.String(),
  /** 最大结果数（默认 15） */
  maxResults: Type.Optional(Type.Number()),
  /** 额外搜索关键词（手动补充） */
  extraTerms: Type.Optional(Type.Array(Type.String())),
  /** 是否搜索 .json/.jsonl 文件（默认 false） */
  includeJson: Type.Optional(Type.Boolean()),
});

// ─── 工具创建函数 ──────────────────────────────────────────────

interface MemoryCrudToolOptions {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}

/**
 * 创建 memory_write 工具 — 写入/追加记忆文件
 */
export function createMemoryWriteTool(options: MemoryCrudToolOptions): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memory Write",
    name: "memory_write",
    description:
      "记忆写入：将内容写入记忆文件。支持三种模式：overwrite（覆盖）、append（追加到末尾）、prepend（追加到开头）。" +
      "路径相对于工作区根目录，如 memory/preferences.md、characters/lina/memory/core.md。" +
      "会自动创建不存在的目录。写入后自动刷新搜索缓存。",
    parameters: MemoryWriteSchema,
    execute: async (_toolCallId, params) => {
      const filePath = readStringParam(params, "filePath", { required: true });
      const content = readStringParam(params, "content", { required: true, allowEmpty: true });
      const mode = readStringParam(params, "mode") ?? "overwrite";
      const createDirs = params.createDirs !== false;

      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const absPath = resolveMemoryPath(workspaceDir, filePath);

      // 安全检查：不允许写入工作区外
      if (!absPath.startsWith(workspaceDir)) {
        return jsonResult({
          success: false,
          error: "路径不在工作区范围内，拒绝写入",
        });
      }

      try {
        // 确保目录存在
        if (createDirs) {
          await fs.mkdir(path.dirname(absPath), { recursive: true });
        }

        let finalContent = content;
        if (mode === "append" || mode === "prepend") {
          let existing = "";
          try {
            existing = await fs.readFile(absPath, "utf-8");
          } catch {
            // 文件不存在，直接写入
          }
          finalContent = mode === "append"
            ? existing + (existing.endsWith("\n") ? "" : "\n") + content
            : content + (content.endsWith("\n") ? "" : "\n") + existing;
        }

        await fs.writeFile(absPath, finalContent, "utf-8");

        // 刷新所有缓存
        invalidateFileCache(absPath);
        invalidateDirCache();
        invalidateSearchCache();
        // M7: 即时索引 — 触发 SQLite/FTS/向量索引增量更新（fire-and-forget）
        void triggerImmediateIndex(cfg, agentId, absPath);

        const stat = await fs.stat(absPath);
        return jsonResult({
          success: true,
          path: filePath,
          absPath,
          mode,
          size: stat.size,
          lines: finalContent.split("\n").length,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * 创建 memory_update 工具 — 精确替换记忆文件中的内容
 */
export function createMemoryUpdateTool(options: MemoryCrudToolOptions): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memory Update",
    name: "memory_update",
    description:
      "记忆更新：在记忆文件中精确查找并替换指定文本。" +
      "必须提供准确的 oldText（要替换的原文）和 newText（替换后的新文本）。" +
      "建议先用 memory_search 或 memory_get 查看文件内容，确认要替换的精确文本。",
    parameters: MemoryUpdateSchema,
    execute: async (_toolCallId, params) => {
      const filePath = readStringParam(params, "filePath", { required: true });
      const oldText = readStringParam(params, "oldText", { required: true, allowEmpty: false });
      const newText = readStringParam(params, "newText", { required: true, allowEmpty: true });
      const replaceAll = params.replaceAll === true;

      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const absPath = resolveMemoryPath(workspaceDir, filePath);

      try {
        const content = await fs.readFile(absPath, "utf-8");

        if (!content.includes(oldText)) {
          return jsonResult({
            success: false,
            error: "未找到要替换的文本（oldText 与文件内容不匹配）",
            hint: "请先用 memory_get 或 memory_search 确认文件内容",
          });
        }

        let updated: string;
        let replaceCount: number;

        if (replaceAll) {
          const parts = content.split(oldText);
          replaceCount = parts.length - 1;
          updated = parts.join(newText);
        } else {
          replaceCount = 1;
          const idx = content.indexOf(oldText);
          updated = content.substring(0, idx) + newText + content.substring(idx + oldText.length);
        }

        await fs.writeFile(absPath, updated, "utf-8");
        invalidateFileCache(absPath);
        invalidateSearchCache();
        // M7: 即时索引
        void triggerImmediateIndex(cfg, agentId, absPath);

        return jsonResult({
          success: true,
          path: filePath,
          replaceCount,
          newSize: updated.length,
          newLines: updated.split("\n").length,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * 创建 memory_delete 工具 — 删除记忆文件
 */
export function createMemoryDeleteTool(options: MemoryCrudToolOptions): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memory Delete",
    name: "memory_delete",
    description:
      "记忆删除：删除指定的记忆文件。必须设置 confirm=true 才会执行删除。" +
      "删除前会返回文件信息（大小、行数），删除后不可恢复。",
    parameters: MemoryDeleteSchema,
    execute: async (_toolCallId, params) => {
      const filePath = readStringParam(params, "filePath", { required: true });
      const confirm = params.confirm === true;

      if (!confirm) {
        return jsonResult({
          success: false,
          error: "删除操作需要 confirm=true 确认",
        });
      }

      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const absPath = resolveMemoryPath(workspaceDir, filePath);

      // 安全检查
      if (!absPath.startsWith(workspaceDir)) {
        return jsonResult({
          success: false,
          error: "路径不在工作区范围内，拒绝删除",
        });
      }

      try {
        const stat = await fs.stat(absPath);
        const content = await fs.readFile(absPath, "utf-8");
        const lineCount = content.split("\n").length;

        await fs.unlink(absPath);
        invalidateFileCache(absPath);
        invalidateDirCache();
        invalidateSearchCache();

        return jsonResult({
          success: true,
          path: filePath,
          deletedSize: stat.size,
          deletedLines: lineCount,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * 创建 memory_list 工具 — 列出记忆库文件树
 */
export function createMemoryListTool(options: MemoryCrudToolOptions): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memory List",
    name: "memory_list",
    description:
      "记忆列表：列出记忆库中的所有文件（递归遍历多层级目录）。" +
      "返回文件路径、大小、修改时间。可通过 subDir 指定子目录，extensions 过滤文件类型。" +
      "用于了解记忆库的整体结构，决定要读取或搜索哪些文件。",
    parameters: MemoryListSchema,
    execute: async (_toolCallId, params) => {
      const subDir = readStringParam(params, "subDir");
      const extensions = params.extensions as string[] | undefined;
      const maxDepth = readNumberParam(params, "maxDepth", { integer: true });
      const includeLineCount = params.includeLineCount === true;

      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

      // 确定搜索目录
      let dirs: string[];
      if (subDir) {
        const absSubDir = resolveMemoryPath(workspaceDir, subDir);
        dirs = [absSubDir];
      } else {
        dirs = getDefaultMemoryDirs(workspaceDir);
      }

      try {
        const files = await listMemoryTree(dirs, {
          extensions: extensions ?? [".md", ".txt", ".json"],
          workspaceDir,
          maxDepth: maxDepth ?? undefined,
          includeLineCount,
        });

        // 格式化输出
        const summary = {
          totalFiles: files.length,
          totalSize: files.reduce((sum, f) => sum + f.size, 0),
          byExtension: {} as Record<string, number>,
        };
        for (const f of files) {
          summary.byExtension[f.extension] = (summary.byExtension[f.extension] ?? 0) + 1;
        }

        return jsonResult({
          files: files.map(f => ({
            path: f.path,
            size: f.size,
            modifiedAt: new Date(f.modifiedAt).toISOString(),
            extension: f.extension,
            ...(f.lineCount !== undefined ? { lineCount: f.lineCount } : {}),
          })),
          summary,
        });
      } catch (err) {
        return jsonResult({
          files: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * 创建 memory_deep_search 工具 — 关键词抽取驱动的深度搜索
 */
export function createMemoryDeepSearchTool(options: MemoryCrudToolOptions): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memory Deep Search",
    name: "memory_deep_search",
    description:
      "记忆深度搜索：从查询文本中自动提取关键词（TF-IDF），在多层级记忆目录中全面检索。" +
      "比 memory_search 更强大：支持长文本查询（自动抽取关键词）、返回匹配的具体关键词、覆盖更多目录。" +
      "适用场景：需要从大段上下文中快速定位相关记忆、跨目录全文搜索。" +
      "零外部依赖，纯本地执行。",
    parameters: MemoryDeepSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults") ?? 15;
      const extraTerms = params.extraTerms as string[] | undefined;
      const includeJson = params.includeJson === true;

      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const dirs = getDefaultMemoryDirs(workspaceDir);

      try {
        const results = await deepGrepSearch(query, {
          dirs,
          maxResults,
          extraTerms,
          includeJson,
          workspaceDir,
        });

        return jsonResult({
          results: results.map(r => ({
            path: r.path,
            startLine: r.startLine,
            endLine: r.endLine,
            score: Math.round(r.score * 100) / 100,
            matchedTerms: r.matchedTerms,
            snippet: r.snippet.length > 500 ? r.snippet.substring(0, 500) + "..." : r.snippet,
            fileTotalLines: r.fileTotalLines,
          })),
          totalResults: results.length,
          provider: "local-deep-grep",
        });
      } catch (err) {
        return jsonResult({
          results: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

// ─── M7: 即时索引辅助函数 ───────────────────────────────────────────────────────

/**
 * M7: 写入后即时触发 SQLite/FTS/向量索引增量更新
 * fire-and-forget，不阻塞 CRUD 工具响应返回。
 * 如果索引管理器不可用（无 embedding 配置等），静默降级。
 */
async function triggerImmediateIndex(cfg: ClawdbotConfig, agentId: string, absPath: string): Promise<void> {
  try {
    const result = await getMemorySearchManager({ cfg, agentId });
    if (result.manager) {
      await result.manager.notifyFileChanged(absPath);
    }
  } catch {
    // 索引管理器不可用（无 embedding 配置等），静默降级
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────────

/**
 * 解析记忆文件路径（相对路径 → 绝对路径）
 * 支持 memory/xxx 和绝对路径两种格式
 */
function resolveMemoryPath(workspaceDir: string, filePath: string): string {
  // 如果已经是绝对路径，直接使用
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath);
  }
  // 相对路径，基于工作区目录解析
  return path.normalize(path.join(workspaceDir, filePath));
}

/**
 * 创建所有记忆 CRUD 工具的便捷函数
 */
export function createAllMemoryCrudTools(options: MemoryCrudToolOptions): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  const write = createMemoryWriteTool(options);
  const update = createMemoryUpdateTool(options);
  const del = createMemoryDeleteTool(options);
  const list = createMemoryListTool(options);
  const deepSearch = createMemoryDeepSearchTool(options);

  if (write) tools.push(write);
  if (update) tools.push(update);
  if (del) tools.push(del);
  if (list) tools.push(list);
  if (deepSearch) tools.push(deepSearch);

  return tools;
}
