/**
 * 任务复杂度评分器
 * 
 * 综合考虑多个维度，智能评估任务的复杂度，用于自适应深度控制。
 * 
 * 评分维度：
 * - Prompt 长度（0-25 分）
 * - 任务类型（0-25 分）
 * - 工具依赖（0-25 分）
 * - 历史数据（0-25 分）
 * 
 * 总分范围：0-100
 * 深度推荐：
 * - 0-30 分 → maxDepth = 1
 * - 31-60 分 → maxDepth = 2
 * - 61-100 分 → maxDepth = 3
 */

import type { TaskTree } from "./types.js";

/**
 * 任务复杂度评分结果
 */
export type TaskComplexityScore = {
  /** 总分 (0-100) */
  total: number;
  
  /** 各维度得分 */
  dimensions: {
    /** Prompt 长度得分 (0-25) */
    promptLength: number;
    
    /** 任务类型得分 (0-25) */
    taskType: number;
    
    /** 工具依赖数量得分 (0-25) */
    toolDependencies: number;
    
    /** 历史表现得分 (0-25) */
    historicalPerformance: number;
  };
  
  /** 推荐的最大深度 (1-4) */
  recommendedMaxDepth: number;
};

/**
 * 任务类型关键词映射
 */
const TASK_TYPE_KEYWORDS = {
  writing: ["写", "生成", "创作", "编写", "撰写", "write", "generate", "create", "compose"],
  coding: ["代码", "编程", "实现", "开发", "修复", "code", "program", "implement", "develop", "fix"],
  data: ["数据", "分析", "处理", "统计", "计算", "data", "analyze", "process", "calculate"],
  research: ["研究", "调查", "搜索", "查找", "探索", "research", "investigate", "search", "explore"],
  design: ["设计", "架构", "规划", "方案", "design", "architecture", "plan", "solution"],
};

/**
 * 工具关键词（用于估算工具依赖）
 */
const TOOL_KEYWORDS = [
  "文件", "读取", "写入", "执行", "搜索", "查询", "调用",
  "file", "read", "write", "execute", "search", "query", "call",
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
    const historicalPerformanceScore = this.scoreHistoricalPerformance(taskTree);
    
    const total = promptLengthScore + taskTypeScore + toolDependenciesScore + historicalPerformanceScore;
    const recommendedMaxDepth = this.calculateDepth(total);
    
    return {
      total,
      dimensions: {
        promptLength: promptLengthScore,
        taskType: taskTypeScore,
        toolDependencies: toolDependenciesScore,
        historicalPerformance: historicalPerformanceScore,
      },
      recommendedMaxDepth,
    };
  }
  
  /**
   * 评分维度 1：Prompt 长度
   * 
   * 评分规则：
   * - < 100 字符 = 5 分
   * - 100-300 字符 = 10 分
   * - 300-500 字符 = 15 分
   * - 500-1000 字符 = 20 分
   * - > 1000 字符 = 25 分
   */
  private scorePromptLength(prompt: string): number {
    const length = prompt.length;
    
    if (length < 100) return 5;
    if (length < 300) return 10;
    if (length < 500) return 15;
    if (length < 1000) return 20;
    return 25;
  }
  
  /**
   * 评分维度 2：任务类型
   * 
   * 评分规则：
   * - 简单查询/搜索 = 5 分
   * - 写作/生成 = 10 分
   * - 数据分析/处理 = 15 分
   * - 代码编写/开发 = 20 分
   * - 系统设计/架构 = 25 分
   */
  private scoreTaskType(prompt: string): number {
    const lowerPrompt = prompt.toLowerCase();
    
    // 检测任务类型
    let maxScore = 5; // 默认：简单任务
    
    // 写作/生成
    if (TASK_TYPE_KEYWORDS.writing.some((kw) => lowerPrompt.includes(kw))) {
      maxScore = Math.max(maxScore, 10);
    }
    
    // 数据分析/处理
    if (TASK_TYPE_KEYWORDS.data.some((kw) => lowerPrompt.includes(kw))) {
      maxScore = Math.max(maxScore, 15);
    }
    
    // 代码编写/开发
    if (TASK_TYPE_KEYWORDS.coding.some((kw) => lowerPrompt.includes(kw))) {
      maxScore = Math.max(maxScore, 20);
    }
    
    // 系统设计/架构
    if (TASK_TYPE_KEYWORDS.design.some((kw) => lowerPrompt.includes(kw))) {
      maxScore = Math.max(maxScore, 25);
    }
    
    return maxScore;
  }
  
  /**
   * 评分维度 3：工具依赖
   * 
   * 评分规则：
   * - 0-1 个工具 = 5 分
   * - 2-3 个工具 = 10 分
   * - 4-5 个工具 = 15 分
   * - 6-8 个工具 = 20 分
   * - > 8 个工具 = 25 分
   */
  private scoreToolDependencies(prompt: string): number {
    const lowerPrompt = prompt.toLowerCase();
    
    // 估算可能使用的工具数量
    let toolCount = 0;
    for (const keyword of TOOL_KEYWORDS) {
      if (lowerPrompt.includes(keyword)) {
        toolCount++;
      }
    }
    
    if (toolCount <= 1) return 5;
    if (toolCount <= 3) return 10;
    if (toolCount <= 5) return 15;
    if (toolCount <= 8) return 20;
    return 25;
  }
  
  /**
   * 评分维度 4：历史表现
   * 
   * 评分规则：
   * - 无历史数据 = 12 分（中等）
   * - 成功率 > 80% = 5 分（简单）
   * - 成功率 50-80% = 15 分（中等偏难）
   * - 成功率 < 50% = 25 分（困难）
   * 
   * 注：当前版本暂不实现历史数据查询，返回默认值
   */
  private scoreHistoricalPerformance(_taskTree: TaskTree): number {
    // TODO: 实现历史数据查询
    // 当前返回默认值：12 分（中等）
    return 12;
  }
  
  /**
   * 根据总分计算推荐的最大深度
   * 
   * 计算公式：
   * - 0-30 分 → maxDepth = 1
   * - 31-60 分 → maxDepth = 2
   * - 61-100 分 → maxDepth = 3
   * 
   * 限制范围：1-3
   */
  private calculateDepth(totalScore: number): number {
    if (totalScore <= 30) return 1;
    if (totalScore <= 60) return 2;
    return 3;
  }
}
