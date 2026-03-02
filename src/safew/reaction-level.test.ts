import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveSafewReactionLevel } from "./reaction-level.js";

describe("resolveSafewReactionLevel", () => {
  const prevSafewToken = process.env.SAFEW_BOT_TOKEN;

  beforeAll(() => {
    process.env.SAFEW_BOT_TOKEN = "test-token";
  });

  afterAll(() => {
    if (prevSafewToken === undefined) {
      delete process.env.SAFEW_BOT_TOKEN;
    } else {
      process.env.SAFEW_BOT_TOKEN = prevSafewToken;
    }
  });

  it("defaults to minimal level when reactionLevel is not set", () => {
    const cfg: ClawdbotConfig = {
      channels: { safew: {} },
    };

    const result = resolveSafewReactionLevel({ cfg });
    expect(result.level).toBe("minimal");
    expect(result.ackEnabled).toBe(false);
    expect(result.agentReactionsEnabled).toBe(true);
    expect(result.agentReactionGuidance).toBe("minimal");
  });

  it("returns off level with no reactions enabled", () => {
    const cfg: ClawdbotConfig = {
      channels: { safew: { reactionLevel: "off" } },
    };

    const result = resolveSafewReactionLevel({ cfg });
    expect(result.level).toBe("off");
    expect(result.ackEnabled).toBe(false);
    expect(result.agentReactionsEnabled).toBe(false);
    expect(result.agentReactionGuidance).toBeUndefined();
  });

  it("returns ack level with only ackEnabled", () => {
    const cfg: ClawdbotConfig = {
      channels: { safew: { reactionLevel: "ack" } },
    };

    const result = resolveSafewReactionLevel({ cfg });
    expect(result.level).toBe("ack");
    expect(result.ackEnabled).toBe(true);
    expect(result.agentReactionsEnabled).toBe(false);
    expect(result.agentReactionGuidance).toBeUndefined();
  });

  it("returns minimal level with agent reactions enabled and minimal guidance", () => {
    const cfg: ClawdbotConfig = {
      channels: { safew: { reactionLevel: "minimal" } },
    };

    const result = resolveSafewReactionLevel({ cfg });
    expect(result.level).toBe("minimal");
    expect(result.ackEnabled).toBe(false);
    expect(result.agentReactionsEnabled).toBe(true);
    expect(result.agentReactionGuidance).toBe("minimal");
  });

  it("returns extensive level with agent reactions enabled and extensive guidance", () => {
    const cfg: ClawdbotConfig = {
      channels: { safew: { reactionLevel: "extensive" } },
    };

    const result = resolveSafewReactionLevel({ cfg });
    expect(result.level).toBe("extensive");
    expect(result.ackEnabled).toBe(false);
    expect(result.agentReactionsEnabled).toBe(true);
    expect(result.agentReactionGuidance).toBe("extensive");
  });

  it("resolves reaction level from a specific account", () => {
    const cfg: ClawdbotConfig = {
      channels: {
        safew: {
          reactionLevel: "ack",
          accounts: {
            work: { botToken: "tok-work", reactionLevel: "extensive" },
          },
        },
      },
    };

    const result = resolveSafewReactionLevel({ cfg, accountId: "work" });
    expect(result.level).toBe("extensive");
    expect(result.ackEnabled).toBe(false);
    expect(result.agentReactionsEnabled).toBe(true);
    expect(result.agentReactionGuidance).toBe("extensive");
  });

  it("falls back to global level when account has no reactionLevel", () => {
    const cfg: ClawdbotConfig = {
      channels: {
        safew: {
          reactionLevel: "minimal",
          accounts: {
            work: { botToken: "tok-work" },
          },
        },
      },
    };

    const result = resolveSafewReactionLevel({ cfg, accountId: "work" });
    expect(result.level).toBe("minimal");
    expect(result.agentReactionsEnabled).toBe(true);
    expect(result.agentReactionGuidance).toBe("minimal");
  });
});
