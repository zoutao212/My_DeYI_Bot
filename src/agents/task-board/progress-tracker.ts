/**
 * 进度跟踪器
 * 
 * 负责跟踪任务和子任务的状态变化，并持久化到磁盘。
 */

import type {
  TaskBoard,
  MainTask,
  SubTask,
  SubTaskStatus,
  Checkpoint,
  Risk,
  CurrentFocus
} from "./types.js";
import { saveTaskBoard, loadTaskBoard } from "./persistence.js";
import { saveTaskBoardWithRendering } from "./renderer.js";

/**
 * 进度跟踪器接口
 */
export interface ProgressTracker {
  /**
   * 初始化任务看板
   * @param mainTask 主任务
   * @param subTasks 子任务列表
   * @returns 初始化的任务看板
   */
  initialize(mainTask: MainTask, subTasks: SubTask[]): Promise<TaskBoard>;

  /**
   * 更新子任务状态
   * @param subTaskId 子任务 ID
   * @param status 新状态
   * @param progress 进度描述
   */
  updateSubTaskStatus(
    subTaskId: string,
    status: SubTaskStatus,
    progress?: string
  ): Promise<void>;

  /**
   * 更新当前焦点
   * @param subTaskId 当前焦点的子任务 ID
   * @param reasoning 推理摘要
   * @param nextAction 下一步行动
   */
  updateCurrentFocus(
    subTaskId: string,
    reasoning: string,
    nextAction: string
  ): Promise<void>;

  /**
   * 创建检查点
   * @param summary 摘要
   * @param decisions 关键决策
   * @param openQuestions 未决问题
   */
  createCheckpoint(
    summary: string,
    decisions: string[],
    openQuestions: string[]
  ): Promise<void>;

  /**
   * 添加风险或阻塞
   * @param description 描述
   * @param mitigation 缓解措施
   */
  addRisk(description: string, mitigation: string): Promise<void>;

  /**
   * 添加上下文锚点
   * @param type 类型（code_location 或 command）
   * @param value 值
   */
  addContextAnchor(type: "code_location" | "command", value: string): Promise<void>;

  /**
   * 获取当前任务看板
   * @returns 任务看板
   */
  getTaskBoard(): Promise<TaskBoard>;

  /**
   * 持久化任务看板到磁盘
   */
  persist(): Promise<void>;

  /**
   * 从磁盘加载任务看板
   * @param sessionId 会话 ID
   * @returns 任务看板
   */
  load(sessionId: string): Promise<TaskBoard | null>;
}

/**
 * 默认进度跟踪器实现
 */
export class DefaultProgressTracker implements ProgressTracker {
  private taskBoard: TaskBoard | null = null;
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * 初始化任务看板
   */
  async initialize(mainTask: MainTask, subTasks: SubTask[]): Promise<TaskBoard> {
    this.taskBoard = {
      sessionId: this.sessionId,
      mainTask,
      subTasks,
      currentFocus: {
        taskId: "",
        reasoningSummary: "",
        nextAction: ""
      },
      checkpoints: [],
      risksAndBlocks: [],
      contextAnchors: {
        codeLocations: [],
        commands: []
      },
      lastUpdated: new Date().toISOString(),
      version: "v1.0.0"
    };

    // 持久化到磁盘
    await this.persist();

    return this.taskBoard;
  }

  /**
   * 更新子任务状态
   */
  async updateSubTaskStatus(
    subTaskId: string,
    status: SubTaskStatus,
    progress?: string
  ): Promise<void> {
    if (!this.taskBoard) {
      throw new Error("TaskBoard not initialized");
    }

    // 查找子任务
    const subTask = this.taskBoard.subTasks.find(t => t.id === subTaskId);
    if (!subTask) {
      throw new Error(`SubTask ${subTaskId} not found`);
    }

    // 更新状态
    subTask.status = status;
    if (progress !== undefined) {
      subTask.progress = progress;
    }

    // 更新最后更新时间
    this.taskBoard.lastUpdated = new Date().toISOString();

    // 持久化到磁盘
    await this.persist();
  }

