/**
 * 任务树文件管理器
 * 
 * 管理任务树相关的所有文件和目录
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SubTask, TaskTree } from "./types.js";

/**
 * 差异统计信息
 */
export interface DiffStats {
  filename: string;
  diffPreview: string;
  modifiedLines: number;
  addedLines: number;
  deletedLines: number;
}

/**
 * 文件管理器
 */
export class FileManager {
  private taskTreePath: string;
  private taskTreeId: string;

  constructor(taskTreeId: string) {
    this.taskTreeId = taskTreeId;
    this.taskTreePath = path.join(
      os.homedir(),
      ".clawdbot",
      "tasks",
      taskTreeId
    );
  }

  /**
   * 获取任务树根目录路径
   */
  getTaskTreePath(): string {
    return this.taskTreePath;
  }

  /**
   * 初始化目录结构
   */
  async initialize(): Promise<void> {
    // 创建所有必要的目录
    const directories = [
      "metadata",
      "checkpoints",
      "logs",
      "sources",
      "sources/documents",
      "sources/data",
      "sources/code",
      "tasks",
      "deliverables",
      "deliverables/artifacts",
      "deliverables/diffs",
      "temp",
      "temp/cache",
    ];

    for (const dir of directories) {
      await fs.mkdir(path.join(this.taskTreePath, dir), { recursive: true });
    }

    // 创建 README.md
    await this.createReadme();

    console.log(`[FileManager] ✅ Initialized directory structure at ${this.taskTreePath}`);
  }

  /**
   * 创建 README.md
   */
  private async createReadme(): Promise<void> {
    const readme = `# 任务树：${this.taskTreeId}

## 目录结构

- \`metadata/\`: 元数据（配置、统计、时间线）
- \`checkpoints/\`: 检查点（任务树快照）
- \`logs/\`: 日志（执行、失败、错误、质量评估）
- \`sources/\`: 源文件（任务引用的原始文件）
- \`tasks/\`: 任务目录（每个任务的输出和交付产物）
- \`deliverables/\`: 交付产物（汇总所有任务的最终输出）
- \`temp/\`: 临时文件（可随时清理）

## 文件说明

- \`TASK_TREE.json\`: 任务树主文件（JSON 格式）
- \`TASK_TREE.md\`: 任务树可视化（Markdown 格式）
- \`TASK_TREE.json.bak\`: 任务树备份文件

## 使用方法

1. 查看任务树状态：\`cat TASK_TREE.md\`
2. 查看任务输出：\`cat tasks/{subTaskId}/output.txt\`
3. 查看交付产物：\`ls deliverables/artifacts/\`
4. 查看执行日志：\`cat logs/execution.log\`

---

创建时间：${new Date().toISOString()}
`;

    await fs.writeFile(
      path.join(this.taskTreePath, "README.md"),
      readme,
      "utf-8"
    );
  }

  /**
   * 保存任务输出
   * 
   * @param subTaskId 子任务 ID
   * @param output 输出内容
   * @param format 输出格式
   * @returns 输出文件路径
   */
  async saveTaskOutput(
    subTaskId: string,
    output: string,
    format: "txt" | "md" | "json" = "txt"
  ): Promise<string> {
    const taskDir = path.join(this.taskTreePath, "tasks", subTaskId);
    await fs.mkdir(taskDir, { recursive: true });

    const outputPath = path.join(taskDir, `output.${format}`);
    await fs.writeFile(outputPath, output, "utf-8");

    console.log(`[FileManager] ✅ Saved task output to ${outputPath}`);
    return outputPath;
  }

