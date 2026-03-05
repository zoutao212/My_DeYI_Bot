// @ts-nocheck
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import { danger, logVerbose } from "../globals.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveSafewDraftStreamingChunking } from "./draft-chunking.js";
import { createSafewDraftStream } from "./draft-stream.js";

export const dispatchSafewMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  safewCfg,
  opts,
  resolveBotTopicsEnabled,
}) => {
  const {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    resolvedThreadId,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
  } = context;

  const forwardedChatroomMessageIds = new Set<string>();
  let forwardChain: Promise<void> = Promise.resolve();
  let stopForwarding = false;
  const expectedSessionKey = (ctxPayload as any)?.SessionKey ?? route.sessionKey;
  const unsubscribeAgentEvents = onAgentEvent((evt) => {
    if (stopForwarding) return;
    if (!evt || evt.stream !== "assistant") return;
    if (!evt.sessionKey || evt.sessionKey !== expectedSessionKey) return;
    const data = evt.data || {};
    const messageId = typeof data.messageId === "string" ? data.messageId : "";
    const chatroomMessageText =
      typeof data.chatroomMessageText === "string" ? data.chatroomMessageText : "";
    if (!messageId || !chatroomMessageText) return;
    if (forwardedChatroomMessageIds.has(messageId)) return;
    forwardedChatroomMessageIds.add(messageId);

    forwardChain = forwardChain
      .then(async () => {
        await bot.api.sendMessage(chatId, chatroomMessageText, {
          ...(typeof resolvedThreadId === "number" ? { message_thread_id: resolvedThreadId } : {}),
        });
      })
      .catch(() => {});
  });

  const isPrivateChat = msg.chat.type === "private";
  const draftMaxChars = Math.min(textLimit, 4096);
  const canStreamDraft =
    streamMode !== "off" &&
    isPrivateChat &&
    typeof resolvedThreadId === "number" &&
    (await resolveBotTopicsEnabled(primaryCtx));
  const draftStream = canStreamDraft
    ? createSafewDraftStream({
        api: bot.api,
        chatId,
        draftId: msg.message_id || Date.now(),
        maxChars: draftMaxChars,
        messageThreadId: resolvedThreadId,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && streamMode === "block"
      ? resolveSafewDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) return;
    if (text === lastPartialText) return;
    if (streamMode === "partial") {
      lastPartialText = text;
      draftStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = text;
    if (!delta) return;
    if (!draftChunker) {
      draftText = text;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
    });
  };
  const flushDraft = async () => {
    if (!draftStream) return;
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText) draftStream.update(draftText);
    }
    await draftStream.flush();
  };

  let fallbackTypingTimer: NodeJS.Timeout | undefined;
  const startTypingFallback = () => {
    if (fallbackTypingTimer) return;
    void sendTyping().catch(() => {});
    fallbackTypingTimer = setInterval(() => {
      void sendTyping().catch(() => {});
    }, 5000);
  };
  const stopTypingFallback = () => {
    if (fallbackTypingTimer) {
      clearInterval(fallbackTypingTimer);
      fallbackTypingTimer = undefined;
    }
  };

  // Immediate typing loop to cover task trees, media understanding, and complex dispatch
  startTypingFallback();

  const disableBlockStreaming =
    Boolean(draftStream) ||
    (typeof safewCfg.blockStreaming === "boolean" ? !safewCfg.blockStreaming : undefined);

  const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "safew",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "safew", route.accountId);

  let queuedFinal;
  try {
    ({ queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        responsePrefix: prefixContext.responsePrefix,
        responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
        deliver: async (payload, info) => {
          if (info.kind === "final") {
            await flushDraft();
            draftStream?.stop();
          }
          await deliverReplies({
            replies: [payload],
            chatId: String(chatId),
            token: opts.token,
            runtime,
            bot,
            replyToMode,
            textLimit,
            messageThreadId: resolvedThreadId,
            tableMode,
            chunkMode,
            onVoiceRecording: sendRecordVoice,
            linkPreview: safewCfg.linkPreview,
          });
        },
        onError: (err, info) => {
          runtime.error?.(danger(`safew ${info.kind} reply failed: ${String(err)}`));
        },
        onReplyStart: async () => {
          await sendTyping().catch((err) => {
            logTypingFailure({
              log: logVerbose,
              channel: "safew",
              target: String(chatId),
              error: err,
            });
          });
        },
      },
      replyOptions: {
        skillFilter,
        onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
        onReasoningStream: draftStream
          ? (payload) => {
              if (payload.text) draftStream.update(payload.text);
            }
          : undefined,
        disableBlockStreaming,
        onModelSelected: (ctx) => {
          prefixContext.onModelSelected(ctx);
        },
      },
    }).finally(() => {
      stopTypingFallback();
    }));
  } finally {
    stopForwarding = true;
    try {
      unsubscribeAgentEvents?.();
    } catch {
    }
  }
  draftStream?.stop();
  if (!queuedFinal) {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
    return;
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReactionPromise ? "ack" : null,
    remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
    onError: (err) => {
      if (!msg.message_id) return;
      logAckFailure({
        log: logVerbose,
        channel: "safew",
        target: `${chatId}/${msg.message_id}`,
        error: err,
      });
    },
  });
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
  }
};
