/**
 * 直接测试 Hook Runner
 */

import { loadClawdbotPlugins } from "./dist/plugins/loader.js";
import { getGlobalHookRunner } from "./dist/plugins/hook-runner-global.js";

console.log("Loading plugins...");

const registry = loadClawdbotPlugins({
  config: {},
  cache: false,
});

console.log(`Total typedHooks: ${registry.typedHooks.length}\n`);

const hookRunner = getGlobalHookRunner();

if (hookRunner) {
  console.log("✅ Hook runner initialized\n");
  
  // 测试 before_agent_start hook
  console.log("Testing before_agent_start hook...");
  const result = await hookRunner.runBeforeAgentStart(
    {
      prompt: "栗娜，你好",
      messages: [],
    },
    {
      agentId: "main",
      sessionKey: "test",
      workspaceDir: process.cwd(),
    }
  );
  
  console.log("\nHook result:");
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("❌ Hook runner NOT initialized");
}
