/**
 * 智能任务分解系统 - 基本使用示例
 * 
 * 演示如何使用 Orchestrator 创建任务树、添加子任务、执行任务、恢复任务
 */

import { Orchestrator } from "../../dist/agents/intelligent-task-decomposition/index.js";

async function main() {
  const orchestrator = new Orchestrator();
  const sessionId = "test-session-" + Date.now();

  console.log("=== 示例 1：创建任务树并添加子任务 ===\n");

  // 1. 初始化任务树
  const taskTree = await orchestrator.initializeTaskTree(
    "生成一个 10000 字的科幻小说",
    sessionId,
  );
  console.log(`✅ Task tree initialized: ${taskTree.id}\n`);

  // 2. 添加子任务
  const subTask1 = await orchestrator.addSubTask(
    taskTree,
    "请生成科幻小说的第 1-2000 字，包括开头和人物介绍",
    "生成小说第 1-2000 字",
  );
  console.log(`✅ Sub task 1 added: ${subTask1.id}\n`);

  const subTask2 = await orchestrator.addSubTask(
    taskTree,
    "请生成科幻小说的第 2001-4000 字，继续故事发展",
    "生成小说第 2001-4000 字",
  );
  console.log(`✅ Sub task 2 added: ${subTask2.id}\n`);

  // 3. 执行子任务
  console.log("=== 示例 2：执行子任务 ===\n");

  await orchestrator.executeSubTask(taskTree, subTask1, async () => {
    // 模拟 LLM 生成内容
    console.log("🔄 Executing sub task 1...");
    await sleep(1000);
    return "这是第 1-2000 字的内容...";
  });
  console.log(`✅ Sub task 1 completed\n`);

  await orchestrator.executeSubTask(taskTree, subTask2, async () => {
    // 模拟 LLM 生成内容
    console.log("🔄 Executing sub task 2...");
    await sleep(1000);
    return "这是第 2001-4000 字的内容...";
  });
  console.log(`✅ Sub task 2 completed\n`);

  // 4. 渲染任务树为 Markdown
  console.log("=== 示例 3：渲染任务树为 Markdown ===\n");
  const markdown = orchestrator.renderTaskTreeToMarkdown(taskTree);
  console.log(markdown);
  console.log();

  // 5. 检查是否有未完成的任务
  console.log("=== 示例 4：检查未完成的任务 ===\n");
  const hasUnfinished = await orchestrator.hasUnfinishedTasks(sessionId);
  console.log(`Has unfinished tasks: ${hasUnfinished}\n`);

  // 6. 恢复任务树
  console.log("=== 示例 5：恢复任务树 ===\n");
  const loadedTaskTree = await orchestrator.loadTaskTree(sessionId);
  if (loadedTaskTree) {
    console.log(`✅ Task tree loaded: ${loadedTaskTree.id}`);
    console.log(`   Status: ${loadedTaskTree.status}`);
    console.log(`   Sub tasks: ${loadedTaskTree.subTasks.length}`);
    console.log(`   Checkpoints: ${loadedTaskTree.checkpoints.length}\n`);
  }

  console.log("=== 所有示例完成 ===");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
