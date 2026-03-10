import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../types";
import type { ChatQueueItem } from "../ui-types";
import type { ChatItem, MessageGroup } from "../types/chat-types";
import { icons } from "../icons";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../chat/message-normalizer";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render";
import { hasSendFileCard } from "../chat/tool-cards";
import { renderMarkdownSidebar } from "./markdown-sidebar";
import { renderChatFileList } from "./chat-file-list";
import { renderChatFilePreview } from "./chat-file-preview";
import "../components/resizable-divider";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  reasoningStream?: string | null;
  streamStartedAt: number | null;
  waitElapsedSeconds: number;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  runEvents?: Array<{
    ts: number;
    sessionKey?: string;
    runId?: string;
    kind: string;
    payload?: unknown;
  }>;
  onClearRunEvents?: () => void;
  // File list & preview (v20260206_1)
  fileList?: Array<{
    fileName: string;
    size: number;
    createdAt: string;
    modifiedAt: string;
  }>;
  filePreview?: {
    fileName: string;
    content: string;
  } | null;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onNewSessionNoSummary: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  // File handlers (v20260206_1)
  onFilePreview?: (fileName: string) => void;
  onFileDownload?: (fileName: string) => void;
  onFilePreviewClose?: () => void;
  // Attachment handlers (drag-drop text files)
  pendingAttachments?: Array<{ fileName: string; size: number }>;
  onFileDrop?: (files: File[]) => void;
  onRemoveAttachment?: (index: number) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function renderRunPanelInChat(props: ChatProps) {
  // 运行事件流已隐藏，详细日志写入 runtimelog 目录
  return nothing;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) return nothing;

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="callout info compaction-indicator compaction-indicator--active">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="callout success compaction-indicator compaction-indicator--complete">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null || (props.reasoningStream ?? null) !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find(
    (row) => row.key === props.sessionKey,
  );
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const composePlaceholder = props.connected
    ? "Message (↩ to send, Shift+↩ for line breaks)"
    : "Connect to the gateway to start chatting…";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${props.loading ? html`<div class="muted">Loading chat…</div>` : nothing}
      ${repeat(buildChatItems(props), (item) => item.key, (item) => {
        if (item.kind === "reading-indicator") {
          return renderReadingIndicatorGroup(assistantIdentity, props.waitElapsedSeconds);
        }

        if (item.kind === "stream") {
          return renderStreamingGroup(
            item.text,
            item.reasoning ?? null,
            item.startedAt,
            props.onOpenSidebar,
            assistantIdentity,
            props.waitElapsedSeconds,
            showReasoning,
          );
        }

        if (item.kind === "group") {
          return renderMessageGroup(item, {
            onOpenSidebar: props.onOpenSidebar,
            showReasoning,
            assistantName: props.assistantName,
            assistantAvatar: assistantIdentity.avatar,
          });
        }

        return nothing;
      })}
    </div>
  `;

  return html`
    <section class="card chat">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: center;">
        <div class="mono" style="font-size: 12px; opacity: 0.9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${props.sessionKey}
        </div>
        <div class="row" style="gap: 8px;">
          <button
            class="btn"
            type="button"
            ?disabled=${!props.connected || props.sending}
            @click=${props.onNewSession}
          >
            新会话（带总结）
          </button>
          <button
            class="btn"
            type="button"
            ?disabled=${!props.connected || props.sending}
            @click=${props.onNewSessionNoSummary}
          >
            全新开始（不总结）
          </button>
        </div>
      </div>

      ${renderRunPanelInChat(props)}

      ${props.disabledReason
        ? html`<div class="callout">${props.disabledReason}</div>`
        : nothing}

      ${props.error
        ? html`<div class="callout danger">${props.error}</div>`
        : nothing}

      ${renderCompactionIndicator(props.compactionStatus)}

      ${props.focusMode
        ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
        : nothing}

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${sidebarOpen
          ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) =>
                  props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
                  content: props.sidebarContent ?? null,
                  error: props.sidebarError ?? null,
                  onClose: props.onCloseSidebar!,
                  onViewRawText: () => {
                    if (!props.sidebarContent || !props.onOpenSidebar) return;
                    props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                  },
                })}
              </div>
            `
          : nothing}
      </div>

      ${props.queue.length
        ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">${item.text}</div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}

      ${props.fileList && props.fileList.length > 0 && props.onFilePreview && props.onFileDownload
        ? renderChatFileList({
            files: props.fileList,
            onPreview: props.onFilePreview,
            onDownload: props.onFileDownload,
          })
        : nothing}

      ${props.filePreview && props.onFilePreviewClose && props.onFileDownload
        ? renderChatFilePreview({
            fileName: props.filePreview.fileName,
            content: props.filePreview.content,
            onClose: props.onFilePreviewClose,
            onDownload: props.onFileDownload,
          })
        : nothing}

      <div class="chat-compose" style="position: relative;"
        @dragover=${(e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          const el = (e.currentTarget as HTMLElement).querySelector(".chat-compose__drop-overlay") as HTMLElement | null;
          if (el) el.style.display = "flex";
        }}
        @dragleave=${(e: DragEvent) => {
          e.preventDefault();
          const el = (e.currentTarget as HTMLElement).querySelector(".chat-compose__drop-overlay") as HTMLElement | null;
          if (el) el.style.display = "none";
        }}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          const el = (e.currentTarget as HTMLElement).querySelector(".chat-compose__drop-overlay") as HTMLElement | null;
          if (el) el.style.display = "none";
          if (e.dataTransfer?.files?.length && props.onFileDrop) {
            props.onFileDrop(Array.from(e.dataTransfer.files));
          }
        }}
      >
        <div class="chat-compose__drop-overlay" style="display: none;">
          📎 拖放文件到此处
        </div>
        <div style="flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px;">
          <label class="field chat-compose__field">
            <span>Message</span>
            <textarea
              .value=${props.draft}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key !== "Enter") return;
                if (e.isComposing || e.keyCode === 229) return;
                if (e.shiftKey) return; // Allow Shift+Enter for line breaks
                if (!props.connected) return;
                e.preventDefault();
                if (canCompose) props.onSend();
              }}
              @input=${(e: Event) =>
                props.onDraftChange((e.target as HTMLTextAreaElement).value)}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>
          ${props.pendingAttachments && props.pendingAttachments.length > 0
            ? html`
                <div class="chat-compose__attachments">
                  ${props.pendingAttachments.map(
                    (att, idx) => html`
                      <span class="chat-attachment-chip">
                        <span class="chat-attachment-chip__name" title=${att.fileName}>${att.fileName}</span>
                        <span class="chat-attachment-chip__size">${formatAttachmentSize(att.size)}</span>
                        <button
                          class="chat-attachment-chip__remove"
                          type="button"
                          aria-label="Remove attachment"
                          @click=${() => props.onRemoveAttachment?.(idx)}
                        >×</button>
                      </span>
                    `,
                  )}
                </div>
              `
            : nothing}
        </div>
        <div class="chat-compose__actions">
          ${canAbort
            ? html`
                <button
                  class="btn"
                  ?disabled=${!props.connected || props.sending}
                  @click=${props.onAbort}
                >
                  Stop
                </button>
              `
            : nothing}
          <button
            class="btn primary"
            ?disabled=${!props.connected}
            @click=${props.onSend}
          >
            ${isBusy ? "Queue" : "Send"}<kbd class="btn-kbd">↵</kbd>
          </button>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || currentGroup.role !== role) {
      if (currentGroup) result.push(currentGroup);
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) result.push(currentGroup);
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);

    if (!props.showThinking && normalized.role.toLowerCase() === "toolresult") {
      // Always show send_file results with webFileCard (file delivery cards)
      if (!hasSendFileCard(msg)) {
        continue;
      }
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  if (props.showThinking) {
    for (let i = 0; i < tools.length; i++) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null || (props.reasoningStream ?? null) !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    const streamText = props.stream ?? "";
    const reasoningText = props.reasoningStream ?? null;
    const hasVisibleReasoning = props.showThinking && Boolean(reasoningText?.trim());
    if (streamText.trim().length > 0 || hasVisibleReasoning) {
      items.push({
        kind: "stream",
        key,
        text: streamText,
        reasoning: reasoningText,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) return `tool:${toolCallId}`;
  const id = typeof m.id === "string" ? m.id : "";
  if (id) return `msg:${id}`;
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) return `msg:${messageId}`;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) return `msg:${role}:${timestamp}:${index}`;
  return `msg:${role}:${index}`;
}
