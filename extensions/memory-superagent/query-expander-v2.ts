/**
 * Enhanced Query Expander V2 - Multi-Entity Query Support
 *
 * 优化多实体查询的处理：
 * 1. 识别空格分隔的多实体
 * 2. 智能过滤噪声实体
 * 3. 生成更好的查询组合
 * 4. 支持并列查询（如"高丽琴的故事 阿居 水彧姑娘"）
 */

import { QueryType, type QueryAnalysis, type ExpandedQuery } from "./query-expander.js";

// ============================================================================
// Types
// ============================================================================

export interface MultiEntityQuery {
  /** 完整的原始查询 */
  fullQuery: string;
  /** 拆分出的实体列表 */
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
// Entity Noise Filter
// ============================================================================

/**
 * 实体噪声过滤器
 * 
 * 过滤掉不应该是实体的词：
 * - 无意义后缀："的故事"、"的传说"
 * - 助词："的"、"了"、"着"
 * - 常见词："故事"、"传说"、"历史"
 */
class EntityNoiseFilter {
  // 无意义后缀模式
  private static readonly NOISE_SUFFIXES = [
    "的故事", "的传说", "的历史", "的经历",
    "的回忆", "的往事", "的人生",
  ];

  // 噪声词列表（单独出现时不是实体）
  private static readonly NOISE_WORDS = new Set([
    "故事", "传说", "历史", "经历",
    "回忆", "往事", "人生",
    "的", "了", "着", "过",
  ]);

  // 最小实体长度（过滤过短的噪声）
  private static readonly MIN_ENTITY_LENGTH = 2;

  /**
   * 过滤噪声实体
   */
  static filter(entities: string[]): string[] {
    return entities.filter(entity => {
      // 1. 长度过滤
      if (entity.length < this.MIN_ENTITY_LENGTH) {
        return false;
      }

      // 2. 噪声词过滤
      if (this.NOISE_WORDS.has(entity)) {
        return false;
      }

      // 3. 无意义后缀过滤
      for (const suffix of this.NOISE_SUFFIXES) {
        if (entity.endsWith(suffix) && entity.length === suffix.length) {
          return false;
        }
      }

      // 4. 检查是否包含"的"，但保留"阿居的爸爸"这类嵌套实体
      if (entity.includes("的")) {
        // 如果"的"在中间，且前后都有实质内容，保留
        const parts = entity.split("的");
        const hasValidParts = parts.every(part => 
          part.length >= 2 && !this.NOISE_WORDS.has(part)
        );
        if (!hasValidParts) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * 清理实体名称（移除噪声后缀）
   */
  static cleanEntityName(entity: string): string {
    for (const suffix of this.NOISE_SUFFIXES) {
      if (entity.endsWith(suffix)) {
        return entity.slice(0, -suffix.length);
      }
    }
    return entity;
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
      const rawEntities = spaceSplit.map(part => part.trim());
      const cleanedEntities = EntityNoiseFilter.filter(rawEntities);
      
      return {
        fullQuery: query,
        entities: cleanedEntities,
        isMultiEntity: cleanedEntities.length > 1,
        queryType: QueryType.FACTUAL,
        confidence: 0.9,
      };
    }

    // 2. 单实体查询
    // 尝试识别"XX的YY"模式
    const possessiveMatch = query.match(/([^\s]+(?:的[^\s]+)+)/);
    if (possessiveMatch) {
      // 嵌套实体（如"阿居的爸爸"）
      const entity = possessiveMatch[1];
      return {
        fullQuery: query,
        entities: [entity],
        isMultiEntity: false,
        queryType: QueryType.RELATIONAL,
        confidence: 0.8,
      };
    }

    // 3. 简单单实体
    return {
      fullQuery: query,
      entities: [query],
      isMultiEntity: false,
      queryType: QueryType.UNKNOWN,
      confidence: 0.6,
    };
  }
}

// ============================================================================
// Enhanced Query Expander V2
// ============================================================================

/**
 * 增强版查询扩展器 V2
 * 
 * 专为多实体查询优化
 */
export class QueryExpanderV2 {
  /**
   * 分解多实体查询
   */
  static decompose(query: string): QueryDecomposition {
    const detection = MultiEntityQueryDetector.detect(query);

    if (detection.isMultiEntity) {
      // 多实体查询：拆分成独立的子查询
      return this.decomposeMultiEntity(query, detection.entities);
    } else if (detection.entities.length === 1) {
      // 单实体查询：生成变体
      return this.decomposeSingleEntity(query, detection.entities[0]);
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
    entities: string[]
  ): QueryDecomposition {
    const subQueries: ExpandedQuery[] = [];

    // 1. 原始查询（最高权重）
    subQueries.push({
      text: query,
      source: "original",
      weight: 1.0,
      queryType: QueryType.FACTUAL,
      entities: entities,
    });

    // 2. 每个实体作为独立查询（高权重）
    for (const entity of entities) {
      subQueries.push({
        text: entity,
        source: "entity",
        weight: 0.9,
        queryType: QueryType.FACTUAL,
        entities: [entity],
      });
    }

    // 3. 实体组合（中等权重）
    if (entities.length >= 2) {
      // 两两组合
      for (let i = 0; i < Math.min(2, entities.length); i++) {
        for (let j = i + 1; j < Math.min(3, entities.length); j++) {
          subQueries.push({
            text: `${entities[i]} ${entities[j]}`,
            source: "composed",
            weight: 0.7,
            queryType: QueryType.RELATIONAL,
            entities: [entities[i], entities[j]],
          });
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
    entity: string
  ): QueryDecomposition {
    const subQueries: ExpandedQuery[] = [];

    // 1. 原始查询
    subQueries.push({
      text: query,
      source: "original",
      weight: 1.0,
      queryType: QueryType.FACTUAL,
      entities: [entity],
    });

    // 2. 实体本身
    subQueries.push({
      text: entity,
      source: "entity",
      weight: 0.9,
      queryType: QueryType.FACTUAL,
      entities: [entity],
    });

    // 3. 清理后的实体名（移除"的故事"等后缀）
    const cleanedEntity = EntityNoiseFilter.cleanEntityName(entity);
    if (cleanedEntity !== entity && cleanedEntity.length >= 2) {
      subQueries.push({
        text: cleanedEntity,
        source: "expanded",
        weight: 0.75,
        queryType: QueryType.FACTUAL,
        entities: [cleanedEntity],
      });
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
