import fs from "node:fs/promises";
import path from "node:path";

export type ExecutionEventType =
  | "exec_started"
  | "exec_finished"
  | "exec_failed"
  | "judge_decided"
  | "enqueue_requested";

export type ExecutionEvent = {
  ts: number;
  sessionId: string;
  rootTaskId?: string;
  subTaskId?: string;
  type: ExecutionEventType;
  data: Record<string, unknown>;
};

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "~";
}

function getTaskDir(sessionId: string): string {
  return path.join(resolveHomeDir(), ".clawdbot", "tasks", sessionId);
}

function getJournalPath(sessionId: string): string {
  return path.join(getTaskDir(sessionId), "logs", "journal", "execution-journal.jsonl");
}

/**
 * 执行日志（append-only）
 *
 * 目标：让“执行→判定→重试/入队”的每一次关键决策可回放、可审计。
 *
 * 约束：这是旁路观测与恢复证据，不允许阻塞主流程。
 */
export class ExecutionJournal {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async append(event: Omit<ExecutionEvent, "ts" | "sessionId">): Promise<void> {
    const record: ExecutionEvent = {
      ts: Date.now(),
      sessionId: this.sessionId,
      ...event,
    };

    try {
      const p = getJournalPath(this.sessionId);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.appendFile(p, `${JSON.stringify(record)}\n`, "utf-8");
    } catch {
      // 不阻塞
    }
  }
}
