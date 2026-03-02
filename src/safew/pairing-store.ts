import type { ClawdbotConfig } from "../config/config.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";

export type SafewPairingListEntry = {
  chatId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
};

const PROVIDER = "safew" as const;

export async function readSafewAllowFromStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return readChannelAllowFromStore(PROVIDER, env);
}

export async function addSafewAllowFromStoreEntry(params: {
  entry: string | number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  return addChannelAllowFromStoreEntry({
    channel: PROVIDER,
    entry: params.entry,
    env: params.env,
  });
}

export async function listSafewPairingRequests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SafewPairingListEntry[]> {
  const list = await listChannelPairingRequests(PROVIDER, env);
  return list.map((r) => ({
    chatId: r.id,
    code: r.code,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    username: r.meta?.username,
    firstName: r.meta?.firstName,
    lastName: r.meta?.lastName,
  }));
}

export async function upsertSafewPairingRequest(params: {
  chatId: string | number;
  username?: string;
  firstName?: string;
  lastName?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: string; created: boolean }> {
  return upsertChannelPairingRequest({
    channel: PROVIDER,
    id: String(params.chatId),
    env: params.env,
    meta: {
      username: params.username,
      firstName: params.firstName,
      lastName: params.lastName,
    },
  });
}

export async function approveSafewPairingCode(params: {
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ chatId: string; entry?: SafewPairingListEntry } | null> {
  const res = await approveChannelPairingCode({
    channel: PROVIDER,
    code: params.code,
    env: params.env,
  });
  if (!res) return null;
  const entry = res.entry
    ? {
        chatId: res.entry.id,
        code: res.entry.code,
        createdAt: res.entry.createdAt,
        lastSeenAt: res.entry.lastSeenAt,
        username: res.entry.meta?.username,
        firstName: res.entry.meta?.firstName,
        lastName: res.entry.meta?.lastName,
      }
    : undefined;
  return { chatId: res.id, entry };
}

export async function resolveSafewEffectiveAllowFrom(params: {
  cfg: ClawdbotConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ dm: string[]; group: string[] }> {
  const env = params.env ?? process.env;
  const cfgAllowFrom = (params.cfg.channels?.safew?.allowFrom ?? [])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^(safew|tg):/i, ""))
    .filter((v) => v !== "*");
  const cfgGroupAllowFrom = (params.cfg.channels?.safew?.groupAllowFrom ?? [])
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => v.replace(/^(safew|tg):/i, ""))
    .filter((v) => v !== "*");
  const storeAllowFrom = await readSafewAllowFromStore(env);

  const dm = Array.from(new Set([...cfgAllowFrom, ...storeAllowFrom]));
  const group = Array.from(
    new Set([
      ...(cfgGroupAllowFrom.length > 0 ? cfgGroupAllowFrom : cfgAllowFrom),
      ...storeAllowFrom,
    ]),
  );
  return { dm, group };
}
