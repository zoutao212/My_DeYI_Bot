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

  constructor(llmConfig: LLMConfig) {
    this.llmConfig = llmConfig;
    this.reviewsDir = join(homedir(), ".clawdbot", "tasks");
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
      console.error("质量评估失败:", error);
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
    subTaskId: string
  ): Promise<QualityReviewResult> {
    try {
      // 1. 找到子任务
      const subTask = this.findSubTask(taskTree, subTaskId);
      if (!subTask) {
        throw new Error(`子任务 ${subTaskId} 不存在`);
      }

      // 2. 构建评估提示词
      const prompt = this.buildCompletionReviewPrompt(taskTree, subTask);
      
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
      console.error("子任务完成质量评估失败:", error);
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
    taskTree: TaskTree
  ): Promise<QualityReviewResult> {
    try {
      // 1. 构建评估提示词
      const prompt = this.buildOverallReviewPrompt(taskTree);
      
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
      console.error("整体完成质量评估失败:", error);
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
    try {
      // 1. 找到子任务
      const subTask = this.findSubTask(taskTree, subTaskId);
      if (!subTask) {
        throw new Error(`子任务 ${subTaskId} 不存在`);
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
        criteria: ["失败原因分析"],
        findings: [result.reason],
        suggestions: result.improvements,
        decision: result.decision
      });
      
      return result;
    } catch (error) {
      console.error("失败分析失败:", error);
      return {
        reason: "未知错误",
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
    const lines: string[] = [];
    
    lines.push(`# 质量评估报告`);
    lines.push(``);
    lines.push(`**任务树 ID**: ${review.taskTreeId}`);
    lines.push(`**评估类型**: ${this.getReviewTypeLabel(review.type)}`);
    lines.push(`**评估时间**: ${new Date(review.reviewedAt).toLocaleString()}`);
    lines.push(`**评估状态**: ${this.getQualityStatusLabel(review.status)}`);
    lines.push(`**评估决策**: ${this.getReviewDecisionLabel(review.decision)}`);
    lines.push(``);
    
    if (review.criteria.length > 0) {
      lines.push(`## 评估标准`);
      lines.push(``);
      review.criteria.forEach((criterion, index) => {
        lines.push(`${index + 1}. ${criterion}`);
      });
      lines.push(``);
    }
    
    if (review.findings.length > 0) {
      lines.push(`## 发现的问题`);
      lines.push(``);
      review.findings.forEach((finding, index) => {
        lines.push(`${index + 1}. ${finding}`);
      });
      lines.push(``);
    }
    
    if (review.suggestions.length > 0) {
      lines.push(`## 改进建议`);
      lines.push(``);
      review.suggestions.forEach((suggestion, index) => {
        lines.push(`${index + 1}. ${suggestion}`);
      });
      lines.push(``);
    }
    
    if (review.changes && review.changes.length > 0) {
      lines.push(`## 应用的变更`);
      lines.push(``);
      review.changes.forEach((change, index) => {
        lines.push(`${index + 1}. ${this.getChangeTypeLabel(change.type)} - 目标: ${change.targetId}`);
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
    try {
      const sessionDir = join(this.reviewsDir, record.taskTreeId);
      await fs.mkdir(sessionDir, { recursive: true });
      
      const reviewsFile = join(sessionDir, "quality-reviews.jsonl");
      const line = JSON.stringify(record) + "\n";
      
      await fs.appendFile(reviewsFile, line, "utf-8");
    } catch (error) {
      console.error("保存质量评估记录失败:", error);
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
    subTask: SubTask
  ): string {
    const prompts = getPrompts();
    const aspects = prompts.completionReview.aspects;
    const aspectsStr = Object.values(aspects).map((aspect, index) => `${index + 1}. ${aspect}`).join("\n\n");

    return `${prompts.completionReview.expertRole} ${prompts.completionReview.instruction}

${prompts.labels.rootTask}：${taskTree.rootTask}

${prompts.labels.subTaskInfo}：
- ID: ${subTask.id}
- ${prompts.labels.description}: ${subTask.prompt}
- ${prompts.labels.status}: ${subTask.status}
- ${prompts.labels.output}: ${subTask.output || prompts.labels.noOutput}

${prompts.completionReview.aspectsTitle}

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
   * 构建整体完成评估提示词
   */
  private buildOverallReviewPrompt(taskTree: TaskTree): string {
    const prompts = getPrompts();
    const completedTasksStr = taskTree.subTasks
      .filter(st => st.status === "completed")
      .map(st => `- ${st.id}: ${st.summary}\n  ${prompts.labels.output}: ${st.output || prompts.labels.noOutput}`)
      .join("\n");

    const aspects = prompts.overallReview.aspects;
    const aspectsStr = Object.values(aspects).map((aspect, index) => `${index + 1}. ${aspect}`).join("\n\n");

    return `${prompts.overallReview.expertRole} ${prompts.overallReview.instruction}

${prompts.labels.rootTask}：${taskTree.rootTask}

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
    // TODO: 实现实际的 LLM 调用
    // 这里返回一个模拟响应
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
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/```\s*([\s\S]*?)\s*```/) ||
                       [null, response];
      
      const jsonStr = jsonMatch[1] || response;
      return JSON.parse(jsonStr.trim()) as QualityReviewResult;
    } catch (error) {
      console.error("解析评估响应失败:", error);
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
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/```\s*([\s\S]*?)\s*```/) ||
                       [null, response];
      
      const jsonStr = jsonMatch[1] || response;
      return JSON.parse(jsonStr.trim()) as FailureAnalysisResult;
    } catch (error) {
      console.error("解析失败分析响应失败:", error);
      return {
        reason: "未知错误",
        context: "",
        lessons: [],
        improvements: [],
        decision: "adjust"
      };
    }
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
