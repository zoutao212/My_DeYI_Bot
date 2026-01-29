import crypto from "node:crypto";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import { createSubsystemLogger } from "../logging/subsystem.js";
import { appendRuntimeTrace } from "../gateway/runtime-log.js";

const log = createSubsystemLogger("agent/gemini-payload");

type PatchEntry = {
  path: string;
  name?: string;
  keys?: string[];
};

type ScanReport = {
  added: PatchEntry[];
  candidates: number;
  missingBefore: number;
  missingPaths: string[];
};

function makeStableThoughtSignatureBase64(seed: string): string {
  const digest = crypto.createHash("sha256").update(seed).digest();
  return digest.subarray(0, 12).toString("base64");
}

function shouldEnable(params: {
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
}): boolean {
  const provider = (params.provider ?? "").trim().toLowerCase();
  if (provider.includes("vectorengine")) return true;
  return false;
}

function ensureThoughtSignatureOnRecord(params: {
  record: Record<string, unknown>;
  path: string;
  report: ScanReport;
}): void {
  const hasSnake =
    typeof params.record.thought_signature === "string" && params.record.thought_signature.trim();
  const hasCamel =
    typeof params.record.thoughtSignature === "string" && params.record.thoughtSignature.trim();
  if (hasSnake || hasCamel) return;

  const name =
    typeof params.record.name === "string"
      ? params.record.name
      : typeof params.record.functionName === "string"
        ? params.record.functionName
        : typeof params.record.toolName === "string"
          ? params.record.toolName
          : undefined;

  const seed =
    (typeof params.record.id === "string" && params.record.id.trim() && params.record.id) ||
    (typeof params.record.call_id === "string" && params.record.call_id.trim() && params.record.call_id) ||
    (typeof params.record.toolCallId === "string" && params.record.toolCallId.trim() && params.record.toolCallId) ||
    `${params.path}:${name ?? ""}`;

  const signature = makeStableThoughtSignatureBase64(seed);
  params.record.thought_signature = signature;
  params.record.thoughtSignature = signature;
  params.report.added.push({
    path: params.path,
    name,
    keys: Object.keys(params.record),
  });
}

function noteCandidate(params: {
  record: Record<string, unknown>;
  path: string;
  report: ScanReport;
}): void {
  params.report.candidates += 1;
  const hasSnake =
    typeof params.record.thought_signature === "string" && params.record.thought_signature.trim();
  const hasCamel =
    typeof params.record.thoughtSignature === "string" && params.record.thoughtSignature.trim();
  if (hasSnake || hasCamel) return;
  params.report.missingBefore += 1;
  if (params.report.missingPaths.length < 20) {
    params.report.missingPaths.push(params.path);
  }
}

function walkAndPatch(params: {
  value: unknown;
  path: string;
  report: ScanReport;
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

  const role = typeof rec.role === "string" ? rec.role.trim().toLowerCase() : "";
  const isToolResultMessage = role === "tool" || typeof rec.tool_call_id === "string";
  if (isToolResultMessage) {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
  }

  const type = rec.type;
  const typeText = typeof type === "string" ? type.trim().toLowerCase() : "";
  const isFunctionCallType =
    typeText === "functioncall" ||
    typeText === "function_call" ||
    typeText === "toolcall" ||
    typeText === "tool_call" ||
    typeText === "tooluse" ||
    typeText === "tool_use";

  if (isFunctionCallType) {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
  }

  const parts = rec.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part || typeof part !== "object") continue;
      const partRec = part as Record<string, unknown>;
      noteCandidate({
        record: partRec,
        path: `${params.path}.parts[${i}]`,
        report: params.report,
      });
      ensureThoughtSignatureOnRecord({
        record: partRec,
        path: `${params.path}.parts[${i}]`,
        report: params.report,
      });
    }
  }

  const hasNestedFunctionCallPart =
    (rec.functionCall && typeof rec.functionCall === "object") ||
    (rec.function_call && typeof rec.function_call === "object") ||
    (rec.functionResponse && typeof rec.functionResponse === "object") ||
    (rec.function_response && typeof rec.function_response === "object");
  if (hasNestedFunctionCallPart) {
    // Some Gemini/OpenAI-completions adapters validate the *part wrapper* (contents[].parts[].*)
    // for thought_signature when it contains a functionCall/functionResponse. Patch the wrapper too.
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
  }

  const toolCallsSnake = rec.tool_calls;
  if (Array.isArray(toolCallsSnake)) {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    for (let i = 0; i < toolCallsSnake.length; i += 1) {
      const entry = toolCallsSnake[i];
      if (!entry || typeof entry !== "object") continue;
      noteCandidate({
        record: entry as Record<string, unknown>,
        path: `${params.path}.tool_calls[${i}]`,
        report: params.report,
      });
      ensureThoughtSignatureOnRecord({
        record: entry as Record<string, unknown>,
        path: `${params.path}.tool_calls[${i}]`,
        report: params.report,
      });

      const fnObj = (entry as Record<string, unknown>).function;
      if (fnObj && typeof fnObj === "object") {
        noteCandidate({
          record: fnObj as Record<string, unknown>,
          path: `${params.path}.tool_calls[${i}].function`,
          report: params.report,
        });
        ensureThoughtSignatureOnRecord({
          record: fnObj as Record<string, unknown>,
          path: `${params.path}.tool_calls[${i}].function`,
          report: params.report,
        });
      }
    }
  }
  const toolCallsCamel = rec.toolCalls;
  if (Array.isArray(toolCallsCamel)) {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    for (let i = 0; i < toolCallsCamel.length; i += 1) {
      const entry = toolCallsCamel[i];
      if (!entry || typeof entry !== "object") continue;
      noteCandidate({
        record: entry as Record<string, unknown>,
        path: `${params.path}.toolCalls[${i}]`,
        report: params.report,
      });
      ensureThoughtSignatureOnRecord({
        record: entry as Record<string, unknown>,
        path: `${params.path}.toolCalls[${i}]`,
        report: params.report,
      });

      const fnObj = (entry as Record<string, unknown>).function;
      if (fnObj && typeof fnObj === "object") {
        noteCandidate({
          record: fnObj as Record<string, unknown>,
          path: `${params.path}.toolCalls[${i}].function`,
          report: params.report,
        });
        ensureThoughtSignatureOnRecord({
          record: fnObj as Record<string, unknown>,
          path: `${params.path}.toolCalls[${i}].function`,
          report: params.report,
        });
      }
    }
  }

  const functionObj = rec.function;
  if (functionObj && typeof functionObj === "object") {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    noteCandidate({
      record: functionObj as Record<string, unknown>,
      path: `${params.path}.function`,
      report: params.report,
    });
    ensureThoughtSignatureOnRecord({
      record: functionObj as Record<string, unknown>,
      path: `${params.path}.function`,
      report: params.report,
    });
  }

  const functionCall = rec.functionCall;
  if (functionCall && typeof functionCall === "object") {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    noteCandidate({
      record: functionCall as Record<string, unknown>,
      path: `${params.path}.functionCall`,
      report: params.report,
    });
    ensureThoughtSignatureOnRecord({
      record: functionCall as Record<string, unknown>,
      path: `${params.path}.functionCall`,
      report: params.report,
    });
  }
  const function_call = rec.function_call;
  if (function_call && typeof function_call === "object") {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    noteCandidate({
      record: function_call as Record<string, unknown>,
      path: `${params.path}.function_call`,
      report: params.report,
    });
    ensureThoughtSignatureOnRecord({
      record: function_call as Record<string, unknown>,
      path: `${params.path}.function_call`,
      report: params.report,
    });
  }

  const functionResponse = rec.functionResponse;
  if (functionResponse && typeof functionResponse === "object") {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    noteCandidate({
      record: functionResponse as Record<string, unknown>,
      path: `${params.path}.functionResponse`,
      report: params.report,
    });
    ensureThoughtSignatureOnRecord({
      record: functionResponse as Record<string, unknown>,
      path: `${params.path}.functionResponse`,
      report: params.report,
    });
  }
  const function_response = rec.function_response;
  if (function_response && typeof function_response === "object") {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({ record: rec, path: params.path, report: params.report });
    noteCandidate({
      record: function_response as Record<string, unknown>,
      path: `${params.path}.function_response`,
      report: params.report,
    });
    ensureThoughtSignatureOnRecord({
      record: function_response as Record<string, unknown>,
      path: `${params.path}.function_response`,
      report: params.report,
    });
  }

  for (const [k, v] of Object.entries(rec)) {
    if (k === "thought_signature" || k === "thoughtSignature") continue;
    walkAndPatch({ value: v, path: `${params.path}.${k}`, report: params.report });
  }
}

