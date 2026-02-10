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
import { AsyncLocalStorage } from "node:async_hooks";

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

/** 当前活跃的追踪任务 ID 栈（支持并行执行） */
const activeTrackingStack: string[] = [];

/**
 * 🔧 并行安全：AsyncLocalStorage 隔离每个任务的追踪上下文
 * 并行执行时，每个任务在自己的 async context 中运行，
 * trackFileWrite 通过 ALS 获取正确的 taskId，不会串台。
 */
const trackingALS = new AsyncLocalStorage<string>();

/**
 * 获取当前追踪的任务 ID（优先 ALS，回退到栈顶）
 */
function resolveCurrentTaskId(): string | null {
  return trackingALS.getStore() ?? activeTrackingStack[activeTrackingStack.length - 1] ?? null;
}

/**
 * 开始追踪某个子任务的文件产出
 * 
 * @param taskId 子任务 ID
 */
export function beginTracking(taskId: string): void {
  // 🔧 并行安全：用栈替代单变量，支持多任务同时追踪
  activeTrackingStack.push(taskId);
  if (!FILE_REGISTRY.has(taskId)) {
    FILE_REGISTRY.set(taskId, []);
  }
  console.log(`[FileTracker] 🔍 开始追踪任务 ${taskId} 的文件产出 (active: ${activeTrackingStack.length})`);
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

  const taskId = resolveCurrentTaskId() || "__unassociated__";
  
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

  // 🔧 修复：不再无条件合并 __unassociated__ 文件
  // 原因：并行执行时，第一个完成的任务会把所有 __unassociated__ 文件都吞掉，
  // 导致文件归属错乱（如第一章的 producedFilePaths 包含了 1-4 章的文件）。
  // 只有当该任务自身没有追踪到文件时，才尝试从 __unassociated__ 中匹配。
  let allFiles = [...files];

  if (allFiles.length === 0) {
    // 该任务没有追踪到任何文件，尝试从 __unassociated__ 中获取
    // 但只在没有其他活跃追踪任务时才这样做（避免抢占）
    const unassociated = FILE_REGISTRY.get("__unassociated__") || [];
    if (unassociated.length > 0 && activeTrackingStack.length <= 1) {
      allFiles = [...unassociated];
      FILE_REGISTRY.delete("__unassociated__");
      console.log(
        `[FileTracker] 📦 任务 ${taskId} 无直接追踪文件，从 __unassociated__ 获取 ${allFiles.length} 个`
      );
    }
  }

  // 清理该任务的追踪记录
  FILE_REGISTRY.delete(taskId);

  // 从栈中移除（并行安全：只移除匹配的第一个）
  const stackIdx = activeTrackingStack.indexOf(taskId);
  if (stackIdx >= 0) {
    activeTrackingStack.splice(stackIdx, 1);
  }

  console.log(
    `[FileTracker] 📦 收集任务 ${taskId} 的文件产出: ${allFiles.length} 个文件 (remaining active: ${activeTrackingStack.length})`
  );

  return allFiles;
}

/**
 * 清理某个子任务的追踪记录（异常时使用）
 */
export function clearTracking(taskId: string): void {
  FILE_REGISTRY.delete(taskId);
  const stackIdx = activeTrackingStack.indexOf(taskId);
  if (stackIdx >= 0) {
    activeTrackingStack.splice(stackIdx, 1);
  }
}

/**
 * 获取当前追踪的任务 ID
 */
export function getCurrentTrackingTaskId(): string | null {
  return resolveCurrentTaskId();
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

/**
 * 🔧 并行安全：在 AsyncLocalStorage 上下文中执行回调
 * 
 * 并行执行多个任务时，每个任务应该用 runWithTracking 包裹，
 * 确保 trackFileWrite 能正确关联到对应的 taskId。
 * 
 * @param taskId 子任务 ID
 * @param fn 要执行的异步函数
 * @returns fn 的返回值
 */
export async function runWithTracking<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  return trackingALS.run(taskId, fn);
}
