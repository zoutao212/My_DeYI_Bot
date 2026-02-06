/**
 * 模糊匹配 Edit 工具包装器
 * 
 * 当精确匹配失败时，自动尝试空白归一化的模糊匹配作为回退。
 * 策略：
 * 1. 先调用原始 edit 工具（精确匹配）
 * 2. 如果失败，读取文件内容，用空白归一化找到最相似的匹配
 * 3. 如果找到唯一匹配，直接执行替换
 * 4. 如果文件不存在且 oldText 为空，回退到 write 模式创建文件
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { normalizeToolParams } from "./pi-tools.read.js";

// 错误关键词，用于检测精确匹配失败
const EDIT_FAIL_PATTERNS = [
  "Could not find the exact text",
  "old text must match exactly",
  "The old text must match exactly",
  "not found in",
];

/**
 * 检测 edit 工具返回结果是否为"精确匹配失败"
 */
function isExactMatchFailure(result: AgentToolResult<unknown>): boolean {
  if (!result || !result.content || !Array.isArray(result.content)) return false;
  
  for (const block of result.content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text") {
      const text = (block as { text?: string }).text ?? "";
      if (EDIT_FAIL_PATTERNS.some(pattern => text.includes(pattern))) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * 将文本中的连续空白（空格、制表符、换行）归一化为单个空格
 * 用于模糊比较
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 在文件内容中查找与 oldText 空白归一化后匹配的片段
 * 返回所有匹配的 { start, end } 位置
 */
function findFuzzyMatches(
  fileContent: string,
  oldText: string,
): Array<{ start: number; end: number; matched: string }> {
  const normalizedOld = normalizeWhitespace(oldText);
  if (!normalizedOld) return [];
  
  const matches: Array<{ start: number; end: number; matched: string }> = [];
  
  // 滑动窗口：在文件内容中找到空白归一化后与 oldText 匹配的片段
  // 策略：按行切分，尝试不同的行范围组合
  const lines = fileContent.split("\n");
  const oldLines = oldText.split("\n");
  const oldLineCount = oldLines.length;
  
  // 允许行数有 ±2 的浮动
  const minLines = Math.max(1, oldLineCount - 2);
  const maxLines = oldLineCount + 2;
  
  for (let startLine = 0; startLine < lines.length; startLine++) {
    for (let span = minLines; span <= maxLines && startLine + span <= lines.length; span++) {
      const candidate = lines.slice(startLine, startLine + span).join("\n");
      const normalizedCandidate = normalizeWhitespace(candidate);
      
      if (normalizedCandidate === normalizedOld) {
        // 计算字符偏移
        let charStart = 0;
        for (let i = 0; i < startLine; i++) {
          charStart += lines[i].length + 1; // +1 for \n
        }
        const charEnd = charStart + candidate.length;
        
        // 去重：如果已有完全相同的匹配，跳过
        const isDuplicate = matches.some(m => m.start === charStart && m.end === charEnd);
        if (!isDuplicate) {
          matches.push({ start: charStart, end: charEnd, matched: candidate });
        }
      }
    }
  }
  
  return matches;
}

/**
 * 包装 edit 工具，添加模糊匹配回退
 */
export function wrapEditWithFuzzyMatch(
  editTool: AnyAgentTool,
  workspaceRoot: string,
): AnyAgentTool {
  const originalExecute = editTool.execute;
  
  return {
    ...editTool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      // 先尝试精确匹配
      let result: AgentToolResult<unknown>;
      try {
        result = await originalExecute(toolCallId, params, signal, onUpdate) as AgentToolResult<unknown>;
      } catch (err) {
        // 如果原始工具抛出异常，包装为结果
        const errMsg = String(err);
        if (EDIT_FAIL_PATTERNS.some(p => errMsg.includes(p))) {
          result = {
            content: [{ type: "text" as const, text: errMsg }],
            details: { error: errMsg },
          };
        } else {
          throw err;
        }
      }
      
      // 如果精确匹配成功，直接返回
      if (!isExactMatchFailure(result)) {
        return result;
      }
      
      // 精确匹配失败，尝试模糊匹配
      const normalized = normalizeToolParams(params);
      const record = normalized ?? (params && typeof params === "object" ? params as Record<string, unknown> : {});
      
      const filePath = typeof record.path === "string" ? record.path : "";
      const oldText = typeof record.oldText === "string" ? record.oldText : "";
      const newText = typeof record.newText === "string" ? record.newText : "";
      
      if (!filePath) {
        return result; // 没有文件路径，无法回退
      }
      
      // 解析绝对路径
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
      
      // 如果 oldText 为空且文件不存在，这是创建新文件的场景
      if (!oldText && newText) {
        try {
          await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
          await fs.promises.writeFile(absPath, newText, "utf-8");
          console.log(`[fuzzy-edit] 📝 文件不存在，已创建: ${filePath}`);
          return {
            content: [{ type: "text" as const, text: `Created new file: ${filePath}` }],
            details: { path: filePath, action: "create" },
          };
        } catch (writeErr) {
          console.error(`[fuzzy-edit] ❌ 创建文件失败: ${writeErr}`);
          return result;
        }
      }
      
      // 读取文件内容
      let fileContent: string;
      try {
        fileContent = await fs.promises.readFile(absPath, "utf-8");
      } catch (readErr) {
        console.log(`[fuzzy-edit] ❌ 无法读取文件 ${filePath}: ${readErr}`);
        return result; // 文件不可读，返回原始错误
      }
      
      // 尝试模糊匹配
      const matches = findFuzzyMatches(fileContent, oldText);
      
      if (matches.length === 0) {
        console.log(`[fuzzy-edit] ❌ 模糊匹配也未找到: ${filePath}`);
        // 返回增强的错误信息
        return {
          content: [{
            type: "text" as const,
            text: `Could not find the text in ${filePath} (both exact and fuzzy match failed).\n\nThe old text must match the file content. Please re-read the file and try again with the correct text.`,
          }],
          details: { path: filePath, action: "fuzzy-edit-failed" },
        };
      }
      
      if (matches.length > 1) {
        console.log(`[fuzzy-edit] ⚠️ 模糊匹配找到 ${matches.length} 处，无法确定唯一替换位置: ${filePath}`);
        return {
          content: [{
            type: "text" as const,
            text: `Fuzzy match found ${matches.length} possible locations in ${filePath}. Cannot determine unique replacement. Please provide more specific oldText.`,
          }],
          details: { path: filePath, matchCount: matches.length, action: "fuzzy-edit-ambiguous" },
        };
      }
      
      // 唯一匹配，执行替换
      const match = matches[0];
      const updatedContent = fileContent.slice(0, match.start) + newText + fileContent.slice(match.end);
      
      try {
        await fs.promises.writeFile(absPath, updatedContent, "utf-8");
        console.log(`[fuzzy-edit] ✅ 模糊匹配替换成功: ${filePath} (位置 ${match.start}-${match.end})`);
        return {
          content: [{
            type: "text" as const,
            text: `Successfully edited ${filePath} (fuzzy match: whitespace differences were normalized)`,
          }],
          details: { path: filePath, action: "fuzzy-edit-success", matchStart: match.start, matchEnd: match.end },
        };
      } catch (writeErr) {
        console.error(`[fuzzy-edit] ❌ 写入失败: ${writeErr}`);
        return {
          content: [{
            type: "text" as const,
            text: `Fuzzy match found the text but failed to write: ${String(writeErr)}`,
          }],
          details: { path: filePath, error: String(writeErr), action: "fuzzy-edit-write-failed" },
        };
      }
    },
  };
}
