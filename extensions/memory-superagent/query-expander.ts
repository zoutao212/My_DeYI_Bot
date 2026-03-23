/**
 * Intelligent Query Expander
 *
 * Ported from AgentMemorySystem's Query Expander
 *
 * Core capabilities:
 * 1. Query decomposition: Split complex queries into sub-queries
 * 2. Query expansion: Generate semantically equivalent query variants
 * 3. Entity extraction: Identify core entities and query focus
 * 4. Query type classification: Categorize query intent
 * 5. Combined search strategy: Generate optimal search plan
 */

// ============================================================================
// Types
// ============================================================================

export enum QueryType {
  FACTUAL = "factual", // 事实查询：是什么、是谁
  ATTRIBUTIVE = "attributive", // 属性查询：名字、年龄、地点
  RELATIONAL = "relational", // 关系查询：谁是谁的什么
  TEMPORAL = "temporal", // 时间查询：什么时候、哪一年
  LOCATIONAL = "locational", // 地点查询：在哪里、什么地方
  DESCRIPTIVE = "descriptive", // 描述查询：什么样的、如何
  UNKNOWN = "unknown",
}

export interface ExpandedQuery {
  text: string;
  source: "original" | "entity" | "composed" | "decomposed" | "expanded" | "keyword_combo";
  weight: number;
  queryType: QueryType;
  entities: string[];
  focus?: string;
}

export interface QueryAnalysis {
  originalQuery: string;
  queryType: QueryType;
  entities: string[];
  focus: string;
  keywords: string[];
  subQueries: ExpandedQuery[];
  expandedQueries: ExpandedQuery[];
  searchStrategy: string;
}

// ============================================================================
// Query Expander
// ============================================================================

export class QueryExpander {
  // Question pattern mappings
  private static readonly QUESTION_PATTERNS: Record<QueryType, RegExp[]> = {
    [QueryType.FACTUAL]: [
      /是什么/,
      /是谁/,
      /什么是/,
      /谁是/,
      /叫什么/,
      /叫什么名字/,
      /全名/,
    ],
    [QueryType.ATTRIBUTIVE]: [
      /多大/,
      /多少/,
      /多高/,
      /多长/,
      /怎样的/,
      /什么样/,
      /什么样子/,
    ],
    [QueryType.RELATIONAL]: [
      /是谁的/,
      /是谁的什么/,
      /和.*什么关系/,
      /什么关系/,
      /朋友/,
      /亲人/,
    ],
    [QueryType.TEMPORAL]: [
      /什么时候/,
      /哪一年/,
      /哪天/,
      /多久/,
      /几时/,
      /何时/,
    ],
    [QueryType.LOCATIONAL]: [/在哪里/, /什么地方/, /哪个城市/, /哪裡/],
    [QueryType.DESCRIPTIVE]: [/怎么样/, /如何/, /怎么/, /为何/],
    [QueryType.UNKNOWN]: [],
  };

  // Semantic expansion mappings (query focus → expansion terms)
  private static readonly FOCUS_EXPANSIONS: Record<string, string[]> = {
    全名: ["名字", "姓名", "叫什么", "真名", "本名"],
    名字: ["全名", "姓名", "叫什么", "真名"],
    年龄: ["多大", "几岁", "多少岁"],
    地点: ["在哪里", "什么地方", "位置"],
    时间: ["什么时候", "何时", "哪一年"],
    原因: ["为什么", "为何", "缘故"],
    关系: ["什么关系", "怎么认识的", "怎样的交情"],
  };

