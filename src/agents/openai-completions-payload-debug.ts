import crypto from "node:crypto";

import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/openai-completions-payload");

type DebugEntry = {
  path: string;
  name?: string;
  id?: string;
  callId?: string;
  keys?: string[];
};

function makeStableThoughtSignatureBase64(seed: string): string {
  const digest = crypto.createHash("sha256").update(seed).digest();
  return digest.subarray(0, 12).toString("base64");
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (key, val) => {
      const k = String(key);
      if (/^(apiKey|token|authorization)$/i.test(k)) {
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
        return { type: "Uint8Array", data: Buffer.from(val).toString("base64") };
      }
      return val;
    },
    2,
  );
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... truncated (${text.length} chars)`;
}

function shouldEnable(params: {
  env?: NodeJS.ProcessEnv;
  provider?: string;
  modelApi?: string | null;
}): boolean {
  const provider = (params.provider ?? "").trim().toLowerCase();
  if (!provider.includes("vectorengine")) return false;
  if ((params.modelApi ?? "").trim().toLowerCase() !== "openai-completions") return false;
  return true;
}

function isOpenAiCompletionsModel(model: Model<Api> | undefined | null): boolean {
  return (model as { api?: unknown })?.api === "openai-completions";
}

function isToolLikeType(typeValue: unknown): boolean {
  if (typeof typeValue !== "string") return false;
  const t = typeValue.trim().toLowerCase();
  return (
    t === "toolcall" ||
    t === "tool_call" ||
    t === "tooluse" ||
    t === "tool_use" ||
    t === "toolresult" ||
    t === "tool_result" ||
    t === "functioncall" ||
    t === "function_call" ||
    t === "functionresponse" ||
    t === "function_response"
  );
}

function ensureThoughtSignatureOnRecord(params: {
  record: Record<string, unknown>;
  path: string;
  report: { added: DebugEntry[] };
}): void {
  const hasSnake =
    typeof params.record.thought_signature === "string" && params.record.thought_signature.trim();
  const hasCamel =
    typeof params.record.thoughtSignature === "string" && params.record.thoughtSignature.trim();
  if (hasSnake || hasCamel) return;

  const id =
    (typeof params.record.id === "string" && params.record.id.trim() && params.record.id) ||
    (typeof params.record.call_id === "string" && params.record.call_id.trim() && params.record.call_id) ||
    "";
  const name = typeof params.record.name === "string" ? params.record.name : undefined;
  const seed = id || safeJsonStringify(params.record);
  const signature = makeStableThoughtSignatureBase64(seed);

  params.record.thought_signature = signature;
  params.record.thoughtSignature = signature;

  params.report.added.push({
    path: params.path,
    name,
    id: typeof params.record.id === "string" ? params.record.id : undefined,
    callId: typeof params.record.call_id === "string" ? params.record.call_id : undefined,
    keys: Object.keys(params.record),
  });
}

function walkAndPatch(params: {
  value: unknown;
  path: string;
  report: { added: DebugEntry[] };
}): void {
  const value = params.value;
  if (!value) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkAndPatch({ value: value[i], path: `${params.path}[${i}]`, report: params.report });
    }
    return;
  }
  if (typeof value !== "object") return;

  const rec = value as Record<string, unknown>;

  const type = rec.type;
  if (isToolLikeType(type)) {
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
  }

  if (Array.isArray(rec.tool_calls)) {
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    for (let i = 0; i < rec.tool_calls.length; i += 1) {
      const entry = rec.tool_calls[i];
      if (entry && typeof entry === "object") {
        ensureThoughtSignatureOnRecord({
          record: entry as Record<string, unknown>,
          path: `${params.path}.tool_calls[${i}]`,
          report: params.report,
        });

        const fnObj = (entry as Record<string, unknown>).function;
        if (fnObj && typeof fnObj === "object") {
          ensureThoughtSignatureOnRecord({
            record: fnObj as Record<string, unknown>,
            path: `${params.path}.tool_calls[${i}].function`,
            report: params.report,
          });
        }
      }
    }
  }
  if (Array.isArray(rec.toolCalls)) {
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    for (let i = 0; i < rec.toolCalls.length; i += 1) {
      const entry = rec.toolCalls[i];
      if (entry && typeof entry === "object") {
        ensureThoughtSignatureOnRecord({
          record: entry as Record<string, unknown>,
          path: `${params.path}.toolCalls[${i}]`,
          report: params.report,
        });

        const fnObj = (entry as Record<string, unknown>).function;
        if (fnObj && typeof fnObj === "object") {
          ensureThoughtSignatureOnRecord({
            record: fnObj as Record<string, unknown>,
            path: `${params.path}.toolCalls[${i}].function`,
            report: params.report,
          });
        }
      }
    }
  }
  if (Array.isArray(rec.tools)) {
    for (let i = 0; i < rec.tools.length; i += 1) {
      const entry = rec.tools[i];
      if (!entry || typeof entry !== "object") continue;
      ensureThoughtSignatureOnRecord({
        record: entry as Record<string, unknown>,
        path: `${params.path}.tools[${i}]`,
        report: params.report,
      });
      const fnObj = (entry as Record<string, unknown>).function;
      if (fnObj && typeof fnObj === "object") {
        ensureThoughtSignatureOnRecord({
          record: fnObj as Record<string, unknown>,
          path: `${params.path}.tools[${i}].function`,
          report: params.report,
        });
      }
    }
  }
  if (rec.function_call && typeof rec.function_call === "object") {
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({
      record: rec.function_call as Record<string, unknown>,
      path: `${params.path}.function_call`,
      report: params.report,
    });
  }
  if (rec.functionCall && typeof rec.functionCall === "object") {
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({
      record: rec.functionCall as Record<string, unknown>,
      path: `${params.path}.functionCall`,
      report: params.report,
    });
  }

  for (const [k, v] of Object.entries(rec)) {
    if (k === "thought_signature" || k === "thoughtSignature") continue;
    walkAndPatch({ value: v, path: `${params.path}.${k}`, report: params.report });
  }
}

export type OpenAiCompletionsPayloadDebugger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

export function createOpenAiCompletionsPayloadDebugger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
}): OpenAiCompletionsPayloadDebugger | null {
  if (!shouldEnable({ env: params.env, provider: params.provider, modelApi: params.modelApi })) {
    return null;
  }

  const base = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
  };

  const wrapStreamFn: OpenAiCompletionsPayloadDebugger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      if (!isOpenAiCompletionsModel(model as Model<Api>)) {
        return streamFn(model, context, options);
      }
      const nextOnPayload = (payload: unknown) => {
        const report = { added: [] as DebugEntry[] };
        walkAndPatch({ value: payload, path: "$", report });

        if (report.added.length > 0) {
          const payloadText = truncate(safeJsonStringify(payload), 60_000);
          log.info("openai-completions tool thoughtSignature patched", {
            ...base,
            added: report.added.length,
            entries: report.added,
            payload: payloadText,
          });
        } else {
          log.info("openai-completions payload", {
            ...base,
            payload: truncate(safeJsonStringify(payload), 60_000),
          });
        }
        options?.onPayload?.(payload);
      };
      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };
    return wrapped;
  };

  log.info("openai-completions payload debugger enabled", base);
  return { enabled: true, wrapStreamFn };
}

export function _test_only_walkAndPatch(value: unknown): { added: DebugEntry[] } {
  const report = { added: [] as DebugEntry[] };
  walkAndPatch({ value, path: "$", report });
  return report;
}

export function _test_only_isEnabled(params: {
  env?: NodeJS.ProcessEnv;
  provider?: string;
  modelApi?: string | null;
}): boolean {
  return shouldEnable(params);
}

export function _test_only_isToolLike(typeValue: unknown): boolean {
  return isToolLikeType(typeValue);
}

export function _test_only_isOpenAiCompletions(model: Model<Api> | undefined | null): boolean {
  return isOpenAiCompletionsModel(model);
}

export function _test_only_makeSig(seed: string): string {
  return makeStableThoughtSignatureBase64(seed);
}

export function _test_only_safeJson(value: unknown): string {
  return safeJsonStringify(value);
}

export function _test_only_truncate(text: string, limit: number): string {
  return truncate(text, limit);
}

export function _test_only_ensureRecord(rec: Record<string, unknown>): { added: DebugEntry[] } {
  const report = { added: [] as DebugEntry[] };
  ensureThoughtSignatureOnRecord({ record: rec, path: "$", report });
  return report;
}

export function _test_only_walkMessages(messages: AgentMessage[]): { added: DebugEntry[] } {
  const report = { added: [] as DebugEntry[] };
  walkAndPatch({ value: { messages }, path: "$", report });
  return report;
}
