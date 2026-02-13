/**
 * H4: 结构化记忆补丁工具（Memory Patch Tool）
 *
 * 提供 memory_patch LLM 工具，支持对 Markdown 记忆文件的结构化操作：
 * - set_field: 在指定 section 下设置 key=value（自动创建/更新）
 * - append_to_list: 在指定 section 的列表末尾追加一项
 * - remove_from_list: 从指定 section 的列表中删除匹配项
 * - upsert_section: 创建或整体替换一个 section
 * - delete_section: 删除整个 section
 *
 * 底层解析 Markdown 标题层级+列表结构，精确定位后修改，
 * 比 memory_update 的精确文本匹配更鲁棒。
 *
 * @module agents/tools/memory-patch-tool
 */

import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ClawdbotConfig } from "../../config/config.js";
import {
  invalidateFileCache,
  invalidateDirCache,
} from "../../memory/local-search.js";
import { invalidateSearchCache } from "../../memory/query-router.js";
import { getMemorySearchManager } from "../../memory/search-manager.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ─── Schema ──────────────────────────────────────────────────

const MemoryPatchSchema = Type.Object({
  /** 记忆文件的相对路径（如 memory/preferences.md） */
  filePath: Type.String(),
  /** 操作类型 */
  operation: Type.Union([
    Type.Literal("set_field"),
    Type.Literal("append_to_list"),
    Type.Literal("remove_from_list"),
    Type.Literal("upsert_section"),
    Type.Literal("delete_section"),
  ]),
  /** 目标 section 标题（精确匹配，如 "偏好设置" 或 "角色属性"） */
  section: Type.String(),
  /** key 名（set_field 时必填） */
  key: Type.Optional(Type.String()),
  /** 值（set_field / append_to_list / upsert_section 时必填） */
  value: Type.Optional(Type.String()),
  /** 匹配模式（remove_from_list 时必填，支持子串匹配） */
  pattern: Type.Optional(Type.String()),
});

// ─── Markdown Section 解析 ───────────────────────────────────

interface MarkdownSection {
  /** section 标题（不含 # 前缀） */
  title: string;
  /** 标题级别（1-6） */
  level: number;
  /** 标题行索引（0-indexed） */
  headerLine: number;
  /** section 内容起始行（标题下一行） */
  contentStart: number;
  /** section 内容结束行（不含，到下一个同级/上级标题或文件末尾） */
  contentEnd: number;
}

/**
 * 解析 Markdown 文件的 section 结构
 */
function parseSections(lines: string[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      sections.push({
        title: match[2].trim(),
        level: match[1].length,
        headerLine: i,
        contentStart: i + 1,
        contentEnd: lines.length, // 暂时设为文件末尾
      });
    }
  }

  // 计算每个 section 的实际结束行
  for (let i = 0; i < sections.length; i++) {
    const current = sections[i];
    // 找到下一个同级或上级标题
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= current.level) {
        current.contentEnd = sections[j].headerLine;
        break;
      }
    }
  }

  return sections;
}

/**
 * 在 section 内容中查找 key: value 行
 * 返回行索引（相对于整个文件），-1 表示未找到
 */
function findFieldLine(lines: string[], section: MarkdownSection, key: string): number {
  const keyLower = key.toLowerCase().trim();
  for (let i = section.contentStart; i < section.contentEnd; i++) {
    const line = lines[i];
    // 匹配格式：key: value 或 key：value 或 - **key**: value
    const fieldMatch = line.match(/^[-*]*\s*\*{0,2}([^:：*]+?)\*{0,2}\s*[:：]\s*/);
    if (fieldMatch && fieldMatch[1].trim().toLowerCase() === keyLower) {
      return i;
    }
  }
  return -1;
}

/**
 * 在 section 内容中查找列表区域的最后一行
 * 返回最后一个列表项的行索引，-1 表示没有列表
 */
function findListEnd(lines: string[], section: MarkdownSection): number {
  let lastListLine = -1;
  for (let i = section.contentStart; i < section.contentEnd; i++) {
    if (/^\s*[-*+]\s/.test(lines[i]) || /^\s*\d+\.\s/.test(lines[i])) {
      lastListLine = i;
    }
  }
  return lastListLine;
}

// ─── 操作实现 ────────────────────────────────────────────────

