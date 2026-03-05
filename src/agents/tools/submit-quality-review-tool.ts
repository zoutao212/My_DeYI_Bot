import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";

const SubmitQualityReviewSchema = Type.Object({
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed")], {
    description: "质检状态：passed=通过；failed=不通过。",
  }),
  decision: Type.Union(
    [
      Type.Literal("continue"),
      Type.Literal("adjust"),
      Type.Literal("restart"),
      Type.Literal("overthrow"),
      Type.Literal("decompose"),
    ],
    {
      description:
        "质检决策：continue/adjust/restart/overthrow/decompose。decompose 用于建议进一步拆分。",
    },
  ),
  criteria: Type.Optional(
    Type.Array(Type.String(), {
      description: "检查项（可选）：列出你实际检查过的维度。",
      maxItems: 30,
    }),
  ),
  findings: Type.Array(Type.String(), {
    description: "发现的问题/结论（必须）。",
    minItems: 0,
    maxItems: 50,
  }),
  suggestions: Type.Array(Type.String(), {
    description: "改进建议（必须）。",
    minItems: 0,
    maxItems: 50,
  }),
  modifications: Type.Optional(
    Type.Array(
      Type.Object(
        {
          type: Type.String({ description: "变更类型（向后兼容：不做强约束）" }),
        },
        { additionalProperties: true },
      ),
      {
        description:
          "可选：对任务树的结构化修改建议（如果 decision=adjust 时通常需要）。",
        maxItems: 50,
      },
    ),
  ),
  rationale: Type.Optional(
    Type.String({
      description:
        "可选：简要说明你基于哪些证据做出该判断（引用 fileContent 摘要/验证结果等）。",
    }),
  ),
});

export function createSubmitQualityReviewTool(): AnyAgentTool {
  return {
    label: "Submit Quality Review",
    name: "submit_quality_review",
    description:
      "提交任务质检结果（结构化 JSON）。你必须先完成审查，再调用此工具提交 status/decision/findings/suggestions。",
    parameters: SubmitQualityReviewSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const payload = {
        status: args.status,
        decision: args.decision,
        criteria: args.criteria,
        findings: args.findings,
        suggestions: args.suggestions,
        modifications: args.modifications,
        rationale: args.rationale,
      };

      const text = JSON.stringify(payload);
      const compact = text.length > 480 ? text.slice(0, 480) : text;

      return {
        content: [{ type: "text" as const, text: compact }],
        details: payload,
      };
    },
  };
}
