import { z } from "zod";

const ExecApprovalForwardTargetSchema = z
  .object({
    channel: z.string().min(1),
    to: z.string().min(1),
    accountId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const ExecApprovalForwardingSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ExecApprovalForwardTargetSchema).optional(),
  })
  .strict()
  .optional();

const LlmApprovalSchema = z
  .object({
    /** 是否启用 LLM 审批。默认 false（不审批，自动允许）。 */
    enabled: z.boolean().optional(),
    /** 是否自动批准所有请求。默认 false。 */
    autoApprove: z.boolean().optional(),
  })
  .strict()
  .optional();

const ToolApprovalSchema = z
  .object({
    /** 是否启用 Tool 审批。默认 false（不审批，自动允许）。 */
    enabled: z.boolean().optional(),
    /** 
     * 审批模式：
     * - "before-and-after": 执行前后都审批（阻塞执行）
     * - "after-only": 只在执行后展示（不阻塞，推荐）
     * - "off": 关闭审批
     * 默认 "after-only"
     */
    mode: z.union([
      z.literal("before-and-after"),
      z.literal("after-only"),
      z.literal("off"),
    ]).optional(),
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    llm: LlmApprovalSchema,
    tools: ToolApprovalSchema,
  })
  .strict()
  .optional();
