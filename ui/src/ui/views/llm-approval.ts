import { html, nothing } from "lit";

import type { AppViewState } from "../app-view-state";

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

export function renderLlmApprovalPrompt(state: AppViewState) {
  const active = state.llmApprovalQueue[0];
  if (!active) return nothing;
  const request = active.request;
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining = remainingMs > 0 ? `expires in ${formatRemaining(remainingMs)}` : "expired";
  const queueCount = state.llmApprovalQueue.length;
  const showFull = Boolean(state.llmApprovalShowFullPayload);

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

  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">LLM approval needed</div>
            <div class="exec-approval-sub">${remaining}</div>
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
            ${renderMetaRow("Provider", request.provider)}
            ${renderMetaRow("Model", request.modelId)}
            ${renderMetaRow("Source", request.source)}
            ${renderMetaRow("Session", request.sessionKey)}
            ${renderMetaRow("RunId", request.runId)}
            ${renderMetaRow("URL", request.url)}
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button class="btn" @click=${() => (state.llmApprovalShowFullPayload = !showFull)}>
              ${showFull ? "查看摘要" : "查看全文"}
            </button>
            <span class="muted" style="font-size:12px; user-select:none;">
              ${showFull ? "脱敏全文" : "摘要"}
            </span>
          </div>
          ${showFull
            ? html`<div class="exec-approval-command mono" style="max-height: 260px; overflow:auto;">${payloadText}</div>`
            : request.bodySummary
              ? html`<div class="exec-approval-command mono" style="max-height: 160px; overflow:auto;">${request.bodySummary}</div>`
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
            Allow once
          </button>
          <button
            class="btn"
            ?disabled=${state.llmApprovalBusy}
            @click=${() => state.handleLlmApprovalDecision("allow-always")}
          >
            Always allow
          </button>
          <button
            class="btn danger"
            ?disabled=${state.llmApprovalBusy}
            @click=${() => state.handleLlmApprovalDecision("deny")}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  `;
}
