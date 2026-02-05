/**
 * LLM 驱动的任务分解器
 * 
 * 使用 LLM 进行智能任务拆解，提供更准确和上下文相关的子任务生成。
 * 
 * 🆕 增强功能：
 * - 递归分解：支持多层嵌套的任务分解
 * - 失败学习：从失败经验中学习并生成改进的分解方案
 * - 复杂度估算：估算任务的复杂度和预计时长
 * - 动态调整：根据质量评估结果生成调整方案
 */

import type { SubTask, DecompositionContext } from "./types.js";
import type { TaskDecomposer } from "./decomposer.js";
import type { 
  FailureRecord, 
  QualityReviewResult, 
  TaskTreeChange,
  SubTask as RecursiveSubTask,
  TaskTree
} from "../intelligent-task-decomposition/types.js";

/**
 * LLM 配置
 */
export interface LLMConfig {
  /** LLM 提供商（例如："openai", "anthropic", "google"） */
  provider: string;
  /** 模型名称 */
  model: string;
  /** API 密钥 */
  apiKey?: string;
  /** API 端点 */
  endpoint?: string;
}

/**
 * LLM 驱动的任务分解器
 */
export class LLMTaskDecomposer implements TaskDecomposer {
  private llmConfig: LLMConfig;

  constructor(llmConfig: LLMConfig) {
    this.llmConfig = llmConfig;
  }

