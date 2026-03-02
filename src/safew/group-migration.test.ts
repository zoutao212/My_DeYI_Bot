import { describe, expect, it } from "vitest";

import { migrateSafewGroupConfig } from "./group-migration.js";

describe("migrateSafewGroupConfig", () => {
  it("migrates global group ids", () => {
    const cfg = {
      channels: {
        safew: {
          groups: {
            "-123": { requireMention: false },
          },
        },
      },
    };

    const result = migrateSafewGroupConfig({
      cfg,
      accountId: "default",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(cfg.channels.safew.groups).toEqual({
      "-100123": { requireMention: false },
    });
  });

  it("migrates account-scoped groups", () => {
    const cfg = {
      channels: {
        safew: {
          accounts: {
            primary: {
              groups: {
                "-123": { requireMention: true },
              },
            },
          },
        },
      },
    };

    const result = migrateSafewGroupConfig({
      cfg,
      accountId: "primary",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(result.scopes).toEqual(["account"]);
    expect(cfg.channels.safew.accounts.primary.groups).toEqual({
      "-100123": { requireMention: true },
    });
  });

  it("matches account ids case-insensitively", () => {
    const cfg = {
      channels: {
        safew: {
          accounts: {
            Primary: {
              groups: {
                "-123": {},
              },
            },
          },
        },
      },
    };

    const result = migrateSafewGroupConfig({
      cfg,
      accountId: "primary",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(cfg.channels.safew.accounts.Primary.groups).toEqual({
      "-100123": {},
    });
  });

  it("skips migration when new id already exists", () => {
    const cfg = {
      channels: {
        safew: {
          groups: {
            "-123": { requireMention: true },
            "-100123": { requireMention: false },
          },
        },
      },
    };

    const result = migrateSafewGroupConfig({
      cfg,
      accountId: "default",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(false);
    expect(result.skippedExisting).toBe(true);
    expect(cfg.channels.safew.groups).toEqual({
      "-123": { requireMention: true },
      "-100123": { requireMention: false },
    });
  });
});
