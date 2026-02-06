/**
 * 交付报告格式器
 * 
 * 支持多种格式的交付报告生成：
 * - Markdown（所有频道）
 * - HTML（Web、Telegram）
 */

import type { DeliveryReport } from "./types.js";

/**
 * 报告格式器接口
 */
export interface ReportFormatter {
  /**
   * 格式化交付报告
   * 
   * @param report - 交付报告数据
   * @returns 格式化后的字符串
   */
  format(report: DeliveryReport): string;
  
  /**
   * 检查是否支持指定频道
   * 
   * @param channel - 频道类型
   * @returns 是否支持
   */
  supportsChannel(channel?: string): boolean;
}

/**
 * Markdown 格式器
 * 
 * 支持所有频道的纯文本 Markdown 格式
 */
export class MarkdownFormatter implements ReportFormatter {
  format(report: DeliveryReport): string {
    const lines: string[] = [];
    
    // 标题
    lines.push(`# 📋 任务交付报告\n`);
    
    // 根任务
    lines.push(`**根任务**: ${report.rootTask}\n`);
    
    // 统计信息
    const { completed, failed, total } = report.stats;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    lines.push(`**进度**: ${completed}/${total} 完成 (${successRate}%)`);
    if (failed > 0) {
      lines.push(`**失败**: ${failed} 个任务`);
    }
    lines.push("");
    
    // 任务列表
    if (report.tasks.length > 0) {
      lines.push(`## 任务详情\n`);
      for (const task of report.tasks) {
        const statusEmoji = task.status === "completed" ? "✅" : 
                           task.status === "failed" ? "❌" : "⏳";
        lines.push(`${statusEmoji} **${task.summary}**`);
        if (task.result) {
          lines.push(`   ${task.result.substring(0, 100)}...`);
        }
        lines.push("");
      }
    }
    
    // 时间信息
    if (report.startTime && report.endTime) {
      const duration = Math.round((report.endTime - report.startTime) / 1000);
      lines.push(`\n⏱️ 总耗时: ${duration} 秒`);
    }
    
    return lines.join("\n");
  }
  
  supportsChannel(_channel?: string): boolean {
    // Markdown 支持所有频道
    return true;
  }
}

/**
 * HTML 格式器
 * 
 * 支持 Web 和 Telegram 频道的富文本 HTML 格式
 */
export class HTMLFormatter implements ReportFormatter {
  format(report: DeliveryReport): string {
    const { completed, failed, total } = report.stats;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    const html: string[] = [];
    
    // 标题
    html.push(`<b>📋 任务交付报告</b>\n`);
    
    // 根任务
    html.push(`<b>根任务:</b> ${this.escape(report.rootTask)}\n`);
    
    // 统计信息
    html.push(`<b>进度:</b> ${completed}/${total} 完成 (${successRate}%)`);
    if (failed > 0) {
      html.push(`<b>失败:</b> ${failed} 个任务`);
    }
    html.push("");
    
    // 任务列表
    if (report.tasks.length > 0) {
      html.push(`\n<b>任务详情:</b>\n`);
      for (const task of report.tasks) {
        const statusEmoji = task.status === "completed" ? "✅" : 
                           task.status === "failed" ? "❌" : "⏳";
        html.push(`${statusEmoji} <b>${this.escape(task.summary)}</b>`);
        if (task.result) {
          const preview = task.result.substring(0, 100);
          html.push(`   <i>${this.escape(preview)}...</i>`);
        }
        html.push("");
      }
    }
    
    // 时间信息
    if (report.startTime && report.endTime) {
      const duration = Math.round((report.endTime - report.startTime) / 1000);
      html.push(`\n⏱️ <b>总耗时:</b> ${duration} 秒`);
    }
    
    return html.join("\n");
  }
  
  supportsChannel(channel?: string): boolean {
    // HTML 支持 Web 和 Telegram
    return channel === "web" || channel === "telegram";
  }
  
  /**
   * HTML 转义
   * 
   * 防止 XSS 攻击
   */
  private escape(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}

/**
 * 选择合适的格式器
 * 
 * @param channel - 频道类型
 * @returns 格式器实例
 */
export function selectFormatter(channel?: string): ReportFormatter {
  // 优先选择 HTML（如果支持）
  const htmlFormatter = new HTMLFormatter();
  if (htmlFormatter.supportsChannel(channel)) {
    return htmlFormatter;
  }
  
  // 回退到 Markdown
  return new MarkdownFormatter();
}
