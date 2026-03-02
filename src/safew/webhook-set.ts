import { type ApiClientOptions, Bot } from "grammy";
import { resolveSafewFetch } from "./fetch.js";

export async function setSafewWebhook(opts: {
  token: string;
  url: string;
  secret?: string;
  dropPendingUpdates?: boolean;
}) {
  const fetchImpl = resolveSafewFetch();
  const client: ApiClientOptions | undefined = fetchImpl
    ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
    : undefined;
  const bot = new Bot(opts.token, client ? { client } : undefined);
  await bot.api.setWebhook(opts.url, {
    secret_token: opts.secret,
    drop_pending_updates: opts.dropPendingUpdates ?? false,
  });
}

export async function deleteSafewWebhook(opts: { token: string }) {
  const fetchImpl = resolveSafewFetch();
  const client: ApiClientOptions | undefined = fetchImpl
    ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
    : undefined;
  const bot = new Bot(opts.token, client ? { client } : undefined);
  await bot.api.deleteWebhook();
}
