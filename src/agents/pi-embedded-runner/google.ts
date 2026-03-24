import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import { registerUnhandledRejectionHandler } from "../../infra/unhandled-rejections.js";
import {
  downgradeOpenAIReasoningBlocks,
  isCompactionFailureError,
  isGoogleModelApi,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "../pi-embedded-helpers.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { log } from "./logger.js";
import { describeUnknownError } from "./utils.js";
import { cleanToolSchemaForGemini } from "../pi-tools.schema.js";
import type { TranscriptPolicy } from "../transcript-policy.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";

const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";
const GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);
const ANTIGRAVITY_SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidAntigravitySignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length % 4 !== 0) return false;
  return ANTIGRAVITY_SIGNATURE_RE.test(trimmed);
}

function shouldEnsureGeminiToolThoughtSignatures(params: {
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
}): boolean {
  const provider = (params.provider ?? "").trim().toLowerCase();
  const modelId = (params.modelId ?? "").trim().toLowerCase();
  const modelApi = (params.modelApi ?? "").trim().toLowerCase();
  if (provider.includes("vectorengine")) return true;
  if (modelId.includes("gemini")) return true;
  if (modelApi.includes("gemini")) return true;
  return false;
}

function makeStableThoughtSignatureBase64(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  return digest.subarray(0, 12).toString("base64");
}

type ToolThoughtSignatureReport = {
  added: number;
  byTool: Record<string, number>;
};

