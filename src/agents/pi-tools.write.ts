import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { patchToolSchemaForClaudeCompatibility, normalizeToolParams } from "./pi-tools.read.js";
import {
  type SupportedEncoding,
  encodeString,
  decodeBuffer,
  isEncodingSupported,
  getEncodingDescription,
} from "./intelligent-task-decomposition/encoding-utils.js";
import { trackFileWrite } from "./intelligent-task-decomposition/file-tracker.js";

/**
 * Enhanced write tool with multiple modes:
 * - overwrite: Replace entire file (default)
 * - append: Append to end of file
 * - insert: Insert at specific line
 * - replace: Replace line range
 *
 * 编码支持（已修复 GBK 乱码 Bug）：
 * - utf-8 / utf8：标准 UTF-8
 * - utf-8-bom：带 BOM 的 UTF-8（Windows 友好，推荐中文文件使用）
 * - gbk / gb2312：中文 GBK 编码（通过 iconv-lite 实现真正的 GBK 写入）
 * - big5：繁体中文 Big5 编码
 * - shift_jis：日文 Shift_JIS 编码
 * - ascii / latin1：基础编码
 */

type WriteMode = "overwrite" | "append" | "insert" | "replace";

async function ensureParentDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
}

async function readFileLines(filePath: string, encoding: SupportedEncoding = "utf-8"): Promise<string[]> {
  try {
    const buffer = await fs.promises.readFile(filePath);
    const content = decodeBuffer(buffer, encoding);
    return content.split("\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function writeFileContent(filePath: string, content: string, encoding: SupportedEncoding = "utf-8"): Promise<void> {
  const buffer = encodeString(content, encoding);
  await fs.promises.writeFile(filePath, buffer);
}

async function writeFileLines(filePath: string, lines: string[], encoding: SupportedEncoding = "utf-8"): Promise<void> {
  const content = lines.join("\n");
  await writeFileContent(filePath, content, encoding);
}

export function createEnhancedWriteTool(baseTool: AnyAgentTool): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(baseTool);
  
  // Enhance schema with new parameters
  const schema =
    patched.parameters && typeof patched.parameters === "object"
      ? (patched.parameters as Record<string, unknown>)
      : {};
  
  const properties = schema.properties && typeof schema.properties === "object"
    ? { ...(schema.properties as Record<string, unknown>) }
    : {};
  
  // Add mode parameter
  properties.mode = {
    type: "string",
    description: "Write mode: overwrite (default), append, insert, or replace",
    enum: ["overwrite", "append", "insert", "replace"],
  };
  
  // Add position parameter (for insert mode)
  properties.position = {
    type: "number",
    description: "Line number to insert at (1-indexed, required for insert mode)",
  };
  
  // Add startLine parameter (for replace mode)
  properties.startLine = {
    type: "number",
    description: "Start line number for replacement (1-indexed, inclusive, required for replace mode)",
  };
  
  // Add endLine parameter (for replace mode)
  properties.endLine = {
    type: "number",
    description: "End line number for replacement (1-indexed, inclusive, required for replace mode)",
  };
  
  // Add encoding parameter
  properties.encoding = {
    type: "string",
    description: "File encoding. Supported: utf-8 (default), utf-8-bom (Windows friendly), gbk, gb2312, big5, shift_jis, ascii, latin1",
    enum: ["utf-8", "utf-8-bom", "gbk", "gb2312", "big5", "shift_jis", "ascii", "latin1"],
  };
  
  // Add createDirs parameter
  properties.createDirs = {
    type: "boolean",
    description: "Auto-create parent directories (default: true)",
  };
  
  // Update description
  const enhancedDescription = 
    "Write content to a file with multiple modes. " +
    "**IMPORTANT: Use mode='append' to add content to an existing file without overwriting it.** " +
    "Modes: " +
    "overwrite (default, replaces entire file - USE WITH CAUTION), " +
    "append (adds to end of file, preserves existing content), " +
    "insert (inserts at specific line), " +
    "replace (replaces line range). " +
    "Auto-creates parent directories. " +
    "Example for appending: write(path='file.md', content='new content', mode='append')";
  
  const enhancedSchema = {
    ...schema,
    properties,
  };
  
  return {
    ...patched,
    description: enhancedDescription,
    parameters: enhancedSchema,
    execute: async (_toolCallId, params, _signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      
      if (!record) {
        throw new Error("Missing parameters for write tool");
      }
      
      // Extract parameters
      const filePath = typeof record.path === "string" ? record.path : 
                      typeof record.file_path === "string" ? record.file_path : undefined;
      
      if (!filePath) {
        throw new Error("Missing required parameter: path");
      }
      
      const content = typeof record.content === "string" ? record.content : "";
      const mode = (typeof record.mode === "string" ? record.mode : "overwrite") as WriteMode;
      const position = typeof record.position === "number" ? record.position : undefined;
      const startLine = typeof record.startLine === "number" ? record.startLine : undefined;
      const endLine = typeof record.endLine === "number" ? record.endLine : undefined;
      const rawEncoding = typeof record.encoding === "string" ? record.encoding : "utf-8";
      const createDirs = typeof record.createDirs === "boolean" ? record.createDirs : true;
      
      // 验证编码是否支持
      if (!isEncodingSupported(rawEncoding)) {
        console.warn(`[write] ⚠️ 不支持的编码 "${rawEncoding}"，回退到 UTF-8`);
      }
      const encoding = rawEncoding as SupportedEncoding;
      
      // Validate mode-specific parameters
      if (mode === "insert" && position === undefined) {
        throw new Error("insert mode requires position parameter");
      }
      
      if (mode === "replace" && (startLine === undefined || endLine === undefined)) {
        throw new Error("replace mode requires startLine and endLine parameters");
      }
      
      if (mode === "replace" && startLine !== undefined && endLine !== undefined && startLine > endLine) {
        throw new Error(`Invalid line range: startLine (${startLine}) > endLine (${endLine})`);
      }
      
      // Create parent directories if needed
      if (createDirs) {
        await ensureParentDir(filePath);
      }
      
      try {
        let resultMessage: string;
        
        switch (mode) {
          case "overwrite": {
            // Default behavior: overwrite entire file
            await writeFileContent(filePath, content, encoding);
            resultMessage = `File written successfully (overwrite mode, ${getEncodingDescription(encoding)}): ${filePath}`;
            break;
          }
          
          case "append": {
            // Append to end of file — 需要用 Buffer 拼接而非原生 appendFile
            const appendBuffer = encodeString(content, encoding);
            await fs.promises.appendFile(filePath, appendBuffer);
            resultMessage = `Content appended successfully (${getEncodingDescription(encoding)}): ${filePath}`;
            break;
          }
          
          case "insert": {
            // Insert at specific line
            const lines = await readFileLines(filePath, encoding);
            const insertPos = Math.max(0, Math.min(position! - 1, lines.length));
            const contentLines = content.split("\n");
            
            // Remove trailing empty line from content if it exists
            if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") {
              contentLines.pop();
            }
            
            lines.splice(insertPos, 0, ...contentLines);
            await writeFileLines(filePath, lines, encoding);
            resultMessage = `Content inserted at line ${position}: ${filePath}`;
            break;
          }
          
          case "replace": {
            // Replace line range
            const lines = await readFileLines(filePath, encoding);
            const start = Math.max(0, Math.min(startLine! - 1, lines.length));
            const end = Math.max(0, Math.min(endLine!, lines.length));
            const deleteCount = end - start;
            
            const contentLines = content.split("\n");
            
            // Remove trailing empty line from content if it exists
            if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") {
              contentLines.pop();
            }
            
            lines.splice(start, deleteCount, ...contentLines);
            await writeFileLines(filePath, lines, encoding);
            resultMessage = `Lines ${startLine}-${endLine} replaced: ${filePath}`;
            break;
          }
          
          default: {
            throw new Error(`Invalid mode: ${mode}`);
          }
        }
        
        // 追踪文件写入（用于任务系统的文件产出收集）
        const fileSize = fs.statSync(filePath).size;
        trackFileWrite(filePath, fileSize, encoding);
        
        return {
          content: [
            {
              type: "text" as const,
              text: resultMessage,
            },
          ],
          details: { filePath, mode, encoding, fileSize },
        } satisfies AgentToolResult<unknown>;
        
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write file: ${errorMsg}`);
      }
    },
  };
}
