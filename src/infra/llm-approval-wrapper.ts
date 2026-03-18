/**
 * LLM 请求审批包装器
 * 
 * 为所有 LLM 调用提供统一的人工审核接入点
 * 支持网关 Web UI 的审批功能和请求预览
 * 
 * @module infra/llm-approval-wrapper
 */

import {
  loadLlmApprovals,
  shouldAskLlmApproval,
  addAllowAlwaysRule,
  saveLlmApprovals,
  type LlmApprovalRequestPayload,
  type LlmApprovalDecision,
} from "./llm-approvals.js";
import { getLlmRequestContext, withLlmRequestContext } from "./llm-request-context.js";
import { EventEmitter } from "node:events";

// 审批超时配置
const APPROVAL_TIMEOUT_MS = 120_000; // 2 分钟
const APPROVAL_CACHE_TTL_MS = 0; // 禁用缓存，每次都审批

// 审批决策缓存（避免重复询问相同的请求）
interface CachedApproval {
  decision: LlmApprovalDecision;
  cachedAt: number;
  expiresAt: number;
}

const approvalCache = new Map<string, CachedApproval>();

// 审批事件发射器（用于通知 UI）
// 注意：这个 EventEmitter 主要用于进程内通信。
// 在网关环境中，应该使用网关的广播系统 (context.broadcast)。
export const approvalEvents = new EventEmitter();

// 全局审批请求寄存器（用于网关环境）
let globalApprovalRequestHandler: ((payload: {
  id: string;
  request: LlmApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
}) => Promise<LlmApprovalDecision>) | null = null;

/**
 * 注册全局审批请求处理器（网关环境使用）
 */
export function registerGlobalApprovalRequestHandler(
  handler: (payload: {
    id: string;
    request: LlmApprovalRequestPayload;
    createdAtMs: number;
    expiresAtMs: number;
  }) => Promise<LlmApprovalDecision>,
): void {
  globalApprovalRequestHandler = handler;
  console.log("[llm-approval] ✅ 已注册全局审批处理器");
}

/**
 * 请求 LLM 审批
 * 
 * 这个方法会被网关的审批处理器拦截
 * 在 Web UI 中显示审批对话框
 */
