import { EventEmitter } from "node:events";

export type RunEventPayload = {
  ts: number;
  sessionKey?: string;
  runId?: string;
  event: string;
  payload: unknown;
};

const runEventBus = new EventEmitter();

export function onRunEvent(handler: (evt: RunEventPayload) => void): () => void {
  runEventBus.on("run", handler);
  return () => {
    runEventBus.off("run", handler);
  };
}

export function emitRunEvent(evt: RunEventPayload) {
  runEventBus.emit("run", evt);
}
