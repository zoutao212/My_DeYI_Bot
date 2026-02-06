/**
 * 任务树管理器
 * 
 * 负责任务树的持久化、加载、更新和检查点管理
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { TaskTree, SubTask, Checkpoint, ValidationResult } from "./types.js";

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

    // 🆕 将根任务转换为特殊的 SubTask（用于汇总）
    const rootSubTask: SubTask = {
      id: `root-${sessionId}`,
      prompt: rootTask,
      summary: `【总任务】${rootTask.substring(0, 50)}...`,
      status: "pending",
      retryCount: 0,
      createdAt: Date.now(),
      parentId: null,
      children: [],
      waitForChildren: true,  // ✅ 等待所有子任务完成
      depth: 0,
      metadata: {
        isRootTask: true,  // ✅ 标记为根任务
        isSummaryTask: true,  // ✅ 标记为汇总任务
      },
    };

    // 🆕 将根任务添加到 subTasks 数组的开头
    taskTree.subTasks.unshift(rootSubTask);

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
   * 添加子任务到指定父任务
   * 
   * @param taskTree 任务树
   * @param parentId 父任务 ID（null 表示根级任务）
   * @param subTask 要添加的子任务
   * 
   * 功能：
   * - 自动设置子任务的 depth、parentId 字段
   * - 更新父任务的 children 数组
   * - 保持任务树的一致性
   * 
   * 验证：需求 5.4
   */
  async addSubTask(
    taskTree: TaskTree,
    parentId: string | null,
    subTask: SubTask,
  ): Promise<void> {
    // 如果是根级任务（parentId 为 null）
    if (parentId === null) {
      // 设置深度为 0
      subTask.depth = 0;
      subTask.parentId = null;
      
      // 初始化 children 数组（如果不存在）
      if (!subTask.children) {
        subTask.children = [];
      }
      
      // 添加到任务树的 subTasks 列表
      taskTree.subTasks.push(subTask);
    } else {
      // 查找父任务
      const parentTask = this.findSubTask(taskTree, parentId);
      if (!parentTask) {
        throw new Error(`Parent task not found: ${parentId}`);
      }
      
      // 设置子任务的 parentId 和 depth
      subTask.parentId = parentId;
      subTask.depth = (parentTask.depth ?? 0) + 1;
      
      // 初始化 children 数组（如果不存在）
      if (!subTask.children) {
        subTask.children = [];
      }
      
      // 初始化父任务的 children 数组（如果不存在）
      if (!parentTask.children) {
        parentTask.children = [];
      }
      
      // 添加到父任务的 children 列表
      parentTask.children.push(subTask);
      
      // 同时添加到任务树的 subTasks 列表（保持扁平化结构，便于查找）
      taskTree.subTasks.push(subTask);
    }
    
    // 保存任务树
    await this.save(taskTree);
    
    console.log(`[TaskTreeManager] ✅ SubTask added: ${subTask.id} (parent: ${parentId ?? "root"})`);
  }

  /**
   * 删除子任务及其所有子孙任务（级联删除）
   * 
   * @param taskTree 任务树
   * @param subTaskId 要删除的子任务 ID
   * 
   * 功能：
   * - 递归删除子任务及其所有子孙任务
   * - 更新父任务的 children 数组
   * - 清理所有对已删除任务的引用（dependencies）
   * - 保持任务树的一致性
   * 
   * 验证：需求 5.4
   */
  async removeSubTask(
    taskTree: TaskTree,
    subTaskId: string,
  ): Promise<void> {
    // 查找要删除的子任务
    const subTask = this.findSubTask(taskTree, subTaskId);
    if (!subTask) {
      throw new Error(`SubTask not found: ${subTaskId}`);
    }
    
    // 递归获取所有要删除的任务 ID（包括子孙任务）
    const idsToDelete = this.getDescendantIds(subTask);
    idsToDelete.push(subTaskId); // 包含自己
    
    // 从父任务的 children 数组中移除
    if (subTask.parentId !== null && subTask.parentId !== undefined) {
      const parentTask = this.findSubTask(taskTree, subTask.parentId);
      if (parentTask && parentTask.children) {
        parentTask.children = parentTask.children.filter((child) => child.id !== subTaskId);
      }
    }
    
    // 从任务树的 subTasks 扁平化列表中移除所有相关任务
    taskTree.subTasks = taskTree.subTasks.filter((t) => !idsToDelete.includes(t.id));
    
    // 清理所有对已删除任务的引用（dependencies）
    for (const task of taskTree.subTasks) {
      if (task.dependencies && task.dependencies.length > 0) {
        task.dependencies = task.dependencies.filter((depId) => !idsToDelete.includes(depId));
      }
    }
    
    // 保存任务树
    await this.save(taskTree);
    
    console.log(`[TaskTreeManager] ✅ SubTask removed: ${subTaskId} (including ${idsToDelete.length - 1} descendants)`);
  }

  /**
   * 递归获取子任务的所有子孙任务 ID
   * 
   * @param subTask 子任务
   * @returns 所有子孙任务的 ID 列表
   */
  private getDescendantIds(subTask: SubTask): string[] {
    const ids: string[] = [];
    
    if (subTask.children && subTask.children.length > 0) {
      for (const child of subTask.children) {
        ids.push(child.id);
        // 递归获取子孙任务
        ids.push(...this.getDescendantIds(child));
      }
    }
    
    return ids;
  }

  /**
   * 修改子任务
   * 
   * @param taskTree 任务树
   * @param subTaskId 要修改的子任务 ID
   * @param updates 要更新的字段（部分更新）
   * 
   * 功能：
   * - 支持修改子任务的任意字段（除了 id）
   * - 验证修改的合法性
   * - 自动更新 updatedAt 时间戳
   * - 保持任务树的一致性
   * 
   * 验证：需求 5.2
   */
  async modifySubTask(
    taskTree: TaskTree,
    subTaskId: string,
    updates: Partial<SubTask>,
  ): Promise<void> {
    // 查找要修改的子任务
    const subTask = this.findSubTask(taskTree, subTaskId);
    if (!subTask) {
      throw new Error(`SubTask not found: ${subTaskId}`);
    }
    
    // 验证修改的合法性
    if (updates.id !== undefined && updates.id !== subTaskId) {
      throw new Error(`Cannot modify task id: ${subTaskId}`);
    }
    
    // 如果修改了 parentId，需要验证新的父任务是否存在
    if (updates.parentId !== undefined && updates.parentId !== null) {
      const newParent = this.findSubTask(taskTree, updates.parentId);
      if (!newParent) {
        throw new Error(`New parent task not found: ${updates.parentId}`);
      }
      
      // 检查是否会导致循环依赖（新父任务不能是当前任务的子孙任务）
      const descendants = this.getDescendantIds(subTask);
      if (descendants.includes(updates.parentId)) {
        throw new Error(`Cannot set parent to a descendant task: ${updates.parentId}`);
      }
    }
    
    // 如果修改了 dependencies，需要验证依赖的任务是否存在
    if (updates.dependencies !== undefined && updates.dependencies.length > 0) {
      for (const depId of updates.dependencies) {
        const depTask = this.findSubTask(taskTree, depId);
        if (!depTask) {
          throw new Error(`Dependency task not found: ${depId}`);
        }
        
        // 检查是否会导致循环依赖（依赖的任务不能是当前任务的子孙任务）
        const descendants = this.getDescendantIds(subTask);
        if (descendants.includes(depId)) {
          throw new Error(`Cannot depend on a descendant task: ${depId}`);
        }
      }
    }
    
    // 应用更新（浅拷贝，保留未修改的字段）
    Object.assign(subTask, updates);
    
    // 如果修改了 status 为 completed，自动设置 completedAt
    if (updates.status === "completed" && !subTask.completedAt) {
      subTask.completedAt = Date.now();
    }
    
    // 保存任务树
    await this.save(taskTree);
    
    console.log(`[TaskTreeManager] ✅ SubTask modified: ${subTaskId}`);
  }

  /**
   * 移动子任务到新的父任务
   * 
   * @param taskTree 任务树
   * @param subTaskId 要移动的子任务 ID
   * @param newParentId 新的父任务 ID（null 表示移动到根级）
   * 
   * 功能：
   * - 更新旧父任务的 children 数组（移除子任务）
   * - 更新新父任务的 children 数组（添加子任务）
   * - 重新计算子任务及其子孙任务的 depth
   * - 保持任务树的一致性
   * 
   * 验证：需求 5.4
   */
  async moveSubTask(
    taskTree: TaskTree,
    subTaskId: string,
    newParentId: string | null,
  ): Promise<void> {
    // 查找要移动的子任务
    const subTask = this.findSubTask(taskTree, subTaskId);
    if (!subTask) {
      throw new Error(`SubTask not found: ${subTaskId}`);
    }
    
    // 如果新父任务 ID 与当前父任务 ID 相同，无需移动
    if (subTask.parentId === newParentId) {
      console.log(`[TaskTreeManager] ℹ️ SubTask already under parent: ${subTaskId}`);
      return;
    }
    
    // 如果新父任务不为 null，验证新父任务是否存在
    if (newParentId !== null) {
      const newParent = this.findSubTask(taskTree, newParentId);
      if (!newParent) {
        throw new Error(`New parent task not found: ${newParentId}`);
      }
      
      // 检查是否会导致循环依赖（新父任务不能是当前任务的子孙任务）
      const descendants = this.getDescendantIds(subTask);
      if (descendants.includes(newParentId)) {
        throw new Error(`Cannot move task to a descendant: ${newParentId}`);
      }
    }
    
    // 从旧父任务的 children 数组中移除
    const oldParentId = subTask.parentId;
    if (oldParentId !== null && oldParentId !== undefined) {
      const oldParent = this.findSubTask(taskTree, oldParentId);
      if (oldParent && oldParent.children) {
        oldParent.children = oldParent.children.filter((child) => child.id !== subTaskId);
      }
    }
    
    // 添加到新父任务的 children 数组
    if (newParentId !== null) {
      const newParent = this.findSubTask(taskTree, newParentId);
      if (newParent) {
        // 初始化 children 数组（如果不存在）
        if (!newParent.children) {
          newParent.children = [];
        }
        newParent.children.push(subTask);
      }
    }
    
    // 更新子任务的 parentId
    subTask.parentId = newParentId;
    
    // 重新计算子任务及其子孙任务的 depth
    const newDepth = newParentId === null ? 0 : (this.findSubTask(taskTree, newParentId)?.depth ?? 0) + 1;
    this.updateDepthRecursively(subTask, newDepth);
    
    // 保存任务树
    await this.save(taskTree);
    
    console.log(`[TaskTreeManager] ✅ SubTask moved: ${subTaskId} (from ${oldParentId ?? "root"} to ${newParentId ?? "root"})`);
  }

  /**
   * 递归更新子任务及其子孙任务的 depth
   * 
   * @param subTask 子任务
   * @param newDepth 新的深度
   */
  private updateDepthRecursively(subTask: SubTask, newDepth: number): void {
    subTask.depth = newDepth;
    
    if (subTask.children && subTask.children.length > 0) {
      for (const child of subTask.children) {
        this.updateDepthRecursively(child, newDepth + 1);
      }
    }
  }

  /**
   * 查找子任务（递归搜索）
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   * @returns 找到的子任务，如果不存在则返回 undefined
   */
  private findSubTask(taskTree: TaskTree, subTaskId: string): SubTask | undefined {
    // 在扁平化的 subTasks 列表中查找
    return taskTree.subTasks.find((t) => t.id === subTaskId);
  }

  /**
   * 获取子任务的所有子孙任务（递归获取）
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   * @returns 所有子孙任务的扁平化列表
   * 
   * 功能：
   * - 递归遍历子任务的 children
   * - 返回扁平化的子孙任务列表
   * - 不包含子任务本身
   * 
   * 验证：需求 4.1
   */
  getDescendants(
    taskTree: TaskTree,
    subTaskId: string,
  ): SubTask[] {
    // 查找子任务
    const subTask = this.findSubTask(taskTree, subTaskId);
    if (!subTask) {
      throw new Error(`SubTask not found: ${subTaskId}`);
    }
    
    // 递归获取所有子孙任务
    const descendants: SubTask[] = [];
    
    const collectDescendants = (task: SubTask): void => {
      if (task.children && task.children.length > 0) {
        for (const child of task.children) {
          descendants.push(child);
          // 递归收集子孙任务
          collectDescendants(child);
        }
      }
    };
    
    collectDescendants(subTask);
    
    return descendants;
  }

  /**
   * 获取子任务的所有祖先任务（从根到父任务的路径）
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   * @returns 从根任务到父任务的路径（不包含子任务本身）
   * 
   * 功能：
   * - 从子任务向上追溯到根任务
   * - 返回从根到父任务的路径
   * - 不包含子任务本身
   * 
   * 验证：需求 4.2
   */
  getAncestors(
    taskTree: TaskTree,
    subTaskId: string,
  ): SubTask[] {
    // 查找子任务
    const subTask = this.findSubTask(taskTree, subTaskId);
    if (!subTask) {
      throw new Error(`SubTask not found: ${subTaskId}`);
    }
    
    // 向上追溯祖先任务
    const ancestors: SubTask[] = [];
    let currentId = subTask.parentId;
    
    while (currentId !== null && currentId !== undefined) {
      const parent = this.findSubTask(taskTree, currentId);
      if (!parent) {
        // 父任务不存在，说明任务树不一致
        break;
      }
      
      // 将父任务添加到列表开头（保持从根到父的顺序）
      ancestors.unshift(parent);
      
      // 继续向上追溯
      currentId = parent.parentId;
    }
    
    return ancestors;
  }

  /**
   * 验证任务树的一致性
   * 
   * @param taskTree 任务树
   * @returns 验证结果
   * 
   * 功能：
   * - 检查循环依赖（parentId 和 dependencies）
   * - 检查引用完整性（所有引用的任务 ID 都存在）
   * - 检查深度限制（不超过 maxDepth）
   * - 检查父子关系双向一致性
   * 
   * 验证：需求 5.1
   */
  validateTaskTree(taskTree: TaskTree): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // 构建任务 ID 集合（用于快速查找）
    const taskIds = new Set(taskTree.subTasks.map((t) => t.id));
    
    // 检查每个子任务
    for (const subTask of taskTree.subTasks) {
      // 1. 检查 parentId 引用完整性
      if (subTask.parentId !== null && subTask.parentId !== undefined) {
        if (!taskIds.has(subTask.parentId)) {
          errors.push(`Task ${subTask.id}: parentId ${subTask.parentId} does not exist`);
        }
      }
      
      // 2. 检查 dependencies 引用完整性
      if (subTask.dependencies && subTask.dependencies.length > 0) {
        for (const depId of subTask.dependencies) {
          if (!taskIds.has(depId)) {
            errors.push(`Task ${subTask.id}: dependency ${depId} does not exist`);
          }
        }
      }
      
      // 3. 检查深度限制
      const maxDepth = taskTree.maxDepth ?? 3;
      if (subTask.depth !== undefined && subTask.depth > maxDepth) {
        errors.push(`Task ${subTask.id}: depth ${subTask.depth} exceeds maxDepth ${maxDepth}`);
      }
      
      // 4. 检查父子关系双向一致性
      if (subTask.parentId !== null && subTask.parentId !== undefined) {
        const parent = this.findSubTask(taskTree, subTask.parentId);
        if (parent) {
          const childExists = parent.children?.some((child) => child.id === subTask.id);
          if (!childExists) {
            errors.push(`Task ${subTask.id}: not found in parent ${subTask.parentId}'s children array`);
          }
        }
      }
      
      // 5. 检查 children 数组中的任务是否存在于 subTasks 中
      if (subTask.children && subTask.children.length > 0) {
        for (const child of subTask.children) {
          if (!taskIds.has(child.id)) {
            errors.push(`Task ${subTask.id}: child ${child.id} not found in taskTree.subTasks`);
          }
        }
      }
    }
    
    // 6. 检查循环依赖（parentId）
    for (const subTask of taskTree.subTasks) {
      if (this.hasCircularParentDependency(taskTree, subTask.id)) {
        errors.push(`Task ${subTask.id}: circular parent dependency detected`);
      }
    }
    
    // 7. 检查循环依赖（dependencies）
    for (const subTask of taskTree.subTasks) {
      if (this.hasCircularTaskDependency(taskTree, subTask.id)) {
        errors.push(`Task ${subTask.id}: circular task dependency detected`);
      }
    }
    
    // 8. 检查深度值的正确性
    for (const subTask of taskTree.subTasks) {
      if (subTask.parentId !== null && subTask.parentId !== undefined) {
        const parent = this.findSubTask(taskTree, subTask.parentId);
        if (parent) {
          const expectedDepth = (parent.depth ?? 0) + 1;
          if (subTask.depth !== expectedDepth) {
            warnings.push(`Task ${subTask.id}: depth ${subTask.depth} does not match expected depth ${expectedDepth}`);
          }
        }
      } else {
        // 根级任务的深度应该为 0
        if (subTask.depth !== 0) {
          warnings.push(`Task ${subTask.id}: root task depth should be 0, but is ${subTask.depth}`);
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 检查是否存在循环父任务依赖
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   * @returns 是否存在循环依赖
   */
  private hasCircularParentDependency(taskTree: TaskTree, subTaskId: string): boolean {
    const visited = new Set<string>();
    let currentId: string | null | undefined = subTaskId;
    
    while (currentId !== null && currentId !== undefined) {
      if (visited.has(currentId)) {
        // 发现循环
        return true;
      }
      
      visited.add(currentId);
      
      const task = this.findSubTask(taskTree, currentId);
      if (!task) {
        // 任务不存在，停止检查
        break;
      }
      
      currentId = task.parentId;
    }
    
    return false;
  }

  /**
   * 检查是否存在循环任务依赖
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   * @returns 是否存在循环依赖
   */
  private hasCircularTaskDependency(taskTree: TaskTree, subTaskId: string): boolean {
    const visited = new Set<string>();
    const stack: string[] = [subTaskId];
    
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      
      if (visited.has(currentId)) {
        // 发现循环
        return true;
      }
      
      visited.add(currentId);
      
      const task = this.findSubTask(taskTree, currentId);
      if (!task || !task.dependencies || task.dependencies.length === 0) {
        continue;
      }
      
      // 将依赖的任务加入栈
      for (const depId of task.dependencies) {
        if (depId === subTaskId) {
          // 依赖回到起点，发现循环
          return true;
        }
        stack.push(depId);
      }
    }
    
    return false;
  }

  /**
   * 创建任务树版本（完整快照）
   * 
   * @param taskTree 任务树
   * @returns 版本 ID
   * 
   * 功能：
   * - 创建任务树的完整快照
   * - 保存到版本文件（versions/<versionId>.json）
   * - 返回版本 ID
   * 
   * 验证：需求 6.1
   */
  async createVersion(taskTree: TaskTree): Promise<string> {
    const versionId = crypto.randomUUID();
    const versionDir = path.join(this.getTaskTreeDir(taskTree.id), "versions");
    const versionPath = path.join(versionDir, `${versionId}.json`);
    
    // 创建版本目录
    await fs.mkdir(versionDir, { recursive: true });
    
    // 创建版本快照（深拷贝）
    const version = {
      id: versionId,
      taskTree: JSON.parse(JSON.stringify(taskTree)),
      createdAt: Date.now(),
    };
    
    // 保存版本文件
    await fs.writeFile(versionPath, JSON.stringify(version, null, 2), "utf-8");
    
    console.log(`[TaskTreeManager] ✅ Version created: ${versionId}`);
    return versionId;
  }

  /**
   * 回滚到指定版本
   * 
   * @param taskTree 当前任务树
   * @param versionId 版本 ID
   * @returns 恢复的任务树
   * 
   * 功能：
   * - 从版本文件加载任务树
   * - 恢复到指定版本的状态
   * - 返回恢复的任务树
   * 
   * 验证：需求 6.2
   */
  async rollbackToVersion(
    taskTree: TaskTree,
    versionId: string,
  ): Promise<TaskTree> {
    const versionPath = path.join(this.getTaskTreeDir(taskTree.id), "versions", `${versionId}.json`);
    
    try {
      // 读取版本文件
      const content = await fs.readFile(versionPath, "utf-8");
      const version = JSON.parse(content) as { id: string; taskTree: TaskTree; createdAt: number };
      
      console.log(`[TaskTreeManager] ✅ Rolled back to version: ${versionId}`);
      return version.taskTree;
    } catch (err) {
      throw new Error(`Failed to rollback to version ${versionId}: ${err}`);
    }
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
