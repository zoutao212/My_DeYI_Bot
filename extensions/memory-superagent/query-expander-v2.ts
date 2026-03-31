/**
 * Enhanced Query Expander V2 - Multi-Entity Query Support
 * 
 * 正确处理多实体并列查询：
 * - "高丽琴的故事 阿居 水彧姑娘" → [高丽琴的故事, 高丽琴, 阿居, 水彧姑娘, 水彧]
 * - 保留完整短语 + 提取核心实体
 * - 扩展检索范围，提高召回率
 */

import { QueryType, type QueryAnalysis, type ExpandedQuery } from "./query-expander.js";

// ============================================================================
// Types
// ============================================================================

export interface MultiEntityQuery {
  /** 完整的原始查询 */
  fullQuery: string;
  /** 完整短语列表 */
  phrases: string[];
  /** 扩展后的所有实体（包含核心实体） */
  entities: string[];
  /** 是否为多实体查询 */
  isMultiEntity: boolean;
  /** 查询类型 */
  queryType: QueryType;
  /** 置信度 */
  confidence: number;
}

export interface QueryDecomposition {
  /** 原始查询 */
  original: string;
  /** 拆分策略 */
  strategy: "space_split" | "single_entity" | "composite";
  /** 子查询列表 */
  subQueries: ExpandedQuery[];
  /** 置信度 */
  confidence: number;
}

// ============================================================================
// Entity Phrase Expander
// ============================================================================

/**
 * 实体短语扩展器
 * 
 * 核心逻辑：
 * - 保留完整短语（如"高丽琴的故事"、"水彧姑娘"）
 * - 提取核心实体（如"高丽琴"、"水彧"）
 * - 两者都用，扩展检索范围
 */
class EntityPhraseExpander {
  // 常见后缀模式（需要提取核心实体）
  private static readonly SUFFIX_PATTERNS: Array<[string, string]> = [
    ["的故事", "故事"],
    ["的传说", "传说"],
    ["的历史", "历史"],
    ["的经历", "经历"],
    ["的回忆", "回忆"],
    ["的往事", "往事"],
    ["姑娘", "姑娘"],
    ["小姐", "小姐"],
    ["先生", "先生"],
  ];

  // 最小实体长度
  private static readonly MIN_ENTITY_LENGTH = 2;

  // 噪声词（单独出现时不应该作为实体）
  private static readonly NOISE_WORDS = new Set([
    "故事", "传说", "历史", "经历",
    "回忆", "往事", "人生",
    "的", "了", "着", "过",
  ]);

  /**
   * 扩展实体短语
   * 
   * Args:
   *   phrase: 原始短语
   * 
   * Returns:
   *   扩展后的实体列表（包含完整短语 + 核心实体）
   */
  static expand(phrase: string): string[] {
    const result = [phrase]; // 总是保留完整短语

    // 尝试提取核心实体
    const coreEntity = this.extractCoreEntity(phrase);
    if (coreEntity && coreEntity !== phrase) {
      result.push(coreEntity);
    }

    return result;
  }

  /**
   * 提取核心实体
   * 
   * Args:
   *   phrase: 原始短语
   * 
   * Returns:
   *   核心实体（如果存在）
   */
  private static extractCoreEntity(phrase: string): string | null {
    // 1. 尝试移除后缀
    for (const [suffix, _] of this.SUFFIX_PATTERNS) {
      if (phrase.endsWith(suffix)) {
        const core = phrase.slice(0, -suffix.length);
        if (core.length >= this.MIN_ENTITY_LENGTH && !this.NOISE_WORDS.has(core)) {
          return core;
        }
      }
    }

    // 2. 尝试从嵌套实体中提取（如"阿居的爸爸"）
    if (phrase.includes("的")) {
      // 保留嵌套结构，不拆分
      // "阿居的爸爸" 是一个有意义的完整实体
    }

    return null;
  }
}

// ============================================================================
// Multi-Entity Query Detector
// ============================================================================

/**
 * 多实体查询检测器
 */
export class MultiEntityQueryDetector {
  /**
   * 检测查询是否为多实体查询
   */
  static detect(query: string): MultiEntityQuery {
    // 1. 空格分隔检测
    const spaceSplit = query.split(/\s+/).filter(p => p.trim().length > 0);

    if (spaceSplit.length > 1) {
      // 多实体查询
      // 扩展每个短语（保留完整短语 + 提取核心实体）
      const allEntities: string[] = [];
      for (const phrase of spaceSplit) {
        const expanded = EntityPhraseExpander.expand(phrase);
        allEntities.push(...expanded);
      }

      return {
        fullQuery: query,
        phrases: spaceSplit, // 完整短语
        entities: allEntities, // 扩展后的所有实体
        isMultiEntity: spaceSplit.length > 1,
        queryType: QueryType.FACTUAL,
        confidence: 0.9,
      };
    }

    // 2. 单实体查询
    // 扩展实体
    const expanded = EntityPhraseExpander.expand(query);

    return {
      fullQuery: query,
      phrases: [query],
      entities: expanded,
      isMultiEntity: false,
      queryType: QueryType.UNKNOWN,
      confidence: 0.8,
    };
  }
}

