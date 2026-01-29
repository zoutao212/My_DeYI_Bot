import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";

import { detectMime } from "../media/mime.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// NOTE(steipete): Upstream read now does file-magic MIME detection; we keep the wrapper
// to normalize payloads and sanitize oversized images before they hit providers.
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

// Encoding detection and conversion utilities
type SupportedEncoding = "utf-8" | "gbk" | "gb2312" | "big5" | "shift_jis" | "auto";

async function detectTextEncoding(filePath: string): Promise<string> {
  const encodings = ["utf-8", "gbk", "gb2312", "big5", "shift_jis"];
  const buffer = await fs.promises.readFile(filePath);
  
  for (const encoding of encodings) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: true });
      const text = decoder.decode(buffer);
      
      // Check for replacement characters (indicates encoding mismatch)
      if (!text.includes("\uFFFD")) {
        return encoding;
      }
    } catch {
      // Encoding failed, try next
      continue;
    }
  }
  
  // Default to utf-8 if detection fails
  return "utf-8";
}

async function readFileWithEncoding(
  filePath: string,
  encoding: SupportedEncoding,
): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  
  // Auto-detect encoding
  if (encoding === "auto") {
    const detected = await detectTextEncoding(filePath);
    encoding = detected as SupportedEncoding;
  }
  
  // Read with specified encoding
  try {
    const decoder = new TextDecoder(encoding, { fatal: false });
    return decoder.decode(buffer);
  } catch (err) {
    throw new Error(`Failed to read file with encoding ${encoding}: ${String(err)}`);
  }
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
    const idx = required.indexOf(original);
    if (idx !== -1) {
      required.splice(idx, 1);
      changed = true;
    }
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
  return wrapSandboxPathGuard(wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write), root);
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
      
      // Check if file is a text file and encoding is specified
      const isTextFile = filePath.match(/\.(txt|md|json|xml|html|css|js|ts|py|java|c|cpp|h|hpp|sh|bat|ps1|yaml|yml|toml|ini|cfg|conf|log)$/i);
      
      if (isTextFile && encoding !== "utf-8") {
        try {
          // Read file with specified encoding
          const content = await readFileWithEncoding(filePath, encoding);
          
          // Return as text result
          return {
            content: [
              {
                type: "text" as const,
                text: `Read text file [${encoding}]\n\n${content}`,
              },
            ],
            details: { encoding, filePath },
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
      
      const normalizedResult = await normalizeReadImageResult(result, filePath);
      return sanitizeToolResultImages(normalizedResult, `read:${filePath}`);
    },
  };
}