function applySetField(lines: string[], section: MarkdownSection, key: string, value: string): string[] {
  const result = [...lines];
  const fieldLine = findFieldLine(lines, section, key);

  if (fieldLine >= 0) {
    // 更新已有字段
    const existing = result[fieldLine];
    const colonMatch = existing.match(/^([-*]*\s*\*{0,2}[^:：*]+?\*{0,2}\s*[:：]\s*)/);
    if (colonMatch) {
      result[fieldLine] = colonMatch[1] + value;
    } else {
      result[fieldLine] = `- **${key}**: ${value}`;
    }
  } else {
    // 在 section 末尾添加字段（找到最后一个非空行后插入）
    let insertAt = section.contentEnd;
    for (let i = section.contentEnd - 1; i >= section.contentStart; i--) {
      if (lines[i].trim() !== "") {
        insertAt = i + 1;
        break;
      }
    }
    result.splice(insertAt, 0, `- **${key}**: ${value}`);
  }

  return result;
}

function applyAppendToList(lines: string[], section: MarkdownSection, item: string): string[] {
  const result = [...lines];
  const listEnd = findListEnd(lines, section);

  if (listEnd >= 0) {
    // 在列表末尾追加
    const indent = lines[listEnd].match(/^(\s*)/)?.[1] ?? "";
    const bullet = /^\s*\d+\./.test(lines[listEnd]) ? "1." : "-";
    result.splice(listEnd + 1, 0, `${indent}${bullet} ${item}`);
  } else {
    // section 内无列表，在 section 内容末尾新建列表
    let insertAt = section.contentEnd;
    for (let i = section.contentEnd - 1; i >= section.contentStart; i--) {
      if (lines[i].trim() !== "") {
        insertAt = i + 1;
        break;
      }
    }
    result.splice(insertAt, 0, `- ${item}`);
  }

  return result;
}

function applyRemoveFromList(lines: string[], section: MarkdownSection, pattern: string): { lines: string[]; removedCount: number } {
  const patternLower = pattern.toLowerCase();
  const toRemove: number[] = [];

  for (let i = section.contentStart; i < section.contentEnd; i++) {
    if (/^\s*[-*+]\s/.test(lines[i]) || /^\s*\d+\.\s/.test(lines[i])) {
      if (lines[i].toLowerCase().includes(patternLower)) {
        toRemove.push(i);
      }
    }
  }

  if (toRemove.length === 0) {
    return { lines, removedCount: 0 };
  }

  const result = lines.filter((_, i) => !toRemove.includes(i));
  return { lines: result, removedCount: toRemove.length };
}

function applyUpsertSection(lines: string[], sections: MarkdownSection[], sectionTitle: string, content: string): string[] {
  const existing = sections.find(s => s.title === sectionTitle);
  const result = [...lines];

  if (existing) {
    // 替换已有 section 内容（保留标题）
    const newContent = content.split("\n");
    result.splice(existing.contentStart, existing.contentEnd - existing.contentStart, ...newContent);
  } else {
    // 在文件末尾追加新 section
    const headerLevel = sections.length > 0 ? sections[sections.length - 1].level : 2;
    const header = "#".repeat(headerLevel) + " " + sectionTitle;
    const newLines = ["", header, "", ...content.split("\n"), ""];
    result.push(...newLines);
  }

  return result;
}

function applyDeleteSection(lines: string[], section: MarkdownSection): string[] {
  const result = [...lines];
  // 删除从标题行到 section 结束
  result.splice(section.headerLine, section.contentEnd - section.headerLine);
  return result;
}

// ─── 工具创建 ────────────────────────────────────────────────

interface MemoryPatchToolOptions {
  config?: ClawdbotConfig;
  agentSessionKey?: string;
}

