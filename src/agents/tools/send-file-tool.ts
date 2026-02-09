import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve, extname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

const SendFileSchema = Type.Object({
  filePath: Type.String({
    description: "文件路径（绝对路径或相对于工作目录的路径）",
  }),
  caption: Type.Optional(
    Type.String({
      description: "文件说明（可选），会显示在文件下方",
    }),
  ),
});

/**
 * 允许的文件扩展名（白名单）
 */
const ALLOWED_EXTENSIONS = [
  ".txt",
  ".md",
  ".pdf",
  ".docx",
  ".xlsx",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".zip",
  ".tar",
  ".gz",
  ".json",
  ".csv",
  ".xml",
];

/**
 * 各频道的文件大小限制（字节）
 */
const MAX_FILE_SIZE = {
  telegram: 50 * 1024 * 1024, // 50 MB
  discord: 8 * 1024 * 1024, // 8 MB
  slack: 1024 * 1024 * 1024, // 1 GB
  web: 100 * 1024 * 1024, // 100 MB
};

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * MIME 类型映射
 */
const MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
};

function resolveMimeType(ext: string): string {
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function isImageFile(ext: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif"].includes(ext);
}

function isTextFile(ext: string): boolean {
  return [".txt", ".md", ".csv", ".json", ".xml"].includes(ext);
}

/**
 * 创建 send_file 工具
 *
 * 允许 LLM 发送文件到用户的聊天频道
 */
export function createSendFileTool(options: {
  workspaceDir: string;
}): AnyAgentTool {
  return {
    label: "Send File",
    name: "send_file",
    description: `发送文件到用户的聊天频道。

**使用场景**：
- 用户明确要求发送文件："把这个文件发给我"
- 生成了文件后需要发送给用户
- 完成任务后发送结果文件

**支持的频道**：
- Telegram（最大 50MB）
- Discord（最大 8MB）
- Slack（最大 1GB）
- Web 网关

**文件路径**：
- 绝对路径：/home/user/file.txt
- 相对路径：./output/file.txt（相对于工作目录）
- 任务文件：~/.clawdbot/tasks/{sessionId}/file.txt

**示例**：
\`\`\`
用户：把刚才生成的报告发给我
→ 调用 send_file({ filePath: "./report.txt", caption: "这是您要的报告" })

用户：发送 /tmp/data.csv
→ 调用 send_file({ filePath: "/tmp/data.csv" })
\`\`\``,
    parameters: SendFileSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const filePath = readStringParam(params, "filePath", { required: true });
      const caption = readStringParam(params, "caption") || "";

      try {
        // 1. 解析文件路径
        const resolvedPath = isAbsolute(filePath)
          ? filePath
          : resolve(options.workspaceDir, filePath);

        // 2. 检查文件是否存在
        if (!existsSync(resolvedPath)) {
          return jsonResult({
            success: false,
            error: `文件不存在：${filePath}`,
          });
        }

        // 3. 验证路径安全性
        const allowedDirs = [
          options.workspaceDir,
          resolve(homedir(), ".clawdbot", "tasks"),
        ];

        const isAllowed = allowedDirs.some((dir) =>
          resolvedPath.startsWith(dir),
        );

        if (!isAllowed) {
          return jsonResult({
            success: false,
            error: "文件路径不在允许的目录内",
          });
        }

        // 4. 获取文件信息
        const fileName = basename(resolvedPath);
        const fileStats = statSync(resolvedPath);
        const fileSize = fileStats.size;

        // 5. 检查文件类型
        const ext = extname(fileName).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
          return jsonResult({
            success: false,
            error: `不支持的文件类型：${ext}`,
          });
        }

        // 6. 从全局上下文获取会话信息
        const { getCurrentFollowupRunContext } = await import(
          "./enqueue-task-tool.js"
        );
        const currentFollowupRun = getCurrentFollowupRunContext();

        if (!currentFollowupRun) {
          return jsonResult({
            success: false,
            status: "error",
            error: `无法获取会话上下文（系统内部错误）。⚠️ 这是不可恢复的系统错误，重复调用 send_file 不会解决此问题。请勿重试，改为告知用户文件已保存到本地路径：${resolvedPath}`,
          });
        }

        const {
          originatingChannel,
          originatingTo,
          originatingAccountId,
          originatingThreadId,
        } = currentFollowupRun;

        // 🔧 P14 修复：webchat 频道不需要 originatingTo，提前处理
        if (originatingChannel === "webchat") {
          const maxSize = MAX_FILE_SIZE.web;
          if (maxSize && fileSize > maxSize) {
            return jsonResult({
              success: false,
              error: `文件太大（${formatFileSize(fileSize)}），超过 webchat 的限制（${formatFileSize(maxSize)}）。⚠️ 这是系统限制，请勿重试此操作。`,
            });
          }
          // Web 网关：返回文件元信息，前端通过 chat.file.download 接口获取内容
          const mimeType = resolveMimeType(ext);
          return jsonResult({
            success: true,
            message: `✅ 文件已准备好：${fileName}（${formatFileSize(fileSize)}）`,
            fileName,
            fileSize,
            filePath: resolvedPath,
            mimeType,
            channel: "webchat",
            caption: caption || undefined,
            // 前端可用此标记渲染文件卡片
            webFileCard: {
              fileName,
              fileSize,
              mimeType,
              filePath: resolvedPath,
              caption: caption || undefined,
              isImage: isImageFile(ext),
              isText: isTextFile(ext),
            },
          });
        }

        // 🔧 P15 修复：非 webchat 频道需要 originatingTo
        if (!originatingChannel || !originatingTo) {
          return jsonResult({
            success: false,
            status: "error",
            error: `无法获取频道路由信息（originatingChannel=${originatingChannel ?? "空"}, originatingTo=${originatingTo ?? "空"}）。` +
              `这是系统内部配置问题，重复调用 send_file 不会解决此问题。⚠️ 请勿重试，改为告知用户文件已保存到本地路径：${resolvedPath}`,
          });
        }

        // 7. 检查文件大小限制
        const maxSize =
          MAX_FILE_SIZE[originatingChannel as keyof typeof MAX_FILE_SIZE];
        if (maxSize && fileSize > maxSize) {
          return jsonResult({
            success: false,
            status: "error",
            error: `文件太大（${formatFileSize(fileSize)}），超过 ${originatingChannel} 的限制（${formatFileSize(maxSize)}）。⚠️ 这是系统限制，请勿重试此操作。改为告知用户文件已保存到本地路径：${resolvedPath}`,
          });
        }

        // 8. 根据频道类型发送文件（需要实际发送的频道）
        const fileBuffer = await readFile(resolvedPath);

        if (originatingChannel === "telegram") {
          await sendFileToTelegram({
            chatId: originatingTo,
            fileBuffer,
            fileName,
            caption,
            accountId: originatingAccountId,
            threadId: originatingThreadId as number | undefined,
          });

          return jsonResult({
            success: true,
            message: `✅ 文件已发送到 Telegram：${fileName}（${formatFileSize(fileSize)}）`,
            fileName,
            fileSize,
            channel: "telegram",
          });
        } else if (originatingChannel === "discord") {
          // TODO: 实现 Discord 文件发送
          return jsonResult({
            success: false,
            status: "error",
            error: `暂不支持 ${originatingChannel} 频道的文件发送。⚠️ 请勿重试，改为告知用户文件已保存到本地路径：${resolvedPath}`,
          });
        } else if (originatingChannel === "slack") {
          // TODO: 实现 Slack 文件发送
          return jsonResult({
            success: false,
            status: "error",
            error: `暂不支持 ${originatingChannel} 频道的文件发送。⚠️ 请勿重试，改为告知用户文件已保存到本地路径：${resolvedPath}`,
          });
        } else {
          return jsonResult({
            success: false,
            status: "error",
            error: `不支持的频道类型：${originatingChannel}。⚠️ 请勿重试，改为告知用户文件已保存到本地路径：${resolvedPath}`,
          });
        }
      } catch (err) {
        console.error(`[send_file] ❌ Error:`, err);
        return jsonResult({
          success: false,
          error: String(err),
        });
      }
    },
  };
}

