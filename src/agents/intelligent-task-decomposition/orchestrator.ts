/**
 * 任务分解协调器
 * 
 * 协调所有组件，实现完整的任务分解流程
 */

import crypto from "node:crypto";
import type { TaskTree, SubTask, TaskTreeChange, QualityReviewResult, TaskBatch, BatchExecutionResult, BatchExecutionOptions, PostProcessResult, Round, RoundStatus, ExecutionContext, CreateDecision, StartDecision, FailureDecision, RoundCompletedResult, DrainScheduleResult } from "./types.js";
import { TaskTreeManager } from "./task-tree-manager.js";
import { RetryManager } from "./retry-manager.js";
import { ErrorHandler } from "./error-handler.js";
import { RecoveryManager } from "./recovery-manager.js";
import { LLMTaskDecomposer } from "./llm-task-decomposer.js";
import { QualityReviewer } from "./quality-reviewer.js";
import { TaskAdjuster } from "./task-adjuster.js";
import { FileManager } from "./file-manager.js";
import { OutputFormatter } from "./output-formatter.js";
import { TaskGrouper, type GroupingOptions } from "./task-grouper.js";
import { BatchExecutor, type LLMCaller } from "./batch-executor.js";
import { DeliveryReporter, type DeliveryReport } from "./delivery-reporter.js";
import { ComplexityScorer } from "./complexity-scorer.js";
import { beginTracking, collectTrackedFiles, clearTracking } from "./file-tracker.js";
import { findParallelGroups } from "./dependency-analyzer.js";
import { createSystemLLMCaller, type SystemLLMCallerConfig } from "./system-llm-caller.js";
import { classifyTaskIntent, type TaskIntentResult } from "./task-intent-classifier.js";
import { deriveExecutionRole, createExecutionContext } from "./execution-context.js";
import type { ClawdbotConfig } from "../../config/config.js";

/**
 * 任务分解协调器
 */
export class Orchestrator {
  private taskTreeManager: TaskTreeManager;
  private retryManager: RetryManager;
  private errorHandler: ErrorHandler;
  private recoveryManager: RecoveryManager;
  private llmDecomposer: LLMTaskDecomposer;
  private qualityReviewer: QualityReviewer;
  private taskAdjuster: TaskAdjuster;
  private fileManager: FileManager | null = null;
  private outputFormatter: OutputFormatter;
  
  // 🆕 批量执行相关组件
  private taskGrouper: TaskGrouper;
  private batchExecutor: BatchExecutor | null = null;
  
  // 🆕 系统 LLM 调用器（用于意图分类等轻量级调用）
  private systemLLMCaller: LLMCaller | null = null;

  // 🆕 A2: 系统配置引用（用于读取 taskDecomposition 默认值）
  private config: ClawdbotConfig | undefined;

  constructor(
    groupingOptions?: GroupingOptions,
    config?: ClawdbotConfig,
  ) {
    this.config = config;
    this.taskTreeManager = new TaskTreeManager();
    this.retryManager = new RetryManager();
    this.errorHandler = new ErrorHandler();
    this.recoveryManager = new RecoveryManager(this.taskTreeManager);
    this.outputFormatter = new OutputFormatter();
    
    // 初始化 LLM 调用器（如有 config 则走系统管线，否则降级到规则驱动）
    const llmConfig = {
      provider: "openai",
      model: "gpt-4",
    };
    let llmCaller: LLMCaller | undefined;
    if (config) {
      try {
        llmCaller = createSystemLLMCaller({ config });
        console.log("[Orchestrator] ✅ 系统 LLM 调用器已初始化（走 auth profiles + completeSimple）");
      } catch (err) {
        console.warn("[Orchestrator] ⚠️ 系统 LLM 调用器初始化失败，降级到规则驱动:", err);
      }
    }
    this.llmDecomposer = new LLMTaskDecomposer(llmConfig, llmCaller);
    this.qualityReviewer = new QualityReviewer(llmConfig, llmCaller);
    this.taskAdjuster = new TaskAdjuster(this.taskTreeManager);
    
    // 初始化批量执行组件
    this.taskGrouper = new TaskGrouper(groupingOptions);
  }

  /**
   * 延迟初始化 LLM 调用能力
   * 
   * 在 Orchestrator 被创建后（如全局单例），可以通过此方法注入 config 以启用真实 LLM 调用。
   * 适用于 config 在构造时尚不可用的场景。
   */
  initializeLLMCaller(config: ClawdbotConfig, provider?: string, modelId?: string): void {
    try {
      const caller = createSystemLLMCaller({ config, provider, modelId });
      this.llmDecomposer.setLLMCaller(caller);
      this.qualityReviewer.setLLMCaller(caller);

      // 🆕 P3: 同时初始化 BatchExecutor（消除 batchExecutor 始终为 null 的问题）
      if (!this.batchExecutor) {
        this.batchExecutor = new BatchExecutor(caller);
        console.log("[Orchestrator] ✅ BatchExecutor 已初始化");
      }

      // 🆕 保存系统 LLM 调用器引用（用于意图分类等轻量级调用）
      this.systemLLMCaller = caller;

      console.log("[Orchestrator] ✅ LLM 调用器已延迟注入（走 auth profiles + completeSimple）");
    } catch (err) {
      console.warn("[Orchestrator] ⚠️ LLM 调用器延迟注入失败:", err);
    }
  }

