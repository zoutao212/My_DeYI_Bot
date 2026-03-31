/**
 * 智能任务分解系统 - 核心数据类型
 * 
 * 定义任务树、子任务、检查点、失败日志、错误日志等核心数据结构
 */

import type { AttemptOutcome } from "../pi-embedded-runner/run/types.js";

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
  status: "pending" | "active" | "completed" | "failed" | "cancelled";
  
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
  
  // 🆕 V2: Round 支持（向后兼容，可选字段）

  /** 轮次列表（V2 新增，按创建时间排序） */
  rounds?: Round[];
}

// ========================================
// 🆕 V2: Round — 任务轮次（一等公民）
// ========================================

/**
 * 轮次状态
 *
 * active   → 有 pending/active 子任务
 * completed→ 所有子任务 completed（且无 overthrow）
 * failed   → 有子任务 failed 或被 overthrow
 * cancelled→ 用户主动取消
 */
export type RoundStatus = "active" | "completed" | "failed" | "cancelled";

/**
 * 轮次质量评审摘要
 */
export interface RoundQualityReview {
  /** 评审状态 */
  status: QualityStatus;
  /** 评审决策 */
  decision: ReviewDecision;
  /** 发现的问题 */
  findings: string[];
  /** 改进建议 */
  suggestions: string[];
  /** 评审时间 */
  reviewedAt: number;
}

/**
 * 任务轮次 — 用户一次请求产生的所有子任务的容器
 *
 * 替代散落在 SubTask 上的 rootTaskId 字段，
 * 让"轮次"成为显式数据结构而非隐式标记。
 */
export interface Round {
  /** 轮次 ID（替代散落在 SubTask 上的 rootTaskId） */
  id: string;

  /** 轮次目标（用户实际要做的事，质量评审用这个对比） */
  goal: string;

  /** 轮次状态（有限状态机） */
  status: RoundStatus;

  /** 该轮次的所有子任务 ID */
  subTaskIds: string[];

  /** 创建时间 */
  createdAt: number;

  /** 完成时间 */
  completedAt?: number;

  /** 是否有任务被 overthrow（级联守卫用） */
  hasOverthrow: boolean;

  /** 该轮次的质量评审摘要 */
  qualityReview?: RoundQualityReview;

  /** 交付状态（用于 round 完成交付幂等控制） */
  delivery?: {
    /** 首次准备交付的时间 */
    preparedAt?: number;
    /** 实际完成交付的时间 */
    deliveredAt?: number;
    /** 最近一次合并产物路径 */
    mergedFilePath?: string;
  };

  /** 熔断器状态（Phase 7 扩展） */
  circuitBreaker?: {
    /** 累计失败次数 */
    totalFailures: number;
    /** 累计 token 消耗 */
    totalTokensUsed: number;
    /** 🆕 累计 LLM 调用次数（每次子任务执行 +1，质检 +1） */
    llmCallCount: number;
    /** 🆕 LLM 调用预算上限（默认 100，用户可指定） */
    llmCallBudget: number;
    /** 是否已熔断 */
    tripped: boolean;
    /** 熔断原因 */
    tripReason?: string;
  };
}

// ========================================
// 🆕 V2: FSM 转换规则（Phase 1 状态机实现的类型基础）
// ========================================

/**
 * SubTask 状态类型别名（方便引用）
 */
export type SubTaskStatus = SubTask["status"];

/**
 * FSM 转换规则
 *
 * from → to 的合法转换，附带可选的守卫函数。
 * Phase 1 实现时会用这个类型构建实际的转换表。
 */
export interface FSMTransitionRule<S extends string> {
  /** 起始状态 */
  from: S;
  /** 目标状态 */
  to: S;
  /** 守卫条件描述（人读） */
  guard?: string;
}

/**
 * Round FSM 合法转换列表（常量，设计时确定，运行时只读）
 *
 * Phase 1 中会实现实际的 transition() 函数，这里只定义类型。
 */
