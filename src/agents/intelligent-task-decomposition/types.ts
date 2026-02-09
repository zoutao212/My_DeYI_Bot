/**
 * 智能任务分解系统 - 核心数据类型
 * 
 * 定义任务树、子任务、检查点、失败日志、错误日志等核心数据结构
 */

/**
 * 任务树
 * 
 * 表示一个完整的任务分解树，包含根任务和所有子任务
 */
export interface TaskTree {
  /** 任务树 ID（通常是 sessionId） */
  id: string;
  
  /** 根任务描述 */
  rootTask: string;
  
  /** 所有子任务 */
  subTasks: SubTask[];
  
  /** 任务树状态 */
  status: "pending" | "active" | "completed" | "failed";
  
  /** 创建时间戳 */
  createdAt: number;
  
  /** 更新时间戳 */
  updatedAt: number;
  
  /** 检查点 ID 列表 */
  checkpoints: string[];
  
  // 🆕 递归任务系统新增字段
  
  /** 版本号（用于版本管理和回滚） */
  version?: number;
  
  /** 最大分解深度（默认 3，防止无限递归） */
  maxDepth?: number;
  
  /** 当前深度（根任务为 0） */
  currentDepth?: number;
  
  /** 是否启用质量评估（默认 true） */
  qualityReviewEnabled?: boolean;
  
  /** 质量状态 */
  qualityStatus?: QualityStatus;
  
  /** 失败历史（用于学习和改进） */
  failureHistory?: FailureRecord[];
  
  /** 重启次数（默认最多 2 次） */
  restartCount?: number;
  
  /** 推翻次数（默认最多 1 次） */
  overthrowCount?: number;
  
  /** 元数据（统计信息） */
  metadata?: TaskTreeMetadata;
  
  // 🆕 批量执行相关字段
  
  /** 任务批次列表 */
  batches?: TaskBatch[];
}

/**
 * 子任务
 * 
 * 表示任务树中的一个子任务
 */
export interface SubTask {
  /** 子任务 ID */
  id: string;
  
  /** 任务提示词 */
  prompt: string;
  
  /** 任务简短描述 */
  summary: string;
  
  /** 任务状态 */
  status: "pending" | "active" | "completed" | "failed" | "interrupted";
  
  /** 任务输出 */
  output?: string;
  
  /** 错误信息 */
  error?: string;
  
  /** 重试次数 */
  retryCount: number;
  
  /** 创建时间戳 */
  createdAt: number;
  
  /** 完成时间戳 */
  completedAt?: number;
  
  // 🆕 递归任务系统新增字段
  
  /** 父任务 ID（用于递归分解，null 表示根级任务） */
  parentId?: string | null;
  
  /** 任务深度（根任务为 0，子任务为父任务深度 + 1） */
  depth?: number;
  
  /** 子任务列表（递归结构，支持多层嵌套） */
  children?: SubTask[];
  
  /** 依赖的任务 ID 列表（必须在这些任务完成后才能执行） */
  dependencies?: string[];
  
  /** 是否可以继续分解（基于复杂度和深度限制） */
  canDecompose?: boolean;
  
  /** 是否已分解（标记任务是否已经被分解成子任务） */
  decomposed?: boolean;
  
  /** 是否等待子任务完成（用于递归回溯，父任务等待所有子任务完成后才执行） */
  waitForChildren?: boolean;
  
  /** 
   * 轮次 ID（用于隔离不同用户请求产生的子任务）
   * 
   * 同一次用户消息触发的所有子任务（包括递归分解）共享同一个 rootTaskId。
   * 完成检查只看当前轮次，避免多轮累积导致 allDone 永远为 false。
   */
  rootTaskId?: string;
  
  /** 是否启用质量评估（默认继承任务树设置） */
  qualityReviewEnabled?: boolean;
  
  /** 质量状态 */
  qualityStatus?: QualityStatus;
  
  /** 元数据（复杂度、优先级、时长估算等） */
  metadata?: SubTaskMetadata;
}

/**
 * 检查点
 * 
 * 表示任务树的一个快照，用于恢复
 */
export interface Checkpoint {
  /** 检查点 ID */
  id: string;
  
  /** 任务树快照 */
  taskTree: TaskTree;
  
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 失败日志
 * 
 * 记录子任务的失败信息
 */
export interface FailureLog {
  /** 子任务 ID */
  subTaskId: string;
  
  /** 错误信息 */
  error: string;
  
  /** 堆栈跟踪 */
  stackTrace: string;
  
  /** 重试次数 */
  retryCount: number;
  
  /** 时间戳 */
  timestamp: number;
}

/**
 * 错误日志
 * 
 * 记录系统级别的错误信息
 */
export interface ErrorLog {
  /** 错误类型 */
  errorType: "llm_request_failed" | "file_system_failed" | "out_of_memory" | "system_crash";
  
  /** 错误信息 */
  error: string;
  
  /** 堆栈跟踪 */
  stackTrace: string;
  
  /** 上下文信息 */
  context: Record<string, unknown>;
  
