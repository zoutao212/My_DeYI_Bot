import type { Tab } from "./navigation";

export type UiLanguage = "en" | "zh";

export type UiL10n = {
  tabGroup: {
    chat: string;
    control: string;
    agent: string;
    settings: string;
  };
  tabTitle: Record<Tab, string>;
  tabSubtitle: Record<Tab, string>;
  overview: {
    gatewayAccessTitle: string;
    gatewayAccessSub: string;
    websocketUrl: string;
    gatewayToken: string;
    systemPromptLanguage: string;
    uiLanguage: string;
    passwordNotStored: string;
    defaultSessionKey: string;
    connect: string;
    refresh: string;
    connectHint: string;
    snapshotTitle: string;
    snapshotSub: string;
    snapshotStatusLabel: string;
    snapshotStatusConnected: string;
    snapshotStatusDisconnected: string;
    snapshotUptimeLabel: string;
    snapshotTickLabel: string;
    snapshotLastChannelsRefreshLabel: string;
    snapshotConnectChannelsHint: string;
    statsInstancesLabel: string;
    statsInstancesSub: string;
    statsSessionsLabel: string;
    statsSessionsSub: string;
    statsCronLabel: string;
    statsCronEnabled: string;
    statsCronDisabled: string;
    statsCronSubPrefix: string;
    notesTitle: string;
    notesSub: string;
    notesTailscaleTitle: string;
    notesTailscaleBody: string;
    notesSessionTitle: string;
    notesSessionBody: string;
    notesCronTitle: string;
    notesCronBody: string;
  };
  resources: {
    title: string;
    docs: string;
    docsTitle: string;
  };
  approval: {
    languageSettings: string;
    allow: string;
    deny: string;
  };
};

