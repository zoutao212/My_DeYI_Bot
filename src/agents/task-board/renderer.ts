/**
 * 任务看板渲染器
 * 
 * 负责将任务看板渲染为 JSON 和 Markdown 格式。
 */

import type { TaskBoard, SubTask, Checkpoint, Risk } from "./types.js";
import { getTaskBoardJsonPath, getTaskBoardMarkdownPath } from "./persistence.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 渲染任务看板为 JSON 字符串
 * @param board 任务看板
 * @returns JSON 字符串
 */
export function renderToJSON(board: TaskBoard): string {
  return JSON.stringify(board, null, 2);
}

/**
 * 获取状态的 Emoji 表示
 * @param status 状态
 * @returns Emoji
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
 * 获取主任务状态的 Emoji 表示
 * @param status 主任务状态
 * @returns Emoji 和文本
 */
function getMainTaskStatusDisplay(status: string): string {
  switch (status) {
    case "active":
      return "🟢 进行中";
    case "paused":
      return "🟡 已暂停";
    case "completed":
      return "✅ 已完成";
    case "blocked":
      return "🔴 已阻塞";
    default:
      return "❓ 未知";
  }
}

/**
 * 渲染子任务为 Markdown
 * @param subTask 子任务
 * @returns Markdown 字符串
 */
function renderSubTaskToMarkdown(subTask: SubTask): string {
  const emoji = getStatusEmoji(subTask.status);
  const lines: string[] = [];
  
  lines.push(`### ${subTask.id}: ${subTask.title} ${emoji}`);
  lines.push("");
  lines.push(`- **描述**: ${subTask.description}`);
  lines.push(`- **状态**: ${subTask.status}`);
  lines.push(`- **进度**: ${subTask.progress}`);
  
  if (subTask.dependencies.length > 0) {
    lines.push(`- **依赖**: ${subTask.dependencies.join(", ")}`);
  } else {
    lines.push(`- **依赖**: 无`);
  }
  
  if (subTask.outputs.length > 0) {
    lines.push(`- **产出**: ${subTask.outputs.join(", ")}`);
  } else {
    lines.push(`- **产出**: 无`);
  }
  
  if (subTask.notes) {
    lines.push(`- **备注**: ${subTask.notes}`);
  }
  
  lines.push("");
  return lines.join("\n");
}

/**
 * 渲染检查点为 Markdown
 * @param checkpoint 检查点
 * @returns Markdown 字符串
 */
function renderCheckpointToMarkdown(checkpoint: Checkpoint): string {
  const lines: string[] = [];
  
  lines.push(`### ${checkpoint.timestamp}`);
  lines.push("");
  lines.push(`**摘要**: ${checkpoint.summary}`);
  lines.push("");
  
  if (checkpoint.decisions.length > 0) {
    lines.push(`**关键决策**:`);
    for (const decision of checkpoint.decisions) {
      lines.push(`- ${decision}`);
    }
    lines.push("");
  }
  
  if (checkpoint.openQuestions.length > 0) {
    lines.push(`**未决问题**:`);
    for (const question of checkpoint.openQuestions) {
      lines.push(`- ${question}`);
    }
    lines.push("");
  } else {
    lines.push(`**未决问题**: 无`);
    lines.push("");
  }
  
  return lines.join("\n");
}

/**
 * 渲染风险为 Markdown
 * @param risk 风险
 * @returns Markdown 字符串
 */
function renderRiskToMarkdown(risk: Risk): string {
  return `- **${risk.description}**\n  - 缓解措施: ${risk.mitigation}`;
}

/**
 * 渲染任务看板为 Markdown 字符串
 * @param board 任务看板
 * @returns Markdown 字符串
 */
export function renderToMarkdown(board: TaskBoard): string {
  const lines: string[] = [];
  
  // 标题
  lines.push("# 任务看板");
  lines.push("");
  lines.push(`**会话 ID**: ${board.sessionId}`);
  lines.push(`**最后更新**: ${board.lastUpdated}`);
  lines.push(`**版本**: ${board.version}`);
  lines.push("");
  
  // 主任务
  lines.push("## 主任务");
  lines.push("");
  lines.push(`**标题**: ${board.mainTask.title}`);
  lines.push(`**目标**: ${board.mainTask.objective}`);
  lines.push(`**状态**: ${getMainTaskStatusDisplay(board.mainTask.status)}`);
  lines.push(`**进度**: ${board.mainTask.progress}`);
  lines.push("");
  
  // 子任务
  lines.push("## 子任务");
  lines.push("");
  
  if (board.subTasks.length === 0) {
    lines.push("无子任务");
    lines.push("");
  } else {
    for (const subTask of board.subTasks) {
      lines.push(renderSubTaskToMarkdown(subTask));
    }
  }
  
  // 当前焦点
  lines.push("## 当前焦点");
  lines.push("");
  
  if (board.currentFocus.taskId) {
    lines.push(`**任务**: ${board.currentFocus.taskId}`);
    lines.push(`**推理摘要**: ${board.currentFocus.reasoningSummary}`);
    lines.push(`**下一步行动**: ${board.currentFocus.nextAction}`);
  } else {
    lines.push("无当前焦点");
  }
  lines.push("");
  
  // 检查点
  lines.push("## 检查点");
  lines.push("");
  
  if (board.checkpoints.length === 0) {
    lines.push("无检查点");
    lines.push("");
  } else {
    for (const checkpoint of board.checkpoints) {
      lines.push(renderCheckpointToMarkdown(checkpoint));
    }
  }
  
  // 风险和阻塞
  lines.push("## 风险和阻塞");
  lines.push("");
  
  if (board.risksAndBlocks.length === 0) {
    lines.push("无");
    lines.push("");
  } else {
    for (const risk of board.risksAndBlocks) {
      lines.push(renderRiskToMarkdown(risk));
    }
    lines.push("");
  }
  
  // 上下文锚点
  lines.push("## 上下文锚点");
  lines.push("");
  
  if (board.contextAnchors.codeLocations.length > 0) {
    lines.push("**代码位置**:");
    for (const location of board.contextAnchors.codeLocations) {
      lines.push(`- ${location}`);
    }
    lines.push("");
  }
  
  if (board.contextAnchors.commands.length > 0) {
    lines.push("**命令**:");
    for (const command of board.contextAnchors.commands) {
      lines.push(`- ${command}`);
    }
    lines.push("");
  }
  
  if (board.contextAnchors.codeLocations.length === 0 && board.contextAnchors.commands.length === 0) {
    lines.push("无");
    lines.push("");
  }
  
  return lines.join("\n");
}

/**
 * 保存任务看板为 JSON 和 Markdown 文件
 * @param board 任务看板
 * @param sessionId 会话 ID
 */
export async function saveTaskBoardWithRendering(board: TaskBoard, sessionId: string): Promise<void> {
  try {
    // 渲染为 JSON
    const jsonContent = renderToJSON(board);
    const jsonPath = getTaskBoardJsonPath(sessionId);
    
    // 确保目录存在
    mkdirSync(dirname(jsonPath), { recursive: true });
    
    // 保存 JSON 文件
    writeFileSync(jsonPath, jsonContent, "utf-8");
    
    // 渲染为 Markdown
    const markdownContent = renderToMarkdown(board);
    const markdownPath = getTaskBoardMarkdownPath(sessionId);
    
    // 保存 Markdown 文件
    writeFileSync(markdownPath, markdownContent, "utf-8");
  } catch (error) {
    throw new Error(`Failed to save TaskBoard with rendering: ${error instanceof Error ? error.message : String(error)}`);
  }
}