export const ROUND_TRANSITIONS: ReadonlyArray<FSMTransitionRule<RoundStatus>> = [
  { from: "active",    to: "completed", guard: "allSubTasksDone && !hasOverthrow" },
  { from: "active",    to: "failed",    guard: "anySubTaskOverthrown" },
  { from: "active",    to: "cancelled", guard: "userCancelled" },
] as const;

/**
 * SubTask FSM 合法转换列表
 */
export const SUBTASK_TRANSITIONS: ReadonlyArray<FSMTransitionRule<SubTaskStatus>> = [
  { from: "pending",  to: "active",    guard: "taskPickedUp" },
  { from: "active",   to: "completed", guard: "executionSuccess" },
  { from: "active",   to: "failed",    guard: "executionFailed" },
  { from: "pending",  to: "skipped",   guard: "roundOverthrown (cascade)" },
  { from: "active",   to: "skipped",   guard: "roundOverthrown (cascade)" },
] as const;

// ========================================
// 🆕 V2: ExecutionContext — 执行上下文（替代布尔标记海洋）
// ========================================

/**
 * 执行角色
 *
 * user   → 用户直接发消息，完整权限
 * root   → 根任务（用户消息触发的第一层 LLM 调用），可分解
 * leaf   → 叶子子任务（队列执行的具体工作），仅执行，禁止 enqueue
 * system → 系统自动分解（shouldAutoDecompose），受控分解
 */
export type ExecutionRole = "user" | "root" | "leaf" | "system";

/**
 * 执行权限集
 */
export interface ExecutionPermissions {
  /** 是否允许调用 enqueue_task */
  canEnqueue: boolean;
  /** 是否允许触发分解 */
  canDecompose: boolean;
  /** 是否允许创建新 Round */
  canCreateNewRound: boolean;
}

/**
 * 权限矩阵（设计时确定，运行时只读）
 *
 * 替代 isQueueTask/isRootTask/isNewRootTask 布尔标记组合。
 * 4 个角色 = 4 种明确行为，无歧义。
 */
export const PERMISSION_MATRIX: Record<ExecutionRole, ExecutionPermissions> = {
  user:   { canEnqueue: true,  canDecompose: true,  canCreateNewRound: true  },
  root:   { canEnqueue: true,  canDecompose: true,  canCreateNewRound: false },
  leaf:   { canEnqueue: false, canDecompose: false, canCreateNewRound: false },
  system: { canEnqueue: true,  canDecompose: true,  canCreateNewRound: false },
};

/**
 * 执行上下文 — 决定当前 agent 调用的权限边界
 *
 * 由 Orchestrator.onTaskStarting() 在任务执行前构建。
 * 传递给 followup-runner，followup-runner 再传递给工具上下文。
 */
export interface ExecutionContext {
  /** 执行角色 */
  role: ExecutionRole;

  /** 所属轮次 ID */
  roundId: string;

  /** 当前任务深度 */
  depth: number;

  /** 权限集（由 role 推导，不可手动覆盖） */
  permissions: ExecutionPermissions;
}

// ========================================
// 🆕 V2: TaskType — 任务类型感知
// ========================================

/**
 * 任务类型 — 决定执行策略和质量评审标准
 *
 * 设计原则：按"执行方式"分类，而非"内容领域"分类。
 * （"科幻小说"和"游记"都是 writing，执行方式相同）
 */
export type TaskType =
  | "writing"      // 创作型：LLM 生成内容并写入文件
  | "coding"       // 编码型：LLM 编写/修改代码
  | "analysis"     // 分析型：LLM 阅读内容并产出结论
  | "research"     // 研究型：LLM 搜索、整理、综合信息
  | "data"         // 数据型：LLM 处理、转换、统计数据
  | "design"       // 设计型：LLM 产出架构、方案、系统设计
  | "merge"        // 合并型：系统拼接多个文件（不应走 LLM）
  | "delivery"     // 交付型：系统发送文件到用户（不应走 LLM）
  | "planning"     // 规划型：LLM 产出大纲/计划
  | "review"       // 审校型：LLM 阅读并校对/修改
  | "automation"   // 自动化型：LLM 编排多工具调用完成操作流
  | "generic";     // 通用型：无法分类，走标准 LLM

