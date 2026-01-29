import { html, nothing } from "lit";

import type { AppViewState } from "../app-view-state";
import { getUiL10n } from "../ui-l10n";

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

  if (messages && messages.length > 0) {
    lines.push("");
    lines.push(isZh ? "--- messages ---" : "--- messages ---");
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (!isRecord(m)) continue;
      const role = typeof m.role === "string" ? m.role : "unknown";
      const name = typeof m.name === "string" ? m.name : "";
      const header = name ? `#${i + 1} role=${role} name=${name}` : `#${i + 1} role=${role}`;
      lines.push(header);
      const content = normalizeMessageContentToText(m.content);
      lines.push(content || (isZh ? "(空)" : "(empty)"));
      lines.push("");
    }
  }

  const out = lines.join("\n").trimEnd();
  return out ? out : null;
}

function collapseBlankLines(text: string): string {
  // 最多保留 2 个连续空行，避免过度压缩
  return text.replace(/\n{4,}/g, "\n\n\n");
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
      return visualizeFormatting(payloadText);
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
            <div class="exec-approval-title">${isZh ? "需要 LLM 审批" : "LLM approval needed"}</div>
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
          <div class="exec-approval-command mono">
            ${request.bodySummary ?? request.method ?? "request"}
          </div>
          <div class="exec-approval-meta">
            ${renderMetaRow(isZh ? "提供方" : "Provider", request.provider)}
            ${renderMetaRow(isZh ? "模型" : "Model", request.modelId)}
            ${renderMetaRow(isZh ? "来源" : "Source", request.source)}
            ${renderMetaRow(isZh ? "会话" : "Session", request.sessionKey)}
            ${renderMetaRow("RunId", request.runId)}
            ${renderMetaRow("URL", request.url)}
            ${renderMetaRow(isZh ? "是否截断" : "Truncated", truncated)}
          </div>
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
                    ? "当前：原文（单行+横向滚动）"
                    : "Current: raw (single-line + horizontal scroll)"
                  : isZh
                    ? "当前：美化（自动换行）"
                    : "Current: pretty (wrapped)"
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
                  ? "原文（单行）"
                  : "Raw (single line)"
                : isZh
                  ? "美化（换行）"
                  : "Pretty (wrapped)"}
            </span>
          </div>
          ${showFull
            ? html`<pre
                class="exec-approval-command exec-approval-command--scroll exec-approval-command--${displayMode} mono"
              >${fullText}</pre>`
            : request.bodySummary
              ? html`<pre
                  class="exec-approval-command exec-approval-command--scroll exec-approval-command--pretty mono"
                >${request.bodySummary}</pre>`
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
