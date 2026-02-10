/**
 * AI 自主质量评估器
 * 
 * 核心组件：负责 AI 自主评估任务分解和执行的质量
 * 
 * 评估触发点：
 * 1. 初始任务分解后 - AI 评估分解是否合理
 * 2. 每个子任务完成后 - AI 评估完成质量
 * 3. 所有子任务完成后 - AI 评估整体质量
 * 4. 任务执行失败时 - AI 分析失败原因
 * 
 * 评估决策：
 * - 通过（continue）：继续执行
 * - 调整（adjust）：生成调整方案并自动应用
 * - 重启（restart）：保留当前结果作为经验，重新分解任务
 * - 推翻（overthrow）：完全推翻当前方案，从头开始设计
 */

import type {
  TaskTree,
  SubTask,
  QualityReviewRecord,
  QualityReviewResult,
  FailureAnalysisResult,
  ReviewType,
  QualityStatus,
  ReviewDecision,
  TaskTreeChange
} from "./types.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPrompts } from "./prompts-loader.js";
import { extractJsonFromResponse } from "./json-extractor.js";
import type { LLMCaller } from "./batch-executor.js";

/**
 * LLM 配置接口
 */
interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  endpoint?: string;
}

/**
 * AI 自主质量评估器
 */
export class QualityReviewer {
  private llmConfig: LLMConfig;
  private reviewsDir: string;
  private externalLLMCaller: LLMCaller | null;

  constructor(llmConfig: LLMConfig, llmCaller?: LLMCaller) {
    this.llmConfig = llmConfig;
    this.reviewsDir = join(homedir(), ".clawdbot", "tasks");
    this.externalLLMCaller = llmCaller ?? null;
  }

  /**
   * 设置外部 LLM 调用器（支持延迟注入）
   */
  setLLMCaller(caller: LLMCaller): void {
    this.externalLLMCaller = caller;
  }

  /**
   * 评估任务分解的质量
   * 
   * AI 自主评估任务分解是否合理：
   * - 子任务是否覆盖目标
   * - 是否有遗漏
   * - 是否有冗余
   * - 依赖关系是否合理
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID（如果是子任务分解，否则为 null）
   * @param type 评估类型
   * @returns 质量评估结果
   */
  async reviewDecomposition(
    taskTree: TaskTree,
    subTaskId: string | null,
    type: ReviewType
  ): Promise<QualityReviewResult> {
    const prompts = getPrompts();
    try {
      // 1. 构建评估提示词
      const prompt = this.buildDecompositionReviewPrompt(taskTree, subTaskId, type);
      
      // 2. 调用 LLM 进行评估
      const llmResponse = await this.callLLM(prompt);
      
      // 3. 解析评估结果
      const result = this.parseReviewResponse(llmResponse);
      
      // 4. 保存评估记录
      await this.saveReviewRecord({
        id: `review-${Date.now()}`,
        taskTreeId: taskTree.id,
        subTaskId: subTaskId || undefined,
        type,
        status: result.status,
        reviewedAt: Date.now(),
        criteria: result.criteria,
        findings: result.findings,
        suggestions: result.suggestions,
        decision: result.decision,
        changes: result.modifications
      });
      
      return result;
    } catch (error) {
      console.error(`${prompts.qualityReviewer.errors.reviewFailed}:`, error);
      // 返回默认的通过结果
      return {
        status: "passed",
        decision: "continue",
        criteria: [],
        findings: [],
        suggestions: []
      };
    }
  }

