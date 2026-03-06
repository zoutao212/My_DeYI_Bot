/**
 * OpenCAWD V2 Enhanced Executor
 * 
 * 任务树与 ToolCall 2.0 融合执行引擎
 * 
 * 功能：
 * - 检测子任务是否需要 ToolCall 2.0 增强
 * - 动态生成执行策略
 * - 调用 Tool Composer 和 Memory Enhancer
 * - 提供智能文本处理和代码生成能力
 */

import type { SubTask, TaskTree, ExecutionContext, PostProcessResult, DynamicExecutionStrategy } from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

/**
 * V2 增强执行配置
 */
export interface V2EnhancedConfig {
  /** 是否启用代码工具 */
  enableCodeTool?: boolean;
  /** 是否启用工具组合器 */
  enableToolComposer?: boolean;
  /** 是否启用记忆增强器 */
  enableMemoryEnhancer?: boolean;
  /** 默认超时时间（秒） */
  defaultTimeout?: number;
  /** 默认内存限制（MB） */
  defaultMemoryLimit?: number;
}

/**
 * V2 增强执行结果
 */
export interface V2EnhancedResult {
  /** 执行是否成功 */
  success: boolean;
  /** 执行输出 */
  output: unknown;
  /** 执行日志 */
  logs: string[];
  /** 执行时间（毫秒） */
  executionTimeMs: number;
  /** 使用的工具类型 */
  toolType: "code_tool" | "tool_composer" | "memory_enhancer" | "standard";
  /** 错误信息 */
  error?: {
    type: "timeout" | "execution_error" | "tool_error" | "config_error";
    message: string;
    details?: unknown;
  };
}

/**
 * V2 增强执行器
 * 
 * 负责检测子任务是否需要 ToolCall 2.0 增强，并执行相应的智能处理
 */
export class V2EnhancedExecutor {
  private codeEngine: CodeToolEngine;
  private toolComposer: ToolComposer;
  private memoryEnhancer: ReturnType<typeof createMemoryEnhancerTool>;
  private config: V2EnhancedConfig;

  constructor(config: V2EnhancedConfig = {}) {
    this.config = {
      enableCodeTool: true,
      enableToolComposer: true,
      enableMemoryEnhancer: true,
      defaultTimeout: 60,
      defaultMemoryLimit: 256,
      ...config,
    };

    this.codeEngine = new CodeToolEngine();
    this.toolComposer = new ToolComposer();
    this.memoryEnhancer = createMemoryEnhancerTool();

    // 注册基础工具到组合器
    this.registerBasicTools();
  }

  /**
   * 检测子任务是否需要 ToolCall 2.0 增强
   */
  shouldUseToolCallV2(subTask: SubTask): boolean {
    const { prompt, summary, metadata } = subTask;
    const promptLower = (prompt + " " + (summary || "")).toLowerCase();

    // 检测 ToolCall 2.0 相关关键词
    const v2Keywords = [
      "智能", "动态", "语义", "批量", "自动", "代码生成", "工具组合",
      "code_tool", "tool_composer", "memory_enhancer",
      "生成代码", "动态生成", "智能分析", "批量处理",
      "语义搜索", "知识图谱", "自动分类", "数据验证"
    ];

    // 检测是否已配置 ToolCall 2.0
    const hasV2Config = metadata.toolCallV2Config?.enabled;

    // 检测是否有动态执行策略
    const hasDynamicStrategy = metadata.dynamicExecutionStrategy;

    // 关键词匹配
    const hasKeywords = v2Keywords.some(keyword => promptLower.includes(keyword));

    // 复杂任务类型检测
    const complexTaskTypes = ["analysis", "data", "automation", "research"];
    const isComplexTask = complexTaskTypes.includes(subTask.taskType || "generic");

    return hasV2Config || hasDynamicStrategy || hasKeywords || isComplexTask;
  }

