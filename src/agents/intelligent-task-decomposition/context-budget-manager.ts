/**
 * V8 P0: 上下文预算管理器 (Context Budget Manager)
 *
 * 核心职责：
 * 1. 根据模型 contextWindow 和 maxOutputTokens 计算可用输入预算
 * 2. 按优先级为各 prompt 组件分配 token 预算
 * 3. 超预算时按优先级从低到高压缩
 * 4. 提供智能截断（找最近的完整边界，不断在句子/段落中间）
 *
 * 解决的根本问题：
 * - 当前所有截断都是字符级硬编码，不感知 token 预算
 * - 各组件独立截断，不感知其他组件的消耗
 * - 没有输出空间预留的概念
 * - model.contextWindow 信息不流向 prompt 构建层
 */

// ────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────

/**
 * Prompt 组件槽位名称
 *
 * 按 followup-runner.ts 中的 prompt 构建流程定义，
 * 每个槽位对应一个可独立截断的 prompt 片段。
 */
export type BudgetSlot =
  | "systemBase"        // 系统基础 prompt（工具描述+agent info）— 不可压缩
  | "blueprint"         // 纲领上下文（V7 结构化组件 或 masterBlueprint 回退）
  | "chapterOutline"    // 章节大纲 + 相邻章节摘要
  | "siblingContext"    // 兄弟任务上下文（buildSiblingContext）
  | "iterationContext"  // 迭代优化（previousOutput + failureFindings）
  | "userPrompt"        // 用户 prompt 本体（含强制落盘/禁委派指令）
  | "outputReserve";    // LLM 输出保留空间 — 不可压缩

/**
 * 预算请求 — 每个组件申报自己的"期望"和"最低"token 数
 */
export interface BudgetRequest {
  /** 槽位名称 */
  slot: BudgetSlot;
  /** 期望 token 数（理想状态下需要的量） */
  desired: number;
  /** 最低可接受 token 数（低于此值该组件无意义，设 0 表示可完全丢弃） */
  minimum: number;
  /**
   * 优先级（0 = 最高，数字越大越容易被压缩）
   *
   * 默认优先级表：
   *   0: systemBase（不可压缩）
   *   1: outputReserve（不可压缩）
   *   2: userPrompt（核心任务指令，最后才压缩）
   *   3: chapterOutline（当前章节的具体大纲）
   *   4: blueprint（全局纲领/人物卡/世界观）
   *   5: iterationContext（重试时的上次输出参考）
   *   6: siblingContext（兄弟任务摘要，可完全丢弃）
   */
  priority: number;
  /** 原始内容（用于截断计算；systemBase/outputReserve 不需要） */
  content?: string;
}

/**
 * 预算分配结果
 */
export interface BudgetAllocation {
  /** 各槽位的最终分配（token 数） */
  slots: Record<BudgetSlot, number>;
  /** 模型总 context window (tokens) */
  totalBudget: number;
  /** 实际可用输入 token 预算（= totalBudget - outputReserve - sessionOverhead） */
  inputBudget: number;
  /** 是否触发了预算压缩 */
  compressed: boolean;
  /** 压缩日志（人可读，用于调试） */
  compressionLog: string;
}

/**
 * 智能截断选项
 */
export interface TruncateOptions {
  /** 截断方向: head=保留开头, tail=保留结尾, both=首尾各保留 */
  direction?: "head" | "tail" | "both";
  /** both 模式下的头部占比 (0-1)，默认 0.7 */
  headRatio?: number;
  /** 内容类型（影响边界检测策略） */
  contentType?: "writing" | "coding" | "generic";
}

// ────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────

/** session 对话历史预留开销（tokens）— 保守估计 */
const SESSION_OVERHEAD_TOKENS = 500;

/** 默认 context window（当模型信息不可用时的保守回退值） */
const DEFAULT_CONTEXT_WINDOW = 32_000;

/** 默认 max output tokens */
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

/** 最低可用输入预算（低于此值直接放弃预算管理，走无截断路径） */
const MIN_USABLE_INPUT_BUDGET = 2_000;

// ────────────────────────────────────────────────────────────
// 核心实现
// ────────────────────────────────────────────────────────────

