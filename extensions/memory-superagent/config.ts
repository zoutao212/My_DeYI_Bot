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

export type SuperMemoryConfig = {
  server: SuperMemoryServerConfig;
  autoCapture: boolean;
  autoRecall: boolean;
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
      ["server", "autoCapture", "autoRecall", "defaults"],
      "memory-superagent config",
    );

    // Parse server config
    const server = cfg.server as Record<string, unknown> | undefined;
    if (!server || typeof server.apiKey !== "string" || !server.apiKey.trim()) {
      throw new Error("server.apiKey is required");
    }
    assertAllowedKeys(server, ["baseUrl", "apiKey"], "server config");

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

    return {
      server: {
        baseUrl,
        apiKey: resolveEnvVars(server.apiKey.trim()),
      },
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
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
