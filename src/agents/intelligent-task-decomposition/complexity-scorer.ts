/**
 * 任务复杂度评分器
 * 
 * 综合考虑多个维度，智能评估任务的复杂度，用于自适应深度控制。
 * 
 * 🆕 V6: 增强评分维度
 * 评分维度：
 * - Prompt 长度（0-20 分）
 * - 任务类型（0-20 分）— 使用统一分类器
 * - 工具/资源依赖（0-20 分）
 * - 多步骤结构信号（0-20 分）— 新增
 * - 历史数据（0-20 分）
 * 
 * 总分范围：0-100
 * 深度推荐：
 * - 0-30 分 → maxDepth = 1
 * - 31-60 分 → maxDepth = 2
 * - 61-100 分 → maxDepth = 3
 */

import type { TaskTree } from "./types.js";
import { classifyTaskType } from "./task-type-classifier.js";

/**
 * 任务复杂度评分结果
 */
export type TaskComplexityScore = {
  /** 总分 (0-100) */
  total: number;
  
  /** 各维度得分 */
  dimensions: {
    /** Prompt 长度得分 (0-20) */
    promptLength: number;
    
    /** 任务类型得分 (0-20) */
    taskType: number;
    
    /** 工具/资源依赖数量得分 (0-20) */
    toolDependencies: number;

    /** 🆕 V6: 多步骤结构信号得分 (0-20) */
    structuralComplexity: number;
    
    /** 历史表现得分 (0-20) */
    historicalPerformance: number;
  };
  
  /** 推荐的最大深度 (1-4) */
  recommendedMaxDepth: number;
};

/**
 * 工具/资源关键词（用于估算工具依赖）
 */
const TOOL_KEYWORDS = [
  "文件", "读取", "写入", "执行", "搜索", "查询", "调用",
  "数据库", "API", "接口", "部署", "配置", "安装",
  "file", "read", "write", "execute", "search", "query", "call",
  "database", "api", "deploy", "config", "install",
];

/**
 * 复杂度评分器
 */
export class ComplexityScorer {
  /**
   * 计算任务的复杂度评分
   * 
   * @param taskTree - 任务树
   * @returns 复杂度评分结果
   */
  calculateScore(taskTree: TaskTree): TaskComplexityScore {
    const promptLengthScore = this.scorePromptLength(taskTree.rootTask);
    const taskTypeScore = this.scoreTaskType(taskTree.rootTask);
    const toolDependenciesScore = this.scoreToolDependencies(taskTree.rootTask);
    const structuralComplexityScore = this.scoreStructuralComplexity(taskTree.rootTask);
    const historicalPerformanceScore = this.scoreHistoricalPerformance(taskTree);
    
    const total = promptLengthScore + taskTypeScore + toolDependenciesScore + structuralComplexityScore + historicalPerformanceScore;
    const recommendedMaxDepth = this.calculateDepth(total);
    
    return {
      total,
      dimensions: {
        promptLength: promptLengthScore,
        taskType: taskTypeScore,
        toolDependencies: toolDependenciesScore,
        structuralComplexity: structuralComplexityScore,
        historicalPerformance: historicalPerformanceScore,
      },
      recommendedMaxDepth,
    };
  }
  
  /**
   * 评分维度 1：Prompt 长度 (0-20)
   */
  private scorePromptLength(prompt: string): number {
    const length = prompt.length;
    
    if (length < 100) return 4;
    if (length < 300) return 8;
    if (length < 500) return 12;
    if (length < 1000) return 16;
    return 20;
  }
  
  /**
   * 评分维度 2：任务类型 (0-20)
   * 
   * 🆕 V6: 使用统一分类器替代硬编码关键词列表
   * 基于分类器的 confidence 和类型固有复杂度综合评分
   */
  private scoreTaskType(prompt: string): number {
    const classification = classifyTaskType(prompt);
    
    // 各任务类型的固有复杂度权重
    const typeComplexityWeight: Record<string, number> = {
      planning: 6,
      review: 8,
      writing: 10,
      analysis: 12,
      research: 14,
      data: 14,
      coding: 16,
      automation: 16,
      design: 18,
      generic: 8,
    };
    
    const baseScore = typeComplexityWeight[classification.type] ?? 8;
    // 高置信度（多关键词/结构信号命中）提高得分
    const confidenceBonus = classification.confidence > 70 ? 2 : 0;
    
    return Math.min(20, baseScore + confidenceBonus);
  }
  
  /**
   * 评分维度 3：工具/资源依赖 (0-20)
   */
  private scoreToolDependencies(prompt: string): number {
    const lowerPrompt = prompt.toLowerCase();
    
    let toolCount = 0;
    for (const keyword of TOOL_KEYWORDS) {
      if (lowerPrompt.includes(keyword)) {
        toolCount++;
      }
    }
    
    if (toolCount <= 1) return 4;
    if (toolCount <= 3) return 8;
    if (toolCount <= 5) return 12;
    if (toolCount <= 8) return 16;
    return 20;
  }

  /**
   * 🆕 V6 评分维度 4：多步骤结构信号 (0-20)
   * 
   * 检测 prompt 中的结构性复杂度指标：
   * - 编号列表（步骤、阶段）
   * - 多对象/多维度信号
   * - 条件分支（如果...否则...）
   * - 量化指标（大数字字数/数量要求）
   */
  private scoreStructuralComplexity(prompt: string): number {
    let score = 0;

    // 编号列表检测
    const numberedItems = (prompt.match(/(?:^|\n)\s*\d+[\.)\、]\s*/g) || []).length;
    if (numberedItems >= 5) score += 6;
    else if (numberedItems >= 3) score += 4;
    else if (numberedItems >= 1) score += 2;

    // 多步骤/顺序信号
    const sequenceSignals = [
      /(?:首先|其次|然后|接着|最后|第一步|第二步)/,
      /(?:first|then|next|finally|step\s*\d)/i,
      /(?:阶段|phase|stage)\s*\d/i,
    ];
    const seqCount = sequenceSignals.filter(p => p.test(prompt)).length;
    score += Math.min(seqCount * 2, 6);

    // 条件分支信号
    const conditionalSignals = [
      /(?:如果|若|当|假如|否则|不然)/,
      /(?:if|when|unless|otherwise|else)/i,
    ];
    if (conditionalSignals.some(p => p.test(prompt))) {
      score += 2;
    }

    // 大量化指标
    const bigNumberMatch = prompt.match(/(\d{4,})\s*(?:字|个|行|条|项|words?|lines?|items?)/i);
    if (bigNumberMatch && parseInt(bigNumberMatch[1]) >= 5000) {
      score += 4;
    }

    // 多对象/多维度信号
    const multiObjectSignals = [
      /(?:分别|各自|每个|respectively|each)/i,
      /(?:多个|several|multiple)\s*(?:文件|模块|维度|方面)/i,
    ];
    if (multiObjectSignals.some(p => p.test(prompt))) {
      score += 2;
    }

    return Math.min(20, score);
  }
  
  /**
   * 评分维度 5：历史表现 (0-20)
   * 
   * 注：当前版本暂不实现历史数据查询，返回默认值
   */
  private scoreHistoricalPerformance(_taskTree: TaskTree): number {
    // TODO: 实现历史数据查询
    return 10;
  }
  
  /**
   * 根据总分计算推荐的最大深度
   * 
   * 限制范围：1-3
   */
  private calculateDepth(totalScore: number): number {
    if (totalScore <= 30) return 1;
    if (totalScore <= 60) return 2;
    return 3;
  }
}
