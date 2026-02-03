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
  // Extract provider from modelId if provider is empty
  const providerStr = (params.provider ?? "").trim().toLowerCase();
  const modelStr = (params.modelId ?? "").trim().toLowerCase();
  const providerFromModel = modelStr.includes("/")
    ? modelStr.split("/")[0]
    : "";
  const effectiveProvider = providerStr || providerFromModel;

  // 对 yinli 禁用 thought_signature
  // 原因：yinli 的 API 不支持 thought_signature，会返回 "Corrupted thought signature" 错误
  if (effectiveProvider.includes("yinli")) {
    log.debug(`[thought_signature] Disabled for yinli provider`);
    return false;
  }

  // 🔧 Fix: 对 vectorengine 禁用整个 patcher（包括格式转换）
  // 原因：vectorengine 是标准的 OpenAI 兼容接口
  // - 需要标准的 OpenAI 格式（messages, tool_calls, role: assistant）
  // - 不需要 Gemini 格式转换（contents, functionCall, role: model）
  // - 不需要 thought_signature
  // 测试证明：
  // - ✅ 标准 OpenAI 格式成功
  // - ❌ Gemini 格式失败（报错 "field messages is required"）
  if (effectiveProvider.includes("vectorengine")) {
    log.info(
      `[thought_signature] Disabled for vectorengine provider (standard OpenAI format, no conversion needed)`,
    );
    return false;
  }

  // 对其他 provider，默认启用 thought_signature patcher
  // 这样可以确保中转 API 不会因为缺少 thought_signature 而报错
  log.debug(`[thought_signature] Enabled for provider: ${effectiveProvider}`);
  return true;
}

/**
 * 检查是否需要移除 thought_signature（针对不支持的 provider）
 */
function shouldStripThoughtSignature(params: {
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
}): boolean {
  // Extract provider from modelId if provider is empty
  const providerStr = (params.provider ?? "").trim().toLowerCase();
  const modelStr = (params.modelId ?? "").trim().toLowerCase();
  const providerFromModel = modelStr.includes("/")
    ? modelStr.split("/")[0]
    : "";
  const effectiveProvider = providerStr || providerFromModel;

  // 只有 yinli 需要移除所有 thought_signature
  // vectorengine 需要保留 thought_signature（API 要求）
  return effectiveProvider.includes("yinli");
}

/**
 * 生成稳定的工具调用 ID（基于工具名称和参数）
 */
function generateStableToolCallId(name: string, args: unknown): string {
  const argsStr =
    typeof args === "object" ? JSON.stringify(args) : String(args);
  const seed = `${name}:${argsStr}`;
  // 使用简单的 hash 生成稳定的 ID
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `call_${Math.abs(hash).toString(36)}`;
}

/**
 * 将 Gemini 格式的消息转换回 OpenAI 格式
 * 用于保存到 session 时统一格式
 */
function convertGeminiToOpenAIFormat(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const msgRec = message as Record<string, unknown>;
  const role =
    typeof msgRec.role === "string" ? msgRec.role.trim().toLowerCase() : "";

  // 转换 model 消息 → assistant
  if (role === "model") {
    const parts = msgRec.parts;
    if (!Array.isArray(parts)) return message;

    // 检查是否有 functionCall
    const functionCalls = parts
      .filter((p) => p && typeof p === "object" && "functionCall" in p)
      .map((p) => {
        const part = p as Record<string, unknown>;
        const fc = part.functionCall;
        if (!fc || typeof fc !== "object") return null;
        const fcRec = fc as Record<string, unknown>;

        const name = String(fcRec.name || "unknown");
        const args = fcRec.args || {};

        return {
          id: generateStableToolCallId(name, args),
          type: "function",
          function: {
            name: name,
            arguments: JSON.stringify(args),
          },
        };
      })
      .filter(Boolean);

    if (functionCalls.length > 0) {
      return {
        role: "assistant",
        content: null,
        tool_calls: functionCalls,
      };
    }

    // 没有 functionCall，提取 text
    const textParts = parts
      .filter((p) => p && typeof p === "object" && "text" in p)
      .map((p) => {
        const part = p as Record<string, unknown>;
        return part.text;
      })
      .filter((t) => typeof t === "string");

    if (textParts.length > 0) {
      return {
        role: "assistant",
        content: textParts.join(""),
      };
    }

    // 空 parts
    return {
      role: "assistant",
      content: null,
    };
  }

  // 转换 function/user 消息 → tool
  if (role === "function" || role === "user") {
    const parts = msgRec.parts;
    if (!Array.isArray(parts) || parts.length === 0) return message;

    const firstPart = parts[0];
    if (!firstPart || typeof firstPart !== "object") return message;
    const partRec = firstPart as Record<string, unknown>;
    const fr = partRec.functionResponse;
    if (!fr || typeof fr !== "object") return message;
    const frRec = fr as Record<string, unknown>;

    const name = String(frRec.name || "unknown");
    const response = frRec.response || {};

    // 从 response 中提取 args（如果有）
    let args = {};
    if (response && typeof response === "object") {
      const respRec = response as Record<string, unknown>;
      if (respRec.args && typeof respRec.args === "object") {
        args = respRec.args;
      }
    }

    return {
      role: "tool",
      tool_call_id: generateStableToolCallId(name, args),
      content: JSON.stringify(response),
    };
  }

  // 其他消息保持不变
  return message;
}

