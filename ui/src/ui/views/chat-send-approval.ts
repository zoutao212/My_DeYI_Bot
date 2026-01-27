import { html, nothing } from "lit";

import type { AppViewState } from "../app-view-state";
import { getUiL10n } from "../ui-l10n";

function renderMetaRow(label: string, value?: string | null) {
  if (!value) return nothing;
  return html`<div class="exec-approval-meta-row"><span>${label}</span><span>${value}</span></div>`;
}

function resolveSessionModelMeta(state: AppViewState, sessionKey: string): {
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
} {
  const row = state.sessionsResult?.sessions?.find((s) => s.key === sessionKey);
  const defaultsModel = state.sessionsResult?.defaults?.model ?? null;
  const defaultsProvider =
    typeof defaultsModel === "string" && defaultsModel.includes("/")
      ? defaultsModel.split("/")[0] ?? null
      : null;
  const provider = row?.modelProvider ?? defaultsProvider;
  const model = row?.model ?? defaultsModel;
  const thinkingLevel = row?.thinkingLevel ?? state.chatThinkingLevel ?? null;
  return { provider, model, thinkingLevel };
}

export function renderChatSendApprovalPrompt(state: AppViewState) {
  const request = state.chatSendApprovalRequest;
  if (!request) return nothing;

  const l10n = getUiL10n(state.settings.uiLanguage);

  const preview = state.chatSendApprovalPreviewResult;
  const previewError = state.chatSendApprovalPreviewError;
  const previewLoading = state.chatSendApprovalPreviewLoading;
  const meta = resolveSessionModelMeta(state, request.sessionKey);
  const modelRef = preview?.modelRef ?? (meta.provider && meta.model ? `${meta.provider}/${meta.model}` : null);
  const thinkingLevel = preview?.thinkingLevel ?? meta.thinkingLevel;
  const extraSystemPrompt =
    typeof preview?.extraSystemPrompt === "string" ? preview.extraSystemPrompt.trim() : "";
  const clientToolsStatus = typeof preview?.clientToolsStatus === "string" ? preview.clientToolsStatus : "";
  const clientTools = preview?.clientTools;
  const clientToolsCount = Array.isArray(clientTools) ? clientTools.length : 0;
  const attachments = Array.isArray(preview?.attachments) ? preview.attachments : [];

  return html`
    <div
      class="exec-approval-overlay"
      role="dialog"
      aria-live="polite"
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) state.handleChatSendApprovalCancel();
      }}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">Chat send approval needed</div>
            <div class="exec-approval-sub">Review message content before sending</div>
          </div>
          <button class="btn" @click=${() => state.handleChatSendApprovalCancel()} title="Close">
            Close
          </button>
        </div>

        <div class="exec-approval-body">
          <div class="exec-approval-command mono">${request.message}</div>

          <div class="exec-approval-meta">
            ${renderMetaRow("Agent", request.agentId)}
            ${renderMetaRow("Session", request.sessionKey)}
            ${renderMetaRow("Model", modelRef)}
            ${renderMetaRow("Thinking", thinkingLevel)}
            ${previewLoading ? renderMetaRow("Preview", "loading...") : nothing}
            ${previewError ? renderMetaRow("Preview error", previewError) : nothing}
            ${renderMetaRow(
              "Extra system",
              extraSystemPrompt ? "(see below)" : "(none)",
            )}
            ${renderMetaRow(
              "Client tools",
              clientToolsStatus === "not_applicable"
                ? "not applicable"
                : clientToolsCount > 0
                  ? String(clientToolsCount)
                  : "(none)",
            )}
            ${renderMetaRow(
              "Attachments",
              attachments.length > 0 ? String(attachments.length) : "(none)",
            )}
          </div>

          ${attachments.length > 0
            ? html`<div class="exec-approval-command mono">
                ${attachments
                  .map((a) => {
                    const name = typeof a.fileName === "string" && a.fileName.trim() ? a.fileName : "(unnamed)";
                    const mime = typeof a.mimeType === "string" && a.mimeType.trim() ? a.mimeType : "";
                    const bytes = typeof a.bytes === "number" ? `${a.bytes} bytes` : "";
                    const parts = [name, mime, bytes].filter((p) => String(p).trim().length > 0);
                    return parts.join(" ");
                  })
                  .join("\n")}
              </div>`
            : nothing}

          ${extraSystemPrompt
            ? html`<div class="exec-approval-command mono">${extraSystemPrompt}</div>`
            : nothing}
        </div>

        <div class="exec-approval-actions">
          <button
            class="btn"
            @click=${() => {
              state.setTab("overview");
              setTimeout(() => {
                const el = document.getElementById("system-prompt-language");
                el?.scrollIntoView({ block: "center" });
              }, 50);
            }}
          >
            ${l10n.approval.languageSettings}
          </button>
          <button class="btn primary" @click=${() => state.handleChatSendApprovalDecision("allow")}>
            ${l10n.approval.allow}
          </button>
          <button class="btn danger" @click=${() => state.handleChatSendApprovalDecision("deny")}>
            ${l10n.approval.deny}
          </button>
        </div>
      </div>
    </div>
  `;
}