// ========================================
// 🆕 V2: 工厂函数类型签名（Phase 1/2 实现）
// ========================================

/**
 * 创建 Round 的参数
 */
export interface CreateRoundParams {
  /** 轮次目标（用户原始 prompt 或摘要） */
  goal: string;
  /** 会话 ID（用于生成唯一 Round ID） */
  sessionId: string;
}

/**
 * 创建 ExecutionContext 的参数
 */
export interface CreateExecutionContextParams {
  /** 执行角色 */
  role: ExecutionRole;
  /** 所属轮次 ID */
  roundId: string;
  /** 当前任务深度 */
  depth: number;
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
  status: "pending" | "active" | "completed" | "failed" | "interrupted" | "skipped";
  
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

  /** 最近一次进入 active 状态的时间戳（用于僵尸检测，替代 createdAt） */
  lastActiveAt?: number;
  
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
  
  // 🆕 V2: 新增字段（向后兼容，全部可选）

  /** 所属轮次 ID（V2 新增，与 Round.id 关联） */
  roundId?: string;

  /** 任务类型（分解时由系统自动分类或 LLM 标注） */
  taskType?: TaskType;

  /** 执行角色（由 ExecutionContext 在执行时填入） */
  executionRole?: ExecutionRole;

  /** 执行策略偏好（由 StrategyRouter 在 preflight 阶段填入） */
  preferredStrategy?: string;

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
  | "partial"           // 部分完成（已有输出可保留，但需要续写补足）
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

  // 🆕 V3: 总纲领（Master Blueprint）— 多智能体编排的共享上下文

  /**
   * AI 生成的总纲领/创作大纲
   *
   * 在根任务首次分解前由 LLM 生成，包含：
   * - 整体规划（如完整剧情大纲、架构设计、项目蓝图）
   * - 子任务间的协调约束（角色一致性、风格统一、接口规范）
   * - 各子任务的详细大纲
   *
   * 所有子任务执行时通过 extraSystemPrompt 注入此纲领，
   * 实现"指挥家不亲自演奏，但确保每件乐器在正确时间发出正确声音"。
   */
  masterBlueprint?: string;

  /** masterBlueprint 生成时间 */
  blueprintGeneratedAt?: number;

  // 🆕 V7: 结构化纲领（写作任务多轮次生成）
  // 将原本单次生成的 masterBlueprint 拆分为结构化组件，
  // 每个组件可以精准注入到对应的章节子任务中，避免截断丢失关键信息。

  /** 人物卡片集合（每个主要角色的完整档案：性格/动机/成长弧线/关系网络/外貌标签） */
  blueprintCharacterCards?: string;

  /** 世界观设定（核心设定/背景规则/重要地点/时间线/力量体系等） */
  blueprintWorldBuilding?: string;

  /** 各章节剧情纲要（按章节号索引，每章包含：核心情节/出场角色/场景/衔接钩子） */
  blueprintChapterSynopses?: Record<string, string>;

  /** 风格指南（叙事视角/语言风格/氛围基调/禁忌事项） */
  blueprintStyleGuide?: string;

  /** 纲领版本号（每次迭代优化 +1，用于追踪精炼次数） */
  blueprintVersion?: number;

  // 🆕 V8 P3: 经验池摘要（分解前注入）
  /** 从经验池查询到的历史教训摘要，供 buildDecompositionPrompt 读取 */
  experienceSummary?: string;

  /**
   * 🆕 Agent 工作流状态机（任务树级）
   * dialog  : 普通对话态（不强制入队）
   * task    : 任务态（agent loop，强制推进直到 round 结束）
   * closing : 收尾态（合并/交付/归档进行中或刚完成）
   */
  agentMode?: "dialog" | "task" | "closing";

  /** agentMode 最近一次切换原因（短文本，用于观测与回放） */
  agentModeReason?: string;

