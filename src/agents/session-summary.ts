import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface SessionSummary {
  taskGoal: string;
  keyActions: string[];
  keyDecisions: string[];
  blockers: string[];
  totalTurns: number;
  createdAt: number;
}

/**
 * Generate a summary of the session history.
 * This summary is injected into the system prompt to provide context.
 */
export function generateSessionSummary(messages: AgentMessage[]): SessionSummary | null {
  if (messages.length === 0) return null;

  // Extract task goal (first user message)
  const firstUser = messages.find((m) => m.role === "user");
  const taskGoal = firstUser ? extractTextFromContent(firstUser.content) : "未知任务";

  // Extract key actions (tool calls)
  const keyActions: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const assistantMsg = msg as { role: "assistant"; tool_calls?: Array<{ function: { name: string } }> };
      if (assistantMsg.tool_calls) {
        for (const call of assistantMsg.tool_calls) {
          keyActions.push(`${call.function.name}`);
        }
      }
    }
  }

  // Extract key decisions (assistant messages with important keywords)
  const keyDecisions: string[] = [];
  const decisionKeywords = ["决定", "选择", "采用", "使用", "修改", "创建"];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = extractTextFromContent(msg.content);
      if (decisionKeywords.some((kw) => text.includes(kw))) {
        // 提取第一句话作为决策摘要
        const firstSentence = text.split(/[。！？\n]/)[0];
        if (firstSentence.length > 10 && firstSentence.length < 100) {
          keyDecisions.push(firstSentence);
        }
      }
    }
  }

  // Extract blockers (error messages)
  const blockers: string[] = [];
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const text = extractTextFromContent(msg.content);
      if (text.includes("error") || text.includes("failed") || text.includes("失败")) {
        const errorLine = text.split("\n").find((line) =>
          line.includes("error") || line.includes("failed") || line.includes("失败")
        );
        if (errorLine && errorLine.length < 100) {
          blockers.push(errorLine);
        }
      }
    }
  }

  return {
    taskGoal,
    keyActions: [...new Set(keyActions)].slice(0, 10), // 去重，最多 10 个
    keyDecisions: keyDecisions.slice(0, 5), // 最多 5 个
    blockers: [...new Set(blockers)].slice(0, 3), // 去重，最多 3 个
    totalTurns: messages.filter((m) => m.role === "user").length,
    createdAt: Date.now(),
  };
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  }
  return "";
}

/**
 * Format session summary for injection into system prompt.
 */
export function formatSessionSummary(summary: SessionSummary): string {
  const parts = [
    "## 会话上下文（Session Context）",
    "",
    `**任务目标**：${summary.taskGoal}`,
    `**对话轮数**：${summary.totalTurns} 轮`,
  ];

  if (summary.keyActions.length > 0) {
    parts.push("");
    parts.push("**已执行操作**：");
    parts.push(summary.keyActions.map((a) => `- ${a}`).join("\n"));
  }

  if (summary.keyDecisions.length > 0) {
    parts.push("");
    parts.push("**关键决策**：");
    parts.push(summary.keyDecisions.map((d, i) => `${i + 1}. ${d}`).join("\n"));
  }

  if (summary.blockers.length > 0) {
    parts.push("");
    parts.push("**遇到的问题**：");
    parts.push(summary.blockers.map((b, i) => `${i + 1}. ${b}`).join("\n"));
  }

  return parts.join("\n");
}
