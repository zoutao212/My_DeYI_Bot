import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";

import { detectMime } from "../media/mime.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import { sanitizeToolResultImages } from "./tool-images.js";
import { createEnhancedWriteTool } from "./pi-tools.write.js";
import {
  type SupportedEncoding,
  decodeBuffer,
  detectEncoding,
} from "./intelligent-task-decomposition/encoding-utils.js";

// NOTE(steipete): Upstream read now does file-magic MIME detection; we keep the wrapper
// to normalize payloads and sanitize oversized images before they hit providers.

// P116/P117: read 工具大文件截断上限（字符数）
// 与 session-tool-result-guard.ts 中的 MAX_TOOL_RESULT_CHARS (30K) 对齐
// 避免读取后再被 session 截断，浪费资源
const MAX_READ_CONTENT_CHARS = 30_000;

type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

/**
 * 以指定编码读取文件（统一使用 encoding-utils 模块）
 */
async function readFileWithEncoding(
  filePath: string,
  encoding: SupportedEncoding,
): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  
  if (encoding === "auto") {
    const detected = detectEncoding(buffer);
    return decodeBuffer(buffer, detected as SupportedEncoding);
  }
  
  return decodeBuffer(buffer, encoding);
}

async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const trimmed = base64.trim();
  if (!trimmed) return undefined;

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) return undefined;

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];

  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  if (!image) return result;

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniffed = await sniffMimeFromBase64(image.data);
  if (!sniffed) return result;

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) return result;

  const nextContent = content.map((block) => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { ...result, content: nextContent };
}

type RequiredParamGroup = {
  keys: readonly string[];
  allowEmpty?: boolean;
  label?: string;
};

export const CLAUDE_PARAM_GROUPS = {
  read: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
  write: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
  edit: [
    { keys: ["path", "file_path"], label: "path (path or file_path)" },
    {
      keys: ["oldText", "old_string"],
      label: "oldText (oldText or old_string)",
    },
    {
      keys: ["newText", "new_string"],
      label: "newText (newText or new_string)",
    },
  ],
} as const;

// Normalize tool parameters from Claude Code conventions to pi-coding-agent conventions.
// Claude Code uses file_path/old_string/new_string while pi-coding-agent uses path/oldText/newText.
// This prevents models trained on Claude Code from getting stuck in tool-call loops.
export function normalizeToolParams(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  const normalized = { ...record };
  // file_path → path (read, write, edit)
  if ("file_path" in normalized && !("path" in normalized)) {
    normalized.path = normalized.file_path;
    delete normalized.file_path;
  }
  // old_string → oldText (edit)
  if ("old_string" in normalized && !("oldText" in normalized)) {
    normalized.oldText = normalized.old_string;
    delete normalized.old_string;
  }
  // new_string → newText (edit)
  if ("new_string" in normalized && !("newText" in normalized)) {
    normalized.newText = normalized.new_string;
    delete normalized.new_string;
  }
  return normalized;
}

