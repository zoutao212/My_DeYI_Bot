/**
 * Tool 包装器
 * 
 * 为 tool 添加审批、日志、错误处理等功能
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";

import {
  logToolExecution,
  requestToolApproval,
  shouldRequireToolApproval,
} from "../../infra/tool-approval-manager.js";

// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
type AnyAgentTool = AgentTool<any, unknown>;

/**
 * 包装 Tool 以支持审批
 * 
 * @param tool 原始 tool
 * @returns 包装后的 tool
 */
export function wrapToolWithApproval<T extends AnyAgentTool>(tool: T): T {
  const originalExecute = tool.execute;

  return {
    ...tool,
    execute: async (toolCallId: string, args: unknown, signal?: AbortSignal) => {
      const timestamp = Date.now();

      // 执行前审批（如果启用）
      if (shouldRequireToolApproval("before")) {
        await requestToolApproval({
          toolName: tool.name,
          params: args,
          phase: "before",
          timestamp,
        });
      }

      try {
        // 执行 tool
        const result = await originalExecute(toolCallId, args, signal);

        // 执行后展示结果
        if (shouldRequireToolApproval("after")) {
          await requestToolApproval({
            toolName: tool.name,
            params: args,
            result,
            phase: "after",
            timestamp,
          });
        } else {
          // 如果不需要审批，只记录日志
          logToolExecution({
            toolName: tool.name,
            params: args,
            result,
            phase: "after",
            timestamp,
          });
        }

        return result;
      } catch (error) {
        // 执行失败展示错误
        if (shouldRequireToolApproval("after")) {
          await requestToolApproval({
            toolName: tool.name,
            params: args,
            error: error instanceof Error ? error.message : String(error),
            phase: "after",
            timestamp,
          });
        } else {
          // 如果不需要审批，只记录日志
          logToolExecution({
            toolName: tool.name,
            params: args,
            error: error instanceof Error ? error.message : String(error),
            phase: "after",
            timestamp,
          });
        }

        throw error;
      }
    },
  } as T;
}

/**
 * 批量包装 tools
 * 
 * @param tools 原始 tools
 * @returns 包装后的 tools
 */
export function wrapToolsWithApproval<T extends AnyAgentTool>(tools: T[]): T[] {
  return tools.map((tool) => wrapToolWithApproval(tool));
}
