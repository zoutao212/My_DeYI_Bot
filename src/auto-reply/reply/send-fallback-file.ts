/**
 * 兜底文件发送器
 *
 * 当 LLM 偷懒未调用 write/send_file 工具时，系统自动将内容落盘后，
 * 通过此模块把文件发送到用户的聊天频道（Telegram / Discord / Slack 等）。
 *
 * 设计原则：
 * - 仅依赖 FollowupRun 上已有的频道信息，不引入额外状态
 * - 对不支持的频道静默降级为文本通知
 * - 所有外部依赖 lazy import，避免增加启动开销
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { FollowupRun } from "./queue.js";
import type { ReplyPayload } from "../types.js";

export type SendFallbackFileParams = {
  /** 本地文件绝对路径 */
  filePath: string;
  /** 文件说明（显示在文件下方） */
  caption?: string;
  /** 当前正在执行的 FollowupRun（提供频道信息） */
  queued: FollowupRun;
};

export type SendFallbackFileResult = {
  ok: boolean;
  /** 实际使用的发送方式 */
  method: "telegram" | "route-reply" | "text-notify" | "skipped";
  error?: string;
};

/**
 * 把兜底落盘文件发送到用户的聊天频道
 *
 * 优先级：
 * 1. Telegram → 直接调用 grammy sendDocument（最可靠）
 * 2. 其他可路由频道 → 通过 routeReply 发送文本通知 + 文件路径
 * 3. 无频道信息 → 跳过（仅日志）
 */
export async function sendFallbackFile(
  params: SendFallbackFileParams,
): Promise<SendFallbackFileResult> {
  const { filePath, caption, queued } = params;
  const channel = queued.originatingChannel;
  const to = queued.originatingTo;

  if (!channel || !to) {
    console.log(
      `[send-fallback-file] ⏭️ 无频道信息，跳过文件发送：${filePath}`,
    );
    return { ok: true, method: "skipped" };
  }

  const fileName = basename(filePath);

  // ── Telegram：直接发送文件 ──────────────────────────────────
  if (channel === "telegram") {
    try {
      const fileBuffer = await readFile(filePath);
      const { Bot, InputFile } = await import("grammy");
      const { loadConfig } = await import("../../config/config.js");
      const { resolveTelegramAccount } = await import(
        "../../telegram/accounts.js"
      );

      const cfg = loadConfig();
      const account = resolveTelegramAccount({
        cfg,
        accountId: queued.originatingAccountId,
      });
      const token = account.token;
      if (!token) {
        return { ok: false, method: "telegram", error: "Telegram token 未配置" };
      }

      const bot = new Bot(token);
      const file = new InputFile(fileBuffer, fileName);

      const sendParams: Record<string, unknown> = {};
      if (caption) {
        sendParams.caption = caption;
      }
      const threadId = queued.originatingThreadId;
      if (threadId != null) {
        sendParams.message_thread_id =
          typeof threadId === "string" ? Number(threadId) : threadId;
      }

      await bot.api.sendDocument(to, file, sendParams);
      console.log(
        `[send-fallback-file] ✅ 已通过 Telegram 发送文件：${fileName} → ${to}`,
      );
      return { ok: true, method: "telegram" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[send-fallback-file] ⚠️ Telegram 文件发送失败，降级为 routeReply 文本通知：${msg}`,
      );
      // 🔧 降级：sendDocument 失败时（chat not found / 权限不足），
      //    通过 routeReply 发送文本通知（与 outbound 的 chunks 降级对齐）
      try {
        const { isRoutableChannel, routeReply } = await import("./route-reply.js");
        if (isRoutableChannel(channel)) {
          const fileContent = (await readFile(filePath, "utf-8")).slice(0, 4000);
          const notifyText = caption
            ? `📎 ${caption}\n\n${fileContent}${fileContent.length >= 4000 ? "\n\n...(已截断)" : ""}`
            : `📎 文件内容：\n\n${fileContent}${fileContent.length >= 4000 ? "\n\n...(已截断)" : ""}`;
          const payload: ReplyPayload = { text: notifyText };
          const result = await routeReply({
            payload,
            channel,
            to,
            sessionKey: queued.run.sessionKey,
            accountId: queued.originatingAccountId,
            threadId: queued.originatingThreadId,
            cfg: queued.run.config,
          });
          if (result.ok) {
            console.log(`[send-fallback-file] ✅ Telegram sendDocument 失败后通过 routeReply 成功发送文本`);
            return { ok: true, method: "text-notify" };
          }
        }
      } catch {
        // 降级也失败，返回原始错误
      }
      return { ok: false, method: "telegram", error: msg };
    }
  }

  // ── 其他频道：通过 routeReply 发送文本通知 ─────────────────
  try {
    const { isRoutableChannel, routeReply } = await import("./route-reply.js");

    if (isRoutableChannel(channel)) {
      const notifyText = caption
        ? `📎 ${caption}\n📁 文件已保存：${filePath}`
        : `📎 文件已保存：${filePath}`;

      const payload: ReplyPayload = { text: notifyText };
      const result = await routeReply({
        payload,
        channel,
        to,
        sessionKey: queued.run.sessionKey,
        accountId: queued.originatingAccountId,
        threadId: queued.originatingThreadId,
        cfg: queued.run.config,
      });

      if (result.ok) {
        console.log(
          `[send-fallback-file] ✅ 已通过 ${channel} 发送文件通知：${fileName}`,
        );
        return { ok: true, method: "route-reply" };
      }
      return {
        ok: false,
        method: "route-reply",
        error: result.error ?? "routeReply failed",
      };
    }

    console.log(
      `[send-fallback-file] ⏭️ 频道 ${channel} 不支持路由，跳过文件发送`,
    );
    return { ok: true, method: "skipped" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[send-fallback-file] ⚠️ 文件通知发送失败：${msg}`,
    );
    return { ok: false, method: "text-notify", error: msg };
  }
}