  /**
   * 分析任务并判断是否需要拆解
   */
  async shouldDecompose(task: string): Promise<boolean> {
    // 1. 检查任务描述长度
    if (task.length > 200) {
      return true;
    }

    // 2. 检查是否包含多个动词
    const actionVerbs = [
      "创建", "修改", "删除", "更新", "实现", "添加", "移除",
      "测试", "验证", "检查", "构建", "部署", "发布",
      "重构", "优化", "修复", "调试", "分析", "设计",
      "create", "modify", "delete", "update", "implement", "add", "remove",
      "test", "verify", "check", "build", "deploy", "release",
      "refactor", "optimize", "fix", "debug", "analyze", "design"
    ];

    let verbCount = 0;
    for (const verb of actionVerbs) {
      if (task.includes(verb)) {
        verbCount++;
      }
    }

    if (verbCount >= 3) {
      return true;
    }

    // 3. 检查是否涉及多个文件或模块
    const filePatterns = [
      /\w+\.\w+/g, // 文件名模式
      /src\/\w+/g, // 源代码路径模式
      /\w+\/\w+/g  // 路径模式
    ];

    let fileCount = 0;
    for (const pattern of filePatterns) {
      const matches = task.match(pattern);
      if (matches) {
        fileCount += matches.length;
      }
    }

    if (fileCount >= 3) {
      return true;
    }

    // 4. 检查是否明确要求拆解
    const decompositionKeywords = [
      "拆解", "分解", "分步", "步骤", "阶段",
      "decompose", "break down", "step by step", "phases"
    ];

    for (const keyword of decompositionKeywords) {
      if (task.toLowerCase().includes(keyword.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  /**
   * 将任务拆解成子任务（使用 LLM）
   */
  async decompose(task: string, context: DecompositionContext): Promise<SubTask[]> {
    try {
      // 构建 LLM 提示词
      const prompt = this.buildDecompositionPrompt(task, context);
      
      // 调用 LLM 进行拆解
      const llmResponse = await this.callLLM(prompt);
      
      // 解析 LLM 响应
      const subTasks = this.parseLLMResponse(llmResponse);
      
      // 验证子任务数量（2-8 个）
      if (subTasks.length < 2) {
        return this.getDefaultDecomposition(task);
      }
      
      if (subTasks.length > 8) {
        return subTasks.slice(0, 8);
      }
      
      return subTasks;
    } catch (error) {
      console.error("LLM 任务拆解失败:", error);
      return this.getDefaultDecomposition(task);
    }
  }

  /**
   * 根据用户反馈重新拆解任务（使用 LLM）
   */
  async redecompose(
    task: string,
    feedback: string,
    previousDecomposition: SubTask[]
  ): Promise<SubTask[]> {
    try {
      // 构建重新拆解的提示词
      const prompt = this.buildRedecompositionPrompt(task, feedback, previousDecomposition);
      
      // 调用 LLM 进行重新拆解
      const llmResponse = await this.callLLM(prompt);
      
      // 解析 LLM 响应
      const subTasks = this.parseLLMResponse(llmResponse);
      
      // 验证子任务数量
      if (subTasks.length < 2 || subTasks.length > 8) {
        // 如果新拆解不合理，保留原拆解并稍作调整
        return previousDecomposition.map((subTask, index) => ({
          ...subTask,
          description: `${subTask.description} (已根据反馈调整)`
        }));
      }
      
      return subTasks;
    } catch (error) {
      console.error("LLM 重新拆解失败:", error);
      // 返回原拆解
      return previousDecomposition;
    }
  }

  /**
   * 构建任务拆解的 LLM 提示词
   */
  private buildDecompositionPrompt(task: string, context: DecompositionContext): string {
    const recentContext = context.recentMessages
      .slice(-5)
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    return `你是一个任务分解专家。请将以下任务拆解成 2-8 个可执行的子任务。

任务描述：
${task}

最近的对话上下文：
${recentContext}

代码库路径：${context.codebase}

请按照以下格式返回子任务列表（JSON 格式）：

\`\`\`json
[
  {
    "id": "T1",
    "title": "子任务标题",
    "description": "详细描述",
    "dependencies": [],
    "outputs": ["预期产出1", "预期产出2"]
  }
]
\`\`\`

要求：
1. 每个子任务应该是独立可执行的
2. 子任务之间的依赖关系要明确（dependencies 数组包含依赖的子任务 ID）
3. 子任务标题要简洁明了
4. 子任务描述要详细具体
5. 预期产出要明确可验证
6. 子任务数量在 2-8 个之间
7. 子任务 ID 按顺序命名（T1, T2, T3...）

请只返回 JSON 数组，不要包含其他内容。`;
  }

  /**
   * 构建重新拆解的 LLM 提示词
   */
  private buildRedecompositionPrompt(
    task: string,
    feedback: string,
    previousDecomposition: SubTask[]
  ): string {
    const previousTasksStr = previousDecomposition
      .map(t => `- ${t.id}: ${t.title} - ${t.description}`)
      .join("\n");

    return `你是一个任务分解专家。请根据用户反馈重新拆解以下任务。

原始任务描述：
${task}

之前的拆解结果：
${previousTasksStr}

用户反馈：
${feedback}

请根据用户反馈调整任务拆解，返回新的子任务列表（JSON 格式）：

\`\`\`json
[
  {
    "id": "T1",
    "title": "子任务标题",
    "description": "详细描述",
    "dependencies": [],
    "outputs": ["预期产出1", "预期产出2"]
  }
]
\`\`\`

要求：
1. 根据用户反馈调整子任务
2. 保持子任务数量在 2-8 个之间
3. 确保子任务之间的依赖关系合理
4. 子任务 ID 按顺序命名（T1, T2, T3...）

请只返回 JSON 数组，不要包含其他内容。`;
  }

  /**
   * 调用 LLM 进行任务拆解
   */
  private async callLLM(prompt: string): Promise<string> {
    // TODO: 这里应该调用实际的 LLM API
    // 根据 this.llmConfig.provider 选择相应的 API
    
    // 示例实现（需要根据实际的 LLM 提供商实现）:
    // if (this.llmConfig.provider === "openai") {
    //   return await this.callOpenAI(prompt);
    // } else if (this.llmConfig.provider === "anthropic") {
    //   return await this.callAnthropic(prompt);
    // } else if (this.llmConfig.provider === "google") {
    //   return await this.callGoogle(prompt);
    // }
    
    // 目前返回一个模拟响应
    return `[
  {
    "id": "T1",
    "title": "分析需求",
    "description": "分析任务需求并明确目标",
    "dependencies": [],
    "outputs": ["需求文档", "目标清单"]
  },
  {
    "id": "T2",
    "title": "设计方案",
    "description": "设计技术方案和实现计划",
    "dependencies": ["T1"],
    "outputs": ["设计文档", "实现计划"]
  },
  {
    "id": "T3",
    "title": "实现功能",
    "description": "根据设计方案实现功能",
    "dependencies": ["T2"],
    "outputs": ["源代码", "单元测试"]
  },
  {
    "id": "T4",
    "title": "测试验证",
    "description": "测试功能并验证是否符合需求",
    "dependencies": ["T3"],
    "outputs": ["测试报告", "验证结果"]
  }
]`;
  }

  /**
   * 解析 LLM 响应
   */
  private parseLLMResponse(response: string): SubTask[] {
    try {
      // 提取 JSON 内容（可能被包裹在代码块中）
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/```\s*([\s\S]*?)\s*```/) ||
                       [null, response];
      
      const jsonStr = jsonMatch[1] || response;
      const parsed = JSON.parse(jsonStr.trim());
      
      if (!Array.isArray(parsed)) {
        throw new Error("LLM 响应不是数组");
      }
      
      // 转换为 SubTask 格式
      return parsed.map((item: any, index: number) => ({
        id: item.id || `T${index + 1}`,
        title: item.title || "未命名任务",
        description: item.description || "",
        status: "pending" as const,
        progress: "0%",
        dependencies: Array.isArray(item.dependencies) ? item.dependencies : [],
        outputs: Array.isArray(item.outputs) ? item.outputs : [],
        notes: ""
      }));
    } catch (error) {
      console.error("解析 LLM 响应失败:", error);
      return [];
    }
  }

  /**
   * 获取默认的任务拆解
   */
  private getDefaultDecomposition(task: string): SubTask[] {
    return [
      {
        id: "T1",
        title: "分析需求",
        description: "分析任务需求并明确目标",
        status: "pending",
        progress: "0%",
        dependencies: [],
        outputs: [],
        notes: ""
      },
      {
        id: "T2",
        title: "设计方案",
        description: "设计技术方案和实现计划",
        status: "pending",
        progress: "0%",
        dependencies: ["T1"],
        outputs: [],
        notes: ""
      },
      {
        id: "T3",
        title: "实现功能",
        description: "根据设计方案实现功能",
        status: "pending",
        progress: "0%",
        dependencies: ["T2"],
        outputs: [],
        notes: ""
      },
      {
        id: "T4",
        title: "测试验证",
        description: "测试功能并验证是否符合需求",
        status: "pending",
        progress: "0%",
        dependencies: ["T3"],
        outputs: [],
        notes: ""
      }
    ];
  }

  // ========================================
  // 🆕 递归任务系统新增方法
  // ========================================

  /**
   * 判断子任务是否可以继续分解
   * 
   * 考虑因素：
   * 1. 当前深度是否达到最大深度限制
   * 2. 任务描述的复杂度（长度、动词数量、文件数量）
   * 3. 任务是否明确要求分解
   * 
   * @param subTask 子任务
   * @param currentDepth 当前深度
   * @param maxDepth 最大深度（默认 3）
   * @returns 是否可以继续分解
   */
  async canDecompose(
    subTask: RecursiveSubTask,
    currentDepth: number,
    maxDepth: number = 3
  ): Promise<boolean> {
    // 1. 检查深度限制
    if (currentDepth >= maxDepth) {
      return false;
    }

    // 2. 如果任务已经被标记为不可分解，直接返回 false
    if (subTask.canDecompose === false) {
      return false;
    }

    // 3. 使用现有的 shouldDecompose 方法判断任务复杂度
    const shouldDecompose = await this.shouldDecompose(subTask.prompt);
    
    return shouldDecompose;
  }

  /**
   * 递归分解子任务
   * 
   * 支持多层嵌套的任务分解，每个子任务可以继续分解成更小的子任务。
   * 
   * @param subTask 要分解的子任务
   * @param context 分解上下文
   * @param maxDepth 最大分解深度（默认 3）
   * @param failureHistory 失败历史（可选，用于学习）
   * @returns 分解后的子任务列表
   */
  async decomposeRecursively(
    subTask: RecursiveSubTask,
    context: DecompositionContext,
    maxDepth: number = 3,
    failureHistory?: FailureRecord[]
  ): Promise<RecursiveSubTask[]> {
    const currentDepth = subTask.depth || 0;

    // 1. 检查是否可以继续分解
    const canDecompose = await this.canDecompose(subTask, currentDepth, maxDepth);
    if (!canDecompose) {
      return [];
    }

    try {
      // 2. 如果有失败历史，使用失败学习方法
      let subTasks: SubTask[];
      if (failureHistory && failureHistory.length > 0) {
        subTasks = await this.decomposeWithLessons(subTask.prompt, failureHistory);
      } else {
        // 3. 否则使用标准分解方法
        subTasks = await this.decompose(subTask.prompt, context);
      }

      // 4. 转换为递归子任务格式
      const recursiveSubTasks: RecursiveSubTask[] = subTasks.map((st, index) => ({
        id: `${subTask.id}-${index + 1}`,
        prompt: st.description,
        summary: st.title,
        status: "pending",
        retryCount: 0,
        createdAt: Date.now(),
        parentId: subTask.id,
        depth: currentDepth + 1,
        children: [],
        dependencies: st.dependencies.map(depId => `${subTask.id}-${depId.replace('T', '')}`),
        canDecompose: true,
        decomposed: false,
        qualityReviewEnabled: subTask.qualityReviewEnabled,
        metadata: {
          complexity: "medium",
          priority: "medium"
        }
      }));

      return recursiveSubTasks;
    } catch (error) {
      console.error("递归分解失败:", error);
      return [];
    }
  }

  /**
   * 从失败经验中学习并生成改进的分解方案
   * 
   * 将失败历史作为上下文注入 LLM，生成避免重复错误的分解方案。
   * 
   * @param task 任务描述
   * @param failureHistory 失败历史
   * @returns 改进的子任务列表
   */
  async decomposeWithLessons(
    task: string,
    failureHistory: FailureRecord[]
  ): Promise<SubTask[]> {
    try {
      // 1. 构建包含失败经验的提示词
      const prompt = this.buildDecompositionWithLessonsPrompt(task, failureHistory);
      
      // 2. 调用 LLM 进行分解
      const llmResponse = await this.callLLM(prompt);
      
      // 3. 解析 LLM 响应
      const subTasks = this.parseLLMResponse(llmResponse);
      
      // 4. 验证子任务数量
      if (subTasks.length < 2) {
        return this.getDefaultDecomposition(task);
      }
      
      if (subTasks.length > 8) {
        return subTasks.slice(0, 8);
      }
      
      return subTasks;
    } catch (error) {
      console.error("失败学习分解失败:", error);
      return this.getDefaultDecomposition(task);
    }
  }

  /**
   * 根据质量评估结果生成任务树变更
   * 
   * 将质量评估的改进建议转换为具体的任务树变更操作。
   * 
   * @param taskTree 任务树
   * @param review 质量评估结果
   * @returns 任务树变更列表
   */
  async generateAdjustments(
    taskTree: TaskTree,
    review: QualityReviewResult
  ): Promise<TaskTreeChange[]> {
    try {
      // 1. 构建生成调整方案的提示词
      const prompt = this.buildAdjustmentPrompt(taskTree, review);
      
      // 2. 调用 LLM 生成调整方案
      const llmResponse = await this.callLLM(prompt);
      
      // 3. 解析 LLM 响应
      const changes = this.parseAdjustmentResponse(llmResponse);
      
      return changes;
    } catch (error) {
      console.error("生成调整方案失败:", error);
      return [];
    }
  }

  /**
   * 估算任务的复杂度和预计时长
   * 
   * 基于任务描述和历史数据估算任务的复杂度和预计时长。
   * 
   * @param subTask 子任务
   * @returns 复杂度和预计时长
   */
  async estimateTask(subTask: RecursiveSubTask): Promise<{
    complexity: "low" | "medium" | "high";
    estimatedDuration: number;
  }> {
    try {
      // 1. 基于任务描述长度估算复杂度
      const descriptionLength = subTask.prompt.length;
      let complexity: "low" | "medium" | "high";
      let estimatedDuration: number;

      if (descriptionLength < 100) {
        complexity = "low";
        estimatedDuration = 5 * 60 * 1000; // 5 分钟
      } else if (descriptionLength < 300) {
        complexity = "medium";
        estimatedDuration = 15 * 60 * 1000; // 15 分钟
      } else {
        complexity = "high";
        estimatedDuration = 30 * 60 * 1000; // 30 分钟
      }

      // 2. 根据子任务数量调整估算
      if (subTask.children && subTask.children.length > 0) {
        estimatedDuration *= subTask.children.length;
      }

      return { complexity, estimatedDuration };
    } catch (error) {
      console.error("估算任务失败:", error);
      return {
        complexity: "medium",
        estimatedDuration: 15 * 60 * 1000
      };
    }
  }

  // ========================================
  // 🆕 私有辅助方法
  // ========================================

  /**
   * 构建包含失败经验的分解提示词
   */
  private buildDecompositionWithLessonsPrompt(
    task: string,
    failureHistory: FailureRecord[]
  ): string {
    const lessonsStr = failureHistory
      .map((failure, index) => {
        return `
失败 ${index + 1}：
- 原因：${failure.reason}
- 上下文：${failure.context}
- 教训：${failure.lessons.join("; ")}
- 改进建议：${failure.improvements.join("; ")}
`;
      })
      .join("\n");

    return `你是一个任务分解专家。请将以下任务拆解成 2-8 个可执行的子任务。

任务描述：
${task}

⚠️ 重要：以下是之前失败的经验，请务必避免重复这些错误：

${lessonsStr}

请按照以下格式返回子任务列表（JSON 格式）：

\`\`\`json
[
  {
    "id": "T1",
    "title": "子任务标题",
    "description": "详细描述",
    "dependencies": [],
    "outputs": ["预期产出1", "预期产出2"]
  }
]
\`\`\`

要求：
1. 每个子任务应该是独立可执行的
2. 子任务之间的依赖关系要明确
3. 子任务标题要简洁明了
4. 子任务描述要详细具体
5. 预期产出要明确可验证
6. 子任务数量在 2-8 个之间
7. **务必避免之前失败的错误**
8. **应用失败经验中的改进建议**

请只返回 JSON 数组，不要包含其他内容。`;
  }

  /**
   * 构建生成调整方案的提示词
   */
  private buildAdjustmentPrompt(
    taskTree: TaskTree,
    review: QualityReviewResult
  ): string {
    const subTasksStr = taskTree.subTasks
      .map(st => `- ${st.id}: ${st.summary} (${st.status})`)
      .join("\n");

    const findingsStr = review.findings.join("\n- ");
    const suggestionsStr = review.suggestions.join("\n- ");

    return `你是一个任务调整专家。请根据质量评估结果生成任务树调整方案。

当前任务树：
根任务：${taskTree.rootTask}
子任务：
${subTasksStr}

质量评估结果：
发现的问题：
- ${findingsStr}

改进建议：
- ${suggestionsStr}

请生成具体的调整方案（JSON 格式）：

\`\`\`json
[
  {
    "type": "add_task" | "remove_task" | "modify_task" | "move_task" | "merge_tasks" | "split_task",
    "targetId": "目标任务 ID",
    "before": "变更前的值（可选）",
    "after": "变更后的值",
    "timestamp": ${Date.now()}
  }
]
\`\`\`

变更类型说明：
- add_task: 添加新任务（after 包含新任务的完整信息）
- remove_task: 删除任务（targetId 是要删除的任务 ID）
- modify_task: 修改任务（after 包含要修改的字段）
- move_task: 移动任务到新的父任务（after 包含新的 parentId）
- merge_tasks: 合并多个任务（targetId 是合并后的任务 ID，after 包含要合并的任务 ID 列表）
- split_task: 拆分任务（targetId 是要拆分的任务 ID，after 包含拆分后的新任务列表）

请只返回 JSON 数组，不要包含其他内容。`;
  }

  /**
   * 解析调整方案响应
   */
  private parseAdjustmentResponse(response: string): TaskTreeChange[] {
    try {
      // 提取 JSON 内容
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                       response.match(/```\s*([\s\S]*?)\s*```/) ||
                       [null, response];
      
      const jsonStr = jsonMatch[1] || response;
      const parsed = JSON.parse(jsonStr.trim());
      
      if (!Array.isArray(parsed)) {
        throw new Error("LLM 响应不是数组");
      }
      
      return parsed as TaskTreeChange[];
    } catch (error) {
      console.error("解析调整方案失败:", error);
      return [];
    }
  }
}

/**
 * 创建 LLM 驱动的任务分解器实例
 * @param llmConfig LLM 配置
 * @returns 任务分解器实例
 */
export function createLLMTaskDecomposer(llmConfig: LLMConfig): TaskDecomposer {
  return new LLMTaskDecomposer(llmConfig);
}
