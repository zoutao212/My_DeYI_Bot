/**
 * 任务看板数据模型
 * 
 * 本文件定义了任务分解、展示和总结机制的核心数据结构。
 */

/**
 * 子任务状态
 */
export type SubTaskStatus = "pending" | "active" | "completed" | "blocked" | "skipped";

/**
 * 主任务状态
 */
export type MainTaskStatus = "active" | "paused" | "completed" | "blocked";

/**
 * 主任务
 */
export interface MainTask {
  /** 任务标题 */
  title: string;
  /** 任务目标 */
  objective: string;
  /** 任务状态 */
  status: MainTaskStatus;
  /** 进度描述（例如："30%" 或 "已完成需求澄清"） */
  progress: string;
}

/**
 * 子任务
 */
export interface SubTask {
  /** 子任务 ID（例如："T1", "T2"） */
  id: string;
  /** 子任务标题 */
  title: string;
  /** 子任务描述 */
  description: string;
  /** 子任务状态 */
  status: SubTaskStatus;
  /** 进度描述 */
  progress: string;
  /** 依赖的子任务 ID 列表 */
  dependencies: string[];
  /** 产出列表（文件路径、函数名等） */
  outputs: string[];
  /** 结论级要点 */
  notes: string;
}

/**
 * 当前焦点
 */
export interface CurrentFocus {
  /** 当前焦点的子任务 ID */
  taskId: string;
  /** 结论级摘要（不是推理链） */
  reasoningSummary: string;
  /** 可执行的下一步行动 */
  nextAction: string;
}

/**
 * 检查点
 */
export interface Checkpoint {
  /** 时间戳（ISO 8601 格式） */
  timestamp: string;
  /** 本阶段结论摘要 */
  summary: string;
  /** 已确认的关键决策 */
  decisions: string[];
  /** 未决问题 */
  openQuestions: string[];
}

/**
 * 风险或阻塞
 */
export interface Risk {
  /** 风险描述 */
  description: string;
  /** 缓解措施 */
  mitigation: string;
}

/**
 * 上下文锚点
 */
export interface ContextAnchors {
  /** 代码位置列表（例如："src/agents/pi-tools.ts::readFile"） */
  codeLocations: string[];
  /** 命令列表（例如："pnpm build"） */
  commands: string[];
}

/**
 * 任务看板
 */
export interface TaskBoard {
  /** 会话 ID */
  sessionId: string;
  /** 主任务 */
  mainTask: MainTask;
  /** 子任务列表 */
  subTasks: SubTask[];
  /** 当前焦点 */
  currentFocus: CurrentFocus;
  /** 检查点列表 */
  checkpoints: Checkpoint[];
  /** 风险和阻塞列表 */
  risksAndBlocks: Risk[];
  /** 上下文锚点 */
  contextAnchors: ContextAnchors;
  /** 最后更新时间（ISO 8601 格式） */
  lastUpdated: string;
  /** 版本号 */
  version: string;
}

/**
 * 任务分解上下文
 */
export interface DecompositionContext {
  /** 代码库路径 */
  codebase: string;
  /** 最近的对话历史 */
  recentMessages: Array<{ role: string; content: string }>;
  /** 项目记忆（可选） */
  projectMemory?: unknown;
}

/**
 * 执行上下文
 */
export interface ExecutionContext {
  /** 会话 ID */
  sessionId: string;
  /** 任务看板 */
  taskBoard: TaskBoard;
  /** Agent 工具集（可选） */
  tools?: unknown;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  /** 子任务 ID */
  subTaskId: string;
  /** 执行状态 */
  status: "completed" | "failed" | "cancelled";
  /** 产出列表（文件路径、函数名等） */
  outputs: string[];
  /** 错误信息（如果失败） */
  error?: Error;
  /** 执行时长（毫秒） */
  duration: number;
}

/**
 * 失败决策
 */
export interface FailureDecision {
  /** 决策动作 */
  action: "retry" | "skip" | "modify" | "abort";
  /** 修改后的任务（如果 action 是 "modify"） */
  modifiedTask?: SubTask;
}

/**
 * 失败总结
 */
export interface FailureSummary {
  /** 子任务 ID */
  subTaskId: string;
  /** 错误类型 */
  errorType: string;
  /** 根本原因 */
  rootCause: string;
  /** 上下文信息 */
  context: string;
  /** 建议的修复方案 */
  suggestedFix: string;
}
