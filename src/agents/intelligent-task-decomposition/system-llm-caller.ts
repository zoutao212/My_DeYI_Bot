/**
 * 系统 LLM 调用器
 * 
 * 桥接现有 auth profiles + completeSimple 的薄适配层，
 * 为任务分解和质量评估提供轻量级 LLM 调用能力。
 * 
 * 不依赖完整的 agent runner（runEmbeddedPiAgent），
 * 只做"给 prompt → 返回文本"的简单调用。
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ClawdbotConfig } from "../../config/config.js";
import { resolveClawdbotAgentDir } from "../agent-paths.js";
import { getApiKeyForModel, requireApiKey } from "../model-auth.js";
import { resolveModel } from "../pi-embedded-runner/model.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { FailoverError } from "../failover-error.js";
import { runWithModelFallback } from "../model-fallback.js";
import type { LLMCaller } from "./batch-executor.js";
import { buildPromptProfileSystemPrompt } from "../pi-embedded-runner/prompt-profiles.js";
import { withApproval, checkApprovalRequired } from "../../infra/llm-approval-wrapper.js";
import crypto from "node:crypto";

/**
 * 系统 LLM 调用器配置
 */
export interface SystemLLMCallerConfig {
  /** Clawdbot 配置（用于解析 auth profiles） */
  config?: ClawdbotConfig;
  /** LLM 提供商（默认使用系统默认） */
  provider?: string;
  /** 模型 ID（默认使用系统默认） */
  modelId?: string;
  /** 最大输出 token 数（默认 8192） */
  maxTokens?: number;
  /** 温度（默认 0.3，QC/分解场景偏低温） */
  temperature?: number;
  /** 超时时间（毫秒，默认 120000） */
  timeoutMs?: number;
}

/**
 * 从 completeSimple 的返回值中提取纯文本
 * P24: 增加 thinking 块回退——推理模型可能只产出 thinking 内容
 */
function extractText(res: { content: Array<{ type: string; text?: string; thinking?: string }> }): string {
  if (!res?.content) return "";

  // 优先提取 text 块
  const textParts = res.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => (block as { type: "text"; text: string }).text.trim())
    .filter(Boolean);
  if (textParts.length > 0) return textParts.join("\n");

  // 回退：推理模型可能只产出 thinking 块（如 openrouter/pony-alpha）
  const thinkingParts = res.content
    .filter((block) => block.type === "thinking" && block.thinking)
    .map((block) => (block as { type: "thinking"; thinking: string }).thinking.trim())
    .filter(Boolean);
  if (thinkingParts.length > 0) {
    console.warn(`[SystemLLMCaller] ⚠️ 仅提取到 thinking 内容（${thinkingParts.length} 块），无 text 块——推理模型可能消耗了全部输出 token`);
    return thinkingParts.join("\n");
  }

  return "";
}

/**
 * 创建基于系统 LLM 基础设施的调用器
 * 
 * 使用现有的 auth profiles + completeSimple 实现轻量级 LLM 调用，
 * 用于任务分解和质量评估等不需要完整 agent runner 的场景。
 * 
 * @param params 配置参数
 * @returns LLMCaller 实例
 */
/**
 * P79: 从 config 中自动检测可用的 provider/model
 * 优先级：1) activeProviderId + activeModelId（UI配置） 2) 第一个有配置的 provider
 */
function autoDetectProviderFromConfig(config?: ClawdbotConfig): { provider?: string; modelId?: string } {
  if (!config) return {};
  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object") return {};
  
  // 优先使用 activeProviderId + activeModelId（UI 配置的选择）
  const activeProviderId = typeof (config.models as any)?.activeProviderId === "string" 
    ? (config.models as any).activeProviderId.trim() 
    : "";
  const activeModelId = typeof (config.models as any)?.activeModelId === "string" 
    ? (config.models as any).activeModelId.trim() 
    : "";
    
  if (activeProviderId && activeModelId) {
    const activeProvider = providers[activeProviderId];
    if (activeProvider) {
      const models = (activeProvider as { models?: Array<{ id?: string }> })?.models;
      if (models && models.some(m => m.id === activeModelId)) {
        return { provider: activeProviderId, modelId: activeModelId };
      }
    }
  }
  
  // 回退：使用第一个有配置的 provider
  for (const [providerKey, providerCfg] of Object.entries(providers)) {
    const trimmed = providerKey.trim();
    if (!trimmed) continue;
    // 有 models 配置的 provider 视为可用
    const models = (providerCfg as { models?: Array<{ id?: string }> })?.models;
    if (models && models.length > 0 && models[0]?.id) {
      return { provider: trimmed, modelId: models[0].id };
    }
  }
  return {};
}

