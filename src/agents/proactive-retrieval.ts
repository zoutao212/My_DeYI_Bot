/**
 * 主动检索增强引擎 (Proactive Retrieval Augmentation Engine)
 *
 * 核心职责：在用户消息进入 LLM prompt 之前，主动从多个维度进行检索，
 * 并将相关性高的上下文信息注入到 extraSystemPrompt 中。
 *
 * 检索维度：
 * 1. 记忆系统检索 (MEMORY.md + memory/*.md)
 * 2. 小说文本切片检索 (NovelsAssets/*.txt)
 * 3. 关键词扩展检索 (从 Agent 定义、系统提示词中抽取关键词)
 * 4. ToolCall 2.0 工具定义注入
 *
 * 使用时机：
 * - 用户发送消息后、LLM prompt 构建前
 * - 子任务执行前、attempt.ts 构建 system prompt 时
 *
 * @module agents/proactive-retrieval
 */

import type { ClawdbotConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getMemorySearchManager } from "../memory/index.js";
import { localGrepSearch, deepGrepSearch, getDefaultMemoryDirs } from "../memory/local-search.js";
import { searchNovelAssets, hasNovelAssets } from "../memory/novel-assets-searcher.js";
import { extractSearchTerms } from "../memory/keyword-extractor.js";
import { intelligentExtract, adjustRetrievalParams } from "../memory/intelligent-keyword-extractor.js"; // 🆕 智能关键词抽取
import { optimizeRetrievalResult } from "../memory/tiered-retrieval-optimizer.js"; // 🆕 分层检索优化
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { resolveMemorySearchConfig } from "./memory-search.js";

const log = createSubsystemLogger("proactive-retrieval");

/** 检索结果条目 */
export interface RetrievalSnippet {
  /** 来源类型 */
  source: "memory" | "novel" | "agent-def" | "tool-def";
  /** 文件路径或标识符 */
  path: string;
  /** 起始行号 (1-indexed) */
  startLine?: number;
  /** 结束行号 (1-indexed) */
  endLine?: number;
  /** 片段文本 */
  text: string;
  /** 匹配分数 (0-1) */
  score: number;
  /** 匹配的关键词 */
  matchedTerms?: string[];
}

/** 检索配置 */
export interface ProactiveRetrievalOptions {
  /** 用户原始消息 */
  userMessage: string;
  /** Agent 定义文本 (可选，用于抽取关键词) */
  agentDefinition?: string;
  /** 系统提示词文本 (可选，用于抽取关键词) */
  systemPrompt?: string;
  /** 背景提示词文本 (可选，用于抽取关键词) */
  backgroundPrompt?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 会话 Key */
  sessionKey?: string;
  /** 最大返回片段数 (默认 8) */
  maxSnippets?: number;
  /** 最低分数阈值 (默认 0.3) */
  minScore?: number;
  /** 是否启用记忆检索 (默认 true) */
  enableMemory?: boolean;
  /** 是否启用小说检索 (默认 true) */
  enableNovel?: boolean;
  /** 是否启用 Agent 定义关键词抽取 (默认 true) */
  enableAgentDef?: boolean;
  /** 是否启用 ToolCall 2.0 工具定义注入 (默认 true) */
  enableToolDefs?: boolean;
}

/** 检索结果 */
export interface ProactiveRetrievalResult {
  /** 所有检索到的片段 */
  snippets: RetrievalSnippet[];
  /** 格式化后的上下文字符串 (可直接注入 prompt) */
  formattedContext: string;
  /** 使用的关键词列表 */
  extractedKeywords: string[];
  /** 检索耗时 (ms) */
  durationMs: number;
  /** 各通道命中数量统计 */
  stats: {
    memory: number;
    novel: number;
    agentDef: number;
    toolDef: number;
  };
  /** 🆕 智能抽取结果（意图、实体、时间敏感度） */
  intelligentExtraction?: import("../memory/intelligent-keyword-extractor.js").IntelligentExtractionResult;
  /** 🆕 分层检索结果 */
  tieredResult?: import("../memory/tiered-retrieval-optimizer.js").TieredRetrievalResult;
  /** 🆕 优化后的检索结果（含注入建议） */
  optimizedResult?: import("../memory/tiered-retrieval-optimizer.js").OptimizedRetrievalResult;
  /** 🆕 分层信息（高/中/低相关性分组） */
  tiers?: {
    /** 高相关性片段 (>0.7) */
    highRelevance: RetrievalSnippet[];
    /** 中等相关性片段 (0.4-0.7) */
    mediumRelevance: RetrievalSnippet[];
    /** 低相关性片段 (<0.4) */
    lowRelevance: RetrievalSnippet[];
  };
}

