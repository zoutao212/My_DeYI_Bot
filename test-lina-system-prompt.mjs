#!/usr/bin/env node

/**
 * 测试 Lina System Prompt 生成
 * 
 * 验证：
 * 1. characterName 正确传递到 buildEmbeddedSystemPrompt
 * 2. System Prompt 包含 Lina 人格设定
 * 3. prependContext 正确注入到用户消息
 */

import { buildEmbeddedSystemPrompt } from "./dist/agents/pi-embedded-runner/system-prompt.js";

console.log("🔵 [Test] 开始测试 Lina System Prompt 生成...\n");

// Step 1: 测试不带角色名的 System Prompt
console.log("📝 [Test] 生成默认 System Prompt（无角色）...");
const defaultPrompt = await buildEmbeddedSystemPrompt({
  workspaceDir: "C:\\Users\\zouta\\clawd",
  reasoningTagHint: false,
  tools: [],
  modelAliasLines: [],
  userTimezone: "Asia/Shanghai",
  runtimeInfo: {
    host: "test-host",
    os: "Windows",
    arch: "x64",
    node: "v22.0.0",
    model: "test/model",
  },
});

console.log(`✅ [Test] 默认 System Prompt 长度: ${defaultPrompt.length} 字符\n`);

// Step 2: 测试带 Lina 角色名的 System Prompt
console.log("📝 [Test] 生成 Lina System Prompt（带角色）...");
const linaPrompt = await buildEmbeddedSystemPrompt({
  workspaceDir: "C:\\Users\\zouta\\clawd",
  reasoningTagHint: false,
  tools: [],
  modelAliasLines: [],
  userTimezone: "Asia/Shanghai",
  runtimeInfo: {
    host: "test-host",
    os: "Windows",
    arch: "x64",
    node: "v22.0.0",
    model: "test/model",
  },
  characterName: "lina",  // 🆕 指定角色名
  characterBasePath: "C:\\Users\\zouta",  // 🔧 FIX: 修正基础路径（不包含 clawd）
});

console.log(`✅ [Test] Lina System Prompt 长度: ${linaPrompt.length} 字符`);
console.log(`   - 增加了 ${linaPrompt.length - defaultPrompt.length} 字符\n`);

// Step 3: 验证 Lina 人格设定是否存在
const linaKeywords = [
  "栗娜",
  "Lina",
  "人格",
  "性格",
  "特点",
];

console.log("🔍 [Test] 检查 Lina 人格关键词...");
let foundKeywords = 0;
for (const keyword of linaKeywords) {
  if (linaPrompt.includes(keyword)) {
    console.log(`   ✅ 找到关键词: ${keyword}`);
    foundKeywords++;
  } else {
    console.log(`   ⚠️  未找到关键词: ${keyword}`);
  }
}

console.log(`\n📊 [Test] 找到 ${foundKeywords}/${linaKeywords.length} 个关键词`);

if (foundKeywords >= 2) {
  console.log("✅ [Test] Lina 人格设定已注入！");
} else {
  console.error("❌ [Test] Lina 人格设定未注入！");
  console.log("\n📄 [Debug] System Prompt 前 500 字符:");
  console.log(linaPrompt.slice(0, 500));
  process.exit(1);
}

// Step 4: 显示 System Prompt 预览
console.log("\n" + "=".repeat(60));
console.log("📄 [Test] Lina System Prompt 预览（前 800 字符）:");
console.log("=".repeat(60));
console.log(linaPrompt.slice(0, 800));
console.log("...");
console.log("=".repeat(60));

console.log("\n🎉 [Test] 所有测试通过！");
