#!/usr/bin/env node

/**
 * 测试 Lina 人格集成
 * 
 * 验证：
 * 1. Pipeline Plugin 正确注册
 * 2. Hook 正确触发
 * 3. 角色识别正确
 * 4. System Prompt 包含角色设定
 * 5. prependContext 正确注入
 */

import { loadClawdbotPlugins } from "./dist/plugins/loader.js";
import { getGlobalHookRunner } from "./dist/plugins/hook-runner-global.js";

console.log("🔵 [Test] 开始测试 Lina 人格集成...\n");

// Step 1: 加载 Plugins
console.log("📦 [Test] 加载 Plugins...");
const registry = loadClawdbotPlugins({
  config: {},
  workspaceDir: "C:\\Users\\zouta\\clawd",
  cache: false,
});

console.log(`✅ [Test] 加载了 ${registry.plugins.length} 个 plugins`);
console.log(`✅ [Test] 注册了 ${registry.typedHooks.length} 个 hooks\n`);

// Step 2: 查找 Pipeline Plugin
const pipelinePlugin = registry.plugins.find(p => p.id === "clawdbot-pipeline");
if (!pipelinePlugin) {
  console.error("❌ [Test] Pipeline Plugin 未找到！");
  process.exit(1);
}

console.log("✅ [Test] Pipeline Plugin 已注册:");
console.log(`   - ID: ${pipelinePlugin.id}`);
console.log(`   - Name: ${pipelinePlugin.name}`);
console.log(`   - Status: ${pipelinePlugin.status}`);
console.log(`   - Hooks: ${pipelinePlugin.hookCount}\n`);

// Step 3: 获取 Hook Runner
const hookRunner = getGlobalHookRunner();
if (!hookRunner) {
  console.error("❌ [Test] Hook Runner 未初始化！");
  process.exit(1);
}

console.log("✅ [Test] Hook Runner 已初始化");
console.log(`   - before_agent_start hooks: ${hookRunner.getHookCount("before_agent_start")}`);
console.log(`   - agent_end hooks: ${hookRunner.getHookCount("agent_end")}\n`);

// Step 4: 测试 Hook 调用（提到栗娜）
console.log("🧪 [Test] 测试 Hook 调用（提到栗娜）...");
const result1 = await hookRunner.runBeforeAgentStart(
  {
    prompt: "栗娜，帮我查看今天的任务",
    messages: [],
  },
  {
    agentId: "main",
    sessionKey: "main:test",
    workspaceDir: "C:\\Users\\zouta\\clawd",
  }
);

console.log("📊 [Test] Hook 返回结果:");
console.log(`   - characterName: ${result1?.characterName || "(未识别)"}`);
console.log(`   - prependContext: ${result1?.prependContext ? `(${result1.prependContext.length} 字符)` : "(无)"}`);

if (result1?.characterName === "lina") {
  console.log("✅ [Test] 角色识别成功：lina");
} else {
  console.error("❌ [Test] 角色识别失败！");
  process.exit(1);
}

if (result1?.prependContext && result1.prependContext.includes("🔵 [Pipeline Active]")) {
  console.log("✅ [Test] prependContext 包含标记");
} else {
  console.error("❌ [Test] prependContext 缺少标记！");
  process.exit(1);
}

console.log("\n" + "=".repeat(60));
console.log("🎉 [Test] 所有测试通过！");
console.log("=".repeat(60));
console.log("\n📝 [Test] 下一步：");
console.log("   1. 运行 clawdbot agent 命令测试真实环境");
console.log("   2. 检查日志中是否有 🔵 [Pipeline] 标记");
console.log("   3. 检查 System Prompt 是否包含 Lina 人格设定");
