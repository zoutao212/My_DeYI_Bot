import type { IconName } from "./icons.js";

export const TAB_GROUPS = [
  { label: "Chat", tabs: ["chat"] },
  {
    label: "Control",
    tabs: ["overview", "channels", "instances", "sessions", "cron"],
  },
  { label: "Agent", tabs: ["skills", "nodes"] },
  { label: "Settings", tabs: ["config", "debug", "logs"] },
] as const;

export type Tab =
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "debug"
  | "logs";

const TAB_PATHS: Record<Tab, string> = {
  overview: "/overview",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  cron: "/cron",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  config: "/config",
  debug: "/debug",
  logs: "/logs",
};

const PATH_TO_TAB = new Map(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab]),
);

export function normalizeBasePath(basePath: string): string {
  if (!basePath) return "";
  let base = basePath.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (base === "/") return "";
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

export function normalizePath(path: string): string {
  if (!path) return "/";
  let normalized = path.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = TAB_PATHS[tab];
  return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith("/index.html")) normalized = "/";
  if (normalized === "/") return "chat";
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") return "";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  for (let i = 0; i < segments.length; i++) {
    const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  switch (tab) {
    case "chat":
      return "messageSquare";
    case "overview":
      return "barChart";
    case "channels":
      return "link";
    case "instances":
      return "radio";
    case "sessions":
      return "fileText";
    case "cron":
      return "loader";
    case "skills":
      return "zap";
    case "nodes":
      return "monitor";
    case "config":
      return "settings";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    default:
      return "folder";
  }
}

export function titleForTab(tab: Tab, lang: "en" | "zh" = "en") {
  const zh = lang === "zh";
  switch (tab) {
    case "overview":
      return zh ? "概览" : "Overview";
    case "channels":
      return zh ? "渠道" : "Channels";
    case "instances":
      return zh ? "实例" : "Instances";
    case "sessions":
      return zh ? "会话" : "Sessions";
    case "cron":
      return zh ? "定时任务" : "Cron Jobs";
    case "skills":
      return zh ? "技能" : "Skills";
    case "nodes":
      return zh ? "节点" : "Nodes";
    case "chat":
      return zh ? "聊天" : "Chat";
    case "config":
      return zh ? "配置" : "Config";
    case "debug":
      return zh ? "调试" : "Debug";
    case "logs":
      return zh ? "日志" : "Logs";
    default:
      return zh ? "控制" : "Control";
  }
}

export function subtitleForTab(tab: Tab, lang: "en" | "zh" = "en") {
  const zh = lang === "zh";
  switch (tab) {
    case "overview":
      return zh ? "网关状态、入口与快速健康信息。" : "Gateway status, entry points, and a fast health read.";
    case "channels":
      return zh ? "管理渠道与相关设置。" : "Manage channels and settings.";
    case "instances":
      return zh ? "已连接客户端与节点的在线/存在信息。" : "Presence beacons from connected clients and nodes.";
    case "sessions":
      return zh ? "查看会话并调整会话默认值。" : "Inspect active sessions and adjust per-session defaults.";
    case "cron":
      return zh ? "安排唤醒与周期性运行。" : "Schedule wakeups and recurring agent runs.";
    case "skills":
      return zh ? "管理技能可用性与 API Key 注入。" : "Manage skill availability and API key injection.";
    case "nodes":
      return zh ? "配对设备、能力与命令暴露。" : "Paired devices, capabilities, and command exposure.";
    case "chat":
      return zh ? "直接与网关对话，便于快速干预。" : "Direct gateway chat session for quick interventions.";
    case "config":
      return zh ? "安全编辑 ~/.clawdbot/clawdbot.json。" : "Edit ~/.clawdbot/clawdbot.json safely.";
    case "debug":
      return zh ? "网关快照、事件与手动 RPC 调用。" : "Gateway snapshots, events, and manual RPC calls.";
    case "logs":
      return zh ? "实时查看网关日志。" : "Live tail of the gateway file logs.";
    default:
      return "";
  }
}
