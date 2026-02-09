/**
 * LLMCaller 系统集成实现
 *
 * 使用项目已有的 LLM 基础设施（@mariozechner/pi-ai 的 complete() +
 * model-auth 认证体系），为 QualityReviewer 和 LLMTaskDecomposer
 * 提供 LLM 调用能力。
 *
 * ⚠️ 不再自行拼接 HTTP 请求 / 手动读取 env var —— 全部委托给
 *    pi-ai + model-auth，与主管线（runEmbeddedPiAgent）共享同一套
 *    provider 配置、auth profile、failover 等基础设施。
 */

import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";

import { getApiKeyForModel, requireApiKey, resolveEnvApiKey } from "../model-auth.js";
import { resolveClawdbotAgentDir } from "../agent-paths.js";
import { normalizeModelCompat } from "../model-compat.js";
import { ensureClawdbotModelsJson } from "../models-config.js";
import type { LLMCaller } from "./batch-executor.js";

/**
 * Meta-level 调用（质量评估 / 任务分解）使用的轻量模型。
 * 不使用 DEFAULT_MODEL（claude-opus-4-5），避免不必要的高成本。
 */
const META_MODEL_CANDIDATES: Array<{
  provider: string;
  model: string;
  api: "anthropic" | "openai-chat" | "google-gemini";
}> = [
  { provider: "anthropic", model: "claude-sonnet-4-20250514", api: "anthropic" },
  { provider: "openai",    model: "gpt-4o-mini",              api: "openai-chat" },
  { provider: "google",    model: "gemini-2.0-flash",         api: "google-gemini" },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4-20250514", api: "openai-chat" },
];

/**
 * 从已完成的 AssistantMessage 中提取纯文本
 */
function extractAssistantText(message: AssistantMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } =>
        c != null && typeof c === "object" && (c as unknown as Record<string, unknown>).type === "text",
      )
      .map((c) => c.text)
      .join("");
  }
  return String(content ?? "");
}

/**
 * 从系统配置自动创建 LLMCaller
 *
 * 1. 按 META_MODEL_CANDIDATES 顺序查找第一个有可用 API Key 的 provider
 * 2. 在首次 call() 时惰性初始化 Model 对象和 API Key（解析 auth profile）
 * 3. 调用 pi-ai 的 complete() 完成请求（自动适配各 provider 的 HTTP 协议）
 * 4. 若无任何可用 key，返回 null；调用方会降级到默认行为（桩函数）
 *
 * @returns LLMCaller 实例，或 null
 */
export function createLLMCallerFromEnv(): LLMCaller | null {
  // ---------- 1. 同步快检：找到第一个有 env key 的 provider ----------
  let selectedCandidate: (typeof META_MODEL_CANDIDATES)[number] | null = null;

  for (const candidate of META_MODEL_CANDIDATES) {
    const envKey = resolveEnvApiKey(candidate.provider);
    if (envKey) {
      selectedCandidate = candidate;
      break;
    }
  }

  if (!selectedCandidate) {
    console.warn(
      "[LLMCaller] ⚠️ 未找到任何可用的 API Key，质量评估和任务分解将使用默认行为",
    );
    return null;
  }

  console.log(
    `[LLMCaller] ✅ 使用 ${selectedCandidate.provider}/${selectedCandidate.model}`,
  );

  // ---------- 2. 惰性初始化（首次 call 时执行） ----------
  let resolvedModel: Model<Api> | null = null;
  let resolvedApiKey: string | null = null;
  let initialized = false;

  const lazyInit = async () => {
    if (initialized) return;

    const agentDir = resolveClawdbotAgentDir();
    await ensureClawdbotModelsJson(undefined, agentDir);
    const authStorage = discoverAuthStorage(agentDir);
    const modelRegistry = discoverModels(authStorage, agentDir);

    // 从 registry 查找模型；找不到则构造 fallback Model 对象
    const found = modelRegistry.find(
      selectedCandidate!.provider,
      selectedCandidate!.model,
    ) as Model<Api> | null;

    resolvedModel = found
      ? found
      : normalizeModelCompat({
          id: selectedCandidate!.model,
          name: selectedCandidate!.model,
          api: selectedCandidate!.api,
          provider: selectedCandidate!.provider,
          reasoning: false,
          input: ["text"] as const,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
          baseUrl: "",
        } as unknown as Model<Api>);

    // 通过统一认证体系解析 API Key（auth profile / env / config）
    const apiKeyInfo = await getApiKeyForModel({
      model: resolvedModel,
      agentDir,
    });
    resolvedApiKey = requireApiKey(apiKeyInfo, resolvedModel.provider);
    authStorage.setRuntimeApiKey(resolvedModel.provider, resolvedApiKey);

    initialized = true;
  };

  // ---------- 3. 返回 LLMCaller ----------
  return {
    async call(prompt: string): Promise<string> {
      await lazyInit();

      if (!resolvedModel || !resolvedApiKey) {
        throw new Error("[LLMCaller] 初始化失败：model 或 apiKey 为空");
      }

      const message = (await complete(
        resolvedModel,
        {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: resolvedApiKey, maxTokens: 4096 },
      )) as AssistantMessage;

      return extractAssistantText(message);
    },
  };
}
