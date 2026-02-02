import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface SessionSummary {
  taskGoal: string;
  keyActions: string[];
  keyDecisions: string[];
  blockers: string[];
  totalTurns: number;
  createdAt: number;
  // 🆕 新增字段
  progress?: {
    completed: number;
    total: number;
    percentage: number;
  };
  nextSteps?: string[];
  keyFiles?: string[];
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

  // 🆕 Extract progress information
  const progress = extractProgress(messages);

  // 🆕 Extract next steps
  const nextSteps = extractNextSteps(messages);

  // 🆕 Extract key files
  const keyFiles = extractKeyFiles(messages);

  return {
    taskGoal,
    keyActions: [...new Set(keyActions)].slice(0, 10), // 去重，最多 10 个
    keyDecisions: keyDecisions.slice(0, 5), // 最多 5 个
    blockers: [...new Set(blockers)].slice(0, 3), // 去重，最多 3 个
    totalTurns: messages.filter((m) => m.role === "user").length,
    createdAt: Date.now(),
    progress,
    nextSteps,
    keyFiles,
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
 * 🆕 Extract progress information from messages.
 * Looks for patterns like "完成 3/5" or "已完成 60%"
 */
function extractProgress(messages: AgentMessage[]): { completed: number; total: number; percentage: number } | undefined {
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = extractTextFromContent(msg.content);
      
      // Pattern 1: "完成 3/5" or "已完成 3/5"
      const fractionMatch = text.match(/(?:完成|已完成)\s*(\d+)\s*\/\s*(\d+)/);
      if (fractionMatch) {
        const completed = parseInt(fractionMatch[1], 10);
        const total = parseInt(fractionMatch[2], 10);
        return {
          completed,
          total,
          percentage: Math.round((completed / total) * 100),
        };
      }
      
      // Pattern 2: "已完成 60%" or "进度 60%"
      const percentMatch = text.match(/(?:已完成|进度)\s*(\d+)%/);
      if (percentMatch) {
        const percentage = parseInt(percentMatch[1], 10);
        return {
          completed: percentage,
          total: 100,
          percentage,
        };
      }
    }
  }
  
  return undefined;
}

/**
 * 🆕 Extract next steps from messages.
 * Looks for patterns like "下一步：" or "接下来："
 */
function extractNextSteps(messages: AgentMessage[]): string[] | undefined {
  const nextSteps: string[] = [];
  const nextStepKeywords = ["下一步", "接下来", "然后", "之后"];
  
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = extractTextFromContent(msg.content);
      const lines = text.split("\n");
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (nextStepKeywords.some((kw) => line.includes(kw))) {
          // 提取当前行和下一行
          const step = line.replace(/^[*\-\d.]+\s*/, "").trim();
          if (step.length > 5 && step.length < 100) {
            nextSteps.push(step);
          }
        }
      }
    }
  }
  
  return nextSteps.length > 0 ? nextSteps.slice(0, 5) : undefined;
}

/**
 * 🆕 Extract key files from tool calls.
 * Looks for file paths in read/write/edit tool calls.
 */
function extractKeyFiles(messages: AgentMessage[]): string[] | undefined {
  const keyFiles: string[] = [];
  
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const assistantMsg = msg as { role: "assistant"; tool_calls?: Array<{ function: { name: string; arguments: string } }> };
      if (assistantMsg.tool_calls) {
        for (const call of assistantMsg.tool_calls) {
          if (["read", "write", "edit"].includes(call.function.name)) {
            try {
              const args = JSON.parse(call.function.arguments);
              if (args.path) {
                keyFiles.push(args.path);
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    }
  }
  
  return keyFiles.length > 0 ? [...new Set(keyFiles)].slice(0, 10) : undefined;
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

  // 🆕 Add progress information
  if (summary.progress) {
    parts.push("");
    parts.push(`**进度**：${summary.progress.completed}/${summary.progress.total} (${summary.progress.percentage}%)`);
  }

  // 🆕 Add next steps
  if (summary.nextSteps && summary.nextSteps.length > 0) {
    parts.push("");
    parts.push("**下一步计划**：");
    parts.push(summary.nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  }

  // 🆕 Add key files
  if (summary.keyFiles && summary.keyFiles.length > 0) {
    parts.push("");
    parts.push("**关键文件**：");
    parts.push(summary.keyFiles.map((f) => `- ${f}`).join("\n"));
  }

  return parts.join("\n");
}
