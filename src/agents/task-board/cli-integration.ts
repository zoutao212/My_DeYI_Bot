/**
 * CLI 集成
 * 
 * 提供命令行界面的任务分解和跟踪功能。
 */

import { createOrchestrator, type OrchestratorConfig } from "./orchestrator.js";
import type { TaskBoard } from "./types.js";

/**
 * CLI 任务分解命令
 * 
 * @param task 任务描述
 * @param options 选项
 */
export async function cliTaskDecompose(
  task: string,
  options: {
    sessionId?: string;
    codebase?: string;
    enableConcurrent?: boolean;
    enableAutoRetry?: boolean;
    maxRetries?: number;
  } = {}
): Promise<void> {
  const sessionId = options.sessionId || `session_${Date.now()}`;
  const codebase = options.codebase || process.cwd();

  console.log(`\n📋 任务分解模式`);
  console.log(`任务: ${task}`);
  console.log(`会话 ID: ${sessionId}`);
  console.log(`代码库: ${codebase}\n`);

  // 创建 Orchestrator
  const config: OrchestratorConfig = {
    sessionId,
    enableConcurrentExecution: options.enableConcurrent || false,
    enableAutoRetry: options.enableAutoRetry || false,
    maxRetries: options.maxRetries || 3
  };

  const orchestrator = createOrchestrator(config);

  try {
    // 处理任务
    const taskBoard = await orchestrator.handleTask(task, {
      codebase,
      recentMessages: []
    });

    // 展示任务看板
    displayTaskBoard(taskBoard);

    console.log(`\n✅ 任务分解完成！`);
    console.log(`任务看板已保存到: ~/.clawdbot/tasks/${sessionId}/`);
  } catch (error) {
    console.error(`\n❌ 任务分解失败:`, error);
    process.exit(1);
  }
}

/**
 * CLI 任务恢复命令
 * 
 * @param sessionId 会话 ID
 */
export async function cliTaskResume(sessionId: string): Promise<void> {
  console.log(`\n🔄 恢复任务`);
  console.log(`会话 ID: ${sessionId}\n`);

  // 创建 Orchestrator
  const orchestrator = createOrchestrator({ sessionId });

  try {
    // 恢复任务
    const taskBoard = await orchestrator.resumeTask(sessionId);

    if (!taskBoard) {
      console.error(`❌ 找不到会话: ${sessionId}`);
      process.exit(1);
    }

    // 展示任务看板
    displayTaskBoard(taskBoard);

    console.log(`\n✅ 任务已恢复！`);
  } catch (error) {
    console.error(`\n❌ 任务恢复失败:`, error);
    process.exit(1);
  }
}

/**
 * 展示任务看板（CLI 格式）
 */
function displayTaskBoard(taskBoard: TaskBoard): void {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📋 任务看板`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // 主任务
  console.log(`🎯 主任务: ${taskBoard.mainTask.title}`);
  console.log(`   目标: ${taskBoard.mainTask.objective}`);
  console.log(`   状态: ${getStatusEmoji(taskBoard.mainTask.status)} ${taskBoard.mainTask.status}`);
  console.log(`   进度: ${taskBoard.mainTask.progress}\n`);

  // 子任务列表
  console.log(`📝 子任务列表:\n`);
  for (const subTask of taskBoard.subTasks) {
    const statusEmoji = getSubTaskStatusEmoji(subTask.status);
    const depStr = subTask.dependencies.length > 0 
      ? ` (依赖: ${subTask.dependencies.join(", ")})`
      : "";
    
    console.log(`   ${statusEmoji} ${subTask.id}: ${subTask.title}${depStr}`);
    console.log(`      ${subTask.description}`);
    console.log(`      进度: ${subTask.progress}`);
    
    if (subTask.outputs.length > 0) {
      console.log(`      产出: ${subTask.outputs.join(", ")}`);
    }
    
    console.log();
  }

  // 当前焦点
  if (taskBoard.currentFocus.taskId) {
    console.log(`🎯 当前焦点: ${taskBoard.currentFocus.taskId}`);
    console.log(`   推理: ${taskBoard.currentFocus.reasoningSummary}`);
    console.log(`   下一步: ${taskBoard.currentFocus.nextAction}\n`);
  }

  // 检查点
  if (taskBoard.checkpoints.length > 0) {
    console.log(`✅ 检查点:\n`);
    for (const checkpoint of taskBoard.checkpoints) {
      console.log(`   [${checkpoint.timestamp}]`);
      console.log(`   ${checkpoint.summary}`);
      if (checkpoint.decisions.length > 0) {
        console.log(`   决策: ${checkpoint.decisions.join("; ")}`);
      }
      console.log();
    }
  }

  // 风险和阻塞
  if (taskBoard.risksAndBlocks.length > 0) {
    console.log(`⚠️  风险和阻塞:\n`);
    for (const risk of taskBoard.risksAndBlocks) {
      console.log(`   ⚠️  ${risk.description}`);
      console.log(`      缓解: ${risk.mitigation}\n`);
    }
  }

  // 上下文锚点
  if (taskBoard.contextAnchors.codeLocations.length > 0 || 
      taskBoard.contextAnchors.commands.length > 0) {
    console.log(`🔗 上下文锚点:\n`);
    
    if (taskBoard.contextAnchors.codeLocations.length > 0) {
      console.log(`   代码位置:`);
      for (const location of taskBoard.contextAnchors.codeLocations) {
        console.log(`   - ${location}`);
      }
      console.log();
    }
    
    if (taskBoard.contextAnchors.commands.length > 0) {
      console.log(`   命令:`);
      for (const command of taskBoard.contextAnchors.commands) {
        console.log(`   - ${command}`);
      }
      console.log();
    }
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

/**
 * 获取状态表情符号
 */
function getStatusEmoji(status: string): string {
  switch (status) {
    case "active":
      return "🟢";
    case "paused":
      return "🟡";
    case "completed":
      return "✅";
    case "blocked":
      return "🔴";
    default:
      return "⚪";
  }
}

/**
 * 获取子任务状态表情符号
 */
function getSubTaskStatusEmoji(status: string): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "active":
      return "🔄";
    case "completed":
      return "✅";
    case "blocked":
      return "🚫";
    case "skipped":
      return "⏭️";
    default:
      return "⚪";
  }
}
