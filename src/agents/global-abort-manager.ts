/**
 * 全局任务中断管理器
 * 
 * 🚨 Bug #3 修复: 统一管理所有层级的 AbortController
 * 解决聊天室、任务分解、子任务三层 AbortController 互不连通的问题
 * 
 * @module agents/global-abort-manager
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("global-abort-manager");

/**
 * 全局任务中断管理器
 * 
 * 统一管理所有任务的 AbortController，让 /stop 命令能穿透所有层级：
 * - 聊天室会话
 * - 任务分解系统
 * - 子任务执行
 */
class GlobalTaskAbortManager {
  private taskControllers = new Map<string, AbortController>();
  private sessionControllers = new Map<string, AbortController>();

  /**
   * 注册任务级 AbortController
   * @param taskId 任务 ID（可以是 runId、subTaskId、sessionId 等）
   * @param controller AbortController 实例
   */
  registerTask(taskId: string, controller: AbortController): void {
    this.taskControllers.set(taskId, controller);
    log.debug(`注册任务中断控制器: taskId=${taskId}`);
  }

  /**
   * 注册会话级 AbortController（聊天室等）
   * @param sessionKey 会话标识
   * @param controller AbortController 实例
   */
  registerSession(sessionKey: string, controller: AbortController): void {
    this.sessionControllers.set(sessionKey, controller);
    log.debug(`注册会话中断控制器: sessionKey=${sessionKey}`);
  }

  /**
   * 中断指定任务
   * @param taskId 任务 ID
   * @param reason 中断原因
   * @returns 是否成功中断
   */
  abortTask(taskId: string, reason?: string): boolean {
    const controller = this.taskControllers.get(taskId);
    if (!controller) {
      log.debug(`任务中断失败，未找到控制器: taskId=${taskId}`);
      return false;
    }

    if (controller.signal.aborted) {
      log.debug(`任务已中断，跳过: taskId=${taskId}`);
      return true;
    }

    log.info(`🛑 中断任务: taskId=${taskId}, reason=${reason || "unknown"}`);
    controller.abort(reason);
    return true;
  }

  /**
   * 中断指定会话的所有任务
   * @param sessionKey 会话标识
   * @param reason 中断原因
   * @returns 是否成功中断
   */
  abortSession(sessionKey: string, reason?: string): boolean {
    const controller = this.sessionControllers.get(sessionKey);
    if (!controller) {
      log.debug(`会话中断失败，未找到控制器: sessionKey=${sessionKey}`);
      return false;
    }

    if (controller.signal.aborted) {
      log.debug(`会话已中断，跳过: sessionKey=${sessionKey}`);
      return true;
    }

    log.info(`🛑 中断会话: sessionKey=${sessionKey}, reason=${reason || "unknown"}`);
    controller.abort(reason);
    return true;
  }

  /**
   * 中断所有任务和会话（/stop 命令使用）
   * @param reason 中断原因
   * @returns 中断的任务和会话数量
   */
  abortAll(reason?: string): { tasks: number; sessions: number } {
    let taskCount = 0;
    let sessionCount = 0;

    // 中断所有任务
    for (const [taskId, controller] of this.taskControllers) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
        taskCount++;
      }
    }

    // 中断所有会话
    for (const [sessionKey, controller] of this.sessionControllers) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
        sessionCount++;
      }
    }

    log.info(`🛑 全局中断: ${taskCount} 个任务, ${sessionCount} 个会话, reason=${reason || "stop command"}`);
    
    // 清理已中断的控制器
    this.cleanup();
    
    return { tasks: taskCount, sessions: sessionCount };
  }

  /**
   * 清理已完成的控制器（防止内存泄漏）
   */
  cleanup(): void {
    // 清理已中断的任务控制器
    for (const [taskId, controller] of this.taskControllers) {
      if (controller.signal.aborted) {
        this.taskControllers.delete(taskId);
      }
    }

    // 清理已中断的会话控制器
    for (const [sessionKey, controller] of this.sessionControllers) {
      if (controller.signal.aborted) {
        this.sessionControllers.delete(sessionKey);
      }
    }

    const remainingTasks = this.taskControllers.size;
    const remainingSessions = this.sessionControllers.size;
    if (remainingTasks > 0 || remainingSessions > 0) {
      log.debug(`清理后剩余: ${remainingTasks} 个任务, ${remainingSessions} 个会话`);
    }
  }

  /**
   * 获取当前状态（用于调试）
   */
  getStatus(): { activeTasks: number; activeSessions: number } {
    const activeTasks = Array.from(this.taskControllers.values()).filter(c => !c.signal.aborted).length;
    const activeSessions = Array.from(this.sessionControllers.values()).filter(c => !c.signal.aborted).length;
    
    return { activeTasks, activeSessions };
  }

  /**
   * 注销任务控制器（任务完成时调用）
   * @param taskId 任务 ID
   */
  unregisterTask(taskId: string): void {
    this.taskControllers.delete(taskId);
    log.debug(`注销任务中断控制器: taskId=${taskId}`);
  }

  /**
   * 注销会话控制器（会话结束时调用）
   * @param sessionKey 会话标识
   */
  unregisterSession(sessionKey: string): void {
    this.sessionControllers.delete(sessionKey);
    log.debug(`注销会话中断控制器: sessionKey=${sessionKey}`);
  }
}

// 导出单例实例
export const globalAbortManager = new GlobalTaskAbortManager();

// 定期清理（每 5 分钟）
setInterval(() => {
  globalAbortManager.cleanup();
}, 5 * 60 * 1000);
