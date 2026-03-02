import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { resolveSafewDraftStreamingChunking } from "./draft-chunking.js";

describe("resolveSafewDraftStreamingChunking", () => {
  it("uses smaller defaults than block streaming", () => {
    const chunking = resolveSafewDraftStreamingChunking(undefined, "default");
    expect(chunking).toEqual({
      minChars: 200,
      maxChars: 800,
      breakPreference: "paragraph",
    });
  });

  it("clamps to safew.textChunkLimit", () => {
    const cfg: ClawdbotConfig = {
      channels: { safew: { allowFrom: ["*"], textChunkLimit: 150 } },
    };
    const chunking = resolveSafewDraftStreamingChunking(cfg, "default");
    expect(chunking).toEqual({
      minChars: 150,
      maxChars: 150,
      breakPreference: "paragraph",
    });
  });

  it("supports per-account overrides", () => {
    const cfg: ClawdbotConfig = {
      channels: {
        safew: {
          allowFrom: ["*"],
          accounts: {
            default: {
              allowFrom: ["*"],
              draftChunk: {
                minChars: 10,
                maxChars: 20,
                breakPreference: "sentence",
              },
            },
          },
        },
      },
    };
    const chunking = resolveSafewDraftStreamingChunking(cfg, "default");
    expect(chunking).toEqual({
      minChars: 10,
      maxChars: 20,
      breakPreference: "sentence",
    });
  });
});