/**
 * 估算文本的 token 数
 *
 * 轻量级估算（不调用 tokenizer，零依赖）：
 * - CJK 字符（中日韩）：1 字符 ≈ 1.5 tokens（保守估计，实际约 1.2-1.8）
 * - 非 CJK 字符（英文/代码/标点）：1 token ≈ 4 字符
 * - 混合文本按比例加权
 *
 * 误差范围：±20%，对预算分配足够精确。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 统计 CJK 汉字数（基本区 + 扩展A；排除标点、全角拉丁等非汉字字符）
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const cjkCount = cjkChars ? cjkChars.length : 0;
  const nonCjkCount = text.length - cjkCount;
  // 中文 ~1.5 tokens/char, 英文 ~0.25 tokens/char
  return Math.ceil(cjkCount * 1.5 + nonCjkCount * 0.25);
}

/**
 * 按 token 预算智能截断文本
 *
 * 不是简单的 substring，而是找最近的完整边界：
 * - 写作类：段落边界（\n\n）> 句子边界（。！？.!?）> 行边界（\n）
 * - 编码类：行边界（\n）
 * - 通用：句子边界 > 行边界
 *
 * @param text 原始文本
 * @param tokenBudget 目标 token 数
 * @param options 截断选项
 * @returns 截断后的文本
 */
export function truncateToTokenBudget(
  text: string,
  tokenBudget: number,
  options?: TruncateOptions,
): string {
  if (!text) return "";
  const currentTokens = estimateTokens(text);
  if (currentTokens <= tokenBudget) return text;
  if (tokenBudget <= 0) return "";

  const direction = options?.direction ?? "head";
  const contentType = options?.contentType ?? "generic";

  // 粗略估算目标字符数（反向推算）
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const cjkCount = cjkChars ? cjkChars.length : 0;
  const cjkRatio = text.length > 0 ? cjkCount / text.length : 0;
  // 加权平均每个字符的 token 数
  const avgTokensPerChar = cjkRatio * 1.5 + (1 - cjkRatio) * 0.25;
  const targetChars = Math.floor(tokenBudget / Math.max(avgTokensPerChar, 0.1));

  if (direction === "head") {
    return _truncateHead(text, targetChars, contentType);
  } else if (direction === "tail") {
    return _truncateTail(text, targetChars, contentType);
  } else {
    // both: 首尾各保留
    const headRatio = options?.headRatio ?? 0.7;
    const headChars = Math.floor(targetChars * headRatio);
    const tailChars = targetChars - headChars;
    const headPart = _truncateHead(text, headChars, contentType);
    const tailPart = _truncateTail(text, tailChars, contentType);
    return headPart + "\n\n...[中段已省略，保留首尾关键内容]...\n\n" + tailPart;
  }
}

/**
 * 分配预算
 *
 * 算法：
 * 1. 计算 inputBudget = contextWindow - maxOutputTokens - sessionOverhead
 * 2. 不可压缩槽位（systemBase, outputReserve）直接分配实际消耗
 * 3. 可压缩槽位按"期望"分配
 * 4. 如果总和 > inputBudget，从优先级最低的开始压缩：
 *    a. 先压缩到 minimum
 *    b. 仍超预算则设为 0（完全丢弃）
 *    c. 继续向高优先级压缩
 * 5. 永远不压缩 priority=0 和 priority=1 的槽位
 */
