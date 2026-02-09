/**
 * 智能上下文剪枝模块
 *
 * 解决的核心问题：长对话中旧任务上下文污染当前任务。
 * 例如：session 中有"九天星辰录"15章创作历史，用户新发"白燕妮"任务时，
 * LLM 被旧上下文误导，生成与当前任务无关的子任务。
 *
 * 策略：
 * 1. 规则检测：识别 enqueue_task(isNewRootTask=true) 标记的任务边界
 * 2. 段落压缩：将旧任务段落压缩为 1-2 行摘要，释放上下文空间
 * 3. LLM 增强（可选）：对模糊边界用 LLM 判定相关性
 *
 * 集成点：attempt.ts 中 sanitizeSessionHistory → pruneIrrelevantContext → limitHistoryTurns
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ── 类型定义 ──

/** 任务段落：一组连续的、属于同一任务的消息 */
interface TaskSegment {
  /** 段落起始索引（在原始 messages 数组中） */
  startIndex: number;
  /** 段落结束索引（不含） */
  endIndex: number;
  /** 任务目标（从 user message 或 enqueue_task summary 提取） */
  taskGoal: string;
  /** 该段落的 rootTaskId（如果检测到） */
  rootTaskId?: string;
  /** 是否为当前活跃任务 */
  isCurrent: boolean;
  /** 消息数量 */
  messageCount: number;
  /** 估算 token 数（粗略） */
  estimatedTokens: number;
}

/** 剪枝结果 */
export interface ContextPruningResult {
  /** 剪枝后的消息数组 */
  messages: AgentMessage[];
  /** 被压缩的段落数 */
  prunedSegments: number;
  /** 节省的消息数 */
  savedMessages: number;
  /** 节省的估算 token 数 */
  savedTokens: number;
}

/** 剪枝选项 */
export interface ContextPruningOptions {
  /** 触发剪枝的最小消息数（默认 20） */
  minMessagesThreshold?: number;
  /** 保留最近 N 个任务段落的完整内容（默认 1，即只保留当前任务） */
  keepRecentSegments?: number;
  /** LLM 相关性评分器（可选，用于模糊边界判定） */
  llmRelevanceScorer?: (
    currentGoal: string,
    segmentGoal: string,
    sampleContent: string,
  ) => Promise<number>;
  /** 是否为队列任务（followup-runner 执行的子任务） */
  isQueueTask?: boolean;
}

// ── 核心函数 ──

/**
 * 智能上下文剪枝：识别任务边界，压缩旧任务段落
 *
 * @param messages 原始消息数组（已通过 sanitizeSessionHistory）
 * @param options 剪枝选项
 * @returns 剪枝结果
 */
export function pruneIrrelevantContext(
  messages: AgentMessage[],
  options?: ContextPruningOptions,
): ContextPruningResult {
  const threshold = options?.minMessagesThreshold ?? 20;
  const keepRecent = options?.keepRecentSegments ?? 1;

  // 消息数太少，不需要剪枝
  if (messages.length < threshold) {
    return {
      messages,
      prunedSegments: 0,
      savedMessages: 0,
      savedTokens: 0,
    };
  }

  // Step 1: 检测任务边界，切分为段落
  const segments = detectTaskSegments(messages);

  // 只有一个段落（或没有明确边界），不剪枝
  if (segments.length <= keepRecent) {
    return {
      messages,
      prunedSegments: 0,
      savedMessages: 0,
      savedTokens: 0,
    };
  }

  // Step 2: 标记当前任务（最后 keepRecent 个段落）
  for (let i = 0; i < segments.length; i++) {
    segments[i].isCurrent = i >= segments.length - keepRecent;
  }

  // Step 3: 构建剪枝后的消息数组
  const pruned: AgentMessage[] = [];
  let savedMessages = 0;
  let savedTokens = 0;
  let prunedSegments = 0;

  for (const segment of segments) {
    if (segment.isCurrent) {
      // 当前任务段落：完整保留
      pruned.push(...messages.slice(segment.startIndex, segment.endIndex));
    } else {
      // 旧任务段落：压缩为摘要
      const summary = compressSegmentToSummary(segment, messages);
      pruned.push(...summary);
      savedMessages += segment.messageCount - summary.length;
      savedTokens += segment.estimatedTokens - estimateTokensForMessages(summary);
      prunedSegments++;
    }
  }

  console.log(
    `[context-pruning] ✂️ 剪枝完成: ${segments.length} 段落, ` +
    `压缩 ${prunedSegments} 个旧任务段落, ` +
    `${messages.length} → ${pruned.length} 条消息, ` +
    `节省 ~${savedTokens} tokens`,
  );

  return {
    messages: pruned,
    prunedSegments,
    savedMessages,
    savedTokens,
  };
}

