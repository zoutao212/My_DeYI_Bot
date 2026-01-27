import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

export const LlmApprovalsRuleSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    enabled: Type.Optional(Type.Boolean()),
    provider: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    urlHost: Type.Optional(Type.String()),
    urlPathPrefix: Type.Optional(Type.String()),
    lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastUsedSummary: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LlmApprovalsFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    enabled: Type.Optional(Type.Boolean()),
    ask: Type.Optional(Type.String()),
    rules: Type.Optional(Type.Array(LlmApprovalsRuleSchema)),
  },
  { additionalProperties: false },
);

export const LlmApprovalsSnapshotSchema = Type.Object(
  {
    path: NonEmptyString,
    exists: Type.Boolean(),
    hash: NonEmptyString,
    file: LlmApprovalsFileSchema,
  },
  { additionalProperties: false },
);

export const LlmApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const LlmApprovalsSetParamsSchema = Type.Object(
  {
    file: LlmApprovalsFileSchema,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const LlmApprovalRequestPayloadSchema = Type.Object(
  {
    provider: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    modelId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    toolName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    runId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    url: NonEmptyString,
    method: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    headers: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])),
    bodyText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    bodyJson: Type.Optional(Type.Any()),
    bodySummary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const LlmApprovalRequestParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    request: LlmApprovalRequestPayloadSchema,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const LlmApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
