/**
 * 爱姬聊天室 — 记忆桥接层
 *
 * 为聊天室角色提供记忆读写能力，采用"预取注入 + 结构化动作解析"两阶段模式：
 *
 * Phase A（LLM 调用前）：
 *   自动搜索与用户消息+角色相关的记忆，注入到角色 prompt 上下文。
 *   复用 deepGrepSearch / localGrepSearch，零额外 LLM 开销。
 *
 * Phase B（LLM 调用后）：
 *   解析 LLM 输出中的结构化记忆动作块，执行实际的记忆写入/更新操作。
 *   复用 createAllMemoryCrudTools 的底层 execute 方法。
 *
 * 设计原则：
 * - 不引入完整 agent loop，保持聊天室的轻量特性
 * - 复用现有记忆系统基础设施，不重复造轮子
 * - 失败静默降级，不阻塞聊天室主流程
 *
 * @module agents/chatroom/memory-bridge
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { deepGrepSearch, getDefaultMemoryDirs } from "../../memory/local-search.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { createMemoryWriteTool, createMemoryUpdateTool } from "../tools/memory-crud-tool.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  MemoryAction,
  MemoryActionResult,
  MemoryContextSnippet,
} from "./types.js";

const log = createSubsystemLogger("chatroom:memory");

// ============================================================================
// 常量
// ============================================================================

/** 预取记忆的最大结果数 */
const MAX_MEMORY_SNIPPETS = 5;

/** 每条记忆片段的最大字符数 */
const SNIPPET_MAX_CHARS = 400;

/** 预取记忆搜索超时（ms） */
const MEMORY_SEARCH_TIMEOUT_MS = 8_000;

/** 记忆动作块的正则（支持 write/append/update 三种类型） */
const MEMORY_ACTION_PATTERN = /<memory_(write|append|update)\s+path=["']([^"']+)["'](?:\s+old=["']([^"']*?)["'])?>([\s\S]*?)<\/memory_\1>/g;

// ============================================================================
// Phase A: 预取记忆上下文
// ============================================================================

/**
 * 为指定角色预取与用户消息相关的记忆上下文
 *
 * 搜索范围：
 * - 角色专属记忆目录（如 characters/lina/memory/）
 * - 全局记忆目录（memory/）
 * - 角色 knowledge 目录
 *
 * @param characterId - 角色 ID
 * @param userMessage - 用户消息（用作搜索查询）
 * @param config - Clawdbot 配置
 * @param agentSessionKey - agent session key（用于解析工作区路径）
 * @returns 记忆上下文片段列表
 */
export async function fetchMemoryContext(
  characterId: string,
  userMessage: string,
  config?: ClawdbotConfig,
  agentSessionKey?: string,
): Promise<MemoryContextSnippet[]> {
  if (!config || !userMessage.trim()) return [];

  try {
    const agentId = resolveSessionAgentId({
      sessionKey: agentSessionKey,
      config,
    });
    const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
    const defaultDirs = getDefaultMemoryDirs(workspaceDir);

    // 构建搜索查询：用户消息 + 角色名（提高角色相关记忆的召回率）
    const searchQuery = `${characterId} ${userMessage}`;

    // 带超时的搜索（防止记忆搜索拖慢聊天室响应）
    const results = await Promise.race([
      deepGrepSearch(searchQuery, {
        dirs: defaultDirs,
        maxResults: MAX_MEMORY_SNIPPETS,
        workspaceDir,
        autoExtractKeywords: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("记忆搜索超时")), MEMORY_SEARCH_TIMEOUT_MS),
      ),
    ]);

    const snippets: MemoryContextSnippet[] = results.map((r) => ({
      path: r.path,
      score: Math.round(r.score * 100) / 100,
      snippet: r.snippet.length > SNIPPET_MAX_CHARS
        ? r.snippet.substring(0, SNIPPET_MAX_CHARS) + "…"
        : r.snippet,
    }));

    if (snippets.length > 0) {
      log.info(
        `[MemoryBridge] ${characterId} 预取记忆: ${snippets.length} 条, ` +
        `top score=${snippets[0].score}`,
      );
    }

    return snippets;
  } catch (err) {
    // 记忆搜索失败不阻塞聊天室
    log.warn(`[MemoryBridge] ${characterId} 记忆预取失败（静默降级）: ${err}`);
    return [];
  }
}

// ============================================================================
// 记忆上下文 → Prompt 注入
// ============================================================================

/**
 * 将预取的记忆片段格式化为 prompt 注入文本
 */
export function formatMemoryContextForPrompt(
  snippets: MemoryContextSnippet[],
  characterId: string,
): string {
  if (snippets.length === 0) return "";

  const parts: string[] = [];
  parts.push(`## 📚 你的记忆（自动检索）`);
  parts.push(`以下是与当前话题相关的记忆片段，供你参考：`);
  parts.push(``);

  for (const s of snippets) {
    parts.push(`- **${s.path}** (相关度 ${s.score}):`);
    parts.push(`  ${s.snippet}`);
    parts.push(``);
  }

  return parts.join("\n");
}

/**
 * 构建记忆写入指引（注入到角色 system prompt）
 *
 * 告诉 LLM 如何在回复中嵌入记忆写入动作。
 */
