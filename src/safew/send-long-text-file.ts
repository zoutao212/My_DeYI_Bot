/**
 * 长文本自动转 .txt 文件发送（Telegram 专用）
 *
 * 当纯文本回复超过阈值时，写入临时 .txt 文件通过 sendDocument 发送，
 * 而非分 chunk 发多条消息。供 deliverReplies 和 deliverOutboundPayloads 共用。
 */

import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, InputFile } from "grammy";
import { logVerbose } from "../globals.js";
import { loadConfig } from "../config/config.js";
import { resolveTelegramAccount } from "./accounts.js";

/** 超过此字符数的纯文本回复自动作为 .txt 文件发送 */
export const LONG_TEXT_FILE_THRESHOLD = 2000;

export type SendLongTextFileParams = {
  /** 要发送的完整文本 */
  text: string;
  /** Telegram chat ID（纯数字或 telegram:xxx 格式均可） */
  chatId: string;
  /** 可选：已有的 Bot 实例（deliverReplies 路径已有 bot） */
  bot?: Bot;
  /** 可选：Telegram bot token（与 bot 二选一） */
  token?: string;
  /** 可选：account ID（用于从配置中解析 token） */
  accountId?: string;
  /** 可选：reply_to_message_id */
  replyToMessageId?: number;
  /** 可选：message_thread_id（论坛话题） */
  messageThreadId?: number;
};

export type SendLongTextFileResult = {
  ok: boolean;
  error?: string;
};

/**
 * 将长文本写入临时 .txt 文件并通过 Telegram sendDocument 发送。
 * 截取前 200 字符作为 caption 摘要。
 */
export async function sendTelegramLongTextFile(
  params: SendLongTextFileParams,
): Promise<SendLongTextFileResult> {
  const { text, chatId, replyToMessageId, messageThreadId } = params;

  // 解析 bot 实例
  let bot = params.bot;
  if (!bot) {
    let token = params.token;
    if (!token) {
      const cfg = loadConfig();
      const account = resolveTelegramAccount({ cfg, accountId: params.accountId });
      token = account.token;
    }
    if (!token) {
      return { ok: false, error: "Telegram token 未配置" };
    }
    bot = new Bot(token);
  }

  try {
    const dir = await mkdtemp(join(tmpdir(), "clawdbot-reply-"));
    const filePath = join(dir, "reply.txt");
    await writeFile(filePath, text, "utf-8");
    const file = new InputFile(filePath, "reply.txt");

    const docParams: Record<string, unknown> = {};
    if (messageThreadId != null) {
      docParams.message_thread_id = messageThreadId;
    }
    if (replyToMessageId != null) {
      docParams.reply_to_message_id = replyToMessageId;
    }
    // 截取前 200 字符作为 caption 摘要
    const captionText =
      text.length > 200 ? text.slice(0, 197) + "..." : text;
    docParams.caption = captionText;

    await bot.api.sendDocument(chatId, file, docParams);
    logVerbose(
      `telegram: sent long reply as .txt file (${text.length} chars > threshold ${LONG_TEXT_FILE_THRESHOLD})`,
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
