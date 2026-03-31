/**
 * Agent Tools for SuperAgentMemory
 *
 * Defines three Agent tools: supermemory_store, supermemory_recall, supermemory_forget.
 * Each tool uses TypeBox for parameter schemas and returns structured results.
 */

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "clawdbot/plugin-sdk";
import {
  SuperMemoryClient,
  SuperMemoryError,
  type StoreResponse,
  type RetrieveResponse,
} from "./client.js";
import type { SuperMemoryConfig } from "./config.js";
import type { CaptureCategory } from "./capture.js";

// ============================================================================
// Tool parameter schemas
// ============================================================================

const StoreParams = Type.Object({
  content: Type.String({
    description: "Information to store in memory",
    minLength: 1,
    maxLength: 5000,
  }),
  importance: Type.Optional(
    Type.Number({
      description: "Importance 0-1, higher = more important (default: 0.7)",
      minimum: 0,
      maximum: 1,
    }),
  ),
  tags: Type.Optional(
    Type.Array(
      Type.String({ description: "Tag for categorization" }),
      { description: "Tags for organization (e.g. ['preference', 'user-name'])" },
    ),
  ),
});

const RecallParams = Type.Object({
  query: Type.String({
    description: "Search query to find relevant memories",
    minLength: 1,
    maxLength: 1000,
  }),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 10)",
      minimum: 1,
      maximum: 50,
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({
      description: "Ripple retrieval depth 1-5, higher = broader search (default: 3)",
      minimum: 1,
      maximum: 5,
    }),
  ),
});

const ForgetParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "Search query to find memory to delete",
    }),
  ),
  memoryId: Type.Optional(
    Type.Number({
      description: "Specific memory atom ID to delete",
    }),
  ),
});

// Stats params (no input needed)
const StatsParams = Type.Object({});

// Evolve params
const EvolveParams = Type.Object({
  phases: Type.Optional(
    Type.Array(
      Type.String({ description: "Evolution phase" }),
      { description: "Phases: grow, prune, reinforce, cluster (default: all)" },
    ),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: "Run evolution in background (default: false)",
    }),
  ),
});

// Health params (no input needed)
const HealthParams = Type.Object({});

// ============================================================================
// Result formatting
// ============================================================================

function formatStoreResult(result: StoreResponse): string {
  // 处理重复情况
  if (result.duplicate || result.is_duplicate) {
    const similar = result.similar_atoms
      ?.map((a) => `  - [${a.id}] "${a.content.slice(0, 80)}..." (${(a.similarity * 100).toFixed(0)}%)`)
      .join("\n");
    return similar ? `Similar memory already exists:\n${similar}` : "Similar memory already exists.";
  }

  // 新格式：直接返回 id 和 content
  if (result.id && result.content) {
    let text = `Memory stored (ID: ${result.id})\n`;
    text += `Content: "${result.content.slice(0, 100)}${result.content.length > 100 ? "..." : ""}"\n`;
    if (result.synapses_count && result.synapses_count > 0) {
      text += `Auto-linked: ${result.synapses_count} synapses\n`;
    }
    return text;
  }

  // 兼容旧格式
  if (result.atom) {
    const atom = result.atom;
    let text = `Memory stored (ID: ${atom.id})\n`;
    text += `Content: "${atom.content.slice(0, 100)}${atom.content.length > 100 ? "..." : ""}"\n`;
    if (result.synapses_created && result.synapses_created > 0) {
      text += `Auto-linked: ${result.synapses_created} synapses created\n`;
    }
    return text;
  }

  return "Memory stored successfully.";
}

function formatRecallResult(result: RetrieveResponse): string {
  if (result.results.length === 0) {
    return "No relevant memories found.";
  }

  const total = result.total_results ?? result.total_found ?? result.results.length;
  let text = `Found ${total} memories (showing ${result.results.length}):\n\n`;
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    const score = (r.score * 100).toFixed(0);
    const tags = r.keywords?.length ? ` [${r.keywords.join(", ")}]` : 
                 r.tags?.length ? ` [${r.tags.join(", ")}]` : "";
    text += `${i + 1}. [ID:${r.id}] (${score}%)${tags}\n`;
    text += `   ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}\n`;
    if (r.path && r.path.length > 0) {
      text += `   Path: ${r.path.join(" → ")} (depth ${r.depth})\n`;
    }
    text += "\n";
  }
  return text;
}

// ============================================================================
// Tool factory
// ============================================================================

export type ToolDependencies = {
  client: SuperMemoryClient;
  config: SuperMemoryConfig;
  getSessionKey?: () => string | undefined;
};

/**
 * Creates all Agent tools for SuperAgentMemory.
 */
