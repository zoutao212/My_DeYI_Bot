const KEY = "clawdbot.control.settings.v1";

import type { ThemeMode } from "./theme";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  systemPromptLanguage: "en" | "zh";
  uiLanguage: "en" | "zh";
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeMode;
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navGroupsCollapsed: Record<string, boolean>; // Which nav groups are collapsed
};

export function loadSettings(): UiSettings {
  const defaultUrl = (() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const host = location.hostname;
    const port = location.port;
    const isLocalHost = host === "localhost" || host === "127.0.0.1";
    // 在 Vite dev server (5173) 下，默认连接本机 gateway 的 18789，避免误连到 5173。
    if (isLocalHost && port === "5173") {
      return `${proto}://127.0.0.1:18789`;
    }
    return `${proto}://${location.host}`;
  })();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: "",
    systemPromptLanguage: "en",
    uiLanguage: "zh",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
  };

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<UiSettings>;

    const migrateGatewayUrl = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return defaults.gatewayUrl;
      const host = location.hostname;
      const port = location.port;
      const isLocalHost = host === "localhost" || host === "127.0.0.1";
      // 主动纠错：在 5173 下若历史上保存成 ws://localhost:5173 / ws://127.0.0.1:5173，强制迁移到 18789。
      if (
        isLocalHost &&
        port === "5173" &&
        (trimmed === "ws://localhost:5173" ||
          trimmed === "ws://127.0.0.1:5173" ||
          trimmed === "wss://localhost:5173" ||
          trimmed === "wss://127.0.0.1:5173")
      ) {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        return `${proto}://127.0.0.1:18789`;
      }
      return trimmed;
    };

    return {
      gatewayUrl:
        typeof parsed.gatewayUrl === "string" ? migrateGatewayUrl(parsed.gatewayUrl) : defaults.gatewayUrl,
      token: typeof parsed.token === "string" ? parsed.token : defaults.token,
      systemPromptLanguage:
        parsed.systemPromptLanguage === "zh" || parsed.systemPromptLanguage === "en"
          ? parsed.systemPromptLanguage
          : defaults.systemPromptLanguage,
      uiLanguage:
        parsed.uiLanguage === "zh" || parsed.uiLanguage === "en" ? parsed.uiLanguage : defaults.uiLanguage,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      lastActiveSessionKey:
        typeof parsed.lastActiveSessionKey === "string" &&
        parsed.lastActiveSessionKey.trim()
          ? parsed.lastActiveSessionKey.trim()
          : (typeof parsed.sessionKey === "string" &&
              parsed.sessionKey.trim()) ||
            defaults.lastActiveSessionKey,
      theme:
        parsed.theme === "light" ||
        parsed.theme === "dark" ||
        parsed.theme === "system"
          ? parsed.theme
          : defaults.theme,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean"
          ? parsed.chatFocusMode
          : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean"
          ? parsed.navCollapsed
          : defaults.navCollapsed,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" &&
        parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  localStorage.setItem(KEY, JSON.stringify(next));
}
