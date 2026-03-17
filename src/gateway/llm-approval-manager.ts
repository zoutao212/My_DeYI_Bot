import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

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
  requestKey?: string;
};

export class LlmApprovalManager {
  private pending = new Map<string, PendingEntry>();
  private pendingByKey = new Map<string, string>();

  private static computeRequestKey(request: LlmApprovalRequestPayload): string {
    const stable = JSON.stringify({
      provider: request.provider ?? null,
      modelId: request.modelId ?? null,
      source: request.source ?? null,
      toolName: request.toolName ?? null,
      sessionKey: request.sessionKey ?? null,
      runId: request.runId ?? null,
      url: request.url,
      method: request.method ?? null,
      headers: request.headers ?? null,
      bodyText: request.bodyText ?? null,
      bodySummary: request.bodySummary ?? null,
    });
    return createHash("sha256").update(stable).digest("hex");
  }

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

  createOrGet(request: LlmApprovalRequestPayload, timeoutMs: number, id?: string | null): LlmApprovalRecord {
    const requestKey = LlmApprovalManager.computeRequestKey(request);
    const existingId = this.pendingByKey.get(requestKey);
    if (existingId) {
      const existing = this.pending.get(existingId);
      if (existing && existing.record.expiresAtMs > Date.now()) {
        return existing.record;
      }
      this.pendingByKey.delete(requestKey);
    }
    const record = this.create(request, timeoutMs, id);
    this.pendingByKey.set(requestKey, record.id);
    return record;
  }

  async waitForDecision(record: LlmApprovalRecord, timeoutMs: number): Promise<LlmApprovalDecision | null> {
    return await new Promise<LlmApprovalDecision | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(record.id);
        if (entry?.requestKey) this.pendingByKey.delete(entry.requestKey);
        this.pending.delete(record.id);
        resolve(null);
      }, timeoutMs);
      const requestKey = LlmApprovalManager.computeRequestKey(record.request);
      this.pendingByKey.set(requestKey, record.id);
      this.pending.set(record.id, { record, resolve, reject, timer, requestKey });
    });
  }

  resolve(recordId: string, decision: LlmApprovalDecision, resolvedBy?: string | null): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) {
      console.log(`[llm-approval] ⚠️ 尝试解析未知的审批记录：${recordId}`);
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = decision;
    pending.record.resolvedBy = resolvedBy ?? null;
    
    const waitTimeMs = pending.record.resolvedAtMs - pending.record.createdAtMs;
    console.log(`[llm-approval] ✅ 审批已解析：id=${recordId}, decision=${decision}, resolvedBy=${resolvedBy ?? 'unknown'}, waitTime=${waitTimeMs}ms`);
    console.log(`[llm-approval] 📋 请求详情：provider=${pending.record.request.provider}, model=${pending.record.request.modelId}, summary=${pending.record.request.bodySummary}`);
    
    if (pending.requestKey) this.pendingByKey.delete(pending.requestKey);
    this.pending.delete(recordId);
    pending.resolve(decision);
    return true;
  }

  getSnapshot(recordId: string): LlmApprovalRecord | null {
    const entry = this.pending.get(recordId);
    return entry?.record ?? null;
  }
}