  /** agentMode 最近一次切换时间（ms） */
  agentModeUpdatedAt?: number;
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

  /** 持久化/落盘警告（不阻塞主流程，但必须可追溯） */
  persistenceWarnings?: string[];
  
  // 🆕 兜底落盘相关字段
  
  /** 兜底落盘文件路径（LLM 未调用 write 工具时系统自动保存） */
  fallbackFilePath?: string;
  
  /** 兜底落盘原因 */
  fallbackReason?: string;
  
  // 🆕 质量评估相关字段

  /** overthrow 累计次数（首次降级为 restart，连续 2 次才真正 failed） */
  overthrowCount?: number;
  
  /** 质量评估结果（子任务完成后由 QualityReviewer 填充） */
  qualityReview?: {
    status: string;
    decision: string;
    findings: string[];
    suggestions: string[];
  };

  /**
   * 上下文收缩等级（0=不收缩）。当检测到上下文溢出/临时性崩溃时逐步提升，
   * followup-runner 会据此减少“经验池/记忆/素材”等重上下文注入，避免长程连续被 context 爆炸拖死。
   */
  contextShrinkLevel?: number;

  /** attempt 层结构化失败分类与恢复建议（用于诊断与回放，不影响业务逻辑） */
  lastAttemptOutcome?: AttemptOutcome;

  // 🆕 drain Watchdog 熔断保护（任务树级硬标记）

  /** 是否被 drain Watchdog 熔断丢弃（用于避免反复卡死） */
  watchdogDropped?: boolean;

  /** 熔断丢弃原因（短文本，可回放） */
  watchdogDropReason?: string;

  /** 熔断丢弃评分（越高越危险） */
  watchdogDropScore?: number;

  /** 熔断丢弃时间戳（ms） */
  watchdogDropAt?: number;

  /** 熔断丢弃选择依据（诊断用，不保证稳定结构） */
  watchdogDropExplain?: Record<string, unknown>;

  // 🆕 迭代优化相关字段

  /** 上一次执行的输出（restart 时保存，用于下次重试时注入 prompt 做迭代优化） */
  previousOutput?: string;

  /** 上一次质检失败的原因（restart 时保存，用于下次重试时告知 LLM 避免重复犯错） */
  lastFailureFindings?: string[];

  // 🆕 续写子任务标识字段

  /** 是否是续写子任务（由 decomposeFailedTask 创建） */
  isContinuation?: boolean;

  /** 续写的原始子任务 ID */
  continuationOf?: string;

  /** 续写部分编号（第 N 部分） */
  continuationPart?: number;

  // 🆕 restart 时保存的旧文件路径

  /** 上一次执行产生的文件路径（restart 时保存，供参考） */
  previousProducedFilePaths?: string[];

  // 🆕 V4: 章节分段子任务标识字段（智能分段：大章节 → 多个小分段 → 合并）

  /** 是否是分段子任务（由 decomposeWritingTaskIntoSegments 创建） */
  isSegment?: boolean;

  /** 分段所属的父章节子任务 ID */
  segmentOf?: string;

  /** 分段序号（从 1 开始） */
  segmentIndex?: number;

  /** 总分段数 */
  totalSegments?: number;

  /** 每个分段的目标字数 */
  segmentTargetChars?: number;

  /** 最终合并后的章节文件名（如 "九天星辰录_第01章.txt"） */
  chapterFileName?: string;

  /** 🔧 P37: 标准化分段文件名（如 "九天星辰录_第01章_第1节.txt"） */
  segmentFileName?: string;

  /** 🔧 P51: 章节编号（从 1 开始，用于精准匹配 V7 blueprintChapterSynopses） */
  chapterNumber?: number;

  // 🔧 P113: 追加写入模式相关字段

  /** 是否是追加写入子任务（由 decomposeWritingTaskWithAppend 创建） */
  isAppendTask?: boolean;

  /** 追加模式标记（与 isAppendTask 配合使用） */
  appendMode?: boolean;