  /**
   * 评估单个子任务的完成质量
   * 
   * 在 followup-runner 中子任务完成后调用。
   * 如果 LLM caller 未初始化，降级为规则驱动（默认通过）。
   * 
   * @returns 质量评估结果
   */
  async reviewSubTaskCompletion(
    taskTree: TaskTree,
    subTaskId: string,
  ): Promise<QualityReviewResult> {
    try {
      const result = await this.qualityReviewer.reviewSubTaskCompletion(taskTree, subTaskId);
      console.log(
        `[Orchestrator] 📋 子任务 ${subTaskId} 质量评估: status=${result.status}, decision=${result.decision}`,
      );
      return result;
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️ 子任务质量评估失败，默认通过:`, err);
      return {
        status: "passed",
        decision: "continue",
        criteria: [],
        findings: [],
        suggestions: [],
      };
    }
  }

  /**
   * 评估整个轮次的完成质量
   * 
   * 在 followup-runner 中检测到 round completed 后调用。
   * 
   * @returns 质量评估结果
   */
  async reviewRoundCompletion(
    taskTree: TaskTree,
    rootTaskId?: string,
  ): Promise<QualityReviewResult> {
    try {
      // 🆕 V2: 优先从 Round.goal 获取轮次目标，避免跨轮次误判
      const roundGoal = rootTaskId
        ? this.getRoundRootDescription(taskTree, rootTaskId)
        : undefined;
      const result = await this.qualityReviewer.reviewOverallCompletion(taskTree, roundGoal);
      console.log(
        `[Orchestrator] 📋 轮次整体质量评估: status=${result.status}, decision=${result.decision}`,
      );
      return result;
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️ 轮次质量评估失败，默认通过:`, err);
      return {
        status: "passed",
        decision: "continue",
        criteria: [],
        findings: [],
        suggestions: [],
      };
    }
  }

  // ========================================
  // 🆕 P0: 统一后处理路径
  // ========================================

  /**
   * 确保 FileManager 已初始化（延迟初始化）
   * 
   * 当 followup-runner 路径未经过 initializeTaskTree() 时，
   * FileManager 可能为 null。此方法按需创建并初始化。
   */
  private async ensureFileManager(sessionId: string): Promise<FileManager> {
    if (!this.fileManager) {
      this.fileManager = new FileManager(sessionId);
      await this.fileManager.initialize();
      console.log(`[Orchestrator] 📁 FileManager 延迟初始化: ${sessionId}`);
    }
    return this.fileManager;
  }

  /**
   * 子任务完成后的统一后处理流程（P0 核心方法）
   * 
   * 由 followup-runner 在子任务执行完成后调用，统一处理：
   * 1. 质量评估及决策响应（adjust/restart/overthrow）
   * 2. 文件产出验证
   * 3. 文件发送到聊天频道
   * 4. 最终交付产物生成
   * 5. FileManager 持久化（输出/元数据/时间线/执行日志）
   * 
   * 调用方根据返回值决定后续动作：
   * - needsRequeue=true → 重新入队（restart 决策）
   * - markedFailed=true → 停止执行（overthrow 决策）
   * 
   * @param taskTree 任务树
   * @param subTask 已完成的子任务（output/completedAt/status 已设置）
   * @returns PostProcessResult
   */
  async postProcessSubTaskCompletion(
    taskTree: TaskTree,
    subTask: SubTask,
  ): Promise<PostProcessResult> {
    const result: PostProcessResult = {
      decision: "continue",
      status: "passed",
      findings: [],
      suggestions: [],
      needsRequeue: false,
      markedFailed: false,
    };

    // ── 1. 质量评估及决策 ──
    if (taskTree.qualityReviewEnabled !== false) {
      try {
        console.log(`[Orchestrator] 🔍 开始质量评估：${subTask.id}`);

        // 🔧 P5 修复：精确字数前置检查（零 LLM 调用，减轻质检负担）
        // 从 prompt 中提取字数要求，与实际文件内容字数精确比较
        // 🆕 结构性失败分治策略：重试过一次仍不达标 → decompose（而非继续 restart）
        // 🔧 关键修复：subTask.output 是 LLM 的确认消息（如"已创作完成"），不是文件内容。
        // 必须读取 producedFilePaths 中的实际文件来计算字数。
        const wordCountReq = this.qualityReviewer.extractWordCountRequirement(subTask.prompt);
        // 🔧 修复：即使 subTask.output 为空，只要有文件产出也应该检查字数
        // 原因：LLM 可能写了文件但 output 只是空字符串或确认消息
        const hasFileOutput = subTask.metadata?.producedFilePaths && subTask.metadata.producedFilePaths.length > 0;
        if (wordCountReq && (subTask.output || hasFileOutput)) {
          // 优先用文件内容计算字数，回退到 output 长度
          let actualLength = (subTask.output ?? "").length;
          const producedPaths = subTask.metadata?.producedFilePaths;
          if (producedPaths && producedPaths.length > 0) {
            try {
              const fs = await import("node:fs/promises");
              let totalFileChars = 0;
              for (const filePath of producedPaths) {
                try {
                  const content = await fs.readFile(filePath, "utf-8");
                  totalFileChars += content.length;
                } catch {
                  // 文件不存在或无法读取，跳过
                }
              }
              if (totalFileChars > 0) {
                actualLength = totalFileChars;
                console.log(
                  `[Orchestrator] 📏 字数检查使用文件内容: ${producedPaths.length} 个文件, 共 ${totalFileChars} 字符`,
                );
              }
            } catch {
              // import 失败，回退到 output 长度
            }
          }
          const threshold = Math.floor(wordCountReq * 0.3); // 30% 硬性底线
          if (actualLength < threshold) {
            const currentRetry = subTask.retryCount ?? 0;

            // 🆕 分治策略：已重试过至少 1 次且仍不达标 → 结构性失败，转 decompose
            // 保留已有输出作为第一部分，创建续写子任务逐步积累
            if (currentRetry >= 1) {
              console.log(
                `[Orchestrator] 🔧 字数前置检查：已重试 ${currentRetry} 次仍不达标（${actualLength}/${wordCountReq}），` +
                `转为 decompose 增量分解策略`,
              );
              try {
                const newSubTasks = await this.decomposeFailedTask(taskTree, subTask);
                if (newSubTasks.length > 0) {
                  result.decision = "decompose";
                  result.decomposedTaskIds = newSubTasks.map(t => t.id);
                  result.findings = [
                    `字数结构性不达标（${actualLength}/${wordCountReq}，${Math.round(actualLength / wordCountReq * 100)}%），` +
                    `已重试 ${currentRetry} 次无改善，转为增量分解：保留已有 ${actualLength} 字 + 创建 ${newSubTasks.length} 个续写子任务`,
                  ];
                  await this.taskTreeManager.save(taskTree);
                  return result;
                }
              } catch (decompErr) {
                console.warn(`[Orchestrator] ⚠️ decomposeFailedTask 失败，回退到 restart: ${decompErr}`);
              }
            }

            // 首次不达标或 decompose 失败 → 正常 restart
            console.warn(
              `[Orchestrator] ⚠️ P5 精确字数前置检查：要求 ${wordCountReq} 字，实际 ${actualLength} 字（< 30% 底线 ${threshold}），restart`,
            );
            if (currentRetry < 3) {
              // 🆕 A1: 迭代优化 — 保存上次输出和失败原因
              if (!subTask.metadata) subTask.metadata = {};
              if (subTask.output && subTask.output.length > 0) {
                subTask.metadata.previousOutput = subTask.output.length > 3000
                  ? subTask.output.substring(0, 3000)
                  : subTask.output;
              }
              subTask.metadata.lastFailureFindings = [`字数不达标：要求 ${wordCountReq} 字，实际 ${actualLength} 字（${Math.round(actualLength / wordCountReq * 100)}%）`];
              await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "pending");
              subTask.retryCount = currentRetry + 1;
              result.decision = "restart";
              result.needsRequeue = true;
              result.findings = [`精确字数前置检查不达标：要求 ${wordCountReq} 字，实际 ${actualLength} 字（${Math.round(actualLength / wordCountReq * 100)}%）`];
              await this.taskTreeManager.save(taskTree);
              return result;
            }
            // 重试耗尽且 decompose 也失败了，降级为 overthrow
            await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "failed");
            subTask.error = `字数前置检查重试耗尽：要求 ${wordCountReq} 字，实际 ${actualLength} 字`;
            result.decision = "overthrow";
            result.markedFailed = true;
            await this.taskTreeManager.save(taskTree);
            return result;
          }
          console.log(
            `[Orchestrator] ✅ P5 精确字数前置检查通过：要求 ${wordCountReq} 字，实际 ${actualLength} 字（${Math.round(actualLength / wordCountReq * 100)}%）`,
          );
        } // end if (wordCountReq && subTask.output)

        // 🔧 LLM 质检：使用子任务所属轮次的实际根任务描述
        // 质检 LLM 现在能看到实际文件内容（在 reviewSubTaskCompletion 中读取并注入）
        const roundRootDesc = subTask.rootTaskId
          ? this.getRoundRootDescription(taskTree, subTask.rootTaskId)
          : undefined;
        const review = await this.qualityReviewer.reviewSubTaskCompletion(
          taskTree,
          subTask.id,
          roundRootDesc,
        );

        result.decision = review.decision;
        result.status = review.status;
        result.findings = review.findings;
        result.suggestions = review.suggestions;

        // 记录到子任务元数据
        if (!subTask.metadata) subTask.metadata = {};
        subTask.metadata.qualityReview = {
          status: review.status,
          decision: review.decision,
          findings: review.findings,
          suggestions: review.suggestions,
        };

        switch (review.decision) {
          case "continue":
            console.log(`[Orchestrator] ✅ 质量评估通过`);
            break;

          case "adjust":
            console.log(`[Orchestrator] ⚠️ 质量需要调整`);
            if (review.modifications && review.modifications.length > 0) {
              const beforeIds = new Set(taskTree.subTasks.map(t => t.id));
              await this.adjustTaskTree(taskTree, review.modifications, false);
              const newIds = taskTree.subTasks
                .filter(t => !beforeIds.has(t.id) && t.status === "pending")
                .map(t => t.id);
              if (newIds.length > 0) {
                result.newTaskIds = newIds;
                console.log(`[Orchestrator] 🆕 adjust 新增了 ${newIds.length} 个子任务: ${newIds.join(", ")}`);
              }
            }
            break;

          case "restart": {
            const maxQualityRestarts = this.getDefaultMaxRetries();
            const currentRetry = subTask.retryCount ?? 0;
            if (currentRetry >= maxQualityRestarts) {
              // 分治策略：重试超限时，先尝试 decompose
              const wcReq = this.qualityReviewer.extractWordCountRequirement(subTask.prompt);
              if (wcReq && subTask.output && subTask.output.length > 0) {
                console.log(
                  `[Orchestrator] 🔧 restart 超限 (${currentRetry}/${maxQualityRestarts})，尝试 decompose`,
                );
                try {
                  subTask.status = "completed";
                  const newSubTasks = await this.decomposeFailedTask(taskTree, subTask);
                  if (newSubTasks.length > 0) {
                    result.decision = "decompose";
                    result.decomposedTaskIds = newSubTasks.map(t => t.id);
                    result.findings = [
                      `质量重试超限 (${currentRetry}/${maxQualityRestarts})，转为增量分解：` +
                      `创建 ${newSubTasks.length} 个续写子任务。原因：${review.findings.join("; ")}`,
                    ];
                    await this.taskTreeManager.save(taskTree);
                    break;
                  }
                } catch (decompErr) {
                  console.warn(`[Orchestrator] ⚠️ decompose 失败，降级为 overthrow: ${decompErr}`);
                }
              }

              console.warn(
                `[Orchestrator] ⚠️ 子任务 ${subTask.id} 已重试 ${currentRetry} 次（上限 ${maxQualityRestarts}），降级为 overthrow`,
              );
              await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "failed");
              subTask.error = `质量重试超限 (${currentRetry}/${maxQualityRestarts})：${review.findings.join("; ")}`;
              result.decision = "overthrow";
              result.markedFailed = true;
            } else {
              console.log(`[Orchestrator] 🔄 质量不满意，重新执行 (${currentRetry + 1}/${maxQualityRestarts})`);
              if (!subTask.metadata) subTask.metadata = {};
              if (subTask.output && subTask.output.length > 0) {
                subTask.metadata.previousOutput = subTask.output.length > 3000
                  ? subTask.output.substring(0, 3000)
                  : subTask.output;
              }
              if (review.findings && review.findings.length > 0) {
                subTask.metadata.lastFailureFindings = review.findings;
              }
              await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "pending");
              subTask.retryCount = currentRetry + 1;
              result.needsRequeue = true;
            }
            break;
          }

          case "overthrow": {
            const overthrowCount = (subTask.metadata?.overthrowCount ?? 0) + 1;
            if (!subTask.metadata) subTask.metadata = {};
            subTask.metadata.overthrowCount = overthrowCount;

            if (overthrowCount <= 1) {
              console.log(
                `[Orchestrator] ⚠️ 质量严重不满意（第 ${overthrowCount} 次），降级为 restart`,
              );
              await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "pending");
              subTask.retryCount = (subTask.retryCount ?? 0) + 1;
              subTask.error = `质量评估 overthrow → 降级 restart (${overthrowCount}/2)：${review.findings.join("; ")}`;
              result.decision = "restart";
              result.needsRequeue = true;
            } else {
              console.log(`[Orchestrator] ❌ 质量连续 ${overthrowCount} 次严重不满意，标记失败`);
              await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "failed");
              subTask.error = `质量评估连续 overthrow (${overthrowCount} 次)：${review.findings.join("; ")}`;
              result.markedFailed = true;
            }
            break;
          }
        }
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️ 子任务质量评估失败，默认通过:`, err);
      }
    }

    // 如果决策是 restart 或 overthrow，跳过后续处理
    if (result.needsRequeue || result.markedFailed) {
      // 🔧 P3 修复：overthrow/failed 时更新 failedTasks 计数
      if (result.markedFailed && taskTree.metadata) {
        taskTree.metadata.failedTasks = taskTree.subTasks.filter(t => t.status === "failed").length;
      }
      await this.taskTreeManager.save(taskTree);
      return result;
    }

    // 🔧 P3 修复：任务完成时更新 completedTasks 计数
    if (taskTree.metadata) {
      taskTree.metadata.completedTasks = taskTree.subTasks.filter(t => t.status === "completed").length;
      taskTree.metadata.failedTasks = taskTree.subTasks.filter(t => t.status === "failed").length;
    }

    // ── 2. 验证文件产出（针对写作任务） ──
    if (subTask.metadata?.requiresFileOutput) {
      const hasFileOutput = await this.verifyFileOutput(taskTree, subTask);
      if (hasFileOutput) {
        // ── 3. 发送子任务的文件到聊天频道 ──
        await this.sendSubTaskFiles(taskTree, subTask);
      } else {
        console.warn(`[Orchestrator] ⚠️ 任务完成但未产生文件输出: ${subTask.id}`);
      }
    }

    // ── 4. 如果是根任务（汇总任务），生成最终交付产物 ──
    if (subTask.metadata?.isRootTask && subTask.metadata?.isSummaryTask) {
      try {
        const deliverablePath = await this.generateFinalDeliverable(taskTree, subTask);
        console.log(`[Orchestrator] ✅ 根任务汇总完成，最终产物：${deliverablePath}`);

        if (subTask.metadata?.requiresFileOutput && this.fileManager) {
          const mergedFilePath = await this.fileManager.mergeTaskOutputs(taskTree);
          await this.sendFileToChannel(mergedFilePath, `完整输出：${taskTree.rootTask}`);
          console.log(`[Orchestrator] ✅ 已发送完整文件到聊天频道`);
        }

        taskTree.status = "completed";
        await this.taskTreeManager.save(taskTree);
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️ 生成最终交付产物失败`, err);
      }
    }

    // ── 5. 如果是汇总任务（waitForChildren=true），生成最终交付产物 ──
    if (subTask.waitForChildren && subTask.children && subTask.children.length > 0) {
      try {
        const deliverablePath = await this.generateFinalDeliverable(taskTree, subTask);
        console.log(`[Orchestrator] ✅ 汇总任务完成，最终产物：${deliverablePath}`);

        if (subTask.metadata?.requiresFileOutput && this.fileManager) {
          const mergedFilePath = await this.fileManager.mergeTaskOutputs(taskTree);
          await this.sendFileToChannel(mergedFilePath, `完整输出：${subTask.summary}`);
          console.log(`[Orchestrator] ✅ 已发送完整文件到聊天频道`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️ 生成汇总交付产物失败`, err);
      }
    }

    // ── 6. 保存任务输出到文件系统 ──
    try {
      const fm = await this.ensureFileManager(taskTree.id);
      const outputPath = await fm.saveTaskOutput(
        subTask.id,
        subTask.output || "",
        "txt",
      );
      await fm.saveTaskMetadata(subTask);
      await fm.recordTimelineEvent(
        "task_completed",
        subTask.id,
        `任务完成：${subTask.summary}`,
      );
      await fm.logExecution(
        `Task ${subTask.id} completed: ${subTask.summary}`,
      );
      console.log(`[Orchestrator] 💾 Task output saved to: ${outputPath}`);
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️ 保存任务输出到文件系统失败:`, err);
    }

    // ── 7. 保存任务树 ──
    await this.taskTreeManager.save(taskTree);

    return result;
  }

  /**
   * 初始化任务树
   */
  async initializeTaskTree(rootTask: string, sessionId: string): Promise<TaskTree> {
    const taskTree = await this.taskTreeManager.initialize(rootTask, sessionId);
    
    // 🆕 V2: 初始化 rounds 数组（确保后续 Round CRUD 操作无需判空）
    if (!taskTree.rounds) {
      taskTree.rounds = [];
    }
    
    // 🆕 初始化文件管理器
    this.fileManager = new FileManager(sessionId);
    await this.fileManager.initialize();
    
    // 🆕 记录时间线事件
    await this.fileManager.recordTimelineEvent(
      "task_created",
      sessionId,
      `创建任务树：${rootTask}`
    );
    
    // 🆕 计算并记录复杂度评分
    const scorer = new ComplexityScorer();
    const score = scorer.calculateScore(taskTree);
    
    // 记录到任务树元数据
    if (!taskTree.metadata) {
      taskTree.metadata = {
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
      };
    }
    taskTree.metadata.complexityScore = score.total;
    taskTree.metadata.calculatedMaxDepth = score.recommendedMaxDepth;
    taskTree.metadata.scoreDimensions = score.dimensions;
    
    console.log(`[Orchestrator] 📊 任务树复杂度评分已记录: ${score.total}/100, maxDepth=${score.recommendedMaxDepth}`);
    
    return taskTree;
  }

  /**
   * 添加子任务到任务树
   * 
   * @param taskTree 任务树
   * @param prompt 任务提示词
   * @param summary 任务简短描述
   * @param parentId 父任务 ID（可选）
   * @param waitForChildren 是否等待子任务完成（可选）
   * @param rootTaskId 轮次 ID（可选），用于隔离不同用户请求产生的子任务
   * @returns 新创建的子任务
   */
  async addSubTask(
    taskTree: TaskTree,
    prompt: string,
    summary: string,
    parentId?: string,
    waitForChildren?: boolean,
    rootTaskId?: string,
  ): Promise<SubTask> {
    const subTask: SubTask = {
      id: crypto.randomUUID(),
      prompt,
      summary,
      status: "pending",
      retryCount: 0,
      createdAt: Date.now(),
      parentId: parentId || null,
      children: [],
      waitForChildren: waitForChildren,
      depth: 0,
      rootTaskId,                           // 🆕 轮次隔离 ID
      roundId: rootTaskId,                   // 🆕 V2: 与 Round.id 关联（过渡期与 rootTaskId 相同）
    };

    // 🆕 V2: 将子任务关联到 Round（如果存在）
    if (rootTaskId) {
      const round = this.findRound(taskTree, rootTaskId);
      if (round) {
        round.subTaskIds.push(subTask.id);
      }
    }

    // 🆕 计算任务深度
    if (parentId) {
      const parentTask = taskTree.subTasks.find(t => t.id === parentId);
      if (parentTask) {
        subTask.depth = (parentTask.depth || 0) + 1;
        
        // 🆕 将当前任务添加到父任务的子任务列表
        if (!parentTask.children) {
          parentTask.children = [];
        }
        parentTask.children.push(subTask);
      }
    }

    taskTree.subTasks.push(subTask);

    // 🔧 P3 修复：维护 metadata 计数器
    if (taskTree.metadata) {
      taskTree.metadata.totalTasks = taskTree.subTasks.length;
    }

    // 🔧 不变量守卫：tree 状态与新子任务的关系
    // - completed → active：新轮次开始，正常重置
    // - failed → active：仅当新子任务属于不同轮次（新 rootTaskId）时重置
    //   防止：同轮次 overthrow 后，LLM 继续添加错误子任务导致失败树"复活"
    if (taskTree.status === "completed") {
      console.log(`[Orchestrator] 🔄 Tree status reset: completed → active (new pending sub-task added)`);
      taskTree.status = "active";
    } else if (taskTree.status === "failed") {
      // 收集当前失败轮次的 rootTaskId 集合
      const failedRoundIds = new Set(
        taskTree.subTasks
          .filter(t => t.status === "failed")
          .map(t => t.rootTaskId)
          .filter((id): id is string => Boolean(id)),
      );
      const isNewRound = rootTaskId && !failedRoundIds.has(rootTaskId);
      if (isNewRound) {
        console.log(`[Orchestrator] 🔄 Tree status reset: failed → active (new round: ${rootTaskId})`);
        taskTree.status = "active";
      } else {
        console.warn(`[Orchestrator] ⚠️ Tree is failed (round ${rootTaskId ?? "unknown"}), new sub-task will NOT reset status`);
      }
    }

    await this.taskTreeManager.save(taskTree);

    console.log(`[Orchestrator] ✅ Sub task added: ${subTask.id} (${summary}) [depth=${subTask.depth}, parent=${parentId || 'none'}]`);
    return subTask;
  }

  /**
   * 执行子任务
   */
  async executeSubTask(
    taskTree: TaskTree,
    subTask: SubTask,
    executor: () => Promise<string>,
  ): Promise<void> {
    try {
      // 更新状态为 "active"
      await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "active");

      // 创建检查点
      await this.taskTreeManager.createCheckpoint(taskTree);

      // 🔧 开始文件追踪（在任务执行前启动，收集 write 工具的文件产出）
      beginTracking(subTask.id);

      // 执行任务（带重试）
      const output = await this.retryManager.executeWithRetry(
        subTask,
        executor,
        3, // 最多重试 3 次
      );

      // 更新输出和状态
      subTask.output = output;
      subTask.completedAt = Date.now();
      await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "completed");

      // 🔧 收集文件追踪结果，写入 metadata.producedFiles
      const trackedFiles = collectTrackedFiles(subTask.id);
      if (trackedFiles.length > 0) {
        if (!subTask.metadata) {
          subTask.metadata = {};
        }
        subTask.metadata.producedFiles = trackedFiles.map(f => f.fileName);
        // 🆕 同时保存完整的文件路径映射（用于 mergeTaskOutputs 精准定位）
        subTask.metadata.producedFilePaths = trackedFiles.map(f => f.filePath);
        console.log(
          `[Orchestrator] 📂 收集到 ${trackedFiles.length} 个文件产出: ` +
          trackedFiles.map(f => f.fileName).join(", ")
        );
      }

      // 🔧 P0: 统一后处理（质量评估 + 文件验证 + 交付产物 + 持久化）
      const postResult = await this.postProcessSubTaskCompletion(taskTree, subTask);

      // 将 postProcess 的决策转换为 executeSubTask 的 throw 行为（保持向后兼容）
      if (postResult.needsRequeue) {
        throw new Error(`质量评估不通过，需要重新执行：${postResult.findings.join("; ")}`);
      }
      if (postResult.markedFailed) {
        throw new Error(`质量评估严重不通过：${postResult.findings.join("; ")}`);
      }

      console.log(`[Orchestrator] ✅ Sub task completed: ${subTask.id}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // 更新错误信息和状态
      subTask.error = error.message;
      subTask.retryCount = (subTask.retryCount ?? 0) + 1;
      await this.taskTreeManager.updateSubTaskStatus(taskTree, subTask.id, "failed");

      // 🆕 记录失败到文件系统
      if (this.fileManager) {
        await this.fileManager.logFailure(subTask.id, error.message);
        await this.fileManager.recordTimelineEvent(
          "task_failed",
          subTask.id,
          `任务失败：${subTask.summary} - ${error.message}`
        );
      }

      // 记录失败日志
      await this.retryManager.logFailure(subTask, error, taskTree.id);

      // 处理错误
      await this.errorHandler.handleError(
        error,
        {
          taskTreeId: taskTree.id,
          subTaskId: subTask.id,
          subTaskSummary: subTask.summary,
        },
        taskTree.id,
      );

      // 🔧 异常时清理文件追踪
      clearTracking(subTask.id);

      console.error(`[Orchestrator] ❌ Sub task failed: ${subTask.id} - ${error.message}`);
      throw error;
    }
  }

  /**
   * 检查是否有未完成的任务
   */
  async hasUnfinishedTasks(sessionId: string): Promise<boolean> {
    return await this.recoveryManager.hasUnfinishedTasks(sessionId);
  }

  /**
   * 恢复未完成的任务
   */
  async recoverUnfinishedTasks(sessionId: string): Promise<TaskTree> {
    return await this.recoveryManager.recoverUnfinishedTasks(sessionId);
  }

  /**
   * 重新执行中断的任务
   */
  async reexecuteInterruptedTasks(taskTree: TaskTree): Promise<SubTask[]> {
    const interruptedTasks = this.recoveryManager.identifyInterruptedTasks(taskTree);
    await this.recoveryManager.reexecuteInterruptedTasks(taskTree, interruptedTasks);
    return interruptedTasks;
  }

  // ========================================
  // 🆕 任务意图分类与旧任务归档
  // ========================================

  /**
   * 分类用户消息意图：新任务 / 续接旧任务 / 调整旧任务
   * 
   * 在 agent-runner 中 LLM 被调用之前执行，用于决定是否归档旧任务树。
   * 流程：规则预分类（免 LLM）→ LLM 分类（必要时）→ 降级 new_task（失败时）
   * 
   * @param userMessage 用户新消息
   * @param sessionId 当前 session ID
   * @returns 意图分类结果，如果无旧任务树则返回 null
   */
  async classifyUserIntent(
    userMessage: string,
    sessionId: string,
  ): Promise<TaskIntentResult | null> {
    const taskTree = await this.taskTreeManager.load(sessionId);
    if (!taskTree) {
      return null; // 无旧任务树，无需分类
    }

    return await classifyTaskIntent(userMessage, taskTree, this.systemLLMCaller);
  }

  /**
   * 归档旧任务树（标记为 completed/abandoned）
   * 
   * 当意图分类为 new_task 时调用，确保旧任务树不会污染新任务。
   * 
   * @param sessionId session ID
   * @param reason 归档原因
   */
  async archiveTaskTree(sessionId: string, reason: string): Promise<void> {
    const taskTree = await this.taskTreeManager.load(sessionId);
    if (!taskTree) return;

    // 将所有未终结的子任务标记为 completed（abandoned）
    for (const subTask of taskTree.subTasks) {
      if (subTask.status === "pending" || subTask.status === "active" || subTask.status === "interrupted") {
        subTask.status = "completed";
        subTask.output = `[自动归档] ${reason}`;
        subTask.completedAt = Date.now();
      }
    }

    // 标记任务树为 completed
    taskTree.status = "completed";

    await this.taskTreeManager.save(taskTree);
    console.log(`[Orchestrator] 📦 旧任务树已归档：${sessionId}（原因：${reason}）`);
  }

  /**
   * 加载任务树
   */
  async loadTaskTree(sessionId: string): Promise<TaskTree | null> {
    return await this.taskTreeManager.load(sessionId);
  }

  /**
   * 保存任务树
   */
  async saveTaskTree(taskTree: TaskTree): Promise<void> {
    await this.taskTreeManager.save(taskTree);
  }

  /**
   * 🔧 P7: 更新子任务状态（公共代理方法）
   * 
   * 统一状态转换入口，确保 taskTreeManager 内部的验证和副作用生效。
   * followup-runner 应通过此方法而非直接赋值 subTask.status。
   */
  async updateSubTaskStatus(
    taskTree: TaskTree,
    subTaskId: string,
    status: SubTask["status"],
  ): Promise<void> {
    await this.taskTreeManager.updateSubTaskStatus(taskTree, subTaskId, status);
  }

  /**
   * P2: 判断子任务是否应该自动递归分解
   * 
   * 轻量级前置检查，避免不必要的 LLM 调用。
   * 条件全部满足时返回 true：
   * - 未被分解过
   * - 深度未超过限制
   * - Prompt 长度超过阈值（复杂度启发式）
   * 
   * @param taskTree 任务树
   * @param subTask 待检查的子任务
   * @returns 是否应该自动分解
   */
  shouldAutoDecompose(taskTree: TaskTree, subTask: SubTask): boolean {
    if (subTask.decomposed) return false;
    const maxDepth = taskTree.maxDepth ?? 3;
    if ((subTask.depth ?? 0) >= maxDepth) return false;
    
    // 🔧 多维度启发式判断（替代单一的 prompt 长度阈值）
    const prompt = subTask.prompt;
    const promptLen = prompt.length;
    
    // 维度 1：prompt 长度（基础信号）
    const isLongPrompt = promptLen > 800;
    
    // 维度 2：量化指标检测（字数要求 > 5000 字的任务值得分解）
    const wordCountMatch = prompt.match(/(\d{4,})\s*[字个]/);
    const hasLargeWordCount = wordCountMatch ? parseInt(wordCountMatch[1], 10) >= 5000 : false;
    
    // 维度 3：多步骤信号（包含列表、编号、"步骤"等关键词）
    const multiStepSignals = [
      /(?:第[一二三四五六七八九十\d]+[章节步]|step\s*\d)/i,
      /(?:\d+[\.\)]\s*\S)/,  // 编号列表
      /(?:首先|其次|然后|最后|接着)/,
      /(?:分别|依次|逐一)/,
    ];
    const hasMultiStepSignals = multiStepSignals.filter(p => p.test(prompt)).length >= 2;
    
    // 综合判断：至少满足 2 个维度
    const score = (isLongPrompt ? 1 : 0) + (hasLargeWordCount ? 1 : 0) + (hasMultiStepSignals ? 1 : 0);
    const shouldDecompose = score >= 1 && (isLongPrompt || hasLargeWordCount);
    
    if (shouldDecompose) {
      console.log(
        `[Orchestrator] 📊 P2: 子任务 ${subTask.id} prompt=${promptLen} 字符, ` +
        `depth=${subTask.depth ?? 0}/${maxDepth}, ` +
        `signals=[long=${isLongPrompt}, wordCount=${hasLargeWordCount}, multiStep=${hasMultiStepSignals}] → 推荐自动分解`,
      );
    }
    return shouldDecompose;
  }

  /**
   * 合并轮次的所有子任务输出（P4: 统一合并逻辑）
   * 
   * 使用 FileManager.mergeTaskOutputs() 的多策略合并
   * （producedFilePaths → artifacts → output.txt），
   * 替代 followup-runner 中的简单文本拼接。
   * 
   * @param taskTree 任务树
   * @param roundId 轮次 ID（可选，指定时只合并该轮次的子任务）
   * @returns 合并后的文件路径
   */
  async mergeRoundOutputs(taskTree: TaskTree, roundId?: string): Promise<string> {
    const fm = await this.ensureFileManager(taskTree.id);
    return await fm.mergeTaskOutputs(taskTree, roundId);
  }

  // ========================================
  // 🆕 V2: Round CRUD — 轮次一等公民管理
  // ========================================

  /**
   * 创建新的 Round 并添加到任务树
   * 
   * @param taskTree 任务树
   * @param goal 轮次目标（用户原始 prompt 或摘要）
   * @param roundId 轮次 ID（通常与 rootTaskId 相同，保持向后兼容）
   * @returns 新创建的 Round
   */
  createRound(taskTree: TaskTree, goal: string, roundId: string, llmCallBudget?: number): Round {
      // 🆕 A2: 优先级：用户指定 > 系统配置 > 硬编码默认值
      // 🔧 修复：LLM 传入的预算不能低于系统默认值的最低保障
      // 原因：LLM 可能传入极小的值（如 10），导致熔断器过早触发
      const systemDefault = this.getDefaultLLMBudget();
      const MIN_BUDGET = Math.max(30, Math.floor(systemDefault * 0.5)); // 最低保障：系统默认值的 50% 或 30
      const effectiveBudget = llmCallBudget !== undefined
        ? Math.max(llmCallBudget, MIN_BUDGET)
        : systemDefault;
      const round: Round = {
        id: roundId,
        goal,
        status: "active",
        subTaskIds: [],
        createdAt: Date.now(),
        hasOverthrow: false,
        // 🆕 A2: 初始化熔断器（LLM 请求预算）
        circuitBreaker: {
          totalFailures: 0,
          totalTokensUsed: 0,
          llmCallCount: 0,
          llmCallBudget: effectiveBudget,
          tripped: false,
        },
      };

      if (!taskTree.rounds) {
        taskTree.rounds = [];
      }
      taskTree.rounds.push(round);
      console.log(`[Orchestrator] 🆕 Round created: ${roundId} (goal: ${goal.substring(0, 80)}, budget: ${effectiveBudget}${llmCallBudget !== undefined && llmCallBudget < MIN_BUDGET ? ` [LLM requested ${llmCallBudget}, raised to min ${MIN_BUDGET}]` : ""})`);
      return round;
    }

  /**
   * 通过 ID 查找 Round（向后兼容：支持 rootTaskId 查找）
   * 
   * @param taskTree 任务树
   * @param roundId 轮次 ID（等价于旧的 rootTaskId）
   * @returns Round 对象，未找到时返回 undefined
   */
  findRound(taskTree: TaskTree, roundId: string): Round | undefined {
    return taskTree.rounds?.find((r) => r.id === roundId);
  }

  /**
   * 获取或创建 Round（幂等操作）
   * 
   * 如果 Round 已存在则返回，否则创建新的。
   * 用于 enqueue-task-tool 中确保每个 rootTaskId 都有对应的 Round。
   * 
   * @param taskTree 任务树
   * @param roundId 轮次 ID
   * @param goal 轮次目标（仅在创建时使用）
   * @returns Round 对象
   */
  getOrCreateRound(taskTree: TaskTree, roundId: string, goal: string, llmCallBudget?: number): Round {
    const existing = this.findRound(taskTree, roundId);
    if (existing) {
      // 🔧 修复：只允许提高预算，不允许降低
      // 原因：LLM 在创建多个子任务时，每个子任务都可能传不同的 llmBudget。
      // 最后一个子任务（如合并任务）可能传很小的值（如 10），覆盖了之前的合理预算（如 50）。
      // 正确行为：取所有子任务传入的最大值。
      if (llmCallBudget !== undefined && existing.circuitBreaker) {
        if (llmCallBudget > existing.circuitBreaker.llmCallBudget) {
          console.log(
            `[Orchestrator] 📈 Round ${roundId} 预算提升: ${existing.circuitBreaker.llmCallBudget} → ${llmCallBudget}`,
          );
          existing.circuitBreaker.llmCallBudget = llmCallBudget;
        }
        // 如果新值更小，忽略（不降级）
      }
      return existing;
    }
    return this.createRound(taskTree, goal, roundId, llmCallBudget);
  }

  /**
   * 获取当前活跃的 Round
   * 
   * @param taskTree 任务树
   * @returns 最新的 active Round，无则返回 undefined
   */
  getActiveRound(taskTree: TaskTree): Round | undefined {
    return taskTree.rounds
      ?.filter((r) => r.status === "active")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /**
   * 🆕 A2: 递增 Round 的 LLM 调用计数，并检查是否触发熔断
   * 
   * @returns true 如果已熔断（应停止后续任务），false 如果正常
   */
  incrementLLMCallCount(taskTree: TaskTree, roundId: string, count: number = 1): boolean {
    const round = this.findRound(taskTree, roundId);
    if (!round) return false;

    if (!round.circuitBreaker) {
      round.circuitBreaker = {
        totalFailures: 0,
        totalTokensUsed: 0,
        llmCallCount: 0,
        llmCallBudget: this.getDefaultLLMBudget(),
        tripped: false,
      };
    }

    round.circuitBreaker.llmCallCount += count;

    // 检查是否超过预算
    if (round.circuitBreaker.llmCallCount >= round.circuitBreaker.llmCallBudget && !round.circuitBreaker.tripped) {
      round.circuitBreaker.tripped = true;
      round.circuitBreaker.tripReason = 
        `LLM 调用次数 (${round.circuitBreaker.llmCallCount}) 达到预算上限 (${round.circuitBreaker.llmCallBudget})`;
      console.warn(
        `[Orchestrator] 🔌 熔断器触发: Round ${roundId} — ${round.circuitBreaker.tripReason}`,
      );
      return true;
    }

    return round.circuitBreaker.tripped;
  }

  /**
   * 🆕 A2: 检查 Round 的熔断器是否已触发
   */
  isRoundTripped(taskTree: TaskTree, roundId: string): boolean {
    const round = this.findRound(taskTree, roundId);
    return round?.circuitBreaker?.tripped ?? false;
  }

  /**
   * 🆕 A2: 设置 Round 的 LLM 调用预算
   */
  setRoundBudget(taskTree: TaskTree, roundId: string, budget: number): void {
    const round = this.findRound(taskTree, roundId);
    if (!round) return;
    if (!round.circuitBreaker) {
      round.circuitBreaker = {
        totalFailures: 0,
        totalTokensUsed: 0,
        llmCallCount: 0,
        llmCallBudget: budget,
        tripped: false,
      };
    } else {
      round.circuitBreaker.llmCallBudget = budget;
    }
    console.log(`[Orchestrator] 📊 Round ${roundId} LLM budget set to ${budget}`);
  }

  /**
   * 🆕 A2: 从系统配置中读取默认 LLM 调用预算
   * 优先级：用户指定 > 系统配置 > 硬编码默认值 100
   */
  getDefaultLLMBudget(): number {
    return this.config?.agents?.defaults?.taskDecomposition?.llmCallBudget ?? 600;
  }

  /**
   * 🆕 A2: 从系统配置中读取默认最大重试次数
   */
  getDefaultMaxRetries(): number {
    return this.config?.agents?.defaults?.taskDecomposition?.maxRetries ?? 3;
  }

  /**
   * 🆕 A2: 更新配置引用（当 config 在运行时变化时调用）
   */
  updateConfig(config: ClawdbotConfig): void {
    this.config = config;
  }

  /**
   * 更新 Round 状态（FSM 转换）
   * 
   * @param taskTree 任务树
   * @param roundId 轮次 ID
   * @param newStatus 新状态
   */
  updateRoundStatus(taskTree: TaskTree, roundId: string, newStatus: RoundStatus): void {
    const round = this.findRound(taskTree, roundId);
    if (!round) return;
    
    const oldStatus = round.status;
    round.status = newStatus;
    if (newStatus === "completed" || newStatus === "failed" || newStatus === "cancelled") {
      round.completedAt = Date.now();
    }
    console.log(`[Orchestrator] 🔄 Round ${roundId} status: ${oldStatus} → ${newStatus}`);
  }

  // ========================================
  // 🆕 轮次隔离：集中式完成判定
  // ========================================

  /**
   * 获取指定轮次的实际根任务描述
   * 
   * 从该轮次最早创建的子任务的 summary/prompt 中提取任务目标。
   * 当 taskTree.rootTask 已过期（例如用户在同一 session 中发了新任务）时，
   * 质量评审应使用此方法获取的描述，而非全局 taskTree.rootTask。
   * 
   * @param taskTree 任务树
   * @param rootTaskId 轮次 ID
   * @returns 该轮次的根任务描述，未找到时返回 taskTree.rootTask
   */
  getRoundRootDescription(taskTree: TaskTree, rootTaskId: string): string {
    // 🆕 V2: 优先从 Round.goal 获取（显式数据，最可靠）
    const round = this.findRound(taskTree, rootTaskId);
    if (round?.goal) {
      return round.goal;
    }

    // 向后兼容：无 Round 对象时回退到旧的启发式逻辑
    const roundTasks = taskTree.subTasks
      .filter((t) => t.rootTaskId === rootTaskId && !t.metadata?.isSummaryTask)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    
    if (roundTasks.length === 0) return taskTree.rootTask;
    
    // 取第一个子任务的 summary（较短）或 prompt（较长）作为轮次目标
    const first = roundTasks[0];
    // 如果有 waitForChildren=true 的任务（合并/汇总任务），它通常是父任务，优先使用
    const parentTask = roundTasks.find((t) => t.waitForChildren);
    const representative = parentTask ?? first;
    
    return representative.summary || representative.prompt?.substring(0, 200) || taskTree.rootTask;
  }

  /**
   * 检查指定轮次是否已完成
   * 
   * 只检查 rootTaskId 匹配的子任务（排除 isSummaryTask 占位符）。
   * 当该轮次所有子任务都是 completed/failed 时返回 true。
   * 
   * @param taskTree 任务树
   * @param rootTaskId 轮次 ID
   * @returns 该轮次是否已完成
   */
  isRoundCompleted(taskTree: TaskTree, rootTaskId: string): boolean {
    const roundTasks = taskTree.subTasks.filter(
      (t) => t.rootTaskId === rootTaskId && !t.metadata?.isSummaryTask,
    );
    if (roundTasks.length === 0) return false;
    const allDone = roundTasks.every(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "skipped",
    );
    if (allDone) {
      console.log(
        `[Orchestrator] 🏁 Round ${rootTaskId} completed: ${roundTasks.length} tasks (` +
        `${roundTasks.filter((t) => t.status === "completed").length} ok, ` +
        `${roundTasks.filter((t) => t.status === "failed").length} failed, ` +
        `${roundTasks.filter((t) => t.status === "skipped").length} skipped)`,
      );
    }
    return allDone;
  }

  /**
   * 标记指定轮次为已完成，并更新任务树状态
   * 
   * @param taskTree 任务树
   * @param rootTaskId 轮次 ID
   */
  async markRoundCompleted(taskTree: TaskTree, rootTaskId: string): Promise<void> {
    const roundTasks = taskTree.subTasks.filter(
      (t) => t.rootTaskId === rootTaskId && !t.metadata?.isSummaryTask,
    );
    const hasFailed = roundTasks.some((t) => t.status === "failed");

    // 🆕 V2: 同步更新 Round 对象状态
    const round = this.findRound(taskTree, rootTaskId);
    if (round) {
      const roundStatus = hasFailed ? "failed" as const : "completed" as const;
      this.updateRoundStatus(taskTree, rootTaskId, roundStatus);
      if (hasFailed) {
        round.hasOverthrow = true;
      }
    }

    // 🔧 检查是否有其他轮次的 pending/active 任务
    // 如果有，不能把整棵树标记为 completed，否则 drain Guard A/B 会误杀新任务
    // 🔧 P8 修复：排除 isSummaryTask（根汇总占位符），否则它永远 pending 阻止树终结
    const otherPendingCount = taskTree.subTasks.filter(
      (t) => t.rootTaskId !== rootTaskId
        && !t.metadata?.isSummaryTask
        && (t.status === "pending" || t.status === "active"),
    ).length;

    if (otherPendingCount > 0) {
      taskTree.status = hasFailed ? "failed" : "active";
      console.log(`[Orchestrator] 🏁 Round ${rootTaskId} done, but ${otherPendingCount} pending tasks from other rounds → tree stays ${taskTree.status}`);
    } else {
      taskTree.status = hasFailed ? "failed" : "completed";
      console.log(`[Orchestrator] 🏁 Task tree marked as ${taskTree.status} (round: ${rootTaskId})`);
    }

    await this.taskTreeManager.save(taskTree);
  }

  /**
   * 渲染任务树为 Markdown
   */
  renderTaskTreeToMarkdown(taskTree: TaskTree): string {
    return this.taskTreeManager.renderToMarkdown(taskTree);
  }

  // ========================================
  // 🆕 新增方法：递归分解和质量评估
  // ========================================

  /**
   * 递归分解子任务
   * 
   * @param taskTree 任务树
   * @param subTaskId 要分解的子任务 ID
   * @param enableQualityReview 是否启用质量评估（默认 true）
   * @returns 分解后的子任务列表
   */
  async decomposeSubTask(
    taskTree: TaskTree,
    subTaskId: string,
    enableQualityReview: boolean = true
  ): Promise<SubTask[]> {
    // 1. 查找子任务
    const subTask = taskTree.subTasks.find(t => t.id === subTaskId);
    if (!subTask) {
      throw new Error(`子任务 ${subTaskId} 不存在`);
    }

    // 2. 检查是否可以分解
    const maxDepth = taskTree.maxDepth ?? 3;
    if (!this.llmDecomposer.canDecompose(subTask, maxDepth)) {
      console.log(`[Orchestrator] ℹ️ 子任务 ${subTaskId} 不可分解`);
      return [];
    }

    // 3. 调用 LLM 进行分解
    const decomposedTasks = await this.llmDecomposer.decomposeRecursively(
      taskTree,
      subTask,
      maxDepth
    );

    // 4. 如果启用质量评估，评估分解质量
    if (enableQualityReview && taskTree.qualityReviewEnabled !== false) {
      const review = await this.qualityReviewer.reviewDecomposition(
        taskTree,
        subTaskId,
        "initial_decomposition"
      );

      // 根据评估决策执行相应操作
      switch (review.decision) {
        case "continue":
          // 通过，继续执行
          console.log(`[Orchestrator] ✅ 分解质量评估通过`);
          break;

        case "adjust":
          // 需要调整，应用调整方案
          console.log(`[Orchestrator] ⚠️ 分解质量需要调整`);
          if (review.modifications && review.modifications.length > 0) {
            await this.adjustTaskTree(taskTree, review.modifications, false);
          }
          break;

        case "restart":
          // 需要重启，保留经验并重新分解
          console.log(`[Orchestrator] 🔄 分解质量不满意，需要重启`);
          return await this.restartDecomposition(taskTree, subTask, review);

        case "overthrow":
          // 需要推翻，完全重新开始
          console.log(`[Orchestrator] ❌ 分解质量严重不满意，需要推翻`);
          return await this.overthrowDecomposition(taskTree, subTask, review);
      }
    }

    // 🔧 P3 修复：确保分解产生的子任务继承父任务的 rootTaskId
    // 修复前：LLM 返回的子任务没有 rootTaskId，task-tree-manager.addSubTask 也不自动继承
    // 导致 getNextExecutableTasksForDrain 的 roundFilter 过滤掉这些任务
    const parentRootTaskId = subTask.rootTaskId;
    if (parentRootTaskId) {
      for (const dt of decomposedTasks) {
        if (!dt.rootTaskId) {
          dt.rootTaskId = parentRootTaskId;
          dt.roundId = parentRootTaskId;
        }
      }
    }

    // 5. 将分解后的子任务添加到任务树
    for (const decomposedTask of decomposedTasks) {
      await this.taskTreeManager.addSubTask(taskTree, subTaskId, decomposedTask);
    }

    // 6. 标记子任务为已分解
    await this.markAsDecomposed(taskTree, subTaskId);

    // 🔧 P2+P8 修复：分解后将父任务标记为 completed（而非 pending）
    // 原 P2 修复将状态改为 pending+waitForChildren，但这会阻塞 isRoundCompleted()
    // 且如果父任务最终被执行会重复工作。正确做法：decomposed 父任务直接标记完成。
    if (subTask.status === "active" || subTask.status === "pending") {
      subTask.status = "completed";
      subTask.completedAt = Date.now();
      subTask.output = `[已分解为 ${decomposedTasks.length} 个子任务]`;
    }

    // 🔧 P6 防御：分解后立即创建检查点，防止后续并发写入覆盖分解结果
    await this.taskTreeManager.createCheckpoint(taskTree);
    await this.taskTreeManager.save(taskTree);

    // P6 验证：确认分解的子任务确实在任务树中
    const verifyCount = decomposedTasks.filter(dt =>
      taskTree.subTasks.some(t => t.id === dt.id),
    ).length;
    if (verifyCount !== decomposedTasks.length) {
      console.error(
        `[Orchestrator] ❌ P6: 分解验证失败！预期 ${decomposedTasks.length} 个子任务在树中，实际 ${verifyCount} 个`,
      );
    }

    console.log(`[Orchestrator] ✅ 子任务 ${subTaskId} 分解完成，生成 ${decomposedTasks.length} 个子任务`);
    return decomposedTasks;
  }

  /**
   * 🆕 基于已有输出的增量分解（decompose-on-failure 策略）
   * 
   * 当子任务重试后仍不达标（结构性失败，如字数不足）时，
   * 保留已有输出作为第一部分，创建续写子任务逐步积累完成目标。
   * 
   * 复用现有的 decomposeRecursively + taskTreeManager.addSubTask 能力。
   */
  async decomposeFailedTask(
    taskTree: TaskTree,
    subTask: SubTask,
  ): Promise<SubTask[]> {
    const existingOutput = subTask.output ?? "";
    let existingLength = existingOutput.length;
    const wordCountReq = this.qualityReviewer.extractWordCountRequirement(subTask.prompt);

    // 🔧 关键修复：优先用文件内容计算已有字数
    // subTask.output 可能只是 LLM 的确认消息（如"已创作完成"），不是文件内容
    let actualFileContent = "";
    const producedPaths = subTask.metadata?.producedFilePaths;
    if (producedPaths && producedPaths.length > 0) {
      try {
        const fs = await import("node:fs/promises");
        for (const filePath of producedPaths) {
          try {
            const content = await fs.readFile(filePath, "utf-8");
            actualFileContent += content;
          } catch {
            // 文件不存在或无法读取，跳过
          }
        }
        if (actualFileContent.length > 0) {
          existingLength = actualFileContent.length;
          console.log(
            `[Orchestrator] 📏 decomposeFailedTask 使用文件内容: ${existingLength} 字符 (output 仅 ${existingOutput.length} 字符)`,
          );
        }
      } catch {
        // import 失败，回退到 output 长度
      }
    }

    // 计算还需要多少字
    const remainingChars = wordCountReq ? Math.max(0, wordCountReq - existingLength) : 0;

    // 单次 LLM 输出能力上限（保守估计）
    const maxOutputPerTask = 2000;

    // 计算需要多少个续写子任务
    const continuationCount = remainingChars > 0
      ? Math.max(1, Math.ceil(remainingChars / maxOutputPerTask))
      : 2; // 没有明确字数要求时默认拆 2 个

    console.log(
      `[Orchestrator] 🔧 decomposeFailedTask: ${subTask.id}, ` +
      `已有 ${existingLength} 字, 要求 ${wordCountReq ?? "未知"} 字, ` +
      `剩余 ${remainingChars} 字, 计划创建 ${continuationCount} 个续写子任务`,
    );

    // 1. 将已有输出标记为"第一部分"，当前子任务标记为 completed
    subTask.status = "completed";
    subTask.completedAt = Date.now();
    subTask.output = existingOutput;
    if (!subTask.metadata) subTask.metadata = {};
    subTask.metadata.qualityReview = {
      status: "passed",
      decision: "decompose",
      findings: [`字数不达标触发增量分解：已有 ${existingLength} 字，需续写 ${remainingChars} 字`],
      suggestions: [],
    };

    // 2. 提取已有输出的结尾作为续写上下文（最后 800 字符）
    // 🔧 优先用文件内容作为续写上下文
    const effectiveContent = actualFileContent.length > 0 ? actualFileContent : existingOutput;
    const contextTail = effectiveContent.length > 800
      ? effectiveContent.slice(-800)
      : effectiveContent;

    // 3. 创建续写子任务
    const newSubTasks: SubTask[] = [];
    const charsPerTask = remainingChars > 0
      ? Math.ceil(remainingChars / continuationCount)
      : maxOutputPerTask;

    for (let i = 0; i < continuationCount; i++) {
      const partNumber = i + 2; // 第一部分是已有输出
      const isLast = i === continuationCount - 1;

      // 构建续写 prompt：注入前文结尾 + 字数要求 + 连贯性指令
      const continuationPrompt = [
        `【续写任务 — 第 ${partNumber} 部分（共 ${continuationCount + 1} 部分）】`,
        ``,
        `原始任务：${subTask.summary}`,
        ``,
        `前文结尾（请从这里自然续写，保持风格和情节连贯）：`,
        `---`,
        // 🔧 A3 修复：所有续写子任务都注入实际的前文结尾
        // 第 1 个续写子任务：注入原始任务的输出结尾
        // 第 2+ 个续写子任务：也注入原始任务的输出结尾作为基础上下文
        // 系统会在执行时通过 buildSiblingContext 自动注入前一个续写子任务的完整输出
        contextTail,
        `---`,
        ``,
        i > 0 ? `注意：系统会自动注入前一个续写子任务（第 ${partNumber - 1} 部分）的输出。请从那个输出的结尾处自然续写。` : ``,
        `本部分要求：约 ${charsPerTask} 字。`,
        isLast ? `这是最后一部分，请写出完整的结尾。` : `请在适当的段落处结束，为下一部分留出衔接点。`,
        ``,
        `⚠️ 重要：`,
        `- 必须使用 write 工具将内容写入文件`,
        `- 保持与前文一致的风格、语气、人称`,
        `- 不要重复前文已有的内容`,
      ].filter(Boolean).join("\n");

      const newSubTask: SubTask = {
        id: `${subTask.id}-cont-${partNumber}`,
        prompt: continuationPrompt,
        summary: `${subTask.summary}（续写第 ${partNumber} 部分）`,
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        parentId: subTask.parentId,
        depth: subTask.depth ?? 0,
        children: [],
        // 🔧 修复：续写子任务的依赖链
        // 第一个续写子任务依赖原始子任务（确保原始子任务完成后才开始续写）
        // 后续续写子任务依赖前一个续写子任务（确保串行执行保持连贯性）
        dependencies: i === 0 ? [subTask.id] : [`${subTask.id}-cont-${partNumber - 1}`],
        canDecompose: false, // 续写子任务不再分解
        decomposed: false,
        rootTaskId: subTask.rootTaskId,
        roundId: subTask.roundId,
        metadata: {
          complexity: "medium" as const,
          priority: "medium" as const,
        },
      };

      await this.taskTreeManager.addSubTask(taskTree, newSubTask.parentId || null, newSubTask);
      newSubTasks.push(newSubTask);
    }

    // 4. 保存任务树
    await this.taskTreeManager.save(taskTree);

    console.log(
      `[Orchestrator] ✅ decomposeFailedTask: ${subTask.id} 增量分解完成，` +
      `保留已有输出 (${existingLength} 字) + 创建 ${newSubTasks.length} 个续写子任务`,
    );

    return newSubTasks;
  }

  /**
   * 动态调整任务树
   * 
   * @param taskTree 任务树
   * @param changes 要应用的变更列表
   * @param enableQualityReview 是否启用质量评估（默认 true）
   */
  async adjustTaskTree(
    taskTree: TaskTree,
    changes: TaskTreeChange[],
    enableQualityReview: boolean = true
  ): Promise<void> {
    // 1. 验证变更的合法性
    const validation = this.taskAdjuster.validateChanges(taskTree, changes);
    if (!validation.valid) {
      throw new Error(`变更验证失败: ${validation.errors.join(", ")}`);
    }

    // 2. 如果启用质量评估，评估调整方案
    if (enableQualityReview && taskTree.qualityReviewEnabled !== false) {
      // TODO: 实现调整方案的质量评估
      console.log(`[Orchestrator] ℹ️ 调整方案质量评估（待实现）`);
    }

    // 3. 应用变更
    await this.taskAdjuster.applyChanges(taskTree, changes);

    // 4. 保存任务树
    await this.taskTreeManager.save(taskTree);

    console.log(`[Orchestrator] ✅ 任务树调整完成，应用了 ${changes.length} 个变更`);
  }

  // ========================================
  // 🆕 批量执行相关方法
  // ========================================

  /**
   * 批量执行多个批次
   * 
   * @param taskTree 任务树
   * @param batches 任务批次列表
   * @returns 批量执行结果列表
   */
  async executeBatches(
    taskTree: TaskTree,
    batches: TaskBatch[]
  ): Promise<BatchExecutionResult[]> {
    if (!this.batchExecutor) {
      throw new Error("批量执行器未初始化，请先调用 setLLMCaller() 设置 LLM 调用器");
    }

    console.log(`[Orchestrator] 🚀 开始批量执行 ${batches.length} 个批次`);

    const results: BatchExecutionResult[] = [];

    for (const batch of batches) {
      try {
        // 1. 更新批次状态为 "active"
        batch.status = "active";
        await this.updateBatchStatus(taskTree, batch.id, "active");

        // 2. 执行批次
        const result = await this.batchExecutor.executeBatch(batch);
        results.push(result);

        // 3. 处理执行结果
        if (result.success) {
          // 成功：更新批次状态和任务输出
          batch.status = "completed";
          batch.completedAt = Date.now();
          await this.updateBatchStatus(taskTree, batch.id, "completed");

          // 将输出分配到各个任务
          for (const [taskId, output] of result.outputs.entries()) {
            const task = taskTree.subTasks.find(t => t.id === taskId);
            if (task) {
              task.output = output;
              task.completedAt = Date.now();
              await this.taskTreeManager.updateSubTaskStatus(taskTree, taskId, "completed");

              // 🆕 保存任务输出到文件系统
              if (this.fileManager) {
                await this.fileManager.saveTaskOutput(taskId, output, "txt");
                await this.fileManager.saveTaskMetadata(task);
                await this.fileManager.recordTimelineEvent(
                  "task_completed",
                  taskId,
                  `批量任务完成：${task.summary}`
                );
              }

              console.log(`[Orchestrator] ✅ 任务 ${taskId} 完成（批量执行）`);
            }
          }

          console.log(`[Orchestrator] ✅ 批次 ${batch.id} 执行成功，完成 ${result.outputs.size} 个任务`);
        } else {
          // 失败：更新批次状态和错误信息
          batch.status = "failed";
          batch.error = result.error;
          await this.updateBatchStatus(taskTree, batch.id, "failed");

          // 标记批次中的所有任务为失败
          for (const task of batch.tasks) {
            task.error = `批次执行失败: ${result.error}`;
            await this.taskTreeManager.updateSubTaskStatus(taskTree, task.id, "failed");

            // 🆕 记录失败到文件系统
            if (this.fileManager) {
              await this.fileManager.logFailure(task.id, result.error || "未知错误");
              await this.fileManager.recordTimelineEvent(
                "task_failed",
                task.id,
                `批量任务失败：${task.summary}`
              );
            }
          }

          console.error(`[Orchestrator] ❌ 批次 ${batch.id} 执行失败: ${result.error}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // 更新批次状态为失败
        batch.status = "failed";
        batch.error = errorMessage;
        await this.updateBatchStatus(taskTree, batch.id, "failed");

        // 标记批次中的所有任务为失败
        for (const task of batch.tasks) {
          task.error = `批次执行异常: ${errorMessage}`;
          await this.taskTreeManager.updateSubTaskStatus(taskTree, task.id, "failed");
        }

        console.error(`[Orchestrator] ❌ 批次 ${batch.id} 执行异常: ${errorMessage}`);

        // 记录错误结果
        results.push({
          batchId: batch.id,
          success: false,
          outputs: new Map(),
          error: errorMessage,
          duration: 0,
        });
      }
    }

    console.log(`[Orchestrator] ✅ 批量执行完成，成功 ${results.filter(r => r.success).length}/${batches.length} 个批次`);
    return results;
  }

  /**
   * 更新批次状态
   * 
   * @param taskTree 任务树
   * @param batchId 批次 ID
   * @param status 新状态
   */
  private async updateBatchStatus(
    taskTree: TaskTree,
    batchId: string,
    status: "pending" | "active" | "completed" | "failed"
  ): Promise<void> {
    // 初始化 batches 数组（如果不存在）
    if (!taskTree.batches) {
      taskTree.batches = [];
    }

    // 查找批次
    const batch = taskTree.batches.find(b => b.id === batchId);
    if (batch) {
      batch.status = status;
      
      // 如果是完成状态，记录完成时间
      if (status === "completed") {
        batch.completedAt = Date.now();
      }
    }

    // 保存任务树
    await this.taskTreeManager.save(taskTree);
  }

  /**
   * 获取可执行的子任务列表（考虑依赖关系和父子关系）
   * 
   * 🆕 支持批量执行：返回的任务可以被分组为批次
   * 🆕 支持自动汇总：当所有子任务完成后，自动触发父任务的汇总执行
   * 
   * @param taskTree 任务树
   * @param enableBatching 是否启用批量执行（默认 false）
   * @returns 可执行的子任务列表（按优先级排序）
   */
  getExecutableTasks(taskTree: TaskTree, enableBatching: boolean = false): SubTask[] {
    const executableTasks: SubTask[] = [];

    for (const subTask of taskTree.subTasks) {
      // 1. 检查任务状态（只有 pending 状态的任务可以执行）
      if (subTask.status !== "pending") {
        continue;
      }

      // 🔧 P8 修复：根/汇总任务跳过 LLM 执行路径
      // 合并输出由 onRoundCompleted → FileManager.mergeTaskOutputs() 系统路径处理，
      // 避免将所有子输出灌入 prompt 浪费 token + 产生幻觉
      if (subTask.metadata?.isRootTask && subTask.metadata?.isSummaryTask) {
        const allNonRootTasksCompleted = taskTree.subTasks
          .filter(t => !t.metadata?.isRootTask && !t.metadata?.isSummaryTask)
          .every(t => t.status === "completed" || t.status === "failed");

        if (!allNonRootTasksCompleted) {
          console.log(`[Orchestrator] ⏳ Root summary task waiting for all sub-tasks to complete`);
          continue;
        }

        // 所有子任务已完成，标记根任务为 skipped（系统合并路径处理实际输出）
        subTask.status = "skipped";
        subTask.completedAt = Date.now();
        subTask.output = "[SystemMerge] 合并输出由 onRoundCompleted 系统路径处理";
        
        // 🔧 P3+P4: 更新 metadata 计数器
        if (taskTree.metadata) {
          taskTree.metadata.completedTasks = taskTree.subTasks.filter(t => t.status === "completed").length;
        }
        
        console.log(`[Orchestrator] 🔧 P8: Root summary task ${subTask.id} 跳过 LLM，标记 skipped（系统合并路径处理）`);
        continue; // 不加入 executableTasks
      }

      // 2. 检查依赖关系（所有依赖的任务都必须已完成）
      if (subTask.dependencies && subTask.dependencies.length > 0) {
        const allDependenciesCompleted = subTask.dependencies.every(depId => {
          const depTask = taskTree.subTasks.find(t => t.id === depId);
          return depTask && depTask.status === "completed";
        });

        if (!allDependenciesCompleted) {
          continue;
        }
      }

      // 🆕 3. 检查子任务是否全部完成（递归回溯的核心逻辑）
      if (subTask.waitForChildren && subTask.children && subTask.children.length > 0) {
        const allChildrenCompleted = subTask.children.every(child => {
          return child.status === "completed";
        });

        if (!allChildrenCompleted) {
          console.log(`[Orchestrator] ⏳ Task ${subTask.id} waiting for children to complete`);
          continue; // 子任务未完成,跳过父任务
        }

        // 🆕 4. 将子任务输出注入到父任务的 prompt 中（汇总任务）
        const childOutputs = subTask.children
          .filter(child => child.output && child.output.length > 0)
          .map(child => {
            return `### ${child.summary}\n\n${child.output}`;
          });

        if (childOutputs.length > 0) {
          console.log(`[Orchestrator] 📥 Injecting ${childOutputs.length} child outputs into task ${subTask.id}`);
          
          // 🆕 修改父任务的 prompt，添加汇总指令
          subTask.prompt = `${subTask.prompt}

## 子任务输出

以下是所有子任务的输出结果，请将它们汇总整合为一个完整的、连贯的最终产物：

${childOutputs.join("\n\n---\n\n")}

## 汇总要求

1. **整合内容**: 将所有子任务的输出整合为一个完整的文档
2. **保持连贯**: 确保内容逻辑连贯，过渡自然
3. **统一风格**: 统一文风、格式和术语
4. **生成文件**: 将最终产物保存为 txt 或 md 文件
5. **质量检查**: 确保内容完整、准确、符合要求

请立即执行汇总任务，并生成最终交付文件。`;

          // 🆕 标记父任务为"需要汇总"
          if (!subTask.metadata) {
            subTask.metadata = {};
          }
          subTask.metadata.isSummaryTask = true;
        }
      }

      // 5. 添加到可执行任务列表
      executableTasks.push(subTask);
    }

    // 6. 按优先级排序（high > medium > low）
    executableTasks.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      const aPriority = priorityOrder[a.metadata?.priority || "medium"];
      const bPriority = priorityOrder[b.metadata?.priority || "medium"];
      return bPriority - aPriority;
    });

    // 🆕 7. 如果启用批量执行，创建批次并记录到任务树
    if (enableBatching && executableTasks.length > 0) {
      const batches = this.taskGrouper.groupTasks(taskTree, executableTasks);
      
      if (batches.length > 0) {
        console.log(`[Orchestrator] 📦 创建了 ${batches.length} 个批次，包含 ${batches.reduce((sum, b) => sum + b.tasks.length, 0)} 个任务`);
        
        // 初始化 batches 数组（如果不存在）
        if (!taskTree.batches) {
          taskTree.batches = [];
        }
        
        // 将批次添加到任务树
        for (const batch of batches) {
          // 检查批次是否已存在
          const existingBatch = taskTree.batches.find(b => b.id === batch.id);
          if (!existingBatch) {
            taskTree.batches.push(batch);
          }
          
          // 更新任务的批次信息
          for (let i = 0; i < batch.tasks.length; i++) {
            const task = batch.tasks[i];
            if (!task.metadata) {
              task.metadata = {};
            }
            task.metadata.batchId = batch.id;
            task.metadata.batchIndex = i;
          }
        }
        
        // 保存任务树（异步操作，但不阻塞返回）
        this.taskTreeManager.save(taskTree).catch(err => {
          console.error(`[Orchestrator] ❌ 保存任务树失败: ${err}`);
        });
      }
    }

    return executableTasks;
  }

  // ========================================
  // 🆕 方案 A：任务树驱动的 drain 调度
  // ========================================

  /**
   * 为 drain 提供下一批可执行任务（任务树驱动，单一真相源）
   * 
   * 替代 drain 中的 FIFO shift + 4 层守卫（A/B/C/D）。
   * drain 只需调用此方法，根据返回值决定执行/等待/结束。
   * 
   * 内部逻辑（按优先级）：
   * 1. 任务树已终结（completed/failed 且无 pending）→ discard_all
   * 2. 指定轮次已完成 → round_done
   * 3. 单个子任务已 completed/failed → 从结果中排除
   * 4. waitForChildren 任务的兄弟未全部完成 → 从结果中排除
   * 5. 依赖未满足 → 从结果中排除
   * 6. 剩余 pending 任务按并行组分批返回
   * 
   * @param taskTree 任务树
   * @param roundId 当前轮次 ID（可选，用于轮次隔离）
   * @returns DrainScheduleResult
   */
  getNextExecutableTasksForDrain(
    taskTree: TaskTree,
    roundId?: string,
  ): DrainScheduleResult {
    // 1. 任务树全局终结检查
    if (taskTree.status === "completed" || taskTree.status === "failed") {
      const hasPending = taskTree.subTasks.some(
        (t) => t.status === "pending" || t.status === "active",
      );
      if (!hasPending) {
        return { action: "discard_all", reason: `任务树已 ${taskTree.status}，无 pending 任务` };
      }

      // 🔧 修复：不再因为轮次中有 failed 任务就级联丢弃所有 pending 任务
      // 原因：onTaskFailed 已经做了精细的级联处理（只跳过依赖失败任务的下游），
      // 这里的粗暴级联会覆盖那个精细逻辑，导致无关的兄弟任务也被杀掉。
      // 只有当 Round 被显式标记为 failed（hasOverthrow=true 且无剩余可执行任务）时才丢弃。
      if (taskTree.status === "failed" && roundId) {
        const round = this.findRound(taskTree, roundId);
        const hasPendingInRound = taskTree.subTasks.some(
          (t) => t.rootTaskId === roundId && (t.status === "pending" || t.status === "active"),
        );
        // 只有 Round 已被标记 failed 且无剩余可执行任务时才丢弃
        if (round?.status === "failed" && !hasPendingInRound) {
          return {
            action: "discard_round",
            reason: `轮次 ${roundId} 已标记 failed 且无剩余任务`,
            roundId,
            treeModified: false,
          };
        }
        // 否则继续正常调度（让无依赖的兄弟任务继续执行）
      }
    }

    // 2. 🆕 A2: 熔断器检查 — LLM 请求预算耗尽时停止执行
    if (roundId) {
      const round = this.findRound(taskTree, roundId);
      if (round?.circuitBreaker?.tripped) {
        // 熔断已触发，将同轮次 pending 任务标记为 skipped
        let skippedCount = 0;
        for (const t of taskTree.subTasks) {
          if (t.rootTaskId === roundId && t.status === "pending") {
            t.status = "skipped";
            t.error = `熔断器触发：${round.circuitBreaker.tripReason}`;
            skippedCount++;
          }
        }
        if (skippedCount > 0) {
          console.warn(
            `[Orchestrator] 🔌 熔断器已触发，跳过 ${skippedCount} 个 pending 任务 (Round ${roundId})`,
          );
        }
        return {
          action: "discard_round",
          reason: `熔断器已触发：${round.circuitBreaker.tripReason}，跳过 ${skippedCount} 个任务`,
          roundId,
          treeModified: skippedCount > 0,
        };
      }
    }

    // 3. 轮次完成检查
    if (roundId && this.isRoundCompleted(taskTree, roundId)) {
      return { action: "round_done", reason: `轮次 ${roundId} 已完成`, roundId };
    }

    // 3. 收集当前轮次的 pending 任务，应用语义过滤
    const roundFilter = roundId
      ? (t: SubTask) => t.rootTaskId === roundId
      : () => true;

    const pendingTasks = taskTree.subTasks.filter(
      (t) => t.status === "pending" && roundFilter(t),
    );

    if (pendingTasks.length === 0) {
      // 没有 pending 任务但轮次未标记完成 — 可能所有任务都在 active 状态
      const activeTasks = taskTree.subTasks.filter(
        (t) => t.status === "active" && roundFilter(t),
      );
      if (activeTasks.length > 0) {
        return { action: "wait", reason: `${activeTasks.length} 个任务正在执行中` };
      }
      return { action: "round_done", reason: "无 pending 或 active 任务", roundId };
    }

    // 4. 过滤：root/summary 任务跳过 LLM 执行
    // 5. 过滤：依赖未满足的任务
    // 6. 过滤：waitForChildren 且兄弟未全部完成的任务
    const executable: SubTask[] = [];

    for (const task of pendingTasks) {
      // 跳过 root summary 任务（由系统合并路径处理）
      if (task.metadata?.isRootTask && task.metadata?.isSummaryTask) {
        continue;
      }

      // 依赖检查
      if (task.dependencies && task.dependencies.length > 0) {
        const allDepsDone = task.dependencies.every((depId) => {
          const dep = taskTree.subTasks.find((t) => t.id === depId);
          return dep && (dep.status === "completed" || dep.status === "failed" || dep.status === "skipped");
        });
        if (!allDepsDone) continue;
      }

      // waitForChildren 检查：所有非 waitForChildren 的兄弟任务必须完成
      if (task.waitForChildren) {
        const siblings = taskTree.subTasks.filter(
          (t) => t.rootTaskId === task.rootTaskId
            && t.id !== task.id
            && !t.waitForChildren
            && !t.metadata?.isRootTask
            && !t.metadata?.isSummaryTask,
        );
        const allSiblingsDone = siblings.every(
          (t) => t.status === "completed" || t.status === "failed" || t.status === "skipped",
        );
        if (!allSiblingsDone) continue;
      }

      executable.push(task);
    }

    if (executable.length === 0) {
      // 有 pending 任务但都被过滤了（等待依赖或兄弟完成）
      return { action: "wait", reason: `${pendingTasks.length} 个 pending 任务均在等待依赖/兄弟完成` };
    }

    // 7. 并行组检测
    const groups = findParallelGroups(executable);
    const firstGroup = groups[0] ?? [];

    return {
      action: "execute",
      tasks: firstGroup,
      remainingPending: pendingTasks.length - firstGroup.length,
    };
  }

  /**
   * 标记子任务为已分解
   * 
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   */
  async markAsDecomposed(
    taskTree: TaskTree,
    subTaskId: string
  ): Promise<void> {
    await this.taskTreeManager.modifySubTask(taskTree, subTaskId, {
      decomposed: true
    });
  }

  /**
   * 生成最终交付产物
   * 
   * @param taskTree 任务树
   * @param subTask 汇总任务
   * @returns 交付文件路径
   */
  async generateFinalDeliverable(
    taskTree: TaskTree,
    subTask: SubTask
  ): Promise<string> {
    if (!this.fileManager) {
      throw new Error("FileManager 未初始化");
    }

    // 1. 确定文件格式（根据内容长度和类型）
    const format = subTask.output && subTask.output.length > 10000 ? "md" : "txt";

    // 2. 保存最终产物
    const filepath = await this.fileManager.saveTaskOutput(
      subTask.id,
      subTask.output || "",
      format
    );

    // 3. 生成交付报告
    const report = this.outputFormatter.formatRecursiveCompletion(
      subTask,
      subTask.children || [],
      filepath
    );

    // 4. 保存交付报告
    await this.fileManager.saveTaskOutput(
      `${subTask.id}-report`,
      report,
      "md"
    );

    // 5. 记录时间线事件
    await this.fileManager.recordTimelineEvent(
      "final_deliverable_generated",
      subTask.id,
      `最终交付产物已生成：${filepath}`
    );

    console.log(`[Orchestrator] 📦 最终交付产物已生成：${filepath}`);
    return filepath;
  }

  /**
   * 验证任务是否产生了文件输出
   * 
   * 🆕 用于检查写作任务是否真正创建了文件
   * 
   * @param taskTree 任务树
   * @param subTask 子任务
   * @returns 是否有文件输出
   */
  private async verifyFileOutput(
    taskTree: TaskTree,
    subTask: SubTask
  ): Promise<boolean> {
    if (!this.fileManager) {
      console.warn(`[Orchestrator] ⚠️ FileManager 未初始化，跳过文件产出验证`);
      return true;
    }

    // 🔧 策略 1（优先）：检查文件追踪器已记录的路径
    // collectTrackedFiles 在此之前已经把精确路径写入了 metadata，
    // 如果有数据则直接信任，**不可覆写**。
    if (subTask.metadata?.producedFilePaths && subTask.metadata.producedFilePaths.length > 0) {
      const { stat } = await import("node:fs/promises");
      let existCount = 0;
      for (const fp of subTask.metadata.producedFilePaths) {
        try {
          await stat(fp);
          existCount++;
        } catch {
          console.warn(`[Orchestrator] ⚠️ 追踪文件不存在: ${fp}`);
        }
      }
      if (existCount > 0) {
        console.log(
          `[Orchestrator] ✅ 文件追踪器验证通过: ${existCount}/${subTask.metadata.producedFilePaths.length} 个文件存在`,
        );
        return true;
      }
    }

    // 🔧 策略 2（兜底）：检查 artifacts 目录
    const { join } = await import("node:path");
    const { readdir } = await import("node:fs/promises");
    
    const artifactsDir = join(
      this.fileManager.getTaskTreePath(),
      "tasks",
      subTask.id,
      "artifacts"
    );

    try {
      const files = await readdir(artifactsDir);
      
      const validFiles = files.filter(file => 
        !file.startsWith(".") && 
        !file.endsWith(".tmp") &&
        (file.endsWith(".txt") || 
         file.endsWith(".md") || 
         file.endsWith(".doc") || 
         file.endsWith(".docx") ||
         file.endsWith(".pdf"))
      );

      if (validFiles.length > 0) {
        console.log(`[Orchestrator] ✅ 任务 ${subTask.id} 在 artifacts 中产生了 ${validFiles.length} 个文件：${validFiles.join(", ")}`);
        
        // 🔧 仅在追踪器未记录时才补充（避免覆写追踪器的精确数据）
        if (!subTask.metadata) {
          subTask.metadata = {};
        }
        if (!subTask.metadata.producedFiles || subTask.metadata.producedFiles.length === 0) {
          subTask.metadata.producedFiles = validFiles;
        }
        
        return true;
      }
    } catch {
      // artifacts 目录不存在，继续下一个策略
    }

    // 🔧 策略 3：检查任务输出文本长度（LLM 直接在回复中写了完整内容）
    if (subTask.output && subTask.output.length > 500) {
      console.log(
        `[Orchestrator] ✅ 任务 ${subTask.id} 有 ${subTask.output.length} 字符的文本输出，视为有效产出`,
      );
      return true;
    }

    console.warn(`[Orchestrator] ⚠️ 任务 ${subTask.id} 未产生任何文件或有效文本输出`);
    return false;
  }

  /**
   * 发送子任务的文件到聊天频道
   * 
   * 🆕 用于在子任务完成后，将产生的文件发送给用户
   * 
   * @param taskTree 任务树
   * @param subTask 子任务
   */
  private async sendSubTaskFiles(
    taskTree: TaskTree,
    subTask: SubTask
  ): Promise<void> {
    if (!subTask.metadata?.producedFiles || subTask.metadata.producedFiles.length === 0) {
      return;
    }

    const { join } = await import("node:path");
    
    for (const fileName of subTask.metadata.producedFiles) {
      const filePath = join(
        this.fileManager!.getTaskTreePath(),
        "tasks",
        subTask.id,
        "artifacts",
        fileName
      );
      
      try {
        // 🆕 发送文件到聊天频道
        await this.sendFileToChannel(filePath, `子任务完成：${subTask.summary}`);
        console.log(`[Orchestrator] ✅ 已发送文件到聊天频道：${fileName}`);
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️ 发送文件失败：${fileName}`, err);
      }
    }
  }

  /**
   * 发送文件到聊天频道
   * 
   * 🆕 用于将文件发送给用户（支持 Telegram、Web 等频道）
   * 
   * @param filePath 文件路径
   * @param caption 文件说明
   */
  private async sendFileToChannel(
    filePath: string,
    caption: string
  ): Promise<void> {
    console.log(`[Orchestrator] 📤 准备发送文件：${filePath}`);
    console.log(`[Orchestrator] 📝 文件说明：${caption}`);
    
    try {
      // 🆕 从全局上下文获取当前的 FollowupRun
      const { getCurrentFollowupRunContext } = await import("../tools/enqueue-task-tool.js");
      const currentFollowupRun = getCurrentFollowupRunContext();
      
      if (!currentFollowupRun) {
        console.warn("[Orchestrator] ⚠️ 无法发送文件：currentFollowupRun 未设置");
        return;
      }
      
      const { originatingChannel, originatingTo, originatingAccountId, originatingThreadId } = currentFollowupRun;
      
      if (!originatingChannel || !originatingTo) {
        console.warn("[Orchestrator] ⚠️ 无法发送文件：originatingChannel 或 originatingTo 未设置");
        return;
      }
      
      // 🆕 根据频道类型发送文件
      if (originatingChannel === "telegram") {
        await this.sendFileToTelegram(
          originatingTo,
          filePath,
          caption,
          originatingAccountId,
          originatingThreadId as number | undefined,
        );
      } else {
        console.warn(`[Orchestrator] ⚠️ 不支持的频道类型: ${originatingChannel}`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️ 发送文件失败`, err);
      // 如果发送失败，记录错误，让用户手动下载
    }
  }

  /**
   * 发送文件到 Telegram
   * 
   * 🆕 使用 Telegram Bot API 发送本地文件
   * 
   * @param chatId Telegram 聊天 ID
   * @param filePath 文件路径
   * @param caption 文件说明
   * @param accountId 账号 ID（可选）
   * @param threadId 话题 ID（可选）
   */
  private async sendFileToTelegram(
    chatId: string,
    filePath: string,
    caption: string,
    accountId?: string,
    threadId?: number,
  ): Promise<void> {
    try {
      // 🆕 读取文件内容
      const { readFile } = await import("node:fs/promises");
      const { basename } = await import("node:path");
      
      const fileBuffer = await readFile(filePath);
      const fileName = basename(filePath);
      
      // 🆕 创建 InputFile
      const { InputFile } = await import("grammy");
      const file = new InputFile(fileBuffer, fileName);
      
      // 🆕 获取 Telegram Bot 实例
      const { Bot } = await import("grammy");
      const { loadConfig } = await import("../../config/config.js");
      const { resolveTelegramAccount } = await import("../../telegram/accounts.js");
      
      const cfg = loadConfig();
      const account = resolveTelegramAccount({ cfg, accountId });
      const token = account.token;
      
      if (!token) {
        throw new Error("Telegram token 未配置");
      }
      
      const bot = new Bot(token);
      
      // 🆕 发送文件
      const params: Record<string, unknown> = {
        caption,
        parse_mode: "HTML" as const,
      };
      
      if (threadId != null) {
        params.message_thread_id = threadId;
      }
      
      await bot.api.sendDocument(chatId, file, params);
      
      console.log(`[Orchestrator] ✅ 文件已发送到 Telegram: ${fileName}`);
    } catch (err) {
      console.error("[Orchestrator] ❌ 发送文件到 Telegram 失败:", err);
      throw err;
    }
  }

  /**
   * 获取任务树中的所有批次
   * 
   * @param taskTree 任务树
   * @returns 批次列表
   */
  getBatches(taskTree: TaskTree): TaskBatch[] {
    return taskTree.batches || [];
  }

  /**
   * 获取待执行的批次
   * 
   * @param taskTree 任务树
   * @returns 待执行的批次列表
   */
  getPendingBatches(taskTree: TaskTree): TaskBatch[] {
    if (!taskTree.batches) {
      return [];
    }

    return taskTree.batches.filter(batch => 
      batch.status === "pending" || batch.status === undefined
    );
  }

  /**
   * 获取批次统计信息
   * 
   * @param taskTree 任务树
   * @returns 批次统计信息
   */
  getBatchStatistics(taskTree: TaskTree): {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
  } {
    const batches = taskTree.batches || [];
    
    return {
      total: batches.length,
      pending: batches.filter(b => b.status === "pending" || b.status === undefined).length,
      active: batches.filter(b => b.status === "active").length,
      completed: batches.filter(b => b.status === "completed").length,
      failed: batches.filter(b => b.status === "failed").length,
    };
  }

  /**
   * 检查任务树是否全部完成，并触发整体质量评估
   * 
   * @param taskTree 任务树
   * @returns 是否全部完成且通过质量评估
   */
  async checkAndReviewCompletion(taskTree: TaskTree): Promise<boolean> {
    // 1. 检查是否所有任务都已完成
    const allCompleted = taskTree.subTasks.every(t => t.status === "completed");
    
    if (!allCompleted) {
      return false;
    }

    // 2. 触发整体质量评估
    if (taskTree.qualityReviewEnabled !== false) {
      console.log(`[Orchestrator] 🔍 开始整体质量评估`);
      
      // 🆕 V2: 使用活跃 Round 的 goal 作为评审基准
      const activeRound = this.getActiveRound(taskTree);
      const roundGoal = activeRound?.goal;
      const review = await this.qualityReviewer.reviewOverallCompletion(taskTree, roundGoal);

      // 根据评估结果决定后续操作
      switch (review.decision) {
        case "continue": {
          console.log(`[Orchestrator] ✅ 整体质量评估通过`);
          // 🆕 Step 6c: 生成交付报告
          const deliveryReport = this.generateDeliveryReport(taskTree);
          console.log(`[Orchestrator] 📦 交付报告已生成: ${deliveryReport.statistics.successRate} 成功率`);
          return true;
        }

        case "adjust":
          console.log(`[Orchestrator] ⚠️ 整体质量需要调整`);
          if (review.modifications && review.modifications.length > 0) {
            await this.adjustTaskTree(taskTree, review.modifications, false);
          }
          return false;

        case "restart":
        case "overthrow":
          console.log(`[Orchestrator] ❌ 整体质量不满意`);
          return false;
      }
    }

    return true;
  }

  // ========================================
  // 私有辅助方法：重启和推翻机制
  // ========================================

  /**
   * 重启分解（保留经验并重新分解）
   * 
   * @param taskTree 任务树
   * @param subTask 子任务
   * @param review 质量评估结果
   * @returns 新的子任务列表
   */
  private async restartDecomposition(
    taskTree: TaskTree,
    subTask: SubTask,
    review: QualityReviewResult
  ): Promise<SubTask[]> {
    // 1. 初始化字段（如果不存在）
    if (!taskTree.restartCount) {
      taskTree.restartCount = 0;
    }
    if (!taskTree.failureHistory) {
      taskTree.failureHistory = [];
    }

    // 2. 检查重启次数限制
    const maxRestarts = 2;
    if (taskTree.restartCount >= maxRestarts) {
      console.warn(`[Orchestrator] ⚠️ 已达到最大重启次数 ${maxRestarts}，改为推翻`);
      return await this.overthrowDecomposition(taskTree, subTask, review);
    }

    // 3. 保留当前分解结果作为失败经验
    const failureRecord = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      reason: review.findings.join("; "),
      context: `子任务 ${subTask.id} 的分解质量不满意`,
      lessons: review.findings,
      improvements: review.suggestions
    };

    taskTree.failureHistory.push(failureRecord);
    taskTree.restartCount++;

    // 4. 使用失败经验重新分解
    const maxDepth = taskTree.maxDepth ?? 3;
    const newTasks = await this.llmDecomposer.decomposeWithLessons(
      taskTree,
      subTask,
      taskTree.failureHistory
    );

    console.log(`[Orchestrator] 🔄 重启分解完成（第 ${taskTree.restartCount} 次），生成 ${newTasks.length} 个新子任务`);
    return newTasks;
  }

  /**
   * 推翻分解（完全重新开始）
   * 
   * @param taskTree 任务树
   * @param subTask 子任务
   * @param review 质量评估结果
   * @returns 新的子任务列表
   */
  private async overthrowDecomposition(
    taskTree: TaskTree,
    subTask: SubTask,
    review: QualityReviewResult
  ): Promise<SubTask[]> {
    // 1. 初始化字段（如果不存在）
    if (!taskTree.overthrowCount) {
      taskTree.overthrowCount = 0;
    }
    if (!taskTree.failureHistory) {
      taskTree.failureHistory = [];
    }

    // 2. 检查推翻次数限制
    const maxOverthrows = 1;
    if (taskTree.overthrowCount >= maxOverthrows) {
      throw new Error(`已达到最大推翻次数 ${maxOverthrows}，无法继续分解`);
    }

    // 3. 记录推翻原因
    const failureRecord = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      reason: `根本性错误：${review.findings.join("; ")}`,
      context: `子任务 ${subTask.id} 的分解方案存在根本性错误，需要完全推翻`,
      lessons: review.findings,
      improvements: review.suggestions
    };

    taskTree.failureHistory.push(failureRecord);
    taskTree.overthrowCount++;

    // 4. 完全重新分解（不使用失败经验，从头开始）
    const maxDepth = taskTree.maxDepth ?? 3;
    const newTasks = await this.llmDecomposer.decomposeRecursively(
      taskTree,
      subTask,
      maxDepth
    );

    console.log(`[Orchestrator] ❌ 推翻分解完成（第 ${taskTree.overthrowCount} 次），生成 ${newTasks.length} 个新子任务`);
    return newTasks;
  }

  // ========================================
  // 🆕 交付报告生成
  // ========================================

  /**
   * 生成结构化交付报告
   * 
   * @param taskTree 任务树
   * @returns 交付报告数据
   */
  generateDeliveryReport(taskTree: TaskTree): DeliveryReport {
    const reporter = new DeliveryReporter();
    return reporter.generateReport(taskTree);
  }

  /**
   * 生成交付报告的 Markdown 格式
   * 
   * @param taskTree 任务树
   * @returns Markdown 格式的交付报告
   */
  generateDeliveryReportMarkdown(taskTree: TaskTree): string {
    const reporter = new DeliveryReporter();
    const report = reporter.generateReport(taskTree);
    return reporter.formatAsMarkdown(report);
  }

  // ========================================
  // 🆕 增强分解能力（自适应深度 + 分解验证）
  // ========================================

  /**
   * 自适应计算最大分解深度（智能深度控制）
   * 
   * 使用复杂度评分模型，综合考虑多个维度：
   * - Prompt 长度
   * - 任务类型
   * - 工具依赖
   * - 历史表现
   * 
   * @param rootTask 根任务描述
   * @param subTaskCount 当前子任务数量
   * @returns 推荐的最大分解深度 (1-3)
   */
  calculateAdaptiveMaxDepth(rootTask: string, subTaskCount: number): number {
    // 🆕 使用复杂度评分器
    const scorer = new ComplexityScorer();
    
    // 创建临时任务树用于评分
    const tempTaskTree: TaskTree = {
      id: "temp",
      rootTask,
      subTasks: [],
      status: "pending" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      checkpoints: [],
    };
    
    // 计算复杂度评分
    const score = scorer.calculateScore(tempTaskTree);
    
    console.log(`[Orchestrator] 📊 任务复杂度评分: ${score.total}/100`);
    console.log(`[Orchestrator] 📏 推荐最大深度: ${score.recommendedMaxDepth}`);
    console.log(`[Orchestrator] 📋 评分详情:`, {
      promptLength: score.dimensions.promptLength,
      taskType: score.dimensions.taskType,
      toolDependencies: score.dimensions.toolDependencies,
      historicalPerformance: score.dimensions.historicalPerformance,
    });
    
    return score.recommendedMaxDepth;
  }

  /**
   * 验证分解结果的合法性
   * 
   * 检查：循环依赖、孤立任务、空任务等。
   * 
   * @param taskTree 任务树
   * @returns 验证结果（通过 / 错误列表）
   */
  validateDecomposition(taskTree: TaskTree): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 1. 检查是否有子任务
    if (taskTree.subTasks.length === 0) {
      errors.push("任务树没有子任务");
      return { valid: false, errors };
    }

    // 2. 检查循环依赖
    const visited = new Set<string>();
    const stack = new Set<string>();
    const taskMap = new Map(taskTree.subTasks.map(t => [t.id, t]));

    const hasCycle = (id: string): boolean => {
      if (stack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      stack.add(id);
      const task = taskMap.get(id);
      if (task?.dependencies) {
        for (const dep of task.dependencies) {
          if (hasCycle(dep)) return true;
        }
      }
      stack.delete(id);
      return false;
    };

    for (const t of taskTree.subTasks) {
      if (hasCycle(t.id)) {
        errors.push(`检测到循环依赖，涉及任务: ${t.id} (${t.summary})`);
        break;
      }
    }

    // 3. 检查孤立依赖（依赖不存在的任务）
    const allIds = new Set(taskTree.subTasks.map(t => t.id));
    for (const t of taskTree.subTasks) {
      if (t.dependencies) {
        for (const dep of t.dependencies) {
          if (!allIds.has(dep)) {
            errors.push(`任务 ${t.id} (${t.summary}) 依赖不存在的任务: ${dep}`);
          }
        }
      }
    }

    // 4. 检查空 prompt
    for (const t of taskTree.subTasks) {
      if (!t.prompt || t.prompt.trim().length === 0) {
        errors.push(`任务 ${t.id} (${t.summary}) 的 prompt 为空`);
      }
    }

    if (errors.length > 0) {
      console.warn(`[Orchestrator] ⚠️ 分解验证失败: ${errors.join("; ")}`);
    }

    return { valid: errors.length === 0, errors };
  }

  // ========================================
  // 🆕 V2 Phase 4: 生命周期钩子 — 集中决策逻辑
  // ========================================

  /**
   * 🆕 onTaskCreating — 任务创建前的守卫
   *
   * 集中了 drain.ts 和 enqueue-task-tool.ts 中散落的检查逻辑：
   * 1. 权限检查：ctx.permissions.canEnqueue?
   * 2. 深度检查：task.depth < maxDepth?
   * 3. Round 状态检查：round.hasOverthrow → 拒绝
   * 4. 任务树终结检查：tree.status === completed/failed → 拒绝
   * 5. 轮次完成检查：round 已完成 → 拒绝
   *
   * @param taskTree 任务树
   * @param ctx 执行上下文（可选，无则跳过权限检查）
   * @param rootTaskId 轮次 ID（可选）
   * @param depth 当前深度
   * @returns CreateDecision
   */
  onTaskCreating(
    taskTree: TaskTree,
    ctx?: ExecutionContext,
    rootTaskId?: string,
    depth?: number,
  ): CreateDecision {
    // 守卫 1：任务树已终结
    if (taskTree.status === "completed" || taskTree.status === "failed") {
      const hasPending = taskTree.subTasks.some(
        (t) => t.status === "pending" || t.status === "active",
      );
      if (!hasPending) {
        return {
          allowed: false,
          reason: `任务树已 ${taskTree.status}，无 pending 子任务`,
          denyType: "tree_terminated",
        };
      }
    }

    // 守卫 2：权限检查（ExecutionContext 可用时）
    if (ctx && !ctx.permissions.canEnqueue) {
      return {
        allowed: false,
        reason: `角色 ${ctx.role} 无 enqueue 权限`,
        denyType: "permission",
      };
    }

    // 守卫 3：深度检查
    const maxDepth = taskTree.maxDepth ?? 3;
    const currentDepth = depth ?? ctx?.depth ?? 0;
    if (currentDepth >= maxDepth) {
      return {
        allowed: false,
        reason: `深度 ${currentDepth} 已达上限 ${maxDepth}`,
        denyType: "depth",
      };
    }

    // 守卫 4：Round 状态检查
    if (rootTaskId) {
      const round = this.findRound(taskTree, rootTaskId);
      if (round) {
        if (round.hasOverthrow) {
          return {
            allowed: false,
            reason: `Round ${rootTaskId} 已被 overthrow`,
            denyType: "round_overthrown",
          };
        }
        if (round.status === "completed" || round.status === "failed" || round.status === "cancelled") {
          return {
            allowed: false,
            reason: `Round ${rootTaskId} 已 ${round.status}`,
            denyType: "round_completed",
          };
        }
      }

      // 守卫 5：轮次完成检查（兼容无 Round 对象的旧数据）
      if (this.isRoundCompleted(taskTree, rootTaskId)) {
        return {
          allowed: false,
          reason: `Round ${rootTaskId} 所有子任务已完成`,
          denyType: "round_completed",
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 🆕 onTaskStarting — 任务执行前的准备
   *
   * 替代 followup-runner 中手动构建 ExecutionContext、
   * 检查自动分解、启动文件追踪的散装逻辑。
   *
   * @param taskTree 任务树
   * @param subTask 即将执行的子任务
   * @param legacyFlags 旧布尔标记（过渡期兼容）
   * @returns StartDecision
   */
  onTaskStarting(
    taskTree: TaskTree,
    subTask: SubTask,
    legacyFlags?: {
      isQueueTask?: boolean;
      isRootTask?: boolean;
      isNewRootTask?: boolean;
      taskDepth?: number;
      rootTaskId?: string;
    },
  ): StartDecision {
    // 1. 构建 ExecutionContext
    const role = deriveExecutionRole({
      isQueueTask: legacyFlags?.isQueueTask,
      isRootTask: legacyFlags?.isRootTask ?? legacyFlags?.isNewRootTask,
      isNewRootTask: legacyFlags?.isNewRootTask,
      taskDepth: legacyFlags?.taskDepth,
    });
    const execCtx = createExecutionContext({
      role,
      roundId: legacyFlags?.rootTaskId ?? subTask.rootTaskId ?? "",
      depth: legacyFlags?.taskDepth ?? subTask.depth ?? 0,
    });

    // 2. 检查是否应该先自动分解
    const shouldDecompose = this.shouldAutoDecompose(taskTree, subTask);

    // 3. 启动文件追踪
    beginTracking(subTask.id);

    // 4. 更新子任务状态为 active
    subTask.status = "active";

    // 5. 记录执行角色到子任务元数据
    subTask.executionRole = execCtx.role;

    console.log(
      `[Orchestrator] 🚀 onTaskStarting: ${subTask.id} role=${execCtx.role} depth=${execCtx.depth} shouldDecompose=${shouldDecompose}`,
    );

    return {
      allowed: true,
      executionContext: execCtx,
      shouldDecompose,
    };
  }

  /**
   * 🆕 onTaskCompleted — 任务完成后的统一后处理
   *
   * 编排已有的 postProcessSubTaskCompletion() + 轮次完成检查逻辑。
   * followup-runner 只需调用此方法，不再自己编排。
   *
   * @param taskTree 任务树
   * @param subTask 已完成的子任务（output/status 已设置）
   * @param rootTaskId 轮次 ID
   * @returns PostProcessResult（复用现有类型，向后兼容）
   */
  async onTaskCompleted(
    taskTree: TaskTree,
    subTask: SubTask,
    rootTaskId?: string,
  ): Promise<PostProcessResult> {
    // 🆕 A2: 递增 LLM 调用计数（子任务执行 1 次 + 质检 1 次 = 2 次）
    const effectiveRoundId = rootTaskId ?? subTask.rootTaskId;
    if (effectiveRoundId) {
      const tripped = this.incrementLLMCallCount(taskTree, effectiveRoundId, 2);
      if (tripped) {
        // 熔断已触发，跳过质检但仍然保存任务输出到文件系统
        console.warn(`[Orchestrator] 🔌 熔断器已触发，跳过质检直接完成: ${subTask.id}`);
        
        // 🔧 修复：即使跳过质检，也要保存任务输出和更新计数器
        if (taskTree.metadata) {
          taskTree.metadata.completedTasks = taskTree.subTasks.filter(t => t.status === "completed").length;
        }
        try {
          const fm = await this.ensureFileManager(taskTree.id);
          await fm.saveTaskOutput(subTask.id, subTask.output || "", "txt");
          await fm.saveTaskMetadata(subTask);
        } catch {
          // 保存失败不阻塞
        }
        
        await this.taskTreeManager.save(taskTree);
        const result: PostProcessResult = {
          decision: "continue",
          status: "passed",
          findings: ["熔断器已触发，跳过质检"],
          suggestions: [],
          needsRequeue: false,
          markedFailed: false,
        };
        // 仍然检查轮次完成
        if (effectiveRoundId && this.isRoundCompleted(taskTree, effectiveRoundId)) {
          await this.markRoundCompleted(taskTree, effectiveRoundId);
          result.roundCompleted = true;
          result.completedRoundId = effectiveRoundId;
        }
        return result;
      }
    }

    // 1. 委托现有的后处理逻辑（质量评估 + 决策 + 文件验证 + 持久化）
    const result = await this.postProcessSubTaskCompletion(taskTree, subTask);

    // 2. 如果后处理决定 restart 或 overthrow，直接返回（不做轮次检查）
    if (result.needsRequeue || result.markedFailed) {
      return result;
    }

    // 3. 轮次完成检查
    if (effectiveRoundId && this.isRoundCompleted(taskTree, effectiveRoundId)) {
      await this.markRoundCompleted(taskTree, effectiveRoundId);
      result.roundCompleted = true;
      result.completedRoundId = effectiveRoundId;
      console.log(`[Orchestrator] 🏁 onTaskCompleted → Round ${effectiveRoundId} completed`);
    }

    return result;
  }

  /**
   * 🆕 onTaskFailed — 任务失败后的集中处理
   *
   * 集中了 followup-runner 中的重试判断和 drain.ts 中的级联丢弃逻辑。
   *
   * @param taskTree 任务树
   * @param subTask 失败的子任务
   * @param error 错误对象
   * @returns FailureDecision
   */
  async onTaskFailed(
    taskTree: TaskTree,
    subTask: SubTask,
    error: unknown,
  ): Promise<FailureDecision> {
    const message = error instanceof Error ? error.message : String(error);

    // 🆕 A2: 递增 LLM 调用计数（失败也消耗了 1 次 LLM 调用）
    const roundId = subTask.rootTaskId;
    if (roundId) {
      this.incrementLLMCallCount(taskTree, roundId, 1);
      const round = this.findRound(taskTree, roundId);
      if (round?.circuitBreaker) {
        round.circuitBreaker.totalFailures++;
      }
    }

    // 1. 判断是否可重试
    const isRetryable = this.isRetryableError(error);
    const maxRetries = this.getDefaultMaxRetries();

    if (isRetryable && (subTask.retryCount ?? 0) < maxRetries) {
      // 可重试：标记 pending + retryCount++
      subTask.status = "pending";
      subTask.error = message;
      subTask.retryCount = (subTask.retryCount ?? 0) + 1;
      await this.taskTreeManager.save(taskTree);
      console.log(
        `[Orchestrator] 🔄 onTaskFailed: ${subTask.id} retryable, attempt ${subTask.retryCount}/${maxRetries}`,
      );
      return {
        action: "retry",
        reason: `可重试错误 (${subTask.retryCount}/${maxRetries}): ${message}`,
        needsRequeue: true,
        cascadeSkip: false,
      };
    }

    // 2. 不可重试或重试耗尽：标记 failed
    subTask.status = "failed";
    subTask.error = message;
    await this.taskTreeManager.save(taskTree);

    // 3. 级联检查：只跳过依赖失败任务的下游任务，无依赖的兄弟任务继续执行
    if (roundId) {
      const round = this.findRound(taskTree, roundId);
      if (round) {
        round.hasOverthrow = true;
        // 🔧 优化：只级联跳过直接或间接依赖失败任务的子任务
        const failedId = subTask.id;
        let cascadedCount = 0;
        
        // 收集所有需要级联跳过的任务 ID（递归查找依赖链）
        const toCascade = new Set<string>();
        const findDependents = (targetId: string) => {
          for (const t of taskTree.subTasks) {
            if (t.rootTaskId === roundId && t.status === "pending" && !toCascade.has(t.id)) {
              if (t.dependencies?.includes(targetId) || t.parentId === targetId) {
                toCascade.add(t.id);
                findDependents(t.id); // 递归查找下游
              }
            }
          }
        };
        findDependents(failedId);
        
        for (const t of taskTree.subTasks) {
          if (toCascade.has(t.id)) {
            t.status = "skipped" as SubTask["status"];
            t.error = `级联跳过：依赖的任务 ${failedId} 失败`;
            cascadedCount++;
          }
        }
        
        // 检查是否还有可执行的任务（无依赖的兄弟任务可以继续）
        const remainingPending = taskTree.subTasks.filter(
          t => t.rootTaskId === roundId && t.status === "pending",
        );
        
        if (remainingPending.length === 0) {
          // 所有任务都完成/失败/跳过了，标记 Round 失败
          this.updateRoundStatus(taskTree, roundId, "failed");
        }
        // 否则不标记 Round 失败，让剩余任务继续执行
        
        await this.taskTreeManager.save(taskTree);

        if (cascadedCount > 0) {
          console.log(
            `[Orchestrator] ⚡ onTaskFailed: 级联跳过 ${cascadedCount} 个依赖任务 (Round ${roundId})` +
            (remainingPending.length > 0 ? `，${remainingPending.length} 个无依赖任务继续执行` : ""),
          );
          return {
            action: "cascade_fail",
            reason: `任务 ${subTask.id} 失败，级联跳过 ${cascadedCount} 个依赖任务` +
              (remainingPending.length > 0 ? `，${remainingPending.length} 个无依赖任务继续执行` : ""),
            needsRequeue: false,
            cascadeSkip: true,
          };
        }
      }
    }

    // 4. 更新任务树全局状态
    // 🔧 P9 修复：不要无条件设 failed，检查是否还有可执行的任务
    // 修复前：无条件 taskTree.status = "failed"，导致 getNextExecutableTasksForDrain
    // 的 discard_round 把无辜的兄弟任务也杀了
    const hasRemainingWork = taskTree.subTasks.some(
      (t) => t.status === "pending" || t.status === "active",
    );
    if (!hasRemainingWork) {
      taskTree.status = "failed";
    } else {
      console.log(
        `[Orchestrator] ℹ️ onTaskFailed: 仍有 ${taskTree.subTasks.filter(t => t.status === "pending" || t.status === "active").length} 个任务可执行，不标记 tree 为 failed`,
      );
    }
    await this.taskTreeManager.save(taskTree);

    console.log(`[Orchestrator] ❌ onTaskFailed: ${subTask.id} - ${message}`);
    return {
      action: "stop",
      reason: `不可重试或重试耗尽: ${message}`,
      needsRequeue: false,
      cascadeSkip: false,
    };
  }

  /**
   * 🆕 onRoundCompleted — 轮次完成后的集中处理
   *
   * 集中了 followup-runner 中轮次完成后的合并输出+交付报告+归档逻辑。
   * followup-runner 只需调用此方法并发送返回的 payload。
   *
   * @param taskTree 任务树
   * @param rootTaskId 完成的轮次 ID
   * @returns RoundCompletedResult
   */
  async onRoundCompleted(
    taskTree: TaskTree,
    rootTaskId: string,
  ): Promise<RoundCompletedResult> {
    const result: RoundCompletedResult = {
      archiveSuccess: false,
      roundStatus: "completed",
    };

    // 确定 Round 状态
    const round = this.findRound(taskTree, rootTaskId);
    result.roundStatus = round?.status ?? "completed";

    // 1. 合并子任务输出
    const completedTasks = taskTree.subTasks.filter(
      (t) => t.status === "completed" && t.rootTaskId === rootTaskId,
    );
    if (completedTasks.length > 0) {
      try {
        const mergedFile = await this.mergeRoundOutputs(taskTree, rootTaskId);
        result.mergedFilePath = mergedFile;
        console.log(
          `[Orchestrator] 📝 onRoundCompleted: 合并 ${completedTasks.length} 个子任务输出 → ${mergedFile}`,
        );
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️ onRoundCompleted: 合并输出失败:`, err);
      }
    }

    // 2. 生成交付报告
    try {
      const reporter = new DeliveryReporter();
      const report = reporter.generateReport(taskTree);
      result.deliveryReportMarkdown = reporter.formatAsMarkdown(report);
      console.log(
        `[Orchestrator] 📦 onRoundCompleted: 交付报告已生成 (${report.statistics?.successRate ?? "N/A"} 成功率)`,
      );
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️ onRoundCompleted: 交付报告生成失败:`, err);
    }

    // 3. 归档标记（实际归档由调用方执行，因为需要 config/sessionId 等上下文）
    result.archiveSuccess = true;

    return result;
  }

  /**
   * 判断错误是否可重试（从 followup-runner 搬入 Orchestrator）
   *
   * @private
   */
  private isRetryableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const nonRetryable = [
      "prohibited_content", "safety", "recitation", "blocked",
      "content_filter", "policy_violation", "invalid_request_error",
      "authentication_error", "invalid_argument", "permission_denied",
    ];
    for (const p of nonRetryable) {
      if (message.includes(p)) return false;
    }
    const retryable = [
      "timeout", "network", "rate_limit", "overloaded",
      "internal_error", "503", "502", "504",
    ];
    for (const p of retryable) {
      if (message.includes(p)) return true;
    }
    return false;
  }

  // ========================================
  // 🆕 TaskBoard 渲染能力（合并自 task-board/compact-renderer）
  // ========================================

  /**
   * 将任务树渲染为紧凑的任务看板格式（Markdown）
   * 
   * 复用 task-board 的渲染逻辑，统一到 Orchestrator 中。
   * 
   * @param taskTree 任务树
   * @returns 紧凑格式的 Markdown 字符串
   */
  renderTaskBoard(taskTree: TaskTree): string {
    const statusEmoji = (status: string): string => {
      switch (status) {
        case "completed": return "✅";
        case "active": return "🔄";
        case "pending": return "⏳";
        case "failed": return "❌";
        case "interrupted": return "⚠️";
        default: return "❓";
      }
    };

    const lines: string[] = [];
    const completed = taskTree.subTasks.filter(t => t.status === "completed").length;
    const total = taskTree.subTasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    lines.push("## 📋 任务看板");
    lines.push("");
    lines.push(`**主任务**: ${taskTree.rootTask}`);
    lines.push(`**状态**: ${statusEmoji(taskTree.status)} ${taskTree.status}`);
    lines.push(`**进度**: ${completed}/${total} (${pct}%)`);
    lines.push("");

    if (taskTree.subTasks.length > 0) {
      lines.push("**子任务**:");
      for (let i = 0; i < taskTree.subTasks.length; i++) {
        const t = taskTree.subTasks[i];
        const deps = t.dependencies && t.dependencies.length > 0
          ? ` (依赖: ${t.dependencies.join(", ")})`
          : "";
        lines.push(`${i + 1}. ${statusEmoji(t.status)} ${t.summary}${deps}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 构建任务上下文 Prompt（注入到 System Prompt 中）
   * 
   * 将任务树的关键状态信息格式化为 LLM 可理解的上下文片段。
   * 
   * @param taskTree 任务树
   * @returns 格式化的任务上下文 Prompt
   */
  buildTaskContextPrompt(taskTree: TaskTree): string {
    const completed = taskTree.subTasks.filter(t => t.status === "completed");
    const pending = taskTree.subTasks.filter(t => t.status === "pending");
    const failed = taskTree.subTasks.filter(t => t.status === "failed");

    const parts: string[] = [];
    parts.push("## 当前任务上下文");
    parts.push("");
    parts.push(`你正在执行一个多步骤任务：**${taskTree.rootTask}**`);
    parts.push(`总共 ${taskTree.subTasks.length} 个子任务，已完成 ${completed.length}，待执行 ${pending.length}，失败 ${failed.length}。`);
    parts.push("");

    if (completed.length > 0) {
      parts.push("### 已完成");
      for (const t of completed) {
        const snippet = t.output ? t.output.substring(0, 150) : "无输出";
        parts.push(`- ✅ ${t.summary}: ${snippet}${t.output && t.output.length > 150 ? "..." : ""}`);
      }
      parts.push("");
    }

    if (pending.length > 0) {
      parts.push("### 待执行");
      for (const t of pending) {
        parts.push(`- ⏳ ${t.summary}`);
      }
      parts.push("");
    }

    if (failed.length > 0) {
      parts.push("### 失败");
      for (const t of failed) {
        parts.push(`- ❌ ${t.summary}: ${t.error ?? "未知错误"}`);
      }
      parts.push("");
    }

    return parts.join("\n");
  }
}
