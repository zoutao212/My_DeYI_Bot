import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sendDocument = vi.fn(async () => ({ message_id: 1 }));
  const bot = { api: { sendDocument } };

  return {
    sendDocument,
    bot,
    Bot: vi.fn(() => bot),
    InputFile: vi.fn((buffer: Buffer, fileName: string) => ({ buffer, fileName })),
    loadConfig: vi.fn(() => ({})),
    resolveSafewAccount: vi.fn(() => ({ token: "TOKEN" })),
    parseSafewTarget: vi.fn(() => ({ chatId: "12623413", messageThreadId: 77 })),
    sendSafewDocument: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (_path: string, encoding?: BufferEncoding) => {
    if (encoding) return "mock file content";
    return Buffer.from("mock file");
  }),
}));

vi.mock("grammy", () => ({
  Bot: mocks.Bot,
  InputFile: mocks.InputFile,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../safew/accounts.js", () => ({
  resolveSafewAccount: mocks.resolveSafewAccount,
}));

vi.mock("../../safew/targets.js", () => ({
  parseSafewTarget: mocks.parseSafewTarget,
}));

vi.mock("../../safew/send-document.js", () => ({
  sendSafewDocument: mocks.sendSafewDocument,
}));

const { sendFallbackFile } = await import("./send-fallback-file.js");

describe("sendFallbackFile", () => {
  it("sends files via safew using grammy sendDocument", async () => {
    mocks.sendSafewDocument.mockClear();

    const res = await sendFallbackFile({
      filePath: "d:/Git_GitHub/clawdbot/README.md",
      caption: "cap",
      queued: {
        originatingChannel: "safew",
        originatingTo: "safew:12623413",
        originatingAccountId: "default",
        originatingThreadId: 123,
        run: {
          config: {} as any,
          sessionKey: "agent:main:main",
        },
      } as any,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("safew");
    expect(mocks.sendSafewDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "safew:12623413",
        fileName: expect.any(String),
        caption: "cap",
        parseMode: "HTML",
        messageThreadId: 123,
      }),
    );
  });

  it("prefers queued.originatingThreadId over target.messageThreadId", async () => {
    mocks.sendSafewDocument.mockClear();

    await sendFallbackFile({
      filePath: "d:/Git_GitHub/clawdbot/README.md",
      caption: "cap",
      queued: {
        originatingChannel: "safew",
        originatingTo: "safew:12623413",
        originatingAccountId: "default",
        originatingThreadId: 555,
        run: {
          config: {} as any,
          sessionKey: "agent:main:main",
        },
      } as any,
    });

    expect(mocks.sendSafewDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageThreadId: 555,
      }),
    );
  });
});
