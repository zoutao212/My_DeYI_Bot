import type { SubTask, TaskTree } from "../../agents/intelligent-task-decomposition/types.js";

export type JudgeDecision =
  | { action: "accept"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "fail"; reason: string };

export function judgeAttemptOutcome(params: {
  taskTree?: TaskTree;
  subTask?: SubTask;
  attemptOutcome?: any;
}): JudgeDecision | null {
  const { attemptOutcome: ao } = params;
  if (!ao) return null;
  if (ao.ok === true) return { action: "accept", reason: "AttemptOutcome:ok" };

  const suggested = String(ao.suggestedAction ?? "");
  const kind = String(ao.kind ?? "unknown");
  if (suggested === "retry" || suggested === "degrade" || suggested === "shrink_context") {
    return { action: "retry", reason: `AttemptOutcome:${kind}` };
  }

  return { action: "fail", reason: `AttemptOutcome:${kind}` };
}

export function judgeOutputValidator(params: {
  valid: boolean;
  failureCode?: string;
  failureReason?: string;
  suggestedAction?: "retry" | "skip" | "fail";
  retryCount?: number;
  maxRetries: number;
}): JudgeDecision {
  if (params.valid) return { action: "accept", reason: "OutputValidator:ok" };
  const code = params.failureCode ?? "unknown";
  const reason = params.failureReason ?? code;
  const willRetry = params.suggestedAction === "retry" && (params.retryCount ?? 0) < params.maxRetries;
  return willRetry
    ? { action: "retry", reason: `OutputValidator:${code}:${reason}` }
    : { action: "fail", reason: `OutputValidator:${code}:${reason}` };
}