// ── 任务边界检测 ──

/**
 * 检测消息历史中的任务边界，将消息切分为任务段落
 *
 * 边界检测规则（优先级从高到低）：
 * 1. enqueue_task(isNewRootTask=true) 的 tool call → 新任务开始
 * 2. 用户消息中包含 [任务目标] 标记 → 被 limitHistoryTurns 插入的任务边界
 * 3. 大量 enqueue_task 调用后跟新的用户消息 → 任务切换
 */
function detectTaskSegments(messages: AgentMessage[]): TaskSegment[] {
  const boundaries: number[] = [0]; // 第一个段落从 0 开始

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // 规则 1: 检测 enqueue_task(isNewRootTask=true) tool call
    if (msg.role === "assistant" && hasNewRootTaskCall(msg)) {
      // 边界是包含 tool call 的 assistant 消息所在位置
      // 但实际边界应该是之前的 user 消息
      const userBefore = findPrecedingUserMessage(messages, i);
      if (userBefore >= 0 && !boundaries.includes(userBefore)) {
        boundaries.push(userBefore);
      }
    }

    // 规则 2: 用户消息包含 [任务目标] 标记
    if (msg.role === "user" && hasTaskGoalMarker(msg)) {
      if (!boundaries.includes(i)) {
        boundaries.push(i);
      }
    }

    // 规则 3: 用户消息出现在大量 enqueue_task 调用之后（任务切换信号）
    if (msg.role === "user" && i > 0) {
      const prevEnqueueCount = countRecentEnqueueCalls(messages, i);
      if (prevEnqueueCount >= 3 && !boundaries.includes(i)) {
        boundaries.push(i);
      }
    }
  }

  // 排序去重
  boundaries.sort((a, b) => a - b);

  // 构建段落
  const segments: TaskSegment[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i < boundaries.length - 1 ? boundaries[i + 1] : messages.length;
    const segmentMessages = messages.slice(start, end);

    segments.push({
      startIndex: start,
      endIndex: end,
      taskGoal: extractTaskGoalFromSegment(segmentMessages),
      rootTaskId: extractRootTaskIdFromSegment(segmentMessages),
      isCurrent: false,
      messageCount: end - start,
      estimatedTokens: estimateTokensForMessages(segmentMessages),
    });
  }

  return segments;
}

// ── 辅助函数 ──

/** 检测 assistant 消息是否包含 enqueue_task(isNewRootTask=true) 调用 */
function hasNewRootTaskCall(msg: AgentMessage): boolean {
  if (!("content" in msg) || !Array.isArray(msg.content)) return false;

  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    const item = block as unknown as Record<string, unknown>;

    if (
      (item.type === "toolCall" || item.type === "toolUse" || item.type === "functionCall") &&
      item.name === "enqueue_task"
    ) {
      const args = item.arguments as Record<string, unknown> | undefined;
      if (args?.isNewRootTask === true) return true;
    }
  }
  return false;
}

/** 检测用户消息是否包含 [任务目标] 标记 */
function hasTaskGoalMarker(msg: AgentMessage): boolean {
  const text = extractText(msg);
  return text.includes("[任务目标") || text.includes("任务目标 -");
}

/** 查找索引 i 之前最近的 user 消息索引 */
function findPrecedingUserMessage(messages: AgentMessage[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (messages[j].role === "user") return j;
  }
  return -1;
}

/** 统计索引 i 之前连续的 enqueue_task 相关消息数量 */
function countRecentEnqueueCalls(messages: AgentMessage[], i: number): number {
  let count = 0;
  for (let j = i - 1; j >= 0; j--) {
    const msg = messages[j];
    const text = extractText(msg);
    if (text.includes("enqueue_task") || text.includes("已加入任务")) {
      count++;
    } else if (msg.role === "user") {
      break; // 遇到上一个 user 消息就停止
    }
  }
  return count;
}

