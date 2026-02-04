/**
 * 任务树管理器
 * 
 * 负责任务树的持久化、加载、更新和检查点管理
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { TaskTree, SubTask, Checkpoint } from "./types.js";

/**
 * 任务树管理器
 */
export class TaskTreeManager {
  /**
   * 获取任务树目录路径
   */
  private getTaskTreeDir(sessionId: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
    return path.join(homeDir, ".clawdbot", "tasks", sessionId);
  }

  /**
   * 获取任务树文件路径
   */
  private getTaskTreePath(sessionId: string): string {
    return path.join(this.getTaskTreeDir(sessionId), "TASK_TREE.json");
  }

  /**
   * 获取任务树备份文件路径
   */
  private getTaskTreeBackupPath(sessionId: string): string {
    return path.join(this.getTaskTreeDir(sessionId), "TASK_TREE.json.bak");
  }

  /**
   * 获取任务树 Markdown 文件路径
   */
  private getTaskTreeMarkdownPath(sessionId: string): string {
    return path.join(this.getTaskTreeDir(sessionId), "TASK_TREE.md");
  }

  /**
   * 获取检查点目录路径
   */
  private getCheckpointDir(sessionId: string): string {
    return path.join(this.getTaskTreeDir(sessionId), "checkpoints");
  }

  /**
   * 获取检查点文件路径
   */
  private getCheckpointPath(sessionId: string, checkpointId: string): string {
    return path.join(this.getCheckpointDir(sessionId), `${checkpointId}.json`);
  }

  /**
   * 初始化任务树
   */
  async initialize(rootTask: string, sessionId: string): Promise<TaskTree> {
    const taskTree: TaskTree = {
      id: sessionId,
      rootTask,
      subTasks: [],
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      checkpoints: [],
    };

    // 创建目录
    const dir = this.getTaskTreeDir(sessionId);
    await fs.mkdir(dir, { recursive: true });

    // 创建检查点目录
    const checkpointDir = this.getCheckpointDir(sessionId);
    await fs.mkdir(checkpointDir, { recursive: true });

    // 保存任务树
    await this.save(taskTree);

    return taskTree;
  }

  /**
   * 保存任务树到磁盘（原子写入）
   */
  async save(taskTree: TaskTree): Promise<void> {
    const taskTreePath = this.getTaskTreePath(taskTree.id);
    const backupPath = this.getTaskTreeBackupPath(taskTree.id);
    const markdownPath = this.getTaskTreeMarkdownPath(taskTree.id);
    const tmpPath = `${taskTreePath}.tmp`;

    // 更新时间戳
    taskTree.updatedAt = Date.now();

    // 备份现有文件
    try {
      await fs.access(taskTreePath);
      await fs.copyFile(taskTreePath, backupPath);
    } catch {
      // 文件不存在，跳过备份
    }

    // 原子写入：先写入临时文件
    await fs.writeFile(tmpPath, JSON.stringify(taskTree, null, 2), "utf-8");

    // 重命名为目标文件
    await fs.rename(tmpPath, taskTreePath);

    // 同时保存 Markdown 格式
    const markdown = this.renderToMarkdown(taskTree);
    await fs.writeFile(markdownPath, markdown, "utf-8");

    console.log(`[TaskTreeManager] ✅ Task tree saved: ${taskTreePath}`);
  }

  /**
   * 从磁盘加载任务树
   */
  async load(sessionId: string): Promise<TaskTree | null> {
    const taskTreePath = this.getTaskTreePath(sessionId);
    const backupPath = this.getTaskTreeBackupPath(sessionId);

    try {
      // 尝试加载主文件
      const content = await fs.readFile(taskTreePath, "utf-8");
      const taskTree = JSON.parse(content) as TaskTree;
      console.log(`[TaskTreeManager] ✅ Task tree loaded: ${taskTreePath}`);
      return taskTree;
    } catch (err) {
      console.warn(`[TaskTreeManager] ⚠️ Failed to load task tree: ${err}`);

      // 尝试从备份文件恢复
      try {
        const content = await fs.readFile(backupPath, "utf-8");
        const taskTree = JSON.parse(content) as TaskTree;
        console.log(`[TaskTreeManager] ✅ Task tree restored from backup: ${backupPath}`);
        return taskTree;
      } catch {
        console.error(`[TaskTreeManager] ❌ Failed to restore from backup`);
        return null;
      }
    }
  }

