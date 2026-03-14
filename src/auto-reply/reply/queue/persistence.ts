import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FollowupQueueState } from "./state.js";
import type { FollowupRun } from "./types.js";

type PersistedQueueSnapshot = {
  version: 1;
  key: string;
  savedAt: number;
  state: Omit<FollowupQueueState, "draining">;
};

const SNAPSHOT_VERSION = 1 as const;
const SAVE_DEBOUNCE_MS = 500;

const pendingTimers = new Map<string, NodeJS.Timeout>();
const pendingPromises = new Map<string, Promise<void>>();

function getQueuePersistDir(): string {
  return path.join(os.homedir(), ".clawdbot", "queues");
}

function safeKeyToFileName(key: string): string {
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const cleaned = key.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 32);
  return `${cleaned || "queue"}_${hash}.json`;
}

function getSnapshotPath(key: string): string {
  return path.join(getQueuePersistDir(), safeKeyToFileName(key));
}

function serializeQueueState(queue: FollowupQueueState): Omit<FollowupQueueState, "draining"> {
  return {
    items: queue.items,
    lastEnqueuedAt: queue.lastEnqueuedAt,
    lastProgressAt: queue.lastProgressAt,
    lastProgressReason: queue.lastProgressReason,
    stuckCount: queue.stuckCount,
    lastWatchdogAt: queue.lastWatchdogAt,
    mode: queue.mode,
    debounceMs: queue.debounceMs,
    cap: queue.cap,
    dropPolicy: queue.dropPolicy,
    droppedCount: queue.droppedCount,
    summaryLines: queue.summaryLines,
    lastRun: queue.lastRun,
  };
}

async function saveQueueSnapshotNow(key: string, queue: FollowupQueueState): Promise<void> {
  const cleaned = key.trim();
  if (!cleaned) return;

  const dir = getQueuePersistDir();
  const filePath = getSnapshotPath(cleaned);
  const tmpPath = `${filePath}.tmp`;

  const snapshot: PersistedQueueSnapshot = {
    version: SNAPSHOT_VERSION,
    key: cleaned,
    savedAt: Date.now(),
    state: serializeQueueState(queue),
  };

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

export function scheduleSaveQueueSnapshot(key: string, queue: FollowupQueueState): void {
  const cleaned = key.trim();
  if (!cleaned) return;

  const existing = pendingTimers.get(cleaned);
  if (existing) clearTimeout(existing);

  const p = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(cleaned);
      void saveQueueSnapshotNow(cleaned, queue).finally(() => resolve());
    }, SAVE_DEBOUNCE_MS);
    pendingTimers.set(cleaned, timer);
  });
  pendingPromises.set(cleaned, p);
}

export async function flushQueueSnapshot(key: string): Promise<void> {
  const cleaned = key.trim();
  if (!cleaned) return;
  const existing = pendingTimers.get(cleaned);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(cleaned);
  }
  const p = pendingPromises.get(cleaned);
  pendingPromises.delete(cleaned);
  if (p) await p;
}

export async function deleteQueueSnapshot(key: string): Promise<void> {
  const cleaned = key.trim();
  if (!cleaned) return;
  try {
    await fs.unlink(getSnapshotPath(cleaned));
  } catch {
    // ignore
  }
}

export async function loadQueueSnapshot(key: string): Promise<Omit<FollowupQueueState, "draining"> | null> {
  const cleaned = key.trim();
  if (!cleaned) return null;
  try {
    const raw = await fs.readFile(getSnapshotPath(cleaned), "utf-8");
    const parsed = JSON.parse(raw) as PersistedQueueSnapshot;
    if (!parsed || parsed.version !== SNAPSHOT_VERSION || parsed.key !== cleaned) return null;

    const state = parsed.state;
    if (!state || !Array.isArray(state.items)) return null;

    // 防御性：清理明显损坏的入队项
    const items = state.items.filter((it: FollowupRun) => Boolean(it && typeof it.prompt === "string" && it.run));

    return {
      ...state,
      items,
    };
  } catch {
    return null;
  }
}

export async function writeDeadlockDiagnostic(opts: {
  queueKey: string;
  reason: string;
  queueState: FollowupQueueState;
  taskTreeId?: string;
  roundId?: string;
  pendingTaskIds?: string[];
  blockedBy?: Record<string, string[]>;
}): Promise<string | null> {
  try {
    const dir = path.join(getQueuePersistDir(), "diagnostics");
    await fs.mkdir(dir, { recursive: true });

    const ts = Date.now();
    const base = safeKeyToFileName(opts.queueKey).replace(/\.json$/, "");
    const file = path.join(dir, `${base}_${ts}.json`);

    const payload = {
      version: 1,
      createdAt: ts,
      queueKey: opts.queueKey,
      reason: opts.reason,
      taskTreeId: opts.taskTreeId,
      roundId: opts.roundId,
      pendingTaskIds: opts.pendingTaskIds ?? [],
      blockedBy: opts.blockedBy ?? {},
      queue: {
        ...serializeQueueState(opts.queueState),
        draining: opts.queueState.draining,
      },
    };

    await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf-8");
    return file;
  } catch {
    return null;
  }
}
