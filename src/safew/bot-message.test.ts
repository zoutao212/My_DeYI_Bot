import { beforeEach, describe, expect, it, vi } from "vitest";

const buildSafewMessageContext = vi.hoisted(() => vi.fn());
const dispatchSafewMessage = vi.hoisted(() => vi.fn());

vi.mock("./bot-message-context.js", () => ({
  buildSafewMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchSafewMessage,
}));

import { createSafewMessageProcessor } from "./bot-message.js";

describe("safew bot message processor", () => {
  beforeEach(() => {
    buildSafewMessageContext.mockReset();
    dispatchSafewMessage.mockReset();
  });

  const baseDeps = {
    bot: {},
    cfg: {},
    account: {},
    safewCfg: {},
    historyLimit: 0,
    groupHistories: {},
    dmPolicy: {},
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "none",
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveSafewGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "auto",
    textLimit: 4096,
    opts: {},
    resolveBotTopicsEnabled: () => false,
  };

  it("dispatches when context is available", async () => {
    buildSafewMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createSafewMessageProcessor(baseDeps);
    await processMessage({ message: { chat: { id: 123 }, message_id: 456 } }, [], [], {});

    expect(dispatchSafewMessage).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when no context is produced", async () => {
    buildSafewMessageContext.mockResolvedValue(null);
    const processMessage = createSafewMessageProcessor(baseDeps);
    await processMessage({ message: { chat: { id: 123 }, message_id: 456 } }, [], [], {});
    expect(dispatchSafewMessage).not.toHaveBeenCalled();
  });
});
