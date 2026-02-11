import { Buffer } from "node:buffer";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { appendRuntimeTrace } from "../gateway/runtime-log.js";
import { callGatewayTool } from "./tools/gateway.js";
import { validateAndLogPayload } from "./payload-validator.js";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

const log = createSubsystemLogger("llm");

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…(${text.length} chars)`;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (/^(apiKey|token|authorization)$/i.test(String(_key))) {
      return "[REDACTED]";
    }
    if (val && typeof val === "object") {
      if (seen.has(val as object)) return "[Circular]";
      seen.add(val as object);
    }
    if (typeof val === "bigint") return val.toString();
    if (typeof val === "function") return "[Function]";
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (val instanceof Uint8Array) {
      return { type: "Uint8Array", bytes: val.byteLength };
    }
    return val;
  });
}

function safeJsonClone(value: unknown, maxChars: number): unknown {
  try {
    return JSON.parse(truncate(safeJsonStringify(value), maxChars));
  } catch {
    return { value: truncate(String(value), maxChars) };
  }
}

function pickOpenAiCompletionsResponseEvidence(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("id" in rec) out.id = rec.id;
  if ("object" in rec) out.object = rec.object;
  if ("created" in rec) out.created = rec.created;
  if ("model" in rec) out.model = rec.model;
  if ("error" in rec) out.error = rec.error;

  const choices = rec.choices;
  if (Array.isArray(choices)) {
    out.choices = choices.slice(0, 6).map((choice) => {
      if (!choice || typeof choice !== "object") return choice;
      const c = choice as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      if ("index" in c) picked.index = c.index;
      if ("finish_reason" in c) picked.finish_reason = c.finish_reason;
      if ("finishReason" in c) picked.finishReason = c.finishReason;
      if ("message" in c) picked.message = c.message;
      if ("delta" in c) picked.delta = c.delta;
      if ("text" in c) picked.text = c.text;
      return picked;
    });
  }

  return Object.keys(out).length > 0 ? out : value;
}

type ResponseSummary = {
  chunks: number;
  samples: unknown[];
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return safeJsonStringify(err);
  } catch {
    return String(err);
  }
}

function formatApiTag(api: unknown, fallback: string): string {
  if (typeof api === "string" && api.trim()) return api;
  if (api === null || api === undefined) return fallback;
  try {
    return safeJsonStringify(api);
  } catch {
    return fallback;
  }
}

function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
  if (!value) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.then === "function";
}

function isAsyncIterable<T = unknown>(value: unknown): value is AsyncIterable<T> {
  if (!value || typeof value !== "object") return false;
  const rec = value as { [Symbol.asyncIterator]?: unknown };
  return typeof rec[Symbol.asyncIterator] === "function";
}

async function injectLlmProgress(params: {
  sessionKey?: string;
  message: string;
  enabled?: boolean;  // 新增：是否启用进度提示
}) {
  // 如果明确禁用，直接返回
  if (params.enabled === false) return;
  
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) return;
  try {
    await callGatewayTool(
      "chat.inject",
      { timeoutMs: 10_000 },
      { sessionKey, message: params.message, label: "LLM" },
    );
  } catch {
    // Best-effort only.
  }
}

export type LlmCallConsoleLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

export function createLlmCallConsoleLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  showLlmProgress?: boolean;  // 新增：是否显示 LLM 进度提示
}): LlmCallConsoleLogger | null {
  const env = params.env ?? process.env;
  const enabled = parseBooleanValue(env.CLAWDBOT_LLM_CALL_CONSOLE_LOG);
  if (enabled === false) return null;

  const base = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
  };
  
  // 默认显示进度提示，除非明确设置为 false
  const showProgress = params.showLlmProgress !== false;

  let seq = 0;

  const wrapStreamFn: LlmCallConsoleLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const callSeq = (seq += 1);
      const startedAt = Date.now();
      const m = model as Model<Api>;
      const modelTag = `${String(m.provider ?? base.provider ?? "unknown")}/${String(m.id ?? base.modelId ?? "unknown")}`;
      const apiTag = formatApiTag((m as { api?: unknown })?.api, String(base.modelApi ?? "unknown"));

      let didLogPayload = false;

      const responseSummary: ResponseSummary = { chunks: 0, samples: [] };
      const recordResponseChunk = (chunk: unknown) => {
        responseSummary.chunks += 1;
        const evidence = pickOpenAiCompletionsResponseEvidence(chunk);
        const sample = safeJsonClone(evidence, 4000);

        // Keep first 4 samples, then keep last 2 samples.
        if (responseSummary.samples.length < 4) {
          responseSummary.samples.push(sample);
          return;
        }
        if (responseSummary.samples.length < 6) {
          responseSummary.samples.push(sample);
          return;
        }
        responseSummary.samples[4] = responseSummary.samples[5];
        responseSummary.samples[5] = sample;
      };

      const nextOnPayload = (payload: unknown) => {
        if (!didLogPayload) {
          didLogPayload = true;
          
          // ⚠️ 重要：先调用下一个 wrapper 的 onPayload（格式转换 + 添加 thought_signature）
          // 然后再验证 payload（验证转换后的格式）
          options?.onPayload?.(payload);
          
          // Validate payload format after transformation
          const validation = validateAndLogPayload({
            payload,
            provider: String(m.provider ?? base.provider ?? "unknown"),
            modelApi: apiTag,
            runId: base.runId,
            sessionKey: base.sessionKey,
          });

          // Log validation errors prominently
          if (!validation.valid) {
            log.error(
              `❌ PAYLOAD VALIDATION FAILED seq=${callSeq} model=${modelTag} api=${apiTag} runId=${base.runId ?? ""} errors=${validation.errors.length} warnings=${validation.warnings.length}`,
            );
            for (const err of validation.errors) {
              log.error(`   ❌ ${err}`);
            }
          }
          
          if (validation.warnings.length > 0) {
            log.warn(
              `⚠️  PAYLOAD VALIDATION WARNINGS seq=${callSeq} model=${modelTag} api=${apiTag} runId=${base.runId ?? ""} warnings=${validation.warnings.length}`,
            );
            for (const warn of validation.warnings) {
              log.warn(`   ⚠️  ${warn}`);
            }
          }

          let payloadText = "";
          try {
            payloadText = safeJsonStringify(payload);
          } catch {
            payloadText = "[unserializable payload]";
          }
          const payloadBytes = Buffer.byteLength(payloadText, "utf8");
          log.info(
            `→ LLM请求 seq=${callSeq} model=${modelTag} api=${apiTag} runId=${base.runId ?? ""} sessionKey=${base.sessionKey ?? ""} payloadBytes=${payloadBytes} payloadPreview=${truncate(payloadText, 600)}`,
          );

          // 🔍 Tools 诊断日志：检查 payload 中是否包含 tools 定义
          if (payload && typeof payload === "object") {
            const payloadObj = payload as Record<string, unknown>;
            // Gemini 格式：tools: [{ functionDeclarations: [...] }]
            const geminiTools = payloadObj.tools;
            // OpenAI 格式：tools: [{ type: "function", function: {...} }]
            const oaiTools = payloadObj.tools;
            // config 嵌套格式：config.tools
            const configTools = (payloadObj.config as Record<string, unknown> | undefined)?.tools;
            const effectiveTools = geminiTools ?? configTools;

            if (Array.isArray(effectiveTools) && effectiveTools.length > 0) {
              // 提取函数名
              const funcNames: string[] = [];
              for (const toolGroup of effectiveTools) {
                if (toolGroup && typeof toolGroup === "object") {
                  const tg = toolGroup as Record<string, unknown>;
                  // Gemini: { functionDeclarations: [...] }
                  if (Array.isArray(tg.functionDeclarations)) {
                    for (const fd of tg.functionDeclarations) {
                      if (fd && typeof fd === "object" && typeof (fd as Record<string, unknown>).name === "string") {
                        funcNames.push((fd as Record<string, unknown>).name as string);
                      }
                    }
                  }
                  // OpenAI: { type: "function", function: { name: "..." } }
                  if (tg.type === "function" && tg.function && typeof tg.function === "object") {
                    const fn = tg.function as Record<string, unknown>;
                    if (typeof fn.name === "string") funcNames.push(fn.name);
                  }
                }
              }
              log.info(
                `🔧 Tools诊断 seq=${callSeq}: hasTools=true toolGroups=${effectiveTools.length} functionCount=${funcNames.length} functions=[${funcNames.join(", ")}]`,
              );
            } else {
              log.warn(
                `⚠️ Tools诊断 seq=${callSeq}: hasTools=false — payload 中无 tools 定义！模型无法调用任何工具`,
              );
              // 额外检查 payload 顶层键，帮助定位问题
              const topKeys = Object.keys(payloadObj).join(", ");
              log.warn(
                `⚠️ Tools诊断 seq=${callSeq}: payload顶层键=[${topKeys}]`,
              );
            }
          }

          void injectLlmProgress({
            sessionKey: base.sessionKey,
            message: `→ seq=${callSeq} model=${modelTag} api=${apiTag} bytes=${payloadBytes} runId=${base.runId ?? ""}`,
            enabled: showProgress,
          });

          void appendRuntimeTrace({
            sessionKey: base.sessionKey,
            runId: base.runId,
            event: "llm.payload",
            payload: {
              seq: callSeq,
              model: modelTag,
              api: apiTag,
              payload,
            },
          });
        } else {
          // 如果已经记录过日志，仍然需要调用下一个 wrapper
          options?.onPayload?.(payload);
        }
      };

      const result = streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });

      const finishOk = () => {
        const durationMs = Date.now() - startedAt;
        
        // 提取关键信息
        const summary = responseSummary.chunks > 0 ? responseSummary : undefined;
        let statusInfo = "✅ 成功";
        let toolsUsed = 0;
        let stopReason = "";
        
        if (summary && summary.samples.length > 0) {
          const lastSample = summary.samples[summary.samples.length - 1] as any;
          if (lastSample?.choices?.[0]?.finish_reason) {
            stopReason = lastSample.choices[0].finish_reason;
          }
          // 检查是否使用了工具
          if (lastSample?.choices?.[0]?.message?.tool_calls) {
            toolsUsed = lastSample.choices[0].message.tool_calls.length;
          }
        }
        
        const infoMsg = [
          statusInfo,
          `耗时 ${(durationMs / 1000).toFixed(1)}s`,
          stopReason ? `停止原因: ${stopReason}` : "",
          toolsUsed > 0 ? `🔧 调用工具 ${toolsUsed} 个` : "",
        ].filter(Boolean).join(" · ");
        
        log.info(
          `← LLM回复 seq=${callSeq} ok durationMs=${durationMs} model=${modelTag} api=${apiTag} runId=${base.runId ?? ""} sessionKey=${base.sessionKey ?? ""}`,
        );

        void injectLlmProgress({
          sessionKey: base.sessionKey,
          message: `[LLM] ${infoMsg}`,
          enabled: showProgress,
        });

        void appendRuntimeTrace({
          sessionKey: base.sessionKey,
          runId: base.runId,
          event: "llm.done",
          payload: {
            seq: callSeq,
            ok: true,
            durationMs,
            model: modelTag,
            api: apiTag,
            responseSummary: summary,
          },
        });
      };
      const finishErr = (err: unknown) => {
        const durationMs = Date.now() - startedAt;
        const errorMsg = formatError(err);
        const shortError = truncate(errorMsg, 100);
        
        log.warn(
          `← LLM回复 seq=${callSeq} error durationMs=${durationMs} model=${modelTag} api=${apiTag} runId=${base.runId ?? ""} sessionKey=${base.sessionKey ?? ""} err=${truncate(errorMsg, 800)}`,
        );

        void injectLlmProgress({
          sessionKey: base.sessionKey,
          message: `[LLM] ❌ 失败 · 耗时 ${(durationMs / 1000).toFixed(1)}s · ${shortError}`,
          enabled: showProgress,
        });

        void appendRuntimeTrace({
          sessionKey: base.sessionKey,
          runId: base.runId,
          event: "llm.done",
          payload: {
            seq: callSeq,
            ok: false,
            durationMs,
            model: modelTag,
            api: apiTag,
            err,
            responseSummary: responseSummary.chunks > 0 ? responseSummary : undefined,
          },
        });
      };

      if (isAsyncIterable(result)) {
        const iterable = result as unknown as object;
        const proxy = new Proxy(iterable as any, {
          get(target, prop, _receiver) {
            if (prop === Symbol.asyncIterator) {
              return () => {
                const it = (target as AsyncIterable<unknown>)[Symbol.asyncIterator]();
                return {
                  async next() {
                    try {
                      const res = await it.next();
                      if (!res.done) {
                        recordResponseChunk(res.value);
                      }
                      if (res.done) finishOk();
                      return res;
                    } catch (err) {
                      finishErr(err);
                      throw err;
                    }
                  },
                  async return(value?: unknown) {
                    try {
                      const fn = (it as unknown as { return?: (v?: unknown) => Promise<IteratorResult<unknown>> })
                        .return;
                      const res = typeof fn === "function" ? await fn.call(it, value) : undefined;
                      if (res && !res.done) {
                        recordResponseChunk(res.value);
                      }
                      finishOk();
                      return res ?? { done: true, value };
                    } catch (err) {
                      finishErr(err);
                      throw err;
                    }
                  },
                  async throw(err?: unknown) {
                    try {
                      const fn = (it as unknown as { throw?: (e?: unknown) => Promise<IteratorResult<unknown>> })
                        .throw;
                      const res = typeof fn === "function" ? await fn.call(it, err) : undefined;
                      if (res && !res.done) {
                        recordResponseChunk(res.value);
                      }
                      finishErr(err);
                      return res ?? { done: true, value: undefined };
                    } catch (e) {
                      finishErr(e);
                      throw e;
                    }
                  },
                } as AsyncIterator<unknown>;
              };
            }
            const value = Reflect.get(target, prop);
            if (typeof value === "function") return value.bind(target);
            return value;
          },
        });
        return proxy as any;
      }

      if (isPromiseLike(result)) {
        return (result as PromiseLike<unknown>).then(
          (val) => {
            recordResponseChunk(val);
            finishOk();
            return val;
          },
          (err) => {
            finishErr(err);
            throw err;
          },
        ) as any;
      }

      // Best-effort: unknown return type, log completion immediately.
      finishOk();
      return result;
    };

    return wrapped;
  };

  log.info(
    `llm call console logger enabled: default=on env=CLAWDBOT_LLM_CALL_CONSOLE_LOG runId=${base.runId ?? ""} sessionKey=${base.sessionKey ?? ""}`,
  );
  return { enabled: true, wrapStreamFn };
}
