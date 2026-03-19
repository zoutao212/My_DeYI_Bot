import { html, nothing } from "lit";

import type { AppViewState } from "../app-view-state";
import { getUiL10n } from "../ui-l10n";
import type { LlmApprovalRequest } from "../controllers/llm-approval";

function formatRemaining(ms: number): string {
  const remaining = Math.max(0, ms);
  const totalSeconds = Math.floor(remaining / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function renderMetaRow(label: string, value?: string | null) {
  if (!value) return nothing;
  return html`<div class="exec-approval-meta-row"><span>${label}</span><span>${value}</span></div>`;
}

function visualizeFormatting(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\\r\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function tryPrettyJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 从 LLM 响应中提取最新的 tool call（LLM 即将调用的工具）
 * 用于在审批界面显示 LLM 计划调用哪些工具及其参数
 */
function extractLatestToolCalls(raw: string, isZh: boolean): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
  const contents = Array.isArray(parsed.contents) ? parsed.contents : null;

  // 🎯 OpenAI format: messages[].tool_calls
  if (messages && messages.length > 0) {
    // 从后往前找最新的 assistant 消息（包含 tool_calls）
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!isRecord(m)) continue;
      const role = typeof m.role === "string" ? m.role : "unknown";
      
      if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const toolCallsInfo: string[] = [];
        for (const tc of m.tool_calls) {
          if (!isRecord(tc)) continue;
          const func = tc.function;
          if (!isRecord(func)) continue;
          const funcName = typeof func.name === "string" ? func.name : "unknown";
          const args = func.arguments;
          let argsStr = "";
          if (typeof args === "string") {
            try {
              const argsObj = JSON.parse(args);
              argsStr = JSON.stringify(argsObj, null, 2);
            } catch {
              argsStr = args;
            }
          } else if (args && typeof args === "object") {
            argsStr = JSON.stringify(args, null, 2);
          }
          toolCallsInfo.push(`[${funcName}]\n${argsStr}`);
        }
        if (toolCallsInfo.length > 0) {
          return toolCallsInfo.join("\n\n");
        }
      }
    }
  }

  // 🎯 Google Generative AI format: contents[].parts[].functionCall
  if (contents && contents.length > 0) {
    // 从后往前找最新的 model 消息（包含 functionCall）
    for (let i = contents.length - 1; i >= 0; i -= 1) {
      const c = contents[i];
      if (!isRecord(c)) continue;
      const role = typeof c.role === "string" ? c.role : "unknown";
      
      if (role === "model" && Array.isArray(c.parts)) {
        const functionCalls: string[] = [];
        for (const part of c.parts) {
          if (!isRecord(part)) continue;
          if (part.functionCall && isRecord(part.functionCall)) {
            const funcCall = part.functionCall;
            const funcName = typeof funcCall.name === "string" ? funcCall.name : "unknown";
            const args = funcCall.args;
            let argsStr = "";
            if (args && typeof args === "object") {
              argsStr = JSON.stringify(args, null, 2);
            }
            functionCalls.push(`[${funcName}]\n${argsStr}`);
          }
        }
        if (functionCalls.length > 0) {
          return functionCalls.join("\n\n");
        }
      }
    }
  }

  return null;
}

/**
 * 从 OpenAI/Google 格式的 LLM 请求中提取最新的 tool result 内容
 * 用于在审批界面主区域直接显示，让用户一眼就能看到工具执行结果
 */
