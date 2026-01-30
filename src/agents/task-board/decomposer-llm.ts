/**
 * LLM 驱动的任务分解器
 * 
 * 使用 LLM 进行智能任务拆解，提供更准确和上下文相关的子任务生成。
 */

import type { SubTask, DecompositionContext } from "./types.js";
import type { TaskDecomposer } from "./decomposer.js";

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
}

/**
 * 创建 LLM 驱动的任务分解器实例
 * @param llmConfig LLM 配置
 * @returns 任务分解器实例
 */
export function createLLMTaskDecomposer(llmConfig: LLMConfig): TaskDecomposer {
  return new LLMTaskDecomposer(llmConfig);
}