export function allocateBudget(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
  requests: BudgetRequest[],
): BudgetAllocation {
  const effectiveContextWindow = contextWindow && contextWindow > 0
    ? contextWindow
    : DEFAULT_CONTEXT_WINDOW;
  const effectiveMaxOutput = maxOutputTokens && maxOutputTokens > 0
    ? maxOutputTokens
    : DEFAULT_MAX_OUTPUT_TOKENS;

  const inputBudget = effectiveContextWindow - effectiveMaxOutput - SESSION_OVERHEAD_TOKENS;

  // 初始化分配：全部按 desired
  const allocation: Record<BudgetSlot, number> = {
    systemBase: 0,
    blueprint: 0,
    chapterOutline: 0,
    siblingContext: 0,
    iterationContext: 0,
    userPrompt: 0,
    outputReserve: effectiveMaxOutput,
  };

  // 如果输入预算太小，放弃预算管理
  if (inputBudget < MIN_USABLE_INPUT_BUDGET) {
    for (const req of requests) {
      allocation[req.slot] = req.desired;
    }
    return {
      slots: allocation,
      totalBudget: effectiveContextWindow,
      inputBudget,
      compressed: false,
      compressionLog: `[ContextBudget] 输入预算过小 (${inputBudget} tokens < ${MIN_USABLE_INPUT_BUDGET})，跳过预算管理`,
    };
  }

  // 按 desired 分配
  let totalDesired = 0;
  for (const req of requests) {
    if (req.slot === "outputReserve") continue; // 已固定分配
    allocation[req.slot] = req.desired;
    totalDesired += req.desired;
  }

  // 不需要压缩
  if (totalDesired <= inputBudget) {
    return {
      slots: allocation,
      totalBudget: effectiveContextWindow,
      inputBudget,
      compressed: false,
      compressionLog: `[ContextBudget] 无需压缩: desired=${totalDesired} <= budget=${inputBudget}`,
    };
  }

  // ── 需要压缩 ──
  // 按优先级从低到高排序可压缩槽位（priority 越大越先被压缩）
  const compressible = requests
    .filter(r => r.priority >= 2 && r.slot !== "outputReserve")
    .sort((a, b) => b.priority - a.priority); // 低优先级（高 priority 数字）排前面

  let currentTotal = totalDesired;
  const logParts: string[] = [`[ContextBudget] 需要压缩: desired=${totalDesired}, budget=${inputBudget}, 需削减=${totalDesired - inputBudget}`];

  for (const req of compressible) {
    if (currentTotal <= inputBudget) break;

    const currentAlloc = allocation[req.slot];
    const excess = currentTotal - inputBudget;

    if (currentAlloc <= req.minimum) continue; // 已经是最小值

    // 尝试压缩到 minimum
    const canSave = currentAlloc - req.minimum;
    if (canSave >= excess) {
      // 只需部分压缩
      const newAlloc = currentAlloc - excess;
      logParts.push(`  ${req.slot}: ${currentAlloc} → ${newAlloc} (部分压缩, 节省 ${excess})`);
      allocation[req.slot] = newAlloc;
      currentTotal -= excess;
    } else {
      // 压缩到 minimum
      logParts.push(`  ${req.slot}: ${currentAlloc} → ${req.minimum} (压缩到最低, 节省 ${canSave})`);
      allocation[req.slot] = req.minimum;
      currentTotal -= canSave;

      // 如果 minimum > 0 仍不够，且 minimum 可为 0，则完全丢弃
      if (currentTotal > inputBudget && req.minimum === 0) {
        // 已经是 0 了，跳过
      } else if (currentTotal > inputBudget && req.minimum > 0) {
        // minimum > 0 但仍超预算，强制归零
        logParts.push(`  ${req.slot}: ${req.minimum} → 0 (强制丢弃, 节省 ${req.minimum})`);
        currentTotal -= req.minimum;
        allocation[req.slot] = 0;
      }
    }
  }

  if (currentTotal > inputBudget) {
    logParts.push(`  ⚠️ 压缩后仍超预算: ${currentTotal} > ${inputBudget}，不可压缩槽位过大`);
  }

  return {
    slots: allocation,
    totalBudget: effectiveContextWindow,
    inputBudget,
    compressed: true,
    compressionLog: logParts.join("\n"),
  };
}

/**
 * 便捷方法：根据分配结果截断内容
 *
 * 为每个有内容的槽位，按分配的 token 预算进行智能截断。
 */