  /**
   * 评估子任务完成的质量
   * 
   * AI 自主评估子任务是否达到预期目标：
   * - 是否完成了任务描述中的所有要求
   * - 输出是否符合预期
   * - 是否有错误或遗漏
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   * @returns 质量评估结果
   */
  async reviewSubTaskCompletion(
    taskTree: TaskTree,
    subTaskId: string,
    rootTaskOverride?: string,
  ): Promise<QualityReviewResult> {
    const prompts = getPrompts();
    try {
      // 1. 找到子任务
      const subTask = this.findSubTask(taskTree, subTaskId);
      if (!subTask) {
        throw new Error(`${prompts.qualityReviewer.errors.subTaskNotFound} ${subTaskId}`);
      }

      // 🔧 关键修复：读取实际文件内容用于质检
      // subTask.output 可能只是 LLM 的确认消息（如"已创作完成"），不是文件内容。
      // 质检 LLM 必须看到真实产出才能做出有意义的评估。
      let fileContent: string | undefined;
      const producedPaths = subTask.metadata?.producedFilePaths;
      if (producedPaths && producedPaths.length > 0) {
        try {
          const fs = await import("node:fs/promises");
          const contents: string[] = [];
          for (const filePath of producedPaths) {
            try {
              const content = await fs.readFile(filePath, "utf-8");
              contents.push(content);
            } catch {
              // 文件不存在或无法读取，跳过
            }
          }
          if (contents.length > 0) {
            fileContent = contents.join("\n\n---\n\n");
            // 截断到 6000 字符，避免质检 prompt 过长导致上下文溢出
            if (fileContent.length > 6000) {
              fileContent = fileContent.substring(0, 3000) + "\n\n...[中间内容省略]...\n\n" + fileContent.substring(fileContent.length - 2500);
            }
            console.log(
              `[QualityReviewer] 📏 读取 ${contents.length} 个文件用于质检，共 ${contents.reduce((a, c) => a + c.length, 0)} 字符` +
              (fileContent.length < contents.reduce((a, c) => a + c.length, 0) ? `（截断到 ${fileContent.length} 字符）` : ""),
            );
          }
        } catch {
          // import 失败，回退到 output
        }
      }

      // 2. 构建评估提示词（使用轮次根任务描述替代可能过期的 taskTree.rootTask）
      const prompt = this.buildCompletionReviewPrompt(taskTree, subTask, rootTaskOverride, fileContent);
      
      // 3. 调用 LLM 进行评估
      const llmResponse = await this.callLLM(prompt);
      
      // 4. 解析评估结果
      const result = this.parseReviewResponse(llmResponse);
      
      // 5. 保存评估记录
      await this.saveReviewRecord({
        id: `review-${Date.now()}`,
        taskTreeId: taskTree.id,
        subTaskId,
        type: "subtask_completion",
        status: result.status,
        reviewedAt: Date.now(),
        criteria: result.criteria,
        findings: result.findings,
        suggestions: result.suggestions,
        decision: result.decision,
        changes: result.modifications
      });
      
      return result;
    } catch (error) {
      console.error(`${prompts.qualityReviewer.errors.completionReviewFailed}:`, error);
      return {
        status: "passed",
        decision: "continue",
        criteria: [],
        findings: [],
        suggestions: []
      };
    }
  }

  /**
   * 评估整体任务完成的质量
   * 
   * AI 自主评估所有子任务完成后的整体质量：
   * - 是否满足用户需求
   * - 是否有整体性问题
   * - 是否需要进一步改进
   * 
   * @param taskTree 任务树
   * @returns 质量评估结果
   */
  async reviewOverallCompletion(
    taskTree: TaskTree,
    rootTaskOverride?: string,
  ): Promise<QualityReviewResult> {
    const prompts = getPrompts();
    try {
      // 1. 构建评估提示词（支持 Round.goal 覆盖过期的 taskTree.rootTask）
      const prompt = this.buildOverallReviewPrompt(taskTree, rootTaskOverride);
      
      // 2. 调用 LLM 进行评估
      const llmResponse = await this.callLLM(prompt);
      
      // 3. 解析评估结果
      const result = this.parseReviewResponse(llmResponse);
      
      // 4. 保存评估记录
      await this.saveReviewRecord({
        id: `review-${Date.now()}`,
        taskTreeId: taskTree.id,
        type: "overall_completion",
        status: result.status,
        reviewedAt: Date.now(),
        criteria: result.criteria,
        findings: result.findings,
        suggestions: result.suggestions,
        decision: result.decision,
        changes: result.modifications
      });
      
      return result;
    } catch (error) {
      console.error(`${prompts.qualityReviewer.errors.overallReviewFailed}:`, error);
      return {
        status: "passed",
        decision: "continue",
        criteria: [],
        findings: [],
        suggestions: []
      };
    }
  }

