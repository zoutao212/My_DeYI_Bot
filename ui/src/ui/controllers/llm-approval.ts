export type LlmApprovalRequestPayload = {
  provider?: string | null;
  modelId?: string | null;
  source?: string | null;
  toolName?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
  url: string;
  method?: string | null;
  headers?: Record<string, string> | null;
  bodySummary?: string | null;
  bodyText?: string | null;
};

export type LlmApprovalRequest = {
  id: string;
  request: LlmApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type LlmApprovalResolved = {
  id: string;
  decision?: string | null;
  resolvedBy?: string | null;
  ts?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseLlmApprovalRequested(payload: unknown): LlmApprovalRequest | null {
  if (!isRecord(payload)) return null;
  const id = normalizeString(payload.id);
  const request = payload.request;
  if (!id || !isRecord(request)) return null;

  const url = normalizeString(request.url);
  if (!url) return null;

  const createdAtMs = typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!createdAtMs || !expiresAtMs) return null;

  const headersRaw = request.headers;
  const headers = isRecord(headersRaw)
    ? Object.fromEntries(
        Object.entries(headersRaw).map(([k, v]) => [String(k), String(v)]),
      )
    : null;

  return {
    id,
    request: {
      provider: normalizeString(request.provider),
      modelId: normalizeString(request.modelId),
      source: normalizeString(request.source),
      toolName: normalizeString(request.toolName),
      sessionKey: normalizeString(request.sessionKey),
      runId: normalizeString(request.runId),
      url,
      method: normalizeString(request.method),
      headers,
      bodySummary: normalizeString(request.bodySummary),
      bodyText: normalizeString(request.bodyText),
    },
    createdAtMs,
    expiresAtMs,
  };
}

export function parseLlmApprovalResolved(payload: unknown): LlmApprovalResolved | null {
  if (!isRecord(payload)) return null;
  const id = normalizeString(payload.id);
  if (!id) return null;
  return {
    id,
    decision: normalizeString(payload.decision),
    resolvedBy: normalizeString(payload.resolvedBy),
    ts: typeof payload.ts === "number" ? payload.ts : null,
  };
}

export function pruneLlmApprovalQueue(queue: LlmApprovalRequest[]): LlmApprovalRequest[] {
  const now = Date.now();
  return queue.filter((entry) => entry.expiresAtMs > now);
}

export function addLlmApproval(queue: LlmApprovalRequest[], entry: LlmApprovalRequest): LlmApprovalRequest[] {
  const next = pruneLlmApprovalQueue(queue).filter((item) => item.id !== entry.id);
  next.push(entry);
  return next;
}

export function removeLlmApproval(queue: LlmApprovalRequest[], id: string): LlmApprovalRequest[] {
  return pruneLlmApprovalQueue(queue).filter((entry) => entry.id !== id);
}
