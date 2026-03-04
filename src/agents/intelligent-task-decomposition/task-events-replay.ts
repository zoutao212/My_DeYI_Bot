import fs from "node:fs/promises";
import path from "node:path";

type AnyEvent = {
  ts?: number;
  sessionId?: string;
  type?: string;
  data?: Record<string, unknown>;
};

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "~";
}

function getEventsFilePath(sessionId: string): string {
  return path.join(resolveHomeDir(), ".clawdbot", "tasks", sessionId, "metadata", "task-events.jsonl");
}

export async function loadTaskEvents(sessionId: string): Promise<AnyEvent[]> {
  const p = getEventsFilePath(sessionId);
  const raw = await fs.readFile(p, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const events: AnyEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AnyEvent);
    } catch {
      // ignore malformed lines
    }
  }
  return events;
}

export function summarizeEvents(events: AnyEvent[]) {
  const byType: Record<string, number> = {};
  for (const e of events) {
    const t = String(e.type ?? "unknown");
    byType[t] = (byType[t] ?? 0) + 1;
  }
  return { total: events.length, byType };
}

export async function replayTaskEvents(sessionId: string) {
  const events = await loadTaskEvents(sessionId);
  return {
    sessionId,
    ...summarizeEvents(events),
    last: events.slice(-10),
  };
}