  /** 追加写入的目标文件名（所有追加子任务写入同一文件） */
  appendTargetFile?: string;

  // 🆕 V5: 大文本 Map-Reduce 分析（大文件 → 分 chunk 阅读 → 逐级汇总 → 最终产出）

  /** 是否是 chunk 处理子任务（由 decomposeIntoMapReduce 创建） */
  isChunkTask?: boolean;

  /** chunk 所属的父任务 ID */
  chunkOf?: string;

  /** chunk 序号（从 1 开始） */
  chunkIndex?: number;

  /** 总 chunk 数 */
  totalChunks?: number;

  /** 要读取的行范围 [startLine, endLine]（1-indexed，包含两端） */
  chunkLineRange?: [number, number];

  /** 源文件绝对路径 */
  sourceFilePath?: string;

  /** 所处的 Map-Reduce 阶段 */
  chunkPhase?: "map" | "reduce" | "finalize";

  /** reduce 任务的批次号（从 1 开始） */
  reduceBatchIndex?: number;

  /** reduce/finalize 任务依赖的 chunk 输出文件路径列表 */
  chunkInputFiles?: string[];

  // 🆕 V3: 子任务级大纲与并行标记

  /**
   * 子任务专属大纲（由 masterBlueprint 派生）
   *
   * 例如对于小说写作：每章的详细内容大纲（场景、角色行动、情感节点、衔接点）
   * 例如对于项目开发：该模块的接口规范、依赖说明、验收标准
   */
  chapterOutline?: string;

  /**
   * 是否可安全并行执行
   *
   * 当 masterBlueprint 存在且子任务间无数据依赖时标记为 true。
   * 让 drain.ts 的并行调度器优先并发执行这些任务。
   */
  parallelSafe?: boolean;

  // 🆕 V6: 泛化验证相关字段

  /**
   * 子任务的验证策略列表（由 classifyTaskType 自动填充）
   *
   * 不同任务类型使用不同的验证策略：
   * - word_count: 字数检查（写作类）
   * - file_output: 文件产出检查（写作/编码/数据类）
   * - code_syntax: 代码语法检查（编码类）
   * - completeness: 完成度检查（通用）
   * - structured_output: 结构化输出检查（数据/分析类）
   * - tool_usage: 工具调用检查（自动化类）
   */
  validationStrategies?: string[];

  /** 验证通过的策略列表（执行后由 validator 填充） */
  passedValidations?: string[];

  /** 验证失败的策略及原因 */
  failedValidations?: Array<{ strategy: string; reason: string }>;

  // 🆕 P65: 合并质量指标

  /** 章节合并质量评级（由 mergeSegmentsIfComplete 填充） */
  mergeQuality?: "excellent" | "good" | "degraded" | "failed";

  /** 章节合并后总字数 */
  mergeChars?: number;

  // 🆕 V9: 智能摘要字段（由 smart-summarizer.ts llm_light 生成）

  /** AI 生成的任务产出智能摘要（比截断原文信息密度高 5-10 倍） */
  smartSummary?: string;

  /** 父任务目标的精炼摘要（让子任务清晰知道整体目标） */
  parentGoalSummary?: string;

  // 🆕 S1: 输出契约（OutputContract）— 结构化的产出规范
  // 由系统在任务创建/分解时生成，非 LLM prompt 控制。
  // 用于：prompt 注入、后验检查、自动修正、上下文继承。

  /**
   * 输出契约 — 任务执行前确定的结构化产出规范
   *
   * 生命周期：
   * 1. 创建时：由 decomposeWritingTaskIntoSegments / decomposeFailedTask / enqueue_task 生成
   * 2. 继承时：续写/分段子任务从父任务继承（不丢失上下文）
   * 3. 执行后：followup-runner 用 contract 校验产出文件名，不符时自动重命名
   */
  outputContract?: OutputContract;

  // 🆕 ToolCall 2.0 增强配置
  /** ToolCall 2.0 增强配置 */
  toolCallV2Config?: ToolCallV2Config;

