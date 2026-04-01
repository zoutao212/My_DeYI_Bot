/**
 * 文件缓存工具
 *
 * @module persona-3d-fusion/utils/file-cache
 */

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

/**
 * 缓存条目
 */
interface CacheEntry {
  data: string;
  mtime: number;
  size: number;
}

/**
 * 文件缓存
 */
export class FileCache {
  private cache = new Map<string, CacheEntry>();
  private cacheSize: number;
  private maxCacheSize: number;

  constructor(maxCacheSize: number = 100) {
    this.cacheSize = 0;
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * 获取文件内容（带缓存）
   */
  async get(filePath: string): Promise<string | null> {
    const entry = this.cache.get(filePath);

    if (!entry) {
      return null;
    }

    try {
      const stats = await stat(filePath);

      // 检查文件是否被修改
      if (stats.mtimeMs > entry.mtime || stats.size !== entry.size) {
        this.cache.delete(filePath);
        this.cacheSize--;
        return null;
      }

      return entry.data;
    } catch {
      this.cache.delete(filePath);
      this.cacheSize--;
      return null;
    }
  }

  /**
   * 设置文件内容到缓存
   */
  async set(filePath: string, data?: string): Promise<string | null> {
    let content = data;

    if (content === undefined) {
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    }

    try {
      const stats = await stat(filePath);

      // 清理缓存如果满了
      while (this.cacheSize >= this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) {
          const entry = this.cache.get(firstKey);
          if (entry) {
            this.cacheSize -= entry.size;
          }
          this.cache.delete(firstKey);
        }
      }

      const entry: CacheEntry = {
        data: content,
        mtime: stats.mtimeMs,
        size: stats.size,
      };

      this.cache.set(filePath, entry);
      this.cacheSize += stats.size;

      return content;
    } catch {
      return null;
    }
  }

  /**
   * 计算文件的 hash（用于版本控制）
   */
  async getFileHash(filePath: string): Promise<string | null> {
    const content = await this.get(filePath);
    if (!content) return null;
    return createHash("sha256").update(content).digest("hex").substring(0, 16);
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear();
    this.cacheSize = 0;
  }

  /**
   * 删除特定文件的缓存
   */
  invalidate(filePath: string): void {
    const entry = this.cache.get(filePath);
    if (entry) {
      this.cacheSize -= entry.size;
    }
    this.cache.delete(filePath);
  }

  /**
   * 获取缓存统计
   */
  getStats(): { count: number; size: number; maxSize: number } {
    return {
      count: this.cache.size,
      size: this.cacheSize,
      maxSize: this.maxCacheSize,
    };
  }
}

// =============================================================================
// 全局缓存实例
// =============================================================================

const globalFileCache = new FileCache();

export { globalFileCache };

export default FileCache;
