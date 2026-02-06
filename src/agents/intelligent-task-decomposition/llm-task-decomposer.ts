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
 * LLM 任务分解器
 */
export class LLMTaskDecomposer {
  private llmConfig: LLMConfig;

  constructor(llmConfig: LLMConfig) {
    this.llmConfig = llmConfig;
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

    // 3. 调用 LLM 进行分解
    const llmResponse = await this.callLLM(prompt);

    // 4. 解析分解结果
    const decomposedTasks = this.parseDecompositionResponse(llmResponse, subTask);

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
    
    return `${prompts.decompositionExpertRole} ${prompts.decompositionInstruction}

${prompts.rootTaskLabel}：${taskTree.rootTask}

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
      "dependencies": ["依赖的任务 ID"],
      "canDecompose": true,
      "metadata": {
        "complexity": "low" | "medium" | "high",
        "priority": "low" | "medium" | "high",
        "estimatedDuration": 300000
      }
    }
  ]
}
\`\`\`

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

    return `${prompts.decompositionExpertRole} ${prompts.decompositionInstruction}

${prompts.rootTaskLabel}：${taskTree.rootTask}

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
      "dependencies": ["依赖的任务 ID"],
      "canDecompose": true,
      "metadata": {
        "complexity": "low" | "medium" | "high",
        "priority": "low" | "medium" | "high",
        "estimatedDuration": 300000
      }
    }
  ]
}
\`\`\`

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
    // TODO: 实现实际的 LLM 调用
    // 这里需要集成到现有的 LLM 调用系统
    // 暂时返回一个模拟响应
    console.log(`[LLMTaskDecomposer] 调用 LLM，提示词长度: ${prompt.length}`);
    
    // 模拟响应
    return `{
  "subTasks": [
    {
      "summary": "子任务 1",
      "prompt": "子任务 1 的详细描述",
      "dependencies": [],
      "canDecompose": true,
      "metadata": {
        "complexity": "medium",
        "priority": "high",
        "estimatedDuration": 300000
      }
    },
    {
      "summary": "子任务 2",
      "prompt": "子任务 2 的详细描述",
      "dependencies": [],
      "canDecompose": true,
      "metadata": {
        "complexity": "medium",
        "priority": "medium",
        "estimatedDuration": 300000
      }
    }
  ]
}`;
  }

  /**
   * 解析分解响应
   */
  private parseDecompositionResponse(response: string, parentTask: SubTask): SubTask[] {
    try {
      // 尝试从 JSON 代码块中提取
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/```\s*([\s\S]*?)\s*```/) ||
                       [null, response];
      
      const jsonStr = jsonMatch[1] || response;
      const parsed = JSON.parse(jsonStr.trim());
      
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
        
        // 🆕 自动识别写作任务并标记
        const isWritingTask = this.detectWritingTask(subTask.prompt, subTask.summary);
        if (isWritingTask) {
          subTask.metadata = {
            ...subTask.metadata,
            requiresFileOutput: true,
            expectedFileTypes: ["txt", "md", "doc", "docx", "pdf"]
          };
          console.log(`[LLMTaskDecomposer] 📝 检测到写作任务：${subTask.summary}`);
        }
        
        return subTask;
      });
      
      return subTasks;
    } catch (error) {
      console.error(`[LLMTaskDecomposer] 解析分解响应失败:`, error);
      throw new Error(`解析分解响应失败: ${error}`);
    }
  }

  /**
   * 解析调整方案响应
   */
  private parseAdjustmentResponse(response: string): TaskTreeChange[] {
    try {
      // 尝试从 JSON 代码块中提取
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/```\s*([\s\S]*?)\s*```/) ||
                       [null, response];
      
      const jsonStr = jsonMatch[1] || response;
      const parsed = JSON.parse(jsonStr.trim());
      
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
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/```\s*([\s\S]*?)\s*```/) ||
                       [null, response];
      
      const jsonStr = jsonMatch[1] || response;
      const parsed = JSON.parse(jsonStr.trim());
      
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