/**
 * 将 OpenAI 格式的 messages 转换为 Gemini 格式
 * 用于 vectorengine 等期望 Gemini 格式的混合 API
 */
function convertOpenAIToGeminiFormat(messages: unknown[]): unknown[] {
  // 🔧 Fix: Track pending functionCall names to fix functionResponse.name
  // Gemini format doesn't have id fields, so we match by order (FIFO)
  const pendingFunctionNames: string[] = [];

  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const msgRec = msg as Record<string, unknown>;
    const role =
      typeof msgRec.role === "string" ? msgRec.role.trim().toLowerCase() : "";

    // 🆕 Fix: Convert user messages from OpenAI format to vectorengine format FIRST
    // This must be done before checking for Gemini format messages
    // OpenAI format: { role: "user", content: [{ type: "text", text: "..." }] }
    // vectorengine format: { role: "user", content: [{ text: "..." }] }  ← 注意：是 content，不是 parts！
    if (role === "user") {
      const content = msgRec.content;
      
      // If content is an array with { type: "text", text: "..." }, convert to { text: "..." }
      if (Array.isArray(content)) {
        const needsConversion = content.some((item) => {
          if (!item || typeof item !== "object") return false;
          const itemRec = item as Record<string, unknown>;
          return itemRec.type === "text" && typeof itemRec.text === "string";
        });
        
        if (needsConversion) {
          // Convert from OpenAI format to vectorengine format
          const convertedContent = content
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const itemRec = item as Record<string, unknown>;
              
              // Extract text from { type: "text", text: "..." }
              if (itemRec.type === "text" && typeof itemRec.text === "string") {
                return { text: itemRec.text };
              }
              
              // Keep other types as-is (e.g., image_url)
              return item;
            })
            .filter(Boolean);
          
          if (convertedContent.length > 0) {
            log.debug(`[format] Converted user message from OpenAI format to vectorengine format (${convertedContent.length} items)`);
            msgRec.content = convertedContent;
          }
        }
      } else if (typeof content === "string" && content.length > 0) {
        // Convert from string to vectorengine format
        log.debug(`[format] Converted user message from string to vectorengine format`);
        msgRec.content = [{ text: content }];
      }
    }

    // 🔧 Fix: Handle vectorengine format messages (role: "model" or "user" with content array)
    // These messages are already in vectorengine format, but we need to fix functionResponse.name
    if (role === "model" || role === "user") {
      const content = msgRec.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === "object") {
            const partRec = part as Record<string, unknown>;

            // Track functionCall names
            if ("functionCall" in partRec) {
              const fc = partRec.functionCall;
              if (fc && typeof fc === "object") {
                const fcRec = fc as Record<string, unknown>;
                const name =
                  typeof fcRec.name === "string" ? fcRec.name : "unknown";
                pendingFunctionNames.push(name);
                log.debug(
                  `[format] Tracked functionCall: name="${name}", queue length=${pendingFunctionNames.length}`,
                );
              }
            }

            // Fix functionResponse.name using pending names
            if ("functionResponse" in partRec) {
              const fr = partRec.functionResponse;
              if (fr && typeof fr === "object") {
                const frRec = fr as Record<string, unknown>;
                if (
                  frRec.name === "unknown" &&
                  pendingFunctionNames.length > 0
                ) {
                  const name = pendingFunctionNames.shift()!;
                  frRec.name = name;
                  log.info(
                    `[format] ✓ Fixed functionResponse.name: "unknown" → "${name}" (queue length=${pendingFunctionNames.length})`,
                  );
                } else if (pendingFunctionNames.length > 0) {
                  // Remove from queue even if name is not "unknown"
                  pendingFunctionNames.shift();
                  log.debug(
                    `[format] functionResponse already has name="${frRec.name}", removed from queue (queue length=${pendingFunctionNames.length})`,
                  );
                } else {
                  log.warn(
                    `[format] ⚠️ functionResponse but queue is empty, name="${frRec.name}"`,
                  );
                }
              }
            }
          }
        }
      }

      // Return the message as-is (already in vectorengine format)
      return msg;
    }

    // 转换 assistant 消息
    if (role === "assistant") {
      const toolCalls = msgRec.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        // 转换为 Gemini 格式
        const parts = toolCalls
          .map((tc) => {
            if (!tc || typeof tc !== "object") return null;
            const tcRec = tc as Record<string, unknown>;
            const func = tcRec.function;
            if (!func || typeof func !== "object") return null;
            const funcRec = func as Record<string, unknown>;

            // 解析 arguments（JSON 字符串 → 对象）
            let args = {};
            if (typeof funcRec.arguments === "string") {
              try {
                args = JSON.parse(funcRec.arguments);
              } catch (e) {
                log.warn(
                  `[format] Failed to parse arguments: ${funcRec.arguments}`,
                );
              }
            }

            // 🔧 Fix: Track functionCall name for matching tool results
            const name =
              typeof funcRec.name === "string" ? funcRec.name : "unknown";
            pendingFunctionNames.push(name);
            log.debug(
              `[format] Tracked functionCall from assistant: name="${name}", queue length=${pendingFunctionNames.length}`,
            );

            return {
              functionCall: {
                name: funcRec.name,
                args: args,
              },
            };
          })
          .filter(Boolean);

        return {
          role: "model",
          parts: parts,
        };
      }

      // 没有 tool_calls 的 assistant 消息
      const content = msgRec.content;
      if (typeof content === "string" && content.length > 0) {
        return {
          role: "model",
          parts: [{ text: content }],
        };
      }
      if (Array.isArray(content) && content.length > 0) {
        return {
          role: "model",
          parts: content,
        };
      }
      // 空 content 的 assistant 消息（只有 tool_calls）
      return {
        role: "model",
        parts: [],
      };
    }

    // 转换 tool 消息（OpenAI 格式）
    if (role === "tool") {
      const content = msgRec.content;
      const toolCallId = msgRec.tool_call_id;

      // 解析 content（可能是 JSON 字符串）
      let response = {};
      if (typeof content === "string") {
        try {
          response = JSON.parse(content);
        } catch (e) {
          // 如果不是 JSON，直接使用字符串
          response = { result: content };
        }
      } else if (content && typeof content === "object") {
        response = content;
      }

      // 🆕 Fix: Clean up response.result content to remove metadata
      // Remove "Read text file [auto]" prefix and YAML frontmatter
      if (response && typeof response === "object") {
        const respRec = response as Record<string, unknown>;
        if (typeof respRec.result === "string") {
          let cleaned = respRec.result;

          // Remove "Read text file [auto]" or "Read image file [...]" prefix
          cleaned = cleaned.replace(
            /^Read (?:text|image) file \[.*?\]\n\n/,
            "",
          );

          // Remove YAML frontmatter (---\n...\n---\n)
          cleaned = cleaned.replace(/^---\n[\s\S]*?\n---\n\n/, "");

          respRec.result = cleaned;
          log.debug(`[format] Cleaned response.result: removed metadata`);
        }
      }

      // 🔧 Fix: Use pending names queue to match tool results
      let name = "unknown";

      // 1. Try to extract from response
      if (response && typeof response === "object") {
        const respRec = response as Record<string, unknown>;
        if (typeof respRec.tool === "string") {
          name = respRec.tool;
        } else if (typeof respRec.name === "string") {
          name = respRec.name;
        }
      }

      // 2. If still unknown, use pending names queue
      if (name === "unknown" && pendingFunctionNames.length > 0) {
        name = pendingFunctionNames.shift()!;
        log.info(
          `[format] ✓ Fixed tool message name using queue: "unknown" → "${name}" (queue length=${pendingFunctionNames.length})`,
        );
      } else if (name === "unknown" && typeof toolCallId === "string") {
        // 3. If queue is empty, log warning
        log.warn(
          `[format] Unable to extract tool name from tool_call_id: ${toolCallId}, queue is empty`,
        );
      } else if (name !== "unknown" && pendingFunctionNames.length > 0) {
        // 4. If name is already known, remove from queue
        pendingFunctionNames.shift();
        log.debug(
          `[format] tool message already has name="${name}", removed from queue (queue length=${pendingFunctionNames.length})`,
        );
      }

      return {
        role: "user", // Gemini 格式中，工具结果的 role 是 "user"
        parts: [
          {
            functionResponse: {
              name: name,
              response: response,
            },
          },
        ],
      };
    }

    // 转换 toolResult 消息（Clawdbot 内部格式）
    if (role === "toolresult") {
      const content = msgRec.content;
      const toolName = msgRec.toolName;

      // 解析 content
      let response = {};
      if (typeof content === "string") {
        try {
          response = JSON.parse(content);
        } catch (e) {
          response = { result: content };
        }
      } else if (Array.isArray(content) && content.length > 0) {
        // content 是数组，提取第一个元素的 text
        const firstItem = content[0];
        if (firstItem && typeof firstItem === "object") {
          const itemRec = firstItem as Record<string, unknown>;
          if (typeof itemRec.text === "string") {
            response = { result: itemRec.text };
          } else {
            response = firstItem;
          }
        }
      } else if (content && typeof content === "object") {
        response = content;
      }

      // 🆕 Fix: Clean up response.result content to remove metadata
      // Remove "Read text file [auto]" prefix and YAML frontmatter
      if (response && typeof response === "object") {
        const respRec = response as Record<string, unknown>;
        if (typeof respRec.result === "string") {
          let cleaned = respRec.result;

          // Remove "Read text file [auto]" or "Read image file [...]" prefix
          cleaned = cleaned.replace(
            /^Read (?:text|image) file \[.*?\]\n\n/,
            "",
          );

          // Remove YAML frontmatter (---\n...\n---\n)
          cleaned = cleaned.replace(/^---\n[\s\S]*?\n---\n\n/, "");

          respRec.result = cleaned;
          log.debug(`[format] Cleaned response.result: removed metadata`);
        }
      }

      // 使用 toolName 字段
      const name = typeof toolName === "string" ? toolName : "unknown";

      if (name === "unknown") {
        log.warn(
          `[format] Unable to extract tool name from toolResult message`,
        );
      }

      return {
        role: "user", // Gemini 格式中，工具结果的 role 是 "user"
        parts: [
          {
            functionResponse: {
              name: name,
              response: response,
            },
          },
        ],
      };
    }

    // 其他消息保持不变
    // 🔧 Fix: Convert user messages from OpenAI format to Gemini format
    // User messages in OpenAI format: { role: "user", content: [{ type: "text", text: "..." }] }
    // User messages in Gemini format: { role: "user", parts: [{ text: "..." }] }
    if (role === "user") {
      const content = msgRec.content;
      
      // If already in Gemini format (has parts), return as-is
      if (msgRec.parts) {
        return msg;
      }
      
      // Convert OpenAI format to Gemini format
      if (Array.isArray(content)) {
        const parts = content
          .map((block) => {
            if (!block || typeof block !== "object") return null;
            const blockRec = block as Record<string, unknown>;
            
            // Extract text from OpenAI format
            if (blockRec.type === "text" && typeof blockRec.text === "string") {
              return { text: blockRec.text };
            }
            
            // Extract image from OpenAI format
            if (blockRec.type === "image_url" && blockRec.image_url && typeof blockRec.image_url === "object") {
              const imageUrl = blockRec.image_url as Record<string, unknown>;
              if (typeof imageUrl.url === "string") {
                return { inlineData: { mimeType: "image/jpeg", data: imageUrl.url } };
              }
            }
            
            return null;
          })
          .filter(Boolean);
        
        if (parts.length > 0) {
          log.debug(`[format] Converted user message from OpenAI format to Gemini format (${parts.length} parts)`);
          return {
            role: "user",
            parts: parts,
          };
        }
      }
      
      // If content is a string, convert to Gemini format
      if (typeof content === "string" && content.length > 0) {
        log.debug(`[format] Converted user message from OpenAI format (string) to Gemini format`);
        return {
          role: "user",
          parts: [{ text: content }],
        };
      }
    }
    
    return msg;
  });
}

