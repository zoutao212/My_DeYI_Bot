/**
 * 任务分组器
 * 
 * 智能分组任务，决定哪些任务可以批量执行
 * 
 * 核心功能：
 * - 根据相似度分组（相似的任务优先批量执行）
 * - 根据大小分组（小任务优先批量执行）
 * - 根据依赖关系分组（无依赖关系的任务可以批量执行）
 * - 单个批次最多 3-5 个任务
 * - 单个批次预估输出 < 6000 tokens
 * - 批次内任务必须无依赖关系
 */

import type { SubTask, TaskTree } from "./types.js";

/**
 * 任务批次
 * 
 * 表示一组可以批量执行的任务
 */
export interface TaskBatch {
  /** 批次 ID */
  id: string;
  
  /** 批次中的任务列表 */
  tasks: SubTask[];
  
  /** 预估总输出 tokens */
  estimatedTokens: number;
  
  /** 批次创建时间 */
  createdAt: number;
}

/**
 * 分组选项
 */
export interface GroupingOptions {
  /** 单个批次最多任务数（默认 5） */
  maxTasksPerBatch?: number;
  
  /** 单个批次最大 tokens（默认 6000） */
  maxTokensPerBatch?: number;
  
  /** 是否启用相似度分组（默认 true） */
  enableSimilarityGrouping?: boolean;
  
  /** 是否启用大小分组（默认 true） */
  enableSizeGrouping?: boolean;
  
  /** 相似度阈值（0-1，默认 0.6） */
  similarityThreshold?: number;
}

/**
 * 任务分组器
 */
export class TaskGrouper {
  private options: Required<GroupingOptions>;

  constructor(options: GroupingOptions = {}) {
    this.options = {
      maxTasksPerBatch: options.maxTasksPerBatch ?? 5,
      maxTokensPerBatch: options.maxTokensPerBatch ?? 6000,
      enableSimilarityGrouping: options.enableSimilarityGrouping ?? true,
      enableSizeGrouping: options.enableSizeGrouping ?? true,
      similarityThreshold: options.similarityThreshold ?? 0.6,
    };
  }

  /**
   * 分组任务（主入口）
   * 
   * @param taskTree 任务树
   * @param tasks 要分组的任务列表
   * @returns 任务批次列表
   */
  groupTasks(taskTree: TaskTree, tasks: SubTask[]): TaskBatch[] {
    // 1. 过滤出可以批量执行的任务
    const batchableTasks = tasks.filter(task => this.canBatch(task, taskTree));

    if (batchableTasks.length === 0) {
      console.log("[TaskGrouper] ℹ️ No batchable tasks found");
      return [];
    }

    console.log(`[TaskGrouper] 📊 Found ${batchableTasks.length} batchable tasks out of ${tasks.length} total tasks`);

    // 2. 按优先级排序（优先级高的任务优先分组）
    const sortedTasks = this.sortByPriority(batchableTasks);

    // 3. 创建批次
    const batches: TaskBatch[] = [];
    const remainingTasks = [...sortedTasks];

    while (remainingTasks.length > 0) {
      const batch = this.createBatch(taskTree, remainingTasks);
      
      if (batch.tasks.length === 0) {
        // 无法创建批次，停止
        break;
      }

      batches.push(batch);

      // 从剩余任务中移除已分组的任务
      for (const task of batch.tasks) {
        const index = remainingTasks.findIndex(t => t.id === task.id);
        if (index !== -1) {
          remainingTasks.splice(index, 1);
        }
      }
    }

    console.log(`[TaskGrouper] ✅ Created ${batches.length} batches from ${batchableTasks.length} tasks`);
    return batches;
  }

