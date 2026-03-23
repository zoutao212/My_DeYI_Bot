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