export function patchToolSchemaForClaudeCompatibility(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;

  if (!schema || !schema.properties || typeof schema.properties !== "object") {
    return tool;
  }

  const properties = { ...(schema.properties as Record<string, unknown>) };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  let changed = false;

  const aliasPairs: Array<{ original: string; alias: string }> = [
    { original: "path", alias: "file_path" },
    { original: "oldText", alias: "old_string" },
    { original: "newText", alias: "new_string" },
  ];

  for (const { original, alias } of aliasPairs) {
    if (!(original in properties)) continue;
    if (!(alias in properties)) {
      properties[alias] = properties[original];
      changed = true;
    }
    // 🔧 Fix: Keep original field in required array
    // LLM needs to know that at least one of (original, alias) is required
    // Runtime validation (assertRequiredParams) will check that at least one is provided
    // But we keep original in schema's required array so LLM knows it's not optional
    // Note: This means schema says "original is required", but we accept alias too
    // This is better than saying "both are optional" which confuses LLM
  }

  if (!changed) return tool;

  return {
    ...tool,
    parameters: {
      ...schema,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

export function assertRequiredParams(
  record: Record<string, unknown> | undefined,
  groups: readonly RequiredParamGroup[],
  toolName: string,
): void {
  if (!record || typeof record !== "object") {
    throw new Error(`Missing parameters for ${toolName}`);
  }

  for (const group of groups) {
    const satisfied = group.keys.some((key) => {
      if (!(key in record)) return false;
      const value = record[key];
      if (typeof value !== "string") return false;
      if (group.allowEmpty) return true;
      return value.trim().length > 0;
    });

    if (!satisfied) {
      const label = group.label ?? group.keys.join(" or ");
      throw new Error(`Missing required parameter: ${label}`);
    }
  }
}

// Generic wrapper to normalize parameters for any tool
export function wrapToolParamNormalization(
  tool: AnyAgentTool,
  requiredParamGroups?: readonly RequiredParamGroup[],
): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(tool);
  return {
    ...patched,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      if (requiredParamGroups?.length) {
        assertRequiredParams(record, requiredParamGroups, tool.name);
      }
      return tool.execute(toolCallId, normalized ?? params, signal, onUpdate);
    },
  };
}

function wrapSandboxPathGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = record?.path;
      if (typeof filePath === "string" && filePath.trim()) {
        await assertSandboxPath({ filePath, cwd: root, root });
      }
      return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
    },
  };
}

export function createSandboxedReadTool(root: string) {
  const base = createReadTool(root) as unknown as AnyAgentTool;
  return wrapSandboxPathGuard(createClawdbotReadTool(base), root);
}

export function createSandboxedWriteTool(root: string) {
  const base = createWriteTool(root) as unknown as AnyAgentTool;
  const enhanced = createEnhancedWriteTool(base);
  return wrapSandboxPathGuard(enhanced, root);
}

export function createSandboxedEditTool(root: string) {
  const base = createEditTool(root) as unknown as AnyAgentTool;
  return wrapSandboxPathGuard(wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.edit), root);
}