/**
 * 从 Agent 定义、系统提示词、背景提示词中抽取关键词
 */
function extractKeywordsFromContexts(options: {
  agentDefinition?: string;
  systemPrompt?: string;
  backgroundPrompt?: string;
  userMessage: string;
}): string[] {
  const texts: string[] = [];
  
  if (options.agentDefinition) texts.push(options.agentDefinition);
  if (options.systemPrompt) texts.push(options.systemPrompt);
  if (options.backgroundPrompt) texts.push(options.backgroundPrompt);
  
  // 合并所有文本后统一抽取关键词
  const combinedText = texts.join("\n\n");
  const extracted = extractSearchTerms(combinedText);
  
  // 同时从用户消息中抽取关键词
  const userKeywords = extractSearchTerms(options.userMessage);
  
  // 合并去重
  const allKeywords = Array.from(new Set([...extracted, ...userKeywords]));
  
  log.debug(`Extracted ${allKeywords.length} keywords from contexts + user message`);
  return allKeywords;
}

/**
 * 格式化检索结果为可注入 prompt 的文本
 */
function formatRetrievalContext(snippets: RetrievalSnippet[]): string {
  if (snippets.length === 0) return "";
  
  const groups: Record<string, RetrievalSnippet[]> = {
    memory: [],
    novel: [],
    "agent-def": [],
    "tool-def": [],
  };
  
  for (const snippet of snippets) {
    groups[snippet.source].push(snippet);
  }
  
  const sections: string[] = [];
  
  // 记忆系统片段
  if (groups.memory.length > 0) {
    const lines = groups.memory.map(s => {
      const location = s.startLine !== undefined && s.endLine !== undefined
        ? ` (${s.path}:${s.startLine}-${s.endLine})`
        : ` (${s.path})`;
      return `- [记忆${location}]: ${s.text.substring(0, 300)}${s.text.length > 300 ? "..." : ""}`;
    });
    sections.push(`## 相关记忆\n${lines.join("\n")}`);
  }
  
  // 小说文本片段
  if (groups.novel.length > 0) {
    const lines = groups.novel.map(s => {
      const location = s.startLine !== undefined && s.endLine !== undefined
        ? ` (${s.path}:${s.startLine}-${s.endLine})`
        : ` (${s.path})`;
      return `- [小说片段${location}]: ${s.text.substring(0, 300)}${s.text.length > 300 ? "..." : ""}`;
    });
    sections.push(`## 相关小说文本\n${lines.join("\n")}`);
  }
  
  // Agent 定义相关
  if (groups.agent_def.length > 0) {
    const lines = groups.agent_def.map(s => {
      return `- [Agent 定义]: ${s.text.substring(0, 300)}${s.text.length > 300 ? "..." : ""}`;
    });
    sections.push(`## Agent 定义参考\n${lines.join("\n")}`);
  }
  
  // ToolCall 2.0 工具定义
  if (groups.tool_def.length > 0) {
    const lines = groups.tool_def.map(s => {
      return `- [工具定义]: ${s.text.substring(0, 300)}${s.text.length > 300 ? "..." : ""}`;
    });
    sections.push(`## 可用工具\n${lines.join("\n")}`);
  }
  
  if (sections.length === 0) return "";
  
  return `\n\n=== 主动检索的上下文信息 ===\n${sections.join("\n\n")}\n===============================\n`;
}

/**
 * 🆕 分层格式化检索结果 - 根据不同相关性级别采用不同注入策略
 */