  /** 动态生成的执行策略 */
  dynamicExecutionStrategy?: DynamicExecutionStrategy;
}

/**
 * 输出契约 — 结构化的产出规范（S1 增强）
 *
 * 生命周期：
 * 1. 创建时：由 decomposeWritingTaskIntoSegments / decomposeFailedTask / enqueue_task 生成
 * 2. 继承时：续写/分段子任务从父任务继承（不丢失上下文）
 * 3. 执行后：followup-runner 用 contract 校验产出文件名，不符时自动重命名
 */
export interface OutputContract {
  /** 期望的输出文件名（不含路径，如 "九天星辰录_第02章_续写2.txt"） */
  expectedFileName?: string;

  /** 期望的输出语言（"zh" | "en" | "auto"），用于检测 LLM 输出语言偏差 */
  expectedLanguage?: string;

  /** 期望的最小字数 */
  minChars?: number;

  /** 期望的最大字数 */
  maxChars?: number;

  /** 所属书名/项目名（如"九天星辰录"），用于生成标准化文件名 */
  projectName?: string;

  /** 所属章节号（从 1 开始） */
  chapterNumber?: number;

  /** 父任务的 chapterFileName（继承用） */
  parentChapterFileName?: string;
}

// 🆕 ToolCall 2.0 增强执行相关类型

/**
 * ToolCall 2.0 增强配置
 */
export interface ToolCallV2Config {
  /** 是否启用 ToolCall 2.0 增强 */
  enabled: boolean;
  /** 偏好的操作类型 */
  preferredOperations: string[];
  /** 增强级别：light/medium/heavy */
  enhancementLevel: "light" | "medium" | "heavy";
  /** 允许的编程语言 */
  allowedLanguages?: ("python" | "javascript" | "typescript")[];
  /** 允许的模块列表 */
  allowedModules?: string[];
  /** 是否允许工具组合 */
  allowToolComposition?: boolean;
  /** 是否允许记忆增强 */
  allowMemoryEnhancement?: boolean;
}

/**
 * 动态执行策略
 */
export interface DynamicExecutionStrategy {
  /** 代码模板 */
  codeTemplate?: string;
  /** 工具组合配置 */
  toolComposition?: {
    name: string;
    description: string;
    composition_code: string;
    language: 'python' | 'javascript' | 'typescript';
    input_schema: Record<string, unknown>;
    allowed_tools: string[];
    timeout?: number;
  };
  /** 自适应算法列表 */
  adaptiveAlgorithms?: string[];
  /** 执行策略类型 */
  strategyType: "code_generation" | "tool_composition" | "memory_enhancement" | "hybrid";
  /** 预估执行时间（秒） */
  estimatedExecutionTime?: number;
  /** 预估内存使用（MB） */
  estimatedMemoryUsage?: number;
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
  | "overthrow"     // 推翻任务（完全重新开始）
  | "decompose";    // 🆕 分治策略：将失败的子任务拆分为更小的子任务（结构性失败时使用）

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

  /**
   * 🆕 问题 Z 修复：失败类型分类（decision 为 restart/overthrow 时由质检 LLM 填写）
   * 
   * 系统根据 failureType 选择最优重试策略：
   * - word_count: 字数不达标 → 重试 1 次后转 decompose（拆分积累）
   * - content_confusion: 内容混乱/混入其他章节 → 不重试，直接 decompose 或 fail
   * - quality: 内容质量差/逻辑不通 → 正常 restart（换 prompt 措辞）
   * - style: 风格偏差/语气不当 → restart + 注入风格约束
   * - repetition: 重复内容 → restart + 注入"避免重复"指令
   * - off_topic: 跑题/偏离任务要求 → restart
   * - other: 其他/无法分类 → 正常 restart
   */
  failureType?: "word_count" | "content_confusion" | "quality" | "style" | "repetition" | "off_topic" | "incomplete" | "wrong_format" | "tool_misuse" | "logic_error" | "other";
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
  /** 🆕 V2 Phase 4: 轮次是否已完成（onTaskCompleted 设置） */
  roundCompleted?: boolean;
  /** 🆕 V2 Phase 4: 完成的轮次 ID（roundCompleted=true 时必填） */
  completedRoundId?: string;
  /** 🆕 adjust 决策新增的子任务 ID 列表（需要 followup-runner 入队） */
  newTaskIds?: string[];
  /** 🆕 decompose 决策：分解产生的新子任务 ID 列表（需要 followup-runner 入队） */
  decomposedTaskIds?: string[];
}

