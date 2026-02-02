/**
 * Lina Agent 基本使用示例
 */

import { createLinaAgent } from "../../src/agents/lina/agent.js";

async function main() {
  // 1. 创建 Lina Agent（不提供 TaskDelegator 和 MemoryService）
  console.log("=== 创建 Lina Agent ===");
  const lina = await createLinaAgent({
    characterName: "lina",
    basePath: process.cwd(),
  });

  console.log("✓ Lina Agent 创建成功");
  console.log(`角色名称: ${lina.getConfig()?.name}`);
  console.log(`角色版本: ${lina.getConfig()?.version}`);
  console.log();

  // 2. 查看 System Prompt
  console.log("=== System Prompt ===");
  const systemPrompt = lina.getSystemPrompt();
  console.log(systemPrompt?.substring(0, 200) + "...");
  console.log();

  // 3. 处理通用对话
  console.log("=== 通用对话 ===");
  const response1 = await lina.handleMessage({
    userMessage: "你好，栗娜",
    userName: "张三",
  });
  console.log(`用户: 你好，栗娜`);
  console.log(`栗娜: ${response1.message}`);
  console.log(`能力: ${response1.capability}`);
  console.log();

  // 4. 处理任务管理请求（没有 TaskDelegator）
  console.log("=== 任务管理请求 ===");
  const response2 = await lina.handleMessage({
    userMessage: "帮我创建一个任务：完成项目报告",
    userName: "张三",
  });
  console.log(`用户: 帮我创建一个任务：完成项目报告`);
  console.log(`栗娜: ${response2.message}`);
  console.log(`能力: ${response2.capability}`);
  console.log();

  // 5. 处理记忆服务请求（没有 MemoryService）
  console.log("=== 记忆服务请求 ===");
  const response3 = await lina.handleMessage({
    userMessage: "记住我今天开了一个重要会议",
    userName: "张三",
  });
  console.log(`用户: 记住我今天开了一个重要会议`);
  console.log(`栗娜: ${response3.message}`);
  console.log(`能力: ${response3.capability}`);
  console.log();

  // 6. 处理日程规划请求
  console.log("=== 日程规划请求 ===");
  const response4 = await lina.handleMessage({
    userMessage: "今天有什么安排？",
    userName: "张三",
  });
  console.log(`用户: 今天有什么安排？`);
  console.log(`栗娜: ${response4.message}`);
  console.log(`能力: ${response4.capability}`);
  console.log();

  // 7. 查看路由元数据
  console.log("=== 路由元数据 ===");
  console.log(`路由能力: ${response4.metadata?.routing.capability}`);
  console.log(`置信度: ${response4.metadata?.routing.confidence}`);
  console.log(`原因: ${response4.metadata?.routing.reason}`);
}

main().catch(console.error);
