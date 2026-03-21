/**
 * Tool 审批管理器
 * 
 * 用于在 tool 执行前后展示审批界面，让用户看到：
 * - Tool 名称和参数（执行前）
 * - Tool 执行结果或错误（执行后）
 */

import type { LlmApprovalManager } from "../gateway/llm-approval-manager.js";
import type { LlmApprovalRequestPayload } from "./llm-approvals.js";

export interface ToolApprovalRequest {
  toolName: string;
  params: unknown;
  phase: "before" | "after";
  result?: unknown;
  error?: unknown;
  timestamp: number;
}

export interface ToolApprovalConfig {
  enabled: boolean;
  mode: "before-and-after" | "after-only" | "off";
}

let globalApprovalManager: LlmApprovalManager | null = null;
let globalConfig: ToolApprovalConfig = {
  enabled: false,
  mode: "after-only",
};

/**
 * 设置全局审批管理器
 */
export function setToolApprovalManager(manager: LlmApprovalManager | null): void {
  globalApprovalManager = manager;
}

/**
 * 设置 Tool 审批配置
 */
export function setToolApprovalConfig(config: Partial<ToolApprovalConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

/**
 * 获取当前 Tool 审批配置
 */
export function getToolApprovalConfig(): ToolApprovalConfig {
  return { ...globalConfig };
}

/**
 * 判断是否需要 Tool 审批
 */
export function shouldRequireToolApproval(phase: "before" | "after"): boolean {
  if (!globalConfig.enabled) return false;
  if (globalConfig.mode === "off") return false;
  if (globalConfig.mode === "after-only" && phase === "before") return false;
  return true;
}

/**
 * 全局广播函数（由网关注入）
 */
let globalBroadcastFn: ((event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void) | null = null;

/**
 * 设置全局广播函数（网关环境使用）
 */
export function setToolApprovalBroadcast(
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void,
): void {
  globalBroadcastFn = broadcast;
  console.log("[tool-approval] ✅ 已注册全局广播函数");
}

/**
 * 请求 Tool 审批
 * 
 * @param request 审批请求
 * @returns Promise<void> 审批通过后 resolve
 */
export async function requestToolApproval(request: ToolApprovalRequest): Promise<void> {
  // 检查是否需要审批
  if (!shouldRequireToolApproval(request.phase)) {
    console.log(`[tool-approval] ℹ️ 跳过审批：phase=${request.phase}, mode=${globalConfig.mode}`);
    return;
  }

  // 检查审批管理器是否可用
  if (!globalApprovalManager) {
    console.warn("[tool-approval] ⚠️ 审批管理器未初始化，跳过审批");
    return;
  }

  // 检查广播函数是否可用
  if (!globalBroadcastFn) {
    console.warn("[tool-approval] ⚠️ 广播函数未初始化，跳过审批");
    return;
  }

  // 构建更详细的摘要信息
  let summaryParts: string[] = [];
  summaryParts.push(`工具: ${request.toolName}`);
  summaryParts.push(`阶段: ${request.phase === "before" ? "执行前" : "执行后"}`);
  
  // 添加参数摘要
  if (request.params && typeof request.params === "object") {
    const paramKeys = Object.keys(request.params);
    if (paramKeys.length > 0) {
      summaryParts.push(`参数: ${paramKeys.slice(0, 3).join(", ")}${paramKeys.length > 3 ? ` +${paramKeys.length - 3} more` : ""}`);
    }
  }
  
  // 添加结果摘要
  if (request.phase === "after") {
    if (request.error) {
      summaryParts.push(`状态: ❌ 执行失败`);
    } else if (request.result) {
      summaryParts.push(`状态: ✅ 执行成功`);
      // 尝试提取结果长度
      if (typeof request.result === "object" && request.result !== null) {
        const resultObj = request.result as any;
        if (resultObj.content && Array.isArray(resultObj.content)) {
          const textContent = resultObj.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (textContent) {
            summaryParts.push(`输出: ${textContent.length} 字符`);
          }
        }
      }
    }
  }

  // 构建审批请求体
  const approvalPayload: LlmApprovalRequestPayload = {
    url: `tool://${request.toolName}`,
    method: request.phase === "before" ? "CALL" : "RESULT",
    headers: {
      "X-Tool-Name": request.toolName,
      "X-Tool-Phase": request.phase,
      "X-Timestamp": String(request.timestamp),
    },
    bodyText: JSON.stringify(
      {
        toolName: request.toolName,
        phase: request.phase,
        params: request.params,
        result: request.result,
        error: request.error,
        timestamp: request.timestamp,
      },
      null,
      2,
    ),
    bodySummary: summaryParts.join("\n"),
    provider: "local",
    modelId: "tool-execution",
    source: "tool-approval",
    sessionKey: "tool-execution",
    runId: `tool-${request.timestamp}`,
  };

  try {
    console.log(`[tool-approval] 🔒 开始请求审批：${request.toolName} (${request.phase})`);
    
    // 创建审批记录
    const timeoutMs = 60000; // 60 秒超时
    const record = globalApprovalManager.createOrGet(approvalPayload, timeoutMs);
    
    // 广播审批请求到所有连接的客户端（包括 Control UI）
    console.log(`[tool-approval] 📢 广播审批请求：id=${record.id}`);
    globalBroadcastFn(
      "llm.approval.requested",
      {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      { dropIfSlow: true },
    );
    
    // 等待审批决策
    console.log(`[tool-approval] ⏳ 等待审批决策...`);
    const decision = await globalApprovalManager.waitForDecision(record, timeoutMs);
    console.log(`[tool-approval] ✅ 收到审批决策：${decision}`);
    
    if (!decision || decision === "deny") {
      throw new Error(`Tool 审批被拒绝: ${request.toolName}`);
    }
  } catch (error) {
    console.error("[tool-approval] ❌ 审批请求失败:", error);
    // 如果是 "after-only" 模式，审批失败不应该阻止执行
    if (globalConfig.mode === "after-only" && request.phase === "after") {
      console.warn("[tool-approval] ⚠️ after-only 模式下审批失败，不阻止执行");
      return;
    }
    // 其他情况抛出错误
    throw error;
  }
}

/**
 * 记录 Tool 执行（不阻塞，仅展示）
 * 
 * 用于 "after-only" 模式，只展示结果不等待审批
 */
export function logToolExecution(request: ToolApprovalRequest): void {
  if (!globalConfig.enabled || globalConfig.mode === "off") {
    return;
  }

  // 异步发送，不等待结果
  requestToolApproval(request).catch((error) => {
    console.error("[tool-approval] 记录 Tool 执行失败:", error);
  });
}
