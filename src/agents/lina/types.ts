/**
 * 栗娜日常事务管理系统 - 核心类型定义
 * 
 * 本文件定义了栗娜系统的所有核心数据模型和接口。
 */

// ============================================================================
// 数据模型类型
// ============================================================================

/**
 * 日常任务
 * 
 * 表示用户的待办事项、日程安排等。
 */
export interface DailyTask {
  /** 任务 ID */
  id: string;
  
  /** 任务标题 */
  title: string;
  
  /** 任务描述（可选） */
  description?: string;
  
  /** 优先级 */
  priority: 'low' | 'medium' | 'high' | 'urgent';
  
  /** 状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  
  /** 截止日期（可选） */
  dueDate?: Date;
  
  /** 标签 */
  tags: string[];
  
  /** 创建时间 */
  createdAt: Date;
  
  /** 更新时间 */
  updatedAt: Date;
  
  /** 完成时间（可选） */
  completedAt?: Date;
}

/**
 * 记忆
 * 
 * 表示用户的对话历史、经验总结、重要信息等。
 */
export interface Memory {
  /** 记忆 ID */
  id: string;
  
  /** 记忆内容 */
  content: string;
  
  /** 类型 */
  type: 'conversation' | 'summary' | 'important';
  
  /** 标签 */
  tags: string[];
  
  /** 重要性（0-10） */
  importance: number;
  
  /** 创建时间 */
  createdAt: Date;
  
  /** 元数据 */
  metadata: Record<string, any>;
}

/**
 * 提醒
 * 
 * 表示用户的提醒事项。
 */
export interface Reminder {
  /** 提醒 ID */
  id: string;
  
  /** 提醒标题 */
  title: string;
  
  /** 提醒消息 */
  message: string;
  
  /** 提醒时间 */
  dueTime: Date;
  
  /** 重复配置（可选） */
  repeat?: RepeatConfig;
  
  /** 提前提醒时间（分钟，可选） */
  advanceTime?: number;
  
  /** 状态 */
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  
  /** 创建时间 */
  createdAt: Date;
  
  /** 暂停到（可选） */
  pausedUntil?: Date;
}

/**
 * 重复配置
 * 
 * 定义提醒的重复规则。
 */
export interface RepeatConfig {
  /** 频率 */
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  
  /** 间隔 */
  interval: number;
  
  /** 结束日期（可选） */
  endDate?: Date;
}

/**
 * 技术任务
 * 
 * 表示委托给 TaskDelegator 的技术操作任务。
 */
export interface TechnicalTask {
  /** 任务 ID */
  id: string;
  
  /** 任务类型 */
  type: string;
  
  /** 任务描述 */
  description: string;
  
  /** 任务参数 */
  parameters: Record<string, any>;
  
  /** 优先级 */
  priority: number;
  
  /** 超时时间（毫秒，可选） */
  timeout?: number;
  
  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  
  /** 任务结果（可选） */
  result?: TaskResult;
  
  /** 错误信息（可选） */
  error?: string;
  
  /** 创建时间 */
  createdAt: Date;
  
  /** 开始时间（可选） */
  startedAt?: Date;
  
  /** 完成时间（可选） */
  completedAt?: Date;
}

/**
 * 任务结果
 * 
 * 表示技术任务的执行结果。
 */
export interface TaskResult {
  /** 是否成功 */
  success: boolean;
  
  /** 结果数据 */
  data?: any;
  
  /** 错误信息（如果失败） */
  error?: string;
  
  /** 执行时间（毫秒） */
  executionTime: number;
}

/**
 * 任务进度
 * 
 * 表示技术任务的执行进度。
 */
export interface TaskProgress {
  /** 任务 ID */
  taskId: string;
  
  /** 完成百分比（0-100） */
  percentage: number;
  
  /** 当前步骤 */
  currentStep: string;
  
  /** 总步骤数 */
  totalSteps: number;
  
  /** 已完成步骤数 */
  completedSteps: number;
  
  /** 预计剩余时间（毫秒，可选） */
  estimatedTimeRemaining?: number;
  
  /** 更新时间 */
  updatedAt: Date;
}

// ============================================================================
// 过滤器和查询类型
// ============================================================================

/**
 * 任务过滤器
 * 
 * 用于过滤任务列表。
 */
export interface TaskFilter {
  /** 状态过滤 */
  status?: DailyTask['status'] | DailyTask['status'][];
  
  /** 优先级过滤 */
  priority?: DailyTask['priority'] | DailyTask['priority'][];
  
  /** 标签过滤 */
  tags?: string[];
  
  /** 日期范围过滤 */
  dateRange?: {
    start: Date;
    end: Date;
  };
  
  /** 搜索关键词 */
  keyword?: string;
}

/**
 * 记忆查询
 * 
 * 用于检索记忆。
 */
export interface MemoryQuery {
  /** 查询文本（用于语义搜索） */
  query?: string;
  
  /** 关键词（用于关键词搜索） */
  keywords?: string[];
  
