import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveSafewAccount } from "./accounts.js";

describe("resolveSafewAccount", () => {
  it("falls back to the first configured account when accountId is omitted", () => {
    const prevSafewToken = process.env.SAFEW_BOT_TOKEN;
    process.env.SAFEW_BOT_TOKEN = "";
    try {
      const cfg: ClawdbotConfig = {
        channels: {
          safew: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveSafewAccount({ cfg });
      expect(account.accountId).toBe("work");
      expect(account.token).toBe("tok-work");
      expect(account.tokenSource).toBe("config");
    } finally {
      if (prevSafewToken === undefined) {
        delete process.env.SAFEW_BOT_TOKEN;
      } else {
        process.env.SAFEW_BOT_TOKEN = prevSafewToken;
      }
    }
  });

  it("uses SAFEW_BOT_TOKEN when default account config is missing", () => {
    const prevSafewToken = process.env.SAFEW_BOT_TOKEN;
    process.env.SAFEW_BOT_TOKEN = "tok-env";
    try {
      const cfg: ClawdbotConfig = {
        channels: {
          safew: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveSafewAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("tok-env");
      expect(account.tokenSource).toBe("env");
    } finally {
      if (prevSafewToken === undefined) {
        delete process.env.SAFEW_BOT_TOKEN;
      } else {
        process.env.SAFEW_BOT_TOKEN = prevSafewToken;
      }
    }
  });

  it("prefers default config token over SAFEW_BOT_TOKEN", () => {
    const prevSafewToken = process.env.SAFEW_BOT_TOKEN;
    process.env.SAFEW_BOT_TOKEN = "tok-env";
    try {
      const cfg: ClawdbotConfig = {
        channels: {
          safew: { botToken: "tok-config" },
        },
      };

      const account = resolveSafewAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("tok-config");
      expect(account.tokenSource).toBe("config");
    } finally {
      if (prevSafewToken === undefined) {
        delete process.env.SAFEW_BOT_TOKEN;
      } else {
        process.env.SAFEW_BOT_TOKEN = prevSafewToken;
      }
    }
  });

  it("does not fall back when accountId is explicitly provided", () => {
    const prevSafewToken = process.env.SAFEW_BOT_TOKEN;
    process.env.SAFEW_BOT_TOKEN = "";
    try {
      const cfg: ClawdbotConfig = {
        channels: {
          safew: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveSafewAccount({ cfg, accountId: "default" });
      expect(account.accountId).toBe("default");
      expect(account.tokenSource).toBe("none");
      expect(account.token).toBe("");
    } finally {
      if (prevSafewToken === undefined) {
        delete process.env.SAFEW_BOT_TOKEN;
      } else {
        process.env.SAFEW_BOT_TOKEN = prevSafewToken;
      }
    }
  });
});
