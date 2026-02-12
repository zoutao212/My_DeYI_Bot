import { Type } from "@sinclair/typebox";
import * as path from "node:path";

import type { ClawdbotConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { localGrepSearch } from "../../memory/local-search.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { keywordSearch } from "./memory-keyword-search.js";

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
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      
      // Step 1: Try embedding search first
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      
      if (manager) {
        try {
          const results = await manager.search(query, {
            maxResults,
            minScore,
            sessionKey: options.agentSessionKey,
          });
          const status = manager.status();
          return jsonResult({
            results,
            provider: status.provider,
            model: status.model,
            fallback: status.fallback,
          });
        } catch (err) {
          console.warn("Embedding search failed, falling back to keyword search:", err);
        }
      }
      
      // Step 2: Fallback to localGrepSearch（本地快速文本搜索）
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      try {
        const memoryDir = path.join(workspaceDir, "memory");
        const characterMemoryDirs = [
          path.join(workspaceDir, "characters"),
        ];
        const grepResults = await localGrepSearch(query, {
          dirs: [memoryDir, ...characterMemoryDirs],
          extensions: [".md", ".txt"],
          maxResults: maxResults ?? 10,
          workspaceDir,
        });

        if (grepResults.length > 0) {
          return jsonResult({
            results: grepResults,
            provider: "local-grep",
            fallback: true,
            warning: error
              ? `Embedding search unavailable (${error}), using local grep search`
              : "Using local grep search as fallback",
          });
        }
      } catch {
        // localGrep 失败，继续 fallback
      }

      // Step 3: 最终兜底 — 简单关键词搜索
      try {
        const memoryDir = path.join(workspaceDir, "memory");
        const keywordResults = await keywordSearch({
          query,
          memoryDir,
          maxResults: maxResults ?? 10,
        });
        
        return jsonResult({
          results: keywordResults,
          provider: "keyword",
          fallback: true,
          warning: error 
            ? `Embedding search unavailable (${error}), using keyword search`
            : "Using keyword search as final fallback",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ 
          results: [], 
          disabled: true, 
          error: `All search methods failed: ${message}` 
        });
      }
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
