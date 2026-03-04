import type { Bot, Context } from "grammy";

import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  parseCommandArgs,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import type { CommandArgs } from "../auto-reply/commands-registry.js";
import {
  SAFEW_COMMAND_NAME_PATTERN,
  normalizeSafewCommandDescription,
  normalizeSafewCommandName,
  resolveSafewCustomCommands,
} from "../config/safew-custom-commands.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { danger, logVerbose } from "../globals.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type {
  ReplyToMode,
  SafewAccountConfig,
  SafewGroupConfig,
  SafewTopicConfig,
} from "../config/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { deliverReplies } from "./bot/delivery.js";
import { buildInlineKeyboard } from "./send.js";
import {
  buildSenderName,
  buildSafewGroupFrom,
  buildSafewGroupPeerId,
  resolveSafewForumThreadId,
} from "./bot/helpers.js";
import { firstDefined, isSenderAllowed, normalizeAllowFromWithStore } from "./bot-access.js";
import { readSafewAllowFromStore } from "./pairing-store.js";

type SafewNativeCommandContext = Context & { match?: string };

type SafewBotCommand = { command: string; description: string };

const sanitizeSafewBotCommands = (commands: SafewBotCommand[]) => {
  const MAX_COMMANDS = 50;
  const MAX_DESC_LEN = 256;
  const dropped: Array<{ command: string; reason: string }> = [];
  const seen = new Set<string>();
  const out: SafewBotCommand[] = [];

  const normalizeDesc = (value: string): string => {
    const raw = normalizeSafewCommandDescription(String(value ?? ""));
    const cleaned = raw
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    return cleaned.length > MAX_DESC_LEN ? cleaned.slice(0, MAX_DESC_LEN) : cleaned;
  };

  for (const entry of commands) {
    const name = normalizeSafewCommandName(String(entry?.command ?? ""));
    if (!name) {
      dropped.push({ command: String(entry?.command ?? ""), reason: "missing name" });
      continue;
    }
    if (!SAFEW_COMMAND_NAME_PATTERN.test(name)) {
      dropped.push({ command: name, reason: "invalid name" });
      continue;
    }
    if (seen.has(name)) {
      dropped.push({ command: name, reason: "duplicate" });
      continue;
    }
    const description = normalizeDesc(String(entry?.description ?? ""));
    if (!description) {
      dropped.push({ command: name, reason: "missing description" });
      continue;
    }

    seen.add(name);
    out.push({ command: name, description });
    if (out.length >= MAX_COMMANDS) {
      dropped.push({ command: "...", reason: `limit reached (${MAX_COMMANDS})` });
      break;
    }
  }

  return { commands: out, dropped };
};

const ensureSafewCoreCommands = (commands: SafewBotCommand[]) => {
  const out = [...commands];
  const seen = new Set(out.map((c) => normalizeSafewCommandName(c.command)));
  const ensure = (command: string, description: string) => {
    if (seen.has(command)) return;
    out.unshift({ command, description });
    seen.add(command);
  };

  ensure("reset", "Reset the current session.");
  ensure("new", "Start a new session.");
  ensure("help", "Show available commands.");
  return out;
};

const pickSafewMinimalCommands = (all: SafewBotCommand[]) => {
  const wanted = new Set(["new", "reset", "help"]);
  const picked = all.filter((c) => wanted.has(normalizeSafewCommandName(c.command)));
  const seen = new Set(picked.map((c) => normalizeSafewCommandName(c.command)));
  const ensure = (command: string, description: string) => {
    if (seen.has(command)) return;
    picked.push({ command, description });
    seen.add(command);
  };

  ensure("new", "Start a new session.");
  ensure("reset", "Reset the current session.");
  ensure("help", "Show available commands.");
  return picked;
};

type RegisterSafewNativeCommandsParams = {
  bot: Bot;
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  accountId: string;
  safewCfg: SafewAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  replyToMode: ReplyToMode;
  textLimit: number;
  useAccessGroups: boolean;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  nativeDisabledExplicit: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveSafewGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: SafewGroupConfig; topicConfig?: SafewTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
  opts: { token: string };
};

