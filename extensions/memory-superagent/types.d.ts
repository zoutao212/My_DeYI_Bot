/**
 * Type declarations for clawdbot/plugin-sdk
 * 
 * This file provides type hints for IDE when the main project is not built.
 * The actual types are in ../../src/plugin-sdk/index.ts
 */

declare module "clawdbot/plugin-sdk" {
  export type { ClawdbotPluginApi } from "../../src/plugins/types";
  export type { AnyAgentTool } from "../../src/agents/tools/common";
  export type { PluginRuntime } from "../../src/plugins/runtime/types";
  export { emptyPluginConfigSchema } from "../../src/plugins/config-schema";
  export { stringEnum } from "../../src/plugins/config-schema";
  
  // Re-export common types
  export type {
    ClawdbotPluginToolContext,
    ClawdbotPluginToolFactory,
    ClawdbotPluginConfigSchema,
    PluginConfigUiHint,
    PluginLogger,
  } from "../../src/plugins/types";
  
  export type {
    PluginHookName,
    PluginHookHandlerMap,
    PluginHookBeforeAgentStartEvent,
    PluginHookBeforeAgentStartResult,
    PluginHookAgentEndEvent,
    PluginHookAgentContext,
  } from "../../src/plugins/types";
}