export function createSystemLLMCaller(params?: SystemLLMCallerConfig): LLMCaller {
  // P79: 未显式指定 provider 时，从 config 中自动检测
  const autoDetected = (!params?.provider && params?.config)
    ? autoDetectProviderFromConfig(params.config)
    : {};
  const provider = params?.provider ?? autoDetected.provider ?? DEFAULT_PROVIDER;
  const modelId = params?.modelId ?? autoDetected.modelId ?? DEFAULT_MODEL;
  const config = params?.config;
  const maxTokens = params?.maxTokens ?? 8192;
  const temperature = params?.temperature ?? 0.3;
  const timeoutMs = params?.timeoutMs ?? 120_000;

  if (autoDetected.provider) {
    console.log(`[SystemLLMCaller] P79: 自动检测到 provider=${autoDetected.provider}, model=${autoDetected.modelId}`);
  }

  return {
    async call(prompt: string): Promise<string> {
      // 🔒 LLM 请求人工审批检查
      const approvalPayload = {
        provider,
        modelId,
        source: "system_llm_caller",
        toolName: "system-llm-caller",
        sessionKey: null,
        runId: null,
        url: "internal://system-llm-caller/call",
        method: "POST",
        headers: {},
        bodyText: prompt.slice(0, 10000),
        bodySummary: `系统 LLM 调用 (prompt 长度：${prompt.length}, model: ${provider}/${modelId})`,
      };
      
      const { required, matchedRuleId } = checkApprovalRequired(approvalPayload);
      
      if (required) {
        console.log(`[SystemLLMCaller] 🔒 等待人工审批：${approvalPayload.bodySummary}`);
        
        // 发出审批请求事件（网关会拦截并显示在 Web UI）
        const { approvalEvents } = await import("../../infra/llm-approval-wrapper.js");
        await new Promise<void>((resolve, reject) => {
          const timeoutHandle = setTimeout(() => {
            approvalEvents.off("approval-decision", onDecision);
            reject(new Error("LLM_APPROVAL_TIMEOUT: 人工审批超时 (120s)"));
          }, 120_000);
          
          const onDecision = (decisionPayload: {
            requestId: string;
            decision: "allow-once" | "allow-always" | "deny";
          }) => {
            clearTimeout(timeoutHandle);
            if (decisionPayload.decision === "deny") {
              reject(new Error("LLM_REQUEST_DENIED: 请求被人工审批拒绝"));
            } else {
              console.log(`[SystemLLMCaller] ✅ 审批通过：${decisionPayload.decision}`);
              resolve();
            }
          };
          
          approvalEvents.once("approval-decision", onDecision);
          
          // 发出审批请求
          approvalEvents.emit("approval-request", {
            id: crypto.randomUUID(),
            request: approvalPayload,
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 120_000,
          });
        });
      } else if (matchedRuleId) {
        console.log(`[SystemLLMCaller] ✅ 命中白名单规则 ${matchedRuleId}，跳过审批`);
      }
      
      const base = await buildPromptProfileSystemPrompt("deyi_mini_base");
      const effectivePrompt = base ? `${base}\n\n${prompt}` : prompt;
      const agentDir = resolveClawdbotAgentDir();
      const startedAt = Date.now();

      const result = await runWithModelFallback({
        cfg: config,
        provider,
        model: modelId,
        onError: async (attempt) => {
          const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
          console.warn(
            `[SystemLLMCaller] ⚠️ 模型失败，尝试切换 (${attempt.attempt}/${attempt.total}) ` +
              `${attempt.provider}/${attempt.model}: ${message}`,
          );
        },
        run: async (attemptProvider, attemptModelId) => {
          const { model, error } = resolveModel(attemptProvider, attemptModelId, agentDir, config);
          if (!model) {
            throw new FailoverError(`[SystemLLMCaller] 模型解析失败: ${error ?? "未知错误"}`, {
              reason: "format",
              provider: attemptProvider,
              model: attemptModelId,
            });
          }

          const auth = await getApiKeyForModel({ model, cfg: config, agentDir });
          const apiKey = requireApiKey(auth, attemptProvider);

          console.log(
            `[SystemLLMCaller] 调用 LLM: provider=${attemptProvider}, model=${attemptModelId}, ` +
              `api=${model.api}, reasoning=${(model as any).reasoning ?? false}, ` +
              `prompt长度=${effectivePrompt.length}, maxTokens=${maxTokens}`,
          );

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          const waitLogInterval = setInterval(() => {
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            console.log(
              `[SystemLLMCaller] ⏳ 等待 LLM 响应中... (${elapsed}s) ` +
                `provider=${attemptProvider}, model=${attemptModelId}`,
            );
          }, 15_000);

          try {
            const res = await completeSimple(
              model,
              {
                messages: [
                  {
                    role: "user" as const,
                    content: effectivePrompt,
                    timestamp: Date.now(),
                  },
                ],
              },
              {
                apiKey,
                maxTokens,
                temperature,
                signal: controller.signal,
              },
            );

            const text = extractText(res as { content: Array<{ type: string; text?: string; thinking?: string }> });
            console.log(`[SystemLLMCaller] LLM 响应长度: ${text.length}`);

            if (text) return text;

            if ((model as any).reasoning) {
              console.warn("[SystemLLMCaller] ⚠️ LLM 返回空响应（reasoning=true），关闭 reasoning 重试一次");
              const noReasoningModel = { ...model, reasoning: false } as typeof model;
              const retryRes = await completeSimple(
                noReasoningModel,
                {
                  messages: [
                    {
                      role: "user" as const,
                      content: effectivePrompt,
                      timestamp: Date.now(),
                    },
                  ],
                },
                {
                  apiKey,
                  maxTokens,
                  temperature,
                  signal: controller.signal,
                },
              );
              const retryText = extractText(retryRes as { content: Array<{ type: string; text?: string; thinking?: string }> });
              console.log(`[SystemLLMCaller] P81 重试响应长度: ${retryText.length}`);
              if (retryText) return retryText;
            }

            throw new FailoverError("LLM 返回空响应", {
              reason: "format",
              provider: attemptProvider,
              model: attemptModelId,
            });
          } finally {
            clearInterval(waitLogInterval);
            clearTimeout(timeout);
          }
        },
      });

      return result.result;
    },
  };
}
