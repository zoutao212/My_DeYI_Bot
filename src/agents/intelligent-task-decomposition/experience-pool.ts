/**
 * V8 P3: 跨任务经验池 (Experience Pool)
 *
 * 持久化记录系统在任务执行中学到的经验教训，
 * 使其能够跨 session / 跨任务 复用，实现 L4 自我优化。
 *
 * 持久化目录: ~/.clawdbot/experience/
 * 文件: experience-pool.json（单文件，预计 <100KB）
 *
 * 触发时机：
 * - S2 文件名校验+自动重命名 → record("naming", ...)
 * - 质检 restart → record("quality", ...)
 * - 429 限流 → record("provider", ...)
 * - 轮次完成 → record("execution", ...)
 * - decomposeSubTask 前 → query + generateExperienceSummary → 注入 prompt
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { TaskType } from "./types.js";

// ────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────

/**
 * 经验类别
 */
export type ExperienceCategory =
  | "naming"         // 文件命名相关（LLM 输出了错误的文件名/语言）
  | "decomposition"  // 分解策略相关（分段数不合理、粒度不当）
  | "execution"      // 执行相关（最优分段数、timeout 调整）
  | "quality"        // 质量相关（字数不达标、内容跑题）
  | "provider"       // Provider 相关（429 限流、模型降级）
  | "merge";         // 合并相关（确认消息误合并、排序错误）

/**
 * 经验记录
 */
export interface ExperienceRecord {
  /** 唯一 ID */
  id: string;
  /** 任务类型（可选，None 表示通用经验） */
  taskType?: TaskType;
  /** 经验类别 */
  category: ExperienceCategory;
  /** 模式描述（机器可读的短标识，如 "wrong_filename_language"） */
  pattern: string;
  /** 教训描述（人可读，可注入到 prompt 中） */
  lesson: string;
  /** 建议的改进措施 */
  suggestion: string;
  /** 出现频率（同类问题出现次数） */
  frequency: number;
  /** 置信度 (0-100)，frequency 越高 confidence 越高 */
  confidence: number;
  /** 首次记录时间 */
  firstSeen: number;
  /** 最近一次记录时间 */
  lastSeen: number;
  /** 关联的 provider/model（可选） */
  providerHint?: string;
}

/**
 * 经验池持久化结构
 */
interface ExperiencePoolData {
  version: number;
  updatedAt: number;
  records: ExperienceRecord[];
}

// ────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────

const EXPERIENCE_DIR = path.join(os.homedir(), ".clawdbot", "experience");
const EXPERIENCE_FILE = path.join(EXPERIENCE_DIR, "experience-pool.json");

/** 单个经验的最大置信度 */
const MAX_CONFIDENCE = 95;

/** 最大记录数（防止无限增长） */
const MAX_RECORDS = 500;

/** 写入锁：串行化 read-modify-write，防止并行 recordExperience 互相覆盖 */
let _writeLock: Promise<void> = Promise.resolve();

// ────────────────────────────────────────────────────────────
// 核心实现
// ────────────────────────────────────────────────────────────

/**
 * 加载经验池
 */
async function loadPool(): Promise<ExperiencePoolData> {
  try {
    const raw = await fs.readFile(EXPERIENCE_FILE, "utf-8");
    return JSON.parse(raw) as ExperiencePoolData;
  } catch {
    return { version: 1, updatedAt: Date.now(), records: [] };
  }
}

/**
 * 保存经验池（原子写入）
 */
async function savePool(data: ExperiencePoolData): Promise<void> {
  await fs.mkdir(EXPERIENCE_DIR, { recursive: true });
  data.updatedAt = Date.now();
  const tmpFile = EXPERIENCE_FILE + ".tmp";
  await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpFile, EXPERIENCE_FILE);
}

/**
 * 记录一条经验
 *
 * 如果已有同 pattern + category 的记录，frequency+1 并更新 lastSeen 和 confidence。
 * 否则创建新记录。
 */