function formatRetrievalContextWithTiers(
  snippets: RetrievalSnippet[],
  tiers: {
    highRelevance: RetrievalSnippet[];
    mediumRelevance: RetrievalSnippet[];
    lowRelevance: RetrievalSnippet[];
  }
): string {
  if (snippets.length === 0) return "";
  
  const sections: string[] = [];
  
  // 🔴 高相关性片段 - 直接注入核心区域（LLM 必读）
  if (tiers.highRelevance.length > 0) {
    const lines = tiers.highRelevance.map(s => {
      const location = s.startLine !== undefined && s.endLine !== undefined
        ? ` (${s.path}:${s.startLine}-${s.endLine})`
        : ` (${s.path})`;
      return `【必读】${s.text.substring(0, 350)}${s.text.length > 350 ? "..." : ""}${location}`;
    });
    sections.push(`## 🔴 高相关性背景信息（重要）\n${lines.join("\n")}`);
  }
  
  // 🟡 中等相关性片段 - 注入参考区域（可选阅读）
  if (tiers.mediumRelevance.length > 0) {
    const lines = tiers.mediumRelevance.map(s => {
      const location = s.startLine !== undefined && s.endLine !== undefined
        ? ` (${s.path}:${s.startLine}-${s.endLine})`
        : ` (${s.path})`;
      return `[参考]${s.text.substring(0, 300)}${s.text.length > 300 ? "..." : ""}${location}`;
    });
    sections.push(`## 🟡 中等相关性参考资料（选读）\n${lines.join("\n")}`);
  }
  
  // 🟢 低相关性片段 - 不注入 prompt，仅记录日志（已在上面过滤）
  // 如果有特殊需求需要注入，可以放在这里
  
  if (sections.length === 0) return "";
  
  return `\n\n=== 主动检索的分层上下文信息 ===\n${sections.join("\n\n")}\n=====================================\n`;
}

/**
 * 执行主动检索增强
 *
 * 这是核心函数，会在以下时机被调用：
 * 1. 用户消息到达时 (followup-runner.ts)
 * 2. 子任务执行前 (attempt.ts)
 * 3. system prompt 构建前
 *
 * @param config - Clawdbot 配置对象
 * @param options - 检索选项
 * @returns 检索结果
 */