export function truncateByAllocation(
  requests: BudgetRequest[],
  allocation: BudgetAllocation,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const req of requests) {
    if (!req.content) {
      result[req.slot] = "";
      continue;
    }

    const budget = allocation.slots[req.slot];
    if (budget <= 0) {
      result[req.slot] = "";
      continue;
    }

    const currentTokens = estimateTokens(req.content);
    if (currentTokens <= budget) {
      result[req.slot] = req.content;
      continue;
    }

    // 需要截断 — 根据槽位选择截断策略
    let truncateOpts: TruncateOptions;
    switch (req.slot) {
      case "blueprint":
        // 纲领：首尾各保留（世界观在开头，角色弧线在结尾）
        truncateOpts = { direction: "both", headRatio: 0.7, contentType: "writing" };
        break;
      case "chapterOutline":
        // 章节大纲：保留开头（核心情节在前面）
        truncateOpts = { direction: "head", contentType: "writing" };
        break;
      case "iterationContext":
        // 迭代上下文：保留结尾（最近的输出更重要）
        truncateOpts = { direction: "tail", contentType: "generic" };
        break;
      case "siblingContext":
        // 兄弟上下文：保留结尾（最近完成的兄弟更相关）
        truncateOpts = { direction: "tail", contentType: "generic" };
        break;
      case "userPrompt":
        // 用户 prompt：保留开头（强制指令在最前面）
        truncateOpts = { direction: "head", contentType: "generic" };
        break;
      default:
        truncateOpts = { direction: "head", contentType: "generic" };
    }

    result[req.slot] = truncateToTokenBudget(req.content, budget, truncateOpts);
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// 内部辅助函数
// ────────────────────────────────────────────────────────────

/**
 * 保留开头截断 — 找最近的完整边界
 */
function _truncateHead(text: string, targetChars: number, contentType: string): string {
  if (text.length <= targetChars) return text;
  const raw = text.substring(0, targetChars);
  const minCut = Math.floor(targetChars * 0.6); // 至少保留 60%

  let cutIdx = targetChars;

  if (contentType === "writing") {
    // 写作类：段落边界 > 句号 > 行边界
    const paraIdx = raw.lastIndexOf("\n\n");
    if (paraIdx > minCut) {
      cutIdx = paraIdx;
    } else {
      const sentIdx = Math.max(
        raw.lastIndexOf("。"),
        raw.lastIndexOf("！"),
        raw.lastIndexOf("？"),
        raw.lastIndexOf(". "),
      );
      if (sentIdx > minCut) cutIdx = sentIdx + 1;
    }
  } else if (contentType === "coding") {
    // 编码类：行边界
    const lineIdx = raw.lastIndexOf("\n");
    if (lineIdx > minCut) cutIdx = lineIdx;
  } else {
    // 通用：句子边界 > 行边界
    const sentIdx = Math.max(
      raw.lastIndexOf("。"),
      raw.lastIndexOf("！"),
      raw.lastIndexOf("？"),
      raw.lastIndexOf("\n"),
      raw.lastIndexOf(". "),
    );
    if (sentIdx > minCut) cutIdx = sentIdx + 1;
  }

  return raw.substring(0, cutIdx) + "\n...[已截断]";
}

/**
 * 保留结尾截断 — 找最近的完整边界
 */
function _truncateTail(text: string, targetChars: number, contentType: string): string {
  if (text.length <= targetChars) return text;
  const startPos = text.length - targetChars;
  const raw = text.substring(startPos);
  const maxShift = Math.floor(targetChars * 0.4); // 最多向后移 40%

  let shiftIdx = 0;

  if (contentType === "writing") {
    const paraIdx = raw.indexOf("\n\n");
    if (paraIdx >= 0 && paraIdx < maxShift) {
      shiftIdx = paraIdx + 2;
    } else {
      const sentCandidates = [raw.indexOf("。"), raw.indexOf("！"), raw.indexOf("？"), raw.indexOf(". ")]
        .filter(i => i >= 0);
      const sentIdx = sentCandidates.length > 0 ? Math.min(...sentCandidates) : -1;
      if (sentIdx >= 0 && sentIdx < maxShift) shiftIdx = sentIdx + 1;
    }
  } else if (contentType === "coding") {
    const lineIdx = raw.indexOf("\n");
    if (lineIdx >= 0 && lineIdx < maxShift) shiftIdx = lineIdx + 1;
  } else {
    const lineIdx = raw.indexOf("\n");
    if (lineIdx >= 0 && lineIdx < maxShift) shiftIdx = lineIdx + 1;
  }

  return "...[前文已截断]\n" + raw.substring(shiftIdx);
}
