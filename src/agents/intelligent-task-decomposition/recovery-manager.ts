/**
 * 恢复管理器
 * 
 * 负责检测未完成的任务、恢复任务树、重新执行中断的任务
 */

import type { TaskTree, SubTask } from "./types.js";
import { TaskTreeManager } from "./task-tree-manager.js";

/**
 * 恢复管理器
 */
export class RecoveryManager {
  private taskTreeManager: TaskTreeManager;

  constructor(taskTreeManager: TaskTreeManager) {
    this.taskTreeManager = taskTreeManager;
  }

  /**
   * 检查是否有未完成的任务
   */
  async hasUnfinishedTasks(sessionId: string): Promise<boolean> {
    const taskTree = await this.taskTreeManager.load(sessionId);
    if (!taskTree) {
      return false;
    }

    // 检查是否有未完成的任务
    const hasUnfinished = taskTree.subTasks.some(
      (t) => t.status === "pending" || t.status === "active" || t.status === "interrupted",
    );

    return hasUnfinished;
  }

  /**
   * 恢复未完成的任务
   */
  async recoverUnfinishedTasks(sessionId: string): Promise<TaskTree> {
    const taskTree = await this.taskTreeManager.load(sessionId);
    if (!taskTree) {
      throw new Error(`Task tree not found: ${sessionId}`);
    }

    // 识别中断的任务
    const interruptedTasks = this.identifyInterruptedTasks(taskTree);

    // 将 "active" 状态的任务标记为 "interrupted"
    for (const task of taskTree.subTasks) {
      if (task.status === "active") {
        task.status = "interrupted";
      }
    }

    // 保存任务树
    await this.taskTreeManager.save(taskTree);

    // 尝试从最近的检查点恢复
    if (taskTree.checkpoints.length > 0) {
      const latestCheckpointId = taskTree.checkpoints[taskTree.checkpoints.length - 1];
      try {
        const restoredTaskTree = await this.taskTreeManager.restoreFromCheckpoint(
          taskTree,
          latestCheckpointId,
        );
        console.log(`[RecoveryManager] ✅ Restored from checkpoint: ${latestCheckpointId}`);
        return restoredTaskTree;
      } catch (err) {
        console.warn(`[RecoveryManager] ⚠️ Failed to restore from checkpoint: ${err}`);
        // 继续使用当前任务树
      }
    }

    console.log(
      `[RecoveryManager] ✅ Recovered task tree with ${interruptedTasks.length} interrupted tasks`,
    );
    return taskTree;
  }

  /**
   * 识别中断的任务
   */
  identifyInterruptedTasks(taskTree: TaskTree): SubTask[] {
    return taskTree.subTasks.filter(
      (t) => t.status === "active" || t.status === "interrupted" || t.status === "pending",
    );
  }

  /**
   * 重新执行中断的任务
   */
  async reexecuteInterruptedTasks(
    taskTree: TaskTree,
    interruptedTasks: SubTask[],
  ): Promise<void> {
    console.log(
      `[RecoveryManager] 🔄 Re-executing ${interruptedTasks.length} interrupted tasks`,
    );

    for (const task of interruptedTasks) {
      // 将 "interrupted" 状态的任务重新标记为 "pending"
      if (task.status === "interrupted") {
        task.status = "pending";
      }

      console.log(`[RecoveryManager] 🔄 Re-executing task: ${task.id} (${task.summary})`);
    }

    // 保存任务树
    await this.taskTreeManager.save(taskTree);
  }
}
