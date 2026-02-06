/**
 * 任务文件列表组件
 * @since v20260206_1
 */

import { html, nothing } from "lit";

export type ChatFileItem = {
  fileName: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
};

export type ChatFileListProps = {
  files: ChatFileItem[];
  onPreview: (fileName: string) => void;
  onDownload: (fileName: string) => void;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

export function renderChatFileList(props: ChatFileListProps) {
  if (props.files.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-file-list">
      <div class="chat-file-list-header">
        <h3>📁 任务文件</h3>
      </div>
      <div class="chat-file-list-body">
        ${props.files.map(
          (file) => html`
            <div class="chat-file-item">
              <div class="chat-file-icon">📄</div>
              <div class="chat-file-info">
                <div class="chat-file-name" title="${file.fileName}">
                  ${file.fileName}
                </div>
                <div class="chat-file-meta">
                  ${formatFileSize(file.size)} · ${formatDate(file.createdAt)}
                </div>
              </div>
              <div class="chat-file-actions">
                <button
                  class="btn btn-sm"
                  type="button"
                  @click=${() => props.onPreview(file.fileName)}
                  title="预览文件"
                >
                  预览
                </button>
                <button
                  class="btn btn-sm"
                  type="button"
                  @click=${() => props.onDownload(file.fileName)}
                  title="下载文件"
                >
                  下载
                </button>
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}
