import { html, nothing } from "lit";

import { formatToolDetail, resolveToolDisplay } from "../tool-display";
import { icons } from "../icons";
import type { ToolCard } from "../types/chat-types";
import { TOOL_INLINE_THRESHOLD } from "./constants";
import {
  formatToolOutputForSidebar,
  getTruncatedPreview,
} from "./tool-helpers";
import { isToolResultMessage } from "./message-normalizer";
import { extractTextCached } from "./message-extract";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") continue;
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    const result = (item as { result?: unknown }).result;
    const isError = typeof (item as { isError?: unknown }).isError === "boolean"
      ? ((item as { isError?: boolean }).isError as boolean)
      : undefined;
    cards.push({ kind: "result", name, text, result, isError });
  }

  if (
    isToolResultMessage(message) &&
    !cards.some((card) => card.kind === "result")
  ) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

export function renderToolCardSidebar(
  card: ToolCard,
  onOpenSidebar?: (content: string) => void,
) {
  // 检测 send_file 工具的文件卡片结果
  const fileCard = extractWebFileCard(card);
  if (fileCard) {
    return renderFileCard(fileCard);
  }

  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());

  const summary = summarizeToolResult(card);
  const statusText = summary.statusLabel;
  const hasError = summary.isError;

  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick
    ? () => {
        onOpenSidebar!(formatToolSidebarContent({
          displayLabel: display.label,
          detail,
          args: card.args,
          text: card.text,
          result: card.result,
          isError: hasError,
        }));
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${canClick
        ? (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            handleClick?.();
          }
        : nothing}
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${canClick
          ? html`<span class="chat-tool-card__action">${hasText ? "View" : ""} ${icons.check}</span>`
          : nothing}
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">${icons.check}</span>` : nothing}
      </div>
      ${detail
        ? html`<div class="chat-tool-card__detail">${detail}</div>`
        : nothing}
      ${isEmpty
        ? html`<div class="chat-tool-card__status-text ${hasError ? "danger" : "muted"}">${statusText}</div>`
        : html`<div class="chat-tool-card__status-text ${hasError ? "danger" : "muted"}">${statusText}</div>`}
      ${summary.metaText
        ? html`<div class="chat-tool-card__detail muted">${summary.metaText}</div>`
        : nothing}
      ${showCollapsed
        ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
        : nothing}
      ${showInline
        ? html`<div class="chat-tool-card__inline mono">${card.text}</div>`
        : nothing}
    </div>
  `;
}

function summarizeToolResult(card: ToolCard): {
  isError: boolean;
  statusLabel: string;
  metaText?: string;
} {
  const result = card.result;
  const isError = card.isError === true;
  if (!result || typeof result !== "object") {
    return {
      isError,
      statusLabel: isError ? "失败" : "已完成",
    };
  }
  const rec = result as Record<string, unknown>;
  const exitCode = typeof rec.exitCode === "number" ? rec.exitCode : undefined;
  const durationMs = typeof rec.durationMs === "number" ? rec.durationMs : undefined;
  const stdout = typeof rec.stdout === "string" ? rec.stdout : undefined;
  const stderr = typeof rec.stderr === "string" ? rec.stderr : undefined;
  const okFromExit = exitCode != null ? exitCode === 0 : undefined;
  const derivedError = isError || okFromExit === false;

  const parts: string[] = [];
  if (exitCode != null) parts.push(`exitCode=${exitCode}`);
  if (durationMs != null) parts.push(`耗时=${durationMs}ms`);
  if (stdout != null) parts.push(`stdout=${stdout.length}`);
  if (stderr != null) parts.push(`stderr=${stderr.length}`);

  return {
    isError: derivedError,
    statusLabel: derivedError ? "失败" : "已完成",
    metaText: parts.length ? parts.join(" · ") : undefined,
  };
}

function formatToolSidebarContent(params: {
  displayLabel: string;
  detail?: string;
  args?: unknown;
  text?: string;
  result?: unknown;
  isError: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`## ${params.displayLabel}`);
  if (params.detail) {
    lines.push("");
    lines.push(`**命令：** \`${params.detail}\``);
  }
  lines.push("");
  lines.push(`**状态：** ${params.isError ? "失败" : "已完成"}`);

  if (params.args !== undefined) {
    lines.push("");
    lines.push("### 参数");
    lines.push("```json");
    lines.push(safeJson(params.args));
    lines.push("```");
  }

  if (params.text?.trim()) {
    lines.push("");
    lines.push("### 输出（摘要）");
    lines.push(formatToolOutputForSidebar(params.text));
  }

  if (params.result !== undefined) {
    lines.push("");
    lines.push("### 原始结果（JSON）");
    lines.push("```json");
    lines.push(safeJson(params.result));
    lines.push("```");
  }

  if (!params.text?.trim() && params.result === undefined) {
    lines.push("");
    lines.push("*无输出*");
  }

  return lines.join("\n");
}