function ensureGeminiToolThoughtSignatures(messages: AgentMessage[]): {
  messages: AgentMessage[];
  report: ToolThoughtSignatureReport;
} {
  let touched = false;
  let added = 0;
  const byTool = new Map<string, number>();
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;

    const assistantRecord = assistant as unknown as Record<string, unknown>;
    const toolCallsRaw =
      assistantRecord.toolCalls ?? assistantRecord.tool_calls;
    const toolCalls = Array.isArray(toolCallsRaw) ? toolCallsRaw : null;
    let toolCallsChanged = false;
    let patchedToolCalls: unknown[] | null = null;
    if (toolCalls && toolCalls.length > 0) {
      patchedToolCalls = toolCalls.map((call) => {
        if (!call || typeof call !== "object") return call;
        const rec = call as {
          id?: unknown;
          name?: unknown;
          thoughtSignature?: unknown;
          thought_signature?: unknown;
        };
        const hasSnake = typeof rec.thought_signature === "string" && rec.thought_signature.trim();
        const hasCamel = typeof rec.thoughtSignature === "string" && rec.thoughtSignature.trim();

        const id = typeof rec.id === "string" ? rec.id : "";
        const signature =
          (hasSnake ? String(rec.thought_signature) : hasCamel ? String(rec.thoughtSignature) : "") ||
          makeStableThoughtSignatureBase64(id || JSON.stringify(call));
        const toolName =
          typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : "(unknown)";

        const callRecord = call as unknown as Record<string, unknown>;
        const nextRecord: Record<string, unknown> = { ...callRecord };
        let changed = false;
        if (!(hasSnake || hasCamel)) {
          nextRecord.thoughtSignature = signature;
          nextRecord.thought_signature = signature;
          byTool.set(toolName, (byTool.get(toolName) ?? 0) + 1);
          added += 1;
          changed = true;
        }

        const fnObj = nextRecord.function;
        if (fnObj && typeof fnObj === "object") {
          const fnRec = fnObj as Record<string, unknown>;
          const fnHasSnake = typeof fnRec.thought_signature === "string" && fnRec.thought_signature.trim();
          const fnHasCamel = typeof fnRec.thoughtSignature === "string" && fnRec.thoughtSignature.trim();
          if (!(fnHasSnake || fnHasCamel)) {
            nextRecord.function = {
              ...fnRec,
              thoughtSignature: signature,
              thought_signature: signature,
            };
            added += 1;
            changed = true;
          }
        }

        if (!changed) return call;
        toolCallsChanged = true;
        return nextRecord;
      });
    }

    if (!Array.isArray(assistant.content)) {
      if (toolCallsChanged && patchedToolCalls) {
        touched = true;
        if (Array.isArray(assistantRecord.toolCalls)) {
          out.push(
            ({
              ...(assistant as unknown as Record<string, unknown>),
              toolCalls: patchedToolCalls,
            } as unknown) as AgentMessage,
          );
        } else {
          out.push(
            ({
              ...(assistant as unknown as Record<string, unknown>),
              tool_calls: patchedToolCalls,
            } as unknown) as AgentMessage,
          );
        }
      } else {
        out.push(msg);
      }
      continue;
    }
    type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of assistant.content) {
      if (!block || typeof block !== "object") {
        nextContent.push(block);
        continue;
      }
      const rec = block as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        parts?: unknown;
        thoughtSignature?: unknown;
        thought_signature?: unknown;
      };
      const type = rec.type;
      const id = typeof rec.id === "string" ? rec.id : "";
      const typeText = typeof type === "string" ? type : "";
      const typeNormalized = typeText.trim().toLowerCase();
      const isToolCall =
        type === "toolCall" ||
        type === "toolUse" ||
        type === "functionCall" ||
        type === "tool_call" ||
        type === "function_call" ||
        typeNormalized === "toolcall" ||
        typeNormalized === "tooluse" ||
        typeNormalized === "functioncall" ||
        typeNormalized === "tool_call" ||
        typeNormalized === "function_call";
      if (!isToolCall) {
        nextContent.push(block);
        continue;
      }
      const hasSnake = typeof rec.thought_signature === "string" && rec.thought_signature.trim();
      const hasCamel = typeof rec.thoughtSignature === "string" && rec.thoughtSignature.trim();

      const signature =
        (hasSnake ? String(rec.thought_signature) : hasCamel ? String(rec.thoughtSignature) : "") ||
        makeStableThoughtSignatureBase64(id || JSON.stringify(block));
      const toolName = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : "(unknown)";

      const blockRecord = block as unknown as Record<string, unknown>;
      const nextRecord: Record<string, unknown> = { ...blockRecord };
      let blockChanged = false;

      if (!(hasSnake || hasCamel)) {
        nextRecord.thoughtSignature = signature;
        nextRecord.thought_signature = signature;
        byTool.set(toolName, (byTool.get(toolName) ?? 0) + 1);
        added += 1;
        blockChanged = true;
      }

      if (Array.isArray(rec.parts) && rec.parts.length > 0) {
        const nextParts = rec.parts.map((part, idx) => {
          if (!part || typeof part !== "object") return part;
          const partRec = part as Record<string, unknown>;
          const partHasSnake =
            typeof partRec.thought_signature === "string" && String(partRec.thought_signature).trim();
          const partHasCamel =
            typeof partRec.thoughtSignature === "string" && String(partRec.thoughtSignature).trim();
          if (partHasSnake || partHasCamel) return part;
          const partSignature = makeStableThoughtSignatureBase64(
            `${signature}:part:${idx}:${JSON.stringify(partRec)}`,
          );
          added += 1;
          blockChanged = true;
          return {
            ...partRec,
            thoughtSignature: partSignature,
            thought_signature: partSignature,
          };
        });
        nextRecord.parts = nextParts;
      }

      if (!blockChanged) {
        nextContent.push(block);
        continue;
      }

      nextContent.push(nextRecord as unknown as AssistantContentBlock);
      changed = true;
    }
    if (changed || toolCallsChanged) {
      touched = true;
      const nextAssistant = { ...assistant, content: nextContent } as unknown as Record<string, unknown>;
      if (toolCallsChanged && patchedToolCalls) {
        if (Array.isArray(assistantRecord.toolCalls)) {
          nextAssistant.toolCalls = patchedToolCalls;
          delete nextAssistant.tool_calls;
        } else {
          nextAssistant.tool_calls = patchedToolCalls;
          delete nextAssistant.toolCalls;
        }
      }
      out.push(nextAssistant as unknown as AgentMessage);
    } else {
      out.push(msg);
    }
  }
  const report: ToolThoughtSignatureReport = {
    added,
    byTool: Object.fromEntries(Array.from(byTool.entries()).sort((a, b) => b[1] - a[1])),
  };
  return { messages: touched ? out : messages, report };
}

function sanitizeAntigravityThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistant.content)) {
      out.push(msg);
      continue;
    }
    type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
    const nextContent: AssistantContentBlock[] = [];
    let contentChanged = false;
    for (const block of assistant.content) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "thinking"
      ) {
        nextContent.push(block);
        continue;
      }
      const rec = block as {
        thinkingSignature?: unknown;
        signature?: unknown;
        thought_signature?: unknown;
        thoughtSignature?: unknown;
      };
      const candidate =
        rec.thinkingSignature ?? rec.signature ?? rec.thought_signature ?? rec.thoughtSignature;
      if (!isValidAntigravitySignature(candidate)) {
        contentChanged = true;
        continue;
      }
      if (rec.thinkingSignature !== candidate) {
        const nextBlock = {
          ...(block as unknown as Record<string, unknown>),
          thinkingSignature: candidate,
        } as AssistantContentBlock;
        nextContent.push(nextBlock);
        contentChanged = true;
      } else {
        nextContent.push(block);
      }
    }
    if (contentChanged) {
      touched = true;
    }
    if (nextContent.length === 0) {
      touched = true;
      continue;
    }
    out.push(contentChanged ? { ...assistant, content: nextContent } : msg);
  }
  return touched ? out : messages;
}

function findUnsupportedSchemaKeywords(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findUnsupportedSchemaKeywords(item, `${path}[${index}]`),
    );
  }
  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") continue;
    if (GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS.has(key)) {
      violations.push(`${path}.${key}`);
    }
    if (value && typeof value === "object") {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.${key}`));
    }
  }
  return violations;
}

export function sanitizeToolsForGoogle<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
}): AgentTool<TSchemaType, TResult>[] {
  if (params.provider !== "google-antigravity" && params.provider !== "google-gemini-cli") {
    return params.tools;
  }
  return params.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") return tool;
    return {
      ...tool,
      parameters: cleanToolSchemaForGemini(
        tool.parameters as Record<string, unknown>,
      ) as TSchemaType,
    };
  });
}

export function logToolSchemasForGoogle(params: { tools: AgentTool[]; provider: string }) {
  if (params.provider !== "google-antigravity" && params.provider !== "google-gemini-cli") {
    return;
  }
  const toolNames = params.tools.map((tool, index) => `${index}:${tool.name}`);
  const tools = sanitizeToolsForGoogle(params);
  log.info("google tool schema snapshot", {
    provider: params.provider,
    toolCount: tools.length,
    tools: toolNames,
  });
  for (const [index, tool] of tools.entries()) {
    const violations = findUnsupportedSchemaKeywords(tool.parameters, `${tool.name}.parameters`);
    if (violations.length > 0) {
      log.warn("google tool schema has unsupported keywords", {
        index,
        tool: tool.name,
        violations: violations.slice(0, 12),
        violationCount: violations.length,
      });
    }
  }
}

// Event emitter for unhandled compaction failures that escape try-catch blocks.
// Listeners can use this to trigger session recovery with retry.
const compactionFailureEmitter = new EventEmitter();

export type CompactionFailureListener = (reason: string) => void;

/**
 * Register a listener for unhandled compaction failures.
 * Called when auto-compaction fails in a way that escapes the normal try-catch,
 * e.g., when the summarization request itself exceeds the model's token limit.
 * Returns an unsubscribe function.
 */
export function onUnhandledCompactionFailure(cb: CompactionFailureListener): () => void {
  compactionFailureEmitter.on("failure", cb);
  return () => compactionFailureEmitter.off("failure", cb);
}

registerUnhandledRejectionHandler((reason) => {
  const message = describeUnknownError(reason);
  if (!isCompactionFailureError(message)) return false;
  log.error(`Auto-compaction failed (unhandled): ${message}`);
  compactionFailureEmitter.emit("failure", message);
  return true;
});

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

type ModelSnapshotEntry = {
  timestamp: number;
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
};

const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";

function readLastModelSnapshot(sessionManager: SessionManager): ModelSnapshotEntry | null {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as CustomEntryLike;
      if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) continue;
      const data = entry?.data as ModelSnapshotEntry | undefined;
      if (data && typeof data === "object") {
        return data;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function appendModelSnapshot(sessionManager: SessionManager, data: ModelSnapshotEntry): void {
  try {
    sessionManager.appendCustomEntry(MODEL_SNAPSHOT_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}

function isSameModelSnapshot(a: ModelSnapshotEntry, b: ModelSnapshotEntry): boolean {
  const normalize = (value?: string | null) => value ?? "";
  return (
    normalize(a.provider) === normalize(b.provider) &&
    normalize(a.modelApi) === normalize(b.modelApi) &&
    normalize(a.modelId) === normalize(b.modelId)
  );
}

function hasGoogleTurnOrderingMarker(sessionManager: SessionManager): boolean {
  try {
    return sessionManager
      .getEntries()
      .some(
        (entry) =>
          (entry as CustomEntryLike)?.type === "custom" &&
          (entry as CustomEntryLike)?.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE,
      );
  } catch {
    return false;
  }
}

function markGoogleTurnOrderingMarker(sessionManager: SessionManager): void {
  try {
    sessionManager.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
      timestamp: Date.now(),
    });
  } catch {
    // ignore marker persistence failures
  }
}

export function applyGoogleTurnOrderingFix(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  sessionManager: SessionManager;
  sessionId: string;
  warn?: (message: string) => void;
  isQueueTask?: boolean;
}): { messages: AgentMessage[]; didPrepend: boolean } {
  if (!isGoogleModelApi(params.modelApi)) {
    return { messages: params.messages, didPrepend: false };
  }
  const first = params.messages[0] as { role?: unknown; content?: unknown } | undefined;
  if (first?.role !== "assistant") {
    return { messages: params.messages, didPrepend: false };
  }
  
  // ⚠️ 修复：子任务执行时不添加 bootstrap 消息
  // 原因：bootstrap 消息会干扰 LLM 的理解，导致它认为这是"新会话"
  // 而不是一个需要执行具体工具调用的子任务
  if (params.isQueueTask) {
    const warn = params.warn ?? ((message: string) => log.warn(message));
    warn(`google turn ordering fixup: skipped bootstrap for queue task (sessionId=${params.sessionId})`);
    return { messages: params.messages, didPrepend: false };
  }
  
  const sanitized = sanitizeGoogleTurnOrdering(params.messages);
  const didPrepend = sanitized !== params.messages;
  
  // ✅ 不再将 bootstrap 标记保存到 Session 文件
  // bootstrap 标记只在内存中使用，用于满足 Google API 的要求
  // 不应该保存到 Session 文件，否则会导致 LLM 认为这是"新会话"
  if (didPrepend) {
    const warn = params.warn ?? ((message: string) => log.warn(message));
    warn(`google turn ordering fixup: prepended user bootstrap (sessionId=${params.sessionId})`);
  }
  
  return { messages: sanitized, didPrepend };
}

/**
 * 移除 Pipeline 前缀
 * 
 * Pipeline 会在用户消息前添加 "🔵 [Pipeline Active] ..." 前缀
 * 这些前缀在历史消息中是重复的，应该移除
 */
function stripPipelinePrefix(text: string): string {
  // 移除 "🔵 [Pipeline Active] 动态管道已激活，使用默认系统提示词"
  // 移除 "🔵 [Pipeline Active] 动态管道已激活，角色：xxx"
  return text.replace(/^🔵 \[Pipeline Active\].*?\n+/s, "");
}

/**
 * 移除重复的系统提示词
 * 
 * 检测并移除用户消息中重复出现的系统提示词模式
 * 只保留第一次出现的内容
 * 
 * 包括：
 * - 角色定义（SOUL.md, USER.md, 角色设定）
 * - 工具定义（## 工具定义, ## Available Tools）
 * - Skills 定义（## Skills, ## 技能）
 * - 上下文文件（## 上下文文件, ## Context Files）
 * - 运行时信息（## 运行时信息, ## Runtime Info）
 */
function stripSystemPromptDuplicates(text: string): string {
  // 检测重复的系统提示词模式
  const patterns = [
    // 角色定义
    /【系统人物卡.*?】.*?(?=\[message_id:|##|$)/gs,
    /SOUL\.md.*?(?=\[message_id:|##|$)/gs,
    /USER\.md.*?(?=\[message_id:|##|$)/gs,
    /## 角色设定.*?(?=\[message_id:|##|$)/gs,
    /# 角色设定.*?(?=\[message_id:|##|$)/gs,
    /## User Identity.*?(?=\[message_id:|##|$)/gs,
    /## 用户身份.*?(?=\[message_id:|##|$)/gs,
    
    // 工具定义
    /## 工具定义.*?(?=\[message_id:|##|$)/gs,
    /## Available Tools.*?(?=\[message_id:|##|$)/gs,
    /## Tooling.*?(?=\[message_id:|##|$)/gs,
    
    // Skills 定义
    /## Skills.*?(?=\[message_id:|##|$)/gs,
    /## 技能.*?(?=\[message_id:|##|$)/gs,
    /## Workspace Skills.*?(?=\[message_id:|##|$)/gs,
    
    // 上下文文件
    /## 上下文文件.*?(?=\[message_id:|##|$)/gs,
    /## Context Files.*?(?=\[message_id:|##|$)/gs,
    /## Bootstrap Files.*?(?=\[message_id:|##|$)/gs,
    
    // 运行时信息
    /## 运行时信息.*?(?=\[message_id:|##|$)/gs,
    /## Runtime Info.*?(?=\[message_id:|##|$)/gs,
    /## System Information.*?(?=\[message_id:|##|$)/gs,
    
    // 记忆系统
    /## 记忆检索.*?(?=\[message_id:|##|$)/gs,
    /## Memory Recall.*?(?=\[message_id:|##|$)/gs,
    
    // 任务分解
    /## 任务分解.*?(?=\[message_id:|##|$)/gs,
    /## Task Decomposition.*?(?=\[message_id:|##|$)/gs,
    
    // 消息系统
    /## Messaging.*?(?=\[message_id:|##|$)/gs,
    /## 消息发送.*?(?=\[message_id:|##|$)/gs,
    
    // 时间信息
    /## Current Date & Time.*?(?=\[message_id:|##|$)/gs,
    /## 当前日期与时间.*?(?=\[message_id:|##|$)/gs,
  ];
  
  let cleaned = text;
  for (const pattern of patterns) {
    const matches = Array.from(text.matchAll(pattern));
    if (matches.length > 1) {
      // 只保留第一次出现，移除后续重复
      let firstMatch = true;
      cleaned = cleaned.replace(pattern, (match) => {
        if (firstMatch) {
          firstMatch = false;
          return match;
        }
        return "";
      });
    }
  }
  
  return cleaned;
}

export async function sanitizeSessionHistory(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  modelId?: string;
  provider?: string;
  sessionManager: SessionManager;
  sessionId: string;
  policy?: TranscriptPolicy;
  isQueueTask?: boolean;
}): Promise<AgentMessage[]> {
  // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
  
  // 🔧 Fix: Normalize user messages with object content (should be array)
  // This must happen FIRST to ensure all messages have the correct format
  let userContentFixedCount = 0;
  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i];
    const msgAny = msg as any;
    
    // Fix user messages with object content (should be array)
    if (msg.role === "user" && msgAny.content && typeof msgAny.content === "object" && !Array.isArray(msgAny.content)) {
      // Convert object to array
      msgAny.content = [msgAny.content];
      userContentFixedCount++;
      log.info(`✓ Fixed user.content: object → array (message index: ${i}, sessionId: ${params.sessionId})`);
    }
  }
  if (userContentFixedCount > 0) {
    log.info(`[sanitize] Fixed ${userContentFixedCount} user messages with object content (sessionId: ${params.sessionId})`);
  }
  
  // 🆕 Step 2: 清理用户消息中的 Pipeline 前缀和重复的系统提示词
  let pipelinePrefixRemovedCount = 0;
  let systemPromptDuplicatesRemovedCount = 0;
  
  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          const originalText = block.text;
          
          // 移除 Pipeline 前缀
          let cleanedText = stripPipelinePrefix(block.text);
          if (cleanedText !== originalText) {
            pipelinePrefixRemovedCount++;
          }
          
          // 移除重复的系统提示词
          const beforeDuplicateRemoval = cleanedText;
          cleanedText = stripSystemPromptDuplicates(cleanedText);
          if (cleanedText !== beforeDuplicateRemoval) {
            systemPromptDuplicatesRemovedCount++;
          }
          
          // 更新 block.text
          block.text = cleanedText;
        }
      }
    }
  }
  
  if (pipelinePrefixRemovedCount > 0) {
    log.info(`[sanitize] Removed Pipeline prefix from ${pipelinePrefixRemovedCount} user messages (sessionId: ${params.sessionId})`);
  }
  if (systemPromptDuplicatesRemovedCount > 0) {
    log.info(`[sanitize] Removed system prompt duplicates from ${systemPromptDuplicatesRemovedCount} user messages (sessionId: ${params.sessionId})`);
  }
  
  // 🆕 Step 3: 提取系统上下文并保存到 SessionManager（三层消息结构）
  const { extractSystemContext, hasSystemContextInSession, saveSystemContextToSession } = await import("../system-context-extractor.js");
  
  if (!hasSystemContextInSession(params.sessionManager)) {
    const { systemContextContent, systemContextMetadata, cleanedMessages } = extractSystemContext(params.messages);
    
    if (systemContextContent && systemContextMetadata) {
      // 保存系统上下文到 SessionManager
      saveSystemContextToSession(params.sessionManager, systemContextContent, systemContextMetadata);
      
      // 使用清理后的消息
      params.messages = cleanedMessages;
      
      log.info(`[sanitize] Extracted and saved system context to SessionManager (sessionId: ${params.sessionId})`);
    }
  } else {
    log.debug(`[sanitize] System context already exists in SessionManager (sessionId: ${params.sessionId})`);
  }
  
  // 🔧 Fix: Normalize assistant messages with null content (OpenAI API requirement)
  // This must happen BEFORE any other processing to ensure the fix is persisted
  let fixedCount = 0;
  let toolResultCount = 0;
  
  // 🔧 Fix: For vectorengine, fix Gemini format functionResponse.name = "unknown"
  // vectorengine uses Gemini format in session, but functionResponse.name may be "unknown"
  // We need to match functionCall and functionResponse by order to fix the name
  const geminiToolNames: string[] = [];
  
  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i];
    const msgAny = msg as any;
    
    // Extract toolName from Gemini format functionCall (role: "model")
    if (msgAny.role === "model" && msgAny.parts) {
      for (const part of msgAny.parts) {
        if (part && typeof part === "object" && part.functionCall) {
          const toolName = part.functionCall.name;
          if (typeof toolName === "string") {
            geminiToolNames.push(toolName);
            log.debug(`[sanitize] Extracted toolName from functionCall: "${toolName}" (index=${i})`);
          }
        }
      }
    }
    
    // Fix Gemini format functionResponse.name = "unknown" (role: "user" or "function")
    // 🔧 Fix: Also handle role="function" (used by some providers)
    if ((msg.role === "user" || (msgAny.role === "function" as any)) && msgAny.parts) {
      for (const part of msgAny.parts) {
        if (part && typeof part === "object" && part.functionResponse) {
          if (part.functionResponse.name === "unknown" && geminiToolNames.length > 0) {
            const toolName = geminiToolNames.shift()!;
            part.functionResponse.name = toolName;
            log.info(`[sanitize] ✓ Fixed Gemini functionResponse.name: "unknown" → "${toolName}" (role=${msg.role}, index=${i})`);
          } else if (geminiToolNames.length > 0) {
            // Remove from queue even if name is not "unknown"
            geminiToolNames.shift();
            log.debug(`[sanitize] functionResponse already has name="${part.functionResponse.name}", removed from queue (role=${msg.role}, index=${i})`);
          }
        }
      }
    }
    
    if (msg.role === "assistant") {
      const contentType = msg.content === null ? "null" : Array.isArray(msg.content) ? `array(${msg.content.length})` : typeof msg.content;
      log.debug(`[sanitize] message[${i}]: role=assistant, content=${contentType}`);
      if (msg.content === null) {
        msg.content = [] as never; // Empty array for assistant messages with only tool_calls
        fixedCount++;
        log.info(`✓ Fixed assistant.content: null → [] (message index: ${i}, sessionId: ${params.sessionId})`);
      } else if (Array.isArray(msg.content) && msg.content.length === 0) {
        log.debug(`[sanitize] message[${i}]: content is already empty array (good!)`);
      }
    }
    
    // 🔧 Fix: Convert toolResult messages to OpenAI format (role: "tool")
    // This is required for vectorengine and other Gemini-compatible APIs
    if (msg.role === "toolResult") {
      const toolName = msgAny.toolName || "unknown";
      const content = msg.content;
      
      // Convert to OpenAI format
      msg.role = "tool" as any;
      
      // 🔧 P126: 使用原始 toolCallId，而不是生成假的 ID
      // OpenAI 格式要求 tool_call_id 必须与 assistant.tool_calls[].id 匹配！
      const originalToolCallId = msgAny.toolCallId || msgAny.tool_call_id;
      if (originalToolCallId && typeof originalToolCallId === "string") {
        msgAny.tool_call_id = originalToolCallId;
        log.info(`✓ P126: Using original toolCallId="${originalToolCallId}" (toolName="${toolName}", index=${i})`);
      } else {
        // 没有 toolCallId，生成假的 ID（这可能导致 API 错误）
        // 🔧 P130: 改进假 ID 格式，包含更多上下文信息便于后续匹配
        msgAny.tool_call_id = `call_${toolName}_${i}`;
        log.error(`❌ P126+P130: No toolCallId found for tool="${toolName}" (index=${i}), generated fake ID="${msgAny.tool_call_id}" - this will likely cause API error!`);
        log.error(`❌ P126+P130: 请检查消息保存逻辑，确保 toolResult.toolCallId 与 assistant.tool_calls[].id 匹配！`);
      }
      
      // ✅ 关键：将 toolName 保存到 content 中
      // 这样 convertOpenAIToGeminiFormat 可以提取出来
      let contentStr: string;
      if (typeof content === "string") {
        contentStr = content;
      } else if (Array.isArray(content) && content.length > 0) {
        const firstItem = content[0];
        if (firstItem && typeof firstItem === "object" && "text" in firstItem) {
          contentStr = (firstItem as any).text;
        } else {
          contentStr = JSON.stringify(content);
        }
      } else {
        contentStr = JSON.stringify(content);
      }
      
      // 🔧 P129: 根据 API 类型决定 content 格式
      // - Gemini API: 需要 JSON 包装 {"tool": name, "result": content}
      // - OpenAI API (Grok): 直接使用纯文本 content
      const isGeminiApi = params.modelApi === "gemini" || params.provider?.includes("google") || params.provider?.includes("gemini");
      
      if (isGeminiApi) {
        // Gemini API: 包装成 JSON 格式
        msgAny.content = JSON.stringify({
          tool: toolName,
          result: contentStr
        });
        log.debug(`✓ P129: Gemini API - wrapped tool content with toolName="${toolName}"`);
      } else {
        // OpenAI API (Grok等): 直接使用纯文本
        msgAny.content = contentStr;
        log.debug(`✓ P129: OpenAI API - using plain text content for toolName="${toolName}"`);
      }
      
      toolResultCount++;
      log.debug(`✓ Converted toolResult → tool: name="${toolName}", index=${i}, sessionId=${params.sessionId}`);
    }
  }
  if (fixedCount === 0) {
    log.debug(`[sanitize] No null content found in ${params.messages.length} messages (sessionId: ${params.sessionId})`);
  }
  if (toolResultCount > 0) {
    log.info(`[sanitize] Converted ${toolResultCount} toolResult messages to OpenAI format (sessionId: ${params.sessionId})`);
  }
  
  // 🔍 调试：显示所有消息角色
  const roleCounts = params.messages.reduce((acc, m) => {
    const role = (m as any).role || "unknown";
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  log.info(`[sanitize] 🔍 Messages before policy processing: ${params.messages.length} (${Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(", ")})`);
  
  const policy =
    params.policy ??
    resolveTranscriptPolicy({
      modelApi: params.modelApi,
      provider: params.provider,
      modelId: params.modelId,
    });
  const sanitizedImages = await sanitizeSessionMessagesImages(params.messages, "session:history", {
    sanitizeMode: policy.sanitizeMode,
    sanitizeToolCallIds: policy.sanitizeToolCallIds,
    toolCallIdMode: policy.toolCallIdMode,
    preserveSignatures: policy.preserveSignatures,
    sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
  });
  const sanitizedThinking = policy.normalizeAntigravityThinkingBlocks
    ? sanitizeAntigravityThinkingBlocks(sanitizedImages)
    : sanitizedImages;
  const repairedTools = policy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairing(sanitizedThinking)
    : sanitizedThinking;

  const shouldEnsureThoughtSignatures = shouldEnsureGeminiToolThoughtSignatures({
    provider: params.provider,
    modelApi: params.modelApi,
    modelId: params.modelId,
  });
  const ensured = shouldEnsureThoughtSignatures
    ? ensureGeminiToolThoughtSignatures(repairedTools)
    : { messages: repairedTools, report: { added: 0, byTool: {} } };
  if (shouldEnsureThoughtSignatures && ensured.report.added > 0) {
    log.info("gemini tool thoughtSignature: filled missing signatures", {
      provider: params.provider,
      modelApi: params.modelApi,
      modelId: params.modelId,
      sessionId: params.sessionId,
      added: ensured.report.added,
      byTool: ensured.report.byTool,
    });
  }
  const sanitizedToolThoughtSignatures = ensured.messages;

  const isOpenAIResponsesApi =
    params.modelApi === "openai-responses" || params.modelApi === "openai-codex-responses";
  const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
  const priorSnapshot = hasSnapshot ? readLastModelSnapshot(params.sessionManager) : null;
  const modelChanged = priorSnapshot
    ? !isSameModelSnapshot(priorSnapshot, {
        timestamp: 0,
        provider: params.provider,
        modelApi: params.modelApi,
        modelId: params.modelId,
      })
    : false;
  const sanitizedOpenAI =
    isOpenAIResponsesApi && modelChanged
      ? downgradeOpenAIReasoningBlocks(sanitizedToolThoughtSignatures)
      : sanitizedToolThoughtSignatures;

  if (hasSnapshot && (!priorSnapshot || modelChanged)) {
    appendModelSnapshot(params.sessionManager, {
      timestamp: Date.now(),
      provider: params.provider,
      modelApi: params.modelApi,
      modelId: params.modelId,
    });
  }

  const finalMessages = policy.applyGoogleTurnOrdering
    ? applyGoogleTurnOrderingFix({
        messages: sanitizedOpenAI,
        modelApi: params.modelApi,
        sessionManager: params.sessionManager,
        sessionId: params.sessionId,
        isQueueTask: params.isQueueTask,
      }).messages
    : sanitizedOpenAI;
  
  // 🔍 调试：显示返回前的所有消息角色
  const finalRoleCounts = finalMessages.reduce((acc, m) => {
    const role = (m as any).role || "unknown";
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  log.info(`[sanitize] 🔍 Messages returned: ${finalMessages.length} (${Object.entries(finalRoleCounts).map(([r, c]) => `${r}:${c}`).join(", ")})`);
  
  return finalMessages;
}
