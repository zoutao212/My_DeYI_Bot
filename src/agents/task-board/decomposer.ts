/**
 * 任务分解器
 * 
 * 负责分析任务复杂度并将复杂任务拆解成可执行的子任务。
 */

import type { SubTask, DecompositionContext } from "./types.js";

/**
 * 任务分解器接口
 */
export interface TaskDecomposer {
  /**
   * 分析任务并判断是否需要拆解
   * @param task 用户提交的任务描述
   * @returns 是否需要拆解
   */
  shouldDecompose(task: string): Promise<boolean>;

  /**
   * 将任务拆解成子任务
   * @param task 用户提交的任务描述
   * @param context 当前上下文（代码库、历史对话等）
   * @returns 子任务列表
   */
  decompose(task: string, context: DecompositionContext): Promise<SubTask[]>;

  /**
   * 根据用户反馈重新拆解任务
   * @param task 原始任务描述
   * @param feedback 用户反馈
   * @param previousDecomposition 之前的拆解结果
   * @returns 新的子任务列表
   */
  redecompose(
    task: string,
    feedback: string,
    previousDecomposition: SubTask[]
  ): Promise<SubTask[]>;
}

/**
 * 默认任务分解器实现
 */
export class DefaultTaskDecomposer implements TaskDecomposer {
  /**
   * 分析任务并判断是否需要拆解
   * 
   * 判断标准：
   * 1. 任务描述长度 > 200 字符
   * 2. 包含多个动词（"创建"、"修改"、"测试"等）
   * 3. 涉及多个文件或模块
   * 4. 用户明确要求拆解
   * 
   * @param task 用户提交的任务描述
   * @returns 是否需要拆解
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
      /\w+\.\w+/g, // 文件名模式（例如：file.ts）
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

    // 默认不拆解
    return false;
  }

  /**
   * 将任务拆解成子任务
   * 
   * 注意：这是一个简化的实现，实际应该使用 LLM 进行智能拆解。
   * 
   * @param task 用户提交的任务描述
   * @param context 当前上下文（代码库、历史对话等）
   * @returns 子任务列表
   */
  async decompose(task: string, context: DecompositionContext): Promise<SubTask[]> {
    // TODO: 这里应该调用 LLM 进行智能拆解
    // 目前返回一个简单的示例拆解
    
    const subTasks: SubTask[] = [
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

    return subTasks;
  }

  /**
   * 根据用户反馈重新拆解任务
   * 
   * @param task 原始任务描述
   * @param feedback 用户反馈
   * @param previousDecomposition 之前的拆解结果
   * @returns 新的子任务列表
   */
  async redecompose(
    task: string,
    feedback: string,
    previousDecomposition: SubTask[]
  ): Promise<SubTask[]> {
    // TODO: 这里应该调用 LLM 根据用户反馈重新拆解
    // 目前返回一个简单的修改版本
    
    // 保留之前的子任务，但根据反馈进行调整
    const newSubTasks = previousDecomposition.map((subTask, index) => ({
      ...subTask,
      description: `${subTask.description} (已根据反馈调整)`
    }));

    return newSubTasks;
  }
}

/**
 * 创建默认的任务分解器实例
 * @returns 任务分解器实例
 */
export function createTaskDecomposer(): TaskDecomposer {
  return new DefaultTaskDecomposer();
}