/**
 * 递归移除 payload 中所有的 thought_signature 和 thoughtSignature 字段
 * 用于不支持 thought_signature 的 provider（如 yinli）
 */
function stripAllThoughtSignatures(value: unknown): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) {
      stripAllThoughtSignatures(item);
    }
    return;
  }

  const record = value as Record<string, unknown>;

  // 移除 thought_signature 和 thoughtSignature
  if ("thought_signature" in record) {
    delete record.thought_signature;
  }
  if ("thoughtSignature" in record) {
    delete record.thoughtSignature;
  }

  // 递归处理所有子对象
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (child && typeof child === "object") {
      stripAllThoughtSignatures(child);
    }
  }
}

function ensureThoughtSignatureOnRecord(params: {
  record: Record<string, unknown>;
  path: string;
  report: ScanReport;
}): void {
  const hasSnake =
    typeof params.record.thought_signature === "string" &&
    params.record.thought_signature.trim();
  const hasCamel =
    typeof params.record.thoughtSignature === "string" &&
    params.record.thoughtSignature.trim();
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
    (typeof params.record.id === "string" &&
      params.record.id.trim() &&
      params.record.id) ||
    (typeof params.record.call_id === "string" &&
      params.record.call_id.trim() &&
      params.record.call_id) ||
    (typeof params.record.toolCallId === "string" &&
      params.record.toolCallId.trim() &&
      params.record.toolCallId) ||
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
    typeof params.record.thought_signature === "string" &&
    params.record.thought_signature.trim();
  const hasCamel =
    typeof params.record.thoughtSignature === "string" &&
    params.record.thoughtSignature.trim();
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
      walkAndPatch({
        value: value[i],
        path: `${params.path}[${i}]`,
        report: params.report,
      });
    }
    return;
  }
  if (typeof value !== "object") return;

  const rec = value as Record<string, unknown>;

  const role =
    typeof rec.role === "string" ? rec.role.trim().toLowerCase() : "";
  const isToolResultMessage =
    role === "tool" || typeof rec.tool_call_id === "string";
  if (isToolResultMessage) {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });
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
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });
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
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });
  }

  const toolCallsSnake = rec.tool_calls;
  if (Array.isArray(toolCallsSnake)) {
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });
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
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });
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
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });
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
    // ✅ 给包含 functionCall 的 part wrapper 添加 thoughtSignature
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });

    // ✅ vectorengine 需要在 functionCall 对象内部添加 thought_signature
    // ❌ yinli 不需要（会报错）
    // 解决方案：通过 params 传递 provider 信息，根据 provider 决定是否添加
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
    // ✅ 给包含 function_call 的 part wrapper 添加 thoughtSignature
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });

    // ✅ vectorengine 需要在 function_call 对象内部添加 thought_signature
    // ❌ yinli 不需要（会报错）
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
    // ✅ 给包含 functionResponse 的 part wrapper 添加 thoughtSignature
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });

    // ✅ vectorengine 需要在 functionResponse 对象内部添加 thought_signature
    // ❌ yinli 不需要（会报错）
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
    // ✅ 给包含 function_response 的 part wrapper 添加 thoughtSignature
    noteCandidate({ record: rec, path: params.path, report: params.report });
    ensureThoughtSignatureOnRecord({
      record: rec,
      path: params.path,
      report: params.report,
    });

    // ✅ vectorengine 需要在 function_response 对象内部添加 thought_signature
    // ❌ yinli 不需要（会报错）
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
    walkAndPatch({
      value: v,
      path: `${params.path}.${k}`,
      report: params.report,
    });
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
  const addSignatures = shouldEnable({
    provider: params.provider,
    modelApi: params.modelApi,
    modelId: params.modelId,
  });
  const stripSignatures = shouldStripThoughtSignature({
    provider: params.provider,
    modelApi: params.modelApi,
    modelId: params.modelId,
  });

  // 🔧 Fix: 对于需要清理 thought_signature 的 provider（如 yinli），
  // 即使不添加 thought_signature，也要创建 patcher 来执行清理
  if (!addSignatures && !stripSignatures) {
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

  const wrapStreamFn: GeminiPayloadThoughtSignaturePatcher["wrapStreamFn"] = (
    streamFn,
  ) => {
    const wrapped: StreamFn = (model, context, options) => {
      const nextOnPayload = (payload: unknown) => {
        // ❌ 移除错误的格式转换逻辑
        // vectorengine 使用 OpenAI Completions endpoint (/v1/chat/completions)
        // 它期望的是标准的 OpenAI 格式：
        // - 顶层：messages（OpenAI 格式）
        // - 内容：tool_calls、role: assistant（OpenAI 格式）
        // 不需要转换为 Gemini 格式（functionCall、role: model）

        // Fix 1: Flatten config field to top level (Gemini API format)
        if (payload && typeof payload === "object" && "config" in payload) {
          const payloadObj = payload as Record<string, unknown>;
          const config = payloadObj.config;

          if (config && typeof config === "object") {
            const configObj = config as Record<string, unknown>;

            log.warn(
              `[payload] ⚠️ Found 'config' field in payload (not Gemini API compliant), flattening to top level`,
            );

            // Move config.systemInstruction to top level
            if (configObj.systemInstruction) {
              payloadObj.systemInstruction = configObj.systemInstruction;
              log.info(`[payload] Moved config.systemInstruction to top level`);
            }

            // Move config.tools to top level and clean format
            if (configObj.tools) {
              // Clean tools format: remove label, execute, etc.
              const cleanedTools = Array.isArray(configObj.tools)
                ? configObj.tools.map((toolGroup: unknown) => {
                    if (!toolGroup || typeof toolGroup !== "object")
                      return toolGroup;
                    const group = toolGroup as Record<string, unknown>;

                    // If it's a tool group with functionDeclarations
                    if (Array.isArray(group.functionDeclarations)) {
                      return {
                        functionDeclarations: group.functionDeclarations.map(
                          (fn: unknown) => {
                            if (!fn || typeof fn !== "object") return fn;
                            const func = fn as Record<string, unknown>;
                            // Only keep name, description, parameters
                            return {
                              name: func.name,
                              description: func.description,
                              parameters: func.parameters,
                            };
                          },
                        ),
                      };
                    }

                    return toolGroup;
                  })
                : configObj.tools;

              payloadObj.tools = cleanedTools;
              log.info(
                `[payload] Moved config.tools to top level and cleaned format`,
              );

              // 🔍 DEBUG: Log tools structure
              const toolsArr = Array.isArray(cleanedTools) ? cleanedTools : [];
              if (toolsArr.length > 0 && toolsArr[0]?.functionDeclarations) {
                const funcNames = toolsArr[0].functionDeclarations
                  .map((f: { name?: string }) => f.name)
                  .join(", ");
                log.info(`[payload] Tools functionDeclarations: ${funcNames}`);
              }
            }

            // Move config.maxOutputTokens to generationConfig.maxOutputTokens
            if (typeof configObj.maxOutputTokens === "number") {
              payloadObj.generationConfig = {
                ...(typeof payloadObj.generationConfig === "object" &&
                payloadObj.generationConfig !== null
                  ? (payloadObj.generationConfig as Record<string, unknown>)
                  : {}),
                maxOutputTokens: configObj.maxOutputTokens,
              };
              log.info(
                `[payload] Moved config.maxOutputTokens to generationConfig.maxOutputTokens`,
              );
            }

            // Delete the config field
            delete payloadObj.config;
            log.info(
              `[payload] ✓ Removed 'config' field, payload now Gemini API compliant`,
            );
          }
        }

        // Fix 2: Convert string systemInstruction to parts format for yinli compatibility
        // yinli API requires {parts: [{text: "..."}]} format, not plain string
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          const sysInstr = payloadObj.systemInstruction;
          if (typeof sysInstr === "string" && sysInstr.length > 0) {
            payloadObj.systemInstruction = { parts: [{ text: sysInstr }] };
            log.info(
              `[payload] Converted systemInstruction from string to parts format for yinli compatibility`,
            );
          }
        }

        // Fix 4: Convert OpenAI format to Gemini format for vectorengine
        // vectorengine uses OpenAI endpoint (/v1/chat/completions) but expects Gemini payload format
        // Extract provider from model string (e.g., "vectorengine/gemini-3-flash-preview" → "vectorengine")
        const modelStr = typeof base.modelId === "string" ? base.modelId : "";
        const providerFromModel = modelStr.includes("/")
          ? modelStr.split("/")[0]
          : "";
        // 🔧 Fix: base.provider 可能是空字符串，需要显式检查
        const effectiveProvider = (
          base.provider && base.provider.trim() !== ""
            ? base.provider
            : providerFromModel
        ).toLowerCase();

        log.debug(
          `[format] effectiveProvider="${effectiveProvider}", base.provider="${base.provider}", providerFromModel="${providerFromModel}"`,
        );

        // ✅ Fix 4: Convert OpenAI format to Gemini format for vectorengine
        // vectorengine uses OpenAI endpoint (/v1/chat/completions) but expects Gemini payload format
        // API error: "Function call is missing a thought_signature in functionCall parts"
        // This proves vectorengine expects Gemini format (functionCall), not OpenAI format (tool_calls)
        if (effectiveProvider.includes("vectorengine")) {
          if (payload && typeof payload === "object" && "messages" in payload) {
            const payloadObj = payload as Record<string, unknown>;
            const messages = payloadObj.messages;
            
            if (Array.isArray(messages)) {
              log.info(`[format] Converting OpenAI format to Gemini format for vectorengine (${messages.length} messages)`);
              payloadObj.messages = convertOpenAIToGeminiFormat(messages);
              log.info(`[format] ✓ Converted to Gemini format (role: assistant → model, tool_calls → functionCall)`);
            }
          }
        }

        // Fix 3: Add or strip thought_signature based on provider
        const report: ScanReport = {
          added: [],
          candidates: 0,
          missingBefore: 0,
          missingPaths: [],
        };

        if (stripSignatures) {
          // 🔧 Fix: 对于 yinli 等不支持 thought_signature 的 provider，
          // 在发送请求前彻底移除所有 thought_signature
          stripAllThoughtSignatures(payload);
          log.info(
            `[thought_signature] Stripped all thought_signature fields for provider: ${effectiveProvider}`,
          );
        } else if (addSignatures) {
          // 🔧 Fix: 对于 vectorengine，需要确保历史消息中的 functionCall 内部也有 thought_signature
          // 这是因为 LLM 返回的 assistant 消息可能没有在 functionCall 内部添加 thought_signature
          // 导致保存到 session 的历史消息格式不对，下次请求时 API 报错
          if (effectiveProvider.includes("vectorengine")) {
            // 递归检查并修复 functionCall 内部的 thought_signature
            function ensureInnerThoughtSignatures(
              value: unknown,
              path: string,
            ): void {
              if (!value || typeof value !== "object") return;

              if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                  ensureInnerThoughtSignatures(value[i], `${path}[${i}]`);
                }
                return;
              }

              const record = value as Record<string, unknown>;

              // 如果是 functionCall/functionResponse 对象，确保其内部有 thought_signature
              if (
                record.functionCall &&
                typeof record.functionCall === "object"
              ) {
                const fc = record.functionCall as Record<string, unknown>;
                const hasSnake =
                  typeof fc.thought_signature === "string" &&
                  fc.thought_signature.trim();
                const hasCamel =
                  typeof fc.thoughtSignature === "string" &&
                  fc.thoughtSignature.trim();

                if (!hasSnake && !hasCamel) {
                  // 生成 thought_signature
                  const name =
                    typeof fc.name === "string" ? fc.name : "unknown";
                  const seed = `${path}.functionCall:${name}`;
                  const signature = makeStableThoughtSignatureBase64(seed);
                  fc.thought_signature = signature;
                  fc.thoughtSignature = signature;
                  log.debug(
                    `[thought_signature] Added missing thought_signature to functionCall at ${path}`,
                  );
                }
              }

              if (
                record.function_call &&
                typeof record.function_call === "object"
              ) {
                const fc = record.function_call as Record<string, unknown>;
                const hasSnake =
                  typeof fc.thought_signature === "string" &&
                  fc.thought_signature.trim();
                const hasCamel =
                  typeof fc.thoughtSignature === "string" &&
                  fc.thoughtSignature.trim();

                if (!hasSnake && !hasCamel) {
                  const name =
                    typeof fc.name === "string" ? fc.name : "unknown";
                  const seed = `${path}.function_call:${name}`;
                  const signature = makeStableThoughtSignatureBase64(seed);
                  fc.thought_signature = signature;
                  fc.thoughtSignature = signature;
                  log.debug(
                    `[thought_signature] Added missing thought_signature to function_call at ${path}`,
                  );
                }
              }

              if (
                record.functionResponse &&
                typeof record.functionResponse === "object"
              ) {
                const fr = record.functionResponse as Record<string, unknown>;
                const hasSnake =
                  typeof fr.thought_signature === "string" &&
                  fr.thought_signature.trim();
                const hasCamel =
                  typeof fr.thoughtSignature === "string" &&
                  fr.thoughtSignature.trim();

                if (!hasSnake && !hasCamel) {
                  const name =
                    typeof fr.name === "string" ? fr.name : "unknown";
                  const seed = `${path}.functionResponse:${name}`;
                  const signature = makeStableThoughtSignatureBase64(seed);
                  fr.thought_signature = signature;
                  fr.thoughtSignature = signature;
                  log.debug(
                    `[thought_signature] Added missing thought_signature to functionResponse at ${path}`,
                  );
                }
              }

              if (
                record.function_response &&
                typeof record.function_response === "object"
              ) {
                const fr = record.function_response as Record<string, unknown>;
                const hasSnake =
                  typeof fr.thought_signature === "string" &&
                  fr.thought_signature.trim();
                const hasCamel =
                  typeof fr.thoughtSignature === "string" &&
                  fr.thoughtSignature.trim();

                if (!hasSnake && !hasCamel) {
                  const name =
                    typeof fr.name === "string" ? fr.name : "unknown";
                  const seed = `${path}.function_response:${name}`;
                  const signature = makeStableThoughtSignatureBase64(seed);
                  fr.thought_signature = signature;
                  fr.thoughtSignature = signature;
                  log.debug(
                    `[thought_signature] Added missing thought_signature to function_response at ${path}`,
                  );
                }
              }

              // 递归处理所有子对象
              for (const key of Object.keys(record)) {
                const child = record[key];
                if (child && typeof child === "object") {
                  ensureInnerThoughtSignatures(child, `${path}.${key}`);
                }
              }
            }

            ensureInnerThoughtSignatures(payload, "$");
            log.info(
              `[thought_signature] Ensured inner thought_signature for vectorengine provider (fixing historical messages)`,
            );
          }

          // 对于支持的 provider，添加缺失的 thought_signature
          walkAndPatch({ value: payload, path: "$", report });

          // 🔧 Fix: 对于 yinli provider，即使添加了 thought_signature，
          // 也要移除 functionCall/functionResponse 内部的 thought_signature
          // 因为 yinli 只接受 wrapper 上的 thought_signature，不接受内部的
          if (base.provider && base.provider.toLowerCase().includes("yinli")) {
            // 递归移除 functionCall/functionResponse 内部的 thought_signature
            function stripInnerThoughtSignatures(value: unknown): void {
              if (!value || typeof value !== "object") return;

              if (Array.isArray(value)) {
                for (const item of value) {
                  stripInnerThoughtSignatures(item);
                }
                return;
              }

              const record = value as Record<string, unknown>;

              // 如果是 functionCall/functionResponse 对象，移除其内部的 thought_signature
              if (
                record.functionCall &&
                typeof record.functionCall === "object"
              ) {
                const fc = record.functionCall as Record<string, unknown>;
                delete fc.thought_signature;
                delete fc.thoughtSignature;
              }
              if (
                record.function_call &&
                typeof record.function_call === "object"
              ) {
                const fc = record.function_call as Record<string, unknown>;
                delete fc.thought_signature;
                delete fc.thoughtSignature;
              }
              if (
                record.functionResponse &&
                typeof record.functionResponse === "object"
              ) {
                const fr = record.functionResponse as Record<string, unknown>;
                delete fr.thought_signature;
                delete fr.thoughtSignature;
              }
              if (
                record.function_response &&
                typeof record.function_response === "object"
              ) {
                const fr = record.function_response as Record<string, unknown>;
                delete fr.thought_signature;
                delete fr.thoughtSignature;
              }

              // 递归处理所有子对象
              for (const key of Object.keys(record)) {
                const child = record[key];
                if (child && typeof child === "object") {
                  stripInnerThoughtSignatures(child);
                }
              }
            }

            stripInnerThoughtSignatures(payload);
            log.info(
              `[thought_signature] Stripped inner thought_signature from functionCall/functionResponse for yinli provider`,
            );
          }
        }

        // Safety check: Verify no assistant messages with null content remain
        // (should have been fixed in sanitizeSessionHistory)
        if (payload && typeof payload === "object" && "messages" in payload) {
          const messages = (payload as Record<string, unknown>).messages;
          if (Array.isArray(messages)) {
            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i];
              if (msg && typeof msg === "object") {
                const msgRec = msg as Record<string, unknown>;
                const role =
                  typeof msgRec.role === "string"
                    ? msgRec.role.trim().toLowerCase()
                    : "";
                if (role === "assistant" && msgRec.content === null) {
                  log.error(
                    `❌ BUG: assistant.content is still null after sanitization (message index: ${i})`,
                  );
                  // Emergency fix to prevent API failure
                  const hadToolCalls = Boolean(
                    msgRec.tool_calls || msgRec.toolCalls,
                  );
                  msgRec.content = "";
                  log.info(
                    `[payload] Fixed content: null → "" (index: ${i}, hasToolCalls: ${hadToolCalls})`,
                  );
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
        if (
          report.candidates > 0 ||
          report.added.length > 0 ||
          report.missingBefore > 0
        ) {
          log.info(
            `gemini payload thoughtSignature scan: ${JSON.stringify(summary)}`,
          );
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

/**
 * 导出格式转换函数供外部使用
 */
export { convertGeminiToOpenAIFormat };
