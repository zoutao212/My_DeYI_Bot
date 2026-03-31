/**
 * Clawdbot Memory (SuperAgentMemory) Plugin - Deep Integration
 *
 * Integrates SuperAgentMemory's neural-network-style long-term memory
 * into the Clawdbot Agent system with deep integration:
 *   - Agent tools: supermemory_store, supermemory_recall, supermemory_forget
 *   - Auto-recall: Enhanced retrieval with intelligent routing, ranking, scoring
 *   - Auto-capture: Enhanced capture with category classification
 *   - Synapse dynamics: Automatic activation on retrieval/capture
 *   - Evolution engine: Periodic memory network evolution
 *   - Lifecycle hooks: Comprehensive lifecycle management
 *   - CLI: Advanced commands for management
 */

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { superMemoryConfigSchema, type SuperMemoryConfig, type AutoCaptureConfig } from "./config.js";
import {
  SuperMemoryClient,
  SuperMemoryError,
  type EnhancedRetrieveStats,
  type DashboardStatsResponse,
  type MemoryHealthCheckResponse,
} from "./client.js";
import { createTools } from "./tools.js";
import { findCapturableTexts } from "./capture.js";
import { QueryExpander, type ExpandedQuery } from "./query-expander.js";
import { QueryExpanderV2, decomposeQuery } from "./query-expander-v2.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "memory-superagent",
  name: "Memory (SuperAgentMemory) - Deep Integration",
  description:
    "Neural-network-style long-term memory with enhanced retrieval, intelligent scoring, synapse dynamics, and autonomous evolution",
  kind: "memory" as const,
  configSchema: superMemoryConfigSchema,

  register(api: ClawdbotPluginApi) {
    const cfg = superMemoryConfigSchema.parse(api.pluginConfig);
    const client = new SuperMemoryClient({
      baseUrl: cfg.server.baseUrl,
      apiKey: cfg.server.apiKey,
      timeout: 60_000,  // 🔧 增加到 60 秒，给复杂的检索查询足够时间
      maxRetries: 1,
    });

    // ========================================================================
    // State Management
    // ========================================================================

    // Session key accessor (set per-agent-turn via tool factory closure)
    let currentSessionKey: string | undefined;
    const getSessionKey = () => currentSessionKey;

    // Enhanced retrieval support detection
    let useEnhancedRetrieval = false;
    let useEnhancedCapture = cfg.autoCaptureConfig?.useEnhancedCapture ?? true;

    // Evolution tracking
    let sessionCountSinceEvolution = 0;
    const evolutionInterval = cfg.evolution?.evolutionIntervalSessions ?? 10;

    // Multi-agent support: accessible agent IDs
    let accessibleAgentIds: string[] = [];

    // Initialize capabilities detection
    client.getCapabilities().then((caps) => {
      useEnhancedRetrieval = caps.capabilities.retrieval_modes.includes("enhanced");
      useEnhancedCapture = caps.capabilities.features.batch_operations ?? useEnhancedCapture;
      api.logger.info(
        `memory-superagent: enhanced retrieval ${useEnhancedRetrieval ? "enabled" : "disabled"}, ` +
          `enhanced capture ${useEnhancedCapture ? "enabled" : "disabled"} ` +
          `(server: ${cfg.server.baseUrl})`
      );
    }).catch(() => {
      api.logger.info(
        `memory-superagent: using legacy mode (server: ${cfg.server.baseUrl})`
      );
    });

    // 🔥 启动时预热系统：调用 health check 触发 AgentMemorySystem 初始化
    client.healthCheck().then((health) => {
      api.logger.info(
        `memory-superagent: 🔥 system pre-warmed ` +
          `(server: ${cfg.server.baseUrl}, status: ${health.status})`
      );
    }).catch((err) => {
      api.logger.warn(
        `memory-superagent: ⚠️ pre-warm failed, will retry on first query ` +
          `(server: ${cfg.server.baseUrl})`
      );
    });

    api.logger.info(
      `memory-superagent: plugin registered ` +
        `(server: ${cfg.server.baseUrl}, ` +
        `autoRecall: ${cfg.autoRecall}, ` +
        `autoCapture: ${cfg.autoCapture}, ` +
        `autoEvolution: ${cfg.evolution?.enableAutoEvolution ?? false})`
    );

    // ========================================================================
    // Agent Tools
    // ========================================================================

    const { storeTool, recallTool, forgetTool, statsTool, evolveTool, healthTool } = createTools({
      client,
      config: cfg,
      getSessionKey,
    });

    api.registerTool(storeTool, { name: "supermemory_store" });
    api.registerTool(recallTool, { name: "supermemory_recall" });
    api.registerTool(forgetTool, { name: "supermemory_forget" });
    api.registerTool(statsTool, { name: "supermemory_stats" });
    api.registerTool(evolveTool, { name: "supermemory_evolve" });
    api.registerTool(healthTool, { name: "supermemory_health" });

    // ========================================================================
    // Helper Functions
    // ========================================================================

    /**
     * Format memory line for legacy retrieval
     */
    function formatMemoryLine(r: {
      id: string;
      content: string;
      score: number;
      keywords?: string[];
      tags?: string[];
      depth: number;
    }): string {
      const score = (r.score * 100).toFixed(0);
      const tags = r.keywords?.length ? `[${r.keywords.join(", ")}]` :
                   r.tags?.length ? `[${r.tags.join(", ")}]` : "";
      return `- [ID:${r.id}] (${score}%) ${tags}\n  ${r.content.slice(0, 150)}${r.content.length > 150 ? "..." : ""}`;
    }

    /**
     * Format detailed memory log for debugging
     */
    function formatMemoryLog(r: {
      id: string;
      content: string;
      score: number;
      depth: string | number;
      keywords?: string[];
    }): string {
      const score = (r.score * 100).toFixed(0);
      const preview = r.content.slice(0, 80).replace(/\n/g, " ");
      const keywords = r.keywords?.length ? ` [${r.keywords.slice(0, 3).join(", ")}]` : "";
      return `[${r.id}](${score}%, ${r.depth})${keywords}: ${preview}${r.content.length > 80 ? "..." : ""}`;
    }

    /**
     * Format memory line for enhanced retrieval (with quality factors)
     */
    function formatMemoryLineEnhanced(r: {
      id: string;
      content: string;
      score: number;
      keywords?: string[];
      tags?: string[];
      depth: number;
      quality_factors?: {
        freshness: number;
        importance: number;
        activation: number;
        connectivity: number;
        confidence: number;
        overall: number;
      };
    }): string {
      const score = (r.score * 100).toFixed(0);
      const tags = r.keywords?.length ? `[${r.keywords.join(", ")}]` :
                   r.tags?.length ? `[${r.tags.join(", ")}]` : "";
      const qualityBadge = r.quality_factors
        ? ` quality=${(r.quality_factors.overall * 100).toFixed(0)}%`
        : "";
      return `- [ID:${r.id}] (${score}%) ${tags}${qualityBadge}\n  ${r.content.slice(0, 150)}${r.content.length > 150 ? "..." : ""}`;
    }

    /**
     * Build memory context XML block
     */
    function buildMemoryContext(
      memoryContext: string,
      analysis: { queryType: string; entities: string[]; focus: string; searchStrategy: string }
    ): string {
      const entityHint = analysis.entities.length > 0
        ? `\nDetected entities: ${analysis.entities.join(", ")}`
        : "";
      const focusHint = analysis.focus
        ? `\nQuery focus: ${analysis.focus}`
        : "";

      return `<superagent-memories>
The following memories from SuperAgentMemory may be relevant to your query:
${memoryContext}
${entityHint}${focusHint}
</superagent-memories>`;
    }

    // ========================================================================
    // Auto-Recall Hook: Enhanced proactive memory retrieval
    // ========================================================================

    if (cfg.autoRecall) {
      // Create Query Expander instance
      const queryExpander = new QueryExpander(
        cfg.activeRecall?.maxExpansions ?? 5,
        0.8,
        cfg.activeRecall?.enableQueryExpansion ?? true
      );

      api.on("before_agent_start", async (event, ctx) => {
        const activeRecallCfg = cfg.activeRecall;
        const minLen = activeRecallCfg?.minQueryLength ?? 5;

        // Skip if query too short
        if (!event.prompt || event.prompt.length < minLen) return;

        // Track session key and accessible agents for this turn
        currentSessionKey = ctx.sessionKey;

        // Update accessible agent IDs (can be configured or detected)
        if (activeRecallCfg?.enableMultiAgentRetrieval && ctx.agentIds) {
          accessibleAgentIds = ctx.agentIds.filter(id => id !== ctx.sessionKey);
        }

        try {
          // ========================================
          // Step 1: Query Analysis & Expansion (V2)
          // ========================================
          
          // 使用 V2 版本进行智能查询拆分
          const decomposition = decomposeQuery(event.prompt);
          const searchQueries = decomposition.subQueries;
          
          // 也使用旧版本进行分析（用于获取查询焦点等信息）
          const analysis = queryExpander.analyze(event.prompt);

          if (activeRecallCfg?.debugStrategy) {
            api.logger.info?.(
              `memory-superagent: query decomposition - strategy=${decomposition.strategy}, ` +
                `confidence=${decomposition.confidence}, ` +
                `subQueries=${searchQueries.length}`
            );
            api.logger.info?.(
              `memory-superagent: expanded queries: ` +
                `[${searchQueries.slice(0, 5).map((q) => `"${q.text}"(${q.weight})`).join(", ")}]`
            );
          }

          // ========================================
          // Step 2: Enhanced or Legacy Retrieval
          // ========================================
          const maxMemories = activeRecallCfg?.maxContextMemories ?? 5;

          if (useEnhancedRetrieval) {
            // ========================================
            // Enhanced Retrieval (UnifiedRetrievalPipeline)
            // Uses server-side: query complexity analysis, intelligent ranking,
            // quality scoring, summarization, and synapse dynamics
            // ========================================
            const enhancedResult = await client.enhancedRetrieve({
              query: event.prompt,
              agent_id: ctx.sessionKey,
              max_results: maxMemories,
              max_depth: cfg.defaults.maxDepth,
              // Retrieval configuration
              use_fast_path: true,
              use_intelligent_ranking: true,
              use_quality_scoring: true,
              use_summarization: true,
              max_context_tokens: 4000,
              // Multi-agent support
              accessible_agent_ids: activeRecallCfg?.enableMultiAgentRetrieval ? accessibleAgentIds : undefined,
              // Session scoping
              session_ids: activeRecallCfg?.enableSessionScoping ? [ctx.sessionKey] : undefined,
            });

            if (enhancedResult.results.length === 0) return;

            const memoryContext = enhancedResult.results
              .map((r) => formatMemoryLineEnhanced(r))
              .join("\n");

            // 🔥 增强日志：输出每个 memory 的详细内容
            const memoryDetails = enhancedResult.results
              .slice(0, 5)
              .map((r) => formatMemoryLog(r))
              .join("\n  ");
            
            api.logger.info?.(
              `memory-superagent: injecting ${enhancedResult.results.length} memories (enhanced mode)\n  ${memoryDetails}`
            );

            if (activeRecallCfg?.debugStrategy) {
              const stats = enhancedResult.stats;
              api.logger.info?.(
                `memory-superagent: enhanced retrieval - ` +
                  `path=${stats.path_taken}, complexity=${stats.query_complexity}, ` +
                  `initial=${stats.initial_results}, final=${stats.final_results}, ` +
                  `total_time=${stats.total_time_ms.toFixed(1)}ms` +
                  (stats.summarization_triggered ? `, summarized` : "") +
                  (stats.ripple_synapses_activated
                    ? `, synapses_activated=${stats.ripple_synapses_activated}`
                    : "")
              );
            }

            return {
              prependContext: buildMemoryContext(memoryContext, analysis),
              debug: activeRecallCfg?.debugStrategy
                ? { retrievalStats: enhancedResult.stats }
                : undefined,
            };
          } else {
            // ========================================
            // Legacy Multi-Query Retrieval
            // Client-side query expansion + RRF fusion
            // ========================================
            const maxQueries = activeRecallCfg?.maxParallelQueries ?? 3;
            const topQueries = searchQueries.slice(0, maxQueries);

            // Execute multi-query retrieval
            const multiResult = await client.multiRetrieve(
              topQueries.map((q) => q.text),
              {
                agent_id: ctx.sessionKey,
                max_results: maxMemories,
                max_depth: cfg.defaults.maxDepth,
                decay_factor: cfg.defaults.decayFactor,
                min_strength: cfg.defaults.minStrength,
                accessible_agent_ids: activeRecallCfg?.enableMultiAgentRetrieval ? accessibleAgentIds : undefined,
              },
              {
                maxParallel: maxQueries,
                fuseStrategy: "rrf",
              }
            );

            // Fallback to simple retrieval if multi-retrieve returns nothing
            if (multiResult.results.length === 0) {
              const simpleResult = await client.retrieve({
                query: event.prompt,
                agent_id: ctx.sessionKey,
                max_results: 3,
                max_depth: cfg.defaults.maxDepth,
                decay_factor: cfg.defaults.decayFactor,
                min_strength: cfg.defaults.minStrength,
              });

              if (simpleResult.results.length === 0) return;

              const memoryContext = simpleResult.results
                .map((r) => formatMemoryLine(r))
                .join("\n");

              // 🔥 增强日志：输出每个 memory 的详细内容
              const memoryDetails = simpleResult.results
                .slice(0, 5)
                .map((r) => formatMemoryLog(r))
                .join("\n  ");
              
              api.logger.info?.(
                `memory-superagent: injecting ${simpleResult.results.length} memories (simple mode)\n  ${memoryDetails}`
              );

              return {
                prependContext: buildMemoryContext(memoryContext, analysis),
              };
            }

            // ========================================
            // Step 3: Build Context for LLM
            // ========================================
            const topResults = multiResult.results.slice(0, maxMemories);

            const memoryContext = topResults.map((r) => formatMemoryLine(r)).join("\n");

            // 🔥 增强日志：输出每个 memory 的详细内容
            const memoryDetails = topResults
              .map((r) => formatMemoryLog(r))
              .join("\n  ");
            
            api.logger.info?.(
              `memory-superagent: injecting ${topResults.length} memories ` +
                `(from ${multiResult.queryCount} queries, fusion=${multiResult.fusionMethod})\n  ${memoryDetails}`
            );

            return {
              prependContext: buildMemoryContext(memoryContext, analysis),
            };
          }
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
    // Auto-Capture Hook: Enhanced store important info after agent ends
    // ========================================================================

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        const autoCaptureCfg = cfg.autoCaptureConfig ?? {
          useEnhancedCapture: true,
          maxCaptureItems: 10,
          activateSynapsesOnCapture: true,
          captureCategories: ["preference", "decision", "fact", "action", "general"] as const,
          importanceThreshold: 0.5,
        };

        try {
          const capturable = findCapturableTexts(event.messages, autoCaptureCfg.maxCaptureItems);
          if (capturable.length === 0) return;

          if (useEnhancedCapture && autoCaptureCfg.useEnhancedCapture) {
            // ========================================
            // Enhanced Capture Mode
            // Uses enhanced_capture API with category classification
            // ========================================
            const captureItems = capturable.map(({ text, category }) => ({
              content: text,
              category: category as "preference" | "decision" | "fact" | "action" | "general",
              importance: category === "preference" ? 0.85 : cfg.defaults.importance,
            }));

            const captureResult = await client.enhancedCapture({
              items: captureItems,
              agent_id: ctx.sessionKey,
              session_id: ctx.sessionKey,
              source: "agent_capture",
              deduplicate: true,
              activate_synapses: autoCaptureCfg.activateSynapsesOnCapture,
            });

            if (captureResult.captured > 0) {
              api.logger.info?.(
                `memory-superagent: enhanced capture - ` +
                  `captured=${captureResult.captured}, ` +
                  `duplicates=${captureResult.duplicates}, ` +
                  `synapses_activated=${captureResult.synapses_activated}`
              );
            }
          } else {
            // ========================================
            // Legacy Capture Mode
            // Uses individual store API calls
            // ========================================
            let stored = 0;
            for (const { text, category } of capturable) {
              try {
                const result = await client.store({
                  content: text,
                  agent_id: ctx.sessionKey,
                  session_id: ctx.sessionKey,
                  importance: category === "preference" ? 0.85 : cfg.defaults.importance,
                  tags: [category],
                  auto_link: autoCaptureCfg.activateSynapsesOnCapture,
                  deduplicate: true,
                });

                if (!result.is_duplicate && !result.duplicate) {
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
          }

          // ========================================
          // Track sessions for evolution trigger
          // ========================================
          if (cfg.evolution?.enableAutoEvolution) {
            sessionCountSinceEvolution++;
            if (sessionCountSinceEvolution >= evolutionInterval) {
              sessionCountSinceEvolution = 0;
              api.logger.info?.(
                `memory-superagent: triggering scheduled evolution ` +
                  `(interval: ${evolutionInterval} sessions)`
              );
              // Trigger evolution in background
              client.triggerEvolution({
                phases: ["grow", "prune", "reinforce"],
                background: cfg.evolution.backgroundEvolution ?? true,
              }).catch((err) => {
                api.logger.warn?.(`memory-superagent: evolution trigger failed: ${String(err)}`);
              });
            }
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
          .description("Check SuperAgentMemory server health and component status")
          .action(async () => {
            try {
              const health = await client.memoryHealthCheck();
              console.log(
                `SuperAgentMemory: ${health.status}${health.version ? ` (v${health.version})` : ""}`,
              );
              console.log("\nComponent Status:");
              for (const [component, status] of Object.entries(health.checks)) {
                console.log(`  ${component}: ${status ? "✓" : "✗"}`);
              }
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Health check failed: ${msg}`);
              process.exit(1);
            }
          });

        sm.command("stats")
          .description("Show memory system statistics dashboard")
          .action(async () => {
            try {
              const stats = await client.getDashboardStats();
              console.log(`\n📊 Memory System Dashboard (${stats.timestamp})`);
              console.log("\n🧠 Memory:");
              console.log(`  Total atoms: ${stats.memory.total_atoms}`);
              console.log(`  Active: ${stats.memory.active_atoms}`);
              console.log(`  Archived: ${stats.memory.archived_atoms}`);
              console.log(`  Avg importance: ${(stats.memory.avg_importance * 100).toFixed(1)}%`);
              console.log("\n🔗 Synapses:");
              console.log(`  Total: ${stats.synapses.total_synapses}`);
              console.log(`  Active: ${stats.synapses.active_synapses}`);
              console.log(`  Avg strength: ${(stats.synapses.avg_strength * 100).toFixed(1)}%`);
              console.log("\n🏷️  Keywords:");
              console.log(`  Total: ${stats.keywords.total_keywords}`);
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Stats check failed: ${msg}`);
              process.exit(1);
            }
          });

        sm.command("search")
          .description("Search memories via enhanced retrieval")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", String(cfg.defaults.maxResults))
          .option("--depth <n>", "Ripple depth", String(cfg.defaults.maxDepth))
          .option("--enhanced", "Use enhanced retrieval", String(useEnhancedRetrieval))
          .action(async (query, opts) => {
            try {
              const useEnhanced = opts.enhanced === "true" && useEnhancedRetrieval;

              if (useEnhanced) {
                const result = await client.enhancedRetrieve({
                  query,
                  max_results: parseInt(opts.limit),
                  max_depth: parseInt(opts.depth),
                });

                if (result.results.length === 0) {
                  console.log("No memories found.");
                  return;
                }

                console.log(`Found ${result.total_results} memories (enhanced mode):\n`);
                console.log(`Stats: path=${result.stats.path_taken}, complexity=${result.stats.query_complexity}, time=${result.stats.total_time_ms.toFixed(1)}ms\n`);

                for (let i = 0; i < result.results.length; i++) {
                  const r = result.results[i];
                  const score = (r.score * 100).toFixed(0);
                  const quality = r.quality_factors
                    ? ` quality=${(r.quality_factors.overall * 100).toFixed(0)}%`
                    : "";
                  console.log(
                    `${i + 1}. [ID:${r.id}] (${score}%)${quality} depth=${r.depth}`,
                  );
                  console.log(`   ${r.content.slice(0, 200)}`);
                  if (r.path && r.path.length > 0) {
                    console.log(`   Path: ${r.path.join(" → ")}`);
                  }
                  console.log();
                }
              } else {
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

                console.log(`Found ${result.total_results} memories:\n`);

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

              if (result.duplicate || result.is_duplicate) {
                console.log("Similar memory already exists:");
                for (const a of result.similar_atoms ?? []) {
                  console.log(
                    `  [${a.id}] "${a.content.slice(0, 80)}..." (${(a.similarity * 100).toFixed(0)}%)`,
                  );
                }
              } else {
                console.log(`Stored (ID: ${result.id})`);
                if (result.synapses_count && result.synapses_count > 0) {
                  console.log(`Auto-linked: ${result.synapses_count} synapses`);
                }
              }
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Store failed: ${msg}`);
              process.exit(1);
            }
          });

        sm.command("evolve")
          .description("Trigger memory network evolution")
          .option("--phases <phases>", "Comma-separated phases (grow,prune,reinforce,cluster)", "")
          .option("--background", "Run in background", String(cfg.evolution?.backgroundEvolution ?? true))
          .action(async (opts) => {
            try {
              const phases = opts.phases
                ? opts.phases.split(",").map((p: string) => p.trim())
                : undefined;
              const background = opts.background === "true";

              console.log(`Triggering evolution (phases: ${phases?.join(",") ?? "all"}, background: ${background})...`);

              const result = await client.triggerEvolution({ phases, background });

              if (background) {
                console.log(`Evolution started in ${background ? "background" : "foreground"}`);
              } else {
                console.log(`Evolution completed:`);
                if (result.metrics) {
                  console.log(`  Synapses created: ${result.metrics.synapses_created ?? 0}`);
                  console.log(`  Synapses pruned: ${result.metrics.synapses_pruned ?? 0}`);
                  console.log(`  Synapses strengthened: ${result.metrics.synapses_strengthened ?? 0}`);
                  console.log(`  Clusters formed: ${result.metrics.clusters_formed ?? 0}`);
                }
              }
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Evolution trigger failed: ${msg}`);
              process.exit(1);
            }
          });

        sm.command("capabilities")
          .description("Show memory system capabilities")
          .action(async () => {
            try {
              const caps = await client.getCapabilities();
              console.log(`\n🔧 Memory System Capabilities (v${caps.version})\n`);

              console.log("Retrieval Modes:");
              for (const mode of caps.capabilities.retrieval_modes) {
                console.log(`  - ${mode}`);
              }

              console.log("\nFeatures:");
              for (const [feature, enabled] of Object.entries(caps.capabilities.features)) {
                console.log(`  ${feature}: ${enabled ? "✓" : "✗"}`);
              }
            } catch (err) {
              const msg = err instanceof SuperMemoryError ? err.message : String(err);
              console.error(`Capabilities check failed: ${msg}`);
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
          `memory-superagent: service started ` +
            `(server: ${cfg.server.baseUrl}, ` +
            `enhanced: ${useEnhancedRetrieval && useEnhancedCapture})`
        );
      },
      stop: () => {
        api.logger.info("memory-superagent: service stopped");
      },
    });
  },
};

export default memoryPlugin;
