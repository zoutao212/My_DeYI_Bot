/**
 * Auto-Capture Logic for SuperAgentMemory
 *
 * Rule-based filter to detect conversation messages worth remembering
 * and classify them into memory categories.
 */

// ============================================================================
// Capture trigger patterns
// ============================================================================

const MEMORY_TRIGGERS = [
  // Explicit remember commands (multi-language)
  /zapamatuj si|pamatuj|记住|记下|记住这个|请记住/i,
  /remember|memorize|note this|keep in mind/i,
  // Preferences
  /preferuji|radši|nechci|prefer|偏好|喜欢|讨厌|不喜欢/i,
  /rozhodli jsme|budeme používat|决定|选择了|我们用/i,
  // Contact info
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  // Personal statements
  /můj\s+\w+\s+je|je\s+můj|我的.+是|我叫|我是/i,
  /my\s+\w+\s+is|is\s+my/i,
  // Preference patterns
  /i (like|prefer|hate|love|want|need)|我(喜欢|讨厌|想要|需要)/i,
  /always|never|important|总是|从不|很重要/i,
  // Facts
  /事实是|实际上|顺便说|it is a fact|actually|by the way/i,
  // Decisions
  /那就|决定了|好的就用|let's go with|we'll use|agreed/i,
];

// ============================================================================
// Content filter patterns (skip these)
// ============================================================================

const SKIP_PATTERNS = [
  // Too short
  (text: string) => text.length < 10 || text.length > 500,
  // Injected recall context
  (text: string) => text.includes("<relevant-memories>"),
  (text: string) => text.includes("<superagent-memories>"),
  // XML/system tags
  (text: string) => text.startsWith("<") && text.includes("</"),
  // Agent summaries (markdown lists)
  (text: string) => text.includes("**") && text.includes("\n-"),
  // Emoji-heavy (likely agent output)
  (text: string) =>
    (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length > 3,
  // Code blocks
  (text: string) => text.includes("```"),
  // Tool calls / JSON
  (text: string) => /^\s*[{[]/.test(text),
];

// ============================================================================
// Category detection
// ============================================================================

export type CaptureCategory = "preference" | "fact" | "decision" | "entity" | "other";

const CATEGORY_RULES: Array<{ pattern: RegExp; category: CaptureCategory }> = [
  { pattern: /prefer|radši|like|love|hate|want|偏好|喜欢|讨厌|想要/i, category: "preference" },
  { pattern: /rozhodli|decided|will use|budeme|决定|选择了/i, category: "decision" },
  { pattern: /\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se|名叫|手机|邮箱/i, category: "entity" },
  { pattern: /is|are|has|have|je|má|jsou|是|有/i, category: "fact" },
];

// ============================================================================
// Public functions
// ============================================================================

/** Check if a text message is worth capturing as a memory */
export function shouldCapture(text: string): boolean {
  for (const skip of SKIP_PATTERNS) {
    if (skip(text)) return false;
  }
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

/** Detect the memory category of a text */
export function detectCategory(text: string): CaptureCategory {
  for (const { pattern, category } of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return "other";
}

/** Extract text content from message objects (handles string/array content) */
export function extractTexts(messages: unknown[]): string[] {
  const texts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;

    // Only process user and assistant messages
    const role = msgObj.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = msgObj.content;

    if (typeof content === "string") {
      texts.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }

  return texts;
}

/** Find capturable texts from a list of messages, limited to maxCount */
export function findCapturableTexts(
  messages: unknown[],
  maxCount = 3,
): Array<{ text: string; category: CaptureCategory }> {
  const allTexts = extractTexts(messages);
  const captured: Array<{ text: string; category: CaptureCategory }> = [];

  for (const text of allTexts) {
    if (captured.length >= maxCount) break;
    if (shouldCapture(text)) {
      captured.push({ text, category: detectCategory(text) });
    }
  }

  return captured;
}
