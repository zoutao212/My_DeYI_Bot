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
import type { LLMCaller } from "./batch-executor.js";

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
  /** 最大输出 token 数（默认 4096） */
  maxTokens?: number;
  /** 温度（默认 0.3，QC/分解场景偏低温） */
  temperature?: number;
  /** 超时时间（毫秒，默认 60000） */
  timeoutMs?: number;
}

/**
 * 从 completeSimple 的返回值中提取纯文本
 */
function extractText(res: { content: Array<{ type: string; text?: string }> }): string {
  if (!res?.content) return "";
  return res.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => (block as { type: "text"; text: string }).text.trim())
    .filter(Boolean)
    .join("\n");
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
export function createSystemLLMCaller(params?: SystemLLMCallerConfig): LLMCaller {
  const provider = params?.provider ?? DEFAULT_PROVIDER;
  const modelId = params?.modelId ?? DEFAULT_MODEL;
  const config = params?.config;
  const maxTokens = params?.maxTokens ?? 4096;
  const temperature = params?.temperature ?? 0.3;
  const timeoutMs = params?.timeoutMs ?? 60_000;

  return {
    async call(prompt: string): Promise<string> {
      const agentDir = resolveClawdbotAgentDir();
      const { model, error } = resolveModel(provider, modelId, agentDir, config);
      if (!model) {
        throw new Error(`[SystemLLMCaller] 模型解析失败: ${error ?? "未知错误"}`);
      }

      const auth = await getApiKeyForModel({ model, cfg: config, agentDir });
      const apiKey = requireApiKey(auth, provider);

      console.log(
        `[SystemLLMCaller] 调用 LLM: provider=${provider}, model=${modelId}, ` +
        `prompt长度=${prompt.length}, maxTokens=${maxTokens}`,
      );

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await completeSimple(
          model,
          {
            messages: [
              {
                role: "user" as const,
                content: prompt,
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

        const text = extractText(res as { content: Array<{ type: string; text?: string }> });
        console.log(`[SystemLLMCaller] LLM 响应长度: ${text.length}`);

        if (!text) {
          console.warn("[SystemLLMCaller] ⚠️ LLM 返回空响应，使用默认降级");
          throw new Error("LLM 返回空响应");
        }

        return text;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
