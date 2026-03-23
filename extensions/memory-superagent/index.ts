/**
 * Clawdbot Memory (SuperAgentMemory) Plugin
 *
 * Integrates SuperAgentMemory's neural-network-style long-term memory
 * into the Clawdbot Agent system. Provides:
 *   - Agent tools: supermemory_store, supermemory_recall, supermemory_forget
 *   - Auto-recall: injects relevant memories before agent starts (ripple retrieval)
 *   - Auto-capture: extracts and stores important info after agent ends
 *   - CLI: clawdbot supermemory commands for management
 */

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { superMemoryConfigSchema, type SuperMemoryConfig } from "./config.js";
import { SuperMemoryClient, SuperMemoryError } from "./client.js";
import { createTools } from "./tools.js";
import { findCapturableTexts } from "./capture.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "memory-superagent",
  name: "Memory (SuperAgentMemory)",
  description:
    "Neural-network-style long-term memory with ripple retrieval, auto-evolution, and synapse connections",
  kind: "memory" as const,
  configSchema: superMemoryConfigSchema,

  register(api: ClawdbotPluginApi) {
    const cfg = superMemoryConfigSchema.parse(api.pluginConfig);
    const client = new SuperMemoryClient({
      baseUrl: cfg.server.baseUrl,
      apiKey: cfg.server.apiKey,
      timeout: 10_000,
      maxRetries: 1,
    });

    // Session key accessor (set per-agent-turn via tool factory closure)
    let currentSessionKey: string | undefined;
    const getSessionKey = () => currentSessionKey;

    api.logger.info(
      `memory-superagent: plugin registered (server: ${cfg.server.baseUrl}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
    );

    // ========================================================================
    // Agent Tools
    // ========================================================================

    const { storeTool, recallTool, forgetTool } = createTools({
      client,
      config: cfg,
      getSessionKey,
    });

    api.registerTool(storeTool, { name: "supermemory_store" });
    api.registerTool(recallTool, { name: "supermemory_recall" });
    api.registerTool(forgetTool, { name: "supermemory_forget" });

    // ========================================================================
    // Auto-Recall Hook: inject relevant memories before agent starts
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) return;

        // Track session key for this turn
        currentSessionKey = ctx.sessionKey;

        try {
          const result = await client.retrieve({
            query: event.prompt,
            agent_id: ctx.sessionKey,
            max_results: 3,
            max_depth: cfg.defaults.maxDepth,
            decay_factor: cfg.defaults.decayFactor,
            min_strength: cfg.defaults.minStrength,
          });

          if (result.results.length === 0) return;

          const memoryContext = result.results
            .map(
              (r) =>
                `- [${r.keywords?.join(",") ?? r.tags?.join(",") ?? "general"}] ${r.content}`,
            )
            .join("\n");

          api.logger.info?.(
            `memory-superagent: injecting ${result.results.length} memories (depth: ${result.results.map((r) => r.depth).join(",")})`,
          );

          return {
            prependContext: `<superagent-memories>\nThe following memories from SuperAgentMemory may be relevant:\n${memoryContext}\n</superagent-memories>`,
          };
        } catch (err) {
          if (err instanceof SuperMemoryError && err.code === "CONNECTION_ERROR") {
            api.logger.warn(
              `memory-superagent: server not reachable at ${cfg.server.baseUrl}, skipping auto-recall`,
            );
          } else {
            api.logger.warn(
              `memory-superagent: auto-recall failed: ${String(err)}`,
            );
          }
          // Graceful degradation: return no context
        }
      });
    }

    // ========================================================================
    // Auto-Capture Hook: store important info after agent ends
    // ========================================================================

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          const capturable = findCapturableTexts(event.messages, 3);
          if (capturable.length === 0) return;

          let stored = 0;
          for (const { text, category } of capturable) {
            try {
              const result = await client.store({
                content: text,
                agent_id: ctx.sessionKey,
                importance: category === "preference" ? 0.85 : cfg.defaults.importance,
                tags: [category],
                auto_link: true,
                deduplicate: true,
              });

              if (!result.is_duplicate) {
                stored++;
              }
            } catch {
              // Continue with next item on individual store failure
            }
          }

          if (stored > 0) {
            api.logger.info?.(
              `memory-superagent: auto-captured ${stored} memories`,
            );
          }
        } catch (err) {
          if (err instanceof SuperMemoryError && err.code === "CONNECTION_ERROR") {
            api.logger.warn(
              `memory-superagent: server not reachable, skipping auto-capture`,
            );
          } else {
            api.logger.warn(
              `memory-superagent: auto-capture failed: ${String(err)}`,
            );
          }
        }
      });
    }

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const sm = program
          .command("supermemory")
          .description("SuperAgentMemory plugin commands");

        sm.command("health")
          .description("Check SuperAgentMemory server health")
          .action(async () => {
            try {
              const health = await client.healthCheck();
              console.log(
                `SuperAgentMemory: ${health.status}${health.version ? ` (v${health.version})` : ""}`,
              );
              if (health.database) {
                console.log(`Database: ${health.database}`);
              }
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Health check failed: ${msg}`);
              process.exit(1);
            }
          });

        sm.command("search")
          .description("Search memories via ripple retrieval")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", String(cfg.defaults.maxResults))
          .option("--depth <n>", "Ripple depth", String(cfg.defaults.maxDepth))
          .action(async (query, opts) => {
            try {
              const result = await client.retrieve({
                query,
                max_results: parseInt(opts.limit),
                max_depth: parseInt(opts.depth),
                decay_factor: cfg.defaults.decayFactor,
                min_strength: cfg.defaults.minStrength,
              });

              if (result.results.length === 0) {
                console.log("No memories found.");
                return;
              }

              console.log(`Found ${result.total_results ?? result.total_found ?? result.results.length} memories:\n`);
              for (let i = 0; i < result.results.length; i++) {
                const r = result.results[i];
                const score = (r.score * 100).toFixed(0);
                const tags = r.keywords?.length ? ` [${r.keywords.join(", ")}]` : 
                             r.tags?.length ? ` [${r.tags.join(", ")}]` : "";
                console.log(
                  `${i + 1}. [ID:${r.id}] (${score}%)${tags} depth=${r.depth}`,
                );
                console.log(`   ${r.content.slice(0, 200)}`);
                if (r.path && r.path.length > 0) {
                  console.log(`   Path: ${r.path.join(" → ")}`);
                }
                console.log();
              }
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Search failed: ${msg}`);
              process.exit(1);
            }
          });

        sm.command("store")
          .description("Store a new memory")
          .argument("<content>", "Content to store")
          .option("--importance <n>", "Importance 0-1", String(cfg.defaults.importance))
          .option("--tags <tags>", "Comma-separated tags", "")
          .action(async (content, opts) => {
            try {
              const result = await client.store({
                content,
                importance: parseFloat(opts.importance),
                tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : undefined,
                auto_link: true,
                deduplicate: true,
              });

              if (result.is_duplicate) {
                console.log("Similar memory already exists:");
                for (const a of result.similar_atoms ?? []) {
                  console.log(
                    `  [${a.id}] "${a.content.slice(0, 80)}..." (${(a.similarity * 100).toFixed(0)}%)`,
                  );
                }
              } else {
                console.log(`Stored (ID: ${result.atom.id})`);
                if (result.synapses_created && result.synapses_created > 0) {
                  console.log(`Auto-linked: ${result.synapses_created} synapses`);
                }
              }
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Store failed: ${msg}`);
              process.exit(1);
            }
          });

        sm.command("stats")
          .description("Show memory statistics")
          .action(async () => {
            try {
              const result = await client.retrieve({
                query: "__stats__",
                max_results: 1,
                max_depth: 0,
              });
              console.log(
                `SuperAgentMemory connected at ${cfg.server.baseUrl}`,
              );
              console.log(`Retrieval engine: operational`);
              // Note: for detailed stats, use /v1/stats endpoint
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Stats check failed: ${msg}`);
              process.exit(1);
            }
          });
      },
      { commands: ["supermemory"] },
    );

    // ========================================================================
    // Service (lifecycle logging)
    // ========================================================================

    api.registerService({
      id: "memory-superagent",
      start: () => {
        api.logger.info(
          `memory-superagent: service started (server: ${cfg.server.baseUrl})`,
        );
      },
      stop: () => {
        api.logger.info("memory-superagent: service stopped");
      },
    });
  },
};

export default memoryPlugin;