  /**
   * 保存交付产物
   * 
   * @param subTaskId 子任务 ID
   * @param filename 文件名
   * @param content 文件内容
   * @returns 交付产物文件路径
   */
  async saveArtifact(
    subTaskId: string,
    filename: string,
    content: string | Buffer
  ): Promise<string> {
    const artifactsDir = path.join(this.taskTreePath, "tasks", subTaskId, "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });

    const artifactPath = path.join(artifactsDir, filename);
    await fs.writeFile(artifactPath, content);

    console.log(`[FileManager] ✅ Saved artifact to ${artifactPath}`);
    return artifactPath;
  }

  /**
   * 生成差异对比
   * 
   * @param subTaskId 子任务 ID
   * @param originalContent 原始内容
   * @param modifiedContent 修改后的内容
   * @param filename 文件名（可选）
   * @returns 差异文件路径
   */
  async generateDiff(
    subTaskId: string,
    originalContent: string,
    modifiedContent: string,
    filename: string = "file"
  ): Promise<string> {
    const diff = this.computeDiff(originalContent, modifiedContent, filename);
    
    const taskDir = path.join(this.taskTreePath, "tasks", subTaskId);
    await fs.mkdir(taskDir, { recursive: true });

    const diffPath = path.join(taskDir, "diff.txt");
    await fs.writeFile(diffPath, diff, "utf-8");

    console.log(`[FileManager] ✅ Generated diff at ${diffPath}`);
    return diffPath;
  }

  /**
   * 计算差异（类似 git diff）
   * 
   * @param original 原始内容
   * @param modified 修改后的内容
   * @param filename 文件名
   * @returns 差异字符串
   */
  private computeDiff(original: string, modified: string, filename: string): string {
    const originalLines = original.split("\n");
    const modifiedLines = modified.split("\n");

    let diff = `--- a/${filename}\n+++ b/${filename}\n`;
    
    // 简化的差异算法（实际应该使用 diff 库）
    const maxLines = Math.max(originalLines.length, modifiedLines.length);
    let lineNumber = 1;
    let changes = 0;

    for (let i = 0; i < maxLines; i++) {
      const originalLine = originalLines[i];
      const modifiedLine = modifiedLines[i];

      if (originalLine !== modifiedLine) {
        if (changes === 0) {
          diff += `@@ -${lineNumber},${maxLines - i} +${lineNumber},${maxLines - i} @@\n`;
        }
        changes++;

        if (originalLine !== undefined) {
          diff += `-${originalLine}\n`;
        }
        if (modifiedLine !== undefined) {
          diff += `+${modifiedLine}\n`;
        }
      } else if (originalLine !== undefined) {
        diff += ` ${originalLine}\n`;
      }

      lineNumber++;
    }

    return diff;
  }

  /**
   * 读取任务输出
   * 
   * @param subTaskId 子任务 ID
   * @param format 输出格式
   * @returns 输出内容
   */
  async readTaskOutput(subTaskId: string, format: "txt" | "md" | "json" = "txt"): Promise<string> {
    const outputPath = path.join(this.taskTreePath, "tasks", subTaskId, `output.${format}`);
    
    try {
      return await fs.readFile(outputPath, "utf-8");
    } catch (err) {
      console.warn(`[FileManager] ⚠️ Failed to read task output from ${outputPath}:`, err);
      return "";
    }
  }

  /**
   * 汇总所有子任务输出
   * 
   * @param childTasks 子任务列表
   * @returns 汇总的输出内容
   */
  async aggregateChildOutputs(childTasks: SubTask[]): Promise<string> {
    const outputs: string[] = [];

    for (const child of childTasks) {
      try {
        const output = await this.readTaskOutput(child.id);
        if (output) {
          outputs.push(`### ${child.summary}\n\n${output}`);
        }
      } catch (err) {
        console.warn(`[FileManager] ⚠️ Failed to read child task ${child.id} output:`, err);
      }
    }

    return outputs.join("\n\n---\n\n");
  }

  /**
   * 保存汇总输出到交付产物目录
   * 
   * @param filename 文件名
   * @param content 内容
   * @returns 文件路径
   */
  async saveDeliverable(filename: string, content: string): Promise<string> {
    const deliverablePath = path.join(this.taskTreePath, "deliverables", filename);
    await fs.writeFile(deliverablePath, content, "utf-8");

    console.log(`[FileManager] ✅ Saved deliverable to ${deliverablePath}`);
    return deliverablePath;
  }

  /**
   * 保存任务元数据
   * 
   * @param subTask 子任务
   */
  async saveTaskMetadata(subTask: SubTask): Promise<void> {
    const taskDir = path.join(this.taskTreePath, "tasks", subTask.id);
    await fs.mkdir(taskDir, { recursive: true });

    const metadata = {
      id: subTask.id,
      summary: subTask.summary,
      status: subTask.status,
      createdAt: subTask.createdAt,
      completedAt: subTask.completedAt,
      duration: subTask.completedAt ? subTask.completedAt - subTask.createdAt : 0,
      parentId: subTask.parentId,
      depth: subTask.depth,
      files: {
        output: `tasks/${subTask.id}/output.txt`,
        artifacts: `tasks/${subTask.id}/artifacts/`,
      },
    };

    const metadataPath = path.join(taskDir, "metadata.json");
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
  }

  /**
   * 记录时间线事件
   * 
   * @param type 事件类型
   * @param taskId 任务 ID
   * @param description 描述
   */
  async recordTimelineEvent(
    type: "task_created" | "task_started" | "task_completed" | "task_failed" | "final_deliverable_generated",
    taskId: string,
    description: string
  ): Promise<void> {
    const timelinePath = path.join(this.taskTreePath, "metadata", "timeline.json");

    let timeline: { events: any[] } = { events: [] };

    try {
      const content = await fs.readFile(timelinePath, "utf-8");
      timeline = JSON.parse(content);
    } catch (err) {
      // 文件不存在，使用空时间线
    }

    timeline.events.push({
      timestamp: Date.now(),
      type,
      taskId,
      description,
    });

    await fs.writeFile(timelinePath, JSON.stringify(timeline, null, 2), "utf-8");
  }

  /**
   * 更新统计信息
   * 
   * @param stats 统计信息
   */
  async updateStatistics(stats: {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    pendingTasks: number;
    totalDuration: number;
    averageDuration: number;
  }): Promise<void> {
    const statisticsPath = path.join(this.taskTreePath, "metadata", "statistics.json");
    await fs.writeFile(statisticsPath, JSON.stringify(stats, null, 2), "utf-8");
  }

  /**
   * 记录执行日志
   * 
   * @param message 日志消息
   */
  async logExecution(message: string): Promise<void> {
    const logPath = path.join(this.taskTreePath, "logs", "execution.log");
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;

    await fs.appendFile(logPath, logEntry, "utf-8");
  }

  /**
   * 记录失败日志
   * 
   * @param subTaskId 子任务 ID
   * @param error 错误信息
   */
  async logFailure(subTaskId: string, error: string): Promise<void> {
    const logPath = path.join(this.taskTreePath, "logs", "failures.log");
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] Task ${subTaskId}: ${error}\n`;

    await fs.appendFile(logPath, logEntry, "utf-8");
  }

  /**
   * 清理临时文件
   */
  async cleanupTemp(): Promise<void> {
    const tempDir = path.join(this.taskTreePath, "temp");
    
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.mkdir(tempDir, { recursive: true });
      console.log(`[FileManager] ✅ Cleaned up temp directory`);
    } catch (err) {
      console.warn(`[FileManager] ⚠️ Failed to cleanup temp directory:`, err);
    }
  }

  /**
   * 合并所有子任务的文件产出
   * 
   * 🆕 用于写作任务完成后，将所有子任务的 txt 文件合并成一个完整的文件
   * 
   * @param taskTree 任务树
   * @returns 合并后的文件路径
   */
  async mergeTaskOutputs(taskTree: TaskTree): Promise<string> {
    // 🔧 多策略合并：producedFilePaths → artifacts → output.txt
    const allFiles: Array<{ 
      taskId: string; 
      taskSummary: string; 
      fileName: string;
      content: string;
      source: "tracked" | "artifacts" | "output";
    }> = [];
    
    for (const subTask of taskTree.subTasks) {
      if (subTask.status !== "completed") continue;
      
      let found = false;
      
      // 策略 1：使用文件追踪器记录的完整路径（最精准）
      if (subTask.metadata?.producedFilePaths && subTask.metadata.producedFilePaths.length > 0) {
        for (let i = 0; i < subTask.metadata.producedFilePaths.length; i++) {
          const filePath = subTask.metadata.producedFilePaths[i];
          const fileName = subTask.metadata.producedFiles?.[i] || path.basename(filePath);
          try {
            const content = await fs.readFile(filePath, "utf-8");
            if (content.trim().length > 0) {
              allFiles.push({
                taskId: subTask.id,
                taskSummary: subTask.summary,
                fileName,
                content,
                source: "tracked",
              });
              found = true;
              console.log(`[FileManager] 📄 策略1命中: ${fileName} (${content.length} 字符)`);
            }
          } catch (err) {
            console.warn(`[FileManager] ⚠️ 策略1失败 ${filePath}:`, err);
          }
        }
      }
      
      // 策略 2：从 artifacts 目录查找（旧路径兼容）
      if (!found && subTask.metadata?.producedFiles && subTask.metadata.producedFiles.length > 0) {
        const artifactsDir = path.join(this.taskTreePath, "tasks", subTask.id, "artifacts");
        for (const fileName of subTask.metadata.producedFiles) {
          const filePath = path.join(artifactsDir, fileName);
          try {
            const content = await fs.readFile(filePath, "utf-8");
            if (content.trim().length > 0) {
              allFiles.push({
                taskId: subTask.id,
                taskSummary: subTask.summary,
                fileName,
                content,
                source: "artifacts",
              });
              found = true;
              console.log(`[FileManager] 📄 策略2命中: ${fileName} (${content.length} 字符)`);
            }
          } catch {
            // 静默跳过，尝试下一个策略
          }
        }
      }
      
      // 策略 3：兜底读取 output.txt（LLM 回复文本）
      if (!found) {
        try {
          const output = await this.readTaskOutput(subTask.id);
          if (output && output.trim().length > 50) { // 至少 50 字符才认为是有效内容
            allFiles.push({
              taskId: subTask.id,
              taskSummary: subTask.summary,
              fileName: `output_${subTask.id}.txt`,
              content: output,
              source: "output",
            });
            found = true;
            console.log(`[FileManager] 📄 策略3兜底: output.txt (${output.length} 字符)`);
          }
        } catch {
          // 静默跳过
        }
      }
      
      if (!found) {
        console.warn(`[FileManager] ⚠️ 子任务 ${subTask.id} (${subTask.summary}) 无任何可合并内容`);
      }
    }
    
    if (allFiles.length === 0) {
      throw new Error("没有找到任何子任务的文件产出（已尝试：文件追踪 → artifacts → output.txt）");
    }
    
    // 内容验证：检查是否有"摘要式"内容（疑似 Bug 2 残留）
    const suspiciousCount = allFiles.filter(f => 
      f.source === "output" && f.content.length < 500
    ).length;
    if (suspiciousCount > 0) {
      console.warn(
        `[FileManager] ⚠️ 发现 ${suspiciousCount} 个疑似摘要内容（< 500 字符），` +
        `可能是 LLM 未使用 write 工具直接写入文件`
      );
    }
    
    // 合并内容（纯文本，不加 Markdown 标记，适合直接阅读）
    let mergedContent = "";
    
    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      if (allFiles.length > 1) {
        mergedContent += `\n\n${"=".repeat(60)}\n`;
        mergedContent += `${file.taskSummary}\n`;
        mergedContent += `${"=".repeat(60)}\n\n`;
      }
      mergedContent += file.content;
    }
    
    // 保存合并后的文件
    const deliverableDir = path.join(this.taskTreePath, "deliverables");
    await fs.mkdir(deliverableDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const mergedFileName = `完整输出_${timestamp}.txt`;
    const mergedFilePath = path.join(deliverableDir, mergedFileName);
    
    await fs.writeFile(mergedFilePath, mergedContent, "utf-8");
    
    console.log(`[FileManager] ✅ 合并完成：${mergedFilePath}`);
    console.log(
      `[FileManager] 📦 合并了 ${allFiles.length} 个文件 ` +
      `(tracked: ${allFiles.filter(f => f.source === "tracked").length}, ` +
      `artifacts: ${allFiles.filter(f => f.source === "artifacts").length}, ` +
      `output: ${allFiles.filter(f => f.source === "output").length})`
    );
    
    return mergedFilePath;
  }
}
