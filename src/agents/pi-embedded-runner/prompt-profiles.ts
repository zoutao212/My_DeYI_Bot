export type PromptProfile =
  | "deyi_mini_base"
  | "deyi_mini_decompose"
  | "deyi_mini_qc";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  return undefined;
}
