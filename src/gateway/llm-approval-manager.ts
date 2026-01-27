import { randomUUID } from "node:crypto";

import type { LlmApprovalDecision } from "../infra/llm-approvals.js";
import type { LlmApprovalRequestPayload } from "../infra/llm-approvals.js";

export type LlmApprovalRecord = {
  id: string;
  request: LlmApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  decision?: LlmApprovalDecision;
  resolvedBy?: string | null;
};

type PendingEntry = {
  record: LlmApprovalRecord;
  resolve: (decision: LlmApprovalDecision | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class LlmApprovalManager {
  private pending = new Map<string, PendingEntry>();

  create(request: LlmApprovalRequestPayload, timeoutMs: number, id?: string | null): LlmApprovalRecord {
    const now = Date.now();
    const resolvedId = id && id.trim().length > 0 ? id.trim() : randomUUID();
    return {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
  }

  async waitForDecision(record: LlmApprovalRecord, timeoutMs: number): Promise<LlmApprovalDecision | null> {
    return await new Promise<LlmApprovalDecision | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(record.id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(record.id, { record, resolve, reject, timer });
    });
  }

  resolve(recordId: string, decision: LlmApprovalDecision, resolvedBy?: string | null): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = decision;
    pending.record.resolvedBy = resolvedBy ?? null;
    this.pending.delete(recordId);
    pending.resolve(decision);
    return true;
  }

  getSnapshot(recordId: string): LlmApprovalRecord | null {
    const entry = this.pending.get(recordId);
    return entry?.record ?? null;
  }
}