/**
 * 发送文件到 Telegram
 */
async function sendFileToTelegram(params: {
  chatId: string;
  fileBuffer: Buffer;
  fileName: string;
  caption: string;
  accountId?: string;
  threadId?: number;
}): Promise<void> {
  const { Bot, InputFile } = await import("grammy");
  const { loadConfig } = await import("../../config/config.js");
  const { resolveTelegramAccount } = await import("../../telegram/accounts.js");
  const { parseTelegramTarget } = await import("../../telegram/targets.js");

  const cfg = loadConfig();
  const account = resolveTelegramAccount({ cfg, accountId: params.accountId });
  const token = account.token;

  if (!token) {
    throw new Error("Telegram token 未配置");
  }

  const bot = new Bot(token);
  const file = new InputFile(params.fileBuffer, params.fileName);

  // 解析 chatId，去掉 "telegram:" 等内部前缀并提取 topic ID
  const target = parseTelegramTarget(params.chatId);

  const sendParams: Record<string, unknown> = {
    parse_mode: "HTML" as const,
  };

  if (params.caption) {
    sendParams.caption = params.caption;
  }

  // 优先使用调用方传入的 threadId，其次使用从 target 解析出的 messageThreadId
  const threadId = params.threadId ?? target.messageThreadId;
  if (threadId != null) {
    sendParams.message_thread_id = threadId;
  }

  await bot.api.sendDocument(target.chatId, file, sendParams);
}
