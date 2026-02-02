/**
 * 紧凑型任务看板渲染器
 * 
 * 用于将任务看板渲染为紧凑格式，注入到 System Prompt 中。
 */

import type { TaskBoard, SubTask } from "./types.js";

/**
 * 获取状态的 Emoji 表示
 */
function getStatusEmoji(status: string): string {
  switch (status) {
    case "completed":
      return "✅";
    case "active":
      return "🔄";
    case "pending":
      return "⏳";
    case "blocked":
      return "🚫";
    case "skipped":
      return "⏭️";
    case "paused":
      return "⏸️";
    default:
      return "❓";
  }
}

/**
 * 渲染子任务为紧凑格式
 */
function renderSubTaskCompact(subTask: SubTask, index: number): string {
  const emoji = getStatusEmoji(subTask.status);
  const deps = subTask.dependencies.length > 0 ? ` (依赖: ${subTask.dependencies.join(", ")})` : "";
  return `${index + 1}. [${emoji}] ${subTask.title} - ${subTask.progress}${deps}`;
}

/**
 * 渲染任务看板为紧凑格式（用于 System Prompt）
 * 
 * @param board 任务看板
 * @returns 紧凑格式的 Markdown 字符串
 */
export function renderTaskBoardCompact(board: TaskBoard): string {
  const lines: string[] = [];
  
  lines.push("## 📋 任务看板（Task Board）");
  lines.push("");
  lines.push(`**主任务**: ${board.mainTask.title}`);
  lines.push(`**目标**: ${board.mainTask.objective}`);
  lines.push(`**总体进度**: ${board.mainTask.progress}`);
  lines.push("");
  
  // 子任务列表
  if (board.subTasks.length > 0) {
    lines.push("**子任务**:");
    for (let i = 0; i < board.subTasks.length; i++) {
      lines.push(renderSubTaskCompact(board.subTasks[i], i));
    }
    lines.push("");
  }
  
  // 当前焦点
  if (board.currentFocus.taskId) {
    lines.push(`**当前焦点**: ${board.currentFocus.taskId}`);
    if (board.currentFocus.reasoningSummary) {
      lines.push(`**推理摘要**: ${board.currentFocus.reasoningSummary}`);
    }
    if (board.currentFocus.nextAction) {
      lines.push(`**下一步行动**: ${board.currentFocus.nextAction}`);
    }
    lines.push("");
  }
  
  // 风险和阻塞
  if (board.risksAndBlocks.length > 0) {
    lines.push("**风险和阻塞**:");
    for (const risk of board.risksAndBlocks) {
      lines.push(`- ⚠️ ${risk.description}`);
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

/**
 * 渲染任务看板为用户可见格式（用于消息回复）
 * 
 * @param board 任务看板
 * @returns 用户友好的 Markdown 字符串
 */
export function renderTaskBoardForUser(board: TaskBoard): string {
  const lines: string[] = [];
  
  lines.push("📋 **任务看板更新**");
  lines.push("");
  lines.push(`🎯 **主任务**: ${board.mainTask.title}`);
  lines.push(`📊 **总体进度**: ${board.mainTask.progress}`);
  lines.push("");
  
  // 子任务列表
  if (board.subTasks.length > 0) {
    lines.push("**子任务列表**:");
    for (let i = 0; i < board.subTasks.length; i++) {
      const subTask = board.subTasks[i];
      const emoji = getStatusEmoji(subTask.status);
      const isCurrent = board.currentFocus.taskId === subTask.id;
      const marker = isCurrent ? "👉 " : "   ";
      lines.push(`${marker}${i + 1}. ${emoji} ${subTask.title} (${subTask.progress})`);
    }
    lines.push("");
  }
  
  // 当前焦点
  if (board.currentFocus.taskId) {
    const currentTask = board.subTasks.find(t => t.id === board.currentFocus.taskId);
    if (currentTask) {
      lines.push(`🔍 **当前正在执行**: ${currentTask.title}`);
      if (board.currentFocus.nextAction) {
        lines.push(`⏭️ **下一步**: ${board.currentFocus.nextAction}`);
      }
      lines.push("");
    }
  }
  
  // 风险和阻塞
  if (board.risksAndBlocks.length > 0) {
    lines.push("⚠️ **需要注意**:");
    for (const risk of board.risksAndBlocks) {
      lines.push(`- ${risk.description}`);
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

/**
 * 检查任务看板是否有更新（用于判断是否需要展示给用户）
 * 
 * @param oldBoard 旧的任务看板
 * @param newBoard 新的任务看板
 * @returns 是否有更新
 */
export function hasTaskBoardUpdates(oldBoard: TaskBoard | null, newBoard: TaskBoard): boolean {
  if (!oldBoard) return true;
  
  // 检查主任务进度
  if (oldBoard.mainTask.progress !== newBoard.mainTask.progress) return true;
  
  // 检查子任务状态
  if (oldBoard.subTasks.length !== newBoard.subTasks.length) return true;
  
  for (let i = 0; i < oldBoard.subTasks.length; i++) {
    const oldTask = oldBoard.subTasks[i];
    const newTask = newBoard.subTasks[i];
    
    if (oldTask.status !== newTask.status) return true;
    if (oldTask.progress !== newTask.progress) return true;
  }
  
  // 检查当前焦点
  if (oldBoard.currentFocus.taskId !== newBoard.currentFocus.taskId) return true;
  
  // 检查风险和阻塞
  if (oldBoard.risksAndBlocks.length !== newBoard.risksAndBlocks.length) return true;
  
  return false;
}
