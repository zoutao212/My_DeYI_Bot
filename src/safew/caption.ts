export const SAFEW_MAX_CAPTION_LENGTH = 1024;

export function splitSafewCaption(text?: string): {
  caption?: string;
  followUpText?: string;
} {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return { caption: undefined, followUpText: undefined };
  }
  if (trimmed.length > SAFEW_MAX_CAPTION_LENGTH) {
    return { caption: undefined, followUpText: trimmed };
  }
  return { caption: trimmed, followUpText: undefined };
}