export function createMemoryPatchTool(options: MemoryPatchToolOptions): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Memory Patch",
    name: "memory_patch",
    description:
      "记忆结构化补丁：对 Markdown 记忆文件执行精确的结构化操作，比 memory_update 更鲁棒。\n" +
      "支持 5 种操作：\n" +
      "- set_field(section, key, value)：在指定 section 下设置/更新 key-value 字段\n" +
      "- append_to_list(section, value)：在指定 section 的列表末尾追加一项\n" +
      "- remove_from_list(section, pattern)：从列表中删除包含 pattern 的项\n" +
      "- upsert_section(section, value)：创建或整体替换一个 section\n" +
      "- delete_section(section)：删除整个 section\n" +
      "路径相对于工作区根，如 memory/preferences.md、characters/lina/memory/core.md",
    parameters: MemoryPatchSchema,
    execute: async (_toolCallId, params) => {
      const filePath = readStringParam(params, "filePath", { required: true });
      const operation = readStringParam(params, "operation", { required: true });
      const sectionTitle = readStringParam(params, "section", { required: true });
      const key = readStringParam(params, "key");
      const value = readStringParam(params, "value");
      const pattern = readStringParam(params, "pattern");

      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const absPath = path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.normalize(path.join(workspaceDir, filePath));

      // 安全检查
      if (!absPath.startsWith(workspaceDir)) {
        return jsonResult({ success: false, error: "路径不在工作区范围内" });
      }

      try {
        // 读取文件
        let content: string;
        try {
          content = await fs.readFile(absPath, "utf-8");
        } catch {
          // 文件不存在时，upsert_section 可以创建
          if (operation === "upsert_section" && value) {
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            const header = `## ${sectionTitle}`;
            const newContent = `${header}\n\n${value}\n`;
            await fs.writeFile(absPath, newContent, "utf-8");
            invalidateFileCache(absPath);
            invalidateDirCache();
            invalidateSearchCache();
            void triggerIndex(cfg, agentId, absPath);
            return jsonResult({
              success: true,
              operation,
              section: sectionTitle,
              created: true,
              path: filePath,
            });
          }
          return jsonResult({ success: false, error: "文件不存在" });
        }

        const lines = content.split("\n");
        const sections = parseSections(lines);
        const targetSection = sections.find(s => s.title === sectionTitle);

        // 验证 section 存在性
        if (!targetSection && operation !== "upsert_section") {
          const available = sections.map(s => s.title);
          return jsonResult({
            success: false,
            error: `未找到 section "${sectionTitle}"`,
            availableSections: available,
            hint: "请确认 section 名称拼写正确，或使用 upsert_section 创建新 section",
          });
        }

        let resultLines: string[];
        let detail: Record<string, unknown> = {};

        switch (operation) {
          case "set_field": {
            if (!key) return jsonResult({ success: false, error: "set_field 需要 key 参数" });
            if (value === undefined || value === null) return jsonResult({ success: false, error: "set_field 需要 value 参数" });
            resultLines = applySetField(lines, targetSection!, key, value);
            detail = { key, value };
            break;
          }
          case "append_to_list": {
            if (!value) return jsonResult({ success: false, error: "append_to_list 需要 value 参数" });
            resultLines = applyAppendToList(lines, targetSection!, value);
            detail = { appended: value };
            break;
          }
          case "remove_from_list": {
            if (!pattern) return jsonResult({ success: false, error: "remove_from_list 需要 pattern 参数" });
            const removeResult = applyRemoveFromList(lines, targetSection!, pattern);
            resultLines = removeResult.lines;
            detail = { pattern, removedCount: removeResult.removedCount };
            if (removeResult.removedCount === 0) {
              return jsonResult({
                success: false,
                error: `未找到包含 "${pattern}" 的列表项`,
                section: sectionTitle,
              });
            }
            break;
          }
          case "upsert_section": {
            if (!value) return jsonResult({ success: false, error: "upsert_section 需要 value 参数" });
            resultLines = applyUpsertSection(lines, sections, sectionTitle, value);
            detail = { upserted: true, existed: !!targetSection };
            break;
          }
          case "delete_section": {
            resultLines = applyDeleteSection(lines, targetSection!);
            detail = { deleted: true, linesRemoved: targetSection!.contentEnd - targetSection!.headerLine };
            break;
          }
          default:
            return jsonResult({ success: false, error: `未知操作: ${operation}` });
        }

        // 写入文件
        const newContent = resultLines.join("\n");
        await fs.writeFile(absPath, newContent, "utf-8");

        // 刷新缓存
        invalidateFileCache(absPath);
        invalidateSearchCache();
        void triggerIndex(cfg, agentId, absPath);

        return jsonResult({
          success: true,
          operation,
          section: sectionTitle,
          path: filePath,
          ...detail,
          newLines: resultLines.length,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/** M7: fire-and-forget 即时索引 */
async function triggerIndex(cfg: ClawdbotConfig, agentId: string, absPath: string): Promise<void> {
  try {
    const result = await getMemorySearchManager({ cfg, agentId });
    if (result.manager) {
      await result.manager.notifyFileChanged(absPath);
    }
  } catch { /* 静默降级 */ }
}
