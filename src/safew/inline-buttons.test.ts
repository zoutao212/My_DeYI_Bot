import { describe, expect, it } from "vitest";

import { resolveSafewTargetChatType } from "./inline-buttons.js";

describe("resolveSafewTargetChatType", () => {
  it("returns 'direct' for positive numeric IDs", () => {
    expect(resolveSafewTargetChatType("5232990709")).toBe("direct");
    expect(resolveSafewTargetChatType("123456789")).toBe("direct");
  });

  it("returns 'group' for negative numeric IDs", () => {
    expect(resolveSafewTargetChatType("-123456789")).toBe("group");
    expect(resolveSafewTargetChatType("-1001234567890")).toBe("group");
  });

  it("handles safew: prefix from normalizeSafewMessagingTarget", () => {
    expect(resolveSafewTargetChatType("safew:5232990709")).toBe("direct");
    expect(resolveSafewTargetChatType("safew:-123456789")).toBe("group");
    expect(resolveSafewTargetChatType("SAFEW:5232990709")).toBe("direct");
  });

  it("handles tg/group prefixes and topic suffixes", () => {
    expect(resolveSafewTargetChatType("tg:5232990709")).toBe("direct");
    expect(resolveSafewTargetChatType("safew:group:-1001234567890")).toBe("group");
    expect(resolveSafewTargetChatType("safew:group:-1001234567890:topic:456")).toBe("group");
    expect(resolveSafewTargetChatType("-1001234567890:456")).toBe("group");
  });

  it("returns 'unknown' for usernames", () => {
    expect(resolveSafewTargetChatType("@username")).toBe("unknown");
    expect(resolveSafewTargetChatType("safew:@username")).toBe("unknown");
  });

  it("returns 'unknown' for empty strings", () => {
    expect(resolveSafewTargetChatType("")).toBe("unknown");
    expect(resolveSafewTargetChatType("   ")).toBe("unknown");
  });
});
