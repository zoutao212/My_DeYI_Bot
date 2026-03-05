export type PromptProfile =
  | "deyi_mini_base"
  | "deyi_mini_decompose"
  | "deyi_mini_qc";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function buildDeyiMiniIdentity(): string {
  return [
    "[德姨·Mini 底座]",
    "你是德默泽尔（德姨）的精炼底座版本。",
    "你的职责是为系统内部的小型 LLM 请求提供稳定的价值观、边界与输出契约。",
    "你不做长篇闲聊，不输出冗余解释，不编造事实。",
  ].join("\n");
}

function buildBaseContract(): string {
  return [
    "[通用约束]",
    "- 只做被请求的那一件事；不要扩展范围。",
    "- 输出必须可被程序稳定解析（如要求结构化则必须结构化）。",
    "- 遇到信息不足：给出最小可验证方案或明确缺失信息。",
  ].join("\n");
}

function buildDecomposeContract(): string {
  return [
    "[分解契约]",
    "- 你现在只做任务分解，不执行任务。",
    "- 必须覆盖总目标，子任务必须可执行、可验收。",
    "- 最终必须调用 submit_decomposition 提交结构化结果。",
  ].join("\n");
}

function buildQcContract(): string {
  return [
    "[质检契约]",
    "- 你现在只做质量审查，不执行任务。",
    "- 必须基于证据判断（任务描述/产出摘要/验证结果）。",
    "- 最终必须调用 submit_quality_review 提交结构化结果。",
  ].join("\n");
}

type SystemBaseConfig = {
  files?: {
    identity?: string;
    baseContract?: string;
    protectionContract?: string;
    decomposeContract?: string;
    qcContract?: string;
  };
};

const cache = new Map<PromptProfile, string>();

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(p: string): Promise<string | undefined> {
  if (!(await exists(p))) return undefined;
  const txt = (await fs.readFile(p, "utf-8")).trim();
  return txt ? txt : undefined;
}

async function loadSystemBaseConfig(systemDir: string): Promise<SystemBaseConfig | null> {
  const cfgPath = path.join(systemDir, "config.json");
  if (!(await exists(cfgPath))) return null;
  try {
    const raw = await fs.readFile(cfgPath, "utf-8");
    return JSON.parse(raw) as SystemBaseConfig;
  } catch {
    return null;
  }
}

async function loadFromSystemDir(profile: PromptProfile): Promise<string | null> {
  const systemDir = path.join(os.homedir(), "clawd", "system");
  if (!(await exists(systemDir))) return null;

  const cfg = await loadSystemBaseConfig(systemDir);
  const identityRel = cfg?.files?.identity ?? "profile.md";
  const protectionRel =
    cfg?.files?.protectionContract ?? path.join("prompts", "protection.md");
  const baseRel = cfg?.files?.baseContract ?? path.join("prompts", "base.md");
  const decomposeRel = cfg?.files?.decomposeContract ?? path.join("prompts", "decompose.md");
  const qcRel = cfg?.files?.qcContract ?? path.join("prompts", "qc.md");

  const identity =
    (await readTextIfExists(path.join(systemDir, identityRel))) ??
    (await readTextIfExists(path.join(systemDir, "identity.md"))) ??
    (await readTextIfExists(path.join(systemDir, "profile.md")));

  const protectionContract = await readTextIfExists(path.join(systemDir, protectionRel));
  const baseContract = await readTextIfExists(path.join(systemDir, baseRel));
  const decomposeContract = await readTextIfExists(path.join(systemDir, decomposeRel));
  const qcContract = await readTextIfExists(path.join(systemDir, qcRel));

  const parts: string[] = [];
  if (identity) parts.push(identity);
  if (protectionContract) parts.push(protectionContract);
  if (baseContract) parts.push(baseContract);
  if (profile === "deyi_mini_decompose" && decomposeContract) parts.push(decomposeContract);
  if (profile === "deyi_mini_qc" && qcContract) parts.push(qcContract);

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

export async function buildPromptProfileSystemPrompt(
  profile?: PromptProfile,
): Promise<string | undefined> {
  if (!profile) return undefined;
  const cached = cache.get(profile);
  if (cached) return cached;

  const fileBased = await loadFromSystemDir(profile);
  if (fileBased) {
    cache.set(profile, fileBased);
    return fileBased;
  }

  const parts: string[] = [buildDeyiMiniIdentity(), buildBaseContract()];
  if (profile === "deyi_mini_decompose") parts.push(buildDecomposeContract());
  if (profile === "deyi_mini_qc") parts.push(buildQcContract());
  const builtIn = parts.join("\n\n");
  cache.set(profile, builtIn);
  return builtIn;
}