export async function proactiveRetrieval(
  config: ClawdbotConfig,
  options: ProactiveRetrievalOptions,
): Promise<ProactiveRetrievalResult> {
  const startTime = Date.now();
  
  const maxSnippets = options.maxSnippets ?? 8;
  const minScore = options.minScore ?? 0.3;
  const enableMemory = options.enableMemory ?? true;
  const enableNovel = options.enableNovel ?? true;
  const enableAgentDef = options.enableAgentDef ?? true;
  const enableToolDefs = options.enableToolDefs ?? true;
  
  // 🆕 Step 1: 智能关键词抽取（意图识别、实体识别、时间敏感度分析）
  const intelligentResult = intelligentExtract(options.userMessage);
  log.debug(
    `🆕 智能抽取完成：意图=${intelligentResult.intent}, ` +
    `实体=${intelligentResult.entities.length}, ` +
    `时间敏感=${intelligentResult.temporal.hasTemporal}, ` +
    `策略=${intelligentResult.suggestedStrategy}`
  );
  
  // 🆕 Step 2: 根据检索策略调整参数
  const adjustedParams = adjustRetrievalParams(intelligentResult.suggestedStrategy);
  const effectiveMaxSnippets = options.maxSnippets ?? adjustedParams.maxSnippets;
  const effectiveMinScore = options.minScore ?? adjustedParams.minScore;
  
  log.debug(
    `🆕 检索参数调整：maxSnippets=${effectiveMaxSnippets}, ` +
    `minScore=${effectiveMinScore}, ` +
    `prioritizeRecent=${adjustedParams.prioritizeRecent}`
  );
  
  // Step 3: 从多源抽取关键词（传统方法 + 智能扩展）
  const traditionalKeywords = extractKeywordsFromContexts({
    agentDefinition: options.agentDefinition,
    systemPrompt: options.systemPrompt,
    backgroundPrompt: options.backgroundPrompt,
    userMessage: options.userMessage,
  });
  
  // 合并传统关键词和智能扩展词
  const allKeywords = Array.from(
    new Set([...traditionalKeywords, ...intelligentResult.keywords, ...intelligentResult.expandedTerms])
  ).slice(0, 20); // 限制最多 20 个关键词
  
  log.debug(`Starting proactive retrieval with ${allKeywords.length} keywords (merged traditional + intelligent)`);
  
  // Step 4: 并行执行多维度检索
  const allSnippets: RetrievalSnippet[] = [];
  const stats = { memory: 0, novel: 0, agentDef: 0, toolDef: 0 };
  
  // 2.1 记忆系统检索
  if (enableMemory) {
    try {
      const agentId = resolveSessionAgentId({
        sessionKey: options.sessionKey,
        config,
      });
      
      const memCfg = resolveMemorySearchConfig(config, agentId);
      if (memCfg) {
        const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
        const dirs = getDefaultMemoryDirs(workspaceDir);
        
        // 使用多关键词检索
        for (const keyword of allKeywords.slice(0, 5)) { // 限制最多 5 个关键词，避免过多查询
          const results = await localGrepSearch(keyword, {
            dirs,
            extensions: [".md"],
            maxResults: Math.ceil(effectiveMaxSnippets / 2),
            workspaceDir,
          });
          
          for (const r of results) {
            if (r.score >= effectiveMinScore) {
              allSnippets.push({
                source: "memory",
                path: r.path,
                startLine: r.startLine,
                endLine: r.endLine,
                text: r.snippet,
                score: r.score,
                matchedTerms: (r as any).matchedTerms || [],
              });
              stats.memory++;
            }
          }
        }
        
        // 同时也用语义搜索 (如果 manager 可用)
        const { manager } = await getMemorySearchManager({ cfg: config, agentId });
        if (manager) {
          const semanticResults = await manager.search(options.userMessage, {
            maxResults: Math.ceil(effectiveMaxSnippets / 2),
            minScore: effectiveMinScore,
            sessionKey: options.sessionKey,
          });
          
          for (const r of semanticResults) {
            allSnippets.push({
              source: "memory",
              path: r.path,
              startLine: r.startLine,
              endLine: r.endLine,
              text: r.snippet,
              score: r.score,
            });
            stats.memory++;
          }
        }
      }
    } catch (err) {
      log.debug(`Memory retrieval failed: ${err}`);
    }
  }
  
  // 2.2 小说文本检索
  if (enableNovel) {
    try {
      const agentId = resolveSessionAgentId({
        sessionKey: options.sessionKey,
        config,
      });
      const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
      
      const novelAvailable = await hasNovelAssets(workspaceDir).catch(() => false);
      if (novelAvailable) {
        const novelResult = await searchNovelAssets(options.userMessage, workspaceDir, {
          maxSnippets: Math.ceil(effectiveMaxSnippets / 2),
          snippetTargetChars: 300,
          snippetMaxChars: 500,
          autoExtractKeywords: true,
          extraTerms: allKeywords,
        });
        
        for (const s of novelResult.snippets) {
          if (s.score >= effectiveMinScore) {
            allSnippets.push({
              source: "novel",
              path: `NovelsAssets/${s.fileName}`,
              startLine: s.startLine,
              endLine: s.endLine,
              text: s.text,
              score: s.score,
              matchedTerms: s.matchedTerms,
            });
            stats.novel++;
          }
        }
      }
    } catch (err) {
      log.debug(`Novel retrieval failed: ${err}`);
    }
  }
  
  // 2.3 Agent 定义相关片段 (从抽取的关键词反向检索)
  if (enableAgentDef && options.agentDefinition) {
    for (const keyword of allKeywords.slice(0, 3)) {
      const lowerDef = options.agentDefinition.toLowerCase();
      const lowerKeyword = keyword.toLowerCase();
      const index = lowerDef.indexOf(lowerKeyword);
      
      if (index !== -1) {
        // 提取关键词周围的上下文
        const start = Math.max(0, index - 100);
        const end = Math.min(options.agentDefinition.length, index + keyword.length + 200);
        const snippet = options.agentDefinition.substring(start, end).replace(/\n/g, " ");
        
        allSnippets.push({
          source: "agent-def",
          path: "agent-definition",
          text: snippet,
          score: 0.8, // 人工设定的高分，因为是直接匹配
          matchedTerms: [keyword],
        });
        stats.agentDef++;
      }
    }
  }
  
  // 2.4 ToolCall 2.0 工具定义注入
  if (enableToolDefs) {
    try {
      // 从 pi-tools.ts 获取当前注册的工具列表
      const { createClawdbotCodingTools } = await import("./pi-tools.js");
      const tools = createClawdbotCodingTools({
        workspaceDir: resolveAgentWorkspaceDir(config, resolveSessionAgentId({ sessionKey: options.sessionKey, config })),
        config,
      });
      
      // 转换为可读的文本格式注入到 prompt
      const toolDefTexts = tools.slice(0, 10).map(tool => {
        const paramDesc = tool.parameters 
          ? Object.entries(tool.parameters.properties || {})
              .map(([k, v]) => `  - ${k}: ${(v as any).description || "any"}`)
              .join("\n")
          : "";
        return `**${tool.name}**: ${tool.description || "No description"}\n${paramDesc ? `参数:\n${paramDesc}` : ""}`;
      });
      
      if (toolDefTexts.length > 0) {
        const toolDefsFormatted = `\n## 可用工具列表\n你有以下工具可用:\n\n${toolDefTexts.join("\n\n")}\n`;
        
        allSnippets.push({
          source: "tool-def",
          path: "registered-tools",
          text: toolDefsFormatted,
          score: 1.0, // 工具定义始终高分
        });
        stats.toolDef++;
        
        log.debug(`Injected ${toolDefTexts.length} tool definitions`);
      }
    } catch (err) {
      log.debug(`Tool definition injection failed: ${err}`);
    }
  }
  
  // 🆕 Step 3: 去重 + 排序 + 分层
  const seen = new Set<string>();
  const deduplicated = allSnippets.filter(s => {
    const key = `${s.source}:${s.path}:${s.startLine}-${s.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  deduplicated.sort((a, b) => b.score - a.score);
  
  // 🆕 按相关性分层
  const highRelevance = deduplicated.filter(s => s.score >= 0.7);
  const mediumRelevance = deduplicated.filter(s => s.score >= 0.4 && s.score < 0.7);
  const lowRelevance = deduplicated.filter(s => s.score < 0.4);
  
  // 优先选择高相关性片段，但不超过总限额
  const maxHigh = Math.min(highRelevance.length, Math.ceil(effectiveMaxSnippets * 0.6)); // 60% 给高相关
  const maxMedium = Math.min(mediumRelevance.length, effectiveMaxSnippets - maxHigh); // 剩余给中等相关
  
  const finalSnippets = [
    ...highRelevance.slice(0, maxHigh),
    ...mediumRelevance.slice(0, maxMedium),
  ];
  
  // 🆕 记录低相关性片段供分析（不注入 prompt）
  if (lowRelevance.length > 0) {
    log.debug(`📊 低相关性片段：${lowRelevance.length} 条（未注入，仅记录）`);
  }
  
  // 🆕 Step 4: 分层格式化输出
  const formattedContext = formatRetrievalContextWithTiers(finalSnippets, {
    highRelevance,
    mediumRelevance,
    lowRelevance,
  });
  const durationMs = Date.now() - startTime;
  
  log.info(`🆕 主动检索完成：耗时${durationMs}ms, 总计${deduplicated.length}条，注入${finalSnippets.length}条 (高:${highRelevance.length}, 中:${mediumRelevance.length}, 低:${lowRelevance.length})`);
  
  return {
    snippets: finalSnippets,
    formattedContext,
    extractedKeywords: allKeywords,
    durationMs,
    stats,
    tiers: {
      highRelevance,
      mediumRelevance,
      lowRelevance,
    },
  };
}

/**
 * 快速检索接口 (简化版，适用于对延迟敏感的场景)
 * 只执行关键词抽取和记忆检索，不执行小说检索和 Agent 定义检索
 */
export async function quickRetrieval(
  config: ClawdbotConfig,
  userMessage: string,
  sessionKey?: string,
): Promise<string> {
  const result = await proactiveRetrieval(config, {
    userMessage,
    sessionKey,
    maxSnippets: 4,
    minScore: 0.4,
    enableNovel: false,
    enableAgentDef: false,
    enableToolDefs: false,
  });
  
  return result.formattedContext;
}