export function createTools(deps: ToolDependencies): {
  storeTool: AnyAgentTool;
  recallTool: AnyAgentTool;
  forgetTool: AnyAgentTool;
  statsTool: AnyAgentTool;
  evolveTool: AnyAgentTool;
  healthTool: AnyAgentTool;
} {
  const { client, config, getSessionKey } = deps;

  // --------------------------------------------------------------------------
  // supermemory_store
  // --------------------------------------------------------------------------

  const storeTool = {
    name: "supermemory_store",
    label: "SuperMemory Store",
    description:
      "Save important information in SuperAgentMemory — a neural-network-style long-term memory system with ripple retrieval. " +
      "Use for user preferences, important facts, decisions, or any information worth remembering long-term. " +
      "Automatically deduplicates and creates synapse connections to related memories.",
    parameters: StoreParams,
    async execute(_toolCallId: string, params: Static<typeof StoreParams>) {
      try {
        const agentId = getSessionKey?.();
        const tags = params.tags ?? [];

        const result = await client.store({
          content: params.content,
          agent_id: agentId,
          importance: params.importance ?? config.defaults.importance,
          tags: tags.length > 0 ? tags : undefined,
          auto_link: true,
          deduplicate: true,
        });

        return {
          content: [{ type: "text" as const, text: formatStoreResult(result) }],
          details: {
            action: result.duplicate || result.is_duplicate ? "duplicate" : "created",
            id: result.id ? parseInt(result.id) : result.atom?.id,
            synapsesCreated: result.synapses_count ?? result.synapses_created ?? 0,
          },
        };
      } catch (err) {
        const msg = err instanceof SuperMemoryError ? err.message : `Store failed: ${String(err)}`;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { action: "error", error: msg },
        };
      }
    },
  };

  // --------------------------------------------------------------------------
  // supermemory_recall
  // --------------------------------------------------------------------------

  const recallTool = {
    name: "supermemory_recall",
    label: "SuperMemory Recall",
    description:
      "Search through SuperAgentMemory using HyperNMCv4 multi-layer semantic retrieval — the most powerful search mode. " +
      "Leverages HierarchicalQKV index, 8-layer semantic analysis, and Hot/Warm/Cold tiered retrieval. " +
      "Automatically expands query with keywords and semantic variations for best results. " +
      "Use when you need context about user preferences, past decisions, or previously discussed topics.",
    parameters: RecallParams,
    async execute(_toolCallId: string, params: Static<typeof RecallParams>) {
      try {
        const agentId = getSessionKey?.();

        const result = await client.retrieve({
          query: params.query,
          agent_id: agentId,
          max_results: params.maxResults ?? config.defaults.maxResults,
          max_depth: params.maxDepth ?? config.defaults.maxDepth,
          decay_factor: config.defaults.decayFactor,
          min_strength: config.defaults.minStrength,
        });

        // Strip heavy fields for details
        const sanitizedResults = result.results.map((r) => ({
          id: r.id,
          content: r.content,
          score: r.score,
          depth: r.depth,
          tags: r.keywords ?? r.tags,
        }));

        return {
          content: [{ type: "text" as const, text: formatRecallResult(result) }],
          details: {
            count: result.results.length,
            totalFound: result.total_results ?? result.total_found,
            memories: sanitizedResults,
          },
        };
      } catch (err) {
        const msg = err instanceof SuperMemoryError ? err.message : `Recall failed: ${String(err)}`;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { count: 0, error: msg },
        };
      }
    },
  };

  // --------------------------------------------------------------------------
  // supermemory_forget
  // --------------------------------------------------------------------------

  const forgetTool = {
    name: "supermemory_forget",
    label: "SuperMemory Forget",
    description: "Delete specific memories from SuperAgentMemory. Provide a memoryId for direct deletion, or a query to find candidates first.",
    parameters: ForgetParams,
    async execute(_toolCallId: string, params: Static<typeof ForgetParams>) {
      try {
        // Direct deletion by ID
        if (params.memoryId) {
          const result = await client.delete(params.memoryId, true);
          return {
            content: [{ type: "text" as const, text: `Memory ${params.memoryId} deleted. (Synapses removed: ${result.synapses_removed ?? 0})` }],
            details: { action: "deleted", id: params.memoryId },
          };
        }

        // Search for candidates
        if (params.query) {
          const result = await client.retrieve({
            query: params.query,
            max_results: 5,
            max_depth: 1,
          });

          if (result.results.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No matching memories found." }],
              details: { found: 0 },
            };
          }

          // Single high-confidence match → auto-delete
          if (result.results.length === 1 && result.results[0].score > 0.9) {
            const r = result.results[0];
            const memoryId = parseInt(r.id);
            await client.delete(memoryId, true);
            return {
              content: [{ type: "text" as const, text: `Forgotten: "${r.content.slice(0, 80)}..."` }],
              details: { action: "deleted", id: memoryId },
            };
          }

          // Multiple candidates → list for user to choose
          const list = result.results
            .map(
              (r) =>
                `- [ID:${r.id}] (${(r.score * 100).toFixed(0)}%) "${r.content.slice(0, 80)}..."`,
            )
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${result.results.length} candidates. Specify memoryId to delete:\n${list}`,
              },
            ],
            details: {
              action: "candidates",
              candidates: result.results.map((r) => ({
                id: parseInt(r.id),
                content: r.content,
                score: r.score,
              })),
            },
          };
        }

        return {
          content: [{ type: "text" as const, text: "Provide memoryId or query." }],
          details: { error: "missing_param" },
        };
      } catch (err) {
        const msg = err instanceof SuperMemoryError ? err.message : `Forget failed: ${String(err)}`;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { error: msg },
        };
      }
    },
  };

  // --------------------------------------------------------------------------
  // supermemory_stats
  // --------------------------------------------------------------------------

  const statsTool = {
    name: "supermemory_stats",
    label: "SuperMemory Stats",
    description:
      "Get memory system statistics and dashboard information. " +
      "Shows total memories, synapses, keywords, and system health. " +
      "Use this to understand the current state of the memory system.",
    parameters: StatsParams,
    async execute(_toolCallId: string, _params: Static<typeof StatsParams>) {
      try {
        const stats = await client.getDashboardStats();

        const text = [
          `Memory System Dashboard`,
          ``,
          `🧠 Memory:`,
          `  Total atoms: ${stats.memory.total_atoms}`,
          `  Active: ${stats.memory.active_atoms}`,
          `  Archived: ${stats.memory.archived_atoms}`,
          `  Avg importance: ${(stats.memory.avg_importance * 100).toFixed(1)}%`,
          ``,
          `🔗 Synapses:`,
          `  Total: ${stats.synapses.total_synapses}`,
          `  Active: ${stats.synapses.active_synapses}`,
          `  Avg strength: ${(stats.synapses.avg_strength * 100).toFixed(1)}%`,
          ``,
          `🏷️  Keywords:`,
          `  Total: ${stats.keywords.total_keywords}`,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: {
            memory: stats.memory,
            synapses: stats.synapses,
            keywords: stats.keywords,
          },
        };
      } catch (err) {
        const msg = err instanceof SuperMemoryError ? err.message : `Stats failed: ${String(err)}`;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { error: msg },
        };
      }
    },
  };

  // --------------------------------------------------------------------------
  // supermemory_evolve
  // --------------------------------------------------------------------------

  const evolveTool = {
    name: "supermemory_evolve",
    label: "SuperMemory Evolve",
    description:
      "Trigger memory network evolution. Evolution performs network optimization including: " +
      "growing new synapses between related memories, pruning weak connections, " +
      "reinforcing important memories, and forming semantic clusters. " +
      "This helps keep the memory network healthy and efficient.",
    parameters: EvolveParams,
    async execute(_toolCallId: string, params: Static<typeof EvolveParams>) {
      try {
        const result = await client.triggerEvolution({
          phases: params.phases,
          background: params.background ?? false,
        });

        if (result.background) {
          return {
            content: [{ type: "text" as const, text: `Evolution started in background. ${result.message}` }],
            details: { status: result.status, background: true },
          };
        }

        const text = [
          `Evolution completed. ${result.message}`,
          ``,
          `Metrics:`,
          `  Synapses created: ${result.metrics?.synapses_created ?? 0}`,
          `  Synapses pruned: ${result.metrics?.synapses_pruned ?? 0}`,
          `  Synapses strengthened: ${result.metrics?.synapses_strengthened ?? 0}`,
          `  Clusters formed: ${result.metrics?.clusters_formed ?? 0}`,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: { status: result.status, metrics: result.metrics },
        };
      } catch (err) {
        const msg = err instanceof SuperMemoryError ? err.message : `Evolve failed: ${String(err)}`;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { error: msg },
        };
      }
    },
  };

  // --------------------------------------------------------------------------
  // supermemory_health
  // --------------------------------------------------------------------------

  const healthTool = {
    name: "supermemory_health",
    label: "SuperMemory Health",
    description:
      "Check memory system health and component status. " +
      "Verifies connectivity to all critical components: atom repository, " +
      "synapse repository, keyword repository, embedder, and debouncer.",
    parameters: HealthParams,
    async execute(_toolCallId: string, _params: Static<typeof HealthParams>) {
      try {
        const health = await client.memoryHealthCheck();

        const statusIcon = health.status === "healthy" ? "✓" : health.status === "degraded" ? "⚠" : "✗";

        const components = Object.entries(health.checks)
          .map(([name, ok]) => `  ${ok ? "✓" : "✗"} ${name}: ${ok ? "ok" : "failed"}`)
          .join("\n");

        const text = [
          `Memory System Health: ${statusIcon} ${health.status}`,
          ``,
          `Components:`,
          components,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: { status: health.status, checks: health.checks, version: health.version },
        };
      } catch (err) {
        const msg = err instanceof SuperMemoryError ? err.message : `Health check failed: ${String(err)}`;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: { error: msg },
        };
      }
    },
  };

  return { storeTool, recallTool, forgetTool, statsTool, evolveTool, healthTool };
}
