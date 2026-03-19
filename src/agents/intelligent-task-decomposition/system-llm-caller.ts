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
      // 🔧 移除 withApproval 包装器
      // 原因：llm-gated-fetch 已经在 fetch() 层面做了完整的审批检查
      // withApproval 的 payload 不完整（只有 prompt 前 10000 字符），无法正确判断是否包含 tool result
      // 这会导致审批被错误触发（即使请求不包含 tool result）
      console.log(`[SystemLLMCaller] ℹ️ 审批检查由 llm-gated-fetch 统一处理`);
      
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
            // 🆕 SystemLLM 审批：在调用前记录请求
            const { shouldRequireToolApproval, logToolExecution } = await import(
              "../../infra/tool-approval-manager.js"
            );
            const llmCallTimestamp = Date.now();
            const shouldApprove = shouldRequireToolApproval("after");
            
            if (shouldApprove) {
              logToolExecution({
                toolName: "system_llm_call",
                params: {
                  provider: attemptProvider,
                  model: attemptModelId,
                  promptLength: effectivePrompt.length,
                  maxTokens,
                  temperature,
                },
                phase: "before",
                timestamp: llmCallTimestamp,
              });
            }

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

            // 🆕 SystemLLM 审批：记录响应结果
            if (shouldApprove) {
              logToolExecution({
                toolName: "system_llm_call",
                params: {
                  provider: attemptProvider,
                  model: attemptModelId,
                  promptLength: effectivePrompt.length,
                },
                result: {
                  responseLength: text.length,
                  response: text.slice(0, 500), // 只记录前 500 字符
                },
                phase: "after",
                timestamp: llmCallTimestamp,
              });
            }

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
