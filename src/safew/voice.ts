import { isVoiceCompatibleAudio } from "../media/audio.js";

export function isSafewVoiceCompatible(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  return isVoiceCompatibleAudio(opts);
}

export function resolveSafewVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
}): { useVoice: boolean; reason?: string } {
  if (!opts.wantsVoice) return { useVoice: false };
  if (isSafewVoiceCompatible(opts)) return { useVoice: true };
  const contentType = opts.contentType ?? "unknown";
  const fileName = opts.fileName ?? "unknown";
  return {
    useVoice: false,
    reason: `media is ${contentType} (${fileName})`,
  };
}

export function resolveSafewVoiceSend(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
  logFallback?: (message: string) => void;
}): { useVoice: boolean } {
  const decision = resolveSafewVoiceDecision(opts);
  if (decision.reason && opts.logFallback) {
    opts.logFallback(
      `Safew voice requested but ${decision.reason}; sending as audio file instead.`,
    );
  }
  return { useVoice: decision.useVoice };
}
