/**
 * 调试 Hook 系统
 */

import { loadClawdbotPlugins } from "./dist/plugins/loader.js";
import { getGlobalHookRunner } from "./dist/plugins/hook-runner-global.js";

console.log("Loading plugins...");

const registry = loadClawdbotPlugins({
  config: {},
  cache: false,
});

console.log(`\nTotal plugins: ${registry.plugins.length}`);
console.log(`Total typedHooks: ${registry.typedHooks.length}`);

const pipelinePlugin = registry.plugins.find(p => p.id === "clawdbot-pipeline");

if (pipelinePlugin) {
  console.log("\n✅ Pipeline Plugin found!");
  console.log(`  Hook count: ${pipelinePlugin.hookCount}`);
  console.log(`  Hook names: ${pipelinePlugin.hookNames.join(", ")}`);
}

console.log("\nAll typedHooks:");
registry.typedHooks.forEach(h => {
  console.log(`  - ${h.hookName} (plugin: ${h.pluginId})`);
});

const hookRunner = getGlobalHookRunner();
if (hookRunner) {
  console.log("\n✅ Global hook runner initialized");
  console.log(`  Has before_agent_start hooks: ${hookRunner.hasHooks("before_agent_start")}`);
  console.log(`  before_agent_start hook count: ${hookRunner.getHookCount("before_agent_start")}`);
} else {
  console.log("\n❌ Global hook runner NOT initialized");
}
