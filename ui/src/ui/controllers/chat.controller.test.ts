import { describe, expect, it } from "vitest";

import { handleChatEvent, type ChatState } from "./chat";

function createState(overrides?: Partial<ChatState>): ChatState {
  return {
    client: null,
    connected: true,
    sessionKey: "agent:main:session-a",
    settings: { systemPromptLanguage: "zh" },
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "",
    chatRunId: "run-1",
    chatStream: "",
    chatStreamStartedAt: Date.now(),
    lastError: null,
    ...overrides,
  };
}

describe("handleChatEvent session fallback", () => {
  it("accepts delta when sessionKey differs but runId matches active run", () => {
    const state = createState();

    const nextState = handleChatEvent(state, {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    });

    expect(nextState).toBe("delta");
    expect(state.chatStream).toBe("hello");
  });

  it("drops event when both sessionKey and runId do not match", () => {
    const state = createState();

    const nextState = handleChatEvent(state, {
      runId: "run-2",
      sessionKey: "main",
      state: "delta",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ignored" }],
      },
    });

    expect(nextState).toBeNull();
    expect(state.chatStream).toBe("");
  });

  it("lands split chatroom bubble on delta even with session alias mismatch", () => {
    const state = createState({ chatMessages: [] });

    const nextState = handleChatEvent(state, {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      messageId: "run-1:msg0",
      chatroomMessageText: "德默泽尔：单条回复",
    });

    expect(nextState).toBe("delta");
    expect(state.chatStream).toBeNull();
    expect(state.chatMessages).toHaveLength(1);
    const first = state.chatMessages[0] as Record<string, unknown>;
    expect(first._chatroomMsgId).toBe("run-1:msg0");
  });

  it("accepts split chatroom delta when session/run both mismatch but active run exists", () => {
    const state = createState({
      chatRunId: "run-active",
      chatMessages: [],
    });

    const nextState = handleChatEvent(state, {
      runId: "server-run-x",
      sessionKey: "alias-mismatch",
      state: "delta",
      messageId: "server-run-x:msg9",
      chatroomMessageText: "琳娜：这条应即时显示",
    });

    expect(nextState).toBe("delta");
    expect(state.chatMessages).toHaveLength(1);
    const first = state.chatMessages[0] as Record<string, unknown>;
    expect(first._chatroomMsgId).toBe("server-run-x:msg9");
  });

  it("drops split chatroom delta when no active run", () => {
    const state = createState({
      chatRunId: null,
      chatMessages: [],
    });

    const nextState = handleChatEvent(state, {
      runId: "server-run-y",
      sessionKey: "alias-mismatch",
      state: "delta",
      messageId: "server-run-y:msg1",
      chatroomMessageText: "这条不应被接收",
    });

    expect(nextState).toBeNull();
    expect(state.chatMessages).toHaveLength(0);
  });
});
