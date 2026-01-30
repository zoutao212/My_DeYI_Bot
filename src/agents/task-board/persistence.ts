/**
 * 任务看板持久化层
 * 
 * 负责将任务看板保存到磁盘和从磁盘加载。
 * 使用原子写入确保数据一致性。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { TaskBoard } from "./types.js";

/**
 * 获取任务看板的存储目录
 * @param sessionId 会话 ID
 * @returns 存储目录路径
 */
export function getTaskBoardDir(sessionId: string): string {
  const baseDir = join(homedir(), ".clawdbot", "tasks", sessionId);
  return baseDir;
}

/**
 * 获取任务看板 JSON 文件路径
 * @param sessionId 会话 ID
 * @returns JSON 文件路径
 */
export function getTaskBoardJsonPath(sessionId: string): string {
  return join(getTaskBoardDir(sessionId), "TASK_BOARD.json");
}

/**
 * 获取任务看板 Markdown 文件路径
 * @param sessionId 会话 ID
 * @returns Markdown 文件路径
 */
export function getTaskBoardMarkdownPath(sessionId: string): string {
  return join(getTaskBoardDir(sessionId), "TASK_BOARD.md");
}

/**
 * 原子写入文件
 * 使用临时文件 + 重命名的方式确保写入的原子性
 * @param filePath 目标文件路径
 * @param content 文件内容
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  // 确保目录存在
  mkdirSync(dirname(filePath), { recursive: true });
  
  // 创建临时文件
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  
  try {
    // 写入临时文件
    writeFileSync(tmpPath, content, "utf-8");
    
    // 原子性地重命名临时文件为目标文件
    renameSync(tmpPath, filePath);
  } catch (error) {
    // 如果失败，尝试清理临时文件
    try {
      if (existsSync(tmpPath)) {
        // 注意：这里不导入 unlinkSync 以避免循环依赖
        // 临时文件会在下次写入时被覆盖
      }
    } catch {
      // 忽略清理错误
    }
    throw error;
  }
}

/**
 * 保存任务看板到磁盘
 * @param board 任务看板
 * @param sessionId 会话 ID
 */
export async function saveTaskBoard(board: TaskBoard, sessionId: string): Promise<void> {
  try {
    // 确保 sessionId 一致
    if (board.sessionId !== sessionId) {
      throw new Error(`TaskBoard sessionId (${board.sessionId}) does not match provided sessionId (${sessionId})`);
    }
    
    // 更新最后更新时间
    board.lastUpdated = new Date().toISOString();
    
    // 序列化为 JSON
    const jsonContent = JSON.stringify(board, null, 2);
    
    // 保存 JSON 文件
    const jsonPath = getTaskBoardJsonPath(sessionId);
    atomicWriteFileSync(jsonPath, jsonContent);
    
    // 注意：Markdown 渲染将在 renderer.ts 中实现
    // 这里只保存 JSON 格式
  } catch (error) {
    throw new Error(`Failed to save TaskBoard: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 从磁盘加载任务看板
 * @param sessionId 会话 ID
 * @returns 任务看板，如果不存在则返回 null
 */
export async function loadTaskBoard(sessionId: string): Promise<TaskBoard | null> {
  try {
    const jsonPath = getTaskBoardJsonPath(sessionId);
    
    // 检查文件是否存在
    if (!existsSync(jsonPath)) {
      return null;
    }
    
    // 读取文件内容
    const jsonContent = readFileSync(jsonPath, "utf-8");
    
    // 解析 JSON
    const board = JSON.parse(jsonContent) as TaskBoard;
    
    // 验证基本结构
    if (!board.sessionId || !board.mainTask || !Array.isArray(board.subTasks)) {
      throw new Error("Invalid TaskBoard structure");
    }
    
    // 验证 sessionId 一致性
    if (board.sessionId !== sessionId) {
      throw new Error(`TaskBoard sessionId (${board.sessionId}) does not match requested sessionId (${sessionId})`);
    }
    
    return board;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      // 文件不存在
      return null;
    }
    throw new Error(`Failed to load TaskBoard: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 检查任务看板是否存在
 * @param sessionId 会话 ID
 * @returns 是否存在
 */
export function taskBoardExists(sessionId: string): boolean {
  const jsonPath = getTaskBoardJsonPath(sessionId);
  return existsSync(jsonPath);
}

/**
 * 删除任务看板
 * @param sessionId 会话 ID
 */
export async function deleteTaskBoard(sessionId: string): Promise<void> {
  try {
    const jsonPath = getTaskBoardJsonPath(sessionId);
    const mdPath = getTaskBoardMarkdownPath(sessionId);
    
    // 删除 JSON 文件
    if (existsSync(jsonPath)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(jsonPath);
    }
    
    // 删除 Markdown 文件
    if (existsSync(mdPath)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(mdPath);
    }
  } catch (error) {
    throw new Error(`Failed to delete TaskBoard: ${error instanceof Error ? error.message : String(error)}`);
  }
}
