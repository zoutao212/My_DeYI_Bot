import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";

/**
 * 🔧 P118: continue_generation 工具 — 输出延续机制
 *
 * 解决问题：当 maxOutputTokens 限制（如 4096）不足以完成 LLM 的回复时，
 * LLM 可以主动调用此工具请求系统"续传"，在下一轮对话中继续输出。
 *
 * 工作原理：
 * 1. LLM 在接近 token 限制时调用 continue_generation
 * 2. 工具返回确认消息（包含 LLM 自己的进度摘要）
 * 3. pi-agent SDK 的 agent loop 自动将 tool result 注入并 re-prompt LLM
 * 4. LLM 从上次停止的地方继续
 *
 * 安全机制：
 * - 每个 attempt 实例最多允许 MAX_CONTINUATIONS 次续传（防止无限循环）
 * - 超限后返回错误，要求 LLM 立即结束
 */

export const MAX_CONTINUATIONS = 10;

const ContinueGenerationSchema = Type.Object({
  summary: Type.String({
    description: "简要概括你到目前为止已完成的内容（1-2句话），以便在下一轮中从断点继续。",
  }),
});

/**
 * 创建 continue_generation 工具。
 * 每次调用 createContinueGenerationTool() 都会创建一个独立的计数器实例，
 * 因此天然与 attempt 生命周期绑定（每次 attempt 重新创建工具列表）。
 */
export function createContinueGenerationTool(): AnyAgentTool {
  let continuationCount = 0;

  return {
    label: "Continue Generation",
    name: "continue_generation",
    description: `当你的回复内容较多、即将达到单次输出 token 上限时，调用此工具请求继续输出。

**使用时机**：
- 你需要调用多个工具（如多次 enqueue_task），但单次输出空间不够
- 你正在生成长篇内容（如报告、文章），一次写不完
- 你已经完成了一部分工作，还需要继续

**使用方法**：
1. 先完成当前能做的部分（如先调用几个工具、先写一部分内容）
2. 在回复末尾调用 continue_generation，附上进度摘要
3. 系统会让你继续，你从上次停止的地方接着做

**注意**：
- 每次对话最多可续传 ${MAX_CONTINUATIONS} 次
- 不要在没有实际产出的情况下调用（先做事，再续传）
- 如果任务已经完成，不要调用此工具`,
    parameters: ContinueGenerationSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      continuationCount++;
      const summary = typeof args.summary === "string" ? args.summary.trim() : "(无摘要)";

      if (continuationCount > MAX_CONTINUATIONS) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 已达到最大续传次数 (${MAX_CONTINUATIONS})。请立即完成当前任务并输出最终结果，不要再请求续传。`,
            },
          ],
          details: {
            success: false,
            reason: "max_continuations_exceeded",
            count: continuationCount,
            maxAllowed: MAX_CONTINUATIONS,
          },
        };
      }

      console.log(
        `[continue_generation] ✅ 续传 #${continuationCount}/${MAX_CONTINUATIONS}: ${summary.slice(0, 200)}`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✅ 续传已批准 (${continuationCount}/${MAX_CONTINUATIONS})。`,
              `你的进度记录：${summary}`,
              `剩余续传次数：${MAX_CONTINUATIONS - continuationCount}`,
              ``,
              `请从上次停止的地方继续。不要重复已完成的内容。`,
            ].join("\n"),
          },
        ],
        details: {
          success: true,
          continuationNumber: continuationCount,
          maxAllowed: MAX_CONTINUATIONS,
          summary,
        },
      };
    },
  };
}
