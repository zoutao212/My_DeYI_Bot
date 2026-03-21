/**
 * Agent Tools for SuperAgentMemory
 *
 * Defines three Agent tools: supermemory_store, supermemory_recall, supermemory_forget.
 * Each tool uses TypeBox for parameter schemas and returns structured results.
 */

import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
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

// ============================================================================
// Result formatting
// ============================================================================

function formatStoreResult(result: StoreResponse): string {
  if (result.is_duplicate) {
    const similar = result.similar_atoms
      ?.map((a) => `  - [${a.id}] "${a.content.slice(0, 80)}..." (${(a.similarity * 100).toFixed(0)}%)`)
      .join("\n");
    return `Similar memory already exists:\n${similar}`;
  }

  const atom = result.atom;
  let text = `Memory stored (ID: ${atom.id})\n`;
  text += `Content: "${atom.content.slice(0, 100)}${atom.content.length > 100 ? "..." : ""}"\n`;
  if (result.synapses_created && result.synapses_created > 0) {
    text += `Auto-linked: ${result.synapses_created} synapses created\n`;
  }
  return text;
}

function formatRecallResult(result: RetrieveResponse): string {
  if (result.results.length === 0) {
    return "No relevant memories found.";
  }

  let text = `Found ${result.total_found} memories (showing ${result.results.length}):\n\n`;
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    const atom = r.atom;
    const score = (r.score * 100).toFixed(0);
    const tags = atom.tags?.length ? ` [${atom.tags.join(", ")}]` : "";
    text += `${i + 1}. [ID:${atom.id}] (${score}%)${tags}\n`;
    text += `   ${atom.content.slice(0, 200)}${atom.content.length > 200 ? "..." : ""}\n`;
    if (r.path.length > 0) {
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
 * Creates the three Agent tools for SuperAgentMemory.
 */
export function createTools(deps: ToolDependencies) {
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
            action: result.is_duplicate ? "duplicate" : "created",
            id: result.atom.id,
            synapsesCreated: result.synapses_created ?? 0,
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
      "Search through SuperAgentMemory using ripple retrieval — a neural-network-inspired search that follows synapse connections " +
      "to discover related memories across multiple hops. Better than simple keyword search for finding contextually related information. " +
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
          id: r.atom.id,
          content: r.atom.content,
          score: r.score,
          depth: r.depth,
          tags: r.atom.tags,
        }));

        return {
          content: [{ type: "text" as const, text: formatRecallResult(result) }],
          details: {
            count: result.results.length,
            totalFound: result.total_found,
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
            const atom = result.results[0].atom;
            await client.delete(atom.id, true);
            return {
              content: [{ type: "text" as const, text: `Forgotten: "${atom.content.slice(0, 80)}..."` }],
              details: { action: "deleted", id: atom.id },
            };
          }

          // Multiple candidates → list for user to choose
          const list = result.results
            .map(
              (r) =>
                `- [ID:${r.atom.id}] (${(r.score * 100).toFixed(0)}%) "${r.atom.content.slice(0, 80)}..."`,
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
                id: r.atom.id,
                content: r.atom.content,
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

  return { storeTool, recallTool, forgetTool };
}
