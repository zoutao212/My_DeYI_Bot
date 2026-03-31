/**
 * SuperAgentMemory HTTP Client
 *
 * Lightweight TypeScript client wrapping the SuperAgentMemory REST API.
 * Uses Node.js 22+ built-in fetch — zero external dependencies.
 */

// ============================================================================
// Types
// ============================================================================

export type MemoryAtom = {
  id: number;
  content: string;
  summary?: string;
  atom_type?: string;
  source_type?: string;
  importance: number;
  confidence: number;
  depth_level: number;
  agent_id?: string;
  session_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type StoreRequest = {
  content: string;
  agent_id?: string;
  session_id?: string;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  auto_link?: boolean;
  deduplicate?: boolean;
};

// 服务端实际返回的 store 格式
export type StoreResponse = {
  // 服务端实际返回的字段
  id: string;
  object: string;
  created: boolean;
  content?: string;
  content_hash?: string;
  keywords?: string[];
  embedding?: number[];
  metadata?: Record<string, unknown>;
  depth_level?: number;
  agent_id?: string;
  importance?: number;
  synapses_count?: number;
  prev_id?: string;
  next_id?: string;
  created_at?: string;
  // 重复检测相关
  duplicate?: boolean;
  // 兼容旧格式
  success?: boolean;
  atom?: MemoryAtom;
  synapses_created?: number;
  is_duplicate?: boolean;
  similar_atoms?: Array<{
    id: number;
    content: string;
    similarity: number;
  }>;
};

export type RetrieveRequest = {
  query: string;
  agent_id?: string;
  session_id?: string;
  max_results?: number;
  max_depth?: number;
  decay_factor?: number;
  min_strength?: number;
  accessible_agent_ids?: string[];
  session_branch_path?: string[];
};

// 服务端实际返回的结果格式（平铺结构）
export type RetrieveResultItem = {
  id: string;
  object: string;
  content: string;
  score: number;
  depth: number;
  path: string[];
  keywords?: string[];
  metadata?: Record<string, unknown>;
  agent_id?: string;
  session_id?: string;
  context_before?: string;
  context_after?: string;
  synapse_path?: string[];
  tags?: string[];  // 兼容旧格式
};

export type RetrieveResponse = {
  object: string;
  query: string;
  results: RetrieveResultItem[];
  total_results: number;
  search_config?: {
    agent_id?: string;
    accessible_agent_ids?: string[];
    session_branch_path?: string[];
  };
  ripple_stats?: {
    layers_explored: number;
    atoms_visited: number;
    synapses_activated: number;
  };
  // 兼容旧格式字段
  success?: boolean;
  total_found?: number;
  retrieval_depth?: number;
};

export type UpdateRequest = {
  content?: string;
  importance?: number;
  tags?: string[];
  append?: boolean;
};

export type UpdateResponse = {
  success: boolean;
  atom: MemoryAtom;
};

export type DeleteResponse = {
  success: boolean;
  deleted_id: number;
  synapses_removed?: number;
};

export type HealthResponse = {
  status: string;
  version?: string;
  database?: string;
};

// ============================================================================
// Enhanced Retrieval Types
// ============================================================================

export type EnhancedRetrieveRequest = {
  query: string;
  agent_id?: string;
  max_results?: number;
  max_depth?: number;
  accessible_agent_ids?: string[];
  session_ids?: string[];
  // 检索配置选项
  use_fast_path?: boolean;
  use_intelligent_ranking?: boolean;
  use_quality_scoring?: boolean;
  use_summarization?: boolean;
  max_context_tokens?: number;
};

export type EnhancedRetrieveStats = {
  path_taken: string;
  query_complexity: string;
  total_time_ms: number;
  complexity_analysis_ms: number;
  retrieval_ms: number;
  ranking_ms: number;
  quality_scoring_ms: number;
  summarization_ms: number;
  synapse_update_ms: number;
  initial_results: number;
  final_results: number;
  summarization_triggered: boolean;
  ripple_layers?: number;
  ripple_atoms_visited?: number;
  ripple_synapses_activated?: number;
  token_stats?: {
    original_tokens: number;
    final_tokens: number;
    compression_ratio: number;
  };
};

export type EnhancedRetrieveResponse = {
  object: string;
  query: string;
  results: EnhancedRetrieveResultItem[];
  total_results: number;
  stats: EnhancedRetrieveStats;
};

export type EnhancedRetrieveResultItem = {
  id: string;
  content: string;
  score: number;
  depth: number;
  path: string[];
  keywords?: string[];
  metadata?: Record<string, unknown>;
  agent_id?: string;
  session_id?: string;
  context_before?: string;
  context_after?: string;
  // 质量评分因子
  quality_factors?: {
    freshness: number;
    importance: number;
    activation: number;
    connectivity: number;
    confidence: number;
    overall: number;
  };
  // 匹配类型（用于快速路径）
  match_type?: string;
};

export type CapabilitiesResponse = {
  object: string;
  version: string;
  capabilities: {
    retrieval_modes: string[];
    features: Record<string, boolean>;
    retrieval_config_options: Record<string, { type: string; default: unknown }>;
  };
};

// ============================================================================
// Batch Operations Types
// ============================================================================

export type BatchStoreItem = {
  content: string;
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
};

export type BatchStoreRequest = {
  items: BatchStoreItem[];
  agent_id?: string;
  session_id?: string;
  deduplicate?: boolean;
  auto_link?: boolean;
};

export type BatchStoreResponse = {
  object: string;
  stored: number;
  duplicates: number;
  failed: number;
  total: number;
  results: Array<{
    atom_id?: number;
    created?: boolean;
    error?: string;
    content_preview?: string;
  }>;
};

// ============================================================================
// Enhanced Capture Types
// ============================================================================

export type CaptureItem = {
  content: string;
  category: "preference" | "decision" | "fact" | "action" | "general";
  importance?: number;
  tags?: string[];
};

export type EnhancedCaptureRequest = {
  items: CaptureItem[];
  agent_id?: string;
  session_id?: string;
  source?: string;
  deduplicate?: boolean;
  activate_synapses?: boolean;
};

export type EnhancedCaptureResponse = {
  object: string;
  captured: number;
  duplicates: number;
  total: number;
  synapses_activated: number;
  results: Array<{
    atom_id?: number;
    created?: boolean;
    category?: string;
    importance?: number;
    error?: string;
  }>;
};

// ============================================================================
// Synapse Activation Types
// ============================================================================

export type SynapseActivationRequest = {
  atom_ids: number[];
  activation_type?: "manual" | "retrieval" | "capture";
};

export type SynapseActivationResponse = {
  object: string;
  activated_count: number;
  atoms_processed: number;
  activation_type: string;
};

// ============================================================================
// Dashboard Stats Types
// ============================================================================

export type DashboardStatsResponse = {
  object: string;
  timestamp: string;
  memory: {
    total_atoms: number;
    active_atoms: number;
    archived_atoms: number;
    avg_importance: number;
  };
  synapses: {
    total_synapses: number;
    avg_strength: number;
    active_synapses: number;
  };
  keywords: {
    total_keywords: number;
  };
  sessions: Record<string, unknown>;
};

// ============================================================================
// Evolution Types
// ============================================================================

export type EvolutionTriggerRequest = {
  phases?: string[];
  background?: boolean;
};

export type EvolutionTriggerResponse = {
  object: string;
  status: "started" | "completed";
  message: string;
  background: boolean;
  metrics?: {
    synapses_created?: number;
    synapses_pruned?: number;
    synapses_strengthened?: number;
    clusters_formed?: number;
    resonance_chains?: number;
    processing_time_seconds?: number;
  };
};

// ============================================================================
// Health Check Types
// ============================================================================

export type MemoryHealthCheckResponse = {
  object: string;
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    atom_repo?: boolean;
    synapse_repo?: boolean;
    keyword_repo?: boolean;
    embedder?: boolean;
    debouncer?: boolean;
    synapse_dynamics?: boolean;
  };
  version: string;
  error?: string;
};