/**
 * 从 send_file 工具结果中提取 webFileCard 数据
 */
type WebFileCardData = {
  fileName: string;
  fileSize: number;
  mimeType: string;
  filePath: string;
  caption?: string;
  isImage: boolean;
  isText: boolean;
};

function extractWebFileCard(card: ToolCard): WebFileCardData | null {
  if (card.kind !== "result") return null;
  if (card.name !== "send_file") return null;

  // 尝试从 text 中解析 JSON 结果
  const text = card.text?.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    const wfc = parsed?.webFileCard;
    if (
      wfc &&
      typeof wfc === "object" &&
      typeof wfc.fileName === "string" &&
      typeof wfc.filePath === "string"
    ) {
      return {
        fileName: wfc.fileName,
        fileSize: typeof wfc.fileSize === "number" ? wfc.fileSize : 0,
        mimeType: typeof wfc.mimeType === "string" ? wfc.mimeType : "application/octet-stream",
        filePath: wfc.filePath,
        caption: typeof wfc.caption === "string" ? wfc.caption : undefined,
        isImage: wfc.isImage === true,
        isText: wfc.isText === true,
      };
    }
  } catch {
    // Not JSON or no webFileCard
  }
  return null;
}

function formatFileSizeHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileTypeIcon(mimeType: string, isImage: boolean): string {
  if (isImage) return "🖼️";
  if (mimeType.startsWith("text/")) return "📄";
  if (mimeType.includes("pdf")) return "📕";
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("gzip")) return "📦";
  if (mimeType.includes("json") || mimeType.includes("csv") || mimeType.includes("xml")) return "📊";
  if (mimeType.includes("word") || mimeType.includes("document")) return "📝";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "📈";
  return "📎";
}

function renderFileCard(fileCard: WebFileCardData) {
  const sizeText = formatFileSizeHuman(fileCard.fileSize);
  const typeIcon = getFileTypeIcon(fileCard.mimeType, fileCard.isImage);
  const ext = fileCard.fileName.includes(".")
    ? fileCard.fileName.split(".").pop()?.toUpperCase() ?? ""
    : "";

  const handleDownload = async () => {
    try {
      // 通过 gateway WebSocket 请求文件内容
      const app = (document.querySelector("clawdbot-app") as any);
      const gw = app?.gw;
      if (!gw) {
        console.error("[file-card] gateway not available");
        return;
      }
      const result = await gw.request("chat.file.download", {
        filePath: fileCard.filePath,
      }) as { fileName: string; content: string; mimeType: string; encoding?: string };

      if (!result?.content) return;

      // 根据编码方式创建 Blob
      let blob: Blob;
      if (result.encoding === "base64") {
        const binary = atob(result.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        blob = new Blob([bytes], { type: result.mimeType });
      } else {
        blob = new Blob([result.content], { type: result.mimeType });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.fileName || fileCard.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[file-card] download failed:", err);
    }
  };

  return html`
    <div class="chat-file-card">
      <div class="chat-file-card__icon">${typeIcon}</div>
      <div class="chat-file-card__info">
        <div class="chat-file-card__name" title=${fileCard.fileName}>${fileCard.fileName}</div>
        <div class="chat-file-card__meta">
          ${ext ? html`<span class="chat-file-card__ext">${ext}</span>` : nothing}
          <span class="chat-file-card__size">${sizeText}</span>
        </div>
        ${fileCard.caption
          ? html`<div class="chat-file-card__caption">${fileCard.caption}</div>`
          : nothing}
      </div>
      <button
        class="chat-file-card__download"
        @click=${handleDownload}
        title="下载文件"
        aria-label="下载 ${fileCard.fileName}"
      >
        ${icons.fileText}
        <span>下载</span>
      </button>
    </div>
  `;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (item.result !== undefined) {
    try {
      return JSON.stringify(
        {
          result: item.result,
          isError: typeof item.isError === "boolean" ? item.isError : undefined,
        },
        null,
        2,
      );
    } catch {
      return String(item.result);
    }
  }
  return undefined;
}
