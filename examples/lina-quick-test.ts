/**
 * Lina Agent 快速测试脚本
 * 用于验证 Lina 的核心功能
 */

import { createLinaAgent } from "../src/agents/lina/agent.js";
import { log } from "../src/infra/log.js";

async function main() {
  console.log("=== Lina Agent 快速测试 ===\n");

  try {
    // 1. 创建 Lina Agent
    console.log("1. 创建 Lina Agent...");
    const lina = await createLinaAgent({
      characterName: "lina",
      basePath: process.cwd(),
    });

    console.log("✓ Lina Agent 创建成功\n");

    // 2. 查看配置
    console.log("2. 角色配置:");
    const config = lina.getConfig();
    console.log(`   - 名称: ${config?.name}`);
    console.log(`   - 版本: ${config?.version}`);
    console.log(`   - 核心特质: ${config?.personality.traits.join("、")}`);
    console.log();

    // 3. 查看 System Prompt
    console.log("3. System Prompt 预览:");
    const systemPrompt = lina.getSystemPrompt();
    if (systemPrompt) {
      const lines = systemPrompt.split("\n").slice(0, 10);
      console.log(lines.join("\n"));
      console.log("   ...(省略)");
    }
    console.log();

    // 4. 测试消息处理
    console.log("4. 测试消息处理:\n");

    const testMessages = [
      "你好，Lina！",
      "帮我记住：今天学习了 TypeScript",
      "我有一个任务：完成项目文档",
      "今天的日程安排是什么？",
    ];

    for (const message of testMessages) {
      console.log(`   用户: ${message}`);

      const response = await lina.handleMessage({
        userMessage: message,
        userName: "测试用户",
      });

      console.log(`   Lina: ${response.message}`);
      console.log(`   能力: ${response.capability}`);
      console.log(
        `   路由: ${response.metadata?.routing.capability} (置信度: ${response.metadata?.routing.confidence})`
      );
      console.log();
    }

    console.log("✓ 测试完成！");
  } catch (error) {
    console.error("✗ 测试失败:", error);
    process.exit(1);
  }
}

main();
