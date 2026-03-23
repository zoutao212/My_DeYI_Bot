/**
 * Enhanced Query Expander with NLP API Integration
 *
 * Combines local query expansion with Python NLP API for higher accuracy.
 * Falls back to local processing when API is unavailable.
 *
 * @module memory/query-expander-enhanced
 */

import {
  QueryExpander as LocalQueryExpander,
  QueryType,
  type QueryAnalysis,
  type ExpandedQuery,
  expandQuery,
  analyzeQuery,
  getFusionWeights,
} from "./query-expander.js";
import { NLPClient, getNLPClient, EntityType, QueryType as NLPQueryType } from "./nlp-client.js";

// ============================================================================
// Types
// ============================================================================

export interface EnhancedQueryExpanderConfig {
  /** Enable NLP API integration (default: true) */
  enableNLPAPI?: boolean;
  /** Prefer NLP API over local processing (default: true) */
  preferAPI?: boolean;
  /** NLP API client configuration */
  nlpClientConfig?: {
    baseUrl?: string;
    timeout?: number;
    maxRetries?: number;
    enableFallback?: boolean;
    enableCache?: boolean;
  };
  /** Fallback to local processing on API failure (default: true) */
  enableFallback?: boolean;
}

// ============================================================================
// Enhanced Query Expander
// ============================================================================

/**
 * Enhanced Query Expander with NLP API integration
 *
 * Features:
 * - Automatic API vs local processing selection
 * - Seamless fallback to local processing
 * - Unified interface for both approaches
 * - Enhanced entity extraction with jieba
 */
export class EnhancedQueryExpander {
  private readonly localExpander: LocalQueryExpander;
  private readonly nlpClient: NLPClient;
  private readonly enableNLPAPI: boolean;
  private readonly preferAPI: boolean;
  private readonly enableFallback: boolean;

  constructor(
    maxExpansions: number = 5,
    expansionWeightDecay: number = 0.8,
    enableSemanticExpansion: boolean = true,
    config: EnhancedQueryExpanderConfig = {}
  ) {
    this.localExpander = new LocalQueryExpander(
      maxExpansions,
      expansionWeightDecay,
      enableSemanticExpansion
    );

    this.enableNLPAPI = config.enableNLPAPI !== false;
    this.preferAPI = config.preferAPI !== false;
    this.enableFallback = config.enableFallback !== false;

    this.nlpClient = getNLPClient(config.nlpClientConfig);
  }

  /**
   * Analyze query using best available method
   *
   * If NLP API is available and preferred, uses API.
   * Otherwise falls back to local processing.
   */
  async analyze(query: string): Promise<QueryAnalysis> {
    // Try NLP API first if enabled and preferred
    if (this.enableNLPAPI && this.preferAPI) {
      try {
        const apiResult = await this.callNLPAPI(query);
        if (apiResult) {
          return apiResult;
        }
      } catch (error) {
        console.warn("NLP API call failed, falling back to local processing:", error);
        
        if (!this.enableFallback) {
          throw error;
        }
      }
    }

    // Fallback to local processing
    return this.localExpander.analyze(query);
  }

  /**
   * Get search queries (async version)
   *
   * Uses NLP API if available, otherwise local processing
   */
  async getSearchQueriesAsync(query: string): Promise<ExpandedQuery[]> {
    const analysis = await this.analyze(query);
    return this.convertToExpandedQueries(analysis);
  }

  /**
   * Get search queries (sync version - uses local processing only)
   *
   * @deprecated Use getSearchQueriesAsync for better results
   */
  getSearchQueries(query: string): ExpandedQuery[] {
    return this.localExpander.getSearchQueries(query);
  }

  // ==========================================================================
  // NLP API Integration
  // ==========================================================================

  /**
   * Call NLP API and convert result to local format
   */
  private async callNLPAPI(query: string): Promise<QueryAnalysis | null> {
    try {
      // Check if API is healthy
      const health = await this.nlpClient.healthCheck();
      if (!health.healthy) {
        console.warn("NLP API is not healthy");
        return null;
      }

      // Call analyze endpoint
      const result = await this.nlpClient.analyze(query, {
        enable_expansion: true,
        max_expansions: 5,
        extract_entities: true,
        extract_keywords: true,
        detect_focus: true,
      });

      // Convert to local format
      return this.convertFromAPIFormat(result);
    } catch (error) {
      console.error("NLP API call failed:", error);
      return null;
    }
  }

