/**
 * 任务看板管理器
 * 
 * 负责任务看板的加载、更新、持久化和展示。
 */

import type { TaskBoard } from "./types.js";
import { loadTaskBoard, saveTaskBoard } from "./persistence.js";
import { saveTaskBoardWithRendering } from "./renderer.js";
import { renderTaskBoardCompact, renderTaskBoardForUser, hasTaskBoardUpdates } from "./compact-renderer.js";

/**
 * 任务看板管理器
 */
export class TaskBoardManager {
  private sessionId: string;
  private currentBoard: TaskBoard | null = null;
  private lastRenderedBoard: TaskBoard | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * 加载任务看板
   */
  async load(): Promise<TaskBoard | null> {
    try {
      this.currentBoard = await loadTaskBoard(this.sessionId);
      return this.currentBoard;
    } catch {
      return null;
    }
  }

  /**
   * 更新任务看板
   */
  async update(board: TaskBoard): Promise<void> {
    this.currentBoard = board;
    
    // 保存到磁盘
    await saveTaskBoard(board, this.sessionId);
    
    // 渲染为 JSON 和 Markdown
    await saveTaskBoardWithRendering(board, this.sessionId);
  }

  /**
   * 获取当前任务看板
   */
  getCurrent(): TaskBoard | null {
    return this.currentBoard;
  }

  /**
   * 渲染任务看板为紧凑格式（用于 System Prompt）
   */
  renderForSystemPrompt(): string | undefined {
    if (!this.currentBoard) return undefined;
    return renderTaskBoardCompact(this.currentBoard);
  }

  /**
   * 渲染任务看板为用户可见格式（用于消息回复）
   * 
   * @param forceRender 是否强制渲染（即使没有更新）
   * @returns 用户友好的 Markdown 字符串，如果没有更新则返回 undefined
   */
  renderForUser(forceRender: boolean = false): string | undefined {
    if (!this.currentBoard) return undefined;
    
    // 检查是否有更新
    if (!forceRender && !hasTaskBoardUpdates(this.lastRenderedBoard, this.currentBoard)) {
      return undefined;
    }
    
    // 更新最后渲染的看板
    this.lastRenderedBoard = JSON.parse(JSON.stringify(this.currentBoard));
    
    return renderTaskBoardForUser(this.currentBoard);
  }

  /**
   * 检查是否有活跃的任务看板
   */
  hasActiveBoard(): boolean {
    return this.currentBoard !== null && this.currentBoard.subTasks.length > 0;
  }

  /**
   * 清除任务看板
   */
  clear(): void {
    this.currentBoard = null;
    this.lastRenderedBoard = null;
  }
}
