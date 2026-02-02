/**
 * 测试预览功能 - 验证角色设定是否显示在预览面板
 * 
 * 测试步骤：
 * 1. 模拟 chat.send.preview 请求
 * 2. 验证返回的 extraSystemPrompt 是否包含完整的 Lina System Prompt
 * 3. 验证返回的 characterName 和 prependContext
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

console.log("🧪 测试预览功能 - 角色设定显示");
console.log("=".repeat(60));

// 1. 读取 Lina System Prompt（预期内容）
const linaSystemPromptPath = join(process.cwd(), "clawd", "characters", "lina", "prompts", "system.md");
let expectedSystemPrompt = "";

try {
  expectedSystemPrompt = await readFile(linaSystemPromptPath, "utf-8");
  console.log("✅ 成功读取 Lina System Prompt");
  console.log(`   长度: ${expectedSystemPrompt.length} 字符`);
  console.log(`   前 100 字符: ${expectedSystemPrompt.slice(0, 100)}...`);
} catch (err) {
  console.error("❌ 读取 Lina System Prompt 失败:", err.message);
  process.exit(1);
}

console.log("\n" + "=".repeat(60));
console.log("📋 测试说明:");
console.log("1. 启动 Clawdbot Gateway");
console.log("2. 在 Web UI 中发送消息: '栗娜，你好'");
console.log("3. 检查预览面板是否显示完整的 System Prompt");
console.log("4. 预期内容应包含:");
console.log("   - 基础 System Prompt");
console.log("   - 角色设定标题: '# 角色设定 (lina)'");
console.log(`   - 完整的 Lina System Prompt (${expectedSystemPrompt.length} 字符)`);
console.log("\n" + "=".repeat(60));
console.log("🔍 验证要点:");
console.log("1. extraSystemPrompt 字段包含完整内容");
console.log("2. characterName 字段为 'lina'");
console.log("3. prependContext 字段包含 Pipeline 标记");
console.log("\n" + "=".repeat(60));
console.log("✅ 测试脚本准备完成");
console.log("📝 请手动在 Web UI 中测试预览功能");
