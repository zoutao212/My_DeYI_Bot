import { loadChatHistory } from "./controllers/chat";
import { loadDevices } from "./controllers/devices";
import { loadNodes } from "./controllers/nodes";
import { loadAgents } from "./controllers/agents";
import type { GatewayEventFrame, GatewayHelloOk } from "./gateway";
import { GatewayBrowserClient } from "./gateway";
import type { EventLogEntry } from "./app-events";
import type { AgentsListResult, PresenceEntry, HealthSnapshot, StatusSummary } from "./types";
import type { Tab } from "./navigation";
import type { UiSettings } from "./storage";
import { handleAgentEvent, resetToolStream, type AgentEventPayload } from "./app-tool-stream";
import { flushChatQueueForEvent } from "./app-chat";
import {
  applySettings,
  loadCron,
  refreshActiveTab,
  setLastActiveSessionKey,
} from "./app-settings";
import { handleChatEvent, type ChatEventPayload } from "./controllers/chat";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  removeExecApproval,
} from "./controllers/exec-approval";
import {
  addLlmApproval,
  parseLlmApprovalRequested,
  parseLlmApprovalResolved,
  removeLlmApproval,
} from "./controllers/llm-approval";
import type { ClawdbotApp } from "./app";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import { loadAssistantIdentity } from "./controllers/assistant-identity";

