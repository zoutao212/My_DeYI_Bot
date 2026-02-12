/**
 * 任务树文件管理器
 * 
 * 管理任务树相关的所有文件和目录
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SubTask, TaskTree } from "./types.js";

// ========================================
// 🆕 P62: 合并内容质量验证工具
// ========================================

/** LLM 确认消息特征模式（中英双语） */
const CONFIRMATION_PATTERNS = [
  /^(OK[。.]?\s*)?已完成/,
  /^(OK[。.]?\s*)?已创作/,
  /^(OK[。.]?\s*)?已将/,
  /^(OK[。.]?\s*)?任务(已)?完成/,
  /^(OK[。.]?\s*)?内容已(成功)?写入/,
  /^(OK[。.]?\s*)?已成功/,
  /^(OK[。.]?\s*)?《[^》]+》.*已(创作|完成|写入)/,
  /content has been (written|saved|created)/i,
  /task (is )?completed?/i,
  /successfully (written|saved|created)/i,
];

/** 文件路径引用模式（LLM 确认消息中的路径引用） */
const PATH_REFERENCE_PATTERNS = [
  /`workspace\/[^`]+`/,
  /`[^`]*[\\/][^`]*\.txt`/,
  /写入(文件|了)\s*[`"]/,
  /保存(到|至)\s*[`"]/,
];

/**
 * 🆕 P62: 检测文本是否为 LLM 确认消息（而非实际内容）
 * 
 * 启发式规则：
 * 1. 短文本（< 300 字符）且匹配确认模式 → 高置信度
 * 2. 短文本（< 500 字符）且包含文件路径引用 → 中置信度
 * 3. 长文本（> 500 字符）→ 即使匹配也可能是真正内容，不判定
 * 
 * @param text 待检测文本
 * @returns 检测结果 { isConfirmation, confidence, reason }
 */
export function detectConfirmationMessage(text: string): {
  isConfirmation: boolean;
  confidence: "high" | "medium" | "low";
  reason?: string;
} {
  if (!text || text.length === 0) {
    return { isConfirmation: false, confidence: "low" };
  }

  const trimmed = text.trim();
  const firstLine = trimmed.split("\n")[0].trim();

  // 长文本大概率是真正内容
  if (trimmed.length > 500) {
    return { isConfirmation: false, confidence: "high" };
  }

  // 短文本（< 300 字符）+ 匹配确认模式 → 高置信度
  if (trimmed.length < 300) {
    for (const pattern of CONFIRMATION_PATTERNS) {
      if (pattern.test(firstLine) || pattern.test(trimmed)) {
        return {
          isConfirmation: true,
          confidence: "high",
          reason: `短文本(${trimmed.length}字) + 匹配确认模式: ${pattern.source}`,
        };
      }
    }
  }

  // 短文本（< 500 字符）+ 包含文件路径引用 → 中置信度
  if (trimmed.length < 500) {
    for (const pattern of PATH_REFERENCE_PATTERNS) {
      if (pattern.test(trimmed)) {
        // 额外检查：如果文本主体大部分是路径引用和确认语，则判定
        const nonPathContent = trimmed
          .replace(/`[^`]+`/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (nonPathContent.length < 200) {
          return {
            isConfirmation: true,
            confidence: "medium",
            reason: `短文本(${trimmed.length}字) + 文件路径引用，有效内容仅 ${nonPathContent.length} 字`,
          };
        }
      }
    }
  }

  return { isConfirmation: false, confidence: "low" };
}

/**
 * 🆕 P64: 合并质量指标
 */
