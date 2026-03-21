/**
 * Tool Call 审批包装器
 * 
 * 在执行本地 tool call 前请求用户审批
 * 支持显示 tool 名称、参数、执行上下文等信息
 * 
 * @module infra/tool-approval-wrapper
 */

import { getLlmRequestContext } from "./llm-request-context.js";
import { loadLlmApprovals, shouldAskLlmApproval } from "./llm-approvals.js";
import type { LlmApprovalRequestPayload } from "./llm-approvals.js";

export interface ToolApprovalContext {
  roundNumber?: number;
  totalRounds?: number;
  purpose?: string;
  parentTaskId?: string;
  sessionKey?: string;
}

export interface ToolApprovalParams<T> {
  toolName: string;
  toolDescription?: string;
  toolArgs: Record<string, unknown>;
  context?: ToolApprovalContext;
  execute: () => Promise<T>;
}

// 全局审批请求处理器（由 gateway 注册）
let globalToolApprovalHandler: ((payload: LlmApprovalRequestPayload) => Promise<"allow-once" | "allow-always" | "deny" | null>) | null = null;

/**
 * 注册全局 tool 审批处理器（网关环境使用）
 */
export function registerGlobalToolApprovalHandler(
  handler: (payload: LlmApprovalRequestPayload) => Promise<"allow-once" | "allow-always" | "deny" | null>,
): void {
  globalToolApprovalHandler = handler;
  console.log("[tool-approval] ✅ 已注册全局 tool 审批处理器");
}

/**
 * 检查是否应该对 tool call 进行审批
 */
function shouldAskToolApproval(): boolean {
  // 检查是否启用审批
  const approvals = loadLlmApprovals();
  if (approvals.enabled === false) return false;
  if (approvals.ask === "off") return false;
  
  // 如果配置为 "always"，则审批所有 tool call
  if (approvals.ask === "always") return true;
  
  // 默认禁用 tool 审批，等待用户配置
  return false;
}

/**
 * 构建 tool call 审批 payload
 */
function buildToolApprovalPayload(params: ToolApprovalParams<unknown>): LlmApprovalRequestPayload {
  const ctx = getLlmRequestContext();
  
  // 构建 tool 信息摘要
  const argsPreview = JSON.stringify(params.toolArgs, null, 2).slice(0, 500);
  const bodySummary = `Tool: ${params.toolName}${params.context?.purpose ? ` (${params.context.purpose})` : ""}`;
  
  return {
    provider: ctx?.provider ?? null,
    modelId: null,
    source: "tool-call",
    toolName: params.toolName,
    sessionKey: params.context?.sessionKey ?? ctx?.sessionKey ?? null,
    runId: ctx?.runId ?? null,
    url: `internal://tool-call/${params.toolName}`,
    method: "POST",
    headers: {},
    bodyText: JSON.stringify({
      type: "tool-call",
      toolName: params.toolName,
      toolDescription: params.toolDescription,
      args: params.toolArgs,
      context: params.context,
    }, null, 2),
    bodySummary,
  };
}

/**
 * 请求 tool 审批
 */
async function requestToolApproval(payload: LlmApprovalRequestPayload): Promise<"allow-once" | "allow-always" | "deny" | null> {
  // 如果注册了全局处理器（网关环境），使用它
  if (globalToolApprovalHandler) {
    console.log("[tool-approval] 🔄 使用全局审批处理器");
    try {
      const decision = await globalToolApprovalHandler(payload);
      console.log(`[tool-approval] ✅ 收到审批决策：${decision}`);
      return decision;
    } catch (error) {
      console.error(`[tool-approval] ❌ 全局处理器错误：${error instanceof Error ? error.message : error}`);
      return null;
    }
  }
  
  // 否则默认允许（避免阻塞）
  console.log("[tool-approval] ⚠️ 未检测到全局处理器，默认允许");
  return "allow-once";
}

/**
 * 执行 tool call 并请求审批
 * 
 * 如果启用了 tool 审批，会在执行前请求用户确认
 * 如果用户拒绝，会抛出错误
 * 
 * @param params Tool 执行参数
 * @returns Tool 执行结果
 */
export async function approveAndExecuteTool<T>(
  params: ToolApprovalParams<T>,
): Promise<T> {
  // 如果未启用审批，直接执行
  if (!shouldAskToolApproval()) {
    return params.execute();
  }

  // 构建审批 payload
  const payload = buildToolApprovalPayload(params);

  console.log(`[tool-approval] 📋 Tool Call 审批请求：${params.toolName}`);
  console.log(`[tool-approval] 📦 Payload: ${payload.bodySummary}`);

  // 请求审批
  const decision = await requestToolApproval(payload);
  
  if (decision === "deny") {
    console.log(`[tool-approval] ❌ Tool 执行被拒绝：${params.toolName}`);
    throw new Error(`Tool execution denied: ${params.toolName}`);
  }

  // 执行 tool
  console.log(`[tool-approval] ✅ Tool 执行已批准：${params.toolName}`);
  return params.execute();
}

/**
 * 检查 tool 是否应该被审批
 * 
 * 某些 tool（如 read）可能不需要审批
 * 某些 tool（如 write/exec）应该总是审批
 */
export function shouldApproveToolByName(toolName: string): boolean {
  // 关键 tool 总是需要审批
  const criticalTools = ["write", "exec", "process", "memory_write", "memory_delete"];
  if (criticalTools.includes(toolName)) {
    return true;
  }

  // 其他 tool 根据配置决定
  return shouldAskToolApproval();
}