export type GeminiPayloadThoughtSignaturePatcher = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

export function createGeminiPayloadThoughtSignaturePatcher(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
}): GeminiPayloadThoughtSignaturePatcher | null {
  if (!shouldEnable({ provider: params.provider, modelApi: params.modelApi, modelId: params.modelId })) {
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

  const wrapStreamFn: GeminiPayloadThoughtSignaturePatcher["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const nextOnPayload = (payload: unknown) => {
        const report: ScanReport = {
          added: [],
          candidates: 0,
          missingBefore: 0,
          missingPaths: [],
        };
        walkAndPatch({ value: payload, path: "$", report });
        
        // Safety check: Verify no assistant messages with null content remain
        // (should have been fixed in sanitizeSessionHistory)
        if (payload && typeof payload === "object" && "messages" in payload) {
          const messages = (payload as Record<string, unknown>).messages;
          if (Array.isArray(messages)) {
            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i];
              if (msg && typeof msg === "object") {
                const msgRec = msg as Record<string, unknown>;
                const role = typeof msgRec.role === "string" ? msgRec.role.trim().toLowerCase() : "";
                if (role === "assistant" && msgRec.content === null) {
                  log.error(`❌ BUG: assistant.content is still null after sanitization (message index: ${i})`);
                  // Emergency fix to prevent API failure
                  const hadToolCalls = Boolean(msgRec.tool_calls || msgRec.toolCalls);
                  msgRec.content = "";
                  log.info(`[payload] Fixed content: null → "" (index: ${i}, hasToolCalls: ${hadToolCalls})`);
                }
              }
            }
          }
        }
        
        const summary = {
          ...base,
          modelApi: (model as Model<Api>)?.api,
          candidates: report.candidates,
          missingBefore: report.missingBefore,
          added: report.added.length,
          missingPaths: report.missingPaths,
          entries: report.added.slice(0, 40),
        };
        if (report.candidates > 0 || report.added.length > 0 || report.missingBefore > 0) {
          log.info(`gemini payload thoughtSignature scan: ${JSON.stringify(summary)}`);
        }

        void appendRuntimeTrace({
          sessionKey: base.sessionKey,
          runId: base.runId,
          event: "patch.thought_signature.scan",
          payload: {
            provider: base.provider,
            modelId: base.modelId,
            modelApi: String((model as Model<Api>)?.api ?? base.modelApi ?? ""),
            candidates: report.candidates,
            missingBefore: report.missingBefore,
            added: report.added.length,
            missingPaths: report.missingPaths,
            entries: report.added.slice(0, 40),
          },
        });
        options?.onPayload?.(payload);
      };
      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };
    return wrapped;
  };

  log.info("gemini payload thoughtSignature patcher enabled", base);
  return { enabled: true, wrapStreamFn };
}