export function buildMemoryWriteGuide(characterId: string): string {
  return [
    `## 📝 记忆操作能力`,
    `你拥有记忆读写权限。如果你认为当前对话中有值得记住的信息（主人的偏好、重要决定、新知识等），`,
    `可以在回复末尾添加记忆操作块。系统会自动解析并执行，不会显示给主人。`,
    ``,
    `支持的操作格式：`,
    ``,
    `写入新记忆：`,
    `<memory_write path="characters/${characterId}/memory/xxx.md">`,
    `要写入的内容`,
    `</memory_write>`,
    ``,
    `追加到已有记忆：`,
    `<memory_append path="characters/${characterId}/memory/xxx.md">`,
    `要追加的内容`,
    `</memory_append>`,
    ``,
    `更新已有记忆中的特定内容：`,
    `<memory_update path="characters/${characterId}/memory/xxx.md" old="旧文本">`,
    `新文本`,
    `</memory_update>`,
    ``,
    `注意：`,
    `- 路径相对于工作区根目录`,
    `- 只在确实有值得记住的信息时才使用，不要滥用`,
    `- 记忆块放在回复正文之后，用空行分隔`,
    `- 你可以同时使用多个记忆操作块`,
  ].join("\n");
}

// ============================================================================
// Phase B: 解析 + 执行记忆动作
// ============================================================================

/**
 * 从 LLM 输出文本中解析记忆动作块
 *
 * 支持三种格式：
 * - <memory_write path="...">content</memory_write>
 * - <memory_append path="...">content</memory_append>
 * - <memory_update path="..." old="...">new content</memory_update>
 */
export function parseMemoryActions(text: string): {
  actions: MemoryAction[];
  cleanedText: string;
} {
  const actions: MemoryAction[] = [];
  let cleanedText = text;

  // 重置 lastIndex（全局正则）
  MEMORY_ACTION_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MEMORY_ACTION_PATTERN.exec(text)) !== null) {
    const [fullMatch, type, filePath, oldText, content] = match;
    actions.push({
      type: type as MemoryAction["type"],
      filePath: filePath.trim(),
      content: content.trim(),
      oldText: oldText?.trim() || undefined,
    });
    // 从输出文本中移除记忆动作块（不发送给用户）
    cleanedText = cleanedText.replace(fullMatch, "");
  }

  // 清理多余的空行
  cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n").trim();

  if (actions.length > 0) {
    log.info(`[MemoryBridge] 解析到 ${actions.length} 个记忆动作: ${actions.map(a => `${a.type}→${a.filePath}`).join(", ")}`);
  }

  return { actions, cleanedText };
}

/**
 * 执行解析出的记忆动作
 *
 * 复用 memory-crud-tool 的底层实现，保证写入行为与主 agent 一致。
 *
 * @param actions - 要执行的记忆动作列表
 * @param config - Clawdbot 配置
 * @param agentSessionKey - agent session key
 * @returns 执行结果列表
 */
export async function executeMemoryActions(
  actions: MemoryAction[],
  config?: ClawdbotConfig,
  agentSessionKey?: string,
): Promise<MemoryActionResult[]> {
  if (actions.length === 0 || !config) return [];

  const results: MemoryActionResult[] = [];

  // 创建工具实例（复用 memory-crud-tool 的完整实现）
  const writeTool = createMemoryWriteTool({ config, agentSessionKey });
  const updateTool = createMemoryUpdateTool({ config, agentSessionKey });

  for (const action of actions) {
    try {
      // 工具返回 AgentToolResult<unknown>，details 字段包含原始数据
      let details: Record<string, unknown> | undefined;

      switch (action.type) {
        case "write":
          if (!writeTool) throw new Error("memory_write 工具不可用");
          details = extractToolDetails(await writeTool.execute("chatroom-memory", {
            filePath: action.filePath,
            content: action.content,
            mode: "overwrite",
            createDirs: true,
          }));
          break;

        case "append":
          if (!writeTool) throw new Error("memory_write 工具不可用");
          details = extractToolDetails(await writeTool.execute("chatroom-memory", {
            filePath: action.filePath,
            content: action.content,
            mode: "append",
            createDirs: true,
          }));
          break;

        case "update":
          if (!updateTool) throw new Error("memory_update 工具不可用");
          if (!action.oldText) throw new Error("update 操作需要 oldText");
          details = extractToolDetails(await updateTool.execute("chatroom-memory", {
            filePath: action.filePath,
            oldText: action.oldText,
            newText: action.content,
            replaceAll: false,
          }));
          break;
      }

      const ok = details?.success !== false;
      const errMsg = ok ? undefined : String(details?.error ?? "未知错误");

      results.push({ action, ok, error: errMsg });
      log.info(`[MemoryBridge] 记忆动作 ${action.type}→${action.filePath}: ${ok ? "✅" : "❌"}`);
    } catch (err) {
      results.push({ action, ok: false, error: String(err) });
      log.warn(`[MemoryBridge] 记忆动作执行失败 ${action.type}→${action.filePath}: ${err}`);
    }
  }

  return results;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 从 AgentToolResult 中提取 details 对象
 *
 * memory-crud-tool 的 execute() 返回 jsonResult(payload)，
 * 其中 details 字段包含原始 payload（如 { success: true, path: "..." }）。
 */
function extractToolDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  // AgentToolResult 的 details 字段
  if (r.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  // 直接就是 plain object（兜底）
  if ("success" in r) return r;
  return undefined;
}
