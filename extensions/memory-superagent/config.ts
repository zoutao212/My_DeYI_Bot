/**
 * SuperAgentMemory Plugin Configuration
 *
 * Defines configuration types, defaults, and schema validation.
 */

// ============================================================================
// Types
// ============================================================================

export type SuperMemoryServerConfig = {
  baseUrl: string;
  apiKey: string;
};

export type SuperMemoryDefaultsConfig = {
  maxResults: number;
  maxDepth: number;
  importance: number;
  decayFactor: number;
  minStrength: number;
};

/**
 * Active recall strategy configuration
 * Controls how the system proactively retrieves relevant memories
 */
export type ActiveRecallConfig = {
  /** Enable intelligent query expansion before retrieval */
  enableQueryExpansion: boolean;
  /** Maximum number of expanded queries to execute in parallel */
  maxParallelQueries: number;
  /** Maximum number of sub-queries to generate */
  maxExpansions: number;
  /** Minimum query length to trigger active recall (skip short queries) */
  minQueryLength: number;
  /** Inject retrieved memories as context for LLM */
  injectContext: boolean;
  /** Maximum memories to inject into context */
  maxContextMemories: number;
  /** Show search strategy in logs for debugging */
  debugStrategy: boolean;
  /** Pass accessible_agent_ids for multi-agent retrieval */
  enableMultiAgentRetrieval: boolean;
  /** Pass session_ids for session-scoped retrieval */
  enableSessionScoping: boolean;
};

/**
 * Auto-capture configuration
 * Controls how important information is extracted and stored
 */
export type AutoCaptureConfig = {
  /** Enable enhanced capture API (with category classification) */
  useEnhancedCapture: boolean;
  /** Maximum items to capture per agent session */
  maxCaptureItems: number;
  /** Enable synapse activation after capture */
  activateSynapsesOnCapture: boolean;
  /** Custom capture categories */
  captureCategories: Array<"preference" | "decision" | "fact" | "action" | "general">;
  /** Importance threshold for auto-capture */
  importanceThreshold: number;
};

/**
 * Evolution configuration
 * Controls periodic memory network evolution
 */
export type EvolutionConfig = {
  /** Enable periodic evolution triggers */
  enableAutoEvolution: boolean;
  /** Minimum interval between evolution triggers (in agent sessions) */
  evolutionIntervalSessions: number;
  /** Run evolution in background (non-blocking) */
  backgroundEvolution: boolean;
};

export type SuperMemoryConfig = {
  server: SuperMemoryServerConfig;
  autoCapture: boolean;
  autoRecall: boolean;
  /** Active recall strategy configuration (enhanced autoRecall) */
  activeRecall?: ActiveRecallConfig;
  /** Auto-capture configuration */
  autoCaptureConfig?: AutoCaptureConfig;
  /** Evolution configuration */
  evolution?: EvolutionConfig;
  defaults: SuperMemoryDefaultsConfig;
};

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_BASE_URL = "http://localhost:8080";
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_IMPORTANCE = 0.7;
const DEFAULT_DECAY_FACTOR = 0.6;
const DEFAULT_MIN_STRENGTH = 0.3;

/** Default active recall configuration */
const DEFAULT_ACTIVE_RECALL: ActiveRecallConfig = {
  enableQueryExpansion: true,
  maxParallelQueries: 3,
  maxExpansions: 5,
  minQueryLength: 5,
  injectContext: true,
  maxContextMemories: 5,
  debugStrategy: false,
  enableMultiAgentRetrieval: false,
  enableSessionScoping: false,
};

/** Default auto-capture configuration */
const DEFAULT_AUTO_CAPTURE: AutoCaptureConfig = {
  useEnhancedCapture: true,
  maxCaptureItems: 10,
  activateSynapsesOnCapture: true,
  captureCategories: ["preference", "decision", "fact", "action", "general"],
  importanceThreshold: 0.5,
};

/** Default evolution configuration */
const DEFAULT_EVOLUTION: EvolutionConfig = {
  enableAutoEvolution: false,
  evolutionIntervalSessions: 10,
  backgroundEvolution: true,
};

// ============================================================================
// Validation helpers
// ============================================================================

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

// ============================================================================
// Config Schema
// ============================================================================

