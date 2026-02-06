/**
 * 任务文件预览组件
 * @since v20260206_1
 */

import { html, nothing } from "lit";

export type ChatFilePreviewProps = {
  fileName: string;
  content: string;
  onClose: () => void;
  onDownload: (fileName: string) => void;
};

export function renderChatFilePreview(props: ChatFilePreviewProps | null) {
  if (!props) {
    return nothing;
  }

  return html`
    <div
      class="chat-file-preview-overlay"
      @click=${(e: MouseEvent) => {
        // 点击遮罩层关闭预览
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div class="chat-file-preview-card">
        <div class="chat-file-preview-header">
          <div class="chat-file-preview-title">📄 ${props.fileName}</div>
          <div class="chat-file-preview-actions">
            <button
              class="btn btn-sm"
              type="button"
              @click=${() => props.onDownload(props.fileName)}
              title="下载文件"
            >
              下载
            </button>
            <button
              class="btn btn-sm"
              type="button"
              @click=${props.onClose}
              title="关闭预览"
            >
              关闭
            </button>
          </div>
        </div>
        <div class="chat-file-preview-body">
          <pre class="chat-file-preview-content">${props.content}</pre>
        </div>
      </div>
    </div>
  `;
}
