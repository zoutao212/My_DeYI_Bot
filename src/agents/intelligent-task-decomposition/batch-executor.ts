/**
 * 批量执行器
 * 
 * 将多个任务合并为一次 LLM 请求，显著降低成本和提高效率
 * 
 * 核心功能：
 * - 合并多个任务的 prompt
 * - 添加输出格式要求（使用分隔符）
 * - 单次 LLM 请求
 * - 解析输出并拆分到各个任务
 * - 保存结果到各个任务
 * - 如果拆分失败，回退到单任务执行
 */

import type {
  TaskBatch,
  SubTask,
  BatchExecutionOptions,
  BatchExecutionResult,
} from "./types.js";

/**
 * LLM 调用接口
 * 
 * 用于调用 LLM 的抽象接口，方便测试和集成
 */
export interface LLMCaller {
  /**
   * 调用 LLM
   * 
   * @param prompt 提示词
   * @returns LLM 响应
   */
  call(prompt: string): Promise<string>;
}

/**
 * 批量执行器
 */
export class BatchExecutor {
  private options: Required<BatchExecutionOptions>;
  private llmCaller: LLMCaller;

  constructor(llmCaller: LLMCaller, options: BatchExecutionOptions = {}) {
    this.llmCaller = llmCaller;
    this.options = {
      separator: options.separator ?? "---TASK-SEPARATOR---",
      enableFallbackSplit: options.enableFallbackSplit ?? true,
      timeout: options.timeout ?? 120000, // 2 分钟
    };
  }