  // Entity recognition patterns
  private static readonly ENTITY_PATTERNS: RegExp[] = [
    /「([^」]+)」/, // 「XX」包裹的实体
    /"([^"]+)"/, // "XX" 引号实体
    /《([^》]+)》/, // 《XX》书名/人名
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/, // 英文名
  ];

  // Common Chinese name patterns (2-4 characters)
  private static readonly COMMON_NAME_PATTERN = /^[\u4e00-\u9fff]{2,4}$/;

  // Words to exclude from entity extraction
  private static readonly ENTITY_BLACKLIST = new Set([
    "最喜欢",
    "最喜欢de",
    "喜欢的",
    "什么",
    "怎么",
    "为什么",
    "怎么样",
    "如何",
    "哪里",
    "谁",
    "那个",
    "这个",
    "哪个",
  ]);

  constructor(
    private maxExpansions: number = 5,
    private expansionWeightDecay: number = 0.8,
    private enableSemanticExpansion: boolean = true
  ) {}

  /**
   * Analyze query and return complete analysis result
   */
  analyze(query: string): QueryAnalysis {
    // 1. Classify query type
    const queryType = this.classifyQuery(query);

    // 2. Extract entities
    const entities = this.extractEntities(query);

    // 3. Extract query focus
    const focus = this.extractFocus(query, queryType);

    // 4. Extract keywords
    const keywords = this.extractKeywords(query, entities, focus);

    // 5. Generate sub-queries (query decomposition)
    const subQueries = this.decomposeQuery(query, entities, focus, queryType);

    // 6. Generate expanded queries
    const expandedQueries = this.expandQuery(query, entities, focus, queryType);

    // 7. Determine search strategy
    const searchStrategy = this.determineStrategy(queryType, entities, subQueries);

    return {
      originalQuery: query,
      queryType,
      entities,
      focus,
      keywords,
      subQueries,
      expandedQueries,
      searchStrategy,
    };
  }

  /**
   * Get all search queries list
   * Returns sorted query list, highest weight first
   */
  getSearchQueries(query: string): ExpandedQuery[] {
    const analysis = this.analyze(query);
    const allQueries: ExpandedQuery[] = [];

    // 1. Original query (highest weight)
    allQueries.push({
      text: query,
      source: "original",
      weight: 1.0,
      queryType: analysis.queryType,
      entities: analysis.entities,
      focus: analysis.focus,
    });

    // 2. Entity queries (high weight)
    for (const entity of analysis.entities) {
      allQueries.push({
        text: entity,
        source: "entity",
        weight: 0.9,
        queryType: QueryType.FACTUAL,
        entities: [entity],
      });
    }

    // 3. Entity + Focus combination
    if (analysis.entities.length > 0 && analysis.focus) {
      for (const entity of analysis.entities) {
        const combo = `${entity}的${analysis.focus}`;
        allQueries.push({
          text: combo,
          source: "composed",
          weight: 0.85,
          queryType: analysis.queryType,
          entities: [entity],
          focus: analysis.focus,
        });
      }
    }

    // 4. Sub-queries
    for (const subQ of analysis.subQueries) {
      allQueries.push(subQ);
    }

    // 5. Expanded queries
    let weight = 0.7;
    for (const expQ of analysis.expandedQueries.slice(0, this.maxExpansions)) {
      expQ.weight = weight;
      allQueries.push(expQ);
      weight *= this.expansionWeightDecay;
    }

    // 6. Keyword combinations
    if (analysis.keywords.length >= 2) {
      // Dual-word combinations
      for (let i = 0; i < Math.min(3, analysis.keywords.length); i++) {
        for (let j = i + 1; j < Math.min(4, analysis.keywords.length); j++) {
          allQueries.push({
            text: `${analysis.keywords[i]} ${analysis.keywords[j]}`,
            source: "keyword_combo",
            weight: 0.5,
            queryType: QueryType.UNKNOWN,
            entities: [],
          });
        }
      }
    }

    // Deduplicate by text
    const seen = new Set<string>();
    const uniqueQueries: ExpandedQuery[] = [];
    for (const q of allQueries) {
      if (!seen.has(q.text)) {
        seen.add(q.text);
        uniqueQueries.push(q);
      }
    }

    return uniqueQueries;
  }

  /**
   * Classify query type
   */
  private classifyQuery(query: string): QueryType {
    for (const [qType, patterns] of Object.entries(QueryExpander.QUESTION_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(query)) {
          return qType as QueryType;
        }
      }
    }
    return QueryType.UNKNOWN;
  }

  /**
   * Extract entities from query
   */
  private extractEntities(query: string): string[] {
    const entities: string[] = [];

    // Priority 1: Match "XX的YY" pattern first (greedy) to get full entity name
    // This handles "阿居最喜欢的女孩" → entity = "阿居"
    const possessiveMatch = query.match(/([\u4e00-\u9fff]{2,4})(?=的)/);
    if (possessiveMatch) {
      const entity = possessiveMatch[1];
      if (!entities.includes(entity)) {
        entities.push(entity);
      }
    }

    // Priority 2: Match other entity patterns
    for (const pattern of QueryExpander.ENTITY_PATTERNS) {
      const matches = query.match(pattern);
      if (matches) {
        // Handle possible group matches - match[0] is full match, match[1+] are groups
        const entity = matches[1] || matches[0];
        if (entity && entity.length >= 2 && !entities.includes(entity)) {
          entities.push(entity);
        }
      }
    }

    return [...new Set(entities)];
  }

  /**
   * Extract query focus
   */
  private extractFocus(query: string, queryType: QueryType): string {
    // Common focus patterns
    const focusPatterns: [RegExp, string][] = [
      [/全名/, "全名"],
      [/名字/, "名字"],
      [/姓名/, "姓名"],
      [/年龄|多大|几岁/, "年龄"],
      [/地点|在哪/, "地点"],
      [/时间|什么时候/, "时间"],
      [/原因|为什么/, "原因"],
      [/关系/, "关系"],
    ];

    for (const [pattern, focus] of focusPatterns) {
      if (pattern.test(query)) {
        return focus;
      }
    }

    return "";
  }

  /**
   * Extract keywords from query
   */
  private extractKeywords(query: string, entities: string[], focus: string): string[] {
    const keywords: string[] = [];

    // 1. Entities as keywords
    keywords.push(...entities);

    // 2. Focus as keyword
    if (focus) {
      keywords.push(focus);
    }

    // 3. Extract other meaningful words from query
    // Remove stopwords and punctuation
    const cleaned = query.replace(/[？?！!。，,、]|\s+/g, " ").trim();
    const words = cleaned.split(/\s+/);

    for (const word of words) {
      const trimmed = word.trim();
      if (trimmed.length >= 2 && !keywords.includes(trimmed)) {
        // Simple filter
        if (!/^[的是有在和]/.test(trimmed)) {
          keywords.push(trimmed);
        }
      }
    }

    return keywords;
  }

  /**
   * Decompose query into sub-queries
   */
  private decomposeQuery(
    query: string,
    entities: string[],
    focus: string,
    queryType: QueryType
  ): ExpandedQuery[] {
    const subQueries: ExpandedQuery[] = [];

    // Strategy 1: Entity + Question type
    if (entities.length > 0) {
      for (const entity of entities) {
        if (queryType === QueryType.FACTUAL) {
          subQueries.push({
            text: `${entity} 名字`,
            source: "decomposed",
            weight: 0.75,
            queryType,
            entities: [entity],
            focus: "名字",
          });
        } else if (queryType === QueryType.ATTRIBUTIVE && focus) {
          subQueries.push({
            text: `${entity} ${focus}`,
            source: "decomposed",
            weight: 0.75,
            queryType,
            entities: [entity],
            focus,
          });
        }
      }
    }

    // Strategy 2: Core word combination
    if (entities.length > 0 && focus) {
      subQueries.push({
        text: `${entities[0]} ${focus}`,
        source: "decomposed",
        weight: 0.7,
        queryType,
        entities: [entities[0]],
        focus,
      });
    }

    return subQueries;
  }

  /**
   * Semantic query expansion
   */
  private expandQuery(
    query: string,
    entities: string[],
    focus: string,
    queryType: QueryType
  ): ExpandedQuery[] {
    const expanded: ExpandedQuery[] = [];

    if (!this.enableSemanticExpansion) {
      return expanded;
    }

    // Expand based on focus
    if (focus && QueryExpander.FOCUS_EXPANSIONS[focus]) {
      const expansions = QueryExpander.FOCUS_EXPANSIONS[focus];
      for (const expTerm of expansions.slice(0, 3)) {
        // Limit count
        let newQuery: string;
        if (entities.length > 0) {
          newQuery = `${entities[0]}的${expTerm}`;
        } else {
          newQuery = expTerm;
        }

        if (newQuery !== query) {
          expanded.push({
            text: newQuery,
            source: "expanded",
            weight: 0.65,
            queryType,
            entities: entities.slice(0, 1),
            focus: expTerm,
          });
        }
      }
    }

    // Expand based on query type
    if (queryType === QueryType.FACTUAL) {
      for (const entity of entities.slice(0, 2)) {
        expanded.push({
          text: `${entity} 叫什么`,
          source: "expanded",
          weight: 0.6,
          queryType,
          entities: [entity],
          focus: "名字",
        });
      }
    }

    return expanded;
  }

  /**
   * Determine search strategy
   */
  private determineStrategy(
    queryType: QueryType,
    entities: string[],
    subQueries: ExpandedQuery[]
  ): string {
    if (entities.length > 0) {
      if (entities.length === 1) {
        return `entity_first: Find entity '${entities[0]}' first, then find its attributes`;
      } else {
        return `multi_entity: Find multiple entities '${entities.join(", ")}' and their relationships`;
      }
    } else if (queryType !== QueryType.UNKNOWN) {
      return `type_guided: Search based on query type '${queryType}'`;
    } else {
      return "general: Generic vector + keyword search";
    }
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Query expansion convenience function
 */
export function expandQuery(query: string, maxExpansions: number = 5): ExpandedQuery[] {
  const expander = new QueryExpander(maxExpansions);
  return expander.getSearchQueries(query);
}

/**
 * Query analysis convenience function
 */
export function analyzeQuery(query: string): QueryAnalysis {
  const expander = new QueryExpander();
  return expander.analyze(query);
}

/**
 * Get fusion weights based on query type
 */
export function getFusionWeights(queryType: QueryType): { vector: number; keyword: number } {
  const weightMap: Record<QueryType, { vector: number; keyword: number }> = {
    [QueryType.FACTUAL]: { vector: 0.3, keyword: 0.7 }, // Factual: keywords more important
    [QueryType.ATTRIBUTIVE]: { vector: 0.5, keyword: 0.5 }, // Attribute: balanced
    [QueryType.RELATIONAL]: { vector: 0.4, keyword: 0.6 }, // Relational: keywords slightly important
    [QueryType.TEMPORAL]: { vector: 0.4, keyword: 0.6 }, // Temporal: keywords slightly important
    [QueryType.LOCATIONAL]: { vector: 0.5, keyword: 0.5 }, // Location: balanced
    [QueryType.DESCRIPTIVE]: { vector: 0.7, keyword: 0.3 }, // Descriptive: vector more important
    [QueryType.UNKNOWN]: { vector: 0.6, keyword: 0.4 }, // Default
  };

  return weightMap[queryType] || weightMap[QueryType.UNKNOWN];
}