  /**
   * 更新当前焦点
   */
  async updateCurrentFocus(
    subTaskId: string,
    reasoning: string,
    nextAction: string
  ): Promise<void> {
    if (!this.taskBoard) {
      throw new Error("TaskBoard not initialized");
    }

    // 验证子任务存在
    const subTask = this.taskBoard.subTasks.find(t => t.id === subTaskId);
    if (!subTask) {
      throw new Error(`SubTask ${subTaskId} not found`);
    }

    // 更新当前焦点
    this.taskBoard.currentFocus = {
      taskId: subTaskId,
      reasoningSummary: reasoning,
      nextAction
    };

    // 更新最后更新时间
    this.taskBoard.lastUpdated = new Date().toISOString();

    // 持久化到磁盘
    await this.persist();
  }

  /**
   * 创建检查点
   */
  async createCheckpoint(
    summary: string,
    decisions: string[],
    openQuestions: string[]
  ): Promise<void> {
    if (!this.taskBoard) {
      throw new Error("TaskBoard not initialized");
    }

    // 创建检查点
    const checkpoint: Checkpoint = {
      timestamp: new Date().toISOString(),
      summary,
      decisions,
      openQuestions
    };

    // 添加到检查点列表
    this.taskBoard.checkpoints.push(checkpoint);

    // 更新最后更新时间
    this.taskBoard.lastUpdated = new Date().toISOString();

    // 持久化到磁盘
    await this.persist();
  }

  /**
   * 添加风险或阻塞
   */
  async addRisk(description: string, mitigation: string): Promise<void> {
    if (!this.taskBoard) {
      throw new Error("TaskBoard not initialized");
    }

    // 创建风险
    const risk: Risk = {
      description,
      mitigation
    };

    // 添加到风险列表
    this.taskBoard.risksAndBlocks.push(risk);

    // 更新最后更新时间
    this.taskBoard.lastUpdated = new Date().toISOString();

    // 持久化到磁盘
    await this.persist();
  }

  /**
   * 添加上下文锚点
   */
  async addContextAnchor(type: "code_location" | "command", value: string): Promise<void> {
    if (!this.taskBoard) {
      throw new Error("TaskBoard not initialized");
    }

    // 根据类型添加到对应的列表
    if (type === "code_location") {
      // 检查是否已存在
      if (!this.taskBoard.contextAnchors.codeLocations.includes(value)) {
        this.taskBoard.contextAnchors.codeLocations.unshift(value);
        
        // 限制最多 10 个
        if (this.taskBoard.contextAnchors.codeLocations.length > 10) {
          this.taskBoard.contextAnchors.codeLocations = 
            this.taskBoard.contextAnchors.codeLocations.slice(0, 10);
        }
      }
    } else if (type === "command") {
      // 检查是否已存在
      if (!this.taskBoard.contextAnchors.commands.includes(value)) {
        this.taskBoard.contextAnchors.commands.unshift(value);
        
        // 限制最多 10 个
        if (this.taskBoard.contextAnchors.commands.length > 10) {
          this.taskBoard.contextAnchors.commands = 
            this.taskBoard.contextAnchors.commands.slice(0, 10);
        }
      }
    }

    // 更新最后更新时间
    this.taskBoard.lastUpdated = new Date().toISOString();

    // 持久化到磁盘
    await this.persist();
  }

  /**
   * 获取当前任务看板
   */
  async getTaskBoard(): Promise<TaskBoard> {
    if (!this.taskBoard) {
      throw new Error("TaskBoard not initialized");
    }

    return this.taskBoard;
  }

  /**
   * 持久化任务看板到磁盘
   */
  async persist(): Promise<void> {
    if (!this.taskBoard) {
      throw new Error("TaskBoard not initialized");
    }

    // 使用渲染器保存（同时保存 JSON 和 Markdown）
    await saveTaskBoardWithRendering(this.taskBoard, this.sessionId);
  }

  /**
   * 从磁盘加载任务看板
   */
  async load(sessionId: string): Promise<TaskBoard | null> {
    const board = await loadTaskBoard(sessionId);
    if (board) {
      this.taskBoard = board;
      this.sessionId = sessionId;
    }
    return board;
  }
}

/**
 * 创建默认的进度跟踪器实例
 * @param sessionId 会话 ID
 * @returns 进度跟踪器实例
 */
export function createProgressTracker(sessionId: string): ProgressTracker {
  return new DefaultProgressTracker(sessionId);
}