async function requestApproval(
  payload: LlmApprovalRequestPayload,
  timeoutMs: number = APPROVAL_TIMEOUT_MS,
): Promise<LlmApprovalDecision> {
  const cacheKey = computeCacheKey(payload);
  const cached = approvalCache.get(cacheKey);
  
  if (cached && Date.now() < cached.expiresAt) {
    return cached.decision;
  }

  // 触发自定义事件，让网关有机会拦截
  console.log(`[llm-approval] 🔒 开始请求审批：${payload.bodySummary}`);
  console.log(`[llm-approval] 📦 Payload: provider=${payload.provider}, model=${payload.modelId}, source=${payload.source}`);
  
  // 如果注册了全局处理器（网关环境），使用它
  if (globalApprovalRequestHandler) {
    console.log("[llm-approval] 🔄 使用全局审批处理器");
    try {
      const decision = await globalApprovalRequestHandler({
        id: crypto.randomUUID(),
        request: payload,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + timeoutMs,
      });
      console.log(`[llm-approval] ✅ 收到审批决策：${decision}`);
      console.log(`[llm-approval] 📊 决策详情：provider=${payload.provider}, model=${payload.modelId}, decision=${decision}`);
      return decision;
    } catch (error) {
      console.error(`[llm-approval] ❌ 全局处理器错误：${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }
  
  // 否则使用本地 EventEmitter（备用方案）
  console.log("[llm-approval] ⚠️ 使用本地 EventEmitter（未检测到网关处理器）");
  
  return new Promise<LlmApprovalDecision>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      approvalEvents.off("approval-decision", onDecision);
      console.error(`[llm-approval] ❌ 审批超时 (${timeoutMs}ms)`);
      reject(new Error(`LLM approval timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onDecision = (decisionPayload: {
      requestId: string;
      decision: LlmApprovalDecision;
    }) => {
      clearTimeout(timeoutHandle);
      console.log(`[llm-approval] ✅ 收到审批决策：${decisionPayload.decision}`);
      
      if (decisionPayload.decision === "allow-always") {
        // 添加到白名单
        const approvals = loadLlmApprovals();
        const updated = addAllowAlwaysRule({ approvals, request: payload });
        saveLlmApprovals(updated);
        console.log("[llm-approval] 💾 已添加到白名单");
      }
      
      // 缓存决策
      approvalCache.set(cacheKey, {
        decision: decisionPayload.decision,
        cachedAt: Date.now(),
        expiresAt: Date.now() + APPROVAL_CACHE_TTL_MS,
      });
      
      resolve(decisionPayload.decision);
    };

    approvalEvents.once("approval-decision", onDecision);

    // 发出审批请求事件
    const requestId = crypto.randomUUID();
    console.log(`[llm-approval] 📢 发出审批请求事件 (id=${requestId})`);
    approvalEvents.emit("approval-request", {
      id: requestId,
      request: payload,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + timeoutMs,
    });

    // 🔴 注意：如果没有监听器处理 approval-request 事件，
    // 这个 Promise 会一直等待直到超时。
    // 在生产环境中，网关应该注册一个监听器来处理审批请求。
  });
}

/**
 * 检查是否需要审批
 */
export function checkApprovalRequired(payload: LlmApprovalRequestPayload): {
  required: boolean;
  matchedRuleId?: string;
} {
  const approvals = loadLlmApprovals();
  const result = shouldAskLlmApproval({ approvals, request: payload });
  console.log(`[llm-approval] 🔍 检查审批：required=${result.ask}${result.matchedRuleId ? `, rule=${result.matchedRuleId}` : ''}`);
  return { required: result.ask, matchedRuleId: result.matchedRuleId };
}

/**
 * 包装 LLM 调用，添加审批检查
 * 
 * @param executeFn 实际执行 LLM 调用的函数
 * @param payloadBuilder 构建审批 payload 的函数
 * @returns 包装后的执行函数
 */
export async function withApproval<T>(
  executeFn: () => Promise<T>,
  payloadBuilder: () => LlmApprovalRequestPayload | null,
): Promise<T> {
  const ctx = getLlmRequestContext();
  
  // 如果没有上下文，直接执行（不拦截）
  if (!ctx) {
    return executeFn();
  }

  const payload = payloadBuilder();
  
  // 如果无法构建 payload，直接执行
  if (!payload) {
    return executeFn();
  }

  // 检查是否需要审批
  const { required, matchedRuleId } = checkApprovalRequired(payload);
  
  if (required) {
    try {
      const decision = await requestApproval(payload);
      
      if (decision === "deny") {
        throw new Error("LLM_REQUEST_DENIED: Request denied by manual approval");
      }
      
      // allow-once 或 allow-always 都继续执行
      console.log(`[llm-approval] ✅ 审批通过：${decision}`);
    } catch (error) {
      if ((error as Error).message.includes("timeout")) {
        console.warn(`[llm-approval] ⚠️ 审批超时，拒绝执行`);
        throw new Error("LLM_APPROVAL_TIMEOUT: Manual approval timeout");
      }
      throw error;
    }
  } else {
    if (matchedRuleId) {
      console.log(`[llm-approval] ✅ 命中白名单规则 ${matchedRuleId}，跳过审批`);
    } else {
      console.log(`[llm-approval] ℹ️ 审批功能未启用，直接执行`);
    }
  }

  return executeFn();
}

/**
 * 清理过期的缓存项
 */
export function cleanupApprovalCache(): void {
  const now = Date.now();
  for (const [key, cached] of approvalCache.entries()) {
    if (now > cached.expiresAt) {
      approvalCache.delete(key);
    }
  }
}

/**
 * 清除所有缓存（用于测试或手动刷新）
 */
export function clearApprovalCache(): void {
  approvalCache.clear();
}

function computeCacheKey(payload: LlmApprovalRequestPayload): string {
  const cryptoLib = require("node:crypto");
  const stable = JSON.stringify({
    provider: payload.provider,
    modelId: payload.modelId,
    url: payload.url,
    method: payload.method,
    bodySummary: payload.bodySummary,
  });
  return cryptoLib.createHash("sha256").update(stable).digest("hex");
}