function extractLatestToolResult(raw: string, isZh: boolean): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
  const contents = Array.isArray(parsed.contents) ? parsed.contents : null;

  // 🎯 OpenAI format: messages[].tool_result
  if (messages && messages.length > 0) {
    const latestToolResults: string[] = [];
    
    // 从后往前找最新的 tool result
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!isRecord(m)) continue;
      const role = typeof m.role === "string" ? m.role : "unknown";
      
      if (role === "tool" || role === "toolResult") {
        const toolName = typeof m.name === "string" ? m.name : 
                        typeof m.toolName === "string" ? m.toolName : "unknown";
        const content = normalizeMessageContentToText(m.content);
        if (content) {
          latestToolResults.unshift(`[${toolName}] ${content}`);
        }
      } else if (role === "assistant" || role === "user") {
        // 遇到 assistant 或 user 消息，停止搜索
        break;
      }
    }
    
    if (latestToolResults.length > 0) {
      return latestToolResults.join("\n\n");
    }
  }

  // 🎯 Google Generative AI format: contents[].parts[].functionResponse
  if (contents && contents.length > 0) {
    const latestFuncResponses: string[] = [];
    
    for (let i = contents.length - 1; i >= 0; i -= 1) {
      const c = contents[i];
      if (!isRecord(c)) continue;
      const role = typeof c.role === "string" ? c.role : "unknown";
      
      if ((role === "function" || role === "model") && Array.isArray(c.parts)) {
        for (const part of c.parts) {
          if (!isRecord(part)) continue;
          if (part.functionResponse && isRecord(part.functionResponse)) {
            const funcResp = part.functionResponse;
            const funcName = typeof funcResp.name === "string" ? funcResp.name : "unknown";
            const response = funcResp.response;
            let respStr = "";
            if (typeof response === "string") {
              respStr = response;
            } else if (response && typeof response === "object") {
              respStr = JSON.stringify(response, null, 2);
            }
            if (respStr) {
              latestFuncResponses.unshift(`[${funcName}] ${respStr}`);
            }
          }
        }
      } else if (role === "user") {
        break;
      }
    }
    
    if (latestFuncResponses.length > 0) {
      return latestFuncResponses.join("\n\n");
    }
  }

  return null;
}

function stringifyMaybe(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeMessageContentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (isRecord(item)) {
        const type = typeof item.type === "string" ? item.type : "";
        if (type === "text") {
          parts.push(typeof item.text === "string" ? item.text : stringifyMaybe(item.text));
          continue;
        }
        if (type) {
          parts.push(`[${type}] ${stringifyMaybe(item)}`);
          continue;
        }
      }
      parts.push(stringifyMaybe(item));
    }
    return parts.join("\n");
  }
  return stringifyMaybe(content);
}

