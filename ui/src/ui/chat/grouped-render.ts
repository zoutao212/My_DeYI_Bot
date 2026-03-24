import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import type { AssistantIdentity } from "../assistant-identity";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { MessageGroup } from "../types/chat-types";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown";
import { isToolResultMessage, normalizeRoleForGrouping } from "./message-normalizer";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards";

/**
 * 流式渲染时使用轻量级纯文本渲染，避免每次 delta 都做完整 markdown 解析。
 * 只做基本的 HTML 转义和换行处理，性能远优于 marked + DOMPurify。
 */
function streamingTextToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "<br>");
}

export function renderReadingIndicatorGroup(assistant?: AssistantIdentity, waitElapsedSeconds?: number) {
  const elapsed = waitElapsedSeconds ?? 0;
  const timerText = elapsed > 0
    ? elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
      : `${elapsed}s`
    : "";

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
          ${elapsed >= 1 ? html`<span class="chat-reading-indicator__timer">等待 AI 回复中... ${timerText}</span>` : nothing}
        </div>
      </div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  reasoning: string | null,
  startedAt: number,
  onOpenSidebar?: (content: string) => void,
  assistant?: AssistantIdentity,
  waitElapsedSeconds?: number,
  showReasoning = false,
) {
  const timestamp = new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const name = assistant?.name ?? "Assistant";
  const charCount = text.length + (reasoning?.length ?? 0);
  const elapsed = waitElapsedSeconds ?? 0;
  const elapsedText = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
    : `${elapsed}s`;

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        ${renderGroupedMessage(
          {
            role: "assistant",
            content: [
              ...(reasoning?.trim() ? [{ type: "thinking", thinking: reasoning.trim() }] : []),
              ...(text ? [{ type: "text", text }] : []),
            ],
            timestamp: startedAt,
          },
          { isStreaming: true, showReasoning },
          onOpenSidebar,
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${name}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
          <span class="chat-stream-stats">⚡ ${charCount} 字 · ${elapsedText}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderMessageGroup(
  group: MessageGroup,
  opts: {
    onOpenSidebar?: (content: string) => void;
    showReasoning: boolean;
    assistantName?: string;
    assistantAvatar?: string | null;
  },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const assistantName = opts.assistantName ?? "Assistant";
  const who =
    normalizedRole === "user"
      ? "You"
      : normalizedRole === "assistant"
        ? assistantName
        : normalizedRole;
  const roleClass =
    normalizedRole === "user"
      ? "user"
      : normalizedRole === "assistant"
        ? "assistant"
        : "other";
  const timestamp = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return html`
    <div class="chat-group ${roleClass}">
      ${renderAvatar(group.role, {
        name: assistantName,
        avatar: opts.assistantAvatar ?? null,
      })}
      <div class="chat-group-messages">
        ${group.messages.map((item, index) =>
          renderGroupedMessage(
            item.message,
            {
              isStreaming:
                group.isStreaming && index === group.messages.length - 1,
              showReasoning: opts.showReasoning,
            },
            opts.onOpenSidebar,
          ),
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

function renderAvatar(
  role: string,
  assistant?: Pick<AssistantIdentity, "name" | "avatar">,
) {
  const normalized = normalizeRoleForGrouping(role);
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const initial =
    normalized === "user"
      ? "U"
      : normalized === "assistant"
        ? assistantName.charAt(0).toUpperCase() || "A"
        : normalized === "tool"
          ? "⚙"
          : "?";
  const className =
    normalized === "user"
      ? "user"
      : normalized === "assistant"
        ? "assistant"
      : normalized === "tool"
          ? "tool"
          : "other";

  if (assistantAvatar && normalized === "assistant") {
    if (isAvatarUrl(assistantAvatar)) {
      return html`<img
        class="chat-avatar ${className}"
        src="${assistantAvatar}"
        alt="${assistantName}"
      />`;
    }
    return html`<div class="chat-avatar ${className}">${assistantAvatar}</div>`;
  }

  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

function isAvatarUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^data:image\//i.test(value) ||
    /^\//.test(value) // Relative paths from avatar endpoint
  );
}

function renderGroupedMessage(
  message: unknown,
  opts: { isStreaming: boolean; showReasoning: boolean },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant"
      ? extractThinkingCached(message)
      : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking
    ? formatReasoningMarkdown(extractedThinking)
    : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());

  const bubbleClasses = [
    "chat-bubble",
    canCopyMarkdown ? "has-copy" : "",
    opts.isStreaming ? "streaming" : "",
    "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  // 🔧 Fix: 同时支持 tool result 消息和 assistant 的 tool call 消息
  // tool call 消息是 assistant 角色但包含 toolCall 类型的 content
  const shouldRenderToolCardsOnly = !markdown && hasToolCards && (isToolResult || role === "assistant");
  if (shouldRenderToolCardsOnly) {
    return html`${toolCards.map((card) =>
      renderToolCardSidebar(card, onOpenSidebar),
    )}`;
  }

  if (!markdown && !reasoningMarkdown && !hasToolCards) return nothing;

  // 流式渲染时使用轻量级纯文本，避免每次 delta 都做 markdown 全量解析
  const renderedHtml = opts.isStreaming && markdown
    ? streamingTextToHtml(markdown)
    : markdown
      ? toSanitizedMarkdownHtml(markdown)
      : null;

  return html`
    <div class="${bubbleClasses}">
      ${canCopyMarkdown && !opts.isStreaming ? renderCopyAsMarkdownButton(markdown!) : nothing}
      ${reasoningMarkdown
        ? html`<div class="chat-thinking">${unsafeHTML(
            toSanitizedMarkdownHtml(reasoningMarkdown),
          )}</div>`
        : nothing}
      ${renderedHtml
        ? html`<div class="chat-text">${unsafeHTML(renderedHtml)}</div>`
        : nothing}
      ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
    </div>
  `;
}
