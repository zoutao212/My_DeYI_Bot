import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveAgentIdFromSessionKey } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";

export type ExecutorPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
};

export type ExecutorRunResult = {
  runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  fallbackProvider: string;
  fallbackModel: string;
  llmSessionFile: string | undefined;
  outputText: string;
  contentPayloads: ExecutorPayload[];
  errorPayloads: ExecutorPayload[];
  apiErrorDetected: boolean;
  apiErrorSummary?: string;
  apiErrorSource?: "no_content_has_error_payloads" | "content_is_error_text";
};

function stripHistoricalContext(text: string): string {
  return text
    .replace(/\[Historical context:.*?Do not mimic this format[^\]]*\]/gs, "")
    .trim();
}

function isApiErrorText(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (t.length > 1500) return false;
  const patterns: RegExp[] = [
    /^⚠️\s*API\s*返回了错误/i,
    /^⚠️\s*(?:The )?AI service returned an error/i,
    /too many requests/i,
    /rate[_ ]?limit/i,
    /service unavailable/i,
    /上游负载[已已]饱和/,
    /请稍后再试/,
    /^HTTP\s+[45]\d{2}\b/i,
    /"(?:code|status)"\s*:\s*(?:429|503)/,
  ];
  let hits = 0;
  for (const p of patterns) {
    if (p.test(t)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

function normalizePayloads(payloads: Array<{ text?: string; isError?: boolean }> | undefined): {
  contentPayloads: ExecutorPayload[];
  errorPayloads: ExecutorPayload[];
} {
  const payloadArray = payloads ?? [];
  let contentPayloads = payloadArray.filter((p) => !p.isError);
  let errorPayloads = payloadArray.filter((p) => p.isError);

  // P110 类：content 中混入格式化错误文本
  const realContent = contentPayloads.filter((p) => !isApiErrorText(p.text ?? ""));
  const pseudoErrors = contentPayloads.filter((p) => isApiErrorText(p.text ?? ""));
  if (realContent.length === 0 && pseudoErrors.length > 0) {
    contentPayloads = realContent;
    errorPayloads = [...errorPayloads, ...pseudoErrors];
  } else {
    contentPayloads = realContent;
  }

  return { contentPayloads, errorPayloads };
}

function buildOutputText(contentPayloads: ExecutorPayload[]): string {
  const raw = contentPayloads.map((p) => p.text).filter(Boolean).join("\n");
  return stripHistoricalContext(raw);
}

function buildToolAllowlist(params: {
  queued: FollowupRun;
  taskType: string;
  prompt: string;
}): string[] | undefined {
  const isSubTaskExec = Boolean(params.queued.subTaskId) && !params.queued.isRootTask && !params.queued.isNewRootTask;
  if (!isSubTaskExec) return undefined;

  let allow: string[];
  const taskType = params.taskType ?? "generic";
  if (taskType === "automation") {
    allow = ["write", "read", "edit", "exec", "process", "browser", "web", "fetch"];
  } else if (taskType === "research" || taskType === "analysis") {
    allow = ["write", "read", "edit", "exec", "process", "web", "fetch"];
  } else if (taskType === "coding") {
    allow = ["write", "read", "edit", "exec", "process", "test"];
  } else {
    allow = ["write", "read", "edit", "exec", "process"];
  }

  if (!allow.includes("continue_generation")) allow.push("continue_generation");

  const MEMORY_TOOL_NAMES = [
    "memory_search",
    "memory_get",
    "memory_write",
    "memory_update",
    "memory_delete",
    "memory_list",
    "memory_deep_search",
  ];
  const promptLower = (params.prompt ?? "").toLowerCase();
  const needsMemoryTools =
    MEMORY_TOOL_NAMES.some((t) => promptLower.includes(t)) ||
    /(?:记忆|memory)\s*(?:检索|搜索|查询|写入|更新|删除|列表|工具)/.test(promptLower) ||
    /(?:使用|调用|用)\s*(?:记忆|memory)/.test(promptLower);
  if (needsMemoryTools) {
    for (const mt of MEMORY_TOOL_NAMES) {
      if (!allow.includes(mt)) allow.push(mt);
    }
  }

  return allow;
}

async function resolveIsolatedSessionFile(params: {
  queued: FollowupRun;
  sessionId: string;
  retryCount: number;
}): Promise<string | undefined> {
  let llmSessionFile = params.queued.run.sessionFile;
  if (params.queued.subTaskId && params.queued.isQueueTask) {
    const isolatedSessionDir = path.join(os.homedir(), ".clawdbot", "tasks", params.sessionId, "sessions");
    await fs.mkdir(isolatedSessionDir, { recursive: true });
    const sessionSuffix = params.retryCount > 0 ? `_retry${params.retryCount}` : "";
    llmSessionFile = path.join(isolatedSessionDir, `${params.queued.subTaskId}${sessionSuffix}.jsonl`);
  }
  return llmSessionFile;
}

function resolveEffectiveSessionKey(queued: FollowupRun): string | undefined {
  if (queued.isQueueTask && queued.subTaskId) {
    return queued.run.sessionKey ? `${queued.run.sessionKey}:task:${queued.subTaskId}` : queued.run.sessionKey;
  }
  return queued.run.sessionKey;
}

export async function executeEmbeddedLLM(params: {
  queued: FollowupRun;
  sessionId: string;
  prompt: string;
  extraSystemPrompt?: string;
  taskType: string;
  retryCount: number;
  runId: string;
  emitToolProgress?: boolean;
  emitToolProgressMinGapMs?: number;
  emitToolProgressMaxChars?: number;
  toolProgress?: {
    enabled: boolean;
    onToolResult?: (text?: string) => Promise<void>;
  };
}): Promise<ExecutorRunResult> {
  const llmSessionFile = await resolveIsolatedSessionFile({
    queued: params.queued,
    sessionId: params.sessionId,
    retryCount: params.retryCount,
  });

  const effectiveSessionFile = llmSessionFile ?? params.queued.run.sessionFile;

  const effectiveSessionKey = resolveEffectiveSessionKey(params.queued);
  const toolAllowlist = buildToolAllowlist({ queued: params.queued, taskType: params.taskType, prompt: params.prompt });

  let lastToolProgressSentAt = 0;
  let lastToolProgressText = "";
  const shouldEmitToolProgress = () => Boolean(params.emitToolProgress);
  const maybeEmitToolProgress = async (text?: string) => {
    if (!shouldEmitToolProgress()) return;
    const msg = (text ?? "").trim();
    if (!msg) return;

    const now = Date.now();
    const minGap = Math.max(0, params.emitToolProgressMinGapMs ?? 1200);
    if (now - lastToolProgressSentAt < minGap) return;
    if (msg === lastToolProgressText) return;

    const maxChars = Math.max(50, params.emitToolProgressMaxChars ?? 600);
    const clipped = msg.length > maxChars ? msg.slice(0, maxChars) + "…" : msg;
    lastToolProgressSentAt = now;
    lastToolProgressText = msg;
    if (params.toolProgress?.onToolResult) {
      await params.toolProgress.onToolResult(clipped);
    }
  };

  const fallbackResult = await runWithModelFallback({
    cfg: params.queued.run.config,
    provider: params.queued.run.provider,
    model: params.queued.run.model,
    fallbacksOverride: resolveAgentModelFallbacksOverride(
      params.queued.run.config,
      resolveAgentIdFromSessionKey(params.queued.run.sessionKey),
    ),
    run: (provider, model) => {
      const authProfileId = provider === params.queued.run.provider ? params.queued.run.authProfileId : undefined;

      return runEmbeddedPiAgent({
        sessionId: params.queued.run.sessionId,
        sessionKey: effectiveSessionKey,
        messageProvider: params.queued.run.messageProvider,
        agentAccountId: params.queued.run.agentAccountId,
        messageTo: params.queued.originatingTo,
        messageThreadId: params.queued.originatingThreadId,
        groupId: params.queued.run.groupId,
        groupChannel: params.queued.run.groupChannel,
        groupSpace: params.queued.run.groupSpace,
        sessionFile: effectiveSessionFile,
        workspaceDir: params.queued.run.workspaceDir,
        config: params.queued.run.config,
        // 🚨 Bug #2 修复: 传递 abortSignal 到子任务
        abortSignal: params.queued.abortSignal,
        // 子任务跳过 skills
        skillsSnapshot:
          Boolean(params.queued.subTaskId) && !params.queued.isRootTask && !params.queued.isNewRootTask
            ? undefined
            : params.queued.run.skillsSnapshot,
        runMode: "tool_exec_compact",
        toolAllowlist,
        skipBootstrapContext: Boolean(params.queued.subTaskId) && !params.queued.isRootTask && !params.queued.isNewRootTask,
        shouldEmitToolResult: () => Boolean(params.toolProgress?.enabled) && shouldEmitToolProgress(),
        shouldEmitToolOutput: () => false,
        onToolResult: async (payload) => {
          await maybeEmitToolProgress(payload?.text);
        },
        prompt: params.prompt,
        extraSystemPrompt: params.extraSystemPrompt,
        ownerNumbers: params.queued.run.ownerNumbers,
        enforceFinalTag: params.queued.run.enforceFinalTag,
        provider,
        model,
        authProfileId,
        authProfileIdSource: authProfileId ? params.queued.run.authProfileIdSource : undefined,
        thinkLevel: params.queued.run.thinkLevel,
        verboseLevel: params.queued.run.verboseLevel,
        reasoningLevel: params.queued.run.reasoningLevel,
        execOverrides: params.queued.run.execOverrides,
        bashElevated: params.queued.run.bashElevated,
        timeoutMs: params.queued.run.timeoutMs,
        runId: params.runId || crypto.randomUUID(),
        blockReplyBreak: params.queued.run.blockReplyBreak,
      });
    },
  });

  const runResult = fallbackResult.result;
  const normalized = normalizePayloads(runResult.payloads as any);
  const outputText = buildOutputText(normalized.contentPayloads);

  const hasErrorPayloads = normalized.errorPayloads.length > 0;
  const apiErrorDetected = (!outputText && hasErrorPayloads) || isApiErrorText(outputText);
  const apiErrorSource: ExecutorRunResult["apiErrorSource"] =
    !outputText && hasErrorPayloads
      ? "no_content_has_error_payloads"
      : isApiErrorText(outputText)
        ? "content_is_error_text"
        : undefined;
  const apiErrorSummary = apiErrorDetected
    ? (
        !outputText && hasErrorPayloads
          ? normalized.errorPayloads.map((p) => p.text).filter(Boolean).join("; ")
          : outputText
      ).substring(0, 200)
    : undefined;

  return {
    runResult,
    fallbackProvider: fallbackResult.provider,
    fallbackModel: fallbackResult.model,
    llmSessionFile,
    outputText,
    contentPayloads: normalized.contentPayloads,
    errorPayloads: normalized.errorPayloads,
    apiErrorDetected,
    apiErrorSummary,
    apiErrorSource,
  };
}