// ============================================================================
// Enhanced Query Expander V2
// ============================================================================

/**
 * 增强版查询扩展器 V2
 * 
 * 正确处理多实体查询：
 * - 保留完整短语
 * - 提取核心实体
 * - 生成组合查询
 */
export class QueryExpanderV2 {
  /**
   * 分解多实体查询
   */
  static decompose(query: string): QueryDecomposition {
    const detection = MultiEntityQueryDetector.detect(query);

    if (detection.isMultiEntity) {
      // 多实体查询：拆分成独立的子查询
      return this.decomposeMultiEntity(query, detection.phrases, detection.entities);
    } else if (detection.entities.length >= 1) {
      // 单实体查询：生成变体
      return this.decomposeSingleEntity(query, detection.entities);
    } else {
      // 未知类型：保持原样
      return {
        original: query,
        strategy: "composite",
        subQueries: [{
          text: query,
          source: "original",
          weight: 1.0,
          queryType: QueryType.UNKNOWN,
          entities: [],
        }],
        confidence: 0.5,
      };
    }
  }

  /**
   * 分解多实体查询
   */
  private static decomposeMultiEntity(
    query: string,
    phrases: string[],
    entities: string[]
  ): QueryDecomposition {
    const subQueries: ExpandedQuery[] = [];
    const seenTexts = new Set<string>();

    // 1. 原始查询（最高权重）
    subQueries.push({
      text: query,
      source: "original",
      weight: 1.0,
      queryType: QueryType.FACTUAL,
      entities: entities,
    });
    seenTexts.add(query);

    // 2. 完整短语查询（高权重）
    for (const phrase of phrases) {
      if (!seenTexts.has(phrase)) {
        subQueries.push({
          text: phrase,
          source: "entity",
          weight: 0.9,
          queryType: QueryType.FACTUAL,
          entities: [phrase],
        });
        seenTexts.add(phrase);
      }
    }

    // 3. 核心实体查询（中高权重）
    for (const entity of entities) {
      if (!seenTexts.has(entity) && !phrases.includes(entity)) {
        subQueries.push({
          text: entity,
          source: "core_entity",
          weight: 0.85,
          queryType: QueryType.FACTUAL,
          entities: [entity],
        });
        seenTexts.add(entity);
      }
    }

    // 4. 实体组合（中等权重）
    if (phrases.length >= 2) {
      // 两两组合（只组合完整短语）
      for (let i = 0; i < Math.min(2, phrases.length); i++) {
        for (let j = i + 1; j < Math.min(3, phrases.length); j++) {
          const comboText = `${phrases[i]} ${phrases[j]}`;
          if (!seenTexts.has(comboText)) {
            subQueries.push({
              text: comboText,
              source: "composed",
              weight: 0.7,
              queryType: QueryType.RELATIONAL,
              entities: [phrases[i], phrases[j]],
            });
            seenTexts.add(comboText);
          }
        }
      }
    }

    return {
      original: query,
      strategy: "space_split",
      subQueries,
      confidence: 0.9,
    };
  }

  /**
   * 分解单实体查询
   */
  private static decomposeSingleEntity(
    query: string,
    entities: string[]
  ): QueryDecomposition {
    const subQueries: ExpandedQuery[] = [];
    const seenTexts = new Set<string>();

    // 1. 原始查询
    subQueries.push({
      text: query,
      source: "original",
      weight: 1.0,
      queryType: QueryType.FACTUAL,
      entities: entities,
    });
    seenTexts.add(query);

    // 2. 所有实体变体
    for (const entity of entities) {
      if (!seenTexts.has(entity)) {
        // 判断是否为核心实体
        const source = entity !== query ? "core_entity" : "entity";
        const weight = entity !== query ? 0.85 : 0.9;

        subQueries.push({
          text: entity,
          source,
          weight,
          queryType: QueryType.FACTUAL,
          entities: [entity],
        });
        seenTexts.add(entity);
      }
    }

    return {
      original: query,
      strategy: "single_entity",
      subQueries,
      confidence: 0.8,
    };
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * 检测多实体查询（便捷函数）
 */
export function detectMultiEntityQuery(query: string): MultiEntityQuery {
  return MultiEntityQueryDetector.detect(query);
}

/**
 * 分解查询（便捷函数）
 */
export function decomposeQuery(query: string): QueryDecomposition {
  return QueryExpanderV2.decompose(query);
}

/**
 * 获取所有搜索查询（便捷函数）
 */
export function getSearchQueriesV2(query: string): ExpandedQuery[] {
  const decomposition = QueryExpanderV2.decompose(query);
  return decomposition.subQueries;
}
