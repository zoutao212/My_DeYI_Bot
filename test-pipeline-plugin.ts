/**
 * 测试 Pipeline Plugin 是否正确注册
 */

import { loadClawdbotPlugins } from "./src/plugins/loader.js";

console.log("Loading plugins...");

const registry = loadClawdbotPlugins({
  config: {},
  cache: false,
});

console.log(`\nTotal plugins: ${registry.plugins.length}`);

const pipelinePlugin = registry.plugins.find(p => p.id === "clawdbot-pipeline");

if (pipelinePlugin) {
  console.log("\n✅ Pipeline Plugin found!");
  console.log(`  Name: ${pipelinePlugin.name}`);
  console.log(`  Description: ${pipelinePlugin.description}`);
  console.log(`  Status: ${pipelinePlugin.status}`);
  console.log(`  Origin: ${pipelinePlugin.origin}`);
  console.log(`  Hooks: ${pipelinePlugin.hookNames.length}`);
  console.log(`  Hook names: ${pipelinePlugin.hookNames.join(", ")}`);
} else {
  console.log("\n❌ Pipeline Plugin NOT found!");
}

console.log("\nAll plugins:");
registry.plugins.forEach(p => {
  console.log(`  - ${p.id} (${p.status})`);
});
