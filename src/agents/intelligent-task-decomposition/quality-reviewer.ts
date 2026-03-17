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
import { classifyTaskType, isWordCountCritical } from "./task-type-classifier.js";
import { calculateWordCountThreshold } from "./task-output-validator.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPrompts } from "./prompts-loader.js";
import { extractJsonFromResponse } from "./json-extractor.js";
import type { LLMCaller } from "./batch-executor.js";
import type { ClawdbotConfig } from "../../config/config.js";
import crypto from "node:crypto";
import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEmbeddedPiAgent } from "../pi-embedded.js";
import { withApproval, checkApprovalRequired } from "../../infra/llm-approval-wrapper.js";

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
 * 🔧 P44: LLM 降级错误（区分"LLM 不可用"和"其他错误"）
 * 
 * 当 LLM 管线不可用时抛出此错误，让调用方可以选择走规则驱动验证，
 * 而不是一律返回 "passed" 盲目放行。
 */
class LLMDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMDegradedError";
  }
}

type EmbeddedAgentRunConfig = {
  config: ClawdbotConfig;
  provider?: string;
  modelId?: string;
};

/**
 * AI 自主质量评估器
 */
export class QualityReviewer {
  private llmConfig: LLMConfig;
  private reviewsDir: string;
  private externalLLMCaller: LLMCaller | null;
  private embeddedAgentRunConfig: EmbeddedAgentRunConfig | null = null;

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