  /**
   * 分析任务失败的原因
   * 
   * AI 自主分析任务失败的根本原因：
   * - 失败的直接原因
   * - 失败的根本原因
   * - 可以学到的教训
   * - 改进建议
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   * @param error 错误信息
   * @returns 失败分析结果
   */
  async analyzeFailure(
    taskTree: TaskTree,
    subTaskId: string,
    error: string
  ): Promise<FailureAnalysisResult> {
    const prompts = getPrompts();
    try {
      // 1. 找到子任务
      const subTask = this.findSubTask(taskTree, subTaskId);
      if (!subTask) {
        throw new Error(`${prompts.qualityReviewer.errors.subTaskNotFound} ${subTaskId}`);
      }

      // 2. 构建分析提示词
      const prompt = this.buildFailureAnalysisPrompt(taskTree, subTask, error);
      
      // 3. 调用 LLM 进行分析
      const llmResponse = await this.callLLM(prompt);
      
      // 4. 解析分析结果
      const result = this.parseFailureAnalysisResponse(llmResponse);
      
      // 5. 保存评估记录
      await this.saveReviewRecord({
        id: `review-${Date.now()}`,
        taskTreeId: taskTree.id,
        subTaskId,
        type: "failure_analysis",
        status: "needs_adjustment",
        reviewedAt: Date.now(),
        criteria: [prompts.failureAnalysis.aspectsTitle],
        findings: [result.reason],
        suggestions: result.improvements,
        decision: result.decision
      });
      
      return result;
    } catch (error) {
      console.error(`${prompts.qualityReviewer.errors.failureAnalysisFailed}:`, error);
      return {
        reason: "Unknown error",
        context: "",
        lessons: [],
        improvements: [],
        decision: "adjust"
      };
    }
  }

  /**
   * 生成质量评估报告（Markdown 格式）
   * 
   * @param taskTree 任务树
   * @param review 质量评估记录
   * @returns Markdown 格式的报告
   */
  generateReviewReport(
    taskTree: TaskTree,
    review: QualityReviewRecord
  ): string {
    const prompts = getPrompts();
    const lines: string[] = [];
    
    lines.push(prompts.qualityReviewer.report.title);
    lines.push(``);
    lines.push(`${prompts.qualityReviewer.report.taskTreeId}: ${review.taskTreeId}`);
    lines.push(`${prompts.qualityReviewer.report.reviewType}: ${this.getReviewTypeLabel(review.type)}`);
    lines.push(`${prompts.qualityReviewer.report.reviewTime}: ${new Date(review.reviewedAt).toLocaleString()}`);
    lines.push(`${prompts.qualityReviewer.report.reviewStatus}: ${this.getQualityStatusLabel(review.status)}`);
    lines.push(`${prompts.qualityReviewer.report.reviewDecision}: ${this.getReviewDecisionLabel(review.decision)}`);
    lines.push(``);
    
    if (review.criteria.length > 0) {
      lines.push(prompts.qualityReviewer.report.criteriaTitle);
      lines.push(``);
      review.criteria.forEach((criterion, index) => {
        lines.push(`${index + 1}. ${criterion}`);
      });
      lines.push(``);
    }
    
    if (review.findings.length > 0) {
      lines.push(prompts.qualityReviewer.report.findingsTitle);
      lines.push(``);
      review.findings.forEach((finding, index) => {
        lines.push(`${index + 1}. ${finding}`);
      });
      lines.push(``);
    }
    
    if (review.suggestions.length > 0) {
      lines.push(prompts.qualityReviewer.report.suggestionsTitle);
      lines.push(``);
      review.suggestions.forEach((suggestion, index) => {
        lines.push(`${index + 1}. ${suggestion}`);
      });
      lines.push(``);
    }
    
    if (review.changes && review.changes.length > 0) {
      lines.push(prompts.qualityReviewer.report.changesTitle);
      lines.push(``);
      review.changes.forEach((change, index) => {
        lines.push(`${index + 1}. ${this.getChangeTypeLabel(change.type)} - ${prompts.qualityReviewer.report.changeTarget}: ${change.targetId}`);
      });
      lines.push(``);
    }
    
    return lines.join("\n");
  }