  /**
   * 创建单个批次
   * 
   * @param taskTree 任务树
   * @param tasks 候选任务列表
   * @returns 任务批次
   */
  createBatch(taskTree: TaskTree, tasks: SubTask[]): TaskBatch {
    const batch: TaskBatch = {
      id: this.generateBatchId(),
      tasks: [],
      estimatedTokens: 0,
      createdAt: Date.now(),
    };

    // 从第一个任务开始
    if (tasks.length === 0) {
      return batch;
    }

    const firstTask = tasks[0];
    batch.tasks.push(firstTask);
    batch.estimatedTokens = this.estimateTaskTokens(firstTask);

    // 尝试添加更多任务
    for (let i = 1; i < tasks.length; i++) {
      const task = tasks[i];

      if (this.canAddToBatch(batch, task, taskTree)) {
        batch.tasks.push(task);
        batch.estimatedTokens += this.estimateTaskTokens(task);
      }

      // 检查是否达到批次大小限制
      if (batch.tasks.length >= this.options.maxTasksPerBatch) {
        break;
      }
    }

    console.log(`[TaskGrouper] 📦 Created batch ${batch.id} with ${batch.tasks.length} tasks (${batch.estimatedTokens} tokens)`);
    return batch;
  }

  /**
   * 检查任务是否可以加入批次
   * 
   * @param batch 当前批次
   * @param task 要添加的任务
   * @param taskTree 任务树
   * @returns 是否可以加入
   */
  canAddToBatch(batch: TaskBatch, task: SubTask, taskTree: TaskTree): boolean {
    // 1. 检查批次大小限制
    if (batch.tasks.length >= this.options.maxTasksPerBatch) {
      return false;
    }

    // 2. 检查 tokens 限制
    const taskTokens = this.estimateTaskTokens(task);
    if (batch.estimatedTokens + taskTokens > this.options.maxTokensPerBatch) {
      return false;
    }

    // 3. 检查依赖关系（批次内任务不能有依赖关系）
    if (this.hasDependencyConflict(batch, task, taskTree)) {
      return false;
    }

    // 4. 检查相似度（如果启用）
    if (this.options.enableSimilarityGrouping) {
      const similarity = this.calculateSimilarity(batch, task);
      if (similarity < this.options.similarityThreshold) {
        return false;
      }
    }

    return true;
  }

  /**
   * 检查任务是否可以批量执行
   * 
   * @param task 任务
   * @param taskTree 任务树
   * @returns 是否可以批量执行
   */
  private canBatch(task: SubTask, taskTree: TaskTree): boolean {
    // 1. 检查任务状态（只有 pending 状态的任务可以批量执行）
    if (task.status !== "pending") {
      return false;
    }

    // 2. 检查元数据中的 canBatch 标记
    if (task.metadata?.canBatch === false) {
      return false;
    }

    // 3. 检查任务是否已分解（已分解的任务不能批量执行）
    if (task.decomposed === true) {
      return false;
    }

    // 4. 检查任务是否等待子任务完成（等待子任务的任务不能批量执行）
    if (task.waitForChildren === true && task.children && task.children.length > 0) {
      return false;
    }

    // 5. 检查任务大小（预估输出 > 6000 tokens 的任务不适合批量执行）
    const estimatedTokens = this.estimateTaskTokens(task);
    if (estimatedTokens > this.options.maxTokensPerBatch) {
      return false;
    }

    return true;
  }

  /**
   * 检查是否存在依赖冲突
   * 
   * @param batch 当前批次
   * @param task 要添加的任务
   * @param taskTree 任务树
   * @returns 是否存在依赖冲突
   */
  private hasDependencyConflict(batch: TaskBatch, task: SubTask, taskTree: TaskTree): boolean {
    // 获取批次中所有任务的 ID
    const batchTaskIds = new Set(batch.tasks.map(t => t.id));

    // 1. 检查新任务是否依赖批次中的任务
    if (task.dependencies && task.dependencies.length > 0) {
      for (const depId of task.dependencies) {
        if (batchTaskIds.has(depId)) {
          return true; // 依赖冲突
        }
      }
    }

    // 2. 检查批次中的任务是否依赖新任务
    for (const batchTask of batch.tasks) {
      if (batchTask.dependencies && batchTask.dependencies.length > 0) {
        if (batchTask.dependencies.includes(task.id)) {
          return true; // 依赖冲突
        }
      }
    }

    // 3. 检查父子关系（父任务和子任务不能在同一批次）
    for (const batchTask of batch.tasks) {
      // 检查新任务是否是批次中任务的父任务
      if (batchTask.parentId === task.id) {
        return true;
      }

      // 检查新任务是否是批次中任务的子任务
      if (task.parentId === batchTask.id) {
        return true;
      }
    }

    return false;
  }

