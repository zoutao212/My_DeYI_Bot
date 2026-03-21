/**
 * Tool 审批包装器
 * 
 * 为工具函数添加审批拦截，支持：
 * - 执行前审批（before）：展示工具名称和参数
 * - 执行后审批（after）：展示工具执行结果
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  requestToolApproval,
  shouldRequireToolApproval,
  getToolApprovalConfig,
} from "../infra/tool-approval-manager.js";

/**
 * 包装工具函数，添加审批拦截
 * 
 * @param tool 原始工具
 * @returns 包装后的工具
 */
export function wrapToolWithApproval<T extends AgentTool<any, any>>(tool: T): T {
  const originalExecute = tool.execute;

  const wrappedExecute = async (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (update: any) => void,
  ): Promise<AgentToolResult<any>> => {
    const config = getToolApprovalConfig();
    const timestamp = Date.now();

    // 执行前审批（before）
    if (shouldRequireToolApproval("before")) {
      try {
        await requestToolApproval({
          toolName: tool.name,
          params,
          phase: "before",
          timestamp,
        });
      } catch (error) {
        // 如果审批被拒绝，抛出错误阻止执行
        console.error(`[tool-approval] Tool 执行被拒绝: ${tool.name}`, error);
        throw new Error(`Tool execution denied by approval: ${tool.name}`);
      }
    }

    // 执行工具
    let result: AgentToolResult<any> | undefined;
    let executionError: unknown = null;

    try {
      result = await originalExecute(toolCallId, params, signal, onUpdate);
    } catch (error) {
      executionError = error;
      // 执行后审批（after）- 即使失败也要展示
      if (shouldRequireToolApproval("after")) {
        try {
          await requestToolApproval({
            toolName: tool.name,
            params,
            phase: "after",
            result: undefined,
            error: executionError,
            timestamp,
          });
        } catch (approvalError) {
          // after-only 模式下，审批失败不应该影响错误抛出
          if (config.mode === "after-only") {
            console.warn(
              `[tool-approval] after-only 模式下审批失败，但不影响错误抛出: ${tool.name}`,
              approvalError,
            );
          }
        }
      }
      throw error;
    }

    // 执行成功后的审批（after）
    if (shouldRequireToolApproval("after")) {
      try {
        await requestToolApproval({
          toolName: tool.name,
          params,
          phase: "after",
          result,
          error: undefined,
          timestamp,
        });
      } catch (approvalError) {
        // after-only 模式下，审批失败不应该影响结果返回
        if (config.mode === "after-only") {
          console.warn(
            `[tool-approval] after-only 模式下审批失败，但不影响结果返回: ${tool.name}`,
            approvalError,
          );
        } else {
          // before-and-after 模式下，审批失败应该阻止结果返回
          console.error(`[tool-approval] Tool 结果审批被拒绝: ${tool.name}`, approvalError);
          throw new Error(`Tool result approval denied: ${tool.name}`);
        }
      }
    }

    return result;
  };

  return {
    ...tool,
    execute: wrappedExecute,
  } as T;
}

/**
 * 批量包装工具数组
 * 
 * @param tools 工具数组
 * @returns 包装后的工具数组
 */
export function wrapToolsWithApproval<T extends AgentTool<any, any>>(tools: T[]): T[] {
  const config = getToolApprovalConfig();

  // 如果审批未启用，直接返回原始工具
  if (!config.enabled || config.mode === "off") {
    return tools;
  }

  return tools.map((tool) => wrapToolWithApproval(tool));
}
