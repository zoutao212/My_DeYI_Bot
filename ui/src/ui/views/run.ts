import { html, nothing } from "lit";

export type RunEventFrame = {
  ts: number;
  sessionKey?: string;
  runId?: string;
  kind: string;
  payload?: unknown;
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function renderRun(params: {
  events: RunEventFrame[];
  connected: boolean;
  sessionKey: string;
  onClear?: () => void;
}) {
  // 默认隐藏运行面板，避免干扰用户体验
  // 如果需要查看运行事件，可以在 Debug 标签页查看
  return nothing;
  
  const events = Array.isArray(params.events) ? params.events : [];

  const byRun = new Map<string, RunEventFrame[]>();
  const noRun: RunEventFrame[] = [];
  for (const evt of events) {
    const id = (evt.runId ?? "").trim();
    if (!id) {
      noRun.push(evt);
      continue;
    }
    const list = byRun.get(id) ?? [];
    list.push(evt);
    byRun.set(id, list);
  }

  const runIds = Array.from(byRun.keys()).sort((a, b) => {
    const aLast = byRun.get(a)?.at(0)?.ts ?? 0;
    const bLast = byRun.get(b)?.at(0)?.ts ?? 0;
    return bLast - aLast;
  });

  return html`
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">运行面板</div>
          <div class="card-sub">实时事件流（不依赖最终回复）。当前会话：${params.sessionKey}</div>
        </div>
        <div class="card-actions">
          <button class="button" ?disabled=${!params.onClear} @click=${() => params.onClear?.()}>
            清空
          </button>
        </div>
      </div>
      <div class="card-body">
        ${!params.connected
          ? html`<div class="pill danger">未连接到网关，无法接收 run 事件。</div>`
          : nothing}

        ${runIds.length === 0 && noRun.length === 0
          ? html`<div class="muted">暂无事件。请在聊天里触发一次工具/模型调用后再看这里。</div>`
          : nothing}

        ${runIds.map((runId) => {
          const list = (byRun.get(runId) ?? []).slice().sort((a, b) => b.ts - a.ts);
          const head = list[0];
          const title = head ? `${runId}（${formatTs(head.ts)}）` : runId;
          return html`
            <details class="details" open>
              <summary class="details-summary">${title}</summary>
              <div class="details-body">
                ${list.map((evt) => {
                  const ts = formatTs(evt.ts);
                  const kind = (evt.kind ?? "").trim();
                  return html`
                    <details class="details">
                      <summary class="details-summary">
                        <span class="pill">${ts}</span>
                        <span class="pill">${kind}</span>
                      </summary>
                      <pre class="codeblock">${safeJson(evt.payload)}</pre>
                    </details>
                  `;
                })}
              </div>
            </details>
          `;
        })}

        ${noRun.length > 0
          ? html`
              <details class="details">
                <summary class="details-summary">未绑定 runId 的事件（${noRun.length}）</summary>
                <div class="details-body">
                  ${noRun
                    .slice()
                    .sort((a, b) => b.ts - a.ts)
                    .map(
                      (evt) => html`<pre class="codeblock">${safeJson(evt)}</pre>`,
                    )}
                </div>
              </details>
            `
          : nothing}
      </div>
    </div>
  `;
}