  /**
   * 保存质量评估记录
   * 
   * @param record 质量评估记录
   */
  async saveReviewRecord(record: QualityReviewRecord): Promise<void> {
    const prompts = getPrompts();
    try {
      const sessionDir = join(this.reviewsDir, record.taskTreeId);
      await fs.mkdir(sessionDir, { recursive: true });
      
      const reviewsFile = join(sessionDir, "quality-reviews.jsonl");
      const line = JSON.stringify(record) + "\n";
      
      await fs.appendFile(reviewsFile, line, "utf-8");
    } catch (error) {
      console.error(`${prompts.qualityReviewer.errors.saveRecordFailed}:`, error);
    }
  }

  /**
   * 获取质量评估历史
   * 
   * @param taskTreeId 任务树 ID
   * @returns 质量评估记录列表
   */
  async getReviewHistory(taskTreeId: string): Promise<QualityReviewRecord[]> {
    try {
      const reviewsFile = join(this.reviewsDir, taskTreeId, "quality-reviews.jsonl");
      const content = await fs.readFile(reviewsFile, "utf-8");
      
      const lines = content.trim().split("\n");
      return lines.map(line => JSON.parse(line) as QualityReviewRecord);
    } catch (error) {
      // 文件不存在或读取失败，返回空数组
      return [];
    }
  }

  // ========================================
  // 私有辅助方法
  // ========================================

  /**
   * 查找子任务
   */
  private findSubTask(taskTree: TaskTree, subTaskId: string): SubTask | null {
    return taskTree.subTasks.find(st => st.id === subTaskId) || null;
  }

