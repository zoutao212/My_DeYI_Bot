import { describe, expect, it, vi } from "vitest";

import { resolveSafewVoiceSend } from "./voice.js";

describe("resolveSafewVoiceSend", () => {
  it("skips voice when wantsVoice is false", () => {
    const logFallback = vi.fn();
    const result = resolveSafewVoiceSend({
      wantsVoice: false,
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it("logs fallback for incompatible media", () => {
    const logFallback = vi.fn();
    const result = resolveSafewVoiceSend({
      wantsVoice: true,
      contentType: "audio/mpeg",
      fileName: "track.mp3",
      logFallback,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).toHaveBeenCalledWith(
      "Safew voice requested but media is audio/mpeg (track.mp3); sending as audio file instead.",
    );
  });

  it("keeps voice when compatible", () => {
    const logFallback = vi.fn();
    const result = resolveSafewVoiceSend({
      wantsVoice: true,
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });
});
