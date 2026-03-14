import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSendFileTool } from "./send-file-tool.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./enqueue-task-tool.js", () => {
  return {
    getCurrentFollowupRunContext: () => ({
      originatingChannel: "safew",
      originatingTo: "safew:123456",
      originatingAccountId: "default",
      originatingThreadId: undefined,
    }),
  };
});

const sendDocumentMock = vi.fn(async () => ({ message_id: 1, chat: { id: 123456 } }));

vi.mock("grammy", () => {
  class Bot {
    api = {
      sendDocument: sendDocumentMock,
    };
    constructor(_token: string) {}
  }
  class InputFile {
    constructor(_buf: unknown, _name: string) {}
  }
  return { Bot, InputFile };
});

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => ({
      channels: {
        safew: {
          enabled: true,
          botToken: "test-token",
        },
      },
    }),
  };
});

vi.mock("../../safew/accounts.js", () => {
  return {
    resolveSafewAccount: () => ({
      accountId: "default",
      enabled: true,
      token: "test-token",
      tokenSource: "config",
      config: {},
    }),
  };
});

vi.mock("../../safew/targets.js", () => {
  return {
    parseSafewTarget: (to: string) => ({
      chatId: to.replace(/^safew:/i, ""),
      messageThreadId: undefined,
    }),
  };
});

describe("send-file-tool", () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    // 创建临时测试目录
    testDir = join(tmpdir(), `send-file-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, "test.txt");
    writeFileSync(testFile, "Hello, World!");
  });

  afterEach(() => {
    // 清理测试目录
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // 忽略清理错误
    }
  });

  it("should return error when file does not exist", async () => {
    const tool = createSendFileTool({ workspaceDir: testDir });
    const result = await tool.execute("test-id", {
      filePath: "./nonexistent.txt",
    });

    expect(result).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("文件不存在"),
        }),
      ]),
    });
  });

  it("should return error when file path is not allowed", async () => {
    const tool = createSendFileTool({ workspaceDir: testDir });
    const result = await tool.execute("test-id", {
      filePath: "/etc/passwd",
    });

    expect(result).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("文件路径不在允许的目录内"),
        }),
      ]),
    });
  });

  it("should return error when file type is not allowed", async () => {
    const exeFile = join(testDir, "test.exe");
    writeFileSync(exeFile, "fake exe");

    const tool = createSendFileTool({ workspaceDir: testDir });
    const result = await tool.execute("test-id", {
      filePath: exeFile,
    });

    expect(result).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("不支持的文件类型"),
        }),
      ]),
    });
  });

  it("should send file to safew channel", async () => {
    sendDocumentMock.mockClear();
    const tool = createSendFileTool({ workspaceDir: testDir });
    const result = await tool.execute("test-id", {
      filePath: testFile,
      caption: "test",
    });

    expect(sendDocumentMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("✅"),
        }),
      ]),
    });
  });
});
