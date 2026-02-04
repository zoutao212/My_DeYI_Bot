import { Command } from "commander";
import { cliTaskDecompose, cliTaskResume } from "../../agents/task-board/cli-integration.js";

/**
 * 注册任务分解和跟踪命令
 */
export function registerTaskCommands(program: Command): void {
  const task = program
    .command("task")
    .description("任务分解和跟踪");

  task
    .command("decompose <task>")
    .description("分解任务并显示任务看板")
    .option("-s, --session <sessionId>", "会话 ID")
    .option("-c, --codebase <path>", "代码库路径")
    .option("--concurrent", "启用并发执行")
    .option("--auto-retry", "启用自动重试")
    .option("--max-retries <count>", "最大重试次数", "3")
    .action(async (taskDesc, options) => {
      await cliTaskDecompose(taskDesc, {
        sessionId: options.session,
        codebase: options.codebase,
        enableConcurrent: options.concurrent,
        enableAutoRetry: options.autoRetry,
        maxRetries: parseInt(options.maxRetries),
      });
    });

  task
    .command("resume <sessionId>")
    .description("恢复任务并显示任务看板")
    .action(async (sessionId) => {
      await cliTaskResume(sessionId);
    });

  task
    .command("list")
    .description("列出所有任务会话")
    .action(async () => {
      console.log("\n📋 任务会话列表");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      
      const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
      const tasksDir = `${homeDir}/.clawdbot/tasks`;
      
      try {
        const fs = await import("node:fs/promises");
        const sessions = await fs.readdir(tasksDir);
        
        if (sessions.length === 0) {
          console.log("（暂无任务会话）\n");
          return;
        }
        
        for (const sessionId of sessions) {
          const taskTreePath = `${tasksDir}/${sessionId}/TASK_TREE.json`;
          try {
            const content = await fs.readFile(taskTreePath, "utf-8");
            const taskTree = JSON.parse(content);
            
            const completedCount = taskTree.subTasks.filter((t: any) => t.status === "completed").length;
            const totalCount = taskTree.subTasks.length;
            const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
            
            console.log(`📁 ${sessionId}`);
            console.log(`   主任务: ${taskTree.rootTask}`);
            console.log(`   状态: ${taskTree.status}`);
            console.log(`   进度: ${progress}% (${completedCount}/${totalCount})`);
            console.log(`   更新时间: ${new Date(taskTree.updatedAt).toLocaleString("zh-CN")}`);
            console.log();
          } catch {
            console.log(`📁 ${sessionId} (无法读取任务树)`);
            console.log();
          }
        }
      } catch (err) {
        console.error(`❌ 无法读取任务目录: ${err}`);
      }
      
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    });
}
