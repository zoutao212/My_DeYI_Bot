/**
 * 小说素材参考检索工具（Novel Reference Search Tool）
 *
 * 提供 novel_reference_search LLM 工具，让 Agent 在写作/角色扮演时
 * 主动搜索 NovelsAssets/ 目录中的原文参考片段。
 *
 * @module agents/tools/novel-reference-tool
 */

import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import {
  searchNovelAssets,
  hasNovelAssets,
  getNovelAssetsOverview,
  type NovelSearchOptions,
} from "../../memory/novel-assets-searcher.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

// ─── Schema 定义 ──────────────────────────────────────────────

const NovelReferenceSearchSchema = Type.Object({
  /** 搜索查询（角色名、场景描写、情节关键词、风格特征等） */
  query: Type.String(),
  /** 最大返回片段数（默认 5，范围 1-10） */
  maxSnippets: Type.Optional(Type.Number()),
  /** 单个片段目标长度（字符数，默认 400，范围 100-800） */
  snippetLength: Type.Optional(Type.Number()),
  /** 额外搜索关键词（逗号分隔） */
  extraTerms: Type.Optional(Type.String()),
});

const NovelAssetsListSchema = Type.Object({
  /** 无需参数，列出素材库概览 */
  dummy: Type.Optional(Type.String()),
});

// ─── 工具创建 ──────────────────────────────────────────────

/**
 * 创建 novel_reference_search 工具
 *
 * 仅当 NovelsAssets/ 目录存在且包含文件时才创建。
 */
export function createNovelReferenceSearchTool(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Novel Reference Search",
    name: "novel_reference_search",
    description:
      "小说素材参考检索：在 NovelsAssets/ 目录中搜索原文参考片段，用于写作风格模仿、角色扮演参考、情节灵感获取。" +
      "返回匹配的原文段落（含来源文件名、行号、章节信息）。" +
      "适用场景：创作小说/剧情时需要参考原著的描写手法、人物对话风格、场景氛围、打斗/情感描写等。",
    parameters: NovelReferenceSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxSnippets = Math.min(10, Math.max(1, readNumberParam(params, "maxSnippets") ?? 5));
      const snippetLength = Math.min(800, Math.max(100, readNumberParam(params, "snippetLength") ?? 400));
      const extraTermsRaw = readStringParam(params, "extraTerms");
      const extraTerms = extraTermsRaw
        ? extraTermsRaw.split(/[,，、\s]+/).filter(Boolean)
        : [];

      // 检查素材库是否存在
      const available = await hasNovelAssets(workspaceDir);
      if (!available) {
        return jsonResult({
          error: "NovelsAssets 目录不存在或为空。请在工作区下创建 NovelsAssets/ 目录并放入小说 TXT 文件。",
          dir: `${workspaceDir}/NovelsAssets`,
        });
      }

      const searchOptions: NovelSearchOptions = {
        maxSnippets,
        snippetTargetChars: snippetLength,
        snippetMaxChars: Math.min(800, snippetLength + 200),
        extraTerms,
        autoExtractKeywords: true,
      };

      try {
        const result = await searchNovelAssets(query, workspaceDir, searchOptions);

        return jsonResult({
          snippets: result.snippets.map(s => ({
            fileName: s.fileName,
            startLine: s.startLine,
            endLine: s.endLine,
            charCount: s.charCount,
            score: s.score,
            chapterHint: s.chapterHint,
            matchedTerms: s.matchedTerms,
            text: s.text,
          })),
          meta: {
            filesScanned: result.filesScanned,
            paragraphsScanned: result.paragraphsScanned,
            durationMs: result.durationMs,
            searchTerms: result.searchTerms.slice(0, 10), // 只返回前 10 个搜索词
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `搜索失败: ${message}` });
      }
    },
  };
}

/**
 * 创建 novel_assets_list 工具
 *
 * 列出素材库中的所有文件（文件名 + 大小）
 */
export function createNovelAssetsListTool(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Novel Assets List",
    name: "novel_assets_list",
    description:
      "列出 NovelsAssets/ 目录中的所有小说素材文件（文件名、大小）。用于了解当前可用的参考素材。",
    parameters: NovelAssetsListSchema,
    execute: async () => {
      try {
        const overview = await getNovelAssetsOverview(workspaceDir);
        return jsonResult({
          dir: overview.dir,
          fileCount: overview.fileCount,
          files: overview.files.map(f => ({
            name: f.name,
            sizeMB: Math.round(f.size / 1024 / 1024 * 100) / 100,
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `列表失败: ${message}` });
      }
    },
  };
}
