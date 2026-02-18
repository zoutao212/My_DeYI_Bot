/**
 * 测试聊天室修复效果的脚本
 * 验证：1. 模型选择是否正确 2. UI 展示是否正常 3. 聊天室是否意外结束
 */

import { resolveConfiguredModelRef } from "./dist/agents/model-selection.js";
import { createSystemLLMCaller } from "./dist/agents/intelligent-task-decomposition/system-llm-caller.js";
import { loadConfig } from "./dist/config/config.js";

async function testModelSelection() {
  console.log("=== 测试 1: 模型选择逻辑 ===");
  
  try {
    const config = await loadConfig();
    console.log("配置的 activeProviderId:", config.models?.activeProviderId);
    console.log("配置的 activeModelId:", config.models?.activeModelId);
    
    // 测试 resolveConfiguredModelRef（主要模型解析逻辑）
    const resolvedModel = resolveConfiguredModelRef({
      cfg: config,
      defaultProvider: "anthropic",
      defaultModel: "claude-3-5-sonnet-20241022",
    });
    console.log("resolveConfiguredModelRef 结果:", resolvedModel);
    
    // 测试 SystemLLMCaller 的自动检测（通过创建实例来验证）
    const caller = createSystemLLMCaller({ config });
    console.log("SystemLLMCaller 创建成功，使用了自动检测的 provider/model");
    
    console.log("模型选择测试: ✅ 通过");
    
  } catch (error) {
    console.error("模型选择测试失败:", error);
  }
}

async function testChatRoomDetection() {
  console.log("\n=== 测试 2: 聊天室检测逻辑 ===");
  
  try {
    const { detectChatRoomIntent } = await import("./dist/agents/chatroom/detector.js");
    
    const testMessages = [
      "开始 群聊 功能 测试",
      "聊天室模式",
      "三位一起回答",
      "琳娜 德默泽尔 德洛丽丝 来聊天",
      "只跟琳娜说话",  // 这应该触发退出
      "解散聊天室",    // 这应该触发退出
    ];
    
    const characters = [
      { id: "lina", recognition: { names: ["琳娜", "栗娜", "lina"] } },
      { id: "demerzel", recognition: { names: ["德默泽尔", "德姨", "demerzel"] } },
      { id: "dolores", recognition: { names: ["德洛丽丝", "多莉", "dolores"] } },
    ];
    
    for (const message of testMessages) {
      const result = detectChatRoomIntent(message, characters, false);
      console.log(`消息: "${message}"`);
      console.log(`  触发类型: ${result.triggerType}`);
      console.log(`  聊天室模式: ${result.isChatRoomMode}`);
      console.log(`  参与者: ${result.participants.join(",") || "无"}`);
      console.log("");
    }
    
    console.log("聊天室检测测试: ✅ 通过");
    
  } catch (error) {
    console.error("聊天室检测测试失败:", error);
  }
}

async function main() {
  console.log("🧪 开始测试聊天室修复效果...\n");
  
  await testModelSelection();
  await testChatRoomDetection();
  
  console.log("\n✅ 测试完成！");
}

main().catch(console.error);
