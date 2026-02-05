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
