/**
 * LLM 任务分解器
 * 
 * 核心组件：负责使用 LLM 智能分解任务
 * 
 * 功能：
 * 1. 判断任务是否可以继续分解
 * 2. 递归分解子任务
 * 3. 从失败经验中学习并生成改进的分解方案
 * 4. 根据质量评估结果生成调整方案
 * 5. 估算任务的复杂度和时长
 */

import type {
  TaskTree,
  SubTask,
  FailureRecord,
  QualityReviewResult,
  TaskTreeChange,
  SubTaskMetadata,
} from "./types.js";
import { getPrompts } from "./prompts-loader.js";
import { extractJsonFromResponse } from "./json-extractor.js";
import { classifyAndEnrich } from "./task-type-classifier.js";
import type { LLMCaller } from "./batch-executor.js";
import type { ClawdbotConfig } from "../../config/config.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkApprovalRequired } from "../../infra/llm-approval-wrapper.js";
import { runEmbeddedPiAgent } from "../pi-embedded.js";

/**
 * LLM 配置接口
 */
interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  endpoint?: string;
}

type EmbeddedAgentRunConfig = {
  config: ClawdbotConfig;
  provider?: string;
  modelId?: string;
};

/**
 * LLM 任务分解器
 */
export class LLMTaskDecomposer {
  private llmConfig: LLMConfig;
  private externalLLMCaller: LLMCaller | null;
  private embeddedAgentRunConfig: EmbeddedAgentRunConfig | null = null;

