/**
 * NLP Client for AgentMemorySystem
 *
 * TypeScript client for calling Python NLP API.
 * Provides high-quality Chinese NLP capabilities:
 * - Segmentation with jieba
 * - Entity extraction (person, location, book, etc.)
 * - Keyword extraction with TF-IDF
 * - Complete query analysis
 *
 * @module nlp/nlp-client
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Entity types matching Python API
 */
export enum EntityType {
  PERSON = "person",
  LOCATION = "location",
  ORGANIZATION = "organization",
  BOOK = "book",
  TIME = "time",
  CUSTOM = "custom",
}

/**
 * Query types matching Python API
 */
export enum QueryType {
  FACTUAL = "factual",
  ATTRIBUTIVE = "attributive",
  RELATIONAL = "relational",
  TEMPORAL = "temporal",
  LOCATIONAL = "locational",
  DESCRIPTIVE = "descriptive",
  UNKNOWN = "unknown",
}

/**
 * Entity representation
 */
export interface Entity {
  text: string;
  type: EntityType;
  start_pos: number;
  end_pos: number;
  confidence: number;
  metadata?: {
    pos?: string;
    source?: string;
    [key: string]: unknown;
  };
}

/**
 * Keyword with weight
 */
export interface Keyword {
  text: string;
  weight: number;
  pos?: string;
}

/**
 * Segment (word segmentation result)
 */
export interface Segment {
  text: string;
  pos?: string;
  start_pos: number;
  end_pos: number;
}

/**
 * Expanded query
 */
export interface ExpandedQuery {
  text: string;
  weight: number;
}

/**
 * Search strategy
 */
export interface SearchStrategy {
  name: string;
  description: string;
}

/**
 * Query analysis metadata
 */
export interface QueryAnalysisMetadata {
  processing_time: number;
  source: string;
  confidence: number;
}

/**
 * Complete query analysis result
 */
export interface QueryAnalysis {
  original_query: string;
  query_type: QueryType;
  entities: Entity[];
  focus: string;
  keywords: Keyword[];
  segments: Segment[];
  expansions: ExpandedQuery[];
  strategy: SearchStrategy | null;
  metadata: QueryAnalysisMetadata;
}

/**
 * Segment result
 */
export interface SegmentResult {
  text: string;
  segments: Segment[];
}

/**
 * Extract entities result
 */
export interface ExtractEntitiesResult {
  entities: Entity[];
}

/**
 * Extract keywords result
 */
export interface ExtractKeywordsResult {
  keywords: Keyword[];
}

// ============================================================================
// Request Types
// ============================================================================

interface AnalyzeRequest {
  query: string;
  options?: {
    enable_expansion?: boolean;
    max_expansions?: number;
    extract_entities?: boolean;
    extract_keywords?: boolean;
    detect_focus?: boolean;
  };
}

interface SegmentRequest {
  text: string;
  with_pos?: boolean;
  use_hmm?: boolean;
}

interface ExtractEntitiesRequest {
  text: string;
  types?: EntityType[] | null;
}

interface ExtractKeywordsRequest {
  text: string;
  max_keywords?: number;
  use_tfidf?: boolean;
}

// ============================================================================
// NLP Client
// ============================================================================

/**
 * NLP Client Configuration
 */
export interface NLPClientConfig {
  /** Base URL of the NLP API (default: http://localhost:8080/v1/nlp) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Maximum retry attempts (default: 2) */
  maxRetries?: number;
  /** Enable fallback to local processing (default: true) */
  enableFallback?: boolean;
  /** Enable request caching (default: false) */
  enableCache?: boolean;
  /** Cache TTL in seconds (default: 300) */
  cacheTTL?: number;
}

/**
 * NLP API Client
 *
 * Provides TypeScript interface to Python NLP service.
 * Falls back to local processing when API is unavailable.
 */
