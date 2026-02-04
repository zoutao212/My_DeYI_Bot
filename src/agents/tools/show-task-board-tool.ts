import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { getCurrentFollowupRunContext, getGlobalOrchestrator } from "./enqueue-task-tool.js";

/**
 * 创建 show_task_board 工具
 * 
 * 允许用户查看当前会话的任务看板，包括所有子任务的状态和进度。
 */
export function createShowTaskBoardTool(): AnyAgentTool {
  return {
    label: "Show Task Board",
    name: "show_task_board",
    description: "显示当前会话的任务看板，包括所有子任务的状态和进度",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _args) => {
      const currentFollowupRun = getCurrentFollowupRunContext();
      if (!currentFollowupRun) {
        return jsonResult({
          success: false,
          error: "无法获取当前会话上下文",
        });
      }

      const orchestrator = getGlobalOrchestrator();
      const sessionId = currentFollowupRun.run.sessionId;
      const taskTree = await orchestrator.loadTaskTree(sessionId);

      if (!taskTree) {
        return jsonResult({
          success: false,
          error: "当前会话没有任务树（可能还没有使用 enqueue_task 工具创建任务）",
        });
      }

      // 渲染任务看板
      const markdown = renderTaskBoardToMarkdown(taskTree);

      return jsonResult({
        success: true,
        taskBoard: markdown,
      });
    },
  };
}

/**
 * 渲染任务看板为 Markdown
 */
function renderTaskBoardToMarkdown(taskTree: any): string {
  const lines: string[] = [];

  lines.push(`# 📋 任务看板`);
  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push("");

  // 主任务
  lines.push(`## 🎯 主任务`);
  lines.push("");
  lines.push(`**任务**: ${taskTree.rootTask}`);
  lines.push(`**状态**: ${getStatusEmoji(taskTree.status)} ${taskTree.status}`);
  lines.push(`**创建时间**: ${new Date(taskTree.createdAt).toLocaleString("zh-CN")}`);
  lines.push(`**更新时间**: ${new Date(taskTree.updatedAt).toLocaleString("zh-CN")}`);
  lines.push("");

  // 统计信息
  const completedCount = taskTree.subTasks.filter((t: any) => t.status === "completed").length;
  const activeCount = taskTree.subTasks.filter((t: any) => t.status === "active").length;
  const pendingCount = taskTree.subTasks.filter((t: any) => t.status === "pending").length;
  const failedCount = taskTree.subTasks.filter((t: any) => t.status === "failed").length;
  const totalCount = taskTree.subTasks.length;

  lines.push(`## 📊 统计信息`);
  lines.push("");
  lines.push(`- 总任务数: ${totalCount}`);
  lines.push(`- ✅ 已完成: ${completedCount}`);
  lines.push(`- 🔄 进行中: ${activeCount}`);
  lines.push(`- ⏳ 待执行: ${pendingCount}`);
  lines.push(`- ❌ 失败: ${failedCount}`);
  lines.push(`- 进度: ${totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0}%`);
  lines.push("");

  // 子任务列表
  lines.push(`## 📝 子任务列表`);
  lines.push("");

  if (taskTree.subTasks.length === 0) {
    lines.push("（暂无子任务）");
  } else {
    for (const subTask of taskTree.subTasks) {
      const statusIcon = getSubTaskStatusIcon(subTask.status);
      lines.push(`### ${statusIcon} ${subTask.summary}`);
      lines.push("");
      lines.push(`- **ID**: ${subTask.id}`);
      lines.push(`- **状态**: ${subTask.status}`);
      lines.push(`- **重试次数**: ${subTask.retryCount}`);
      lines.push(`- **创建时间**: ${new Date(subTask.createdAt).toLocaleString("zh-CN")}`);
      if (subTask.completedAt) {
        lines.push(`- **完成时间**: ${new Date(subTask.completedAt).toLocaleString("zh-CN")}`);
      }
      lines.push("");

      if (subTask.output) {
        lines.push(`**输出**:`);
        lines.push("```");
        lines.push(subTask.output.substring(0, 200) + (subTask.output.length > 200 ? "..." : ""));
        lines.push("```");
        lines.push("");
      }

      if (subTask.error) {
        lines.push(`**错误**:`);
        lines.push("```");
        lines.push(subTask.error);
        lines.push("```");
        lines.push("");
      }
    }
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push("");
  lines.push(`💾 任务树文件位置: ~/.clawdbot/tasks/${taskTree.id}/`);

  return lines.join("\n");
}

/**
 * 获取状态图标
 */
function getStatusEmoji(status: string): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "active":
      return "🔄";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    default:
      return "❓";
  }
}

/**
 * 获取子任务状态图标
 */
function getSubTaskStatusIcon(status: string): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "active":
      return "🔄";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "interrupted":
      return "⚠️";
    default:
      return "❓";
  }
}
