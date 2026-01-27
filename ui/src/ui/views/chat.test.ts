import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

import type { SessionsListResult } from "../types";
import { renderChat, type ChatProps } from "./chat";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { model: null, contextTokens: null },
    sessions: [],
  };
}

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    messages: [],
    toolMessages: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: createSessions(),
    focusMode: false,
    assistantName: "Clawdbot",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    onNewSessionNoSummary: () => undefined,
    ...overrides,
  };
}

describe("chat view", () => {
  it("shows a stop button when aborting is available", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: true,
          onAbort,
        }),
      ),
      container,
    );

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Stop",
    );
    expect(stopButton).not.toBeUndefined();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("New session");
  });

  it("shows new session buttons in the header", () => {
    const container = document.createElement("div");
    const onNewSession = vi.fn();
    const onNewSessionNoSummary = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: false,
          onNewSession,
          onNewSessionNoSummary,
        }),
      ),
      container,
    );

    const summarizeButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "新会话（带总结）",
    );
    expect(summarizeButton).not.toBeUndefined();
    summarizeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);

    const noSummaryButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "全新开始（不总结）",
    );
    expect(noSummaryButton).not.toBeUndefined();
    noSummaryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSessionNoSummary).toHaveBeenCalledTimes(1);
  });
});