  constructor(llmConfig: LLMConfig, llmCaller?: LLMCaller) {
    this.llmConfig = llmConfig;
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
   * 判断子任务是否可以继续分解
   * 
   * 考虑因素：
   * - 当前深度是否超过最大深度
   * - 任务复杂度是否足够高
   * - 任务是否已经足够简单
   * 
   * @param subTask 子任务
   * @param maxDepth 最大深度
   * @returns 是否可以继续分解
   */
  canDecompose(subTask: SubTask, maxDepth: number): boolean {
    // 1. 检查深度限制
    const currentDepth = subTask.depth ?? 0;
    if (currentDepth >= maxDepth) {
      console.log(`[LLMTaskDecomposer] ❌ Task ${subTask.id} reached max depth ${maxDepth}`);
      return false;
    }

    // 2. 检查是否已经分解
    if (subTask.decomposed) {
      console.log(`[LLMTaskDecomposer] ℹ️ Task ${subTask.id} already decomposed`);
      return false;
    }

    // 3. 检查是否标记为不可分解
    if (subTask.canDecompose === false) {
      console.log(`[LLMTaskDecomposer] ℹ️ Task ${subTask.id} marked as non-decomposable`);
      return false;
    }

    // 4. 检查任务复杂度（如果有元数据）
    if (subTask.metadata?.complexity === "low") {
      console.log(`[LLMTaskDecomposer] ℹ️ Task ${subTask.id} has low complexity`);
      return false;
    }

    // 5. 默认可以分解
    return true;
  }

  /**
   * 递归分解子任务
   * 
   * 调用 LLM 进行智能分解，生成 2-8 个子任务
   * 
   * @param taskTree 任务树
   * @param subTask 要分解的子任务
   * @param maxDepth 最大深度
   * @returns 分解后的子任务列表
   */
  async decomposeRecursively(
    taskTree: TaskTree,
    subTask: SubTask,
    maxDepth: number
  ): Promise<SubTask[]> {
    // 1. 检查是否可以分解
    if (!this.canDecompose(subTask, maxDepth)) {
      return [];
    }

    // 2. 构建分解提示词
    const prompt = this.buildDecompositionPrompt(taskTree, subTask);

    // 3. 调用 LLM 进行分解（V3 修复：捕获 LLM 不可用错误，返回空数组而非占位符）
    let llmResponse: string;
    try {
      llmResponse = await this.callLLM(prompt);
    } catch (err) {
      console.warn(`[LLMTaskDecomposer] ⚠️ 分解失败（LLM 不可用），任务 ${subTask.id} 将跳过分解直接执行:`, err);
      return [];
    }

    // 4. 解析分解结果
    const decomposedTasks = this.parseDecompositionResponse(llmResponse, subTask);

    // 🆕 O4: chapterOutline 空壳回退 — LLM 未返回时自动从 masterBlueprint 提取
    this.fillMissingChapterOutlines(decomposedTasks, taskTree);

    console.log(`[LLMTaskDecomposer] ✅ Decomposed task ${subTask.id} into ${decomposedTasks.length} subtasks`);
    return decomposedTasks;
  }

  /**
   * 从失败经验中学习并生成改进的分解方案
   * 
   * @param taskTree 任务树
   * @param subTask 要分解的子任务
   * @param failureHistory 失败历史
   * @returns 改进的子任务列表
   */
  async decomposeWithLessons(
    taskTree: TaskTree,
    subTask: SubTask,
    failureHistory: FailureRecord[]
  ): Promise<SubTask[]> {
    // 1. 构建包含失败经验的提示词
    const prompt = this.buildDecompositionWithLessonsPrompt(taskTree, subTask, failureHistory);

    // 2. 调用 LLM 进行分解
    const llmResponse = await this.callLLM(prompt);

    // 3. 解析分解结果
    const decomposedTasks = this.parseDecompositionResponse(llmResponse, subTask);

    // 🆕 O4: chapterOutline 空壳回退
    this.fillMissingChapterOutlines(decomposedTasks, taskTree);

    console.log(`[LLMTaskDecomposer] ✅ Decomposed with lessons: ${decomposedTasks.length} subtasks`);
    return decomposedTasks;
  }

  /**
   * 根据质量评估结果生成任务树变更
   * 
   * @param taskTree 任务树
   * @param review 质量评估结果
   * @returns 任务树变更列表
   */
  async generateAdjustments(
    taskTree: TaskTree,
    review: QualityReviewResult
  ): Promise<TaskTreeChange[]> {
    // 如果评估结果中已经包含了变更建议，直接返回
    if (review.modifications && review.modifications.length > 0) {
      return review.modifications;
    }

    // 否则调用 LLM 将改进建议转换为具体的变更操作
    const prompt = this.buildAdjustmentPrompt(taskTree, review);
    const llmResponse = await this.callLLM(prompt);
    const changes = this.parseAdjustmentResponse(llmResponse);

    console.log(`[LLMTaskDecomposer] ✅ Generated ${changes.length} adjustments`);
    return changes;
  }

  /**
   * 估算任务的复杂度和时长
   * 
   * @param subTask 子任务
   * @returns 任务元数据（复杂度和预估时长）
   */
  async estimateTask(subTask: SubTask): Promise<SubTaskMetadata> {
    // 构建估算提示词
    const prompt = this.buildEstimationPrompt(subTask);

    // 调用 LLM 进行估算
    const llmResponse = await this.callLLM(prompt);

    // 解析估算结果
    const metadata = this.parseEstimationResponse(llmResponse);

    console.log(`[LLMTaskDecomposer] ✅ Estimated task ${subTask.id}: ${metadata.complexity} complexity`);
    return metadata;
  }

  // ========================================
  // 🆕 V3: 总纲领生成（Master Blueprint）
  // ========================================

  /**
   * 生成总纲领（Master Blueprint）
   *
   * 在根任务首次分解前调用，让 LLM 先生成一份完整的创作/执行纲领。
   * 纲领包含整体规划和每个子任务的详细大纲，是"指挥家的总谱"。
   *
   * @param rootTask 根任务描述（用户原始 prompt）
   * @param taskType 任务类型提示（writing/coding/analysis 等）
   * @returns 生成的总纲领文本，LLM 调用失败时返回 null
   */
  async generateMasterBlueprint(
    rootTask: string,
    taskType?: string,
  ): Promise<string | null> {
    const prompt = this.buildBlueprintPrompt(rootTask, taskType);
    console.log(`[LLMTaskDecomposer] 🎼 生成总纲领，提示词长度: ${prompt.length}`);

    try {
      const response = await this.callLLM(prompt);

      // 降级检测：如果返回的是 JSON 格式（callLLM 降级到规则驱动的占位符），说明未成功
      if (response.trim().startsWith("{")) {
        console.warn("[LLMTaskDecomposer] ⚠️ 总纲领生成降级到规则驱动，跳过");
        return null;
      }

      console.log(`[LLMTaskDecomposer] ✅ 总纲领生成完成 (${response.length} chars)`);
      return response;
    } catch (err) {
      console.warn("[LLMTaskDecomposer] ⚠️ 总纲领生成失败:", err);
      return null;
    }
  }

  /**
   * 构建总纲领生成提示词（V3 国际化重构：从 getPrompts() 获取文本）
   */
  private buildBlueprintPrompt(rootTask: string, taskType?: string): string {
    const prompts = getPrompts();

    const typeHint = taskType === "writing"
      ? prompts.blueprintTypeHints.writing
      : taskType === "coding"
      ? prompts.blueprintTypeHints.coding
      : prompts.blueprintTypeHints.generic;

    const consistencyList = prompts.blueprintConsistencyPoints
      .map(p => `- ${p}`)
      .join("\n");

    return `${prompts.blueprintExpertRole} ${prompts.blueprintInstruction}
${consistencyList}

${typeHint}

---
**${prompts.blueprintOriginalTaskLabel}：**
${rootTask}
---

${prompts.blueprintOutputFormatHint}`;
  }

  // ========================================
  // 🆕 V7: 结构化写作纲领（多轮次生成）
  // ========================================

  /**
   * 🆕 V7: 多轮次生成结构化写作纲领
   *
   * 将原本单次 LLM 调用的纲领生成拆分为多个聚焦轮次：
   * - Pass 1: 世界观 + 风格指南 + 人物卡（创作基石）
   * - Pass 2: 基于 Pass 1 生成各章节详细剧情纲要
   * - Pass 3（可选）：一致性审查 + 迭代优化
   *
   * 结果存入 TaskTreeMetadata 的结构化字段，
   * 每个章节子任务执行时精准注入"人物卡 + 该章纲要"，
   * 替代原来的"大段截断纲领"，信息损失为零。
   *
   * @param rootTask 用户原始创作需求
   * @param enablePass3 是否启用第三轮一致性审查（默认 true，额外消耗 1 次 LLM）
   * @returns 结构化纲领组件，LLM 不可用时返回 null
   */
  async generateStructuredWritingBlueprint(
    rootTask: string,
    enablePass3: boolean = true,
  ): Promise<{
    masterBlueprint: string;
    characterCards: string;
    worldBuilding: string;
    styleGuide: string;
    chapterSynopses: Record<string, string>;
    version: number;
    llmCallCount: number;
  } | null> {
    const prompts = getPrompts();
    let llmCallCount = 0;

    // ── Pass 1: 世界观 + 风格指南 + 人物卡 ──
    console.log(`[LLMTaskDecomposer] 🎼 V7 Pass 1/3: 生成世界观+人物卡...`);
    const pass1Prompt = `${prompts.structuredBlueprintPass1Prompt}

---
**原始创作需求：**
${rootTask}
---

${prompts.structuredBlueprintOutputHint}`;

    let pass1Result: string;
    try {
      pass1Result = await this.callLLM(pass1Prompt);
      llmCallCount++;
      if (pass1Result.trim().startsWith("{")) {
        console.warn("[LLMTaskDecomposer] ⚠️ V7 Pass 1 降级到规则驱动，跳过结构化纲领");
        return null;
      }
      console.log(`[LLMTaskDecomposer] ✅ V7 Pass 1 完成 (${pass1Result.length} chars)`);
    } catch (err) {
      console.warn("[LLMTaskDecomposer] ⚠️ V7 Pass 1 失败:", err);
      return null;
    }

    // 从 Pass 1 结果中提取结构化组件
    const { worldBuilding, styleGuide, characterCards } = this.parsePass1Result(pass1Result);

    // ── Pass 2: 章节剧情纲要（基于 Pass 1 的世界观和人物卡） ──
    console.log(`[LLMTaskDecomposer] 🎼 V7 Pass 2/3: 生成章节剧情纲要...`);
    const pass2Prompt = `${prompts.structuredBlueprintPass2Prompt}

---
**已确定的核心设定：**
${pass1Result}

**原始创作需求：**
${rootTask}
---

${prompts.structuredBlueprintOutputHint}`;

    let pass2Result: string;
    try {
      pass2Result = await this.callLLM(pass2Prompt);
      llmCallCount++;
      if (pass2Result.trim().startsWith("{")) {
        console.warn("[LLMTaskDecomposer] ⚠️ V7 Pass 2 降级，使用 Pass 1 作为完整纲领");
        return {
          masterBlueprint: pass1Result,
          characterCards,
          worldBuilding,
          styleGuide,
          chapterSynopses: {},
          version: 1,
          llmCallCount,
        };
      }
      console.log(`[LLMTaskDecomposer] ✅ V7 Pass 2 完成 (${pass2Result.length} chars)`);
    } catch (err) {
      console.warn("[LLMTaskDecomposer] ⚠️ V7 Pass 2 失败，使用 Pass 1 作为完整纲领:", err);
      return {
        masterBlueprint: pass1Result,
        characterCards,
        worldBuilding,
        styleGuide,
        chapterSynopses: {},
        version: 1,
        llmCallCount,
      };
    }

    // 从 Pass 2 结果中提取各章节纲要
    const chapterSynopses = this.parseChapterSynopses(pass2Result);

    // ── Pass 3（可选）: 一致性审查 + 迭代优化 ──
    let finalPass1 = pass1Result;
    let finalPass2 = pass2Result;
    let version = 1;

    if (enablePass3) {
      console.log(`[LLMTaskDecomposer] 🎼 V7 Pass 3/3: 一致性审查+迭代优化...`);
      const combinedBlueprint = `${pass1Result}\n\n---\n\n${pass2Result}`;
      const pass3Prompt = `${prompts.structuredBlueprintPass3Prompt}

---
**待审查的创作纲领：**
${combinedBlueprint}
---

如果需要修正，请输出修正后的完整纲领（保持原有结构）。
如果审查通过，请输出"[审查通过]"后附上改进建议。`;

      try {
        const pass3Result = await this.callLLM(pass3Prompt);
        llmCallCount++;

        if (!pass3Result.includes("[审查通过]") && pass3Result.length > 500) {
          // Pass 3 返回了修正版纲领，使用修正版
          console.log(`[LLMTaskDecomposer] ✅ V7 Pass 3: 纲领已迭代优化 (${pass3Result.length} chars)`);
          // 🔧 P55: 放宽守卫——任一组件有效即采纳修正版
          // 旧守卫要求 characterCards > 100 字才采纳，如果编辑只修正了纲要而未重新输出人物卡，
          // 有效修正会被丢弃。新策略：分别检查每个组件，有效的采纳，无效的保留原版。
          const revised = this.parsePass1Result(pass3Result);
          const revisedSynopses = this.parseChapterSynopses(pass3Result);
          let anyRevised = false;

          // 组件级采纳：每个组件独立判断是否使用修正版
          if (revised.characterCards.length > 100) {
            // 人物卡修正有效
            anyRevised = true;
          }
          if (revised.worldBuilding.length > 50) {
            anyRevised = true;
          }
          if (revised.styleGuide.length > 30) {
            anyRevised = true;
          }
          if (Object.keys(revisedSynopses).length > 0) {
            Object.assign(chapterSynopses, revisedSynopses);
            finalPass2 = pass3Result;
            anyRevised = true;
          }

          if (anyRevised) {
            finalPass1 = pass3Result;
            console.log(
              `[LLMTaskDecomposer] 🔧 P55: Pass 3 修正版已采纳 ` +
              `(chars=${revised.characterCards.length}, world=${revised.worldBuilding.length}, ` +
              `style=${revised.styleGuide.length}, chapters=${Object.keys(revisedSynopses).length})`,
            );
          } else {
            console.log(`[LLMTaskDecomposer] ⚠️ P55: Pass 3 修正版所有组件均无效，保留原版`);
          }
          version = 2;
        } else {
          console.log(`[LLMTaskDecomposer] ✅ V7 Pass 3: 审查通过，纲领质量良好`);
        }
      } catch (err) {
        console.warn("[LLMTaskDecomposer] ⚠️ V7 Pass 3 失败（不影响已有纲领）:", err);
      }
    }

    // 组合完整纲领（向后兼容 masterBlueprint 字符串）
    const masterBlueprint = `${finalPass1}\n\n---\n\n${finalPass2 !== finalPass1 ? finalPass2 : ""}`.trim();
    const finalCharCards = this.parsePass1Result(finalPass1).characterCards || characterCards;
    const finalWorldBuilding = this.parsePass1Result(finalPass1).worldBuilding || worldBuilding;
    const finalStyleGuide = this.parsePass1Result(finalPass1).styleGuide || styleGuide;

    console.log(
      `[LLMTaskDecomposer] ✅ V7 结构化纲领生成完成: ` +
      `masterBlueprint=${masterBlueprint.length} chars, ` +
      `characterCards=${finalCharCards.length} chars, ` +
      `worldBuilding=${finalWorldBuilding.length} chars, ` +
      `chapters=${Object.keys(chapterSynopses).length}, ` +
      `version=${version}, llmCalls=${llmCallCount}`,
    );

    return {
      masterBlueprint,
      characterCards: finalCharCards,
      worldBuilding: finalWorldBuilding,
      styleGuide: finalStyleGuide,
      chapterSynopses,
      version,
      llmCallCount,
    };
  }

  /**
   * 🆕 V7: 从 Pass 1 结果中提取结构化组件
   */
  private parsePass1Result(text: string): {
    worldBuilding: string;
    styleGuide: string;
    characterCards: string;
  } {
    // 按大标题分段：世界观设定 / 风格指南 / 人物卡
    const sections = {
      worldBuilding: "",
      styleGuide: "",
      characterCards: "",
    };

    // 匹配标题分段（支持"## 一、"、"# 世界观"、"**世界观**"等格式）
    const worldPattern = /(?:^|\n)(?:#{1,3}\s*)?(?:\*{0,2})(?:一[、.]?\s*)?(?:世界观|背景|设定|World)/im;
    const stylePattern = /(?:^|\n)(?:#{1,3}\s*)?(?:\*{0,2})(?:二[、.]?\s*)?(?:风格|Style|叙事)/im;
    const charPattern = /(?:^|\n)(?:#{1,3}\s*)?(?:\*{0,2})(?:三[、.]?\s*)?(?:人物|角色|Character)/im;

    const worldMatch = text.match(worldPattern);
    const styleMatch = text.match(stylePattern);
    const charMatch = text.match(charPattern);

    // 按匹配位置排序并提取段落
    const markers = [
      { key: "worldBuilding" as const, pos: worldMatch?.index ?? -1 },
      { key: "styleGuide" as const, pos: styleMatch?.index ?? -1 },
      { key: "characterCards" as const, pos: charMatch?.index ?? -1 },
    ].filter(m => m.pos >= 0).sort((a, b) => a.pos - b.pos);

    for (let i = 0; i < markers.length; i++) {
      const start = markers[i].pos;
      const end = i + 1 < markers.length ? markers[i + 1].pos : text.length;
      sections[markers[i].key] = text.substring(start, end).trim();
    }

    // 如果没有匹配到任何标题，整段作为 characterCards（最重要的组件）
    if (markers.length === 0) {
      sections.characterCards = text;
    }

    return sections;
  }

  /**
   * 🆕 V7: 从 Pass 2 结果中提取各章节剧情纲要
   */
  private parseChapterSynopses(text: string): Record<string, string> {
    const synopses: Record<string, string> = {};

    // 匹配章节标题：### 第N章、## 第N章、**第N章** 等
    const chapterPattern = /(?:^|\n)(?:#{1,3}\s*)?(?:\*{0,2})(?:第\s*([一二三四五六七八九十百千\d]+)\s*[章节篇幕])/gim;
    const matches = [...text.matchAll(chapterPattern)];

    if (matches.length === 0) return synopses;

    const cnMap: Record<string, number> = {
      "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
      "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    };

    for (let i = 0; i < matches.length; i++) {
      const numStr = matches[i][1];
      const num = cnMap[numStr] ?? parseInt(numStr, 10);
      if (isNaN(num)) continue;

      const start = matches[i].index!;
      const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
      const content = text.substring(start, end).trim();

      // 截断单章纲要到 2000 字符
      synopses[String(num)] = content.length > 2000
        ? content.substring(0, 2000) + "\n...[纲要已截断]"
        : content;
    }

    return synopses;
  }

  // ========================================
  // 私有辅助方法
  // ========================================

  /**
   * 构建任务分解提示词
   */
  private buildDecompositionPrompt(taskTree: TaskTree, subTask: SubTask): string {
    const prompts = getPrompts();
    const ancestorsStr = this.getAncestorsContext(taskTree, subTask);
    
    const requirements = prompts.decompositionRequirements
      .map((req, index) => `${index + 1}. ${req}`)
      .join("\n");
    
    // 🆕 V3: 如果存在总纲领，注入到分解提示词中（国际化）
    const blueprintSection = taskTree.metadata?.masterBlueprint
      ? `\n${prompts.blueprintDecompositionInstruction}

${prompts.blueprintChapterOutlineInstruction}

---
${taskTree.metadata.masterBlueprint}
---\n`
      : "";

    // V8 P3: 如果存在经验池摘要，注入到分解提示词（帮助 LLM 避免历史失败模式）
    const experienceSection = taskTree.metadata?.experienceSummary
      ? `\n[📚 历史经验教训]\n以下是从过往任务中积累的教训，请在分解时参考避免重复犯错：\n${taskTree.metadata.experienceSummary}\n`
      : "";

    return `${prompts.decompositionExpertRole} ${prompts.decompositionInstruction}

${prompts.rootTaskLabel}：${taskTree.rootTask}
${blueprintSection}${experienceSection}
${ancestorsStr}

${prompts.currentTaskLabel}：
- ${prompts.taskIdLabel}: ${subTask.id}
- ${prompts.taskDescriptionLabel}: ${subTask.prompt}
- ${prompts.taskDepthLabel}: ${subTask.depth ?? 0}

${prompts.decompositionRequirementsTitle}
${requirements}

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "subTasks": [
    {
      "summary": "子任务简短描述",
      "prompt": "子任务详细描述",
      "dependencies": ["${subTask.id}-1"],
      "canDecompose": true,
      "metadata": {
        "complexity": "low" | "medium" | "high",
        "priority": "low" | "medium" | "high",
        "estimatedDuration": 300000,
        "chapterOutline": "从纲领中提取的本子任务专属大纲（场景、角色、衔接点等详细内容）"
      }
    }
  ]
}
\`\`\`

⚠️ 依赖 ID 格式：子任务 ID 为 \`${subTask.id}-N\`（N 从 1 开始），dependencies 中必须使用连字符 \`-\` 而非下划线 \`_\`。例如第 2 个子任务依赖第 1 个：\`"dependencies": ["${subTask.id}-1"]\`

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 构建包含失败经验的分解提示词
   */
  private buildDecompositionWithLessonsPrompt(
    taskTree: TaskTree,
    subTask: SubTask,
    failureHistory: FailureRecord[]
  ): string {
    const prompts = getPrompts();
    
    const lessonsStr = failureHistory
      .map((record, index) => `
${prompts.failureRecordTitle(index)}
- ${prompts.failureReasonLabel}: ${record.reason}
- ${prompts.lessonsLabel}: ${record.lessons.join(", ")}
- ${prompts.improvementsLabel}: ${record.improvements.join(", ")}
`)
      .join("\n");

    const requirements = [
      ...prompts.decompositionRequirements.slice(0, 3),
      prompts.avoidRepeatMistakesReminder,
      prompts.applyImprovementsReminder
    ].map((req, index) => `${index + 1}. ${req}`)
     .join("\n");

    // 🆕 V3: 失败重分解也注入总纲领，保持上下文一致（国际化）
    const blueprintSection = taskTree.metadata?.masterBlueprint
      ? `\n${prompts.blueprintDecompositionInstruction}
${taskTree.metadata.masterBlueprint.length > 4000 ? taskTree.metadata.masterBlueprint.substring(0, 4000) + "\n" + prompts.blueprintTruncatedHint : taskTree.metadata.masterBlueprint}
---\n`
      : "";

    return `${prompts.decompositionExpertRole} ${prompts.decompositionInstruction}

${prompts.rootTaskLabel}：${taskTree.rootTask}
${blueprintSection}
${prompts.currentTaskLabel}：
- ${prompts.taskIdLabel}: ${subTask.id}
- ${prompts.taskDescriptionLabel}: ${subTask.prompt}
- ${prompts.taskDepthLabel}: ${subTask.depth ?? 0}

${prompts.learningFromFailuresInstruction}

${lessonsStr}

${prompts.decompositionRequirementsTitle}
${requirements}

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "subTasks": [
    {
      "summary": "子任务简短描述",
      "prompt": "子任务详细描述",
      "dependencies": ["${subTask.id}-1"],
      "canDecompose": true,
      "metadata": {
        "complexity": "low" | "medium" | "high",
        "priority": "low" | "medium" | "high",
        "estimatedDuration": 300000,
        "chapterOutline": "从纲领中提取的本子任务专属大纲（场景、角色、衔接点等详细内容）"
      }
    }
  ]
}
\`\`\`

⚠️ 依赖 ID 格式：子任务 ID 为 \`${subTask.id}-N\`（N 从 1 开始），dependencies 中必须使用连字符 \`-\` 而非下划线 \`_\`。例如第 2 个子任务依赖第 1 个：\`"dependencies": ["${subTask.id}-1"]\`

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 构建调整方案提示词
   */
  private buildAdjustmentPrompt(
    taskTree: TaskTree,
    review: QualityReviewResult
  ): string {
    const prompts = getPrompts();
    const findingsStr = review.findings.join("\n- ");
    const suggestionsStr = review.suggestions.join("\n- ");
    const subTasksStr = taskTree.subTasks
      .map(st => `- ${st.id}: ${st.summary} (${prompts.reviewStatusLabel}: ${st.status})`)
      .join("\n");

    const changeTypesStr = Object.values(prompts.changeTypes).map(ct => `- ${ct}`).join("\n");

    return `${prompts.adjustmentExpertRole} ${prompts.adjustmentInstruction}

${prompts.rootTaskLabel}：${taskTree.rootTask}

${prompts.currentSubTasksTitle}
${subTasksStr}

${prompts.qualityReviewResultTitle}
- ${prompts.reviewStatusLabel}: ${review.status}
- ${prompts.reviewDecisionLabel}: ${review.decision}

${prompts.findingsTitle}
- ${findingsStr}

${prompts.suggestionsTitle}
- ${suggestionsStr}

${prompts.generateAdjustmentsInstruction}

${prompts.supportedChangeTypesTitle}
${changeTypesStr}

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "changes": [
    {
      "type": "add_task" | "remove_task" | "modify_task" | "move_task" | "merge_tasks" | "split_task",
      "targetId": "目标任务 ID",
      "after": {
        // 变更后的值（根据变更类型不同而不同）
      },
      "timestamp": ${Date.now()}
    }
  ]
}
\`\`\`

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 构建任务估算提示词
   */
  private buildEstimationPrompt(subTask: SubTask): string {
    const prompts = getPrompts();
    
    return `${prompts.estimationExpertRole} ${prompts.estimationInstruction}

${prompts.taskInfoTitle}
- ${prompts.taskIdLabel}: ${subTask.id}
- ${prompts.taskDescriptionLabel}: ${subTask.prompt}

${prompts.evaluationAspectsTitle}

1. ${prompts.complexityDescription.title}
   - ${prompts.complexityDescription.low}
   - ${prompts.complexityDescription.medium}
   - ${prompts.complexityDescription.high}

2. ${prompts.durationDescription.title}
   - ${prompts.durationDescription.unit}
   - ${prompts.durationDescription.considerations}

${prompts.jsonFormatInstruction}

\`\`\`json
{
  "complexity": "low" | "medium" | "high",
  "estimatedDuration": 300000,
  "priority": "low" | "medium" | "high"
}
\`\`\`

${prompts.jsonOnlyReminder}`;
  }

  /**
   * 获取祖先任务的上下文信息
   */
  private getAncestorsContext(taskTree: TaskTree, subTask: SubTask): string {
    const ancestors: SubTask[] = [];
    let currentId = subTask.parentId;
    
    // 向上追溯祖先任务
    while (currentId !== null && currentId !== undefined) {
      const parent = taskTree.subTasks.find(t => t.id === currentId);
      if (!parent) break;
      
      ancestors.unshift(parent); // 添加到开头，保持从根到父的顺序
      currentId = parent.parentId;
    }
    
    if (ancestors.length === 0) {
      return "";
    }
    
    const ancestorsStr = ancestors
      .map((ancestor, index) => `  ${"  ".repeat(index)}- ${ancestor.summary}`)
      .join("\n");
    
    return `祖先任务（从根到父）：\n${ancestorsStr}\n`;
  }

  /**
   * 调用 LLM
   */
  private async callLLM(prompt: string): Promise<string> {
    if (this.embeddedAgentRunConfig?.config) {
      const runId = crypto.randomUUID();
      const sessionId = `decompose-${runId}`;
      const sessionFile = path.join(
        os.homedir(),
        ".clawdbot",
        "tasks",
        "_decompose_sessions",
        `${sessionId}.jsonl`,
      );
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });

      console.log(`[LLMTaskDecomposer] 🧠 使用 runEmbeddedPiAgent 分解（submit_decomposition），prompt长度: ${prompt.length}`);
      const result = await runEmbeddedPiAgent({
        sessionId,
        sessionKey: `agent:decompose:${runId}`,
        sessionFile,
        workspaceDir: process.cwd(),
        config: this.embeddedAgentRunConfig.config,
        provider: this.embeddedAgentRunConfig.provider ?? this.llmConfig.provider,
        model: this.embeddedAgentRunConfig.modelId ?? this.llmConfig.model,
        prompt,
        runMode: "decompose_agent",
        runId,
        timeoutMs: 120_000,
        toolAllowlist: ["submit_decomposition", "continue_generation"],
        skipBootstrapContext: true,
        skillsSnapshot: undefined,
      });

      const toolMetas = result.toolMetas ?? [];
      const submitMeta = toolMetas
        .slice()
        .reverse()
        .find((m) => m?.toolName === "submit_decomposition" && typeof (m as any)?.meta === "string") as
        | { toolName: string; meta?: string }
        | undefined;

      const metaText = submitMeta?.meta?.trim();
      if (!metaText) {
        throw new Error(
          `分解未提交：未检测到 submit_decomposition 工具调用（toolMetas=${toolMetas.length}）`,
        );
      }

      try {
        const parsed = JSON.parse(metaText) as { subTasks?: unknown };
        if (!parsed || !Array.isArray((parsed as any).subTasks)) {
          throw new Error("submit_decomposition 返回格式不正确：缺少 subTasks 数组");
        }
        return JSON.stringify({ subTasks: (parsed as any).subTasks });
      } catch (err) {
        throw new Error(`分解提交解析失败：${String(err)} meta=${metaText}`);
      }
    }

    if (this.externalLLMCaller) {
      console.log(`[LLMTaskDecomposer] 使用系统 LLM 管线分解（旧路径），提示词长度: ${prompt.length}`);
      return await this.externalLLMCaller.call(prompt);
    }

    console.error(`[LLMTaskDecomposer] ❌ LLM 不可用且无降级方案，提示词长度: ${prompt.length}`);
    throw new Error("LLM 调用不可用：embeddedAgentRunConfig 未注入且系统 LLM 调用器未初始化，无法完成分解");
  }

  /**
   * 解析分解响应
   */
  private parseDecompositionResponse(response: string, parentTask: SubTask): SubTask[] {
    try {
      // 尝试从 JSON 代码块中提取
      const jsonStr = extractJsonFromResponse(response);
      const parsed = JSON.parse(jsonStr);
      
      if (!parsed.subTasks || !Array.isArray(parsed.subTasks)) {
        throw new Error("响应格式不正确：缺少 subTasks 数组");
      }
      
      // 转换为 SubTask 对象
      const subTasks: SubTask[] = parsed.subTasks.map((item: any, index: number) => {
        const subTask: SubTask = {
          id: `${parentTask.id}-${index + 1}`,
          prompt: item.prompt || "",
          summary: item.summary || `子任务 ${index + 1}`,
          status: "pending",
          retryCount: 0,
          createdAt: Date.now(),
          parentId: parentTask.id,
          depth: (parentTask.depth ?? 0) + 1,
          children: [],
          dependencies: item.dependencies || [],
          canDecompose: item.canDecompose ?? true,
          decomposed: false,
          qualityReviewEnabled: parentTask.qualityReviewEnabled ?? true,
          metadata: item.metadata || {}
        };
        
        // 🆕 V6: 统一任务类型分类（替代原有的 detectWritingTask 单点检测）
        // 自动设置 taskType 和 validationStrategies
        try {
          const classification = classifyAndEnrich(subTask);
          console.log(`[LLMTaskDecomposer] 🏷️ V6 分类: ${subTask.summary} → type=${classification.type}(${classification.confidence}%)`);
        } catch {
          // 分类器失败时回退到原有逻辑
          const isWritingTask = this.detectWritingTask(subTask.prompt, subTask.summary);
          if (isWritingTask) {
            subTask.metadata = {
              ...subTask.metadata,
              requiresFileOutput: true,
              expectedFileTypes: ["txt", "md", "doc", "docx", "pdf"]
            };
            subTask.taskType = "writing";
          }
        }

        // 🆕 V3: chapterOutline 提取确认（LLM 返回的 metadata.chapterOutline 已通过 item.metadata 透传）
        if (subTask.metadata?.chapterOutline) {
          console.log(`[LLMTaskDecomposer] 📖 章节大纲已提取：${subTask.summary} (${subTask.metadata.chapterOutline.length} chars)`);
        }
        
        return subTask;
      });

      // 🔧 P9 修复：规范化 LLM 返回的 dependencies，防止 ID 格式不匹配导致死锁
      // LLM 可能返回下划线（parentId_1）、纯索引（1）等格式，但实际 ID 使用连字符（parentId-1）
      this.normalizeDependencyIds(subTasks, parentTask);
      
      return subTasks;
    } catch (error) {
      console.error(`[LLMTaskDecomposer] 解析分解响应失败:`, error);
      throw new Error(`解析分解响应失败: ${error}`);
    }
  }

  /**
   * 🆕 O4: chapterOutline 空壳回退
   *
   * LLM 分解时可能不返回 metadata.chapterOutline，导致子任务执行时
   * 只能看到完整纲领（6000 字）而非精准的章节大纲。
   *
   * 🔧 P52: 优先从 V7 blueprintChapterSynopses 精准匹配，
   * 回退到 masterBlueprint 正则提取。
   */
  private fillMissingChapterOutlines(subTasks: SubTask[], taskTree: TaskTree): void {
    const blueprint = taskTree.metadata?.masterBlueprint;
    const v7Synopses = taskTree.metadata?.blueprintChapterSynopses;
    if (!blueprint && !v7Synopses) return;

    // 统计缺失数
    const missing = subTasks.filter(t => !t.metadata?.chapterOutline);
    if (missing.length === 0) return;

    const cnMap: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

    // 🔧 P52: 优先使用 V7 结构化纲要（精准、无需正则）
    let filledFromV7 = 0;
    if (v7Synopses && Object.keys(v7Synopses).length > 0) {
      const stillMissing: SubTask[] = [];
      for (const subTask of missing) {
        if (!subTask.metadata) subTask.metadata = {};

        // 从 summary 提取章节号
        const chMatch = (subTask.summary ?? "").match(/第\s*([一二三四五六七八九十\d]+)\s*[章节篇幕]/);
        let chNum = 0;
        if (chMatch) {
          chNum = cnMap[chMatch[1]] ?? parseInt(chMatch[1], 10);
        }
        // 回退到位置索引（第 1 个子任务 → 第 1 章）
        if (!chNum || isNaN(chNum)) {
          const taskIndex = subTasks.indexOf(subTask) + 1; // 1-based
          if (v7Synopses[String(taskIndex)]) chNum = taskIndex;
        }

        const synopsis = chNum > 0 ? v7Synopses[String(chNum)] : undefined;
        if (synopsis) {
          subTask.metadata.chapterOutline = synopsis.length > 2000
            ? synopsis.substring(0, 2000) + "\n...[纲要已截断]"
            : synopsis;
          // 同时设置 chapterNumber 以便下游精准匹配
          subTask.metadata.chapterNumber = chNum;
          filledFromV7++;
        } else {
          stillMissing.push(subTask);
        }
      }

      if (filledFromV7 > 0) {
        console.log(
          `[LLMTaskDecomposer] 📖 P52: V7 blueprintChapterSynopses 精准填充 ${filledFromV7}/${missing.length} 个子任务的 chapterOutline`,
        );
      }

      // 如果 V7 已全部填充，无需走旧路径
      if (stillMissing.length === 0) return;

      // 仅对 V7 未覆盖的子任务继续走旧路径
      return this.fillMissingChapterOutlinesFromBlueprint(stillMissing, subTasks, blueprint ?? "");
    }

    // 无 V7 纲要，走旧路径
    this.fillMissingChapterOutlinesFromBlueprint(missing, subTasks, blueprint ?? "");
  }

  /**
   * O4 旧路径：从 masterBlueprint 文本中正则提取章节段落
   */
  private fillMissingChapterOutlinesFromBlueprint(
    missing: SubTask[],
    allSubTasks: SubTask[],
    blueprint: string,
  ): void {
    if (!blueprint) return;

    // 按章节标题切分纲领（支持 "第N章"、"Chapter N"、"## N."、"**第N章**" 等格式）
    const chapterPattern = /(?:^|\n)(?:#{1,3}\s*)?(?:\*{0,2})(?:第[一二三四五六七八九十百千\d]+[章节篇幕]|Chapter\s+\d+|\d+[\.\)]\s*(?:第[一二三四五六七八九十百千\d]+[章节篇幕]|Chapter))(?:\*{0,2})[^\n]*/gi;
    const matches = [...blueprint.matchAll(chapterPattern)];

    if (matches.length === 0) {
      console.log(`[LLMTaskDecomposer] ⚠️ O4: 纲领中未找到章节标题，跳过 chapterOutline 回退`);
      return;
    }

    // 构建章节段落映射：每个章节标题 → 到下一个章节标题之间的文本
    const sections: Array<{ title: string; content: string; index: number }> = [];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index!;
      const end = i + 1 < matches.length ? matches[i + 1].index! : blueprint.length;
      sections.push({
        title: matches[i][0].trim(),
        content: blueprint.substring(start, end).trim(),
        index: i,
      });
    }

    const cnMap: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

    // 为每个缺少 chapterOutline 的子任务匹配对应章节
    let filled = 0;
    for (const subTask of missing) {
      if (!subTask.metadata) subTask.metadata = {};

      // 策略 1：按子任务在数组中的序号匹配（第 1 个子任务 → 第 1 章）
      const taskIndex = allSubTasks.indexOf(subTask);
      let matched: typeof sections[0] | undefined;

      // 策略 2：按 summary 中的章节关键词匹配
      const summaryLower = (subTask.summary ?? "").toLowerCase();
      const chapterNumMatch = summaryLower.match(/第([一二三四五六七八九十\d]+)[章节篇幕]|chapter\s*(\d+)/i);
      if (chapterNumMatch) {
        const numStr = chapterNumMatch[1] || chapterNumMatch[2];
        const num = cnMap[numStr] ?? parseInt(numStr, 10);
        if (!isNaN(num) && num >= 1 && num <= sections.length) {
          matched = sections[num - 1];
        }
      }

      // 策略 3：回退到位置索引
      if (!matched && taskIndex >= 0 && taskIndex < sections.length) {
        matched = sections[taskIndex];
      }

      if (matched) {
        // 截断单章大纲到 1500 字符，避免过长
        subTask.metadata.chapterOutline = matched.content.length > 1500
          ? matched.content.substring(0, 1500) + "\n...[大纲已截断]"
          : matched.content;
        filled++;
      }
    }

    if (filled > 0) {
      console.log(
        `[LLMTaskDecomposer] 📖 O4: masterBlueprint 回退填充 ${filled}/${missing.length} 个子任务的 chapterOutline`,
      );
    }
  }

  /**
   * 解析调整方案响应
   */
  private parseAdjustmentResponse(response: string): TaskTreeChange[] {
    try {
      // 尝试从 JSON 代码块中提取
      const jsonStr = extractJsonFromResponse(response);
      const parsed = JSON.parse(jsonStr);
      
      if (!parsed.changes || !Array.isArray(parsed.changes)) {
        throw new Error("响应格式不正确：缺少 changes 数组");
      }
      
      return parsed.changes as TaskTreeChange[];
    } catch (error) {
      console.error(`[LLMTaskDecomposer] 解析调整方案响应失败:`, error);
      throw new Error(`解析调整方案响应失败: ${error}`);
    }
  }

  /**
   * 解析估算响应
   */
  private parseEstimationResponse(response: string): SubTaskMetadata {
    try {
      // 尝试从 JSON 代码块中提取
      const jsonStr = extractJsonFromResponse(response);
      const parsed = JSON.parse(jsonStr);
      
      return {
        complexity: parsed.complexity || "medium",
        priority: parsed.priority || "medium",
        estimatedDuration: parsed.estimatedDuration || 300000
      };
    } catch (error) {
      console.error(`[LLMTaskDecomposer] 解析估算响应失败:`, error);
      // 返回默认值
      return {
        complexity: "medium",
        priority: "medium",
        estimatedDuration: 300000
      };
    }
  }

  /**
   * 🔧 P9 修复：规范化子任务的依赖 ID
   * 
   * LLM 在 dependencies 中可能返回多种格式的 ID 引用：
   * - 下划线格式：parentId_1（应为 parentId-1）
   * - 纯索引："1"（应为 parentId-1）
   * - 正确格式：parentId-1
   * 
   * 本方法将所有格式统一映射为实际生成的子任务 ID。
   */
  private normalizeDependencyIds(subTasks: SubTask[], parentTask: SubTask): void {
    // 构建多格式 → 实际 ID 的映射表
    const idMap = new Map<string, string>();
    for (let i = 0; i < subTasks.length; i++) {
      const actualId = subTasks[i].id; // parentId-{index+1}
      const idx = i + 1;
      // 下划线格式：parentId_1
      idMap.set(`${parentTask.id}_${idx}`, actualId);
      // 纯索引："1"
      idMap.set(String(idx), actualId);
      // 已正确的格式（不变）
      idMap.set(actualId, actualId);
    }

    let fixedCount = 0;
    let droppedCount = 0;
    for (const task of subTasks) {
      if (!task.dependencies || task.dependencies.length === 0) continue;
      const normalized: string[] = [];
      for (const depId of task.dependencies) {
        const mapped = idMap.get(depId);
        if (mapped) {
          if (mapped !== depId) fixedCount++;
          // 防止自依赖
          if (mapped !== task.id) {
            normalized.push(mapped);
          }
        } else {
          // 未知格式：尝试将下划线替换为连字符后再匹配
          const hyphenized = depId.replace(/_/g, "-");
          const fallback = idMap.get(hyphenized);
          if (fallback && fallback !== task.id) {
            fixedCount++;
            normalized.push(fallback);
          } else {
            droppedCount++;
            console.warn(
              `[LLMTaskDecomposer] ⚠️ P9: 无法解析依赖 ID "${depId}"（任务 ${task.id}），已丢弃`,
            );
          }
        }
      }
      task.dependencies = normalized;
    }
    if (fixedCount > 0 || droppedCount > 0) {
      console.log(
        `[LLMTaskDecomposer] 🔧 P9: 依赖 ID 规范化完成：修正 ${fixedCount} 个，丢弃 ${droppedCount} 个`,
      );
    }
  }

  /**
   * 检测是否为写作任务
   * 
   * 🆕 自动识别需要产生文件的写作任务
   * 
   * @param prompt 任务提示词
   * @param summary 任务摘要
   * @returns 是否为写作任务
   */
  private detectWritingTask(prompt: string, summary: string): boolean {
    const text = `${prompt} ${summary}`.toLowerCase();
    
    // 写作相关关键词
    const writingKeywords = [
      "写", "撰写", "编写", "创作", "起草",
      "文章", "报告", "文档", "说明", "手册",
      "创建文件", "生成文档", "保存为", "输出到文件",
      "write", "create file", "generate document", "save as"
    ];
    
    // 检查是否包含写作关键词
    return writingKeywords.some(keyword => text.includes(keyword));
  }
}
