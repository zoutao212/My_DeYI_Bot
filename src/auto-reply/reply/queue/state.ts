import type { FollowupRun, QueueDropPolicy, QueueMode, QueueSettings } from "./types.js";
import { deleteQueueSnapshot, loadQueueSnapshot, scheduleSaveQueueSnapshot } from "./persistence.js";

export type FollowupQueueState = {
  items: FollowupRun[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  lastRun?: FollowupRun["run"];
};

export const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

export const FOLLOWUP_QUEUES = new Map<string, FollowupQueueState>();

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    existing.mode = settings.mode;
    existing.debounceMs =
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : existing.debounceMs;
    existing.cap =
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : existing.cap;
    existing.dropPolicy = settings.dropPolicy ?? existing.dropPolicy;
    // 🆕 配置更新后落盘（debounce），并确保有快照时能尽快写入新的 mode/cap 等
    scheduleSaveQueueSnapshot(key, existing);
    return existing;
  }

  const created: FollowupQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
  };
  FOLLOWUP_QUEUES.set(key, created);

  // 🆕 重启恢复：尝试从磁盘加载队列快照（fire-and-forget，不阻塞调用方）
  void loadQueueSnapshot(key).then((snap) => {
    if (!snap) return;
    const q = FOLLOWUP_QUEUES.get(key);
    if (!q) return;
    q.items = snap.items;
    q.lastEnqueuedAt = snap.lastEnqueuedAt;
    q.mode = snap.mode;
    q.debounceMs = snap.debounceMs;
    q.cap = snap.cap;
    q.dropPolicy = snap.dropPolicy;
    q.droppedCount = snap.droppedCount;
    q.summaryLines = snap.summaryLines;
    q.lastRun = snap.lastRun;
  }).catch(() => {
    // ignore
  });

  return created;
}

export function clearFollowupQueue(key: string): number {
  const cleaned = key.trim();
  if (!cleaned) return 0;
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) return 0;
  const cleared = queue.items.length + queue.droppedCount;
  queue.items.length = 0;
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  // 🆕 清理快照（不阻塞）
  void deleteQueueSnapshot(cleaned);
  return cleared;
}