  /**
   * Convert NLP API result to local QueryAnalysis format
   */
  private convertFromAPIFormat(apiResult: any): QueryAnalysis {
    return {
      originalQuery: apiResult.original_query,
      queryType: this.convertQueryType(apiResult.query_type),
      entities: apiResult.entities.map((e: any) => e.text),
      focus: apiResult.focus,
      keywords: apiResult.keywords.map((k: any) => k.text),
      subQueries: [],  // Will be generated by local expander if needed
      expandedQueries: apiResult.expansions.map((e: any) => ({
        text: e.text,
        source: "expanded" as const,
        weight: e.weight,
        queryType: this.convertQueryType(apiResult.query_type),
        entities: apiResult.entities.map((ent: any) => ent.text),
        focus: apiResult.focus,
      })),
      searchStrategy: apiResult.strategy?.description || "",
    };
  }

  /**
   * Convert NLP QueryType enum to local QueryType enum
   */
  private convertQueryType(nlpType: string): QueryType {
    const typeMap: Record<string, QueryType> = {
      [NLPQueryType.FACTUAL]: QueryType.FACTUAL,
      [NLPQueryType.ATTRIBUTIVE]: QueryType.ATTRIBUTIVE,
      [NLPQueryType.RELATIONAL]: QueryType.RELATIONAL,
      [NLPQueryType.TEMPORAL]: QueryType.TEMPORAL,
      [NLPQueryType.LOCATIONAL]: QueryType.LOCATIONAL,
      [NLPQueryType.DESCRIPTIVE]: QueryType.DESCRIPTIVE,
      [NLPQueryType.UNKNOWN]: QueryType.UNKNOWN,
    };

    return typeMap[nlpType] || QueryType.UNKNOWN;
  }

  /**
   * Convert QueryAnalysis to ExpandedQuery array
   */
  private convertToExpandedQueries(analysis: QueryAnalysis): ExpandedQuery[] {
    const queries: ExpandedQuery[] = [];

    // 1. Original query
    queries.push({
      text: analysis.originalQuery,
      source: "original",
      weight: 1.0,
      queryType: analysis.queryType,
      entities: analysis.entities,
      focus: analysis.focus,
    });

    // 2. Entity queries
    for (const entity of analysis.entities) {
      queries.push({
        text: entity,
        source: "entity",
        weight: 0.9,
        queryType: QueryType.FACTUAL,
        entities: [entity],
      });
    }

    // 3. Entity + Focus combinations
    if (analysis.entities.length > 0 && analysis.focus) {
      for (const entity of analysis.entities) {
        queries.push({
          text: `${entity}的${analysis.focus}`,
          source: "composed",
          weight: 0.85,
          queryType: analysis.queryType,
          entities: [entity],
          focus: analysis.focus,
        });
      }
    }

    // 4. Sub-queries
    queries.push(...analysis.subQueries);

    // 5. Expanded queries
    queries.push(...analysis.expandedQueries);

    // 6. Keyword combinations
    if (analysis.keywords.length >= 2) {
      for (let i = 0; i < Math.min(3, analysis.keywords.length); i++) {
        for (let j = i + 1; j < Math.min(4, analysis.keywords.length); j++) {
          queries.push({
            text: `${analysis.keywords[i]} ${analysis.keywords[j]}`,
            source: "keyword_combo",
            weight: 0.5,
            queryType: QueryType.UNKNOWN,
            entities: [],
          });
        }
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    return queries.filter((q) => {
      if (seen.has(q.text)) return false;
      seen.add(q.text);
      return true;
    });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Check if NLP API is available
   */
  async isAPIAvailable(): Promise<boolean> {
    if (!this.enableNLPAPI) return false;
    
    try {
      const health = await this.nlpClient.healthCheck();
      return health.healthy;
    } catch {
      return false;
    }
  }

  /**
   * Get NLP client for direct usage
   */
  getNLPClient(): NLPClient {
    return this.nlpClient;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Analyze query using enhanced expander (convenience function)
 */
export async function analyzeQueryEnhanced(
  query: string,
  config?: EnhancedQueryExpanderConfig
): Promise<QueryAnalysis> {
  const expander = new EnhancedQueryExpander(5, 0.8, true, config);
  return expander.analyze(query);
}

/**
 * Get search queries using enhanced expander (convenience function)
 */
export async function getSearchQueriesEnhanced(
  query: string,
  config?: EnhancedQueryExpanderConfig
): Promise<ExpandedQuery[]> {
  const expander = new EnhancedQueryExpander(5, 0.8, true, config);
  return expander.getSearchQueriesAsync(query);
}

// Re-export types and functions from original query-expander
export { QueryType, QueryAnalysis, ExpandedQuery, expandQuery, analyzeQuery, getFusionWeights };