/** 从段落中提取任务目标 */
function extractTaskGoalFromSegment(segmentMessages: AgentMessage[]): string {
  // 优先从第一条 user 消息提取
  for (const msg of segmentMessages) {
    if (msg.role === "user") {
      const text = extractText(msg);
      // 去掉 [任务目标] 前缀
      const cleaned = text.replace(/\[任务目标[^\]]*\]\s*/g, "").trim();
      if (cleaned.length > 0) {
        return cleaned.length > 100 ? cleaned.substring(0, 100) + "..." : cleaned;
      }
    }
  }

  // 兜底：从 enqueue_task 的 summary 提取
  for (const msg of segmentMessages) {
    if (msg.role === "assistant") {
      const text = extractText(msg);
      const match = text.match(/\[已加入任务:\s*([^\]]+)\]/);
      if (match) return match[1];
    }
  }

  return "未知任务";
}

/** 从段落中提取 rootTaskId */
function extractRootTaskIdFromSegment(segmentMessages: AgentMessage[]): string | undefined {
  for (const msg of segmentMessages) {
    if (msg.role === "assistant" && "content" in msg && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const item = block as unknown as Record<string, unknown>;
        if (
          (item.type === "toolCall" || item.type === "toolUse") &&
          item.name === "enqueue_task"
        ) {
          const args = item.arguments as Record<string, unknown> | undefined;
          if (args?.rootTaskId && typeof args.rootTaskId === "string") {
            return args.rootTaskId;
          }
        }
      }
    }

    // 也从压缩后的文本中提取
    const text = extractText(msg);
    const match = text.match(/rootTaskId[=:]\s*([a-f0-9-]{36})/i);
    if (match) return match[1];
  }
  return undefined;
}

/** 将旧任务段落压缩为 1-2 条摘要消息 */
function compressSegmentToSummary(
  segment: TaskSegment,
  messages: AgentMessage[],
): AgentMessage[] {
  const segmentMessages = messages.slice(segment.startIndex, segment.endIndex);

  // 统计关键信息
  const taskCount = countToolCalls(segmentMessages, "enqueue_task");
  const writeCount = countToolCalls(segmentMessages, "write");
  const execCount = countToolCalls(segmentMessages, "exec");
  const userTurns = segmentMessages.filter((m) => m.role === "user").length;

  // 提取最后一条 assistant 文本摘要（如果有）
  let lastAssistantText = "";
  for (let i = segmentMessages.length - 1; i >= 0; i--) {
    if (segmentMessages[i].role === "assistant") {
      const text = extractText(segmentMessages[i]);
      if (text.length > 20) {
        lastAssistantText = text.length > 150 ? text.substring(0, 150) + "..." : text;
        break;
      }
    }
  }

  // 构建压缩摘要
  const stats: string[] = [];
  if (taskCount > 0) stats.push(`${taskCount} 个子任务`);
  if (writeCount > 0) stats.push(`${writeCount} 次文件写入`);
  if (execCount > 0) stats.push(`${execCount} 次命令执行`);
  if (userTurns > 0) stats.push(`${userTurns} 轮对话`);

  const statsText = stats.length > 0 ? `（${stats.join(", ")}）` : "";

  // 使用原始第一条消息的 timestamp
  const firstTimestamp = segmentMessages[0]?.timestamp ?? Date.now();
  const lastTimestamp = segmentMessages[segmentMessages.length - 1]?.timestamp ?? Date.now();

  const summaryMessages: AgentMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `[历史任务 - 已压缩] ${segment.taskGoal}`,
        },
      ],
      timestamp: firstTimestamp,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[历史任务已完成] ${segment.taskGoal}${statsText}${lastAssistantText ? `\n最终状态: ${lastAssistantText}` : ""}`,
        },
      ],
      api: "context-pruning" as never,
      provider: "system" as never,
      model: "context-pruning" as never,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as never,
      timestamp: lastTimestamp,
    },
  ];

  return summaryMessages;
}

/** 统计段落中特定工具的调用次数 */
function countToolCalls(messages: AgentMessage[], toolName: string): number {
  let count = 0;
  for (const msg of messages) {
    const text = extractText(msg);
    if (msg.role === "assistant") {
      // 从压缩的文本格式中匹配
      if (toolName === "enqueue_task") {
        const matches = text.match(/\[已加入任务:/g);
        if (matches) count += matches.length;
      } else if (toolName === "write") {
        const matches = text.match(/\[已写入文件:/g);
        if (matches) count += matches.length;
      } else if (toolName === "exec") {
        const matches = text.match(/\[执行命令:/g);
        if (matches) count += matches.length;
      }
      // 从原始 tool call 格式中匹配
      if ("content" in msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object") {
            const item = block as unknown as Record<string, unknown>;
            if (
              (item.type === "toolCall" || item.type === "toolUse") &&
              item.name === toolName
            ) {
              count++;
            }
          }
        }
      }
    }
  }
  return count;
}

/** 从消息中提取文本内容 */
function extractText(msg: AgentMessage): string {
  if (!("content" in msg)) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item): item is { type: "text"; text: string } =>
        item != null && typeof item === "object" && item.type === "text" && typeof item.text === "string",
      )
      .map((item) => item.text)
      .join("\n");
  }
  return "";
}

/** 粗略估算消息数组的 token 数（1 token ≈ 3-4 字符） */
function estimateTokensForMessages(messages: AgentMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += extractText(msg).length;
  }
  return Math.ceil(chars / 3.5);
}

// ── LLM 增强剪枝（可选） ──

/**
 * 使用 LLM 评估旧任务段落与当前任务的相关性
 *
 * 只在上下文较大（>40 条消息）且有多个段落时触发，
 * 避免每次都调用 LLM 增加延迟。
 *
 * @returns 0-1 的相关性分数，>0.5 表示相关应保留
 */
export async function llmRelevanceScore(
  currentGoal: string,
  segmentGoal: string,
  sampleContent: string,
  llmCaller: {
    call: (prompt: string) => Promise<string>;
  },
): Promise<number> {
  const prompt = `你是一个上下文相关性评估器。请判断以下历史任务与当前任务的相关性。