export const registerSafewNativeCommands = ({
  bot,
  cfg,
  runtime,
  accountId,
  safewCfg,
  allowFrom,
  groupAllowFrom,
  replyToMode,
  textLimit,
  useAccessGroups,
  nativeEnabled,
  nativeSkillsEnabled,
  nativeDisabledExplicit,
  resolveGroupPolicy,
  resolveSafewGroupConfig,
  shouldSkipUpdate,
  opts,
}: RegisterSafewNativeCommandsParams) => {
  const skillCommands =
    nativeEnabled && nativeSkillsEnabled ? listSkillCommandsForAgents({ cfg }) : [];
  const nativeCommands = nativeEnabled
    ? listNativeCommandSpecsForConfig(cfg, { skillCommands, provider: "safew" })
    : [];
  const reservedCommands = new Set(
    listNativeCommandSpecs().map((command) => command.name.toLowerCase()),
  );
  for (const command of skillCommands) {
    reservedCommands.add(command.name.toLowerCase());
  }
  const customResolution = resolveSafewCustomCommands({
    commands: safewCfg.customCommands,
    reservedCommands,
  });
  for (const issue of customResolution.issues) {
    runtime.error?.(danger(issue.message));
  }
  const customCommands = customResolution.commands;
  const allCommands: Array<{ command: string; description: string }> = [
    ...nativeCommands.map((command) => ({
      command: command.name,
      description: command.description,
    })),
    ...customCommands,
  ];

  if (allCommands.length > 0) {
    const requested = allCommands;
    const sanitized = sanitizeSafewBotCommands(ensureSafewCoreCommands(requested));
    const droppedPreview = sanitized.dropped
      .slice(0, 5)
      .map((d) => `${d.command}:${d.reason}`)
      .join(", ");
    logVerbose(
      `safew setMyCommands: accountId=${accountId} requested=${requested.length} registered=${sanitized.commands.length} dropped=${sanitized.dropped.length}${droppedPreview ? ` (e.g. ${droppedPreview})` : ""}`,
    );

    bot.api.setMyCommands(sanitized.commands).catch(async (err) => {
      logVerbose(`safew setMyCommands failed(will retry minimal): ${String(err)}`);

      const minimalRaw = pickSafewMinimalCommands(requested);
      const minimal = sanitizeSafewBotCommands(ensureSafewCoreCommands(minimalRaw));
      logVerbose(
        `safew setMyCommands retry(minimal): accountId=${accountId} registered=${minimal.commands.length}`,
      );
      try {
        await bot.api.setMyCommands(minimal.commands);
      } catch (err2) {
        runtime.error?.(danger(`safew setMyCommands retry(minimal) failed: ${String(err2)}`));
      }
    });

    if (typeof (bot as unknown as { command?: unknown }).command !== "function") {
      logVerbose("safew: bot.command unavailable; skipping native handlers");
    } else {
      for (const command of nativeCommands) {
        bot.command(command.name, async (ctx: SafewNativeCommandContext) => {
          const msg = ctx.message;
          if (!msg) return;
          if (shouldSkipUpdate(ctx)) return;
          const chatId = msg.chat.id;
          const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
          const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
          const isForum = (msg.chat as { is_forum?: boolean }).is_forum === true;
          const resolvedThreadId = resolveSafewForumThreadId({
            isForum,
            messageThreadId,
          });
          const storeAllowFrom = await readSafewAllowFromStore().catch(() => []);
          const { groupConfig, topicConfig } = resolveSafewGroupConfig(chatId, resolvedThreadId);
          const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
          const effectiveGroupAllow = normalizeAllowFromWithStore({
            allowFrom: groupAllowOverride ?? groupAllowFrom,
            storeAllowFrom,
          });
          const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";

          if (isGroup && groupConfig?.enabled === false) {
            await bot.api.sendMessage(chatId, "This group is disabled.");
            return;
          }
          if (isGroup && topicConfig?.enabled === false) {
            await bot.api.sendMessage(chatId, "This topic is disabled.");
            return;
          }
          if (isGroup && hasGroupAllowOverride) {
            const senderId = msg.from?.id;
            const senderUsername = msg.from?.username ?? "";
            if (
              senderId == null ||
              !isSenderAllowed({
                allow: effectiveGroupAllow,
                senderId: String(senderId),
                senderUsername,
              })
            ) {
              await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
              return;
            }
          }

          if (isGroup && useAccessGroups) {
            const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
            const groupPolicy = safewCfg.groupPolicy ?? defaultGroupPolicy ?? "open";
            if (groupPolicy === "disabled") {
              await bot.api.sendMessage(chatId, "Safew group commands are disabled.");
              return;
            }
            if (groupPolicy === "allowlist") {
              const senderId = msg.from?.id;
              if (senderId == null) {
                await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
                return;
              }
              const senderUsername = msg.from?.username ?? "";
              if (
                !isSenderAllowed({
                  allow: effectiveGroupAllow,
                  senderId: String(senderId),
                  senderUsername,
                })
              ) {
                await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
                return;
              }
            }
            const groupAllowlist = resolveGroupPolicy(chatId);
            if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
              await bot.api.sendMessage(chatId, "This group is not allowed.");
              return;
            }
          }

          const senderId = msg.from?.id ? String(msg.from.id) : "";
          const senderUsername = msg.from?.username ?? "";
          const dmAllow = normalizeAllowFromWithStore({
            allowFrom: allowFrom,
            storeAllowFrom,
          });
          const senderAllowed = isSenderAllowed({
            allow: dmAllow,
            senderId,
            senderUsername,
          });
          const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
            useAccessGroups,
            authorizers: [{ configured: dmAllow.hasEntries, allowed: senderAllowed }],
            modeWhenAccessGroupsOff: "configured",
          });
          if (!commandAuthorized) {
            await bot.api.sendMessage(chatId, "You are not authorized to use this command.");
            return;
          }

          const commandDefinition = findCommandByNativeName(command.name, "safew");
          const rawText = ctx.match?.trim() ?? "";
          const commandArgs = commandDefinition
            ? parseCommandArgs(commandDefinition, rawText)
            : rawText
              ? ({ raw: rawText } satisfies CommandArgs)
              : undefined;
          const prompt = commandDefinition
            ? buildCommandTextFromArgs(commandDefinition, commandArgs)
            : rawText
              ? `/${command.name} ${rawText}`
              : `/${command.name}`;
          const menu = commandDefinition
            ? resolveCommandArgMenu({
                command: commandDefinition,
                args: commandArgs,
                cfg,
              })
            : null;
          if (menu && commandDefinition) {
            const title =
              menu.title ??
              `Choose ${menu.arg.description || menu.arg.name} for /${commandDefinition.nativeName ?? commandDefinition.key}.`;
            const rows: Array<Array<{ text: string; callback_data: string }>> = [];
            for (let i = 0; i < menu.choices.length; i += 2) {
              const slice = menu.choices.slice(i, i + 2);
              rows.push(
                slice.map((choice) => {
                  const args: CommandArgs = {
                    values: { [menu.arg.name]: choice },
                  };
                  return {
                    text: choice,
                    callback_data: buildCommandTextFromArgs(commandDefinition, args),
                  };
                }),
              );
            }
            const replyMarkup = buildInlineKeyboard(rows);
            await bot.api.sendMessage(chatId, title, {
              ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
              ...(resolvedThreadId != null ? { message_thread_id: resolvedThreadId } : {}),
            });
            return;
          }
          const route = resolveAgentRoute({
            cfg,
            channel: "safew",
            accountId,
            peer: {
              kind: isGroup ? "group" : "dm",
              id: isGroup ? buildSafewGroupPeerId(chatId, resolvedThreadId) : String(chatId),
            },
          });
          const baseSessionKey = route.sessionKey;
          const dmThreadId = !isGroup ? resolvedThreadId : undefined;
          const threadKeys =
            dmThreadId != null
              ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
              : null;
          const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
          const tableMode = resolveMarkdownTableMode({
            cfg,
            channel: "safew",
            accountId: route.accountId,
          });
          const skillFilter = firstDefined(topicConfig?.skills, groupConfig?.skills);
          const systemPromptParts = [
            groupConfig?.systemPrompt?.trim() || null,
            topicConfig?.systemPrompt?.trim() || null,
          ].filter((entry): entry is string => Boolean(entry));
          const groupSystemPrompt =
            systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
          const conversationLabel = isGroup
            ? msg.chat.title
              ? `${msg.chat.title} id:${chatId}`
              : `group:${chatId}`
            : (buildSenderName(msg) ?? String(senderId || chatId));
          const ctxPayload = finalizeInboundContext({
            Body: prompt,
            RawBody: prompt,
            CommandBody: prompt,
            CommandArgs: commandArgs,
            From: isGroup ? buildSafewGroupFrom(chatId, resolvedThreadId) : `safew:${chatId}`,
            To: `slash:${senderId || chatId}`,
            ChatType: isGroup ? "group" : "direct",
            ConversationLabel: conversationLabel,
            GroupSubject: isGroup ? (msg.chat.title ?? undefined) : undefined,
            GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
            SenderName: buildSenderName(msg),
            SenderId: senderId || undefined,
            SenderUsername: senderUsername || undefined,
            Surface: "safew",
            MessageSid: String(msg.message_id),
            Timestamp: msg.date ? msg.date * 1000 : undefined,
            WasMentioned: true,
            CommandAuthorized: commandAuthorized,
            CommandSource: "native" as const,
            SessionKey: `safew:slash:${senderId || chatId}`,
            CommandTargetSessionKey: sessionKey,
            MessageThreadId: resolvedThreadId,
            IsForum: isForum,
            // Originating context for sub-agent announce routing
            OriginatingChannel: "safew" as const,
            OriginatingTo: `safew:${chatId}`,
          });

          const disableBlockStreaming =
            typeof safewCfg.blockStreaming === "boolean"
              ? !safewCfg.blockStreaming
              : undefined;
          const chunkMode = resolveChunkMode(cfg, "safew", route.accountId);

          await dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
              deliver: async (payload) => {
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
                  linkPreview: safewCfg.linkPreview,
                });
              },
              onError: (err, info) => {
                runtime.error?.(danger(`safew slash ${info.kind} reply failed: ${String(err)}`));
              },
            },
            replyOptions: {
              skillFilter,
              disableBlockStreaming,
            },
          });
        });
      }
    }
  } else if (nativeDisabledExplicit) {
    bot.api.setMyCommands([]).catch((err) => {
      runtime.error?.(danger(`safew clear commands failed: ${String(err)}`));
    });
  }
};