type GatewayHost = {
  settings: UiSettings;
  password: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  tab: Tab;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  debugHealth: HealthSnapshot | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  runEvents: Array<{
    ts: number;
    sessionKey?: string;
    runId?: string;
    kind: string;
    payload?: unknown;
  }>;
  activityLog: Array<{
    ts: number;
    kind: "reply" | "error" | "llm" | "tool";
    sessionKey?: string;
    summary: string;
  }>;
  chatRunId: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
  llmApprovalQueue: import("./controllers/llm-approval").LlmApprovalRequest[];
  llmApprovalError: string | null;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) return raw;
  if (!raw) return mainSessionKey;
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` ||
        raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) return;
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  // 优先用 lastActiveSessionKey（上次活跃 session），避免把用户上次的 session 覆盖为 main
  const nextSessionKey = resolvedLastActiveSessionKey || resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

export function connectGateway(host: GatewayHost) {
  host.lastError = null;
  host.hello = null;
  host.connected = false;
  host.execApprovalQueue = [];
  host.execApprovalError = null;
  host.llmApprovalQueue = [];
  host.llmApprovalError = null;

  host.client?.stop();
  // 断连时若有活跃 run，记录下来；重连后 onHello 据此跳过 loadChatHistory，
  // 避免会话文件未落盘时把本地消息（含用户消息）覆盖成空列表。
  let hadRunOnDisconnect = false;
  host.client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "clawdbot-control-ui",
    mode: "webchat",
    onHello: (hello) => {
      host.connected = true;
      host.lastError = null;
      host.hello = hello;
      applySnapshot(host, hello);
      void loadAssistantIdentity(host as unknown as ClawdbotApp);
      void loadAgents(host as unknown as ClawdbotApp);
      void loadNodes(host as unknown as ClawdbotApp, { quiet: true });
      void loadDevices(host as unknown as ClawdbotApp, { quiet: true });
      void refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
      // 重连时若断连前有活跃 run，跳过 loadChatHistory：
      // 聊天室短路模式下，会话文件尚未落盘，立即回读会把本地消息（含用户消息）覆盖成空列表。
      // run 结束后 chat.final 事件会负责更新 UI，无需在此回读。
      const skipLoad = hadRunOnDisconnect || Boolean(host.chatRunId);
      hadRunOnDisconnect = false;
      if (!skipLoad) {
        void loadChatHistory(host as unknown as ClawdbotApp);
      }
    },
    onClose: ({ code, reason }) => {
      host.connected = false;
      if (host.chatRunId) {
        hadRunOnDisconnect = true;
        host.chatRunId = null;
        resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      }
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      if (code !== 1012) {
        host.lastError = `disconnected (${code}): ${reason || "no reason"}`;
      }
    },
    onEvent: (evt) => handleGatewayEvent(host, evt),
    onGap: ({ expected, received }) => {
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); refresh recommended`;
    },
  });
  host.client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (host.tab === "debug") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent") {
    if (host.onboarding) return;
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      evt.payload as AgentEventPayload | undefined,
    );
    return;
  }

  if (evt.event === "run") {
    const payload = evt.payload as
      | {
          ts?: number;
          sessionKey?: string;
          runId?: string;
          kind?: string;
          payload?: unknown;
        }
      | undefined;
    const sessionKey = payload?.sessionKey?.trim();
    const entry = {
      ts: typeof payload?.ts === "number" ? payload.ts : Date.now(),
      sessionKey,
      runId: payload?.runId,
      kind: typeof payload?.kind === "string" && payload.kind.trim() ? payload.kind : "run",
      payload: payload?.payload,
    };
    host.runEvents = [entry, ...(host.runEvents ?? [])].slice(0, 800);

    // 推送关键 run 事件到活动日志
    const kind = entry.kind;
    if (kind === "llm.done" || kind === "tool.start" || kind === "tool.end") {
      const inner = entry.payload as Record<string, unknown> | undefined;
      let summary: string;
      if (kind === "llm.done") {
        const model = typeof inner?.model === "string" ? inner.model : "";
        const tokens = typeof inner?.totalTokens === "number" ? inner.totalTokens : null;
        summary = `LLM 调用完成${model ? ` [${model}]` : ""}${tokens != null ? ` (${tokens} tokens)` : ""}`;
      } else if (kind === "tool.start") {
        const toolName = typeof inner?.toolName === "string" ? inner.toolName : "?";
        summary = `工具调用开始: ${toolName}`;
      } else {
        const toolName = typeof inner?.toolName === "string" ? inner.toolName : "?";
        const ok = inner?.error ? "失败" : "完成";
        summary = `工具调用${ok}: ${toolName}`;
      }
      host.activityLog = [
        {
          ts: entry.ts,
          kind: kind === "llm.done" ? "llm" as const : "tool" as const,
          sessionKey,
          summary,
        },
        ...host.activityLog,
      ].slice(0, 100);
    }
    return;
  }

  if (evt.event === "chat") {
    const payload = evt.payload as ChatEventPayload | undefined;
    if (payload?.sessionKey) {
      setLastActiveSessionKey(
        host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
        payload.sessionKey,
      );
    }
    const state = handleChatEvent(host as unknown as ClawdbotApp, payload);

    // 推送活动日志：AI 回复完成或出错
    if (state === "final") {
      host.activityLog = [
        {
          ts: Date.now(),
          kind: "reply" as const,
          sessionKey: payload?.sessionKey,
          summary: `AI 回复完成 [${payload?.sessionKey ?? "?"}]`,
        },
        ...host.activityLog,
      ].slice(0, 100);
    } else if (state === "error") {
      host.activityLog = [
        {
          ts: Date.now(),
          kind: "error" as const,
          sessionKey: payload?.sessionKey,
          summary: `AI 回复出错 [${payload?.sessionKey ?? "?"}]: ${payload?.errorMessage ?? "unknown"}`,
        },
        ...host.activityLog,
      ].slice(0, 100);
    }

    if (state === "final" || state === "error" || state === "aborted") {
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      void flushChatQueueForEvent(
        host as unknown as Parameters<typeof flushChatQueueForEvent>[0],
      );
    }
    // 聊天室短路/流式场景下，final 事件可能先于会话文件落盘；
    // 立即回读历史会把刚写入的本地消息覆盖成空列表，导致 UI 看起来“没显示”。
    // 仅当 final 不带 message（本地无可显示内容）时再回读历史兜底。
    if (state === "final" && !payload?.message) {
      void loadChatHistory(host as unknown as ClawdbotApp);
    }
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === "cron" && host.tab === "cron") {
    void loadCron(host as unknown as Parameters<typeof loadCron>[0]);
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as ClawdbotApp, { quiet: true });
  }

  if (evt.event === "exec.approval.requested") {
    const entry = parseExecApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      window.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
  }

  if (evt.event === "llm.approval.requested") {
    const entry = parseLlmApprovalRequested(evt.payload);
    if (entry) {
      console.log(`[UI] 📥 收到审批请求：id=${entry.id}, provider=${entry.request.provider}, model=${entry.request.modelId}`);
      console.log(`[UI] 📊 当前队列长度：${host.llmApprovalQueue.length} → ${host.llmApprovalQueue.length + 1}`);
      host.llmApprovalQueue = addLlmApproval(host.llmApprovalQueue, entry);
      host.llmApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      window.setTimeout(() => {
        console.log(`[UI] ⏰ 审批请求超时自动移除：id=${entry.id}`);
        host.llmApprovalQueue = removeLlmApproval(host.llmApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "llm.approval.resolved") {
    const resolved = parseLlmApprovalResolved(evt.payload);
    if (resolved) {
      console.log(`[UI] ✅ 收到审批决策：id=${resolved.id}, decision=${resolved.decision}`);
      console.log(`[UI] 📊 当前队列长度：${host.llmApprovalQueue.length} → ${host.llmApprovalQueue.length - 1}`);
      host.llmApprovalQueue = removeLlmApproval(host.llmApprovalQueue, resolved.id);
      console.log(`[UI] 📊 移除后队列长度：${host.llmApprovalQueue.length}`);
      if (host.llmApprovalQueue.length > 0) {
        console.log(`[UI] 🔔 队列中还有 ${host.llmApprovalQueue.length} 个待审批请求`);
      }
    }
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        presence?: PresenceEntry[];
        health?: HealthSnapshot;
        sessionDefaults?: SessionDefaultsSnapshot;
      }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
}