export interface MergeQualityMetrics {
  /** 总分段数 */
  totalSegments: number;
  /** 成功读取的分段数 */
  successfulReads: number;
  /** 各层回退命中次数 */
  fallbackHits: {
    producedFilePaths: number;
    fallbackFilePath: number;
    segmentFileName: number;
    outputPathExtract: number;
    outputFallback: number;
  };
  /** 确认消息检测拦截次数 */
  confirmationIntercepted: number;
  /** 合并后总字数 */
  mergedChars: number;
  /** 期望最小字数 */
  expectedMinChars: number;
  /** 质量评级 */
  quality: "excellent" | "good" | "degraded" | "failed";
}

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
  async mergeTaskOutputs(taskTree: TaskTree, roundId?: string): Promise<string> {
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

      // 🔧 P13 修复：按 roundId 过滤，只合并指定轮次的子任务
      if (roundId && subTask.rootTaskId !== roundId) continue;
      
      // 🔧 P1+P36 修复：跳过操作型/汇总型任务
      // 但 V4 分段合并后的父任务（waitForChildren + 有 producedFilePaths）不跳过——
      // 它持有合并后的章节文件，是最终合并的正确数据源。
      if (subTask.waitForChildren || subTask.metadata?.isSummaryTask || subTask.metadata?.isRootTask) {
        const hasProducedFiles = subTask.metadata?.producedFilePaths && subTask.metadata.producedFilePaths.length > 0;
        if (!hasProducedFiles) {
          console.log(`[FileManager] ⏭️ 跳过汇总/操作型任务: ${subTask.id} (${subTask.summary})`);
          continue;
        }
        // 有 producedFilePaths 的父任务不跳过，走正常的策略1/2/3
        console.log(`[FileManager] 📖 P36: 保留已合并的父任务: ${subTask.id} (${subTask.summary}) — ${subTask.metadata!.producedFilePaths!.length} 个文件`);
      }

      // 🔧 P36 修复：跳过分段子任务（isSegment），如果父任务已完成合并
      // 原因：mergeSegmentsIfComplete 已将分段内容合并到父任务的章节文件中，
      // 如果同时合并分段子任务的碎片文件和父任务的章节文件，会导致内容重复。
      if (subTask.metadata?.isSegment && subTask.metadata.segmentOf) {
        const parentTask = taskTree.subTasks.find(t => t.id === subTask.metadata!.segmentOf);
        if (parentTask?.status === "completed" && parentTask.metadata?.producedFilePaths?.length) {
          console.log(`[FileManager] ⏭️ P36: 跳过已合并的分段子任务: ${subTask.id} (${subTask.summary})`);
          continue;
        }
      }

      // 🔧 问题 W 修复：跳过被 decompose 标记为 completed 的原始子任务
      // 原因：decomposeFailedTask 把原始子任务标记为 completed，但其输出是不完整的。
      // 续写子任务会包含完整的后续内容，如果同时合并原始子任务的不完整输出，
      // 会导致最终产物中有重复或不连贯的内容。
      // 检测方式：如果该任务有续写子任务（id 匹配 "{taskId}-cont-"），说明它被 decompose 过。
      const hasContinuations = taskTree.subTasks.some(
        t => t.id.startsWith(`${subTask.id}-cont-`) && t.status === "completed",
      );
      if (hasContinuations && subTask.metadata?.qualityReview?.decision === "decompose") {
        console.log(`[FileManager] ⏭️ 跳过被 decompose 的原始任务（续写子任务包含完整内容）: ${subTask.id} (${subTask.summary})`);
        continue;
      }
      
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
    
    // 🔧 问题 F 修复：按任务创建顺序排序，确保续写子任务紧跟在原始子任务后面
    // 原因：续写子任务被 addSubTask 追加到数组末尾，合并后的内容顺序可能是：
    // 第一章 → 第二章 → ... → 续写第一章第2部分 → 续写第一章第3部分
    // 正确顺序应该是：第一章 → 续写第一章第2部分 → 续写第一章第3部分 → 第二章 → ...
    // 排序策略：按 taskId 排序（续写子任务 ID 格式为 "{原始ID}-cont-{N}"，自然排序会紧跟原始任务）
    allFiles.sort((a, b) => {
      // 🔧 P39 修复：同时识别 -cont-N 和 -seg-N 后缀
      const parseId = (id: string) => {
        const contMatch = id.match(/^(.+)-cont-(\d+)$/);
        if (contMatch) {
          return { baseId: contMatch[1], seqNum: parseInt(contMatch[2], 10) };
        }
        const segMatch = id.match(/^(.+)-seg-(\d+)$/);
        if (segMatch) {
          return { baseId: segMatch[1], seqNum: parseInt(segMatch[2], 10) };
        }
        return { baseId: id, seqNum: 0 };
      };
      const aInfo = parseId(a.taskId);
      const bInfo = parseId(b.taskId);
      // 同一个基础任务的文件按序号排序
      if (aInfo.baseId === bInfo.baseId) {
        return aInfo.seqNum - bInfo.seqNum;
      }
      // 不同基础任务按原始数组顺序（通过在 taskTree.subTasks 中的位置）
      const aIdx = taskTree.subTasks.findIndex(t => t.id === a.taskId || t.id === aInfo.baseId);
      const bIdx = taskTree.subTasks.findIndex(t => t.id === b.taskId || t.id === bInfo.baseId);
      return aIdx - bIdx;
    });
    
    // 🆕 P63: 增强内容验证 — 过滤确认消息 + 摘要式内容
    let confirmationFiltered = 0;
    let summaryFiltered = 0;
    const beforeFilter = allFiles.length;
    const filteredFiles = allFiles.filter(f => {
      // P63: 使用 detectConfirmationMessage 检测 LLM 确认消息
      const detection = detectConfirmationMessage(f.content);
      if (detection.isConfirmation && detection.confidence !== "low") {
        confirmationFiltered++;
        console.log(
          `[FileManager] 🛡️ P63: 过滤确认消息 — ${f.taskSummary} (${f.content.length} 字符): ${detection.reason}`,
        );
        return false;
      }
      // 原有摘要过滤
      if (f.source === "output" && f.content.length < 500) {
        summaryFiltered++;
        console.log(`[FileManager] 🗑️ 过滤疑似摘要内容: ${f.taskSummary} (${f.content.length} 字符)`);
        return false;
      }
      return true;
    });
    const filteredCount = beforeFilter - filteredFiles.length;
    if (filteredCount > 0) {
      console.log(
        `[FileManager] 🧹 P63: 已过滤 ${filteredCount} 个无效内容 ` +
        `(确认消息=${confirmationFiltered}, 摘要=${summaryFiltered})`
      );
    }
    
    // 使用过滤后的文件列表
    const mergeFiles = filteredFiles.length > 0 ? filteredFiles : allFiles; // 如果全被过滤了，回退到原始列表
    
    // 🆕 P66: 任务类型感知合并格式
    // 推断主要任务类型（从子任务的 taskType 或 rootTask 关键词推断）
    const taskTypeCounts: Record<string, number> = {};
    for (const sub of taskTree.subTasks) {
      const tt = sub.taskType ?? "generic";
      taskTypeCounts[tt] = (taskTypeCounts[tt] ?? 0) + 1;
    }
    const dominantType = Object.entries(taskTypeCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "generic";

    // 根据任务类型选择合并策略
    const isWritingMerge = dominantType === "writing" ||
      (taskTree.rootTask ?? "").match(/[写创作小说章节文章翻译]/);
    const isCodingMerge = dominantType === "coding";

    let mergedContent = "";
    
    for (let i = 0; i < mergeFiles.length; i++) {
      const file = mergeFiles[i];
      const isContinuation = file.taskId.includes("-cont-") || file.taskId.includes("-seg-");
      const prevFile = i > 0 ? mergeFiles[i - 1] : null;
      const isPrevSameBase = prevFile && (() => {
        const baseA = file.taskId.replace(/-cont-\d+$/, "");
        const baseB = prevFile.taskId.replace(/-cont-\d+$/, "");
        return baseA === baseB;
      })();
      
      if (mergeFiles.length > 1) {
        if (isContinuation && isPrevSameBase) {
          // 续写/分段子任务紧跟原始任务，无缝衔接
          mergedContent += "\n\n";
        } else if (isWritingMerge) {
          // P66: 写作类 — 章节之间只用空行分隔，不加机器感分隔线
          mergedContent += i > 0 ? "\n\n\n" : "";
        } else if (isCodingMerge) {
          // P66: 编码类 — 用文件路径风格的标题
          mergedContent += `\n\n// ${"─".repeat(50)}\n`;
          mergedContent += `// ${file.taskSummary}\n`;
          mergedContent += `// ${"─".repeat(50)}\n\n`;
        } else {
          // 通用/分析类 — 保留原有分隔线
          mergedContent += `\n\n${"=".repeat(60)}\n`;
          mergedContent += `${file.taskSummary}\n`;
          mergedContent += `${"=".repeat(60)}\n\n`;
        }
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
      `[FileManager] 📦 合并了 ${mergeFiles.length} 个文件 ` +
      `(tracked: ${mergeFiles.filter(f => f.source === "tracked").length}, ` +
      `artifacts: ${mergeFiles.filter(f => f.source === "artifacts").length}, ` +
      `output: ${mergeFiles.filter(f => f.source === "output").length})`
    );
    
    return mergedFilePath;
  }
}