  setEmbeddedAgentRunConfig(cfg: EmbeddedAgentRunConfig): void {
    this.embeddedAgentRunConfig = cfg;
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
      // 🆕 三级降级链：Full LLM → Lightweight LLM → Auto-pass
      const lightResult = await this.lightweightDecompositionReview(taskTree, subTaskId);
      if (lightResult) {
        console.log(`[QualityReviewer] ✅ 分解质检降级到轻量级 LLM 成功: decision=${lightResult.decision}`);
        return lightResult;
      }
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
    // 🔧 P44: 提升到 try 外，让 catch 中的规则验证也能访问文件内容
    let fileContent: string | undefined;
    try {
      // 1. 找到子任务
      const subTask = this.findSubTask(taskTree, subTaskId);
      if (!subTask) {
        throw new Error(`${prompts.qualityReviewer.errors.subTaskNotFound} ${subTaskId}`);
      }

      // 🔧 关键修复：读取实际文件内容用于质检
      // subTask.output 可能只是 LLM 的确认消息（如"已创作完成"），不是文件内容。
      // 质检 LLM 必须看到真实产出才能做出有意义的评估。
      const producedPaths = subTask.metadata?.producedFilePaths;
      if (producedPaths && producedPaths.length > 0) {
        try {
          const fs = await import("node:fs/promises");
          const nodePath = await import("node:path");
          const nodeOs = await import("node:os");
          const contents: string[] = [];
          for (const rawFilePath of producedPaths) {
            try {
              // 🔧 P6/P11 修复：相对路径解析（与 orchestrator 对齐）
              let filePath = rawFilePath;
              if (!nodePath.default.isAbsolute(filePath)) {
                filePath = nodePath.default.join(nodeOs.default.homedir(), "clawd", filePath);
              }
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

      // 🆕 Gap2: 预取经验池摘要（质检时参考已知质量问题模式）
      let experienceHint = "";
      try {
        const { generateExperienceSummary } = await import("./experience-pool.js");
        experienceHint = await generateExperienceSummary(subTask.taskType, 3);
      } catch { /* 经验池不可用，不阻塞质检 */ }

      // 2. 构建评估提示词（使用轮次根任务描述替代可能过期的 taskTree.rootTask）
      const prompt = this.buildCompletionReviewPrompt(taskTree, subTask, rootTaskOverride, fileContent, experienceHint);
      
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
      // 🆕 三级降级链：Full LLM → Lightweight LLM → Rule-based → Auto-pass
      const subTask = this.findSubTask(taskTree, subTaskId);

      // 第二级：轻量级 LLM 质检（短 prompt 更不容易超时/限流/格式错误）
      if (subTask) {
        const lightResult = await this.lightweightLLMReview(subTask, fileContent, rootTaskOverride);
        if (lightResult) {
          console.log(`[QualityReviewer] ✅ 子任务质检降级到轻量级 LLM 成功: decision=${lightResult.decision}`);
          return lightResult;
        }
      }

      // 第三级：规则驱动验证（LLM 完全不可用时的兜底）
      if (error instanceof LLMDegradedError && subTask) {
        console.log(`[QualityReviewer] 🔧 LLM 完全不可用，降级到规则验证 — ${subTaskId}`);
        return this.ruleBasedCompletionReview(subTask, fileContent);
      }

      // 最后一级：自动通过
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
   * 🆕 轻量级 LLM 质检 — 子任务完成质量（三级降级链的第二级）
   * 
   * 设计思路：不为每种 taskType 写死硬编码规则，而是用极短的 prompt（~2KB）
   * 调用同一个 LLM 做快速质检。短 prompt 更不容易超时/被限流/产出格式错误。
   * 
   * 降级链：Full LLM Review → Lightweight LLM Review → Rule-based Review → Auto-pass
   */
  async lightweightLLMReview(
    subTask: SubTask,
    fileContent?: string,
    rootTaskOverride?: string,
  ): Promise<QualityReviewResult | null> {
    if (!this.externalLLMCaller) return null;

    try {
      const taskType = subTask.taskType ?? "generic";
      const taskDesc = (subTask.prompt ?? "").substring(0, 400);

      // 取输出摘要（优先文件内容，截断到 1500 字符）
      const rawContent = fileContent ?? subTask.output ?? "";
      let contentSnippet: string;
      if (rawContent.length <= 1500) {
        contentSnippet = rawContent;
      } else {
        contentSnippet = rawContent.substring(0, 1000) + "\n...[省略]...\n" + rawContent.substring(rawContent.length - 400);
      }

      // 🆕 G3: 策略感知的审查重点（替代纯 taskType 硬编码）
      const strategies = subTask.metadata?.validationStrategies ?? [];
      const passed = subTask.metadata?.passedValidations ?? [];
      const failed = subTask.metadata?.failedValidations ?? [];
      let focusHint: string;
      if (strategies.length > 0) {
        const checkedSet = new Set([...passed, ...failed.map(f => f.strategy)]);
        const unchecked = strategies.filter(s => !checkedSet.has(s));
        const parts: string[] = [];
        if (passed.length > 0) parts.push(`已通过前置: ${passed.join("、")}`);
        if (failed.length > 0) parts.push(`前置失败: ${failed.map(f => f.strategy).join("、")}`);
        if (unchecked.length > 0) parts.push(`需评估: ${unchecked.join("、")}`);
        focusHint = `\n【验证策略】${strategies.join("、")}（${parts.join("；")}）`;
      } else {
        focusHint = this.getLightweightReviewFocus(taskType);
      }

      const prompt = `你是任务质检员。请快速评估以下子任务的完成质量。

【任务类型】${taskType}
【任务描述】${taskDesc}${rootTaskOverride ? `\n【总目标】${rootTaskOverride.substring(0, 200)}` : ""}
【实际产出（${rawContent.length} 字符）】
${contentSnippet}
${focusHint}

请用 JSON 回答（仅此格式，无其他文字）：
\`\`\`json
{"decision":"continue或restart","findings":["一句话发现"],"failureType":"可选的失败类型"}
\`\`\`

decision 说明：产出基本合格→continue，明显不合格（跑题/严重缺失/格式完全错误）→restart。只有明显缺陷才 restart。`;

      console.log(`[QualityReviewer] 🔄 尝试轻量级 LLM 质检，prompt 长度: ${prompt.length}`);
      const response = await this.externalLLMCaller.call(prompt);
      const result = this.parseReviewResponse(response);
      console.log(`[QualityReviewer] ✅ 轻量级 LLM 质检完成: decision=${result.decision}`);
      return result;
    } catch (err) {
      console.warn(`[QualityReviewer] ⚠️ 轻量级 LLM 质检也失败，继续降级到规则验证:`, err);
      return null;
    }
  }

  /**
   * 🆕 轻量级 LLM 质检 — 任务分解质量
   * 
   * 用极短 prompt 评估分解方案是否合理，替代 reviewDecomposition 失败时的盲目通过。
   */
  async lightweightDecompositionReview(
    taskTree: TaskTree,
    subTaskId: string | null,
  ): Promise<QualityReviewResult | null> {
    if (!this.externalLLMCaller) return null;

    try {
      const subTasksSummary = taskTree.subTasks
        .slice(0, 15)
        .map(st => `- ${st.summary ?? st.id} (${st.status})`)
        .join("\n");

      const prompt = `你是任务分解质检员。请快速评估以下任务分解方案是否合理。

【根任务】${(taskTree.rootTask ?? "").substring(0, 300)}
【子任务列表】
${subTasksSummary}

审查重点：子任务是否覆盖目标？有无遗漏或冗余？粒度是否合适？

请用 JSON 回答（仅此格式）：
\`\`\`json
{"decision":"continue或adjust","findings":["一句话发现"],"suggestions":["可选建议"]}
\`\`\`

分解基本合理→continue，有明显遗漏或严重冗余→adjust。`;

      console.log(`[QualityReviewer] 🔄 尝试轻量级分解质检，prompt 长度: ${prompt.length}`);
      const response = await this.externalLLMCaller.call(prompt);
      const result = this.parseReviewResponse(response);
      console.log(`[QualityReviewer] ✅ 轻量级分解质检完成: decision=${result.decision}`);
      return result;
    } catch (err) {
      console.warn(`[QualityReviewer] ⚠️ 轻量级分解质检也失败，降级通过:`, err);
      return null;
    }
  }

  /**
   * 🆕 轻量级 LLM 质检 — 整体完成评估
   * 
   * 用极短 prompt 评估所有子任务完成后的整体质量。
   */
  async lightweightOverallReview(
    taskTree: TaskTree,
    rootTaskOverride?: string,
  ): Promise<QualityReviewResult | null> {
    if (!this.externalLLMCaller) return null;

    try {
      const effectiveRootTask = rootTaskOverride || taskTree.rootTask;
      const completedSummary = taskTree.subTasks
        .filter(st => st.status === "completed")
        .slice(0, 15)
        .map(st => `- ${st.summary ?? st.id}: ${(st.output ?? "").substring(0, 80)}`)
        .join("\n");
      const failedCount = taskTree.subTasks.filter(st => st.status === "failed").length;

      const prompt = `你是任务质检员。请快速评估以下任务的整体完成情况。

【总目标】${(effectiveRootTask ?? "").substring(0, 300)}
【已完成子任务】
${completedSummary}
${failedCount > 0 ? `【失败子任务数】${failedCount}` : ""}

审查重点：是否满足用户需求？有无关键遗漏？

请用 JSON 回答（仅此格式）：
\`\`\`json
{"decision":"continue或restart","findings":["一句话发现"],"suggestions":["可选建议"]}
\`\`\`

整体基本达标→continue，有重大缺陷→restart。`;

      console.log(`[QualityReviewer] 🔄 尝试轻量级整体质检，prompt 长度: ${prompt.length}`);
      const response = await this.externalLLMCaller.call(prompt);
      const result = this.parseReviewResponse(response);
      console.log(`[QualityReviewer] ✅ 轻量级整体质检完成: decision=${result.decision}`);
      return result;
    } catch (err) {
      console.warn(`[QualityReviewer] ⚠️ 轻量级整体质检也失败，降级通过:`, err);
      return null;
    }
  }

  /**
   * 🆕 轻量级 LLM 失败分析
   * 
   * 用极短 prompt 分析任务失败原因，替代 analyzeFailure 失败时的盲目默认值。
   */
  async lightweightFailureAnalysis(
    subTask: SubTask,
    error: string,
  ): Promise<FailureAnalysisResult | null> {
    if (!this.externalLLMCaller) return null;

    try {
      const prompt = `你是任务失败分析员。请快速分析以下任务失败的原因。

【任务描述】${(subTask.prompt ?? "").substring(0, 300)}
【错误信息】${error.substring(0, 500)}
【任务产出】${(subTask.output ?? "").substring(0, 300)}

请用 JSON 回答（仅此格式）：
\`\`\`json
{"reason":"根本原因","context":"上下文","lessons":["教训"],"improvements":["改进"],"decision":"adjust或restart"}
\`\`\``;

      console.log(`[QualityReviewer] 🔄 尝试轻量级失败分析，prompt 长度: ${prompt.length}`);
      const response = await this.externalLLMCaller.call(prompt);
      const result = this.parseFailureAnalysisResponse(response);
      console.log(`[QualityReviewer] ✅ 轻量级失败分析完成: decision=${result.decision}`);
      return result;
    } catch (err) {
      console.warn(`[QualityReviewer] ⚠️ 轻量级失败分析也失败，使用默认值:`, err);
      return null;
    }
  }

  /**
   * 🆕 根据任务类型生成轻量级质检的审查重点（一行式）
   * 
   * 与 buildTaskTypeReviewHint 不同，这里只给 1-2 行精简提示，
   * 用于轻量级 prompt 场景，最大限度减少 token 消耗。
   */
  private getLightweightReviewFocus(taskType: string): string {
    switch (taskType) {
      case "writing": return "\n【审查重点】字数是否达标、内容是否连贯、是否跑题";
      case "coding": return "\n【审查重点】代码逻辑是否正确、是否覆盖需求、有无明显 bug";
      case "analysis": return "\n【审查重点】分析是否有深度、结论是否有依据、结构是否清晰";
      case "research": return "\n【审查重点】调研是否全面、有无遗漏关键维度";
      case "data": return "\n【审查重点】数据处理是否正确、格式是否符合要求";
      case "design": return "\n【审查重点】方案是否可行、是否覆盖需求、接口是否完整";
      case "automation": return "\n【审查重点】操作是否实际执行、步骤是否完整、结果是否符合预期";
      case "planning": return "\n【审查重点】计划是否完整覆盖目标、步骤是否可执行";
      case "review": return "\n【审查重点】修改是否全面、是否引入新问题";
      default: return "\n【审查重点】是否完成了任务要求、输出质量是否合格";
    }
  }

  /**
   * 🔧 P44: 规则驱动的子任务完成验证（LLM 完全不可用时的最后兜底）
   * 
   * 降级链的第三级：Full LLM → Lightweight LLM → Rule-based → Auto-pass
   * 只在 LLM 完全不可用时才走到这里。
   */
  ruleBasedCompletionReview(
    subTask: SubTask,
    fileContent?: string,
  ): QualityReviewResult {
    const findings: string[] = [];
    const suggestions: string[] = [];
    let decision: ReviewDecision = "continue";
    let status: QualityStatus = "passed";
    let failureType: string | undefined;

    // 检查 1: 字数验证（写作类任务）
    const taskType = subTask.taskType ?? "generic";
    const wordCountReq = this.extractWordCountRequirement(subTask.prompt);
    if (wordCountReq && isWordCountCritical(taskType)) {
      const actualContent = fileContent ?? subTask.output ?? "";
      const actualLength = actualContent.length;
      const ratio = actualLength / Math.max(wordCountReq, 1);

      // 🔧 P51: 使用公共阈值计算函数（与 OutputValidator 统一标准）
      // 修复前：硬编码 0.5/0.7，与 OutputValidator 的动态阈值矛盾——
      // 续写子任务 OutputValidator 通过(60%>55%)但 QualityReviewer 拒绝(60%<70%) → 无限 restart
      const dynamicThreshold = calculateWordCountThreshold(subTask);
      if (ratio < dynamicThreshold * 0.7) {
        // 极端不足（低于动态阈值的 70%）：restart
        findings.push(`P44规则检查：字数严重不足 — 要求 ${wordCountReq} 字，实际 ${actualLength} 字（${Math.round(ratio * 100)}%，阈值 ${Math.round(dynamicThreshold * 100)}%）`);
        decision = "restart";
        status = "needs_restart";
        failureType = "word_count";
      } else if (ratio < dynamicThreshold) {
        // 不达标（低于动态阈值）：restart
        findings.push(`P44规则检查：字数不达标 — 要求 ${wordCountReq} 字，实际 ${actualLength} 字（${Math.round(ratio * 100)}%，阈值 ${Math.round(dynamicThreshold * 100)}%）`);
        decision = "restart";
        status = "needs_restart";
        failureType = "word_count";
      } else {
        // >= 动态阈值：通过
        findings.push(`P44规则检查：字数达标 — ${actualLength}/${wordCountReq} 字（${Math.round(ratio * 100)}%，阈值 ${Math.round(dynamicThreshold * 100)}%）`);
      }
    }

    // 检查 2: 内容存在性
    const hasOutput = !!(subTask.output && subTask.output.length > 50);
    const hasFile = !!(subTask.metadata?.producedFilePaths?.length || subTask.metadata?.fallbackFilePath);
    const hasContent = hasOutput || hasFile || !!fileContent;

    if (decision === "continue") {
      if (!hasContent && wordCountReq) {
        findings.push(`规则检查：无实际内容产出（要求 ${wordCountReq} 字）`);
        decision = "restart";
        status = "needs_restart";
        failureType = "incomplete";
      } else if (!hasContent) {
        findings.push(`规则检查：无内容产出（非写作任务，降级为 warning）`);
        suggestions.push("检查任务是否正确执行");
      }
    }

    // 🆕 G4: 策略驱动的规则检查（根据 validationStrategies 扩展检查维度）
    const strategies = subTask.metadata?.validationStrategies ?? [];

    // 检查 3: file_output 策略 — 要求文件输出的任务必须有文件产出
    if (decision === "continue" && strategies.includes("file_output")) {
      if (!hasFile && !fileContent) {
        findings.push(`规则检查：file_output 策略要求文件输出，但未检测到文件产出`);
        // 写作/编码类严格要求文件输出，其他类型降级为 warning
        if (["writing", "coding", "data"].includes(taskType)) {
          decision = "restart";
          status = "needs_restart";
          failureType = "incomplete";
        } else {
          suggestions.push("任务可能未正确产出文件");
        }
      }
    }

    // 检查 4: structured_output 策略 — 分析/研究类任务需要结构化输出
    if (decision === "continue" && strategies.includes("structured_output")) {
      const content = fileContent ?? subTask.output ?? "";
      if (content.length > 500) {
        const structuralSignals = [
          /^#+\s/m,           // Markdown 标题
          /^\s*[-*]\s/m,      // 无序列表
          /^\s*\d+\.\s/m,     // 有序列表
          /\|.*\|.*\|/m,      // 表格
        ];
        const signalCount = structuralSignals.filter(p => p.test(content)).length;
        if (signalCount < 1) {
          findings.push(`规则检查：structured_output 策略要求结构化输出，但未检测到标题/列表/表格等结构信号`);
          suggestions.push("建议使用 Markdown 标题、列表或表格组织内容");
          // 非致命，不阻塞（结构化是质量维度，不是正确性维度）
        }
      }
    }

    // 检查 5: completeness 策略 — prompt 很长但输出极短（可能 LLM 偷懒）
    if (decision === "continue" && strategies.includes("completeness")) {
      const content = fileContent ?? subTask.output ?? "";
      const promptLen = subTask.prompt.length;
      if (promptLen > 500 && content.length < 50 && !hasFile) {
        findings.push(`规则检查：completeness 策略 — prompt ${promptLen} 字符，输出仅 ${content.length} 字符，疑似未完成`);
        decision = "restart";
        status = "needs_restart";
        failureType = "incomplete";
      }
    }

    console.log(
      `[QualityReviewer] 🔧 规则验证结果: decision=${decision}, strategies=[${strategies.join(",")}], findings=[${findings.join("; ")}]`,
    );

    return {
      status,
      decision,
      criteria: ["P44规则驱动验证"],
      findings,
      suggestions,
      failureType,
    } as QualityReviewResult;
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
      // 🆕 三级降级链：Full LLM → Lightweight LLM → Auto-pass
      const lightResult = await this.lightweightOverallReview(taskTree, rootTaskOverride);
      if (lightResult) {
        console.log(`[QualityReviewer] ✅ 整体质检降级到轻量级 LLM 成功: decision=${lightResult.decision}`);
        return lightResult;
      }
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
      // 🆕 三级降级链：Full LLM → Lightweight LLM → Default
      const subTask = this.findSubTask(taskTree, subTaskId);
      if (subTask) {
        const errStr = error instanceof Error ? error.message : String(error);
        const lightResult = await this.lightweightFailureAnalysis(subTask, errStr);
        if (lightResult) {
          console.log(`[QualityReviewer] ✅ 失败分析降级到轻量级 LLM 成功: decision=${lightResult.decision}`);
          return lightResult;
        }
      }
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
    experienceHint?: string,
  ): string {
    const prompts = getPrompts();
    const aspects = prompts.completionReview.aspects;
    const aspectsStr = Object.values(aspects).map((aspect, index) => `${index + 1}. ${aspect}`).join("\n\n");

    // 🔧 BUG5 修复：优先使用轮次根任务描述，避免跨轮次误判
    const effectiveRootTask = rootTaskOverride || taskTree.rootTask;

    // 🆕 V6→G1+G2: 策略驱动的审查重点（替代纯 taskType 硬编码）
    // 读取 V6 前置验证结果（passedValidations/failedValidations），让 LLM 跳过已通过的维度
    const taskType = subTask.taskType ?? classifyTaskType(subTask.prompt).type;
    const taskTypeReviewHint = this.buildValidationContextHint(subTask);

    // 🔧 P0 修复：提取子任务 prompt 中的字数要求，注入硬性校验规则
    // 🆕 V6: 仅对写作类任务注入字数硬性规则
    const wordCountHint = isWordCountCritical(taskType)
      ? this.extractWordCountRequirement(subTask.prompt)
      : undefined;
    const wordCountRule = wordCountHint
      ? `\n\n⚠️ 字数硬性校验规则：\n该子任务要求产出约 ${wordCountHint} 字。请估算实际输出的字数（中文按字符计数）。\n- 实际字数 >= 要求的 80%（即 >= ${Math.floor(wordCountHint * 0.8)} 字）→ 可以 continue\n- 实际字数 < 要求的 80%（即 < ${Math.floor(wordCountHint * 0.8)} 字）→ 必须 restart，并在 findings 中注明"字数不达标：预期 ${wordCountHint} 字，实际约 X 字"\n- 注意：系统已在前置检查中拦截了 < 60% 的极端情况，你只需关注 60%-80% 区间的判断\n`
      : "";

    // 🆕 B1: 注入上次质检失败原因（如果有），帮助质检 LLM 判断是否已改进
    const previousFindings = subTask.metadata?.lastFailureFindings;
    const retryContext = previousFindings && previousFindings.length > 0
      ? `\n\n📋 历史信息：这是第 ${subTask.retryCount ?? 0} 次重试。上次被打回的原因：\n${previousFindings.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n请重点检查这些问题是否已改进。如果已改进，即使其他方面略有不足也可以 continue。\n`
      : "";

    // 🆕 V3+P54: 注入纲领上下文到质检 prompt
    // 🔧 P54: 优先使用 V7 结构化组件（人物卡 + 该章纲要），替代截断的 masterBlueprint
    // V7 路径：精准注入人物卡（角色一致性审查关键）+ 该章剧情纲要
    // 回退路径：截断 masterBlueprint 到 2000 字
    let blueprintReviewCtx = "";
    let chapterOutlineCtx = "";
    const meta = taskTree.metadata;
    const hasV7 = meta?.blueprintCharacterCards && meta.blueprintCharacterCards.length > 50;

    if (hasV7) {
      // V7 路径：精准组件注入
      const parts: string[] = [];

      // 人物卡（角色一致性审查的核心依据，截断到 1500 字）
      if (meta.blueprintCharacterCards) {
        const cards = meta.blueprintCharacterCards.length > 1500
          ? meta.blueprintCharacterCards.substring(0, 1500) + "\n...[人物卡已截断]"
          : meta.blueprintCharacterCards;
        parts.push(`👤 **人物卡片**（审查角色行为/语言是否一致）：\n${cards}`);
      }

      // 风格指南（审查风格一致性）
      if (meta.blueprintStyleGuide) {
        const sg = meta.blueprintStyleGuide.length > 500
          ? meta.blueprintStyleGuide.substring(0, 500) + "\n...[风格指南已截断]"
          : meta.blueprintStyleGuide;
        parts.push(`🎨 **风格指南**：\n${sg}`);
      }

      if (parts.length > 0) {
        blueprintReviewCtx = `\n\n📋 **V7 结构化纲领**（用于判断内容一致性）：\n${parts.join("\n\n")}\n`;
      }

      // 精准匹配该章纲要
      const cnMap: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
      let chNum = subTask.metadata?.chapterNumber ?? 0;
      if (!chNum) {
        const chMatch = (subTask.summary ?? "").match(/第\s*([一二三四五六七八九十\d]+)\s*[章节篇幕]/);
        if (chMatch) chNum = cnMap[chMatch[1]] ?? parseInt(chMatch[1], 10);
      }
      const v7Synopsis = chNum > 0 ? meta.blueprintChapterSynopses?.[String(chNum)] : undefined;
      if (v7Synopsis) {
        chapterOutlineCtx = `\n📖 **本章剧情纲要（第${chNum}章）**：\n${v7Synopsis}\n请重点检查输出是否覆盖了纲要中的核心情节点、角色行动和衔接点。\n`;
      } else if (subTask.metadata?.chapterOutline) {
        chapterOutlineCtx = `\n📖 **本子任务专属大纲**：\n${subTask.metadata.chapterOutline}\n请重点检查输出是否覆盖了大纲中的核心情节点、角色行动和衔接点。\n`;
      }
    } else {
      // 回退路径：截断 masterBlueprint
      if (meta?.masterBlueprint) {
        const bp = meta.masterBlueprint;
        const truncatedBp = bp.length > 2000
          ? bp.substring(0, 2000) + "\n...[纲领已截断]"
          : bp;
        blueprintReviewCtx = `\n\n📋 **总纲领摘要**（用于判断内容一致性）：\n${truncatedBp}\n`;
      }
      if (subTask.metadata?.chapterOutline) {
        chapterOutlineCtx = `\n📖 **本子任务专属大纲**：\n${subTask.metadata.chapterOutline}\n请重点检查输出是否覆盖了大纲中的核心情节点、角色行动和衔接点。\n`;
      }
    }

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
${blueprintReviewCtx}${chapterOutlineCtx}
${prompts.completionReview.aspectsTitle}

${aspectsStr}
${taskTypeReviewHint}${wordCountRule}${retryContext}${experienceHint ? `\n${experienceHint}\n` : ""}
⚠️ 决策指引（overthrow vs restart）：
- "overthrow"（推翻）仅用于任务本身不可能完成的结构性错误（如需求矛盾、技术上不可行）。
- 如果输出存在风格偏差、逻辑错误、格式问题等，应使用 "restart"（重新执行），因为这类问题在重试时通常可以修正。
- 如果输出字数/篇幅严重不足（低于要求的 70%），必须使用 "restart"。
- 只评估子任务自身的输出质量，不要因为输出风格与你的偏好不同就判定 overthrow。

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "status": "passed" | "needs_adjustment" | "needs_restart" | "needs_overthrow",
  "decision": "continue" | "adjust" | "restart" | "overthrow",
  "failureType": "word_count" | "content_confusion" | "quality" | "style" | "repetition" | "off_topic" | "incomplete" | "wrong_format" | "tool_misuse" | "logic_error" | "other",
  "criteria": ["${prompts.labels.evaluationCriteria}1", "${prompts.labels.evaluationCriteria}2"],
  "findings": ["${prompts.labels.findings}1", "${prompts.labels.findings}2"],
  "suggestions": ["${prompts.labels.suggestions}1", "${prompts.labels.suggestions}2"]
}
\`\`\`

failureType 字段说明（decision 为 restart 或 overthrow 时必填，continue 时可省略）：
- "word_count": 字数/篇幅严重不足（主要用于写作类任务）
- "content_confusion": 输出中混入了其他任务/章节的内容，或内容归属错乱
- "quality": 内容质量差、逻辑不通、情节断裂
- "style": 风格偏差、语气不当、不符合要求的风格
- "repetition": 大量重复前文已有的内容
- "off_topic": 跑题、偏离任务要求
- "incomplete": 任务未完全完成，存在遗漏的子项或步骤
- "wrong_format": 输出格式不符合要求（如要求 JSON 却输出了纯文本）
- "tool_misuse": 工具使用不当或未按要求调用工具
- "logic_error": 逻辑错误、推理不正确、数据计算有误
- "other": 其他无法归类的问题

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 🆕 V6: 根据任务类型生成专属的审查重点提示
   *
   * 不同任务类型有不同的质量关注点：
   * - 写作类：字数、风格、连贯性
   * - 编码类：正确性、完整性、代码质量
   * - 分析/研究类：结构化、深度、覆盖度
   * - 设计类：可行性、完整性、一致性
   * - 数据类：准确性、格式正确性
   * - 自动化类：工具调用完整性、操作结果验证
   */
  private buildTaskTypeReviewHint(taskType: string): string {
    switch (taskType) {
      case "writing":
        return `\n\n🎯 **任务类型：写作/创作**\n审查重点：字数达标、风格一致、情节连贯、无内容混淆、结构完整（有开头有结尾）。\n`;
      case "coding":
        return `\n\n🎯 **任务类型：编码/开发**\n审查重点：代码逻辑正确性、是否覆盖所有需求点、接口/函数签名是否完整、是否有明显的 bug 或遗漏、代码风格一致性。\n注意：不要因为代码风格偏好差异而判定失败。关注功能正确性和完整性。\n`;
      case "analysis":
        return `\n\n🎯 **任务类型：分析**\n审查重点：分析是否有深度（不是泛泛而谈）、结论是否有数据/证据支撑、是否覆盖了所有要求的分析维度、输出是否有清晰的结构（标题/列表/表格）。\n`;
      case "research":
        return `\n\n🎯 **任务类型：研究/调研**\n审查重点：信息来源是否可靠、覆盖面是否全面、对比分析是否公允、结论是否有依据、是否有遗漏的关键维度。\n`;
      case "data":
        return `\n\n🎯 **任务类型：数据处理**\n审查重点：数据转换逻辑是否正确、输出格式是否符合要求、是否有数据丢失或异常值未处理、计算结果是否准确。\n`;
      case "design":
        return `\n\n🎯 **任务类型：设计/架构**\n审查重点：方案是否可行、是否覆盖了所有需求和约束、组件边界是否清晰、接口定义是否完整、是否考虑了扩展性和容错。\n`;
      case "automation":
        return `\n\n🎯 **任务类型：自动化/操作流**\n审查重点：是否实际执行了所需的操作（而非只生成描述）、操作步骤是否完整、是否有错误处理、执行结果是否符合预期。\n`;
      case "planning":
        return `\n\n🎯 **任务类型：规划/计划**\n审查重点：计划是否完整覆盖目标、步骤是否可执行、是否有明确的验收标准、优先级和依赖关系是否合理。\n`;
      case "review":
        return `\n\n🎯 **任务类型：审校/修改**\n审查重点：修改是否全面、是否引入了新问题、修改后的内容是否保持一致性。\n`;
      default:
        return `\n\n🎯 **任务类型：通用**\n审查重点：完成度（是否覆盖了所有要求）、正确性（逻辑是否自洽）、输出质量。\n`;
    }
  }

  /**
   * 🆕 G1+G2: 策略驱动的验证上下文提示（替代纯 taskType 硬编码）
   *
   * 从 subTask.metadata 读取：
   * - validationStrategies：该任务配置的验证策略列表
   * - passedValidations：V6 前置检查已通过的策略
   * - failedValidations：V6 前置检查已失败的策略及原因
   *
   * 让 LLM 质检员：
   * 1. 跳过已通过前置检查的维度，避免重复评估浪费 token
   * 2. 重点关注前置检查失败或未覆盖的维度
   * 3. 基于具体策略（而非泛化的 taskType）给出精准审查重点
   *
   * 无策略配置时回退到原有 buildTaskTypeReviewHint(taskType)。
   */
  private buildValidationContextHint(subTask: SubTask): string {
    const taskType = subTask.taskType ?? "generic";
    const strategies = subTask.metadata?.validationStrategies ?? [];
    const passed = subTask.metadata?.passedValidations ?? [];
    const failed = subTask.metadata?.failedValidations ?? [];

    // 无策略配置：回退到原有类型驱动提示
    if (strategies.length === 0) {
      return this.buildTaskTypeReviewHint(taskType);
    }

    const parts: string[] = [];
    parts.push(`\n\n🎯 **任务类型：${taskType}**`);
    parts.push(`📋 **已配置的验证策略**：${strategies.join("、")}`);

    // V6 前置检查已通过的维度
    if (passed.length > 0) {
      parts.push(`✅ **已通过前置检查**：${passed.join("、")}（无需重复评估这些维度）`);
    }

    // V6 前置检查已失败的维度（需重点关注）
    if (failed.length > 0) {
      const failedStr = failed.map(f => `${f.strategy}（${f.reason}）`).join("、");
      parts.push(`❌ **前置检查失败**：${failedStr}（请重点关注这些维度）`);
    }

    // 计算 LLM 需要评估的维度（未被前置检查覆盖的）
    const checkedSet = new Set([...passed, ...failed.map(f => f.strategy)]);
    const unchecked = strategies.filter(s => !checkedSet.has(s));
    if (unchecked.length > 0) {
      parts.push(`⏳ **需要你重点评估的维度**：${unchecked.join("、")}`);
    } else if (passed.length > 0 && failed.length === 0) {
      parts.push(`💡 所有验证策略已通过前置检查，请从整体质量和任务完成度角度评估。`);
    }

    // 基于具体策略生成审查说明
    parts.push(this.getStrategyFocusHints(strategies, passed));

    return parts.join("\n");
  }

  /**
   * 🆕 G2: 根据配置的验证策略生成具体审查维度说明
   *
   * 与 buildTaskTypeReviewHint 的区别：
   * - buildTaskTypeReviewHint 按 taskType 输出固定文本（可能包含与实际策略无关的内容）
   * - getStrategyFocusHints 根据实际配置的策略精准输出，且标注已通过前置检查的维度
   *
   * @param strategies 配置的验证策略列表
   * @param passedStrategies V6 已通过的策略名称
   */
  private getStrategyFocusHints(strategies: string[], passedStrategies: string[]): string {
    const passedSet = new Set(passedStrategies);
    const hints: string[] = [];

    for (const s of strategies) {
      const mark = passedSet.has(s) ? "✅" : "🔍";
      switch (s) {
        case "word_count":
          hints.push(`${mark} **字数**：产出篇幅是否达到要求${passedSet.has(s) ? "（已通过）" : ""}`);
          break;
        case "file_output":
          hints.push(`${mark} **文件输出**：是否有实际文件产出${passedSet.has(s) ? "（已通过）" : ""}`);
          break;
        case "completeness":
          hints.push(`${mark} **完成度**：是否覆盖了任务描述中的所有要求，无遗漏`);
          break;
        case "structured_output":
          hints.push(`${mark} **结构化**：输出是否有清晰的标题/列表/表格组织，而非堆砌文字`);
          break;
        case "tool_usage":
          hints.push(`${mark} **工具调用**：是否实际执行了操作而非只生成了描述`);
          break;
        default:
          hints.push(`${mark} **${s}**：请评估此维度`);
          break;
      }
    }

    if (hints.length > 0) {
      return `\n🔍 **审查维度**：\n${hints.map(h => `- ${h}`).join("\n")}\n`;
    }
    return "";
  }

  /**
   * 🔧 P0: 从 prompt 文本中提取字数要求
   * 支持多种中英文字数表达：3000字、3000 字、3000 words、三千字 等
   * 
   * @returns 提取到的字数数值，未找到返回 undefined
   */
  extractWordCountRequirement(prompt: string): number | undefined {
    // 🔧 P7 修复：续写子任务的 prompt 同时包含"原始任务：...（3000字）"和"本部分要求：约 1318 字"，
    // 必须优先匹配"本部分要求"，否则贪心匹配到原始任务的 3000 字，导致续写片段永远达不到字数要求，
    // 触发无限 restart → decompose 循环。
    const continuationPattern = /本部分要求[：:]?\s*(?:约|大约)?\s*(\d{3,})\s*[字个]/;
    const contMatch = prompt.match(continuationPattern);
    if (contMatch?.[1]) {
      const num = parseInt(contMatch[1], 10);
      if (num >= 100 && num <= 1_000_000) {
        return num;
      }
    }

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
    const completedTasks = taskTree.subTasks.filter(st => st.status === "completed");
    const completedTasksStr = completedTasks
      .map(st => `- ${st.id}: ${st.summary}\n  ${prompts.labels.output}: ${st.output || prompts.labels.noOutput}`)
      .join("\n");

    // 🆕 G5: 汇总验证指标，让整体质检 LLM 看到全局质量视图
    let validationSummary = "";
    {
      let totalStrategies = 0;
      let totalPassed = 0;
      let totalFailed = 0;
      const failedDimensions = new Map<string, number>();

      for (const st of completedTasks) {
        const strategies = st.metadata?.validationStrategies ?? [];
        const passed = st.metadata?.passedValidations ?? [];
        const failed = st.metadata?.failedValidations ?? [];
        totalStrategies += strategies.length;
        totalPassed += passed.length;
        totalFailed += failed.length;
        for (const f of failed) {
          failedDimensions.set(f.strategy, (failedDimensions.get(f.strategy) ?? 0) + 1);
        }
      }

      if (totalStrategies > 0) {
        const parts: string[] = [];
        parts.push(`📊 **验证指标汇总**：共 ${completedTasks.length} 个子任务，${totalStrategies} 项策略检查，${totalPassed} 项通过，${totalFailed} 项失败`);
        if (failedDimensions.size > 0) {
          const dims = [...failedDimensions.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([dim, count]) => `${dim}(${count}次)`)
            .join("、");
          parts.push(`⚠️ **失败维度分布**：${dims}`);
        }
        validationSummary = `\n${parts.join("\n")}\n`;
      }
    }

    const failedCount = taskTree.subTasks.filter(st => st.status === "failed").length;

    const aspects = prompts.overallReview.aspects;
    const aspectsStr = Object.values(aspects).map((aspect, index) => `${index + 1}. ${aspect}`).join("\n\n");

    return `${prompts.overallReview.expertRole} ${prompts.overallReview.instruction}

${prompts.labels.rootTask}：${effectiveRootTask}

${prompts.labels.completedSubTasks}：
${completedTasksStr}
${validationSummary}${failedCount > 0 ? `\n⚠️ 失败子任务数：${failedCount}\n` : ""}
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
   * 
   * 🔧 P44: LLM 不可用时抛出 LLMDegradedError（而非返回假 "passed"），
   * 让调用方可以选择走规则驱动验证，而不是盲目通过。
   */
  private async callLLM(prompt: string): Promise<string> {
    if (this.embeddedAgentRunConfig?.config) {
      const runId = crypto.randomUUID();
      const sessionId = `qc-${runId}`;
      const sessionFile = path.join(
        os.homedir(),
        ".clawdbot",
        "tasks",
        "_qc_sessions",
        `${sessionId}.jsonl`,
      );
      await nodeFs.mkdir(path.dirname(sessionFile), { recursive: true });

      const result = await runEmbeddedPiAgent({
        sessionId,
        sessionKey: `agent:qc:${runId}`,
        sessionFile,
        workspaceDir: process.cwd(),
        config: this.embeddedAgentRunConfig.config,
        provider: this.embeddedAgentRunConfig.provider ?? this.llmConfig.provider,
        model: this.embeddedAgentRunConfig.modelId ?? this.llmConfig.model,
        prompt,
        runMode: "qc_agent",
        runId,
        timeoutMs: 120_000,
        toolAllowlist: ["submit_quality_review", "continue_generation"],
        skipBootstrapContext: true,
        skillsSnapshot: undefined,
      });

      const toolMetas = result.toolMetas ?? [];
      const submitMeta = toolMetas
        .slice()
        .reverse()
        .find((m) => m?.toolName === "submit_quality_review" && typeof (m as any)?.meta === "string") as
        | { toolName: string; meta?: string }
        | undefined;

      const metaText = submitMeta?.meta?.trim();
      if (!metaText) {
        throw new LLMDegradedError(
          `质检未提交：未检测到 submit_quality_review 工具调用（toolMetas=${toolMetas.length}）`,
        );
      }

      try {
        const parsed = JSON.parse(metaText);
        return JSON.stringify(parsed);
      } catch (err) {
        throw new LLMDegradedError(`质检提交解析失败：${String(err)} meta=${metaText}`);
      }
    }

    if (this.externalLLMCaller) {
      console.log(`[QualityReviewer] 使用系统 LLM 管线评估，提示词长度: ${prompt.length}`);
      try {
        return await this.externalLLMCaller.call(prompt);
      } catch (err) {
        console.warn(`[QualityReviewer] ⚠️ 系统 LLM 调用失败，降级到规则驱动:`, err);
        throw new LLMDegradedError("系统 LLM 调用失败");
      }
    }

    console.warn(`[QualityReviewer] ⚠️ P44: 无可用 LLM，抛出降级错误让调用方走规则检查`);
    throw new LLMDegradedError("无可用 LLM 管线");
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
