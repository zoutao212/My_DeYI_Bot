import { AsyncLocalStorage } from "node:async_hooks";

export type LlmRequestSource =
  | "chat"
  | "webchat"
  | "heartbeat"
  | "cron"
  | "auto-reply"
  | "unknown"
  | (string & {});

export type LlmRequestContext = {
  runId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  source?: LlmRequestSource;
  toolName?: string;
};

const storage = new AsyncLocalStorage<LlmRequestContext>();

export function getLlmRequestContext(): LlmRequestContext | undefined {
  return storage.getStore();
}

export function withLlmRequestContext<T>(ctx: LlmRequestContext, fn: () => T): T {
  const merged = { ...storage.getStore(), ...ctx };
  return storage.run(merged, fn);
}