function tryPrettyOpenAiPayload(raw: string, isZh: boolean): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const model = typeof parsed.model === "string" ? parsed.model : "";
  const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
  const contents = Array.isArray(parsed.contents) ? parsed.contents : null;
  const tools = Array.isArray(parsed.tools) ? parsed.tools : null;
  const stream = typeof parsed.stream === "boolean" ? parsed.stream : null;
  const store = typeof parsed.store === "boolean" ? parsed.store : null;
  const maxTokens =
    typeof parsed.max_completion_tokens === "number"
      ? parsed.max_completion_tokens
      : typeof parsed.max_tokens === "number"
        ? parsed.max_tokens
        : null;
  const reasoning = typeof parsed.reasoning_effort === "string" ? parsed.reasoning_effort : "";

  const lines: string[] = [];
  lines.push(isZh ? "LLM 请求体（已美化）" : "LLM request body (pretty)");
  if (model) lines.push(`${isZh ? "模型" : "Model"}: ${model}`);
  if (stream != null) lines.push(`${isZh ? "流式" : "Stream"}: ${stream ? "是" : "否"}`);
  if (store != null) lines.push(`${isZh ? "存储" : "Store"}: ${store ? "是" : "否"}`);
  if (maxTokens != null) lines.push(`${isZh ? "最大 tokens" : "Max tokens"}: ${maxTokens}`);
  if (reasoning) lines.push(`${isZh ? "推理强度" : "Reasoning"}: ${reasoning}`);
  if (tools) lines.push(`${isZh ? "工具数量" : "Tools"}: ${tools.length}`);
  if (messages) lines.push(`${isZh ? "消息数量" : "Messages"}: ${messages.length}`);
  if (contents) lines.push(`${isZh ? "内容数量" : "Contents"}: ${contents.length}`);

  // 🆕 提取并高亮显示 tool result（OpenAI format）
  let toolResultCount = 0;
  const latestToolResults: Array<{ toolName: string; toolCallId: string; content: string }> = [];
  
  if (messages && messages.length > 0) {
    // 从后往前找最新的 tool result
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!isRecord(m)) continue;
      const role = typeof m.role === "string" ? m.role : "unknown";
      if (role === "tool" || role === "toolResult") {
        toolResultCount++;
        const toolName = typeof m.name === "string" ? m.name : 
                        typeof m.toolName === "string" ? m.toolName : "unknown";
        const toolCallId = typeof m.tool_call_id === "string" ? m.tool_call_id :
                          typeof m.toolCallId === "string" ? m.toolCallId : "unknown";
        const content = normalizeMessageContentToText(m.content);
        latestToolResults.unshift({ toolName, toolCallId, content });
      } else if (role === "assistant" || role === "user") {
        // 遇到 assistant 或 user 消息，说明已经找到了最新一轮的 tool result
        break;
      }
    }
    
    if (latestToolResults.length > 0) {
      lines.push("");
      lines.push(isZh ? "=== 🎯 最新 Tool Results (本轮工具执行结果) ===" : "=== 🎯 Latest Tool Results ===");
      for (let i = 0; i < latestToolResults.length; i += 1) {
        const tr = latestToolResults[i];
        lines.push(`\n[Tool Result #${i + 1}] ${tr.toolName} (id: ${tr.toolCallId})`);
        lines.push(tr.content || (isZh ? "(空)" : "(empty)"));
      }
    } else if (toolResultCount === 0) {
      lines.push("");
      lines.push(isZh ? "=== 📋 Tool Results ===" : "=== 📋 Tool Results ===");
      lines.push(isZh ? "(本次请求没有 tool result，这是首次 LLM 调用或 LLM 继续生成)" : "(No tool results - this is initial LLM call or continuation)");
    }
  }

  // 🆕 提取并高亮显示 function response（Google Generative AI format）
  const latestFuncResponses: Array<{ funcName: string; response: string }> = [];
  
  if (contents && contents.length > 0) {
    // 从后往前找最新的 function response
    for (let i = contents.length - 1; i >= 0; i -= 1) {
      const c = contents[i];
      if (!isRecord(c)) continue;
      const role = typeof c.role === "string" ? c.role : "unknown";
      if ((role === "function" || role === "model") && Array.isArray(c.parts)) {
        for (const part of c.parts) {
          if (!isRecord(part)) continue;
          if (part.functionResponse && isRecord(part.functionResponse)) {
            const funcResp = part.functionResponse;
            const funcName = typeof funcResp.name === "string" ? funcResp.name : "unknown";
            const response = funcResp.response;
            let respStr = "";
            if (typeof response === "string") {
              respStr = response;
            } else if (response && typeof response === "object") {
              respStr = JSON.stringify(response, null, 2);
            }
            latestFuncResponses.unshift({ funcName, response: respStr });
          }
        }
      } else if (role === "user") {
        // 遇到 user 消息，说明已经找到了最新一轮的 function response
        break;
      }
    }
    
    if (latestFuncResponses.length > 0) {
      if (latestToolResults.length === 0) {
        lines.push("");
        lines.push(isZh ? "=== 🎯 最新 Function Responses (本轮函数执行结果) ===" : "=== 🎯 Latest Function Responses ===");
      }
      for (let i = 0; i < latestFuncResponses.length; i += 1) {
        const fr = latestFuncResponses[i];
        lines.push(`\n[Function Response #${i + 1}] ${fr.funcName}`);
        lines.push(fr.response || (isZh ? "(空)" : "(empty)"));
      }
    } else if (latestToolResults.length === 0 && toolResultCount === 0) {
      if (latestToolResults.length === 0) {
        lines.push("");
        lines.push(isZh ? "=== 📋 Function Responses ===" : "=== 📋 Function Responses ===");
      }
      lines.push(isZh ? "(本次请求没有 tool result，这是首次 LLM 调用或 LLM 继续生成)" : "(No tool results - this is initial LLM call or continuation)");
    }
  }

  // 🆕 显示完整的 contents（Google Generative AI format）- 默认折叠
  if (contents && contents.length > 0) {
    lines.push("");
    lines.push(isZh ? "=== 📚 完整对话历史 (可折叠) ===" : "=== 📚 Full Conversation History (Collapsible) ===");
    lines.push(isZh ? `(共 ${contents.length} 条消息，点击"查看全文"按钮展开查看)` : `(${contents.length} messages total, click "Show full" to expand)`);
    lines.push("");
    lines.push(isZh ? "💡 提示：重点关注上方的「最新 Tool Results」部分" : "💡 Tip: Focus on the 'Latest Tool Results' section above");
  }

  // 显示其他消息（user/assistant）- 简化版本
  if (messages && messages.length > 0) {
    lines.push("");
    lines.push(isZh ? "=== 💬 对话摘要 ===" : "=== 💬 Conversation Summary ===");
    let userCount = 0;
    let assistantCount = 0;
    let toolCount = 0;
    for (const m of messages) {
      if (!isRecord(m)) continue;
      const role = typeof m.role === "string" ? m.role : "unknown";
      if (role === "user") userCount++;
      else if (role === "assistant") assistantCount++;
      else if (role === "tool" || role === "toolResult") toolCount++;
    }
    lines.push(isZh 
      ? `用户消息: ${userCount} 条 | AI 回复: ${assistantCount} 条 | Tool Results: ${toolCount} 条`
      : `User: ${userCount} | Assistant: ${assistantCount} | Tool Results: ${toolCount}`);
  }

  const out = lines.join("\n").trimEnd();
  return out ? out : null;
}

