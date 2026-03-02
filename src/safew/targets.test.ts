import { describe, expect, it } from "vitest";

import { parseSafewTarget, stripSafewInternalPrefixes } from "./targets.js";

describe("stripSafewInternalPrefixes", () => {
  it("strips safew prefix", () => {
    expect(stripSafewInternalPrefixes("safew:123")).toBe("123");
  });

  it("strips safew+group prefixes", () => {
    expect(stripSafewInternalPrefixes("safew:group:-100123")).toBe("-100123");
  });

  it("does not strip group prefix without safew prefix", () => {
    expect(stripSafewInternalPrefixes("group:-100123")).toBe("group:-100123");
  });

  it("is idempotent", () => {
    expect(stripSafewInternalPrefixes("@mychannel")).toBe("@mychannel");
  });
});

describe("parseSafewTarget", () => {
  it("parses plain chatId", () => {
    expect(parseSafewTarget("-1001234567890")).toEqual({
      chatId: "-1001234567890",
    });
  });

  it("parses @username", () => {
    expect(parseSafewTarget("@mychannel")).toEqual({
      chatId: "@mychannel",
    });
  });

  it("parses chatId:topicId format", () => {
    expect(parseSafewTarget("-1001234567890:123")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 123,
    });
  });

  it("parses chatId:topic:topicId format", () => {
    expect(parseSafewTarget("-1001234567890:topic:456")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 456,
    });
  });

  it("trims whitespace", () => {
    expect(parseSafewTarget("  -1001234567890:99  ")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 99,
    });
  });

  it("does not treat non-numeric suffix as topicId", () => {
    expect(parseSafewTarget("-1001234567890:abc")).toEqual({
      chatId: "-1001234567890:abc",
    });
  });

  it("strips internal prefixes before parsing", () => {
    expect(parseSafewTarget("safew:group:-1001234567890:topic:456")).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 456,
    });
  });
});