  /** 时间戳 */
  timestamp: number;
}

/**
 * 质量状态
 * 
 * 表示任务或任务树的质量评估状态
 */
export type QualityStatus = 
  | "pending"           // 待评估
  | "passed"            // 通过
  | "needs_adjustment"  // 需要调整
  | "needs_restart"     // 需要重启
  | "needs_overthrow";  // 需要推翻

/**
 * 失败记录
 * 
 * 记录任务失败的详细信息，用于学习和改进
 */
export interface FailureRecord {
  /** 失败记录 ID */
  id: string;
  
  /** 失败时间戳 */
  timestamp: number;
  
  /** 失败原因 */
  reason: string;
  
  /** 失败上下文 */
  context: string;
  
  /** 学到的教训 */
  lessons: string[];
  
  /** 改进建议 */
  improvements: string[];
}

/**
 * 任务树元数据
 * 
 * 记录任务树的统计信息
 */
export interface TaskTreeMetadata {
  /** 总任务数 */
  totalTasks: number;
  
  /** 已完成任务数 */
  completedTasks: number;
  
  /** 失败任务数 */
  failedTasks: number;
  
  /** 预估总时长（毫秒） */
  estimatedDuration?: number;
  
  /** 实际总时长（毫秒） */
  actualDuration?: number;
  
  // 🆕 任务系统改进：复杂度评分相关字段
  
  /** 复杂度评分（0-100） */
  complexityScore?: number;
  
  /** 计算得出的最大深度（1-3） */
  calculatedMaxDepth?: number;
  
  /** 评分维度详情 */
  scoreDimensions?: {
    promptLength: number;
    taskType: number;
    toolDependencies: number;
    historicalPerformance: number;
  };
}

/**
 * 子任务元数据
 * 
 * 记录子任务的详细信息
 */
export interface SubTaskMetadata {
  /** 预估时长（毫秒） */
  estimatedDuration?: number;
  
  /** 实际时长（毫秒） */
  actualDuration?: number;
  
  /** 复杂度（低/中/高） */
  complexity?: "low" | "medium" | "high";
  
  /** 优先级（低/中/高） */
  priority?: "low" | "medium" | "high";
  
  // 🆕 批量执行相关字段
  
  /** 预估输出 tokens */
  estimatedTokens?: number;
  
  /** 是否可以批量执行（默认 true） */
  canBatch?: boolean;
  
  /** 所属批次 ID（如果已分配到批次） */
  batchId?: string;
  
  /** 在批次中的索引（用于输出拆分） */
  batchIndex?: number;
  
  // 🆕 汇总任务标记
  
  /** 是否是汇总任务（等待子任务完成后执行汇总） */
  isSummaryTask?: boolean;
  
  /** 是否是根任务（整个任务树的根节点） */
  isRootTask?: boolean;
  
  // 🆕 文件产出相关字段
  
  /** 是否要求产生文件输出（写作任务） */
  requiresFileOutput?: boolean;
  
  /** 期望的文件类型列表 */
  expectedFileTypes?: string[];
  
  /** 实际产生的文件名列表 */
  producedFiles?: string[];
  
  /** 实际产生的文件完整路径列表（用于 mergeTaskOutputs 精准定位） */
  producedFilePaths?: string[];
  
  // 🆕 兜底落盘相关字段
  
  /** 兜底落盘文件路径（LLM 未调用 write 工具时系统自动保存） */
  fallbackFilePath?: string;
  
  /** 兜底落盘原因 */
  fallbackReason?: string;
  
  // 🆕 质量评估相关字段
  
  /** 质量评估结果（子任务完成后由 QualityReviewer 填充） */
  qualityReview?: {
    status: string;
    decision: string;
    findings: string[];
    suggestions: string[];
  };
}

/**
 * 评估类型
 * 
 * 表示质量评估的触发场景
 */
export type ReviewType =
  | "initial_decomposition"  // 初始任务分解后的评估
  | "subtask_completion"     // 子任务完成后的评估
  | "overall_completion"     // 所有子任务完成后的整体评估
  | "failure_analysis";      // 任务失败后的分析评估

/**
 * 评估决策
 * 
 * 表示质量评估后的决策结果
 */
export type ReviewDecision =
  | "continue"      // 继续执行（质量通过）
  | "adjust"        // 调整任务树（需要小幅改进）
  | "restart"       // 重启任务（保留经验，重新分解）
  | "overthrow";    // 推翻任务（完全重新开始）

/**
 * 质量评估记录
 * 
 * 记录一次完整的质量评估过程和结果
 */
export interface QualityReviewRecord {
  /** 评估记录 ID */
  id: string;
  
  /** 任务树 ID */
  taskTreeId: string;
  
  /** 子任务 ID（如果是子任务评估，否则为 undefined） */
  subTaskId?: string;
  
  /** 评估类型 */
  type: ReviewType;
  
  /** 评估状态 */
  status: QualityStatus;
  
  /** 评估时间戳 */
  reviewedAt: number;
  
  /** 评估标准（AI 使用的评估标准列表） */
  criteria: string[];
  
  /** 发现的问题（AI 发现的具体问题） */
  findings: string[];
  