  /**
   * 更新子任务状态
   */
  async updateSubTaskStatus(
    taskTree: TaskTree,
    subTaskId: string,
    status: SubTask["status"],
  ): Promise<void> {
    const subTask = taskTree.subTasks.find((t) => t.id === subTaskId);
    if (!subTask) {
      throw new Error(`SubTask not found: ${subTaskId}`);
    }

    subTask.status = status;
    if (status === "completed") {
      subTask.completedAt = Date.now();
    }

    // 更新任务树状态
    const allCompleted = taskTree.subTasks.every((t) => t.status === "completed");
    const anyFailed = taskTree.subTasks.some((t) => t.status === "failed");
    const anyActive = taskTree.subTasks.some((t) => t.status === "active");

    if (allCompleted) {
      taskTree.status = "completed";
    } else if (anyFailed) {
      taskTree.status = "failed";
    } else if (anyActive) {
      taskTree.status = "active";
    }

    await this.save(taskTree);
  }

  /**
   * 创建检查点
   */
  async createCheckpoint(taskTree: TaskTree): Promise<string> {
    const checkpointId = crypto.randomUUID();
    const checkpoint: Checkpoint = {
      id: checkpointId,
      taskTree: JSON.parse(JSON.stringify(taskTree)), // 深拷贝
      createdAt: Date.now(),
    };

    const checkpointPath = this.getCheckpointPath(taskTree.id, checkpointId);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");

    // 添加到检查点列表
    taskTree.checkpoints.push(checkpointId);

    // 清理旧检查点（最多保留 10 个）
    if (taskTree.checkpoints.length > 10) {
      const oldestCheckpointId = taskTree.checkpoints.shift()!;
      const oldestCheckpointPath = this.getCheckpointPath(taskTree.id, oldestCheckpointId);
      try {
        await fs.unlink(oldestCheckpointPath);
      } catch {
        // 忽略删除失败
      }
    }

    await this.save(taskTree);

    console.log(`[TaskTreeManager] ✅ Checkpoint created: ${checkpointId}`);
    return checkpointId;
  }

  /**
   * 从检查点恢复
   */
  async restoreFromCheckpoint(taskTree: TaskTree, checkpointId: string): Promise<TaskTree> {
    const checkpointPath = this.getCheckpointPath(taskTree.id, checkpointId);

    try {
      const content = await fs.readFile(checkpointPath, "utf-8");
      const checkpoint = JSON.parse(content) as Checkpoint;
      console.log(`[TaskTreeManager] ✅ Restored from checkpoint: ${checkpointId}`);
      return checkpoint.taskTree;
    } catch (err) {
      throw new Error(`Failed to restore from checkpoint ${checkpointId}: ${err}`);
    }
  }

  /**
   * 渲染任务树为 Markdown
   */
  renderToMarkdown(taskTree: TaskTree): string {
    const lines: string[] = [];

    lines.push(`# Task Tree: ${taskTree.rootTask}`);
    lines.push("");
    lines.push(`**Status**: ${taskTree.status}`);
    lines.push(`**Created**: ${new Date(taskTree.createdAt).toISOString()}`);
    lines.push(`**Updated**: ${new Date(taskTree.updatedAt).toISOString()}`);
    lines.push("");

    lines.push("## Sub Tasks");
    lines.push("");

    for (const subTask of taskTree.subTasks) {
      const statusIcon = this.getStatusIcon(subTask.status);
      lines.push(`### ${statusIcon} ${subTask.summary}`);
      lines.push("");
      lines.push(`**ID**: ${subTask.id}`);
      lines.push(`**Status**: ${subTask.status}`);
      lines.push(`**Retry Count**: ${subTask.retryCount}`);
      lines.push(`**Created**: ${new Date(subTask.createdAt).toISOString()}`);
      if (subTask.completedAt) {
        lines.push(`**Completed**: ${new Date(subTask.completedAt).toISOString()}`);
      }
      lines.push("");
      lines.push("**Prompt**:");
      lines.push("```");
      lines.push(subTask.prompt);
      lines.push("```");
      lines.push("");

      if (subTask.output) {
        lines.push("**Output**:");
        lines.push("```");
        lines.push(subTask.output);
        lines.push("```");
        lines.push("");
      }

      if (subTask.error) {
        lines.push("**Error**:");
        lines.push("```");
        lines.push(subTask.error);
        lines.push("```");
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * 获取状态图标
   */
  private getStatusIcon(status: SubTask["status"]): string {
    switch (status) {
      case "pending":
        return "⏳";
      case "active":
        return "🔄";
      case "completed":
        return "✅";
      case "failed":
        return "❌";
      case "interrupted":
        return "⚠️";
      default:
        return "❓";
    }
  }
}
