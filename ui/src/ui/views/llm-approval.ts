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

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

export function renderLlmApprovalPrompt(state: AppViewState) {
  const active = state.llmApprovalQueue[0];
  if (!active) return nothing;
  const request = active.request;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining = remainingMs > 0 ? `expires in ${formatRemaining(remainingMs)}` : "expired";
  const queueCount = state.llmApprovalQueue.length;
  const showFull = Boolean(state.llmApprovalShowFullPayload);
  const displayMode = state.llmApprovalDisplayMode;
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

    const prettyBody = request.bodyText ? tryPrettyJson(request.bodyText) : null;
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