function collapseBlankLines(text: string): string {
  // 最多保留 2 个连续空行，避免过度压缩
  return text.replace(/\n{4,}/g, "\n\n\n");
}

/**
 * 检测是否为批量 tool calls（短时间内的多个工具审批）
 * 返回批量信息或 null
 */
function detectBatchToolCalls(queue: LlmApprovalRequest[]): {
  count: number;
  tools: Array<{ name: string; phase: string; summary: string }>;
} | null {
  if (queue.length < 2) return null;
  
  // 检查前 N 个请求是否都是 tool 审批
  const BATCH_WINDOW_MS = 2000; // 2 秒内的请求视为一批
  const MAX_BATCH_SIZE = 10; // 最多聚合 10 个
  
  const first = queue[0];
  const firstTime = first.createdAtMs;
  const batchItems: Array<{ name: string; phase: string; summary: string }> = [];
  
  for (let i = 0; i < Math.min(queue.length, MAX_BATCH_SIZE); i++) {
    const item = queue[i];
    
    // 检查时间窗口
    if (item.createdAtMs - firstTime > BATCH_WINDOW_MS) {
      break;
    }
    
    // 检查是否是 tool 审批（URL 以 tool:// 开头）
    if (!item.request.url?.startsWith("tool://")) {
      break;
    }
    
    // 提取工具信息
    const toolName = item.request.url.replace("tool://", "");
    const phase = item.request.headers?.["X-Tool-Phase"] || "unknown";
    const summary = item.request.bodySummary || toolName;
    
    batchItems.push({ name: toolName, phase, summary });
  }
  
  // 至少 2 个才算批量
  if (batchItems.length < 2) return null;
  
  return {
    count: batchItems.length,
    tools: batchItems,
  };
}