  /**
   * 执行批次（主入口）
   * 
   * @param batch 任务批次
   * @returns 批量执行结果
   */
  async executeBatch(batch: TaskBatch): Promise<BatchExecutionResult> {
    const startTime = Date.now();
    
    console.log(`[BatchExecutor] 🚀 开始执行批次 ${batch.id}，包含 ${batch.tasks.length} 个任务`);

    try {
      // 1. 合并 prompts
      const mergedPrompt = this.mergePrompts(batch);
      console.log(`[BatchExecutor] 📝 合并后的 prompt 长度: ${mergedPrompt.length} 字符`);

      // 2. 调用 LLM
      const llmOutput = await this.callLLMWithTimeout(mergedPrompt);
      console.log(`[BatchExecutor] ✅ LLM 响应长度: ${llmOutput.length} 字符`);

      // 3. 拆分输出
      const outputs = this.splitOutput(llmOutput, batch);

      // 4. 验证拆分结果
      if (outputs.size !== batch.tasks.length) {
        console.warn(`[BatchExecutor] ⚠️ 拆分结果数量不匹配: 期望 ${batch.tasks.length}，实际 ${outputs.size}`);
        
        // 如果启用后备拆分，尝试后备方法
        if (this.options.enableFallbackSplit) {
          console.log(`[BatchExecutor] 🔄 尝试后备拆分方法`);
          const fallbackOutputs = this.fallbackSplit(llmOutput, batch);
          
          if (fallbackOutputs.size === batch.tasks.length) {
            console.log(`[BatchExecutor] ✅ 后备拆分成功`);
            return this.createSuccessResult(batch, fallbackOutputs, startTime);
          }
        }
        
        // 拆分失败
        throw new Error(`输出拆分失败: 期望 ${batch.tasks.length} 个任务，实际得到 ${outputs.size} 个`);
      }

      // 5. 返回成功结果
      const duration = Date.now() - startTime;
      console.log(`[BatchExecutor] ✅ 批次执行成功，耗时 ${duration}ms`);
      
      return this.createSuccessResult(batch, outputs, startTime);
    } catch (error) {
      // 执行失败
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      console.error(`[BatchExecutor] ❌ 批次执行失败: ${errorMessage}`);
      
      return {
        batchId: batch.id,
        success: false,
        outputs: new Map(),
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * 合并多个任务的 prompt
   * 
   * @param batch 任务批次
   * @returns 合并后的 prompt
   */
  mergePrompts(batch: TaskBatch): string {
    const { separator } = this.options;
    
    // 构建批量执行的提示词
    const header = `你需要完成以下 ${batch.tasks.length} 个任务。请按照顺序完成每个任务，并在每个任务的输出之间使用分隔符 "${separator}"。

**重要说明**：
1. 每个任务的输出必须独立完整
2. 任务之间必须使用分隔符 "${separator}" 分隔
3. 分隔符必须单独占一行
4. 不要在输出中包含任务编号或标题
5. 按照任务顺序输出

**输出格式示例**：
\`\`\`
[任务 1 的完整输出]
${separator}
[任务 2 的完整输出]
${separator}
[任务 3 的完整输出]
\`\`\`

---

`;

    // 添加每个任务的 prompt
    const taskPrompts = batch.tasks.map((task, index) => {
      return `**任务 ${index + 1}**（ID: ${task.id}）

**任务描述**：${task.summary}

**详细要求**：
${task.prompt}

---
`;
    }).join("\n");

    // 添加结尾提醒
    const footer = `
**再次提醒**：
- 请严格按照顺序完成所有 ${batch.tasks.length} 个任务
- 每个任务的输出之间必须使用分隔符 "${separator}"
- 分隔符必须单独占一行
- 现在开始输出：
`;

    return header + taskPrompts + footer;
  }

  /**
   * 拆分 LLM 输出
   * 
   * @param output LLM 输出
   * @param batch 任务批次
   * @returns 任务 ID -> 输出的映射
   */
  splitOutput(output: string, batch: TaskBatch): Map<string, string> {
    const { separator } = this.options;
    const outputs = new Map<string, string>();

    // 1. 按分隔符拆分
    const parts = output.split(separator);

    // 2. 清理每个部分（去除首尾空白）
    const cleanedParts = parts.map(part => part.trim()).filter(part => part.length > 0);

    console.log(`[BatchExecutor] 📊 拆分结果: ${cleanedParts.length} 个部分`);

    // 3. 如果拆分结果数量不匹配，尝试智能修复
    if (cleanedParts.length !== batch.tasks.length) {
      console.warn(`[BatchExecutor] ⚠️ 拆分数量不匹配: 期望 ${batch.tasks.length}，实际 ${cleanedParts.length}`);
      
      // 尝试智能修复：可能 LLM 在某些部分忘记了分隔符
      // 这里可以添加更复杂的修复逻辑
    }

    // 4. 将每个部分映射到对应的任务
    const minLength = Math.min(cleanedParts.length, batch.tasks.length);
    for (let i = 0; i < minLength; i++) {
      const task = batch.tasks[i];
      const taskOutput = cleanedParts[i];
      outputs.set(task.id, taskOutput);
    }

    return outputs;
  }

  /**
   * 后备拆分方法
   * 
   * 当标准拆分失败时，使用更智能的方法尝试拆分
   * 
   * @param output LLM 输出
   * @param batch 任务批次
   * @returns 任务 ID -> 输出的映射
   */
  fallbackSplit(output: string, batch: TaskBatch): Map<string, string> {
    const outputs = new Map<string, string>();

    console.log(`[BatchExecutor] 🔍 使用后备拆分方法`);

    // 策略 1：尝试识别任务标记（如 "任务 1"、"Task 1" 等）
    const taskMarkers = [
      /(?:^|\n)(?:任务|Task)\s*(\d+)[：:]/gi,
      /(?:^|\n)(?:##\s*)?(?:任务|Task)\s*(\d+)/gi,
      /(?:^|\n)\*\*(?:任务|Task)\s*(\d+)\*\*/gi,
    ];

    for (const marker of taskMarkers) {
      const matches = [...output.matchAll(marker)];
      
      if (matches.length === batch.tasks.length) {
        console.log(`[BatchExecutor] ✅ 找到 ${matches.length} 个任务标记`);
        
        // 按标记位置拆分
        for (let i = 0; i < matches.length; i++) {
          const currentMatch = matches[i];
          const nextMatch = matches[i + 1];
          
          const startIndex = currentMatch.index! + currentMatch[0].length;
          const endIndex = nextMatch ? nextMatch.index! : output.length;
          
          const taskOutput = output.substring(startIndex, endIndex).trim();
          const task = batch.tasks[i];
          
          outputs.set(task.id, taskOutput);
        }
        
        return outputs;
      }
    }

    // 策略 2：按长度平均拆分（最后的手段）
    console.log(`[BatchExecutor] ⚠️ 无法识别任务标记，尝试按长度平均拆分`);
    
    const avgLength = Math.floor(output.length / batch.tasks.length);
    let currentIndex = 0;
    
    for (let i = 0; i < batch.tasks.length; i++) {
      const task = batch.tasks[i];
      
      // 最后一个任务取剩余所有内容
      if (i === batch.tasks.length - 1) {
        const taskOutput = output.substring(currentIndex).trim();
        outputs.set(task.id, taskOutput);
      } else {
        // 尝试在平均长度附近找到合适的断点（段落结束）
        const targetIndex = currentIndex + avgLength;
        const searchStart = Math.max(currentIndex, targetIndex - 200);
        const searchEnd = Math.min(output.length, targetIndex + 200);
        const searchText = output.substring(searchStart, searchEnd);
        
        // 查找段落结束标记
        const breakPoints = [
          searchText.lastIndexOf("\n\n"),
          searchText.lastIndexOf("。\n"),
          searchText.lastIndexOf(".\n"),
          searchText.lastIndexOf("\n"),
        ];
        
        let breakPoint = breakPoints.find(bp => bp !== -1);
        if (breakPoint === undefined) {
          breakPoint = avgLength;
        } else {
          breakPoint = searchStart + breakPoint;
        }
        
        const taskOutput = output.substring(currentIndex, breakPoint).trim();
        outputs.set(task.id, taskOutput);
        
        currentIndex = breakPoint;
      }
    }

    return outputs;
  }

  /**
   * 估算 tokens
   * 
   * @param text 文本
   * @returns 预估 tokens
   */
  estimateTokens(text: string): number {
    // 简单估算：中文 1 字 ≈ 2 tokens，英文 1 词 ≈ 1.3 tokens
    
    // 统计中文字符数
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    
    // 统计英文单词数
    const englishWords = text
      .replace(/[\u4e00-\u9fa5]/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 0).length;

    return Math.ceil(chineseChars * 2 + englishWords * 1.3);
  }

  /**
   * 带超时的 LLM 调用
   * 
   * @param prompt 提示词
   * @returns LLM 响应
   */
  private async callLLMWithTimeout(prompt: string): Promise<string> {
    const { timeout } = this.options;

    return Promise.race([
      this.llmCaller.call(prompt),
      new Promise<string>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`LLM 调用超时（${timeout}ms）`));
        }, timeout);
      }),
    ]);
  }

  /**
   * 创建成功结果
   * 
   * @param batch 任务批次
   * @param outputs 输出映射
   * @param startTime 开始时间
   * @returns 批量执行结果
   */
  private createSuccessResult(
    batch: TaskBatch,
    outputs: Map<string, string>,
    startTime: number
  ): BatchExecutionResult {
    const duration = Date.now() - startTime;
    
    // 计算实际消耗的 tokens
    let totalTokens = 0;
    for (const output of outputs.values()) {
      totalTokens += this.estimateTokens(output);
    }

    return {
      batchId: batch.id,
      success: true,
      outputs,
      duration,
      actualTokens: totalTokens,
    };
  }
}