type ClientError = {
  code: string;
  message: string;
  detail?: string;
};

// ============================================================================
// SuperMemoryClient
// ============================================================================

export class SuperMemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    timeout?: number;
    maxRetries?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeout = opts.timeout ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 1;
  }

  // ========================================================================
  // Public API methods
  // ========================================================================

  /** Store a new memory atom */
  async store(req: StoreRequest): Promise<StoreResponse> {
    return this.request<StoreResponse>("POST", "/v1/memory/store", req);
  }

  /** Retrieve memories using ripple search */
  async retrieve(req: RetrieveRequest): Promise<RetrieveResponse> {
    // Build query params (FastAPI expects Query parameters, not JSON body)
    const params = new URLSearchParams();
    params.append("query", req.query);
    params.append("use_new_system", "true");  // 👈 启用 HyperNMCv4 最强检索
    if (req.agent_id) params.append("agent_id", req.agent_id);
    if (req.session_id) params.append("session_id", req.session_id);
    if (req.max_results) params.append("max_results", String(req.max_results));
    if (req.max_depth) params.append("max_depth", String(req.max_depth));
    if (req.decay_factor) params.append("decay_factor", String(req.decay_factor));
    if (req.min_strength) params.append("min_strength", String(req.min_strength));
    if (req.accessible_agent_ids?.length) {
      params.append("accessible_agent_ids", req.accessible_agent_ids.join(","));
    }
    if (req.session_branch_path?.length) {
      params.append("session_branch_path", req.session_branch_path.join(","));
    }

    return this.request<RetrieveResponse>("POST", `/v1/memory/retrieve?${params.toString()}`);
  }

  /** Get a single memory atom by ID */
  async get(atomId: number): Promise<MemoryAtom> {
    return this.request<{ success: boolean; atom: MemoryAtom }>(
      "GET",
      `/v1/memory/${atomId}`,
    ).then((r) => r.atom);
  }

  /** Update an existing memory atom */
  async update(atomId: number, req: UpdateRequest): Promise<UpdateResponse> {
    return this.request<UpdateResponse>(
      "POST",
      `/v1/memory/update?id=${atomId}`,
      req,
    );
  }

  /** Delete a memory atom (optionally cascade delete synapses) */
  async delete(atomId: number, cascade = false): Promise<DeleteResponse> {
    return this.request<DeleteResponse>(
      "DELETE",
      `/v1/memory/${atomId}?cascade=${cascade}`,
    );
  }

  /** Health check */
  async healthCheck(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  /**
   * Enhanced retrieval using UnifiedRetrievalPipeline
   * Leverages all advanced features: fast path, intelligent ranking,
   * quality scoring, summarization, and synapse dynamics
   */
  async enhancedRetrieve(req: EnhancedRetrieveRequest): Promise<EnhancedRetrieveResponse> {
    const params = new URLSearchParams();
    params.append("query", req.query);
    if (req.agent_id) params.append("agent_id", req.agent_id);
    if (req.max_results) params.append("max_results", String(req.max_results));
    if (req.max_depth) params.append("max_depth", String(req.max_depth));
    if (req.use_fast_path !== undefined) params.append("use_fast_path", String(req.use_fast_path));
    if (req.use_intelligent_ranking !== undefined) params.append("use_intelligent_ranking", String(req.use_intelligent_ranking));
    if (req.use_quality_scoring !== undefined) params.append("use_quality_scoring", String(req.use_quality_scoring));
    if (req.use_summarization !== undefined) params.append("use_summarization", String(req.use_summarization));
    if (req.max_context_tokens) params.append("max_context_tokens", String(req.max_context_tokens));
    if (req.accessible_agent_ids?.length) {
      params.append("accessible_agent_ids", req.accessible_agent_ids.join(","));
    }
    if (req.session_ids?.length) {
      params.append("session_ids", req.session_ids.join(","));
    }

    return this.request<EnhancedRetrieveResponse>(
      "POST",
      `/v1/memory/enhanced_retrieve?${params.toString()}`
    );
  }

  /**
   * Get memory system capabilities
   * Returns information about supported features
   */
  async getCapabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>("GET", "/v1/memory/capabilities");
  }

  /**
   * Check if enhanced retrieval is available
   * Falls back to standard retrieval if not available
   */
  async isEnhancedRetrievalAvailable(): Promise<boolean> {
    try {
      const caps = await this.getCapabilities();
      return caps.capabilities.retrieval_modes.includes("enhanced");
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  /**
   * Batch store multiple memories
   * Uses debouncing for efficient bulk inserts
   */
  async batchStore(req: BatchStoreRequest): Promise<BatchStoreResponse> {
    return this.request<BatchStoreResponse>("POST", "/v1/memory/batch_store", req);
  }

  // ============================================================================
  // Enhanced Capture
  // ============================================================================

  /**
   * Enhanced capture for auto-capture scenarios
   * Supports intelligent category classification and synapse activation
   */
  async enhancedCapture(req: EnhancedCaptureRequest): Promise<EnhancedCaptureResponse> {
    return this.request<EnhancedCaptureResponse>("POST", "/v1/memory/enhanced_capture", req);
  }

  // ============================================================================
  // Synapse Operations
  // ============================================================================

  /**
   * Manually activate synapses for specific atoms
   * Useful after bulk operations or manual interventions
   */
  async activateSynapses(req: SynapseActivationRequest): Promise<SynapseActivationResponse> {
    return this.request<SynapseActivationResponse>("POST", "/v1/synapses/activate", req);
  }

  // ============================================================================
  // Stats & Dashboard
  // ============================================================================

  /**
   * Get dashboard statistics
   * Returns comprehensive system status information
   */
  async getDashboardStats(): Promise<DashboardStatsResponse> {
    return this.request<DashboardStatsResponse>("GET", "/v1/stats/dashboard");
  }

  /**
   * Memory system health check
   * Checks all critical components
   */
  async memoryHealthCheck(): Promise<MemoryHealthCheckResponse> {
    return this.request<MemoryHealthCheckResponse>("GET", "/v1/memory/health_check");
  }

  // ============================================================================
  // Evolution
  // ============================================================================

  /**
   * Trigger memory network evolution
   * Can run in background or synchronously
   */
  async triggerEvolution(req?: EvolutionTriggerRequest): Promise<EvolutionTriggerResponse> {
    return this.request<EvolutionTriggerResponse>(
      "POST",
      "/v1/evolution/trigger",
      req || { background: false }
    );
  }

  /**
   * Get evolution status
   */
  async getEvolutionStatus(): Promise<{
    object: string;
    scheduler_running: boolean;
    tasks: Record<string, unknown>;
  }> {
    return this.request("GET", "/v1/evolution/status");
  }

  /**
   * Get evolution configuration
   */
  async getEvolutionConfig(): Promise<{
    object: string;
    config: Record<string, unknown>;
  }> {
    return this.request("GET", "/v1/evolution/config");
  }

  /**
   * Multi-query parallel retrieval
   * Executes multiple retrieval queries in parallel and fuses results
   *
   * @param queries Array of query strings to execute
   * @param baseParams Base parameters for all queries
   * @returns Fused and deduplicated results
   */
  async multiRetrieve(
    queries: string[],
    baseParams: Omit<RetrieveRequest, "query">,
    options?: {
      maxParallel?: number;
      fuseStrategy?: "weighted" | "rrf"; // Reciprocal Rank Fusion
    }
  ): Promise<RetrieveResponse & { queryCount: number; fusionMethod: string }> {
    const maxParallel = options?.maxParallel ?? 3;
    const fuseStrategy = options?.fuseStrategy ?? "weighted";

    // Limit parallel requests
    const batches: string[][] = [];
    for (let i = 0; i < queries.length; i += maxParallel) {
      batches.push(queries.slice(i, i + maxParallel));
    }

    // Execute batches in parallel
    const allResults: Map<string, RetrieveResultItem[]> = new Map();
    let totalQueries = 0;

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map((query) =>
          this.retrieve({ ...baseParams, query }).catch((err) => {
            // Log error but continue with other queries
            console.warn(`Multi-retrieve query "${query}" failed:`, err);
            return {
              object: "retrieve_response",
              query,
              results: [],
              total_results: 0
            } as RetrieveResponse;
          })
        )
      );

      for (let i = 0; i < batch.length; i++) {
        const query = batch[i];
        const result = batchResults[i];
        if (result.results.length > 0) {
          allResults.set(query, result.results);
        }
        totalQueries++;
      }
    }

    // Fuse results
    const fusedResults = this.fuseResults(allResults, fuseStrategy);

    return {
      object: "multi_retrieve_response",
      query: queries[0], // Primary query
      results: fusedResults.slice(0, baseParams.max_results ?? 10),
      total_results: fusedResults.length,
      queryCount: totalQueries,
      fusionMethod: fuseStrategy,
    };
  }

  /**
   * Fuse results from multiple queries
   * Uses weighted or RRF (Reciprocal Rank Fusion) strategy
   */
  private fuseResults(
    resultsByQuery: Map<string, RetrieveResultItem[]>,
    strategy: "weighted" | "rrf"
  ): RetrieveResultItem[] {
    // Track scores for each unique result (by id)
    const scoreMap: Map<string, { item: RetrieveResultItem; score: number; sources: string[] }> =
      new Map();

    const rrfK = 60; // RRF constant

    for (const [query, results] of resultsByQuery) {
      results.forEach((item, rank) => {
        const existing = scoreMap.get(item.id);

        if (strategy === "rrf") {
          // Reciprocal Rank Fusion: 1 / (k + rank)
          const rrfScore = 1 / (rrfK + rank);
          if (existing) {
            existing.score += rrfScore;
            existing.sources.push(query);
          } else {
            scoreMap.set(item.id, {
              item,
              score: rrfScore,
              sources: [query],
            });
          }
        } else {
          // Weighted: use original score with decay
          const weight = 1.0 / (rank + 1);
          const weightedScore = item.score * weight;
          if (existing) {
            existing.score += weightedScore;
            existing.sources.push(query);
          } else {
            scoreMap.set(item.id, {
              item,
              score: weightedScore,
              sources: [query],
            });
          }
        }
      });
    }

    // Sort by fused score
    const sorted = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);

    // Boost items found by multiple queries
    return sorted.map((entry) => ({
      ...entry.item,
      score: Math.min(1.0, entry.score * (1 + Math.log(entry.sources.length) * 0.1)),
    }));
  }

  // ========================================================================
  // Internal HTTP helpers
  // ========================================================================

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const res = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Parse response
        const data = await res.json();

        if (!res.ok) {
          const err = data as ClientError;
          throw new SuperMemoryError(
            err.message ?? `HTTP ${res.status}`,
            res.status,
            err.code,
          );
        }

        return data as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry client errors (4xx) or intentional aborts
        if (
          lastError instanceof SuperMemoryError &&
          lastError.status >= 400 &&
          lastError.status < 500
        ) {
          throw lastError;
        }

        if (
          lastError.name === "AbortError" ||
          lastError.message.includes("ECONNREFUSED") ||
          lastError.message.includes("ENOTFOUND")
        ) {
          throw new SuperMemoryError(
            `Cannot connect to SuperAgentMemory at ${this.baseUrl}`,
            0,
            "CONNECTION_ERROR",
          );
        }

        // Retry on transient errors (5xx, network)
        if (attempt < this.maxRetries) {
          await sleep(Math.min(1000 * 2 ** attempt, 5000));
          continue;
        }
      }
    }

    throw lastError ?? new Error("Unknown error");
  }
}

// ============================================================================
// Custom Error
// ============================================================================

export class SuperMemoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "SuperMemoryError";
    this.status = status;
    this.code = code;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