  /** 类型过滤 */
  type?: Memory['type'] | Memory['type'][];
  
  /** 标签过滤 */
  tags?: string[];
  
  /** 最小重要性 */
  minImportance?: number;
  
  /** 时间范围 */
  timeRange?: {
    start: Date;
    end: Date;
  };
  
  /** 返回数量限制 */
  limit?: number;
}

/**
 * 提醒过滤器
 * 
 * 用于过滤提醒列表。
 */
export interface ReminderFilter {
  /** 状态过滤 */
  status?: Reminder['status'] | Reminder['status'][];
  
  /** 时间范围过滤 */
  timeRange?: {
    start: Date;
    end: Date;
  };
  
  /** 搜索关键词 */
  keyword?: string;
}

/**
 * 任务状态
 * 
 * 表示技术任务的当前状态。
 */
export interface TaskStatus {
  /** 任务 ID */
  taskId: string;
  
  /** 状态 */
  status: TechnicalTask['status'];
  
  /** 进度（可选） */
  progress?: TaskProgress;
  
  /** 错误信息（如果失败） */
  error?: string;
  
  /** 更新时间 */
  updatedAt: Date;
}

// ============================================================================
// 对话相关类型
// ============================================================================

/**
 * 对话
 * 
 * 表示一次完整的对话。
 */
export interface Conversation {
  /** 对话 ID */
  id: string;
  
  /** 消息列表 */
  messages: Message[];
  
  /** 开始时间 */
  startedAt: Date;
  
  /** 结束时间（可选） */
  endedAt?: Date;
  
  /** 元数据 */
  metadata: Record<string, any>;
}

/**
 * 消息
 * 
 * 表示对话中的一条消息。
 */
export interface Message {
  /** 消息 ID */
  id: string;
  
  /** 角色 */
  role: 'user' | 'assistant';
  
  /** 内容 */
  content: string;
  
  /** 时间戳 */
  timestamp: Date;
  
  /** 元数据 */
  metadata?: Record<string, any>;
}

/**
 * 意图
 * 
 * 表示用户的意图。
 */
export interface Intent {
  /** 意图类型 */
  type: string;
  
  /** 置信度（0-1） */
  confidence: number;
  
  /** 提取的实体 */
  entities: Record<string, any>;
  
  /** 原始文本 */
  rawText: string;
}

/**
 * 上下文
 * 
 * 表示对话的上下文信息。
 */
export interface Context {
  /** 对话历史 */
  conversationHistory: Message[];
  
  /** 当前任务列表 */
  currentTasks: DailyTask[];
  
  /** 最近的记忆 */
  recentMemories: Memory[];
  
  /** 活动的提醒 */
  activeReminders: Reminder[];
  
  /** 用户偏好 */
  userPreferences: Record<string, any>;
}

// ============================================================================
// 管理器接口
// ============================================================================

/**
 * 任务管理器接口
 * 
 * 负责管理用户的待办事项、日程安排和提醒事项。
 */
export interface TaskManager {
  /**
   * 创建任务
   * @param task 任务信息
   * @returns 任务 ID
   */
  createTask(task: Omit<DailyTask, 'id' | 'createdAt' | 'updatedAt'>): Promise<string>;
  
  /**
   * 获取任务列表
   * @param filter 过滤条件
   * @returns 任务列表
   */
  getTasks(filter?: TaskFilter): Promise<DailyTask[]>;
  
  /**
   * 更新任务
   * @param taskId 任务 ID
   * @param updates 更新内容
   */
  updateTask(taskId: string, updates: Partial<DailyTask>): Promise<void>;
  
  /**
   * 删除任务
   * @param taskId 任务 ID
   */
  deleteTask(taskId: string): Promise<void>;
  
  /**
   * 完成任务
   * @param taskId 任务 ID
   */
  completeTask(taskId: string): Promise<void>;
  
  /**
   * 获取今天的任务
   * @returns 今天的任务列表
   */
  getTodayTasks(): Promise<DailyTask[]>;
  
  /**
   * 获取本周的任务
   * @returns 本周的任务列表
   */
  getWeekTasks(): Promise<DailyTask[]>;
}

/**
 * 记忆管理器接口
 * 
 * 负责管理用户的对话历史、经验总结和重要信息。
 */
export interface MemoryManager {
  /**
   * 归档对话
   * @param conversation 对话内容
   */
  archiveConversation(conversation: Conversation): Promise<void>;
  
  /**
   * 检索记忆
   * @param query 查询条件
   * @returns 记忆列表
   */
  retrieveMemories(query: MemoryQuery): Promise<Memory[]>;
  
  /**
   * 标记重要记忆
   * @param memoryId 记忆 ID
   */
  markImportant(memoryId: string): Promise<void>;
  
  /**
   * 删除记忆
   * @param memoryId 记忆 ID
   */
  deleteMemory(memoryId: string): Promise<void>;
  
  /**
   * 总结话题
   * @param topic 话题
   * @returns 总结内容
   */
  summarizeTopic(topic: string): Promise<string>;
  
