import { describe, expect, it, vi } from "vitest";

import { createAgentEventHandler, createChatRunState } from "./server-chat.js";

describe("agent event handler", () => {
  it("emits chat delta for assistant text-only events", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("forwards chatroom split-message metadata on chat delta", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2_000);
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "累计文本",
        messageId: "run-2:msg0",
        chatroomMessageText: "德默泽尔：单条消息",
      },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      messageId?: string;
      chatroomMessageText?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.messageId).toBe("run-2:msg0");
    expect(payload.chatroomMessageText).toBe("德默泽尔：单条消息");
    expect(payload.message?.content?.[0]?.text).toBe("累计文本");
    nowSpy.mockRestore();
  });
  it("emits chat delta with structured thinking for reasoning events", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(3_000);
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-3", { sessionKey: "session-3", clientRunId: "client-3" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-3",
      seq: 1,
      stream: "reasoning",
      ts: Date.now(),
      data: {
        text: "Reasoning:\n_step_",
        thinking: "step",
      },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ type?: string; text?: string; thinking?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.type).toBe("thinking");
    expect(payload.message?.content?.[0]?.thinking).toBe("step");
    nowSpy.mockRestore();
  });
});
