// @ts-nocheck
import { buildSafewMessageContext } from "./bot-message-context.js";
import { dispatchSafewMessage } from "./bot-message-dispatch.js";

export const createSafewMessageProcessor = (deps) => {
  const {
    bot,
    cfg,
    account,
    safewCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveSafewGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  } = deps;

  return async (primaryCtx, allMedia, storeAllowFrom, options) => {
    const context = await buildSafewMessageContext({
      primaryCtx,
      allMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveSafewGroupConfig,
    });
    if (!context) return;
    await dispatchSafewMessage({
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
    });
  };
};
