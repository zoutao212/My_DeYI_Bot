import {
  normalizeLlmApprovals,
  readLlmApprovalsSnapshot,
  saveLlmApprovals,
  type LlmApprovalsFile,
  type LlmApprovalsSnapshot,
} from "../../infra/llm-approvals.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateLlmApprovalsGetParams,
  validateLlmApprovalsSetParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function resolveBaseHash(params: unknown): string | null {
  const raw = (params as { baseHash?: unknown })?.baseHash;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function requireApprovalsBaseHash(
  params: unknown,
  snapshot: LlmApprovalsSnapshot,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) return true;
  if (!snapshot.hash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "llm approvals base hash unavailable; re-run llm.approvals.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHash(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "llm approvals base hash required; re-run llm.approvals.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshot.hash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "llm approvals changed since last load; re-run llm.approvals.get and retry",
      ),
    );
    return false;
  }
  return true;
}

export const llmApprovalsHandlers: GatewayRequestHandlers = {
  "llm.approvals.get": ({ params, respond }) => {
    if (!validateLlmApprovalsGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid llm.approvals.get params: ${formatValidationErrors(validateLlmApprovalsGetParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = readLlmApprovalsSnapshot();
    respond(true, snapshot, undefined);
  },
  "llm.approvals.set": ({ params, respond }) => {
    if (!validateLlmApprovalsSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid llm.approvals.set params: ${formatValidationErrors(validateLlmApprovalsSetParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = readLlmApprovalsSnapshot();
    if (!requireApprovalsBaseHash(params, snapshot, respond)) {
      return;
    }
    const incoming = (params as { file?: unknown }).file;
    if (!incoming || typeof incoming !== "object") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "llm approvals file is required"));
      return;
    }
    const normalized = normalizeLlmApprovals(incoming as LlmApprovalsFile);
    saveLlmApprovals(normalized);
    const nextSnapshot = readLlmApprovalsSnapshot();
    respond(true, nextSnapshot, undefined);
  },
};
