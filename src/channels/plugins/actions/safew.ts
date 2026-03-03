import {
  createActionGate,
  readStringOrNumberParam,
  readStringParam,
} from "../../../agents/tools/common.js";
import { handleSafewAction } from "../../../agents/tools/safew-actions.js";
import { listEnabledSafewAccounts } from "../../../safew/accounts.js";
import { isSafewInlineButtonsEnabled } from "../../../safew/inline-buttons.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";

const providerId = "safew";

function readSafewSendParams(params: Record<string, unknown>) {
  const to = readStringParam(params, "to", { required: true });
  const mediaUrl = readStringParam(params, "media", { trim: false });
  const content =
    readStringParam(params, "message", {
      required: !mediaUrl,
      allowEmpty: true,
    }) ?? "";
  const replyTo = readStringParam(params, "replyTo");
  const threadId = readStringParam(params, "threadId");
  const buttons = params.buttons;
  const asVoice = typeof params.asVoice === "boolean" ? params.asVoice : undefined;
  return {
    to,
    content,
    mediaUrl: mediaUrl ?? undefined,
    replyToMessageId: replyTo ?? undefined,
    messageThreadId: threadId ?? undefined,
    buttons,
    asVoice,
  };
}

export const safewMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledSafewAccounts(cfg).filter(
      (account) => account.tokenSource !== "none",
    );
    if (accounts.length === 0) return [];
    const gate = createActionGate(cfg.channels?.safew?.actions);
    const actions = new Set<ChannelMessageActionName>(["send"]);
    if (gate("reactions")) actions.add("react");
    if (gate("deleteMessage")) actions.add("delete");
    return Array.from(actions);
  },
  supportsButtons: ({ cfg }) => {
    const accounts = listEnabledSafewAccounts(cfg).filter(
      (account) => account.tokenSource !== "none",
    );
    if (accounts.length === 0) return false;
    return accounts.some((account) =>
      isSafewInlineButtonsEnabled({ cfg, accountId: account.accountId }),
    );
  },
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) return null;
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const sendParams = readSafewSendParams(params);
      return await handleSafewAction(
        {
          action: "sendMessage",
          ...sendParams,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;
      return await handleSafewAction(
        {
          action: "react",
          chatId:
            readStringParam(params, "chatId") ?? readStringParam(params, "to", { required: true }),
          messageId,
          emoji,
          remove,
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    if (action === "delete") {
      const chatId =
        readStringOrNumberParam(params, "chatId") ??
        readStringOrNumberParam(params, "channelId") ??
        readStringParam(params, "to", { required: true });
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      return await handleSafewAction(
        {
          action: "deleteMessage",
          chatId,
          messageId: Number(messageId),
          accountId: accountId ?? undefined,
        },
        cfg,
      );
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
