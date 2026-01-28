import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { emitRunEvent } from "./run-events.js";

function resolveRuntimeLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAWDBOT_RUNTIMELOG_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveStateDir(env), "runtimelog");
}

export function getRuntimeLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveRuntimeLogDir(env);
}

function safeTimestampForFilename(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  return `${yyyy}${MM}${dd}_${HH}${mm}${ss}_${ms}`;
}

function redactSecrets(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (/^(apiKey|token|authorization)$/i.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = redactSecrets(v);
  }
  return out;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n... truncated (${value.length} chars)`;
}

function safeKeyForFilename(value: string, maxLen: number): string {
  return value
    .trim()
    .slice(0, maxLen)
    .replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function resolveTraceFilePath(params: { dir: string; sessionKey?: string; runId?: string }): string {
  const sessionKeySafe = safeKeyForFilename(params.sessionKey ?? "", 80);
  const runIdSafe = safeKeyForFilename(params.runId ?? "", 40);
  const suffix = [sessionKeySafe, runIdSafe].filter(Boolean).join("__");
  const filename = `trace${suffix ? `__${suffix}` : ""}.jsonl`;
  return path.join(params.dir, filename);
}

export function getTraceFilePathForRun(params: {
  sessionKey?: string;
  runId?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const dir = resolveRuntimeLogDir(params.env);
  return resolveTraceFilePath({ dir, sessionKey: params.sessionKey, runId: params.runId });
}

export async function appendRuntimeTrace(params: {
  ts?: number;
  sessionKey?: string;
  runId?: string;
  event: string;
  payload: unknown;
}): Promise<string | null> {
  const dir = resolveRuntimeLogDir();
  const ts = typeof params.ts === "number" ? params.ts : Date.now();
  const filePath = resolveTraceFilePath({
    dir,
    sessionKey: params.sessionKey,
    runId: params.runId,
  });
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const redacted = redactSecrets(params.payload);
    const line = truncateText(
      JSON.stringify({ ts, event: params.event, sessionKey: params.sessionKey, runId: params.runId, payload: redacted }),
      200_000,
    );
    await fs.promises.appendFile(filePath, line + "\n", "utf-8");

    emitRunEvent({
      ts,
      sessionKey: params.sessionKey,
      runId: params.runId,
      event: params.event,
      payload: redacted,
    });
    return filePath;
  } catch (err) {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[runtimelog] trace append failed filePath=${filePath} err=${msg}`);
    } catch {
      // ignore
    }
    return null;
  }
}

export async function writeRunBundleLog(params: {
  ts?: number;
  sessionKey?: string;
  runId?: string;
  payload: unknown;
}): Promise<string | null> {
  const dir = resolveRuntimeLogDir();
  const ts = typeof params.ts === "number" ? params.ts : Date.now();
  const stamp = safeTimestampForFilename(ts);
  const sessionKeySafe = safeKeyForFilename(params.sessionKey ?? "", 80);
  const runIdSafe = safeKeyForFilename(params.runId ?? "", 40);
  const suffix = [sessionKeySafe, runIdSafe].filter(Boolean).join("__");
  const filename = `runbundle_${stamp}${suffix ? `__${suffix}` : ""}.json`;
  const filePath = path.join(dir, filename);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const redacted = redactSecrets(params.payload);
    const text = truncateText(JSON.stringify(redacted, null, 2), 400_000);
    await fs.promises.writeFile(filePath, text + "\n", "utf-8");
    return filePath;
  } catch (err) {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[runtimelog] runbundle write failed filePath=${filePath} err=${msg}`);
    } catch {
    }
    return null;
  }
}

export async function writeRuntimeLog(params: {
  kind: "sendmsg" | "resmsg";
  ts?: number;
  sessionKey?: string;
  runId?: string;
  payload: unknown;
}): Promise<string | null> {
  const dir = resolveRuntimeLogDir();
  const ts = typeof params.ts === "number" ? params.ts : Date.now();
  const stamp = safeTimestampForFilename(ts);
  const sessionKeySafe = safeKeyForFilename(params.sessionKey ?? "", 80);
  const runIdSafe = safeKeyForFilename(params.runId ?? "", 40);
  const suffix = [sessionKeySafe, runIdSafe].filter(Boolean).join("__");
  const filename = `${params.kind}_${stamp}${suffix ? `__${suffix}` : ""}.log`;
  const filePath = path.join(dir, filename);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const redacted = redactSecrets(params.payload);
    const text = truncateText(JSON.stringify(redacted, null, 2), 200_000);
    await fs.promises.writeFile(filePath, text + "\n", "utf-8");
    return filePath;
  } catch (err) {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[runtimelog] write failed filePath=${filePath} err=${msg}`);
    } catch {
    }
    return null;
  }
}
