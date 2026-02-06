/**
 * 输出格式化器
 * 
 * 格式化任务输出，生成用户友好的消息
 */

import type { SubTask } from "./types.js";
import type { DiffStats } from "./file-manager.js";

/**
 * 输出格式化器
 */
export class OutputFormatter {
  /**
   * 格式化任务完成消息
   * 
   * @param subTask 子任务
   * @param outputPath 输出文件路径
   * @returns 格式化的消息
   */
  formatTaskCompletion(subTask: SubTask, outputPath: string): string {
    const output = subTask.output || "";
    const preview = output.length > 500 ? output.substring(0, 500) + "..." : output;
    const duration = subTask.completedAt ? subTask.completedAt - subTask.createdAt : 0;

    return `
✅ 任务完成：${subTask.summary}

📄 输出内容（前 500 字）：
${preview}

📁 完整内容已保存到：
${outputPath}

📊 统计信息：
- 字数：${output.length}
- 耗时：${this.formatDuration(duration)}
    `.trim();
  }

  /**
   * 格式化差异对比消息
   * 
   * @param subTask 子任务
   * @param diffPath 差异文件路径
   * @param stats 差异统计信息
   * @returns 格式化的消息
   */
  formatDiffCompletion(subTask: SubTask, diffPath: string, stats: DiffStats): string {
    return `
✅ 任务完成：${subTask.summary}

📝 文件修改：${stats.filename}

${stats.diffPreview}

📁 差异文件已保存到：
${diffPath}

📊 统计信息：
- 修改行数：${stats.modifiedLines}
- 新增行数：${stats.addedLines}
- 删除行数：${stats.deletedLines}
    `.trim();
  }

  /**
   * 格式化递归任务完成消息
   * 
   * @param parentTask 父任务
   * @param childTasks 子任务列表
   * @param outputPath 输出文件路径
   * @returns 格式化的消息
   */
  formatRecursiveCompletion(
    parentTask: SubTask,
    childTasks: SubTask[],
    outputPath: string
  ): string {
    const structure = this.buildTaskStructure(childTasks);
    const totalWords = childTasks.reduce((sum, task) => sum + (task.output?.length || 0), 0);
    const totalDuration = childTasks.reduce(
      (sum, task) => {
        const duration = task.completedAt ? task.completedAt - task.createdAt : 0;
        return sum + duration;
      },
      0
    );

    const preview = parentTask.output 
      ? (parentTask.output.length > 500 
          ? parentTask.output.substring(0, 500) + "..." 
          : parentTask.output)
      : "";

    return `
✅ 任务完成：${parentTask.summary}

📖 任务结构：
${structure}

📄 输出内容（前 500 字）：
${preview}

📁 完整内容已保存到：
${outputPath}

📊 统计信息：
- 总字数：${totalWords}
- 层级深度：${parentTask.depth || 0}
- 子任务数量：${childTasks.length}
- 总耗时：${this.formatDuration(totalDuration)}
    `.trim();
  }

  /**
   * 格式化多文件输出消息
   * 
   * @param subTask 子任务
   * @param files 文件列表
   * @param artifactsPath 交付产物目录路径
   * @returns 格式化的消息
   */
  formatMultiFileCompletion(
    subTask: SubTask,
    files: string[],
    artifactsPath: string
  ): string {
    const fileTree = this.buildFileTree(files);
    const totalSize = files.reduce((sum, file) => sum + file.length, 0);

    return `
✅ 任务完成：${subTask.summary}

📦 生成的文件：
${fileTree}

📁 所有文件已保存到：
${artifactsPath}

📊 统计信息：
- 文件数量：${files.length}
- 总大小：${this.formatSize(totalSize)}
    `.trim();
  }

  /**
   * 构建任务结构树
   * 
   * @param childTasks 子任务列表
   * @returns 树状结构字符串
   */
  private buildTaskStructure(childTasks: SubTask[]): string {
    return childTasks
      .map((task, index) => {
        const prefix = index === childTasks.length - 1 ? "└──" : "├──";
        const wordCount = task.output?.length || 0;
        return `${prefix} ${task.summary} (${wordCount} 字)`;
      })
      .join("\n");
  }

  /**
   * 构建文件树
   * 
   * @param files 文件列表
   * @returns 树状结构字符串
   */
  private buildFileTree(files: string[]): string {
    // 简化实现：直接列出文件
    return files
      .map((file, index) => {
        const prefix = index === files.length - 1 ? "└──" : "├──";
        return `${prefix} ${file}`;
      })
      .join("\n");
  }

  /**
   * 格式化时长
   * 
   * @param ms 毫秒数
   * @returns 格式化的时长字符串
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes} 分 ${remainingSeconds} 秒`;
    }
    return `${seconds} 秒`;
  }

  /**
   * 格式化文件大小
   * 
   * @param bytes 字节数
   * @returns 格式化的文件大小字符串
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    } else {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
  }

  /**
   * 格式化任务看板
   * 
   * @param tasks 任务列表
   * @returns 格式化的任务看板
   */
  formatTaskBoard(tasks: SubTask[]): string {
    const pending = tasks.filter(t => t.status === "pending");
    const active = tasks.filter(t => t.status === "active");
    const completed = tasks.filter(t => t.status === "completed");
    const failed = tasks.filter(t => t.status === "failed");

    let board = "📋 任务看板\n\n";

    if (active.length > 0) {
      board += "🔄 进行中：\n";
      active.forEach(task => {
        board += `  - ${task.summary}\n`;
      });
      board += "\n";
    }

    if (pending.length > 0) {
      board += "⏳ 待执行：\n";
      pending.forEach(task => {
        board += `  - ${task.summary}\n`;
      });
      board += "\n";
    }

    if (completed.length > 0) {
      board += `✅ 已完成 (${completed.length})：\n`;
      completed.slice(0, 5).forEach(task => {
        board += `  - ${task.summary}\n`;
      });
      if (completed.length > 5) {
        board += `  ... 还有 ${completed.length - 5} 个任务\n`;
      }
      board += "\n";
    }

    if (failed.length > 0) {
      board += `❌ 失败 (${failed.length})：\n`;
      failed.forEach(task => {
        board += `  - ${task.summary}\n`;
      });
      board += "\n";
    }

    board += `📊 总计：${tasks.length} 个任务`;

    return board;
  }
}
