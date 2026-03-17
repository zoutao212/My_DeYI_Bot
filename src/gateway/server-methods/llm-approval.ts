import type { LlmApprovalDecision } from "../../infra/llm-approvals.js";
import {
  addAllowAlwaysRule,
  loadLlmApprovals,
  saveLlmApprovals,
  type LlmApprovalRequestPayload,
} from "../../infra/llm-approvals.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateLlmApprovalRequestParams,
  validateLlmApprovalResolveParams,
} from "../protocol/index.js";
import type { LlmApprovalManager } from "../llm-approval-manager.js";
import type { GatewayRequestHandlers } from "./types.js";

export function createLlmApprovalHandlers(manager: LlmApprovalManager): GatewayRequestHandlers {
  return {
    "llm.approval.request": async ({ params, respond, context }) => {
      if (!validateLlmApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid llm.approval.request params: ${formatValidationErrors(validateLlmApprovalRequestParams.errors)}`,
          ),
        );
        return;
      }

      const p = params as {
        id?: string;
        request: LlmApprovalRequestPayload;
        timeoutMs?: number;
      };

      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 120_000;
      const explicitId = typeof p.id === "string" && p.id.trim().length > 0 ? p.id.trim() : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"));
        return;
      }

      const record = manager.create(p.request, timeoutMs, explicitId);
      const decisionPromise = manager.waitForDecision(record, timeoutMs);

      context.broadcast(
        "llm.approval.requested",
        {
          id: record.id,
          request: record.request,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        { dropIfSlow: true },
      );

      const decision = await decisionPromise;
      respond(
        true,
        {
          id: record.id,
          decision,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
        },
        undefined,
      );
    },

    "llm.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validateLlmApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid llm.approval.resolve params: ${formatValidationErrors(validateLlmApprovalResolveParams.errors)}`,
          ),
        );
        return;
      }

      const p = params as { id: string; decision: string };
      const decision = p.decision as LlmApprovalDecision;
      if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }

      console.log(`[llm-approval] 📥 收到审批响应：id=${p.id}, decision=${decision}, client=${client?.connect?.client?.displayName ?? client?.connect?.client?.id ?? 'unknown'}`);

      if (decision === "allow-always") {
        const snapshot = manager.getSnapshot(p.id);
        if (snapshot) {
          const approvals = loadLlmApprovals();
          const next = addAllowAlwaysRule({
            approvals,
            request: snapshot.request,
            summary: snapshot.request.bodySummary ?? undefined,
          });
          saveLlmApprovals(next);
          console.log(`[llm-approval] 💾 已添加到白名单：provider=${snapshot.request.provider}, model=${snapshot.request.modelId}`);
        }
      }

      const resolvedBy = client?.connect?.client?.displayName ?? client?.connect?.client?.id;
      const ok = manager.resolve(p.id, decision, resolvedBy ?? null);
      if (!ok) {
        console.error(`[llm-approval] ❌ 审批解析失败：未知的审批 ID ${p.id}`);
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown approval id"));
        return;
      }

      context.broadcast(
        "llm.approval.resolved",
        { id: p.id, decision, resolvedBy, ts: Date.now() },
        { dropIfSlow: true },
      );

      console.log(`[llm-approval] 🎉 审批流程完成：id=${p.id}, decision=${decision}`);
      respond(true, { ok: true }, undefined);
    },
  };
}
