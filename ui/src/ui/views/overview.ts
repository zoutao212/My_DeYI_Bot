import { html } from "lit";

import type { GatewayHelloOk } from "../gateway";
import { formatAgo, formatDurationMs } from "../format";
import { formatNextRun } from "../presenter";
import type { UiSettings } from "../storage";
import { getUiL10n } from "../ui-l10n";

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
};

export function renderOverview(props: OverviewProps) {
  const l10n = getUiL10n(props.settings.uiLanguage);
  const snapshot = props.hello?.snapshot as
    | { uptimeMs?: number; policy?: { tickIntervalMs?: number } }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationMs(snapshot.uptimeMs) : "n/a";
  const tick = snapshot?.policy?.tickIntervalMs
    ? `${snapshot.policy.tickIntervalMs}ms`
    : "n/a";
  const authHint = (() => {
    if (props.connected || !props.lastError) return null;
    const lower = props.lastError.toLowerCase();
    const authFailed = lower.includes("unauthorized") || lower.includes("connect failed");
    if (!authFailed) return null;
    const hasToken = Boolean(props.settings.token.trim());
    const hasPassword = Boolean(props.password.trim());
    if (!hasToken && !hasPassword) {
      return html`
        <div class="muted" style="margin-top: 8px;">
          This gateway requires auth. Add a token or password, then click Connect.
          <div style="margin-top: 6px;">
            <span class="mono">clawdbot dashboard --no-open</span> → tokenized URL<br />
            <span class="mono">clawdbot doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px;">
            <a
              class="session-link"
              href="https://docs.clawd.bot/web/dashboard"
              target="_blank"
              rel="noreferrer"
              title="Control UI auth docs (opens in new tab)"
              >Docs: Control UI auth</a
            >
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 8px;">
        Auth failed. Re-copy a tokenized URL with
        <span class="mono">clawdbot dashboard --no-open</span>, or update the token,
        then click Connect.
        <div style="margin-top: 6px;">
          <a
            class="session-link"
            href="https://docs.clawd.bot/web/dashboard"
            target="_blank"
            rel="noreferrer"
            title="Control UI auth docs (opens in new tab)"
            >Docs: Control UI auth</a
          >
        </div>
      </div>
    `;
  })();
  const insecureContextHint = (() => {
    if (props.connected || !props.lastError) return null;
    const isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true;
    if (isSecureContext !== false) return null;
    const lower = props.lastError.toLowerCase();
    if (!lower.includes("secure context") && !lower.includes("device identity required")) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px;">
        This page is HTTP, so the browser blocks device identity. Use HTTPS (Tailscale Serve) or
        open <span class="mono">http://127.0.0.1:18789</span> on the gateway host.
        <div style="margin-top: 6px;">
          If you must stay on HTTP, set
          <span class="mono">gateway.controlUi.allowInsecureAuth: true</span> (token-only).
        </div>
        <div style="margin-top: 6px;">
          <a
            class="session-link"
            href="https://docs.clawd.bot/gateway/tailscale"
            target="_blank"
            rel="noreferrer"
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.clawd.bot/web/control-ui#insecure-http"
            target="_blank"
            rel="noreferrer"
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">${l10n.overview.gatewayAccessTitle}</div>
        <div class="card-sub">${l10n.overview.gatewayAccessSub}</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>${l10n.overview.websocketUrl}</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: v });
              }}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          <label class="field">
            <span>${l10n.overview.gatewayToken}</span>
            <input
              .value=${props.settings.token}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, token: v });
              }}
              placeholder="CLAWDBOT_GATEWAY_TOKEN"
            />
          </label>
          <label class="field">
            <span>${l10n.overview.uiLanguage}</span>
            <select
              .value=${props.settings.uiLanguage}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                props.onSettingsChange({
                  ...props.settings,
                  uiLanguage: v === "zh" ? "zh" : "en",
                });
              }}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <label class="field">
            <span>${l10n.overview.systemPromptLanguage}</span>
            <select
              id="system-prompt-language"
              .value=${props.settings.systemPromptLanguage}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                props.onSettingsChange({
                  ...props.settings,
                  systemPromptLanguage: v === "zh" ? "zh" : "en",
                });
              }}
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
          </label>
          <label class="field">
            <span>${l10n.overview.passwordNotStored}</span>
            <input
              type="password"
              .value=${props.password}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onPasswordChange(v);
              }}
              placeholder="system or shared password"
            />
          </label>
          <label class="field">
            <span>${l10n.overview.defaultSessionKey}</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSessionKeyChange(v);
              }}
            />
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>${l10n.overview.connect}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${l10n.overview.refresh}</button>
          <span class="muted">${l10n.overview.connectHint}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${l10n.overview.snapshotTitle}</div>
        <div class="card-sub">${l10n.overview.snapshotSub}</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${l10n.overview.snapshotStatusLabel}</div>
            <div class="stat-value ${props.connected ? "ok" : "warn"}">
              ${props.connected
                ? l10n.overview.snapshotStatusConnected
                : l10n.overview.snapshotStatusDisconnected}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${l10n.overview.snapshotUptimeLabel}</div>
            <div class="stat-value">${uptime}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${l10n.overview.snapshotTickLabel}</div>
            <div class="stat-value">${tick}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${l10n.overview.snapshotLastChannelsRefreshLabel}</div>
            <div class="stat-value">
              ${props.lastChannelsRefresh
                ? formatAgo(props.lastChannelsRefresh)
                : "n/a"}
            </div>
          </div>
        </div>
        ${props.lastError
          ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${props.lastError}</div>
              ${authHint ?? ""}
              ${insecureContextHint ?? ""}
            </div>`
          : html`<div class="callout" style="margin-top: 14px;">
              ${l10n.overview.snapshotConnectChannelsHint}
            </div>`}
      </div>
    </section>

    <section class="grid grid-cols-3" style="margin-top: 18px;">
      <div class="card stat-card">
        <div class="stat-label">${l10n.overview.statsInstancesLabel}</div>
        <div class="stat-value">${props.presenceCount}</div>
        <div class="muted">${l10n.overview.statsInstancesSub}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">${l10n.overview.statsSessionsLabel}</div>
        <div class="stat-value">${props.sessionsCount ?? "n/a"}</div>
        <div class="muted">${l10n.overview.statsSessionsSub}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">${l10n.overview.statsCronLabel}</div>
        <div class="stat-value">
          ${props.cronEnabled == null
            ? "n/a"
            : props.cronEnabled
              ? l10n.overview.statsCronEnabled
              : l10n.overview.statsCronDisabled}
        </div>
        <div class="muted">${l10n.overview.statsCronSubPrefix} ${formatNextRun(props.cronNext)}</div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${l10n.overview.notesTitle}</div>
      <div class="card-sub">${l10n.overview.notesSub}</div>
      <div class="note-grid" style="margin-top: 14px;">
        <div>
          <div class="note-title">${l10n.overview.notesTailscaleTitle}</div>
          <div class="muted">${l10n.overview.notesTailscaleBody}</div>
        </div>
        <div>
          <div class="note-title">${l10n.overview.notesSessionTitle}</div>
          <div class="muted">${l10n.overview.notesSessionBody}</div>
        </div>
        <div>
          <div class="note-title">${l10n.overview.notesCronTitle}</div>
          <div class="muted">${l10n.overview.notesCronBody}</div>
        </div>
      </div>
    </section>
  `;
}