  /** 改进建议（AI 提出的改进建议） */
  suggestions: string[];
  
  /** 评估决策（AI 做出的决策） */
  decision: ReviewDecision;
  
  /** 应用的变更（如果决策是调整，记录具体变更） */
  changes?: TaskTreeChange[];
}

/**
 * 质量评估结果
 * 
 * 表示一次质量评估的输出结果
 */
export interface QualityReviewResult {
  /** 评估状态 */
  status: QualityStatus;
  
  /** 评估决策 */
  decision: ReviewDecision;
  
  /** 评估标准 */
  criteria: string[];
  
  /** 发现的问题 */
  findings: string[];
  
  /** 改进建议 */
  suggestions: string[];
  
  /** 建议的修改（如果决策是调整） */
  modifications?: TaskTreeChange[];
}

/**
 * 失败分析结果
 * 
 * 表示对任务失败的分析结果
 */
export interface FailureAnalysisResult {
  /** 失败原因 */
  reason: string;
  
  /** 失败上下文 */
  context: string;
  
  /** 学到的教训 */
  lessons: string[];
  
  /** 改进建议 */
  improvements: string[];
  
  /** 评估决策（基于失败严重程度） */
  decision: ReviewDecision;
}

/**
 * 变更类型
 * 
 * 表示任务树变更的操作类型
 */
export type ChangeType =
  | "add_task"      // 添加新任务
  | "remove_task"   // 删除任务
  | "modify_task"   // 修改任务属性
  | "move_task"     // 移动任务到新的父任务
  | "merge_tasks"   // 合并多个任务
  | "split_task";   // 拆分任务为多个子任务

/**
 * 任务树变更
 * 
 * 记录对任务树的一次变更操作
 */
export interface TaskTreeChange {
  /** 变更类型 */
  type: ChangeType;
  
  /** 目标任务 ID（被操作的任务） */
  targetId: string;
  
  /** 变更前的值（用于回滚） */
  before?: any;
  
  /** 变更后的值 */
  after?: any;
  
  /** 变更时间戳 */
  timestamp: number;
}

/**
 * 验证结果
 * 
 * 表示任务树或变更操作的验证结果
 */
export interface ValidationResult {
  /** 是否验证通过 */
  valid: boolean;
  
  /** 错误列表（验证失败的原因） */
  errors: string[];
  
  /** 警告列表（不影响验证通过，但需要注意的问题） */
  warnings: string[];
}

// ========================================
// 🆕 批量任务执行相关类型
// ========================================

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
  
  /** 批次状态 */
  status?: "pending" | "active" | "completed" | "failed";
  
  /** 批次创建时间 */
  createdAt: number;
  
  /** 批次完成时间 */
  completedAt?: number;
  
  /** 批次输出（合并后的输出） */
  output?: string;
  
  /** 批次错误信息 */
  error?: string;
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
 * 批量执行选项
 */
export interface BatchExecutionOptions {
  /** 输出分隔符（默认 "---TASK-SEPARATOR---"） */
  separator?: string;
  
  /** 是否启用后备拆分（默认 true） */
  enableFallbackSplit?: boolean;
  
  /** 超时时间（毫秒，默认 120000 = 2 分钟） */
  timeout?: number;
}

/**
 * 批量执行结果
 */
export interface BatchExecutionResult {
  /** 批次 ID */
  batchId: string;
  
  /** 是否成功 */
  success: boolean;
  
  /** 任务输出映射（任务 ID -> 输出） */
  outputs: Map<string, string>;
  
  /** 错误信息（如果失败） */
  error?: string;
  
  /** 执行时长（毫秒） */
  duration: number;
  
  /** 实际消耗的 tokens */
  actualTokens?: number;
}

// ========================================
// 🆕 子任务后处理结果
// ========================================

/**
 * 子任务后处理结果
 * 
 * postProcessSubTaskCompletion() 的返回值，
 * 告知调用方（followup-runner）需要执行的后续动作。
 */
export interface PostProcessResult {
  /** 质量评估决策 */
  decision: ReviewDecision;
  /** 质量评估状态 */
  status: QualityStatus;
  /** 评估发现 */
  findings: string[];
  /** 改进建议 */
  suggestions: string[];
  /** 是否需要重新入队（restart 决策时为 true） */
  needsRequeue: boolean;
  /** 是否已标记失败（overthrow 决策时为 true） */
  markedFailed: boolean;
}

// ========================================
// 🆕 交付报告相关类型
// ========================================

/**
 * 交付报告
 * 
 * 表示任务树的交付报告数据
 */
export interface DeliveryReport {
  /** 根任务描述 */
  rootTask: string;
  
  /** 任务列表 */
  tasks: Array<{
    id: string;
    summary: string;
    status: string;
    result?: string;
  }>;
  
  /** 统计信息 */
  stats: {
    total: number;
    completed: number;
    failed: number;
  };
  
  /** 开始时间 */
  startTime?: number;
  
  /** 结束时间 */
  endTime?: number;
  
  /** 统计数据（兼容旧版本） */
  statistics?: {
    successRate: string;
  };
}
