/**
 * V8 P4: 产出一致性检查器 (Output Coherence Checker)
 *
 * 在轮次完成后（onRoundCompleted）运行，对所有子任务的产出做跨任务一致性扫描。
 *
 * 当前质检只检查单个子任务的质量（字数、完成度、文件产出），
 * 不检查跨子任务的一致性问题：
 * - 角色名不统一（"苏晨" vs "苏辰"）
 * - 情节不连贯（第3章结尾 vs 第4章开头矛盾）
 * - 风格漂移（视角突变、语气断裂）
 * - 术语不一致（同一概念多种叫法）
 *
 * 设计约束：
 * - 一致性检查是**报告性质**的，不自动触发 adjust/restart
 * - 结果写入交付报告，让用户决定是否修复
 * - 使用规则驱动（不调用 LLM），零额外 token 消耗
 */

import type { TaskTree, SubTask } from "./types.js";

// ────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────

/**
 * 一致性问题类型
 */
export type CoherenceIssueType =
  | "character_name"    // 角色名不统一
  | "plot_continuity"   // 情节不连贯
  | "style_drift"       // 风格漂移
  | "terminology"       // 术语不一致
  | "file_naming"       // 文件命名不统一
  | "language_mix";     // 语言混杂（中英混用）

/**
 * 一致性问题严重度
 */
export type CoherenceSeverity = "critical" | "warning" | "info";

/**
 * 单条一致性问题
 */
export interface CoherenceIssue {
  type: CoherenceIssueType;
  severity: CoherenceSeverity;
  description: string;
  /** 涉及的子任务 ID */
  affectedSubTaskIds: string[];
}

/**
 * 一致性检查结果
 */
export interface CoherenceCheckResult {
  /** 总体一致性评分 (0-100) */
  score: number;
  /** 发现的问题列表 */
  issues: CoherenceIssue[];
  /** 检查耗时 (ms) */
  durationMs: number;
  /** 检查的子任务数 */
  checkedTaskCount: number;
}

// ────────────────────────────────────────────────────────────
// 规则驱动的一致性检查
// ────────────────────────────────────────────────────────────

/**
 * 运行一致性检查（规则驱动，零 LLM 调用）
 *
 * 检查项：
 * 1. 文件命名一致性
 * 2. 语言一致性（检测中英混杂）
 * 3. 产出完整性（所有任务都有文件产出）
 */
export function checkCoherence(
  taskTree: TaskTree,
  roundId?: string,
): CoherenceCheckResult {
  const startTime = Date.now();
  const issues: CoherenceIssue[] = [];

  // 过滤目标子任务
  const tasks = roundId
    ? taskTree.subTasks.filter((t) => t.rootTaskId === roundId && t.status === "completed")
    : taskTree.subTasks.filter((t) => t.status === "completed");

  if (tasks.length === 0) {
    return { score: 100, issues: [], durationMs: Date.now() - startTime, checkedTaskCount: 0 };
  }

  // ── 检查 1: 文件命名一致性 ──
  checkFileNamingConsistency(tasks, issues);

  // ── 检查 2: 产出完整性 ──
  checkOutputCompleteness(tasks, issues);

  // ── 检查 3: 语言一致性 ──
  checkLanguageConsistency(tasks, issues);

  // 计算总分（每个 critical 扣 15 分，warning 扣 5 分，info 扣 1 分）
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === "critical") score -= 15;
    else if (issue.severity === "warning") score -= 5;
    else score -= 1;
  }
  score = Math.max(0, score);

  return {
    score,
    issues,
    durationMs: Date.now() - startTime,
    checkedTaskCount: tasks.length,
  };
}

/**
 * 格式化一致性检查结果为人可读文本（可注入交付报告）
 */
