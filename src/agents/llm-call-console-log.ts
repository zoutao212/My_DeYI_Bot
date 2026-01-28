import { Buffer } from "node:buffer";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseBooleanValue } from "../utils/boolean.js";

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

  let seq = 0;

  const wrapStreamFn: LlmCallConsoleLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const callSeq = (seq += 1);
      const startedAt = Date.now();
      const m = model as Model<Api>;
      const modelTag = `${String(m.provider ?? base.provider ?? "unknown")}/${String(m.id ?? base.modelId ?? "unknown")}`;
      const apiTag = formatApiTag((m as { api?: unknown })?.api, String(base.modelApi ?? "unknown"));

      let didLogPayload = false;
      const nextOnPayload = (payload: unknown) => {
        if (!didLogPayload) {
          didLogPayload = true;
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
        }
        options?.onPayload?.(payload);
      };

      const result = streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });

      const finishOk = () => {
        const durationMs = Date.now() - startedAt;
        log.info(
          `← LLM回复 seq=${callSeq} ok durationMs=${durationMs} model=${modelTag} api=${apiTag} runId=${base.runId ?? ""} sessionKey=${base.sessionKey ?? ""}`,
        );
      };
      const finishErr = (err: unknown) => {
        const durationMs = Date.now() - startedAt;
        log.warn(
          `← LLM回复 seq=${callSeq} error durationMs=${durationMs} model=${modelTag} api=${apiTag} runId=${base.runId ?? ""} sessionKey=${base.sessionKey ?? ""} err=${truncate(formatError(err), 800)}`,
        );
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