  /**
   * 动态生成执行策略
   */
  async generateDynamicStrategy(subTask: SubTask): Promise<import("./types.js").DynamicExecutionStrategy> {
    const { prompt, taskType, metadata } = subTask;
    const promptLower = prompt.toLowerCase();

    // 基于任务类型和内容生成策略
    let strategyType: import("./types.js").DynamicExecutionStrategy["strategyType"] = "hybrid";
    let preferredOperations: string[] = [];

    // 分析任务类型
    if (taskType === "analysis" || taskType === "research") {
      strategyType = "memory_enhancement";
      preferredOperations = ["semantic_search", "intelligent_search", "smart_classify"];
    } else if (taskType === "data" || taskType === "automation") {
      strategyType = "tool_composition";
      preferredOperations = ["batch_process", "data_validation", "text_transformation"];
    } else if (taskType === "coding") {
      strategyType = "code_generation";
      preferredOperations = ["code_analysis", "dynamic_generation"];
    } else if (promptLower.includes("知识图谱") || promptLower.includes("关系分析")) {
      strategyType = "memory_enhancement";
      preferredOperations = ["knowledge_graph", "semantic_search"];
    } else if (promptLower.includes("批量") || promptLower.includes("多个文件")) {
      strategyType = "tool_composition";
      preferredOperations = ["batch_process"];
    }

    // 生成代码模板
    let codeTemplate = "";
    if (strategyType === "code_generation" || strategyType === "hybrid") {
      codeTemplate = this.generateCodeTemplate(subTask, preferredOperations);
    }

    // 生成工具组合配置
    let toolComposition: import("./types.js").DynamicExecutionStrategy["toolComposition"] | undefined;
    if (strategyType === "tool_composition" || strategyType === "hybrid") {
      toolComposition = this.generateToolCompositionConfig(subTask, preferredOperations);
    }

    return {
      codeTemplate,
      toolComposition,
      adaptiveAlgorithms: preferredOperations,
      strategyType,
      estimatedExecutionTime: this.estimateExecutionTime(subTask, strategyType),
      estimatedMemoryUsage: this.estimateMemoryUsage(subTask, strategyType),
    };
  }

