/**
 * 主动检索增强系统测试脚本
 *
 * 使用方法:
 * node --loader ts-node/esm test-proactive-retrieval.mjs
 *
 * 或在 VS Code 中直接运行:
 * Run: test-proactive-retrieval.mjs
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "./src/config/loader.js";
import { proactiveRetrieval } from "./src/agents/proactive-retrieval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function testProactiveRetrieval() {
  console.log("🔍 开始测试主动检索增强系统...\n");
  
  // 加载配置
  const config = await loadConfig(__dirname);
  if (!config) {
    console.error("❌ 无法加载 Clawdbot 配置");
    return;
  }
  
  console.log("✅ 配置加载成功\n");
  
  // 测试用例 1: 简单查询
  console.log("📝 测试用例 1: 简单记忆检索");
  console.log("=" .repeat(50));
  const query1 = "上次讨论的项目进度";
  console.log(`查询: "${query1}"\n`);
  
  const result1 = await proactiveRetrieval(config, {
    userMessage: query1,
    maxSnippets: 5,
    minScore: 0.3,
    enableMemory: true,
    enableNovel: false,
    enableAgentDef: false,
    enableToolDefs: false,
  });
  
  console.log(`⏱️  耗时：${result1.durationMs}ms`);
  console.log(`📊 统计：记忆=${result1.stats.memory}, 小说=${result1.stats.novel}, Agent=${result1.stats.agentDef}, 工具=${result1.stats.toolDef}`);
  console.log(`🔑 关键词：${result1.extractedKeywords.join(", ")}`);
  console.log(`📄 片段数：${result1.snippets.length}`);
  
  if (result1.formattedContext) {
    console.log("\n📋 检索到的上下文:");
    console.log("-".repeat(50));
    console.log(result1.formattedContext.substring(0, 1000));
    if (result1.formattedContext.length > 1000) {
      console.log("...[已截断]");
    }
  } else {
    console.log("\n⚠️  未检索到相关内容");
  }
  
  console.log("\n");
  
  // 测试用例 2: 小说创作查询
  console.log("📖 测试用例 2: 小说创作查询");
  console.log("=" .repeat(50));
  const query2 = "林娜在星港与艾伦分别的场景";
  console.log(`查询："${query2}"\n`);
  
  const result2 = await proactiveRetrieval(config, {
    userMessage: query2,
    maxSnippets: 8,
    minScore: 0.25,
    enableMemory: true,
    enableNovel: true,
    enableAgentDef: false,
    enableToolDefs: false,
  });
  
  console.log(`⏱️  耗时：${result2.durationMs}ms`);
  console.log(`📊 统计：记忆=${result2.stats.memory}, 小说=${result2.stats.novel}`);
  console.log(`🔑 关键词：${result2.extractedKeywords.join(", ")}`);
  console.log(`📄 片段数：${result2.snippets.length}`);
  
  if (result2.formattedContext) {
    console.log("\n📋 检索到的上下文:");
    console.log("-".repeat(50));
    console.log(result2.formattedContext.substring(0, 1500));
    if (result2.formattedContext.length > 1500) {
      console.log("...[已截断]");
    }
  } else {
    console.log("\n⚠️  未检索到相关内容");
  }
  
  console.log("\n");
  
  // 测试用例 3: 带 Agent 定义的查询
  console.log("🤖 测试用例 3: 带 Agent 定义的查询");
  console.log("=" .repeat(50));
  const query3 = "如何优化任务分解系统";
  const agentDef = `
你是一个智能任务分解助手。
你的职责是将复杂任务拆解为可执行的子任务。
你需要考虑任务之间的依赖关系。
你应该优先处理关键路径上的任务。
任务分解时需要评估每个子任务的难度和预计耗时。
  `.trim();
  
  console.log(`查询："${query3}"`);
  console.log(`Agent 定义：${agentDef.length} 字符\n`);
  
  const result3 = await proactiveRetrieval(config, {
    userMessage: query3,
    agentDefinition: agentDef,
    maxSnippets: 6,
    minScore: 0.35,
    enableMemory: true,
    enableNovel: false,
    enableAgentDef: true,
    enableToolDefs: false,
  });
  
  console.log(`⏱️  耗时：${result3.durationMs}ms`);
  console.log(`📊 统计：记忆=${result3.stats.memory}, Agent=${result3.stats.agentDef}`);
  console.log(`🔑 关键词：${result3.extractedKeywords.join(", ")}`);
  
  if (result3.formattedContext) {
    console.log("\n📋 检索到的上下文:");
    console.log("-".repeat(50));
    console.log(result3.formattedContext);
  }
  
  console.log("\n");
  
  // 测试用例 4: 快速检索模式
  console.log("⚡ 测试用例 4: 快速检索模式");
  console.log("=" .repeat(50));
  const query4 = "昨天的会议记录";
  console.log(`查询："${query4}"\n`);
  
  const { quickRetrieval } = await import("./src/agents/proactive-retrieval.js");
  const quickCtx = await quickRetrieval(config, query4);
  
  if (quickCtx) {
    console.log("📋 快速检索结果:");
    console.log("-".repeat(50));
    console.log(quickCtx.substring(0, 800));
    if (quickCtx.length > 800) {
      console.log("...[已截断]");
    }
  } else {
    console.log("⚠️  未检索到内容");
  }
  
  console.log("\n");
  
  // 性能总结
  console.log("📈 性能总结");
  console.log("=" .repeat(50));
  const avgDuration = (result1.durationMs + result2.durationMs + result3.durationMs) / 3;
  console.log(`平均耗时：${avgDuration.toFixed(0)}ms`);
  console.log(`总检索次数：${result1.snippets.length + result2.snippets.length + result3.snippets.length} 个片段`);
  console.log(`总关键词数：${result1.extractedKeywords.length + result2.extractedKeywords.length + result3.extractedKeywords.length} 个`);
  
  console.log("\n✅ 测试完成!\n");
}

// 运行测试
testProactiveRetrieval().catch(console.error);