export function createClawdbotReadTool(base: AnyAgentTool): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(base);
  
  // Add encoding parameter to schema
  const schema =
    patched.parameters && typeof patched.parameters === "object"
      ? (patched.parameters as Record<string, unknown>)
      : {};
  
  const properties = schema.properties && typeof schema.properties === "object"
    ? { ...(schema.properties as Record<string, unknown>) }
    : {};
  
  // Add encoding parameter
  properties.encoding = {
    type: "string",
    description: "Text file encoding (utf-8, gbk, gb2312, big5, shift_jis, auto). Default: auto (auto-detect)",
    enum: ["utf-8", "gbk", "gb2312", "big5", "shift_jis", "auto"],
  };
  
  const enhancedSchema = {
    ...schema,
    properties,
  };
  
  return {
    ...patched,
    parameters: enhancedSchema,
    execute: async (toolCallId, params, signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);
      
      const filePath = typeof record?.path === "string" ? String(record.path) : "<unknown>";
      const encoding = typeof record?.encoding === "string" 
        ? (record.encoding as SupportedEncoding)
        : "auto";
      
      // Extract offset and limit parameters
      const offset = typeof record?.offset === "number" ? record.offset : undefined;
      const limit = typeof record?.limit === "number" ? record.limit : undefined;
      
      // Check if file is a text file and encoding is specified
      const isTextFile = filePath.match(/\.(txt|md|json|xml|html|css|js|ts|py|java|c|cpp|h|hpp|sh|bat|ps1|yaml|yml|toml|ini|cfg|conf|log)$/i);
      
      if (isTextFile && encoding !== "utf-8") {
        try {
          // Read file with specified encoding
          let content = await readFileWithEncoding(filePath, encoding);
          
          // 🔧 Fix: Apply offset and limit to content
          if (offset !== undefined || limit !== undefined) {
            const lines = content.split("\n");
            const startLine = offset !== undefined ? Math.max(0, offset - 1) : 0; // offset is 1-indexed
            const endLine = limit !== undefined ? startLine + limit : lines.length;
            content = lines.slice(startLine, endLine).join("\n");
          }
          
          // P116: 截断过大内容（仅当用户未指定 offset/limit 时）
          if (offset === undefined && limit === undefined && content.length > MAX_READ_CONTENT_CHARS) {
            const originalLen = content.length;
            const totalLines = content.split("\n").length;
            const headLen = Math.floor(MAX_READ_CONTENT_CHARS * 0.7);
            const tailLen = Math.floor(MAX_READ_CONTENT_CHARS * 0.2);
            content = content.substring(0, headLen)
              + `\n\n⚠️ [P116 大文件截断] 文件共 ${originalLen} 字符 / ${totalLines} 行，已截断到 ${MAX_READ_CONTENT_CHARS} 字符上限。`
              + `\n请使用 offset 和 limit 参数分段读取，或使用 novel_reference_search 工具检索相关段落。\n\n`
              + content.substring(content.length - tailLen);
            console.log(`[read-tool] ✂️ P116: 截断大文件 ${filePath} ${originalLen} → ${content.length} 字符`);
          }
          
          // Return as text result
          return {
            content: [
              {
                type: "text" as const,
                text: `Read text file [${encoding}]\n\n${content}`,
              },
            ],
            details: { encoding, filePath, offset, limit, truncatedByP116: content.length < (offset === undefined && limit === undefined ? Infinity : 0) },
          } satisfies AgentToolResult<unknown>;
        } catch (err) {
          // Fall back to default read if encoding fails
          const errorMsg = String(err);
          const result = (await base.execute(
            toolCallId,
            normalized ?? params,
            signal,
          )) as AgentToolResult<unknown>;
          
          // Add warning about encoding failure
          const content = Array.isArray(result.content) ? result.content : [];
          const warningBlock = {
            type: "text" as const,
            text: `⚠️ Warning: Failed to read with encoding ${encoding}: ${errorMsg}\nFalling back to default encoding.\n\n`,
          };
          
          return {
            ...result,
            content: [warningBlock, ...content],
          };
        }
      }
      
      // Default read for non-text files or utf-8
      const result = (await base.execute(
        toolCallId,
        normalized ?? params,
        signal,
      )) as AgentToolResult<unknown>;
      
      // P116: 截断默认读取路径中的过大文本结果（仅当用户未指定 offset/limit 时）
      if (offset === undefined && limit === undefined && Array.isArray(result.content)) {
        for (const block of result.content) {
          if (!block || typeof block !== "object") continue;
          const textBlock = block as { type?: string; text?: string };
          if (textBlock.type === "text" && typeof textBlock.text === "string" && textBlock.text.length > MAX_READ_CONTENT_CHARS) {
            const original = textBlock.text;
            const totalLines = original.split("\n").length;
            const headLen = Math.floor(MAX_READ_CONTENT_CHARS * 0.7);
            const tailLen = Math.floor(MAX_READ_CONTENT_CHARS * 0.2);
            textBlock.text = original.substring(0, headLen)
              + `\n\n⚠️ [P116 大文件截断] 文件共 ${original.length} 字符 / ${totalLines} 行，已截断到 ${MAX_READ_CONTENT_CHARS} 字符上限。`
              + `\n请使用 offset 和 limit 参数分段读取，或使用 novel_reference_search 工具检索相关段落。\n\n`
              + original.substring(original.length - tailLen);
            console.log(`[read-tool] ✂️ P116: 截断大文件 ${filePath} ${original.length} → ${textBlock.text.length} 字符`);
          }
        }
      }
      
      const normalizedResult = await normalizeReadImageResult(result, filePath);
      return sanitizeToolResultImages(normalizedResult, `read:${filePath}`);
    },
  };
}