  /**
   * 获取时间段记忆
   * @param start 开始时间
   * @param end 结束时间
   * @returns 记忆列表
   */
  getMemoriesByTimeRange(start: Date, end: Date): Promise<Memory[]>;
}

/**
 * 提醒管理器接口
 * 
 * 负责管理用户的提醒事项，并在指定时间主动提醒用户。
 */
export interface ReminderManager {
  /**
   * 创建提醒
   * @param reminder 提醒信息
   * @returns 提醒 ID
   */
  createReminder(reminder: Omit<Reminder, 'id' | 'createdAt'>): Promise<string>;
  
  /**
   * 获取提醒列表
   * @param filter 过滤条件
   * @returns 提醒列表
   */
  getReminders(filter?: ReminderFilter): Promise<Reminder[]>;
  
  /**
   * 更新提醒
   * @param reminderId 提醒 ID
   * @param updates 更新内容
   */
  updateReminder(reminderId: string, updates: Partial<Reminder>): Promise<void>;
  
  /**
   * 删除提醒
   * @param reminderId 提醒 ID
   */
  deleteReminder(reminderId: string): Promise<void>;
  
  /**
   * 暂停提醒
   * @param reminderId 提醒 ID
   * @param until 暂停到
   */
  pauseReminder(reminderId: string, until: Date): Promise<void>;
  
  /**
   * 恢复提醒
   * @param reminderId 提醒 ID
   */
  resumeReminder(reminderId: string): Promise<void>;
  
  /**
   * 检查到期提醒
   * @returns 到期的提醒列表
   */
  checkDueReminders(): Promise<Reminder[]>;
}

/**
 * 委托管理器接口
 * 
 * 负责将技术操作委托给 TaskDelegator 执行。
 */
export interface DelegationManager {
  /**
   * 委托任务
   * @param task 技术任务
   * @returns 任务 ID
   */
  delegateTask(task: Omit<TechnicalTask, 'id' | 'createdAt' | 'status'>): Promise<string>;
  
  /**
   * 取消任务
   * @param taskId 任务 ID
   */
  cancelTask(taskId: string): Promise<void>;
  
  /**
   * 获取任务状态
   * @param taskId 任务 ID
   * @returns 任务状态
   */
  getTaskStatus(taskId: string): Promise<TaskStatus>;
  
  /**
   * 获取任务结果
   * @param taskId 任务 ID
   * @returns 任务结果
   */
  getTaskResult(taskId: string): Promise<TaskResult>;
  
  /**
   * 获取活动任务列表
   * @returns 活动任务列表
   */
  getActiveTasks(): Promise<TechnicalTask[]>;
  
  /**
   * 获取历史任务列表
   * @param filter 过滤条件
   * @returns 历史任务列表
   */
  getHistoryTasks(filter?: TaskFilter): Promise<TechnicalTask[]>;
}

/**
 * 进度跟踪器接口
 * 
 * 负责跟踪委托任务的进度，并主动告知用户。
 */
export interface ProgressTracker {
  /**
   * 开始跟踪任务
   * @param taskId 任务 ID
   */
  startTracking(taskId: string): Promise<void>;
  
  /**
   * 停止跟踪任务
   * @param taskId 任务 ID
   */
  stopTracking(taskId: string): Promise<void>;
  
  /**
   * 获取任务进度
   * @param taskId 任务 ID
   * @returns 任务进度
   */
  getProgress(taskId: string): Promise<TaskProgress>;
  
  /**
   * 更新任务进度
   * @param taskId 任务 ID
   * @param progress 任务进度
   */
  updateProgress(taskId: string, progress: TaskProgress): Promise<void>;
  
  /**
   * 检查长时间运行的任务
   * @returns 长时间运行的任务 ID 列表
   */
  checkLongRunningTasks(): Promise<string[]>;
  
  /**
   * 通知用户任务完成
   * @param taskId 任务 ID
   * @param result 任务结果
   */
  notifyCompletion(taskId: string, result: TaskResult): Promise<void>;
}

/**
 * 对话管理器接口
 * 
 * 负责管理与用户的对话，理解用户意图并做出响应。
 */
export interface ConversationManager {
  /**
   * 处理用户消息
   * @param message 用户消息
   * @returns 响应消息
   */
  handleMessage(message: string): Promise<string>;
  
  /**
   * 澄清用户意图
   * @param message 用户消息
   * @returns 澄清问题
   */
  clarifyIntent(message: string): Promise<string>;
  
  /**
   * 确认操作
   * @param action 操作描述
   * @returns 是否确认
   */
  confirmAction(action: string): Promise<boolean>;
  
  /**
   * 生成响应
   * @param intent 用户意图
   * @param context 上下文
   * @returns 响应消息
   */
  generateResponse(intent: Intent, context: Context): Promise<string>;
  
  /**
   * 获取对话历史
   * @param limit 返回数量限制
   * @returns 对话历史
   */
  getConversationHistory(limit: number): Promise<Message[]>;
  
  /**
   * 重置对话上下文
   */
  resetContext(): Promise<void>;
}