  /**
   * 计算任务与批次的相似度
   * 
   * @param batch 当前批次
   * @param task 要添加的任务
   * @returns 相似度（0-1）
   */
  private calculateSimilarity(batch: TaskBatch, task: SubTask): number {
    if (batch.tasks.length === 0) {
      return 1.0;
    }

    // 如果批次只有一个任务，默认相似度较高（允许添加第二个任务）
    if (batch.tasks.length === 1) {
      return 0.7; // 高于默认阈值 0.6
    }

    // 计算与批次中所有任务的平均相似度
    let totalSimilarity = 0;

    for (const batchTask of batch.tasks) {
      const similarity = this.calculateTaskSimilarity(batchTask, task);
      totalSimilarity += similarity;
    }

    return totalSimilarity / batch.tasks.length;
  }

  /**
   * 计算两个任务的相似度
   * 
   * @param task1 任务 1
   * @param task2 任务 2
   * @returns 相似度（0-1）
   */
  private calculateTaskSimilarity(task1: SubTask, task2: SubTask): number {
    // 简单的相似度计算：基于 summary 和 prompt 的关键词重叠

    // 1. 提取关键词
    const keywords1 = this.extractKeywords(task1.summary + " " + task1.prompt);
    const keywords2 = this.extractKeywords(task2.summary + " " + task2.prompt);

    if (keywords1.length === 0 || keywords2.length === 0) {
      return 0.5; // 默认中等相似度
    }

    // 2. 计算 Jaccard 相似度
    const intersection = keywords1.filter(k => keywords2.includes(k)).length;
    const union = new Set([...keywords1, ...keywords2]).size;

    return union > 0 ? intersection / union : 0;
  }

  /**
   * 提取关键词
   * 
   * @param text 文本
   * @returns 关键词列表
   */
  private extractKeywords(text: string): string[] {
    // 简单的关键词提取：
    // 1. 转小写
    // 2. 分词
    // 3. 过滤停用词
    // 4. 去重

    const stopWords = new Set([
      "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好", "自己", "这",
      "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "from", "as", "is", "was", "are", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "should", "could", "may", "might", "must", "can",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, " ") // 保留中英文字符
      .split(/\s+/)
      .filter(word => word.length > 1 && !stopWords.has(word));

    return [...new Set(words)]; // 去重
  }

  /**
   * 估算任务输出 tokens
   * 
   * @param task 任务
   * @returns 预估 tokens
   */
  private estimateTaskTokens(task: SubTask): number {
    // 如果元数据中有预估值，直接使用
    if (task.metadata?.estimatedTokens) {
      return task.metadata.estimatedTokens;
    }

    // 否则，根据 prompt 和 summary 估算
    // 简单估算：中文 1 字 ≈ 2 tokens，英文 1 词 ≈ 1.3 tokens

    const text = task.prompt + " " + task.summary;
    
    // 统计中文字符数
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    
    // 统计英文单词数
    const englishWords = text
      .replace(/[\u4e00-\u9fa5]/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 0).length;

    // 估算输出 tokens（假设输出是输入的 2-3 倍）
    const inputTokens = chineseChars * 2 + englishWords * 1.3;
    const outputTokens = inputTokens * 2.5;

    // 从 prompt 中提取字数要求（如果有）
    const wordCountMatch = task.prompt.match(/(\d+)\s*字|(\d+)\s*words/i);
    if (wordCountMatch) {
      const wordCount = parseInt(wordCountMatch[1] || wordCountMatch[2]);
      // 字数 * 2 = tokens（粗略估算）
      return Math.max(outputTokens, wordCount * 2);
    }

    return Math.ceil(outputTokens);
  }

  /**
   * 按优先级排序任务
   * 
   * @param tasks 任务列表
   * @returns 排序后的任务列表
   */
  private sortByPriority(tasks: SubTask[]): SubTask[] {
    const priorityOrder = { high: 3, medium: 2, low: 1 };

    return [...tasks].sort((a, b) => {
      const aPriority = priorityOrder[a.metadata?.priority || "medium"];
      const bPriority = priorityOrder[b.metadata?.priority || "medium"];
      return bPriority - aPriority;
    });
  }

  /**
   * 生成批次 ID
   * 
   * @returns 批次 ID
   */
  private generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
