/**
 * 失败处理器
 * 
 * 负责处理子任务失败、分析失败原因并提供恢复选项。
 */

import type { SubTask, FailureDecision, FailureSummary } from "./types.js";

/**
 * 失败处理器接口
 */
export interface FailureHandler {
  /**
   * 处理子任务失败
   * @param subTask 失败的子任务
   * @param error 错误信息
   * @returns 用户决策
   */
  handleFailure(
    subTask: SubTask,
    error: Error
  ): Promise<FailureDecision>;

  /**
   * 分析失败原因并生成总结
   * @param subTask 失败的子任务
   * @param error 错误信息
   * @returns 失败总结
   */
  analyzeFailure(subTask: SubTask, error: Error): Promise<FailureSummary>;

  /**
   * 建议将失败经验固化为规则
   * @param failureSummary 失败总结
   * @returns 是否建议固化
   */
  suggestRuleCreation(failureSummary: FailureSummary): Promise<boolean>;
}

/**
 * 默认失败处理器实现
 */
export class DefaultFailureHandler implements FailureHandler {
  /**
   * 分析失败原因并生成总结
   */
  async analyzeFailure(subTask: SubTask, error: Error): Promise<FailureSummary> {
    // 识别错误类型
    let errorType = "unknown";
    if (error.name === "SyntaxError") {
      errorType = "syntax_error";
    } else if (error.name === "TypeError") {
      errorType = "type_error";
    } else if (error.name === "ReferenceError") {
      errorType = "reference_error";
    } else if (error.message.includes("ENOENT")) {
      errorType = "file_not_found";
    } else if (error.message.includes("EACCES")) {
      errorType = "permission_denied";
    } else if (error.message.includes("timeout")) {
      errorType = "timeout";
    }

    // 分析根本原因
    let rootCause = "未知原因";
    if (errorType === "syntax_error") {
      rootCause = "代码语法错误";
    } else if (errorType === "type_error") {
      rootCause = "类型错误或空值引用";
    } else if (errorType === "reference_error") {
      rootCause = "引用了未定义的变量或函数";
    } else if (errorType === "file_not_found") {
      rootCause = "文件或目录不存在";
    } else if (errorType === "permission_denied") {
      rootCause = "权限不足";
    } else if (errorType === "timeout") {
      rootCause = "操作超时";
    }

    // 生成建议的修复方案
    let suggestedFix = "请检查错误信息并手动修复";
    if (errorType === "syntax_error") {
      suggestedFix = "检查代码语法，确保所有括号、引号和分号正确";
    } else if (errorType === "type_error") {
      suggestedFix = "检查变量类型，确保不会访问 null 或 undefined 的属性";
    } else if (errorType === "reference_error") {
      suggestedFix = "检查变量和函数的定义，确保在使用前已声明";
    } else if (errorType === "file_not_found") {
      suggestedFix = "检查文件路径是否正确，确保文件存在";
    } else if (errorType === "permission_denied") {
      suggestedFix = "检查文件权限，可能需要使用 sudo 或修改权限";
    } else if (errorType === "timeout") {
      suggestedFix = "增加超时时间或优化操作性能";
    }

    return {
      subTaskId: subTask.id,
      errorType,
      rootCause,
      context: `任务: ${subTask.title}\n描述: ${subTask.description}\n错误: ${error.message}`,
      suggestedFix
    };
  }

  /**
   * 处理子任务失败
   */
  async handleFailure(
    subTask: SubTask,
    error: Error
  ): Promise<FailureDecision> {
    // 分析失败原因
    const failureSummary = await this.analyzeFailure(subTask, error);

    // TODO: 这里应该向用户展示失败原因和选项，并等待用户输入
    // 目前返回一个默认的决策（重试）
    
    console.error(`\n❌ 子任务 ${subTask.id} 失败:`);
    console.error(`   错误类型: ${failureSummary.errorType}`);
    console.error(`   根本原因: ${failureSummary.rootCause}`);
    console.error(`   建议修复: ${failureSummary.suggestedFix}`);
    console.error(`\n可选操作:`);
    console.error(`   1. 重试 (retry)`);
    console.error(`   2. 跳过 (skip)`);
    console.error(`   3. 修改任务 (modify)`);
    console.error(`   4. 中止 (abort)`);

    // 默认返回重试决策
    return {
      action: "retry"
    };
  }

  /**
   * 建议将失败经验固化为规则
   */
  async suggestRuleCreation(failureSummary: FailureSummary): Promise<boolean> {
    // 识别可复用的失败模式
    const reusablePatterns = [
      "file_not_found",
      "permission_denied",
      "timeout",
      "syntax_error"
    ];

    // 如果是可复用的失败模式，建议固化
    if (reusablePatterns.includes(failureSummary.errorType)) {
      return true;
    }

    return false;
  }
}

/**
 * 创建默认的失败处理器实例
 * @returns 失败处理器实例
 */
export function createFailureHandler(): FailureHandler {
  return new DefaultFailureHandler();
}
