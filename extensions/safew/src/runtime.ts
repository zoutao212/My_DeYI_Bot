import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSafewRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getSafewRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Safew runtime not initialized");
  }
  return runtime;
}