export const superMemoryConfigSchema = {
  parse(value: unknown): SuperMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-superagent config required");
    }

    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["server", "autoCapture", "autoRecall", "activeRecall", "autoCaptureConfig", "evolution", "defaults"],
      "memory-superagent config",
    );

    // Parse server config
    const server = cfg.server as Record<string, unknown> | undefined;
    if (!server) {
      throw new Error("server config is required");
    }
    assertAllowedKeys(server, ["baseUrl", "apiKey"], "server config");

    // apiKey is optional for local testing (when server has no auth)
    const apiKey =
      typeof server.apiKey === "string" ? resolveEnvVars(server.apiKey.trim()) : "";

    const baseUrl =
      typeof server.baseUrl === "string" && server.baseUrl.trim()
        ? server.baseUrl.replace(/\/+$/, "")
        : DEFAULT_BASE_URL;

    // Parse defaults config
    const defaults = cfg.defaults as Record<string, unknown> | undefined;
    const parsedDefaults: SuperMemoryDefaultsConfig = {
      maxResults:
        typeof defaults?.maxResults === "number"
          ? Math.max(1, Math.min(50, defaults.maxResults))
          : DEFAULT_MAX_RESULTS,
      maxDepth:
        typeof defaults?.maxDepth === "number"
          ? Math.max(1, Math.min(5, Math.round(defaults.maxDepth)))
          : DEFAULT_MAX_DEPTH,
      importance:
        typeof defaults?.importance === "number"
          ? Math.max(0, Math.min(1, defaults.importance))
          : DEFAULT_IMPORTANCE,
      decayFactor:
        typeof defaults?.decayFactor === "number"
          ? Math.max(0, Math.min(1, defaults.decayFactor))
          : DEFAULT_DECAY_FACTOR,
      minStrength:
        typeof defaults?.minStrength === "number"
          ? Math.max(0, Math.min(1, defaults.minStrength))
          : DEFAULT_MIN_STRENGTH,
    };

    // Parse activeRecall config
    const activeRecallConfig = cfg.activeRecall as Record<string, unknown> | undefined;
    const parsedActiveRecall: ActiveRecallConfig = {
      enableQueryExpansion:
        typeof activeRecallConfig?.enableQueryExpansion === "boolean"
          ? activeRecallConfig.enableQueryExpansion
          : DEFAULT_ACTIVE_RECALL.enableQueryExpansion,
      maxParallelQueries:
        typeof activeRecallConfig?.maxParallelQueries === "number"
          ? Math.max(1, Math.min(10, activeRecallConfig.maxParallelQueries))
          : DEFAULT_ACTIVE_RECALL.maxParallelQueries,
      maxExpansions:
        typeof activeRecallConfig?.maxExpansions === "number"
          ? Math.max(1, Math.min(10, activeRecallConfig.maxExpansions))
          : DEFAULT_ACTIVE_RECALL.maxExpansions,
      minQueryLength:
        typeof activeRecallConfig?.minQueryLength === "number"
          ? Math.max(1, Math.min(50, activeRecallConfig.minQueryLength))
          : DEFAULT_ACTIVE_RECALL.minQueryLength,
      injectContext:
        typeof activeRecallConfig?.injectContext === "boolean"
          ? activeRecallConfig.injectContext
          : DEFAULT_ACTIVE_RECALL.injectContext,
      maxContextMemories:
        typeof activeRecallConfig?.maxContextMemories === "number"
          ? Math.max(1, Math.min(20, activeRecallConfig.maxContextMemories))
          : DEFAULT_ACTIVE_RECALL.maxContextMemories,
      debugStrategy:
        typeof activeRecallConfig?.debugStrategy === "boolean"
          ? activeRecallConfig.debugStrategy
          : DEFAULT_ACTIVE_RECALL.debugStrategy,
      enableMultiAgentRetrieval:
        typeof activeRecallConfig?.enableMultiAgentRetrieval === "boolean"
          ? activeRecallConfig.enableMultiAgentRetrieval
          : DEFAULT_ACTIVE_RECALL.enableMultiAgentRetrieval,
      enableSessionScoping:
        typeof activeRecallConfig?.enableSessionScoping === "boolean"
          ? activeRecallConfig.enableSessionScoping
          : DEFAULT_ACTIVE_RECALL.enableSessionScoping,
    };

    // Parse autoCaptureConfig
    const autoCaptureConfig = cfg.autoCaptureConfig as Record<string, unknown> | undefined;
    const parsedAutoCapture: AutoCaptureConfig = {
      useEnhancedCapture:
        typeof autoCaptureConfig?.useEnhancedCapture === "boolean"
          ? autoCaptureConfig.useEnhancedCapture
          : DEFAULT_AUTO_CAPTURE.useEnhancedCapture,
      maxCaptureItems:
        typeof autoCaptureConfig?.maxCaptureItems === "number"
          ? Math.max(1, Math.min(50, autoCaptureConfig.maxCaptureItems))
          : DEFAULT_AUTO_CAPTURE.maxCaptureItems,
      activateSynapsesOnCapture:
        typeof autoCaptureConfig?.activateSynapsesOnCapture === "boolean"
          ? autoCaptureConfig.activateSynapsesOnCapture
          : DEFAULT_AUTO_CAPTURE.activateSynapsesOnCapture,
      captureCategories:
        Array.isArray(autoCaptureConfig?.captureCategories)
          ? autoCaptureConfig.captureCategories as Array<"preference" | "decision" | "fact" | "action" | "general">
          : DEFAULT_AUTO_CAPTURE.captureCategories,
      importanceThreshold:
        typeof autoCaptureConfig?.importanceThreshold === "number"
          ? Math.max(0, Math.min(1, autoCaptureConfig.importanceThreshold))
          : DEFAULT_AUTO_CAPTURE.importanceThreshold,
    };

    // Parse evolution config
    const evolutionConfig = cfg.evolution as Record<string, unknown> | undefined;
    const parsedEvolution: EvolutionConfig = {
      enableAutoEvolution:
        typeof evolutionConfig?.enableAutoEvolution === "boolean"
          ? evolutionConfig.enableAutoEvolution
          : DEFAULT_EVOLUTION.enableAutoEvolution,
      evolutionIntervalSessions:
        typeof evolutionConfig?.evolutionIntervalSessions === "number"
          ? Math.max(1, Math.min(100, evolutionConfig.evolutionIntervalSessions))
          : DEFAULT_EVOLUTION.evolutionIntervalSessions,
      backgroundEvolution:
        typeof evolutionConfig?.backgroundEvolution === "boolean"
          ? evolutionConfig.backgroundEvolution
          : DEFAULT_EVOLUTION.backgroundEvolution,
    };

    return {
      server: {
        baseUrl,
        apiKey,
      },
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      activeRecall: parsedActiveRecall,
      autoCaptureConfig: parsedAutoCapture,
      evolution: parsedEvolution,
      defaults: parsedDefaults,
    };
  },

  uiHints: {
    "server.baseUrl": {
      label: "Server URL",
      placeholder: DEFAULT_BASE_URL,
      help: "SuperAgentMemory API server URL",
    },
    "server.apiKey": {
      label: "API Key",
      sensitive: true,
      placeholder: "your-api-key (or use ${SUPERAGENT_MEMORY_API_KEY})",
      help: "API key for SuperAgentMemory authentication",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information after agent ends",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories before agent starts",
    },
    "activeRecall.enableQueryExpansion": {
      label: "Enable Query Expansion",
      advanced: true,
      help: "Use intelligent query expansion for better recall accuracy",
    },
    "activeRecall.maxParallelQueries": {
      label: "Max Parallel Queries",
      advanced: true,
      help: "Maximum number of expanded queries to execute in parallel",
    },
    "activeRecall.maxExpansions": {
      label: "Max Expansions",
      advanced: true,
      help: "Maximum number of query expansions to generate",
    },
    "activeRecall.minQueryLength": {
      label: "Min Query Length",
      advanced: true,
      help: "Minimum query length to trigger active recall",
    },
    "activeRecall.maxContextMemories": {
      label: "Max Context Memories",
      advanced: true,
      help: "Maximum memories to inject into context",
    },
    "activeRecall.enableMultiAgentRetrieval": {
      label: "Multi-Agent Retrieval",
      advanced: true,
      help: "Enable passing accessible_agent_ids for cross-agent retrieval",
    },
    "activeRecall.enableSessionScoping": {
      label: "Session Scoping",
      advanced: true,
      help: "Enable passing session_ids for session-scoped retrieval",
    },
    "autoCaptureConfig.useEnhancedCapture": {
      label: "Use Enhanced Capture",
      advanced: true,
      help: "Use enhanced_capture API with category classification",
    },
    "autoCaptureConfig.maxCaptureItems": {
      label: "Max Capture Items",
      advanced: true,
      help: "Maximum items to capture per agent session",
    },
    "autoCaptureConfig.activateSynapsesOnCapture": {
      label: "Activate Synapses on Capture",
      advanced: true,
      help: "Activate synapses after capturing memories",
    },
    "evolution.enableAutoEvolution": {
      label: "Auto Evolution",
      advanced: true,
      help: "Periodically trigger memory network evolution",
    },
    "evolution.evolutionIntervalSessions": {
      label: "Evolution Interval",
      advanced: true,
      help: "Minimum sessions between evolution triggers",
    },
    "defaults.maxResults": {
      label: "Max Results",
      advanced: true,
      help: `Default max results for recall (default: ${DEFAULT_MAX_RESULTS})`,
    },
    "defaults.maxDepth": {
      label: "Ripple Depth",
      advanced: true,
      help: `Default ripple retrieval depth 1-5 (default: ${DEFAULT_MAX_DEPTH})`,
    },
  },
};