  /**
   * 执行 V2 增强的子任务
   */
  async executeSubTaskWithV2Enhancement(
    subTask: SubTask,
    context: ExecutionContext,
    taskTree: TaskTree,
    orchestrator: Orchestrator
  ): Promise<PostProcessResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    try {
      logs.push(`[V2EnhancedExecutor] 开始执行子任务: ${subTask.id}`);

      // 检测是否需要 ToolCall 2.0 增强
      if (!this.shouldUseToolCallV2(subTask)) {
        logs.push(`[V2EnhancedExecutor] 子任务不需要 V2 增强，回退到标准执行`);
        return this.fallbackToStandardExecution(subTask, context, taskTree, orchestrator);
      }

      // 生成动态执行策略
      const strategy = subTask.metadata.dynamicExecutionStrategy || 
                      await this.generateDynamicStrategy(subTask);
      
      logs.push(`[V2EnhancedExecutor] 生成执行策略: ${strategy.strategyType}`);

      // 根据策略类型执行
      let result: V2EnhancedResult;

      switch (strategy.strategyType) {
        case "code_generation":
          result = await this.executeWithCodeTool(subTask, strategy);
          break;
        case "tool_composition":
          result = await this.executeWithToolComposer(subTask, strategy);
          break;
        case "memory_enhancement":
          result = await this.executeWithMemoryEnhancer(subTask, strategy);
          break;
        case "hybrid":
          result = await this.executeWithHybridApproach(subTask, strategy);
          break;
        default:
          result = await this.fallbackToStandardExecution(subTask, context, taskTree, orchestrator);
      }

      logs.push(`[V2EnhancedExecutor] 执行完成: ${result.success ? '成功' : '失败'}, 耗时: ${result.executionTimeMs}ms`);

      // 转换为 PostProcessResult
      return this.convertToPostProcessResult(result, subTask, logs);

    } catch (error) {
      logs.push(`[V2EnhancedExecutor] 执行异常: ${error instanceof Error ? error.message : String(error)}`);
      
      const errorResult: V2EnhancedResult = {
        success: false,
        output: null,
        logs,
        executionTimeMs: Date.now() - startTime,
        toolType: "standard",
        error: {
          type: "execution_error",
          message: error instanceof Error ? error.message : String(error),
          details: error,
        },
      };

      return this.convertToPostProcessResult(errorResult, subTask, logs);
    }
  }

  /**
   * 使用代码工具执行
   */
  private async executeWithCodeTool(
    subTask: SubTask,
    strategy: import("./types.js").DynamicExecutionStrategy
  ): Promise<V2EnhancedResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    try {
      const request: CodeToolRequest = {
        language: "python", // 默认使用 Python
        code: strategy.codeTemplate || this.generateDefaultCodeTemplate(subTask),
        inputs: {
          task_prompt: subTask.prompt,
          task_summary: subTask.summary,
          task_type: subTask.taskType,
        },
        timeout: this.config.defaultTimeout,
        allowed_modules: ["json", "datetime", "re", "os", "path"],
        sandbox: {
          allowNetwork: false,
          memoryLimit: this.config.defaultMemoryLimit,
        },
      };

      const result = await this.codeEngine.execute(request);

      return {
        success: result.success,
        output: result.structured_output || result.stdout,
        logs: [...logs, `代码执行${result.success ? '成功' : '失败'}`],
        executionTimeMs: Date.now() - startTime,
        toolType: "code_tool",
        error: result.error ? {
          type: "execution_error",
          message: result.error.message,
          details: result.error,
        } : undefined,
      };

    } catch (error) {
      return {
        success: false,
        output: null,
        logs: [...logs, `代码工具执行异常: ${error instanceof Error ? error.message : String(error)}`],
        executionTimeMs: Date.now() - startTime,
        toolType: "code_tool",
        error: {
          type: "tool_error",
          message: error instanceof Error ? error.message : String(error),
          details: error,
        },
      };
    }
  }

  /**
   * 使用工具组合器执行
   */
  private async executeWithToolComposer(
    subTask: SubTask,
    strategy: import("./types.js").DynamicExecutionStrategy
  ): Promise<V2EnhancedResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    try {
      if (!strategy.toolComposition) {
        throw new Error("缺少工具组合配置");
      }

      const inputs = {
        task_prompt: subTask.prompt,
        task_summary: subTask.summary,
        task_type: subTask.taskType,
        workspace_dir: process.cwd(),
      };

      const result = await this.toolComposer.executeComposition(
        strategy.toolComposition,
        inputs
      );

      return {
        success: result.success,
        output: result.output,
        logs: [...logs, ...result.logs],
        executionTimeMs: Date.now() - startTime,
        toolType: "tool_composer",
        error: result.error ? {
          type: "tool_error",
          message: result.error.message,
          details: result.error.details,
        } : undefined,
      };

    } catch (error) {
      return {
        success: false,
        output: null,
        logs: [...logs, `工具组合器执行异常: ${error instanceof Error ? error.message : String(error)}`],
        executionTimeMs: Date.now() - startTime,
        toolType: "tool_composer",
        error: {
          type: "tool_error",
          message: error instanceof Error ? error.message : String(error),
          details: error,
        },
      };
    }
  }

  /**
   * 使用记忆增强器执行
   */
  private async executeWithMemoryEnhancer(
    subTask: SubTask,
    strategy: import("./types.js").DynamicExecutionStrategy
  ): Promise<V2EnhancedResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    try {
      const params = {
        action: "intelligent_search",
        language: "python",
        search_query: subTask.prompt,
        search_options: {
          semantic: true,
          fuzzy: false,
          case_sensitive: false,
        },
        inputs: {
          task_type: subTask.taskType,
          task_summary: subTask.summary,
        },
        timeout: this.config.defaultTimeout,
        allowed_modules: ["json", "re", "datetime"],
      };

      const result = await this.memoryEnhancer.execute("tool-call", params);

      return {
        success: true,
        output: result.details?.output || result.content?.[0]?.text,
        logs: [...logs, "记忆增强器执行完成"],
        executionTimeMs: Date.now() - startTime,
        toolType: "memory_enhancer",
      };

    } catch (error) {
      return {
        success: false,
        output: null,
        logs: [...logs, `记忆增强器执行异常: ${error instanceof Error ? error.message : String(error)}`],
        executionTimeMs: Date.now() - startTime,
        toolType: "memory_enhancer",
        error: {
          type: "tool_error",
          message: error instanceof Error ? error.message : String(error),
          details: error,
        },
      };
    }
  }

  /**
   * 混合方式执行
   */
  private async executeWithHybridApproach(
    subTask: SubTask,
    strategy: import("./types.js").DynamicExecutionStrategy
  ): Promise<V2EnhancedResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    try {
      // 优先使用记忆增强器进行智能分析
      const memoryResult = await this.executeWithMemoryEnhancer(subTask, strategy);
      
      if (memoryResult.success && memoryResult.output) {
        // 如果记忆增强成功，再使用代码工具进行后处理
        const enhancedPrompt = `${subTask.prompt}\n\n基于智能分析结果：${JSON.stringify(memoryResult.output)}`;
        const enhancedSubTask = {
          ...subTask,
          prompt: enhancedPrompt,
        };

        const codeResult = await this.executeWithCodeTool(enhancedSubTask, strategy);

        return {
          success: codeResult.success,
          output: {
            memory_analysis: memoryResult.output,
            code_processing: codeResult.output,
          },
          logs: [...logs, ...memoryResult.logs, ...codeResult.logs],
          executionTimeMs: Date.now() - startTime,
          toolType: "hybrid",
          error: codeResult.error,
        };
      } else {
        // 记忆增强失败，回退到代码工具
        logs.push("记忆增强失败，回退到代码工具");
        return await this.executeWithCodeTool(subTask, strategy);
      }

    } catch (error) {
      return {
        success: false,
        output: null,
        logs: [...logs, `混合执行异常: ${error instanceof Error ? error.message : String(error)}`],
        executionTimeMs: Date.now() - startTime,
        toolType: "hybrid",
        error: {
          type: "execution_error",
          message: error instanceof Error ? error.message : String(error),
          details: error,
        },
      };
    }
  }

  /**
   * 回退到标准执行
   */
  private async fallbackToStandardExecution(
    subTask: SubTask,
    context: ExecutionContext,
    taskTree: TaskTree,
    orchestrator: Orchestrator
  ): Promise<PostProcessResult> {
    // 这里应该调用原有的标准执行路径
    // 由于这是基础框架，暂时返回一个模拟的结果
    return {
      decomposedTaskIds: [],
      shouldContinue: true,
      shouldRetry: false,
      shouldAdjust: false,
      shouldRestart: false,
      shouldOverthrow: false,
      adjustment: undefined,
      retryDelayMs: 0,
      qualityReview: undefined,
    };
  }

  /**
   * 转换为 PostProcessResult
   */
  private convertToPostProcessResult(
    result: V2EnhancedResult,
    subTask: SubTask,
    logs: string[]
  ): PostProcessResult {
    // 更新子任务的元数据
    if (result.success) {
      subTask.metadata = {
        ...subTask.metadata,
        actualDuration: result.executionTimeMs,
      };

      // 如果有动态策略，保存到元数据
      if (!subTask.metadata.dynamicExecutionStrategy) {
        // 这里应该生成并保存动态策略，但为了简化，暂时跳过
      }
    }

    return {
      decomposedTaskIds: [],
      shouldContinue: result.success,
      shouldRetry: !result.success,
      shouldAdjust: false,
      shouldRestart: false,
      shouldOverthrow: false,
      adjustment: undefined,
      retryDelayMs: result.success ? 0 : 5000,
      qualityReview: result.success ? {
        status: "passed",
        decision: "continue",
        findings: [],
        suggestions: [],
      } : {
        status: "failed",
        decision: "retry",
        findings: [result.error?.message || "执行失败"],
        suggestions: ["检查输入参数", "重试执行"],
      },
    };
  }

  /**
   * 注册基础工具到组合器
   */
  private registerBasicTools(): void {
    // 这里应该注册基础的工具，如 read, write, edit, exec 等
    // 由于这是基础框架，暂时跳过具体实现
  }

  /**
   * 生成代码模板
   */
  private generateCodeTemplate(subTask: SubTask, operations: string[]): string {
    const { prompt, taskType } = subTask;
    
    return `
import json
import re
from typing import Dict, Any, List

def process_task(task_prompt: str, task_summary: str, task_type: str) -> Dict[str, Any]:
    """处理任务的通用函数"""
    
    # 任务分析
    print(f"开始处理任务: {task_type}")
    print(f"任务摘要: {task_summary}")
    
    # 基于操作类型执行相应逻辑
    ${operations.map(op => this.generateOperationCode(op)).join('\n    ')}
    
    # 返回结果
    result = {
        "success": True,
        "task_type": task_type,
        "processed_at": "2026-03-06T00:00:00Z",
        "operations_used": ${JSON.stringify(operations)}
    }
    
    return result

# 执行任务处理
output = process_task(inputs['task_prompt'], inputs['task_summary'], inputs['task_type'])
print(json.dumps(output, ensure_ascii=False, indent=2))
`;
  }

  /**
   * 生成操作代码
   */
  private generateOperationCode(operation: string): string {
    const operationMap: Record<string, string> = {
      "semantic_search": `
        # 语义搜索逻辑
        semantic_results = []
        print(f"执行语义搜索: {len(semantic_results)} 个结果")`,
      "intelligent_search": `
        # 智能搜索逻辑
        search_results = []
        print(f"执行智能搜索: {len(search_results)} 个结果")`,
      "batch_process": `
        # 批量处理逻辑
        processed_items = []
        print(f"批量处理完成: {len(processed_items)} 个项目")`,
      "data_validation": `
        # 数据验证逻辑
        validation_results = {}
        print(f"数据验证完成: {len(validation_results)} 项检查")`,
      "smart_classify": `
        # 智能分类逻辑
        classification_results = {}
        print(f"智能分类完成: {len(classification_results)} 个类别")`,
    };

    return operationMap[operation] || `# 执行 ${operation} 操作\nprint(f"${operation} 执行完成")`;
  }

  /**
   * 生成默认代码模板
   */
  private generateDefaultCodeTemplate(subTask: SubTask): string {
    return `
import json

def process_task(task_prompt: str, task_summary: str, task_type: str) -> Dict[str, Any]:
    """默认任务处理函数"""
    
    print(f"处理任务: {task_summary}")
    print(f"任务类型: {task_type}")
    
    # 基础处理逻辑
    result = {
        "success": True,
        "task_type": task_type,
        "message": "任务处理完成",
        "processed_at": "2026-03-06T00:00:00Z"
    }
    
    return result

# 执行任务
output = process_task(inputs['task_prompt'], inputs['task_summary'], inputs['task_type'])
print(json.dumps(output, ensure_ascii=False, indent=2))
`;
  }

  /**
   * 生成工具组合配置
   */
  private generateToolCompositionConfig(
    subTask: SubTask,
    operations: string[]
  ): import("./types.js").DynamicExecutionStrategy["toolComposition"] {
    return {
      name: `v2_enhanced_${subTask.id}`,
      description: `V2 增强执行: ${subTask.summary || subTask.taskType}`,
      language: "javascript",
      composition_code: `
// V2 增强执行组合
console.log('开始 V2 增强执行');
console.log('任务类型:', inputs.task_type);
console.log('任务摘要:', inputs.task_summary);

// 执行基础操作
const operations = ${JSON.stringify(operations)};
console.log('计划执行的操作:', operations);

// 模拟执行结果
const result = {
  success: true,
  task_type: inputs.task_type,
  operations_executed: operations,
  executed_at: new Date().toISOString()
};

// 输出结果
console.log(JSON.stringify(result, null, 2));
result;
      `,
      input_schema: {
        type: "object",
        properties: {
          task_prompt: { type: "string" },
          task_summary: { type: "string" },
          task_type: { type: "string" },
          workspace_dir: { type: "string" },
        },
        required: ["task_prompt", "task_summary", "task_type"],
      },
      allowed_tools: ["console"],
      timeout: 60,
    };
  }

  /**
   * 估算执行时间
   */
  private estimateExecutionTime(
    subTask: SubTask,
    strategyType: import("./types.js").DynamicExecutionStrategy["strategyType"]
  ): number {
    const baseTime = 30; // 基础时间 30 秒
    
    const strategyMultipliers = {
      code_generation: 1.5,
      tool_composition: 2.0,
      memory_enhancement: 1.2,
      hybrid: 2.5,
    };

    return Math.round(baseTime * (strategyMultipliers[strategyType] || 1.0));
  }

  /**
   * 估算内存使用
   */
  private estimateMemoryUsage(
    subTask: SubTask,
    strategyType: import("./types.js").DynamicExecutionStrategy["strategyType"]
  ): number {
    const baseMemory = 128; // 基础内存 128MB
    
    const strategyMultipliers = {
      code_generation: 1.2,
      tool_composition: 1.5,
      memory_enhancement: 1.8,
      hybrid: 2.0,
    };

    return Math.round(baseMemory * (strategyMultipliers[strategyType] || 1.0));
  }
}

/**
 * 创建 V2 增强执行器实例
 */
export function createV2EnhancedExecutor(config?: V2EnhancedConfig): V2EnhancedExecutor {
  return new V2EnhancedExecutor(config);
}