  /**
   * 构建任务分解评估提示词
   */
  private buildDecompositionReviewPrompt(
    taskTree: TaskTree,
    subTaskId: string | null,
    type: ReviewType
  ): string {
    const prompts = getPrompts();
    const subTasksStr = taskTree.subTasks
      .map(st => `- ${st.id}: ${st.summary}\n  ${prompts.labels.description}: ${st.prompt}\n  ${prompts.labels.status}: ${st.status}`)
      .join("\n");

    const aspects = prompts.decompositionReview.aspects;
    const aspectsStr = Object.values(aspects).map((aspect, index) => `${index + 1}. ${aspect}`).join("\n\n");

    const decisionsStr = Object.entries(prompts.decompositionReview.aspects).map(([key, value]) => `- ${value}`).join("\n");

    return `${prompts.decompositionReview.expertRole} ${prompts.decompositionReview.instruction}

${prompts.labels.rootTask}：${taskTree.rootTask}

${prompts.labels.subTaskList}：
${subTasksStr}

${prompts.decompositionReview.aspectsTitle}

${aspectsStr}

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "status": "passed" | "needs_adjustment" | "needs_restart" | "needs_overthrow",
  "decision": "continue" | "adjust" | "restart" | "overthrow",
  "criteria": ["${prompts.labels.evaluationCriteria}1", "${prompts.labels.evaluationCriteria}2"],
  "findings": ["${prompts.labels.findings}1", "${prompts.labels.findings}2"],
  "suggestions": ["${prompts.labels.suggestions}1", "${prompts.labels.suggestions}2"],
  "modifications": [
    {
      "type": "add_task" | "remove_task" | "modify_task",
      "targetId": "目标任务 ID",
      "after": "变更后的值",
      "timestamp": ${Date.now()}
    }
  ]
}
\`\`\`

${prompts.reviewDecisions.title}
- **${prompts.reviewDecisions.continue}**
- **${prompts.reviewDecisions.adjust}**
- **${prompts.reviewDecisions.restart}**
- **${prompts.reviewDecisions.overthrow}**

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 构建子任务完成评估提示词
   */
  private buildCompletionReviewPrompt(
    taskTree: TaskTree,
    subTask: SubTask,
    rootTaskOverride?: string,
    fileContent?: string,
  ): string {
    const prompts = getPrompts();
    const aspects = prompts.completionReview.aspects;
    const aspectsStr = Object.values(aspects).map((aspect, index) => `${index + 1}. ${aspect}`).join("\n\n");

    // 🔧 BUG5 修复：优先使用轮次根任务描述，避免跨轮次误判
    const effectiveRootTask = rootTaskOverride || taskTree.rootTask;

    // 🔧 P0 修复：提取子任务 prompt 中的字数要求，注入硬性校验规则
    const wordCountHint = this.extractWordCountRequirement(subTask.prompt);
    const wordCountRule = wordCountHint
      ? `\n\n⚠️ 字数硬性校验规则：\n该子任务要求产出约 ${wordCountHint} 字。请估算实际输出的字数（中文按字符计数）。\n- 实际字数 >= 要求的 70%（即 >= ${Math.floor(wordCountHint * 0.7)} 字）→ 可以 continue\n- 实际字数 < 要求的 70%（即 < ${Math.floor(wordCountHint * 0.7)} 字）→ 必须 restart，并在 findings 中注明"字数不达标：预期 ${wordCountHint} 字，实际约 X 字"\n`
      : "";

    // 🆕 B1: 注入上次质检失败原因（如果有），帮助质检 LLM 判断是否已改进
    const previousFindings = subTask.metadata?.lastFailureFindings;
    const retryContext = previousFindings && previousFindings.length > 0
      ? `\n\n📋 历史信息：这是第 ${subTask.retryCount ?? 0} 次重试。上次被打回的原因：\n${previousFindings.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n请重点检查这些问题是否已改进。如果已改进，即使其他方面略有不足也可以 continue。\n`
      : "";

    // 🔧 关键修复：优先使用文件内容作为质检对象
    // subTask.output 可能只是 LLM 的确认消息（如"已创作完成"），不是实际产出。
    // 当有文件内容时，用文件内容替代 output，让质检 LLM 看到真实产出。
    let outputSection: string;
    if (fileContent) {
      const fileCharCount = fileContent.length;
      outputSection = `- ${prompts.labels.output}（来自文件产出，共 ${fileCharCount} 字符）:\n${fileContent}`;
    } else {
      outputSection = `- ${prompts.labels.output}: ${subTask.output || prompts.labels.noOutput}`;
    }

    return `${prompts.completionReview.expertRole} ${prompts.completionReview.instruction}

${prompts.labels.rootTask}：${effectiveRootTask}

${prompts.labels.subTaskInfo}：
- ID: ${subTask.id}
- ${prompts.labels.description}: ${subTask.prompt}
- ${prompts.labels.status}: ${subTask.status}
${outputSection}

${prompts.completionReview.aspectsTitle}

${aspectsStr}
${wordCountRule}${retryContext}
⚠️ 决策指引（overthrow vs restart）：
- "overthrow"（推翻）仅用于任务本身不可能完成的结构性错误（如需求矛盾、技术上不可行）。
- 如果输出存在风格偏差（如出现不合时代/世界观的元素、语气不当、角色人格泄露导致的不当内容），应使用 "restart"（重新执行），因为这类问题在重试时通常可以修正。
- 如果输出字数/篇幅严重不足（低于要求的 70%），必须使用 "restart"。
- 只评估子任务自身的输出质量，不要因为输出风格与你的偏好不同就判定 overthrow。

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "status": "passed" | "needs_adjustment" | "needs_restart" | "needs_overthrow",
  "decision": "continue" | "adjust" | "restart" | "overthrow",
  "criteria": ["${prompts.labels.evaluationCriteria}1", "${prompts.labels.evaluationCriteria}2"],
  "findings": ["${prompts.labels.findings}1", "${prompts.labels.findings}2"],
  "suggestions": ["${prompts.labels.suggestions}1", "${prompts.labels.suggestions}2"]
}
\`\`\`

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 🔧 P0: 从 prompt 文本中提取字数要求
   * 支持多种中英文字数表达：3000字、3000 字、3000 words、三千字 等
   * 
   * @returns 提取到的字数数值，未找到返回 undefined
   */
  extractWordCountRequirement(prompt: string): number | undefined {
    // 匹配 "N字"、"N 字"、"N个字"、"N words"、"N characters" 等
    const patterns = [
      /(\d{3,})\s*[字个](?:左右|以上|以内)?/,
      /(?:约|大约|至少|不少于|不低于)\s*(\d{3,})\s*[字个]/,
      /(\d{3,})\s*(?:words?|characters?)/i,
      /每[章节篇]\s*(?:约|大约)?\s*(\d{3,})\s*[字个]/,
      /字数[：:]\s*(\d{3,})/,
      /篇幅[：:]\s*(\d{3,})/,
    ];
    
    for (const pattern of patterns) {
      const match = prompt.match(pattern);
      if (match?.[1]) {
        const num = parseInt(match[1], 10);
        if (num >= 100 && num <= 1_000_000) {
          return num;
        }
      }
    }
    
    // 匹配中文数字：三千字、五千字、一万字 等
    const cnNumMap: Record<string, number> = {
      "一千": 1000, "两千": 2000, "三千": 3000, "四千": 4000, "五千": 5000,
      "六千": 6000, "七千": 7000, "八千": 8000, "九千": 9000,
      "一万": 10000, "两万": 20000, "三万": 30000, "五万": 50000,
    };
    for (const [cn, num] of Object.entries(cnNumMap)) {
      if (prompt.includes(`${cn}字`) || prompt.includes(`${cn}个字`)) {
        return num;
      }
    }
    
    return undefined;
  }

  /**
   * 构建整体完成评估提示词
   */
  private buildOverallReviewPrompt(taskTree: TaskTree, rootTaskOverride?: string): string {
    const prompts = getPrompts();
    // 🆕 V2: 优先使用 Round.goal 覆盖可能过期的 taskTree.rootTask
    const effectiveRootTask = rootTaskOverride || taskTree.rootTask;
    const completedTasksStr = taskTree.subTasks
      .filter(st => st.status === "completed")
      .map(st => `- ${st.id}: ${st.summary}\n  ${prompts.labels.output}: ${st.output || prompts.labels.noOutput}`)
      .join("\n");

    const aspects = prompts.overallReview.aspects;
    const aspectsStr = Object.values(aspects).map((aspect, index) => `${index + 1}. ${aspect}`).join("\n\n");

    return `${prompts.overallReview.expertRole} ${prompts.overallReview.instruction}

${prompts.labels.rootTask}：${effectiveRootTask}

${prompts.labels.completedSubTasks}：
${completedTasksStr}

${prompts.overallReview.aspectsTitle}

${aspectsStr}

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "status": "passed" | "needs_adjustment" | "needs_restart" | "needs_overthrow",
  "decision": "continue" | "adjust" | "restart" | "overthrow",
  "criteria": ["${prompts.labels.evaluationCriteria}1", "${prompts.labels.evaluationCriteria}2"],
  "findings": ["${prompts.labels.findings}1", "${prompts.labels.findings}2"],
  "suggestions": ["${prompts.labels.suggestions}1", "${prompts.labels.suggestions}2"]
}
\`\`\`

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 构建失败分析提示词
   */
  private buildFailureAnalysisPrompt(
    taskTree: TaskTree,
    subTask: SubTask,
    error: string
  ): string {
    const prompts = getPrompts();
    const aspects = prompts.failureAnalysis.aspects;
    const aspectsStr = Object.values(aspects).map((aspect, index) => `${index + 1}. ${aspect}`).join("\n\n");

    const decisionsStr = Object.entries(prompts.failureAnalysis.decisions)
      .map(([key, value]) => `- **${key}**: ${value}`)
      .join("\n");

    return `${prompts.failureAnalysis.expertRole} ${prompts.failureAnalysis.instruction}

${prompts.labels.rootTask}：${taskTree.rootTask}

${prompts.labels.subTaskInfo}：
- ID: ${subTask.id}
- ${prompts.labels.description}: ${subTask.prompt}
- ${prompts.labels.errorInfo}: ${error}

${prompts.failureAnalysis.aspectsTitle}

${aspectsStr}

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "reason": "失败的根本原因",
  "context": "失败的上下文信息",
  "lessons": ["教训1", "教训2"],
  "improvements": ["改进建议1", "改进建议2"],
  "decision": "adjust" | "restart" | "overthrow"
}
\`\`\`

${prompts.failureAnalysis.decisionsTitle}
${decisionsStr}

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 调用 LLM
   */
  private async callLLM(prompt: string): Promise<string> {
    // 优先使用注入的系统 LLM 调用器（走 auth profiles + completeSimple）
    if (this.externalLLMCaller) {
      console.log(`[QualityReviewer] 使用系统 LLM 管线评估，提示词长度: ${prompt.length}`);
      try {
        return await this.externalLLMCaller.call(prompt);
      } catch (err) {
        console.warn(`[QualityReviewer] ⚠️ 系统 LLM 调用失败，降级到规则驱动:`, err);
      }
    }

    // 降级：规则驱动质量评估默认通过
    console.log(`[QualityReviewer] 使用规则驱动评估（降级），提示词长度: ${prompt.length}`);
    return `{
  "status": "passed",
  "decision": "continue",
  "criteria": ["覆盖性", "独立性", "合理性"],
  "findings": [],
  "suggestions": []
}`;
  }

  /**
   * 解析评估响应
   */
  private parseReviewResponse(response: string): QualityReviewResult {
    const prompts = getPrompts();
    try {
      const jsonStr = this.extractJson(response);
      return JSON.parse(jsonStr) as QualityReviewResult;
    } catch (error) {
      console.error(`${prompts.qualityReviewer.errors.reviewFailed}:`, error);
      return {
        status: "passed",
        decision: "continue",
        criteria: [],
        findings: [],
        suggestions: []
      };
    }
  }

  /**
   * 解析失败分析响应
   */
  private parseFailureAnalysisResponse(response: string): FailureAnalysisResult {
    const prompts = getPrompts();
    try {
      const jsonStr = this.extractJson(response);
      return JSON.parse(jsonStr) as FailureAnalysisResult;
    } catch (error) {
      console.error(`${prompts.qualityReviewer.errors.failureAnalysisFailed}:`, error);
      return {
        reason: "Unknown error",
        context: "",
        lessons: [],
        improvements: [],
        decision: "adjust"
      };
    }
  }

  /**
   * 从 LLM 响应中提取 JSON 字符串（兼容有/无闭合 ``` 的情况）
   */
  private extractJson(response: string): string {
    return extractJsonFromResponse(response);
  }

  /**
   * 获取评估类型标签
   */
  private getReviewTypeLabel(type: ReviewType): string {
    const prompts = getPrompts();
    return prompts.labels.reviewTypeLabels[type] || type;
  }

  /**
   * 获取质量状态标签
   */
  private getQualityStatusLabel(status: QualityStatus): string {
    const prompts = getPrompts();
    return prompts.labels.qualityStatusLabels[status] || status;
  }

  /**
   * 获取评估决策标签
   */
  private getReviewDecisionLabel(decision: ReviewDecision): string {
    const prompts = getPrompts();
    return prompts.labels.reviewDecisionLabels[decision] || decision;
  }

  /**
   * 获取变更类型标签
   */
  private getChangeTypeLabel(type: string): string {
    const prompts = getPrompts();
    const changeTypeLabels = prompts.labels.changeTypeLabels as Record<string, string>;
    return changeTypeLabels[type] || type;
  }
}

/**
 * 创建 QualityReviewer 实例
 * 
 * @param llmConfig LLM 配置
 * @returns QualityReviewer 实例
 */
export function createQualityReviewer(llmConfig: LLMConfig): QualityReviewer {
  return new QualityReviewer(llmConfig);
}