export async function recordExperience(params: {
  category: ExperienceCategory;
  pattern: string;
  lesson: string;
  suggestion: string;
  taskType?: TaskType;
  providerHint?: string;
}): Promise<void> {
  // 串行化写入：等待前一个写入完成后再执行当前写入（防止并行 read-modify-write 竞态）
  const prev = _writeLock;
  let resolve!: () => void;
  _writeLock = new Promise<void>((r) => { resolve = r; });
  await prev;

  try {
    const pool = await loadPool();

    // 查找是否已有同类记录
    const existing = pool.records.find(
      (r) => r.pattern === params.pattern && r.category === params.category,
    );

    if (existing) {
      existing.frequency++;
      existing.lastSeen = Date.now();
      // 置信度随频率递增：50 + min(45, frequency * 5)
      existing.confidence = Math.min(MAX_CONFIDENCE, 50 + existing.frequency * 5);
      // 更新 lesson/suggestion（可能随时间改善）
      if (params.lesson) existing.lesson = params.lesson;
      if (params.suggestion) existing.suggestion = params.suggestion;
      if (params.providerHint) existing.providerHint = params.providerHint;
      console.log(`[experience-pool] 📝 更新经验: ${params.category}/${params.pattern} (frequency=${existing.frequency}, confidence=${existing.confidence})`);
    } else {
      const record: ExperienceRecord = {
        id: crypto.randomUUID(),
        category: params.category,
        pattern: params.pattern,
        lesson: params.lesson,
        suggestion: params.suggestion,
        taskType: params.taskType,
        providerHint: params.providerHint,
        frequency: 1,
        confidence: 55, // 首次记录的基础置信度
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      };
      pool.records.push(record);
      console.log(`[experience-pool] 🆕 新增经验: ${params.category}/${params.pattern}`);
    }

    // 超过上限时淘汰最旧的低置信度记录
    if (pool.records.length > MAX_RECORDS) {
      pool.records.sort((a, b) => b.confidence * b.frequency - a.confidence * a.frequency);
      pool.records = pool.records.slice(0, MAX_RECORDS);
    }

    await savePool(pool);
  } catch (err) {
    console.warn(`[experience-pool] ⚠️ 记录经验失败: ${err}`);
  } finally {
    resolve();
  }
}

/**
 * 查询相关经验
 *
 * 按 category + taskType 过滤，按 confidence * frequency 排序。
 */
export async function queryExperience(filters?: {
  taskType?: TaskType;
  category?: ExperienceCategory;
  providerHint?: string;
  minConfidence?: number;
}): Promise<ExperienceRecord[]> {
  try {
    const pool = await loadPool();
    let results = pool.records;

    if (filters?.category) {
      results = results.filter((r) => r.category === filters.category);
    }
    if (filters?.taskType) {
      results = results.filter((r) => !r.taskType || r.taskType === filters.taskType);
    }
    if (filters?.providerHint) {
      results = results.filter((r) => !r.providerHint || r.providerHint === filters.providerHint);
    }
    if (filters?.minConfidence) {
      results = results.filter((r) => r.confidence >= filters.minConfidence!);
    }

    // 按 confidence * log(frequency+1) 排序
    results.sort((a, b) => {
      const scoreA = a.confidence * Math.log2(a.frequency + 1);
      const scoreB = b.confidence * Math.log2(b.frequency + 1);
      return scoreB - scoreA;
    });

    return results;
  } catch (err) {
    console.warn(`[experience-pool] ⚠️ 查询经验失败: ${err}`);
    return [];
  }
}

/**
 * 生成经验摘要（可直接注入到分解/执行 prompt 中）
 *
 * 格式示例：
 * [历史经验提醒]
 * 1. 续写任务必须指定中文文件名（出现3次，置信度85%）
 * 2. 分段数建议不超过每章4段（出现2次，置信度70%）
 *
 * @param taskType 当前任务类型（过滤相关经验）
 * @param maxItems 最多展示几条经验（默认 5）
 * @returns 经验摘要文本（空字符串表示无可用经验）
 */
export async function generateExperienceSummary(
  taskType?: TaskType,
  maxItems: number = 5,
): Promise<string> {
  const records = await queryExperience({
    taskType,
    minConfidence: 60, // 只注入中高置信度的经验
  });

  if (records.length === 0) return "";

  const items = records.slice(0, maxItems).map((r, i) => {
    const freq = r.frequency > 1 ? `，出现${r.frequency}次` : "";
    return `${i + 1}. ${r.lesson}（置信度${r.confidence}%${freq}）`;
  });

  return `[历史经验提醒]\n${items.join("\n")}`;
}
