import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { localGrepSearch, deepGrepSearch, getDefaultMemoryDirs } from "../../memory/local-search.js";
import { searchNovelAssets, hasNovelAssets } from "../../memory/novel-assets-searcher.js";
import {
  routeQuery,
  getSearchCacheKey,
  getCachedSearchResult,
  cacheSearchResult,
  type SearchChannel,
} from "../../memory/query-router.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
// H2: keywordSearch 已删除，keyword/fts 通道统一使用 localGrepSearch

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

export function createMemorySearchTool(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "记忆检索（强制步骤）：在回答与既往工作/决策/日期/人物/偏好/待办相关的问题前，先在 MEMORY.md + memory/*.md（可选含会话记录）里做语义搜索；返回命中的片段路径与行号范围。",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults") ?? 10;
      const minScore = readNumberParam(params, "minScore") ?? 0;

      // M5: 搜索结果短缓存（30s TTL，避免重复查询）
      const cacheKey = getSearchCacheKey(query, maxResults);
      const cached = getCachedSearchResult<{ path: string; score: number }>(cacheKey);
      if (cached) {
        return jsonResult({ results: cached, provider: "cache", cached: true });
      }

      // 检测可用通道
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      const embeddingAvailable = !!manager;
      const ftsAvailable = embeddingAvailable && (manager!.status().fts?.available ?? false);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const dirs = getDefaultMemoryDirs(workspaceDir);

      // M5: 智能路由 — 根据查询特征选择最优通道
      const decision = routeQuery(query, {
        embedding: embeddingAvailable,
        fts: ftsAvailable,
        grep: true, // grep 始终可用
      });

      // H1: 通道去重 — manager.search() 内部已含 vector+FTS+localGrep 三路融合，
      // 外层不再单独起 grep/keyword/fts 通道（避免 localGrepSearch 被执行 2-3 次）。
      // 仅保留 deepGrep 作为补充通道（TF-IDF 关键词抽取，与 localGrep 互补）。
      // manager 不可用时降级到独立 grep + deepGrep。
      const allChannels: SearchChannel[] = [];
      const allRequested = [decision.primary, ...decision.secondary];
      const hasEmbedding = allRequested.includes("embedding") && embeddingAvailable;

      // H3: 跨域搜索 — 检测写作/角色相关意图时，自动纳入 novelAssets 通道
      const novelAssetsAvailable = await hasNovelAssets(workspaceDir).catch(() => false);
      const isWritingIntent = novelAssetsAvailable && /(?:写作|角色|风格|情节|场景|小说|创作|参考|原著|描写|对话|打斗|情感|character|writing|novel)/i.test(query);

      if (hasEmbedding) {
        // manager 可用 → 它内部已做三路融合，只补充 deepGrep + novelAssets
        allChannels.push("embedding");
        if (allRequested.includes("deepGrep")) {
          allChannels.push("deepGrep");
        }
        if (isWritingIntent) {
          allChannels.push("novelAssets" as SearchChannel);
        }
      } else {
        // manager 不可用 → 降级：去重后保留 grep + deepGrep（keyword/fts 等效于 grep）
        const seen = new Set<SearchChannel>();
        for (const ch of allRequested) {
          if (ch === "embedding") continue; // 不可用
          // keyword/fts 已统一为 grep，避免重复
          const normalized = (ch === "keyword" || ch === "fts") ? "grep" as SearchChannel : ch;
          if (!seen.has(normalized)) {
            seen.add(normalized);
            allChannels.push(normalized);
          }
        }
        // 确保至少有 grep
        if (allChannels.length === 0) allChannels.push("grep");
        // H3: 无 embedding 时也纳入 novelAssets
        if (isWritingIntent) {
          allChannels.push("novelAssets" as SearchChannel);
        }
      }

      // 并行执行所有选中通道
      type ChannelResult = { channel: SearchChannel; results: Array<{ path: string; startLine: number; endLine: number; score: number; snippet: string; source?: string; matchedTerms?: string[] }> };

      const channelPromises: Promise<ChannelResult>[] = allChannels.map(async (channel): Promise<ChannelResult> => {
        try {
          switch (channel) {
            case "embedding": {
              if (!manager) return { channel, results: [] };
              // manager.search() 内部已含 vector+FTS+localGrep 三路融合
              const results = await manager.search(query, {
                maxResults: maxResults * 2,
                minScore,
                sessionKey: options.agentSessionKey,
              });
              return { channel, results };
            }
            case "grep": {
              const results = await localGrepSearch(query, {
                dirs,
                extensions: [".md", ".txt"],
                maxResults: maxResults * 2,
                workspaceDir,
              });
              return {
                channel,
                results: results.map(r => ({
                  path: r.path,
                  startLine: r.startLine,
                  endLine: r.endLine,
                  score: r.score,
                  snippet: r.snippet,
                  source: r.source,
                })),
              };
            }
            case "deepGrep": {
              const results = await deepGrepSearch(query, {
                dirs,
                extensions: [".md", ".txt"],
                maxResults: maxResults * 2,
                workspaceDir,
                autoExtractKeywords: true,
              });
              return {
                channel,
                results: results.map(r => ({
                  path: r.path,
                  startLine: r.startLine,
                  endLine: r.endLine,
                  score: r.score,
                  snippet: r.snippet,
                  source: r.source,
                  matchedTerms: r.matchedTerms,
                })),
              };
            }
            default: {
              // H3: novelAssets 跨域搜索通道
              if (channel === ("novelAssets" as SearchChannel)) {
                const novelResult = await searchNovelAssets(query, workspaceDir, {
                  maxSnippets: Math.min(5, maxResults),
                  snippetTargetChars: 400,
                  snippetMaxChars: 600,
                  autoExtractKeywords: true,
                });
                return {
                  channel,
                  results: novelResult.snippets.map(s => ({
                    path: `NovelsAssets/${s.fileName}`,
                    startLine: s.startLine,
                    endLine: s.endLine,
                    score: s.score,
                    snippet: s.text.length > 500 ? s.text.substring(0, 500) + "…" : s.text,
                    source: "novel-assets",
                    matchedTerms: s.matchedTerms,
                  })),
                };
              }
              return { channel, results: [] };
            }
          }
        } catch {
          return { channel, results: [] };
        }
      });

      const channelResults = await Promise.all(channelPromises);

      // 合并+去重+加权排序
      const seen = new Map<string, { path: string; startLine: number; endLine: number; score: number; snippet: string; source?: string; matchedTerms?: string[]; channels: string[] }>();

      for (const cr of channelResults) {
        const weight = decision.weights[cr.channel] ?? 0.3;
        for (const r of cr.results) {
          const key = `${r.path}:${r.startLine}-${r.endLine}`;
          const existing = seen.get(key);
          if (existing) {
            // 已有：取加权最高分
            existing.score = Math.max(existing.score, r.score * weight);
            existing.channels.push(cr.channel);
            if (r.snippet.length > (existing.snippet?.length ?? 0)) {
              existing.snippet = r.snippet;
            }
          } else {
            seen.set(key, {
              ...r,
              score: r.score * weight,
              channels: [cr.channel],
            });
          }
        }
      }

      // 多通道命中加分（在多个通道中都出现的结果更可信）
      for (const entry of seen.values()) {
        if (entry.channels.length > 1) {
          entry.score *= 1 + 0.15 * (entry.channels.length - 1);
          entry.score = Math.min(1, entry.score);
        }
      }

      const merged = Array.from(seen.values())
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      // 缓存结果
      cacheSearchResult(cacheKey, merged);

      const activeChannels = channelResults.filter(cr => cr.results.length > 0).map(cr => cr.channel);

      return jsonResult({
        results: merged.map(r => ({
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          score: Math.round(r.score * 100) / 100,
          snippet: r.snippet.length > 500 ? r.snippet.substring(0, 500) + "…" : r.snippet,
          source: r.source,
          matchedTerms: r.matchedTerms,
          channels: r.channels,
        })),
        routing: {
          intent: decision.profile.intent,
          primary: decision.primary,
          activeChannels,
          reason: decision.reason,
        },
        ...(error ? { embeddingWarning: `Embedding unavailable: ${error}` } : {}),
      });
    },
  };
}

export function createMemoryGetTool(options: {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "记忆读取（安全片段）：从 MEMORY.md 或 memory/*.md 读取指定范围内容（可选 from/lines）；建议先用 memory_search 定位，再只取必要片段以保持上下文精简。",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ path: relPath, text: "", disabled: true, error });
      }
      try {
        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}