export function getUiL10n(lang: UiLanguage): UiL10n {
  if (lang === "zh") {
    return {
      tabGroup: {
        chat: "聊天",
        control: "控制",
        agent: "代理",
        settings: "设置",
      },
      tabTitle: {
        overview: "概览",
        channels: "渠道",
        instances: "实例",
        sessions: "会话",
        cron: "定时任务",
        skills: "技能",
        nodes: "节点",
        chat: "聊天",
        config: "配置",
        debug: "调试",
        logs: "日志",
      },
      tabSubtitle: {
        overview: "网关状态、入口与快速健康信息。",
        channels: "管理渠道与相关设置。",
        instances: "已连接客户端与节点的在线/存在信息。",
        sessions: "查看会话并调整会话默认值。",
        cron: "安排唤醒与周期性运行。",
        skills: "管理技能可用性与 API Key 注入。",
        nodes: "配对设备、能力与命令暴露。",
        chat: "直接与网关对话，便于快速干预。",
        config: "安全编辑 ~/.clawdbot/clawdbot.json。",
        debug: "网关快照、事件与手动 RPC 调用。",
        logs: "实时查看网关日志。",
      },
      overview: {
        gatewayAccessTitle: "网关连接",
        gatewayAccessSub: "控制台连接到哪里，以及如何鉴权。",
        websocketUrl: "WebSocket 地址",
        gatewayToken: "网关 Token",
        systemPromptLanguage: "系统提示词语言",
        uiLanguage: "界面语言",
        passwordNotStored: "密码（不保存）",
        defaultSessionKey: "默认会话 Key",
        connect: "连接",
        refresh: "刷新",
        connectHint: "修改连接信息后点击“连接”生效。",
        snapshotTitle: "快照",
        snapshotSub: "最近一次握手信息。",
        snapshotStatusLabel: "状态",
        snapshotStatusConnected: "已连接",
        snapshotStatusDisconnected: "未连接",
        snapshotUptimeLabel: "运行时长",
        snapshotTickLabel: "心跳间隔",
        snapshotLastChannelsRefreshLabel: "上次刷新渠道",
        snapshotConnectChannelsHint: "前往“渠道”绑定 WhatsApp、Telegram、Discord、Signal 或 iMessage。",
        statsInstancesLabel: "实例",
        statsInstancesSub: "最近 5 分钟内的在线/存在信息。",
        statsSessionsLabel: "会话",
        statsSessionsSub: "网关最近跟踪到的会话 Key。",
        statsCronLabel: "定时任务",
        statsCronEnabled: "已启用",
        statsCronDisabled: "未启用",
        statsCronSubPrefix: "下次唤醒",
        notesTitle: "备注",
        notesSub: "远程控制场景的快速提示。",
        notesTailscaleTitle: "Tailscale Serve",
        notesTailscaleBody: "优先使用 Serve，把网关维持在 loopback 并启用 tailnet 鉴权。",
        notesSessionTitle: "会话卫生",
        notesSessionBody: "使用 /new 或 sessions.patch 重置上下文。",
        notesCronTitle: "定时任务提示",
        notesCronBody: "周期性任务建议使用隔离的会话来运行。",
      },
      resources: {
        title: "资源",
        docs: "文档",
        docsTitle: "文档（在新标签页打开）",
      },
      approval: {
        languageSettings: "语言设置",
        allow: "允许",
        deny: "拒绝",
      },
    };
  }

  return {
    tabGroup: {
      chat: "Chat",
      control: "Control",
      agent: "Agent",
      settings: "Settings",
    },
    tabTitle: {
      overview: "Overview",
      channels: "Channels",
      instances: "Instances",
      sessions: "Sessions",
      cron: "Cron Jobs",
      skills: "Skills",
      nodes: "Nodes",
      chat: "Chat",
      config: "Config",
      debug: "Debug",
      logs: "Logs",
    },
    tabSubtitle: {
      overview: "Gateway status, entry points, and a fast health read.",
      channels: "Manage channels and settings.",
      instances: "Presence beacons from connected clients and nodes.",
      sessions: "Inspect active sessions and adjust per-session defaults.",
      cron: "Schedule wakeups and recurring agent runs.",
      skills: "Manage skill availability and API key injection.",
      nodes: "Paired devices, capabilities, and command exposure.",
      chat: "Direct gateway chat session for quick interventions.",
      config: "Edit ~/.clawdbot/clawdbot.json safely.",
      debug: "Gateway snapshots, events, and manual RPC calls.",
      logs: "Live tail of the gateway file logs.",
    },
    overview: {
      gatewayAccessTitle: "Gateway Access",
      gatewayAccessSub: "Where the dashboard connects and how it authenticates.",
      websocketUrl: "WebSocket URL",
      gatewayToken: "Gateway Token",
      systemPromptLanguage: "System Prompt Language",
      uiLanguage: "UI Language",
      passwordNotStored: "Password (not stored)",
      defaultSessionKey: "Default Session Key",
      connect: "Connect",
      refresh: "Refresh",
      connectHint: "Click Connect to apply connection changes.",
      snapshotTitle: "Snapshot",
      snapshotSub: "Latest gateway handshake information.",
      snapshotStatusLabel: "Status",
      snapshotStatusConnected: "Connected",
      snapshotStatusDisconnected: "Disconnected",
      snapshotUptimeLabel: "Uptime",
      snapshotTickLabel: "Tick Interval",
      snapshotLastChannelsRefreshLabel: "Last Channels Refresh",
      snapshotConnectChannelsHint: "Use Channels to link WhatsApp, Telegram, Discord, Signal, or iMessage.",
      statsInstancesLabel: "Instances",
      statsInstancesSub: "Presence beacons in the last 5 minutes.",
      statsSessionsLabel: "Sessions",
      statsSessionsSub: "Recent session keys tracked by the gateway.",
      statsCronLabel: "Cron",
      statsCronEnabled: "Enabled",
      statsCronDisabled: "Disabled",
      statsCronSubPrefix: "Next wake",
      notesTitle: "Notes",
      notesSub: "Quick reminders for remote control setups.",
      notesTailscaleTitle: "Tailscale serve",
      notesTailscaleBody: "Prefer serve mode to keep the gateway on loopback with tailnet auth.",
      notesSessionTitle: "Session hygiene",
      notesSessionBody: "Use /new or sessions.patch to reset context.",
      notesCronTitle: "Cron reminders",
      notesCronBody: "Use isolated sessions for recurring runs.",
    },
    resources: {
      title: "Resources",
      docs: "Docs",
      docsTitle: "Docs (opens in new tab)",
    },
    approval: {
      languageSettings: "Language",
      allow: "Allow",
      deny: "Deny",
    },
  };
}