当前任务目标：${currentGoal}

历史任务目标：${segmentGoal}
历史任务内容摘要：${sampleContent.substring(0, 500)}

请只输出一个 0-1 之间的数字（保留 2 位小数）：
- 0.0 = 完全无关
- 0.3 = 略有关联
- 0.7 = 较为相关
- 1.0 = 高度相关

输出格式：仅输出数字，不要任何其他文字。`;

  try {
    const response = await llmCaller.call(prompt);
    const score = parseFloat(response.trim());
    if (isNaN(score) || score < 0 || score > 1) return 0.5;
    return score;
  } catch {
    return 0.5; // LLM 调用失败，默认保留
  }
}

/**
 * 带 LLM 增强的智能上下文剪枝
 *
 * 在规则检测的基础上，对"可能相关"的旧任务段落用 LLM 二次判定。
 * 高相关段落保留完整内容，低相关段落压缩为摘要。
 */
export async function pruneWithLLMEnhancement(
  messages: AgentMessage[],
  options: ContextPruningOptions & {
    llmRelevanceScorer: NonNullable<ContextPruningOptions["llmRelevanceScorer"]>;
  },
): Promise<ContextPruningResult> {
  // 先做规则剪枝
  const ruleResult = pruneIrrelevantContext(messages, {
    ...options,
    // 暂时保留所有段落，只做切分
    keepRecentSegments: 999,
  });

  const segments = detectTaskSegments(messages);
  if (segments.length <= 1) return ruleResult;

  const currentSegment = segments[segments.length - 1];
  const currentGoal = currentSegment.taskGoal;

  // 对非当前段落做 LLM 相关性评分
  const scoredSegments: Array<{ segment: TaskSegment; score: number }> = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const sampleContent = extractText(messages[seg.startIndex]);
    const score = await options.llmRelevanceScorer(currentGoal, seg.taskGoal, sampleContent);
    scoredSegments.push({ segment: seg, score });
    console.log(`[context-pruning] 🤖 LLM 相关性评分: "${seg.taskGoal}" → ${score.toFixed(2)}`);
  }

  // 重新构建消息：高相关保留，低相关压缩
  const pruned: AgentMessage[] = [];
  let savedMessages = 0;
  let savedTokens = 0;
  let prunedSegments = 0;

  for (const { segment, score } of scoredSegments) {
    if (score >= 0.5) {
      // 相关段落：完整保留
      pruned.push(...messages.slice(segment.startIndex, segment.endIndex));
    } else {
      // 无关段落：压缩
      const summary = compressSegmentToSummary(segment, messages);
      pruned.push(...summary);
      savedMessages += segment.messageCount - summary.length;
      savedTokens += segment.estimatedTokens - estimateTokensForMessages(summary);
      prunedSegments++;
    }
  }

  // 当前段落完整保留
  pruned.push(...messages.slice(currentSegment.startIndex, currentSegment.endIndex));

  console.log(
    `[context-pruning] 🤖 LLM 增强剪枝完成: ${prunedSegments}/${segments.length - 1} 个旧段落被压缩, ` +
    `${messages.length} → ${pruned.length} 条消息`,
  );

  return {
    messages: pruned,
    prunedSegments,
    savedMessages,
    savedTokens,
  };
}
