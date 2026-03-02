import fs from "node:fs";

import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

export type SafewTokenSource = "env" | "tokenFile" | "config" | "none";

export type SafewTokenResolution = {
  token: string;
  source: SafewTokenSource;
};

type ResolveSafewTokenOpts = {
  envToken?: string | null;
  accountId?: string | null;
  logMissingFile?: (message: string) => void;
};

export function resolveSafewToken(
  cfg?: ClawdbotConfig,
  opts: ResolveSafewTokenOpts = {},
): SafewTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const safewCfg = cfg?.channels?.safew;
  const accountCfg =
    accountId !== DEFAULT_ACCOUNT_ID
      ? safewCfg?.accounts?.[accountId]
      : safewCfg?.accounts?.[DEFAULT_ACCOUNT_ID];
  const accountTokenFile = accountCfg?.tokenFile?.trim();
  if (accountTokenFile) {
    if (!fs.existsSync(accountTokenFile)) {
      opts.logMissingFile?.(
        `channels.safew.accounts.${accountId}.tokenFile not found: ${accountTokenFile}`,
      );
      return { token: "", source: "none" };
    }
    try {
      const token = fs.readFileSync(accountTokenFile, "utf-8").trim();
      if (token) {
        return { token, source: "tokenFile" };
      }
    } catch (err) {
      opts.logMissingFile?.(
        `channels.safew.accounts.${accountId}.tokenFile read failed: ${String(err)}`,
      );
      return { token: "", source: "none" };
    }
    return { token: "", source: "none" };
  }

  const accountToken = accountCfg?.botToken?.trim();
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const tokenFile = safewCfg?.tokenFile?.trim();
  if (tokenFile && allowEnv) {
    if (!fs.existsSync(tokenFile)) {
      opts.logMissingFile?.(`channels.safew.tokenFile not found: ${tokenFile}`);
      return { token: "", source: "none" };
    }
    try {
      const token = fs.readFileSync(tokenFile, "utf-8").trim();
      if (token) {
        return { token, source: "tokenFile" };
      }
    } catch (err) {
      opts.logMissingFile?.(`channels.safew.tokenFile read failed: ${String(err)}`);
      return { token: "", source: "none" };
    }
  }

  const configToken = safewCfg?.botToken?.trim();
  if (configToken && allowEnv) {
    return { token: configToken, source: "config" };
  }

  const envToken = allowEnv ? (opts.envToken ?? process.env.SAFEW_BOT_TOKEN)?.trim() : "";
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