export function formatCoherenceReport(result: CoherenceCheckResult): string {
  if (result.issues.length === 0) {
    return `✅ 一致性检查通过 (${result.checkedTaskCount} 个子任务, 评分 ${result.score}/100)`;
  }

  const lines: string[] = [
    `📋 一致性检查 (${result.checkedTaskCount} 个子任务, 评分 ${result.score}/100)`,
  ];

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  const info = result.issues.filter((i) => i.severity === "info");

  if (critical.length > 0) {
    lines.push(`\n🔴 严重问题 (${critical.length}):`);
    for (const issue of critical) {
      lines.push(`  - ${issue.description}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`\n🟡 警告 (${warnings.length}):`);
    for (const issue of warnings) {
      lines.push(`  - ${issue.description}`);
    }
  }
  if (info.length > 0) {
    lines.push(`\n🔵 提示 (${info.length}):`);
    for (const issue of info) {
      lines.push(`  - ${issue.description}`);
    }
  }

  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// 内部检查函数
// ────────────────────────────────────────────────────────────

/**
 * 检查文件命名一致性
 *
 * 检测：
 * - 同一轮次内的文件命名风格是否统一（全中文 vs 中英混杂）
 * - 章节编号格式是否统一（第01章 vs 第1章 vs Chapter1）
 */
function checkFileNamingConsistency(tasks: SubTask[], issues: CoherenceIssue[]): void {
  const fileNames: Array<{ taskId: string; name: string }> = [];

  for (const t of tasks) {
    const paths = t.metadata?.producedFilePaths ?? [];
    for (const p of paths) {
      const name = p.split(/[/\\]/).pop() ?? p;
      fileNames.push({ taskId: t.id, name });
    }
  }

  if (fileNames.length < 2) return;

  // 检测中英文混杂命名
  const hasChinese = fileNames.filter((f) => /[\u4e00-\u9fff]/.test(f.name));
  const hasEnglishOnly = fileNames.filter((f) => !/[\u4e00-\u9fff]/.test(f.name) && /[a-zA-Z]/.test(f.name));

  if (hasChinese.length > 0 && hasEnglishOnly.length > 0) {
    issues.push({
      type: "file_naming",
      severity: "warning",
      description: `文件命名风格不统一：${hasChinese.length} 个中文命名, ${hasEnglishOnly.length} 个英文命名`,
      affectedSubTaskIds: hasEnglishOnly.map((f) => f.taskId),
    });
  }

  // 检测章节编号格式不统一
  const chapterFormats = new Set<string>();
  for (const f of fileNames) {
    if (/第\d+章/.test(f.name)) chapterFormats.add("第N章");
    if (/第0\d章/.test(f.name)) chapterFormats.add("第0N章");
    if (/chapter\s*\d+/i.test(f.name)) chapterFormats.add("ChapterN");
    if (/ch\d+/i.test(f.name)) chapterFormats.add("ChN");
  }
  if (chapterFormats.size > 1) {
    issues.push({
      type: "file_naming",
      severity: "info",
      description: `章节编号格式不统一：检测到 ${[...chapterFormats].join(", ")} 多种格式`,
      affectedSubTaskIds: fileNames.map((f) => f.taskId),
    });
  }
}

/**
 * 检查产出完整性
 *
 * 检测：
 * - 已完成的任务是否有实际文件产出
 * - 产出文件是否过短（可能是 LLM 确认消息而非实际内容）
 */
function checkOutputCompleteness(tasks: SubTask[], issues: CoherenceIssue[]): void {
  const noOutputTasks: string[] = [];
  const shortOutputTasks: string[] = [];

  for (const t of tasks) {
    const hasPaths = t.metadata?.producedFilePaths && t.metadata.producedFilePaths.length > 0;
    const hasFallback = t.metadata?.fallbackFilePath;

    if (!hasPaths && !hasFallback) {
      // 只有 output（可能是确认消息），没有实际文件
      if (!t.output || t.output.length < 200) {
        noOutputTasks.push(t.id);
      }
    }

    // 检查 output 是否过短
    if (t.output && t.output.length > 0 && t.output.length < 100 && !hasPaths) {
      shortOutputTasks.push(t.id);
    }
  }

  if (noOutputTasks.length > 0) {
    issues.push({
      type: "plot_continuity",
      severity: "critical",
      description: `${noOutputTasks.length} 个已完成子任务无实际文件产出（可能只有确认消息）`,
      affectedSubTaskIds: noOutputTasks,
    });
  }

  if (shortOutputTasks.length > 0) {
    issues.push({
      type: "plot_continuity",
      severity: "warning",
      description: `${shortOutputTasks.length} 个子任务输出过短（<100字），可能内容不完整`,
      affectedSubTaskIds: shortOutputTasks,
    });
  }
}

/**
 * 检查语言一致性
 *
 * 检测：
 * - 同一轮次内的任务输出是否语言一致（全中文 or 全英文）
 * - 是否有 LLM 突然输出英文内容的情况
 */
function checkLanguageConsistency(tasks: SubTask[], issues: CoherenceIssue[]): void {
  const langStats: Array<{ taskId: string; zhRatio: number }> = [];

  for (const t of tasks) {
    // 优先使用 output，但要求 >= 500 字以排除 LLM 确认消息（通常 <300 字）
    const text = t.output ?? "";
    if (text.length < 500) continue;
    const sample = text.substring(0, 500);
    const zhChars = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    const zhRatio = zhChars / sample.length;
    langStats.push({ taskId: t.id, zhRatio });
  }

  if (langStats.length < 2) return;

  // 判断主要语言（取中位数）
  const ratios = langStats.map((s) => s.zhRatio).sort((a, b) => a - b);
  const medianRatio = ratios[Math.floor(ratios.length / 2)];
  const isMostlyChinese = medianRatio > 0.3;

  if (isMostlyChinese) {
    // 检测突然变成英文的子任务
    const englishTasks = langStats.filter((s) => s.zhRatio < 0.1);
    if (englishTasks.length > 0) {
      issues.push({
        type: "language_mix",
        severity: "warning",
        description: `${englishTasks.length} 个子任务输出为英文，但其余子任务为中文（可能是 LLM 语言偏差）`,
        affectedSubTaskIds: englishTasks.map((s) => s.taskId),
      });
    }
  }
}
