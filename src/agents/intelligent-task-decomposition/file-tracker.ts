/**
 * 文件追踪注册表
 * 
 * 追踪 write 工具在任务执行期间创建/修改的文件。
 * 用于解决"任务系统找不到实际文件产出"的 Bug：
 * - write 工具写入文件时调用 trackFileWrite() 注册
 * - 任务完成后 orchestrator 调用 collectTrackedFiles() 收集
 * - 收集到的文件路径写入 subTask.metadata.producedFiles
 * - mergeTaskOutputs 据此找到实际文件进行合并
 * 
 * 生命周期：
 * - beginTracking(taskId) — 子任务开始执行前调用
 * - trackFileWrite(filePath, ...) — write 工具每次写入时调用
 * - collectTrackedFiles(taskId) — 子任务完成后调用，返回并清空追踪记录
 * - clearTracking(taskId) — 异常时清理追踪记录
 */

import path from "node:path";

/**
 * 单个文件的追踪记录
 */
export interface TrackedFile {
  /** 文件绝对路径 */
  filePath: string;
  /** 文件名 */
  fileName: string;
  /** 文件大小（字节） */
  fileSize: number;
  /** 写入时使用的编码 */
  encoding: string;
  /** 写入时间戳 */
  writtenAt: number;
  /** 写入模式（overwrite/append/insert/replace） */
  writeMode?: string;
}

/**
 * 全局文件追踪注册表
 * 
 * key = taskId（当前正在执行的子任务 ID）
 * value = 该任务执行期间写入的文件列表
 */
const FILE_REGISTRY = new Map<string, TrackedFile[]>();

/** 当前活跃的追踪任务 ID */
let currentTrackingTaskId: string | null = null;

/**
 * 开始追踪某个子任务的文件产出
 * 
 * @param taskId 子任务 ID
 */
export function beginTracking(taskId: string): void {
  currentTrackingTaskId = taskId;
  if (!FILE_REGISTRY.has(taskId)) {
    FILE_REGISTRY.set(taskId, []);
  }
  console.log(`[FileTracker] 🔍 开始追踪任务 ${taskId} 的文件产出`);
}

/**
 * 追踪一次文件写入操作
 * 
 * 由 write 工具在每次成功写入后调用。
 * 如果没有活跃的追踪任务，仍然记录到全局"未关联"列表。
 * 
 * @param filePath 文件路径
 * @param fileSize 文件大小（字节）
 * @param encoding 使用的编码
 * @param writeMode 写入模式
 */
export function trackFileWrite(
  filePath: string,
  fileSize: number,
  encoding: string,
  writeMode?: string
): void {
  const tracked: TrackedFile = {
    filePath: path.resolve(filePath),
    fileName: path.basename(filePath),
    fileSize,
    encoding,
    writtenAt: Date.now(),
    writeMode,
  };

  const taskId = currentTrackingTaskId || "__unassociated__";
  
  if (!FILE_REGISTRY.has(taskId)) {
    FILE_REGISTRY.set(taskId, []);
  }
  
  const files = FILE_REGISTRY.get(taskId)!;
  
  // 避免重复记录同一文件（覆写场景）
  const existingIdx = files.findIndex(f => f.filePath === tracked.filePath);
  if (existingIdx >= 0) {
    files[existingIdx] = tracked; // 更新为最新写入
  } else {
    files.push(tracked);
  }
  
  console.log(
    `[FileTracker] 📝 记录文件写入: ${tracked.fileName} ` +
    `(${formatSize(fileSize)}, ${encoding}) → 任务 ${taskId}`
  );
}

/**
 * 收集某个子任务的所有文件产出
 * 
 * 返回追踪到的文件列表并清空该任务的追踪记录。
 * 
 * @param taskId 子任务 ID
 * @returns 该任务执行期间写入的所有文件
 */
export function collectTrackedFiles(taskId: string): TrackedFile[] {
  const files = FILE_REGISTRY.get(taskId) || [];
  
  // 也收集"未关联"的文件（在追踪开始前就写入的）
  const unassociated = FILE_REGISTRY.get("__unassociated__") || [];
  const allFiles = [...files, ...unassociated];
  
  // 清理
  FILE_REGISTRY.delete(taskId);
  FILE_REGISTRY.delete("__unassociated__");
  
  if (currentTrackingTaskId === taskId) {
    currentTrackingTaskId = null;
  }
  
  console.log(
    `[FileTracker] 📦 收集任务 ${taskId} 的文件产出: ${allFiles.length} 个文件`
  );
  
  return allFiles;
}

/**
 * 清理某个子任务的追踪记录（异常时使用）
 */
export function clearTracking(taskId: string): void {
  FILE_REGISTRY.delete(taskId);
  if (currentTrackingTaskId === taskId) {
    currentTrackingTaskId = null;
  }
}

/**
 * 获取当前追踪的任务 ID
 */
export function getCurrentTrackingTaskId(): string | null {
  return currentTrackingTaskId;
}

/**
 * 获取所有追踪记录的快照（调试用）
 */
export function getTrackingSnapshot(): Map<string, TrackedFile[]> {
  return new Map(FILE_REGISTRY);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
