import { type RunOptions, run } from "@grammyjs/runner";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatDurationMs } from "../infra/format-duration.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveSafewAccount } from "./accounts.js";
import { resolveSafewAllowedUpdates } from "./allowed-updates.js";
import { createSafewBot } from "./bot.js";
import { makeProxyFetch } from "./proxy.js";
import { readSafewUpdateOffset, writeSafewUpdateOffset } from "./update-offset-store.js";
import { startSafewWebhook } from "./webhook.js";

export type MonitorSafewOpts = {
  token?: string;
  accountId?: string;
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export function createSafewRunnerOptions(cfg: ClawdbotConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveSafewAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
    },
  };
}

const SAFEW_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") return false;
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) return false;
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};

export async function monitorSafewProvider(opts: MonitorSafewOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveSafewAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = opts.token?.trim() || account.token;
  if (!token) {
    throw new Error(
      `Safew bot token missing for account "${account.accountId}" (set channels.safew.accounts.${account.accountId}.botToken/tokenFile or SAFEW_BOT_TOKEN for default).`,
    );
  }

  const proxyFetch =
    opts.proxyFetch ??
    (account.config.proxy ? makeProxyFetch(account.config.proxy as string) : undefined);

  let lastUpdateId = await readSafewUpdateOffset({
    accountId: account.accountId,
  });
  const persistUpdateId = async (updateId: number) => {
    if (lastUpdateId !== null && updateId <= lastUpdateId) return;
    lastUpdateId = updateId;
    try {
      await writeSafewUpdateOffset({
        accountId: account.accountId,
        updateId,
      });
    } catch (err) {
      (opts.runtime?.error ?? console.error)(
        `safew: failed to persist update offset: ${String(err)}`,
      );
    }
  };

  const bot = createSafewBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
    config: cfg,
    accountId: account.accountId,
    updateOffset: {
      lastUpdateId,
      onUpdateId: persistUpdateId,
    },
  });

  if (opts.useWebhook) {
    await startSafewWebhook({
      token,
      accountId: account.accountId,
      config: cfg,
      path: opts.webhookPath,
      port: opts.webhookPort,
      secret: opts.webhookSecret,
      runtime: opts.runtime as RuntimeEnv,
      fetch: proxyFetch,
      abortSignal: opts.abortSignal,
      publicUrl: opts.webhookUrl,
    });
    return;
  }

  // Use grammyjs/runner for concurrent update processing
  const log = opts.runtime?.log ?? console.log;
  let restartAttempts = 0;

  while (!opts.abortSignal?.aborted) {
    const runner = run(bot, createSafewRunnerOptions(cfg));
    const stopOnAbort = () => {
      if (opts.abortSignal?.aborted) {
        void runner.stop();
      }
    };
    opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      // runner.task() returns a promise that resolves when the runner stops
      await runner.task();
      return;
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        throw err;
      }
      if (!isGetUpdatesConflict(err)) {
        throw err;
      }
      restartAttempts += 1;
      const delayMs = computeBackoff(SAFEW_POLL_RESTART_POLICY, restartAttempts);
      log(`Safew getUpdates conflict; retrying in ${formatDurationMs(delayMs)}.`);
      try {
        await sleepWithAbort(delayMs, opts.abortSignal);
      } catch (sleepErr) {
        if (opts.abortSignal?.aborted) return;
        throw sleepErr;
      }
    } finally {
      opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    }
  }
}
