import fs from "node:fs/promises";
import path from "node:path";

export type TaskEventType =
  | "subtask_status_changed"
  | "persistence_finalized"
  | "persistence_failed"
  | "round_completed"
  | "agent_mode_changed"
  | "autonomy_level_changed"
  | "fallback_enqueued"
  | "watchdog_recovered";

export type TaskEventRecord = {
  ts: number;
  sessionId: string;
  type: TaskEventType;
  data: Record<string, unknown>;
};

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "~";
}

function getTaskTreeDir(sessionId: string): string {
  return path.join(resolveHomeDir(), ".clawdbot", "tasks", sessionId);
}

function getEventsFilePath(sessionId: string): string {
  return path.join(getTaskTreeDir(sessionId), "metadata", "task-events.jsonl");
}

export class TaskEventLogger {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async append(type: TaskEventType, data: Record<string, unknown>): Promise<void> {
    const record: TaskEventRecord = {
      ts: Date.now(),
      sessionId: this.sessionId,
      type,
      data,
    };

    try {
      const eventsPath = getEventsFilePath(this.sessionId);
      await fs.mkdir(path.dirname(eventsPath), { recursive: true });
      await fs.appendFile(eventsPath, `${JSON.stringify(record)}\n`, "utf-8");
    } catch {
      // 事件流是旁路审计，不允许阻塞主流程。
    }
  }
}