export function renderLlmApprovalPrompt(state: AppViewState) {
  const active = state.llmApprovalQueue[0];
  if (!active) return nothing;
  const request = active.request;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining = remainingMs > 0 ? `expires in ${formatRemaining(remainingMs)}` : "expired";
  const queueCount = state.llmApprovalQueue.length;
  // 默认展开显示完整内容，美化格式
  const showFull = state.llmApprovalShowFullPayload !== false; // 默认 true
  const displayMode = state.llmApprovalDisplayMode ?? "pretty"; // 默认 pretty
  const isZh = state.settings.uiLanguage === "zh";
  const l10n = getUiL10n(state.settings.uiLanguage);

  // 🆕 检测批量 tool calls（只有在批量模式启用时才检测）
  const batchInfo = state.llmApprovalBatchMode ? detectBatchToolCalls(state.llmApprovalQueue) : null;

  const truncated =
    typeof request.bodyText === "string" && request.bodyText.includes("... truncated (") ? "yes" : "no";

  const payloadText = (() => {
    const headerLines = Object.entries(request.headers ?? {})
      .slice(0, 50)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    const body = request.bodyText ?? request.bodySummary ?? "";
    const combined = [
      request.method ? `${request.method} ${request.url}` : request.url,
      headerLines ? `\n${headerLines}` : "",
      body ? `\n\n${body}` : "",
    ].join("\n");
    return combined.trim();
  })();

  const fullText = (() => {
    if (displayMode === "raw") {
      return payloadText; // 直接返回原始文本，保留真实换行符
    }

    const prettyBody = request.bodyText
      ? tryPrettyOpenAiPayload(request.bodyText, isZh) ?? tryPrettyJson(request.bodyText)
      : null;
    const prettyPayload = prettyBody
      ? (() => {
          const headerLines = Object.entries(request.headers ?? {})
            .slice(0, 50)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n");
          return [
            request.method ? `${request.method} ${request.url}` : request.url,
            headerLines ? `\n${headerLines}` : "",
            `\n\n${prettyBody}`,
          ]
            .join("\n")
            .trim();
        })()
      : payloadText;

    return collapseBlankLines(prettyPayload);
  })();

  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">
              ${isZh ? "需要 LLM 审批" : "LLM approval needed"}
              ${batchInfo ? html`<span style="color: var(--warning, #f59e0b); margin-left: 8px;">
                ${isZh ? `批量 (${batchInfo.count} 个工具)` : `Batch (${batchInfo.count} tools)`}
              </span>` : nothing}
            </div>
            <div class="exec-approval-sub">
              ${isZh
                ? `${remaining} · 失败后最多自动重试 1 次（超过将被阻断）`
                : `${remaining} · At most 1 automatic retry after failure (then blocked)`}
            </div>
          </div>
          ${queueCount > 1
            ? html`<div class="exec-approval-queue">${queueCount} pending</div>`
            : nothing}
        </div>

        <div class="exec-approval-body">
          ${batchInfo ? html`
            <div class="exec-approval-batch-summary" style="
              background: var(--bg-warning, #fffbeb);
              border: 1px solid var(--warning, #f59e0b);
              border-radius: 4px;
              padding: 12px;
              margin-bottom: 12px;
            ">
              <div style="font-weight: 600; color: var(--warning, #f59e0b); margin-bottom: 8px;">
                ${isZh ? `🔧 LLM 想要执行 ${batchInfo.count} 个工具：` : `🔧 LLM wants to execute ${batchInfo.count} tools:`}
              </div>
              <div style="display: flex; flex-direction: column; gap: 6px;">
                ${batchInfo.tools.map((tool, index) => html`
                  <div style="
                    display: flex;
                    align-items: flex-start;
                    gap: 8px;
                    padding: 6px;
                    background: var(--bg, white);
                    border-radius: 3px;
                    font-size: 13px;
                  ">
                    <span style="
                      min-width: 20px;
                      font-weight: 600;
                      color: var(--text-muted, #666);
                    ">${index + 1}.</span>
                    <div style="flex: 1; min-width: 0;">
                      <div style="font-weight: 600; color: var(--text, #000);">
                        ${tool.name}
                        <span style="
                          margin-left: 6px;
                          font-size: 11px;
                          font-weight: normal;
                          color: var(--text-muted, #666);
                          background: var(--bg-secondary, #f3f4f6);
                          padding: 2px 6px;
                          border-radius: 3px;
                        ">${tool.phase === "before" ? (isZh ? "执行前" : "before") : isZh ? "执行后" : "after"}</span>
                      </div>
                      <div style="
                        margin-top: 4px;
                        font-size: 12px;
                        color: var(--text-muted, #666);
                        white-space: pre-wrap;
                        word-break: break-word;
                      ">${tool.summary.replace(/\\n/g, "\n")}</div>
                    </div>
                  </div>
                `)}
              </div>
              <div style="
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid var(--border, #e5e7eb);
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
              ">
                <button
                  class="btn primary"
                  style="flex: 1; min-width: 120px;"
                  ?disabled=${state.llmApprovalBusy}
                  @click=${async () => {
                    // 批量批准所有工具
                    for (let i = 0; i < batchInfo.count; i++) {
                      if (state.llmApprovalQueue.length > 0) {
                        await state.handleLlmApprovalDecision("allow-once");
                      }
                    }
                  }}
                >
                  ${isZh ? `✅ 全部批准 (${batchInfo.count})` : `✅ Approve All (${batchInfo.count})`}
                </button>
                <button
                  class="btn danger"
                  style="flex: 1; min-width: 120px;"
                  ?disabled=${state.llmApprovalBusy}
                  @click=${async () => {
                    // 批量拒绝所有工具
                    for (let i = 0; i < batchInfo.count; i++) {
                      if (state.llmApprovalQueue.length > 0) {
                        await state.handleLlmApprovalDecision("deny");
                      }
                    }
                  }}
                >
                  ${isZh ? `❌ 全部拒绝 (${batchInfo.count})` : `❌ Deny All (${batchInfo.count})`}
                </button>
                <button
                  class="btn"
                  style="min-width: 100px;"
                  @click=${() => {
                    // 切换到逐个审批模式（关闭批量视图）
                    state.llmApprovalBatchMode = false;
                  }}
                >
                  ${isZh ? "逐个审批" : "Review One by One"}
                </button>
              </div>
            </div>
          ` : nothing}
          
          ${(() => {
            // 🎯 优先检查 tool result（工具执行结果）
            const toolResultDetail = request.bodyText ? extractLatestToolResult(request.bodyText, isZh) : null;
            if (toolResultDetail) {
              return html`
                <div class="exec-approval-tool-result">
                  <div class="exec-approval-tool-result-label">
                    ${isZh ? "🛠️ 工具执行结果" : "🛠️ Tool Execution Result"}
                  </div>
                  <pre class="exec-approval-tool-result-content" style="white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;">${toolResultDetail}</pre>
                </div>
              `;
            }
            
            // 🎯 如果没有 tool result，检查是否有 tool call（LLM 即将调用的工具）
            const toolCallDetail = request.bodyText ? extractLatestToolCalls(request.bodyText, isZh) : null;
            if (toolCallDetail) {
              return html`
                <div class="exec-approval-tool-result" style="background: var(--bg-warning, #fffbeb); border-color: var(--warning, #f59e0b);">
                  <div class="exec-approval-tool-result-label" style="color: var(--warning, #f59e0b);">
                    ${isZh ? "🔧 AI 即将调用工具" : "🔧 AI Will Call Tools"}
                  </div>
                  <pre class="exec-approval-tool-result-content" style="white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;">${toolCallDetail}</pre>
                </div>
              `;
            }
            
            // 降级：显示简短的 bodySummary
            return html`
              <div class="exec-approval-command mono">
                ${request.bodySummary ?? request.method ?? "request"}
              </div>
            `;
          })()}
          <div class="exec-approval-meta">
            ${renderMetaRow(isZh ? "提供方" : "Provider", request.provider)}
            ${renderMetaRow(isZh ? "模型" : "Model", request.modelId)}
            ${renderMetaRow(isZh ? "来源" : "Source", request.source)}
            ${renderMetaRow(isZh ? "会话" : "Session", request.sessionKey)}
            ${renderMetaRow("RunId", request.runId)}
            ${renderMetaRow("URL", request.url)}
            ${renderMetaRow(isZh ? "是否截断" : "Truncated", truncated)}
          </div>
          
          ${request.bodySummary ? html`
            <div style="
              margin: 12px 0;
              padding: 12px;
              background: var(--bg-secondary, #f3f4f6);
              border-radius: 4px;
              border-left: 3px solid var(--primary, #3b82f6);
            ">
              <div style="font-weight: 600; margin-bottom: 8px; color: var(--text, #000);">
                ${isZh ? "📋 请求摘要" : "📋 Request Summary"}
              </div>
              <pre style="
                margin: 0;
                white-space: pre-wrap;
                word-wrap: break-word;
                font-family: monospace;
                font-size: 13px;
                line-height: 1.5;
                color: var(--text, #000);
              ">${request.bodySummary}</pre>
            </div>
          ` : nothing}
          
          <div style="display:flex; gap:8px; align-items:center; flex-wrap: wrap;">
            <button class="btn" @click=${() => (state.llmApprovalShowFullPayload = !showFull)}>
              ${showFull ? (isZh ? "查看摘要" : "Show summary") : isZh ? "查看全文" : "Show full"}
            </button>
            <button
              class="btn"
              @click=${() => (state.llmApprovalDisplayMode = displayMode === "raw" ? "pretty" : "raw")}
              title=${
                displayMode === "raw"
                  ? isZh
                    ? "当前：原文（保留格式）"
                    : "Current: raw (preserve formatting)"
                  : isZh
                    ? "当前：美化（结构化显示）"
                    : "Current: pretty (structured)"
              }
            >
              ${displayMode === "raw" ? (isZh ? "切到美化" : "Pretty") : isZh ? "切到原文" : "Raw"}
            </button>
            <span class="muted" style="font-size:12px; user-select:none;">
              ${showFull
                ? isZh
                  ? "脱敏全文"
                  : "Redacted full"
                : isZh
                  ? "摘要"
                  : "Summary"}
              ·
              ${displayMode === "raw"
                ? isZh
                  ? "原文（保留格式）"
                  : "Raw (formatted)"
                : isZh
                  ? "美化（结构化）"
                  : "Pretty (structured)"}
            </span>
          </div>
          ${showFull
            ? html`<pre
                class="exec-approval-command exec-approval-command--scroll exec-approval-command--${displayMode} mono"
                style="white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;"
              >${displayMode === "pretty" ? fullText : fullText}</pre>`
            : nothing}
          ${state.llmApprovalError
            ? html`<div class="exec-approval-error">${state.llmApprovalError}</div>`
            : nothing}
        </div>

        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${state.llmApprovalBusy}
            @click=${() => state.handleLlmApprovalDecision("allow-once")}
          >
            ${isZh ? "允许一次" : "Allow once"}
          </button>
          <button
            class="btn"
            ?disabled=${state.llmApprovalBusy}
            @click=${() => state.handleLlmApprovalDecision("allow-always")}
          >
            ${isZh ? "总是允许" : "Always allow"}
          </button>
          <button
            class="btn danger"
            ?disabled=${state.llmApprovalBusy}
            @click=${() => state.handleLlmApprovalDecision("deny")}
          >
            ${l10n.approval.deny}
          </button>
        </div>
      </div>
    </div>
  `;
}