export class NLPClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly enableFallback: boolean;
  private readonly enableCache: boolean;
  private readonly cacheTTL: number;
  private readonly cache: Map<string, { data: unknown; expiry: number }>;

  constructor(config: NLPClientConfig = {}) {
    this.baseUrl = config.baseUrl || "http://localhost:8080/v1/nlp";
    this.timeout = config.timeout || 5000;
    this.maxRetries = config.maxRetries || 2;
    this.enableFallback = config.enableFallback !== false;
    this.enableCache = config.enableCache || false;
    this.cacheTTL = config.cacheTTL || 300;
    this.cache = new Map();
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Complete query analysis (recommended)
   *
   * One-stop NLP processing including:
   * - Segmentation
   * - Entity extraction
   * - Keyword extraction
   * - Query expansion
   * - Search strategy generation
   */
  async analyze(query: string, options?: AnalyzeRequest["options"]): Promise<QueryAnalysis> {
    const cacheKey = `analyze:${query}:${JSON.stringify(options)}`;
    
    // Check cache
    if (this.enableCache) {
      const cached = this.getFromCache<QueryAnalysis>(cacheKey);
      if (cached) return cached;
    }

    try {
      const result = await this.request<QueryAnalysis>("/analyze", {
        query,
        options: options || {
          enable_expansion: true,
          max_expansions: 5,
          extract_entities: true,
          extract_keywords: true,
          detect_focus: true,
        },
      });

      // Cache result
      if (this.enableCache) {
        this.setCache(cacheKey, result);
      }

      return result;
    } catch (error) {
      if (this.enableFallback) {
        console.warn("NLP API unavailable, using local fallback");
        return this.localFallback(query);
      }
      throw error;
    }
  }

  /**
   * Chinese segmentation
   */
  async segment(text: string, withPos = true, useHMM = true): Promise<SegmentResult> {
    const cacheKey = `segment:${text}:${withPos}:${useHMM}`;
    
    if (this.enableCache) {
      const cached = this.getFromCache<SegmentResult>(cacheKey);
      if (cached) return cached;
    }

    try {
      const result = await this.request<SegmentResult>("/segment", {
        text,
        with_pos: withPos,
        use_hmm: useHMM,
      });

      if (this.enableCache) {
        this.setCache(cacheKey, result);
      }

      return result;
    } catch (error) {
      if (this.enableFallback) {
        return this.localSegment(text, withPos);
      }
      throw error;
    }
  }

  /**
   * Entity extraction
   */
  async extractEntities(text: string, types?: EntityType[]): Promise<Entity[]> {
    const cacheKey = `entities:${text}:${types?.join(",")}`;
    
    if (this.enableCache) {
      const cached = this.getFromCache<Entity[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      const result = await this.request<ExtractEntitiesResult>("/extract-entities", {
        text,
        types: types || null,
      });

      const entities = result.entities;

      if (this.enableCache) {
        this.setCache(cacheKey, entities);
      }

      return entities;
    } catch (error) {
      if (this.enableFallback) {
        return this.localExtractEntities(text);
      }
      throw error;
    }
  }

  /**
   * Keyword extraction
   */
  async extractKeywords(text: string, maxKeywords = 15, useTFIDF = true): Promise<Keyword[]> {
    const cacheKey = `keywords:${text}:${maxKeywords}:${useTFIDF}`;
    
    if (this.enableCache) {
      const cached = this.getFromCache<Keyword[]>(cacheKey);
      if (cached) return cached;
    }

    try {
      const result = await this.request<ExtractKeywordsResult>("/extract-keywords", {
        text,
        max_keywords: maxKeywords,
        use_tfidf: useTFIDF,
      });

      const keywords = result.keywords;

      if (this.enableCache) {
        this.setCache(cacheKey, keywords);
      }

      return keywords;
    } catch (error) {
      if (this.enableFallback) {
        return this.localExtractKeywords(text, maxKeywords);
      }
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ healthy: boolean; jiebaAvailable: boolean }> {
    try {
      const result = await this.request<{ status: string; jieba_available: boolean }>("/health");
      return {
        healthy: result.status === "healthy",
        jiebaAvailable: result.jieba_available,
      };
    } catch {
      return {
        healthy: false,
        jiebaAvailable: false,
      };
    }
  }

  // ==========================================================================
  // HTTP Request Handling
  // ==========================================================================

  /**
   * Make HTTP request with retry logic
   */
  private async request<T>(endpoint: string, body: unknown): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data as T;
      } catch (error) {
        lastError = error as Error;

        // Don't retry on abort (timeout)
        if ((error as Error).name === "AbortError") {
          break;
        }

        // Wait before retry (exponential backoff)
        if (attempt < this.maxRetries) {
          await this.sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  // ==========================================================================
  // Caching
  // ==========================================================================

  private getFromCache<T>(key: string): T | null {
    if (!this.enableCache) return null;

    const cached = this.cache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.data as T;
    }

    return null;
  }

  private setCache(key: string, data: unknown): void {
    if (!this.enableCache) return;

    this.cache.set(key, {
      data,
      expiry: Date.now() + this.cacheTTL * 1000,
    });

    // Clean up expired entries
    this.cleanupCache();
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (value.expiry <= now) {
        this.cache.delete(key);
      }
    }
  }

  // ==========================================================================
  // Local Fallback (Simplified NLP)
  // ==========================================================================

  /**
   * Local fallback for query analysis when API is unavailable
   */
  private localFallback(query: string): QueryAnalysis {
    // Simple segmentation using regex
    const segments = this.localSegment(query, false).segments;

    // Simple entity extraction
    const entities = this.localExtractEntities(query);

    // Simple keyword extraction
    const keywords = this.localExtractKeywords(query, 15);

    // Determine query type
    const queryType = this.localClassifyQuery(query);

    // Extract focus
    const focus = this.localExtractFocus(query);

    return {
      original_query: query,
      query_type: queryType,
      entities: entities.map((e) => ({
        ...e,
        confidence: 0.6,
        metadata: { source: "local-fallback" },
      })),
      focus,
      keywords,
      segments,
      expansions: [],
      strategy: {
        name: "local",
        description: "Local fallback processing (API unavailable)",
      },
      metadata: {
        processing_time: 1,
        source: "local-fallback",
        confidence: 0.6,
      },
    };
  }

  /**
   * Local segmentation (simple Chinese word splitting)
   */
  private localSegment(text: string, withPos: boolean): SegmentResult {
    const segments: Segment[] = [];
    const chinesePattern = /[\u4e00-\u9fa5]+/g;
    let match;

    while ((match = chinesePattern.exec(text)) !== null) {
      segments.push({
        text: match[0],
        pos: withPos ? undefined : undefined,
        start_pos: match.index,
        end_pos: match.index + match[0].length,
      });
    }

    return { text, segments };
  }

  /**
   * Local entity extraction (pattern-based)
   */
  private localExtractEntities(text: string): Entity[] {
    const entities: Entity[] = [];

    // Book names: 《XX》
    const bookPattern = /《([^》]+)》/g;
    let match;
    while ((match = bookPattern.exec(text)) !== null) {
      entities.push({
        text: match[1],
        type: EntityType.BOOK,
        start_pos: match.index + 1,
        end_pos: match.index + match[0].length - 1,
        confidence: 0.8,
        metadata: { source: "local" },
      });
    }

    // Chinese names (2-4 characters before "的")
    const namePattern = /([\u4e00-\u9fa5]{2,4})(?=的)/g;
    while ((match = namePattern.exec(text)) !== null) {
      if (!entities.some((e) => e.text === match[1])) {
        entities.push({
          text: match[1],
          type: EntityType.PERSON,
          start_pos: match.index,
          end_pos: match.index + match[1].length,
          confidence: 0.6,
          metadata: { source: "local" },
        });
      }
    }

    return entities;
  }

  /**
   * Local keyword extraction (simple frequency-based)
   */
  private localExtractKeywords(text: string, maxKeywords: number): Keyword[] {
    const chinesePattern = /[\u4e00-\u9fa5]{2,6}/g;
    const words: string[] = [];
    let match;

    while ((match = chinesePattern.exec(text)) !== null) {
      words.push(match[0]);
    }

    // Count frequency
    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    // Sort by frequency
    const sorted = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywords);

    const total = sorted.reduce((sum, [, count]) => sum + count, 0);

    return sorted.map(([text, count]) => ({
      text,
      weight: total > 0 ? count / total : 0,
    }));
  }

  /**
   * Local query type classification
   */
  private localClassifyQuery(query: string): QueryType {
    if (/是什么|是谁|叫什么|全名/.test(query)) return QueryType.FACTUAL;
    if (/多大|多少|怎样/.test(query)) return QueryType.ATTRIBUTIVE;
    if (/什么时候|哪一年/.test(query)) return QueryType.TEMPORAL;
    if (/在哪里|什么地方/.test(query)) return QueryType.LOCATIONAL;
    if (/如何|怎么/.test(query)) return QueryType.DESCRIPTIVE;
    return QueryType.UNKNOWN;
  }

  /**
   * Local focus extraction
   */
  private localExtractFocus(query: string): string {
    const focusPatterns: [RegExp, string][] = [
      [/全名|名字/, "名字"],
      [/年龄|多大/, "年龄"],
      [/地点|在哪/, "地点"],
      [/时间|什么时候/, "时间"],
    ];

    for (const [pattern, focus] of focusPatterns) {
      if (pattern.test(query)) {
        return focus;
      }
    }

    return "";
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultClient: NLPClient | null = null;

/**
 * Get default NLP client instance
 */
export function getNLPClient(config?: NLPClientConfig): NLPClient {
  if (!defaultClient) {
    defaultClient = new NLPClient(config);
  }
  return defaultClient;
}

/**
 * Create new NLP client instance
 */
export function createNLPClient(config?: NLPClientConfig): NLPClient {
  return new NLPClient(config);
}
