import fs from "node:fs/promises";
import path from "node:path";

export type LoopLedgerPhase = "dialog" | "task" | "closing";

export type LoopLedgerEntry = {
  ts: number;
  sessionId: string;
  phase: LoopLedgerPhase;
  reason?: string;
  autonomyLevel?: "quiet" | "normal" | "proactive";
  agentMode?: "dialog" | "task" | "closing";
  cp0Strategy?: string;
  roundId?: string;
  subTaskId?: string;
  nextAction?: string;
  progress?: {
    action?: string;
    evidence?: Record<string, unknown>;
  };
  reflection?: {
    summary?: string;
    risks?: string[];
    openQuestions?: string[];
  };
};

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "~";
}

function getTaskTreeDir(sessionId: string): string {
  return path.join(resolveHomeDir(), ".clawdbot", "tasks", sessionId);
}

function getLedgerPath(sessionId: string): string {
  return path.join(getTaskTreeDir(sessionId), "metadata", "loop-ledger.json");
}

async function safeLoadLedger(sessionId: string): Promise<LoopLedgerEntry[]> {
  try {
    const p = getLedgerPath(sessionId);
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x === "object") as LoopLedgerEntry[];
  } catch {
    return [];
  }
}

export async function loadLoopLedgerEntries(sessionId: string): Promise<LoopLedgerEntry[]> {
  return await safeLoadLedger(sessionId);
}

export async function appendLoopLedgerEntry(params: Omit<LoopLedgerEntry, "ts">): Promise<void> {
  try {
    const entry: LoopLedgerEntry = {
      ...params,
      ts: Date.now(),
    };

    const p = getLedgerPath(params.sessionId);
    await fs.mkdir(path.dirname(p), { recursive: true });

    const ledger = await safeLoadLedger(params.sessionId);
    ledger.push(entry);

    // 简单限流：最多保留最近 500 条，避免长期运行无限增长
    const MAX = 500;
    const trimmed = ledger.length > MAX ? ledger.slice(-MAX) : ledger;
    await fs.writeFile(p, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch {
    // 旁路审计，不允许阻塞主流程
  }
}