// ========================================
// 🆕 V2 Phase 4: 生命周期钩子决策类型
// ========================================

/**
 * 任务创建决策 — onTaskCreating() 的返回值
 *
 * 集中了 drain.ts 和 enqueue-task-tool.ts 中散落的守卫逻辑：
 * - 权限检查（ExecutionContext.permissions.canEnqueue）
 * - 深度检查（depth < maxDepth）
 * - Round 状态检查（round.hasOverthrow → 拒绝）
 */
export interface CreateDecision {
  /** 是否允许创建 */
  allowed: boolean;
  /** 拒绝原因（allowed=false 时必填） */
  reason?: string;
  /** 拒绝类型（用于调用方分类处理） */
  denyType?: "permission" | "depth" | "round_overthrown" | "round_completed" | "tree_terminated";
}

/**
 * 任务启动决策 — onTaskStarting() 的返回值
 *
 * 替代 followup-runner 中手动构建 ExecutionContext 和启动文件追踪的散装逻辑。
 */
export interface StartDecision {
  /** 是否允许启动 */
  allowed: boolean;
  /** 拒绝原因 */
  reason?: string;
  /** 构建好的执行上下文（allowed=true 时必填） */
  executionContext?: ExecutionContext;
  /** 是否应该先自动分解（而非直接执行） */
  shouldDecompose?: boolean;
}

/**
 * 任务失败决策 — onTaskFailed() 的返回值
 *
 * 集中了 followup-runner 中的重试逻辑和 drain.ts 中的级联丢弃逻辑。
 */
export interface FailureDecision {
  /** 决策类型 */
  action: "retry" | "cascade_fail" | "stop";
  /** 决策原因 */
  reason: string;
  /** 是否需要重新入队（retry 时为 true） */
  needsRequeue: boolean;
  /** 是否需要级联跳过同 Round 的 pending 任务 */
  cascadeSkip: boolean;
}

/**
 * 轮次完成结果 — onRoundCompleted() 的返回值
 *
 * 集中了 followup-runner 中轮次完成后的合并+交付+归档逻辑。
 */
export interface RoundCompletedResult {
  /** 合并后的文件路径（如果有） */
  mergedFilePath?: string;
  /** 交付报告 Markdown */
  deliveryReportMarkdown?: string;
  /** 是否已经完成过交付（幂等短路） */
  alreadyDelivered?: boolean;
  /** 归档是否成功 */
  archiveSuccess: boolean;
  /** Round 最终状态 */
  roundStatus: RoundStatus;
}

// ========================================
// 🆕 方案 A：任务树驱动的 drain 调度结果
// ========================================

/**
 * drain 调度决策 — getNextExecutableTasksForDrain() 的返回值
 *
 * drain 根据 action 字段决定行为：
 * - execute: 执行 tasks 中的任务（可并行）
 * - wait: 有 pending 任务但都在等待依赖/兄弟，暂不执行
 * - round_done: 当前轮次已完成，清理队列中该轮次的残留
 * - discard_all: 任务树已终结，丢弃所有队列任务
 * - discard_round: 当前轮次被 overthrow，级联丢弃
 */
export type DrainScheduleResult =
  | { action: "execute"; tasks: SubTask[]; remainingPending: number; treeModified?: boolean }
  | { action: "wait"; reason: string; treeModified?: boolean }
  | { action: "round_done"; reason: string; roundId?: string }
  | { action: "discard_all"; reason: string }
  | { action: "discard_round"; reason: string; roundId: string; treeModified?: boolean };

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
