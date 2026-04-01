/**
 * YAML 加载工具
 *
 * @module persona-3d-fusion/utils/yaml-loader
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import yaml from "js-yaml";

/**
 * 缓存条目
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * YAML 加载器（带缓存）
 */
export class YamlLoader<T = unknown> {
  private cache = new Map<string, CacheEntry<T>>();
  private basePath: string;
  private cacheEnabled: boolean;
  private cacheTTL: number; // 毫秒

  constructor(basePath: string, cacheEnabled: boolean = true, cacheTTL: number = 60000) {
    this.basePath = basePath;
    this.cacheEnabled = cacheEnabled;
    this.cacheTTL = cacheTTL;
  }

  /**
   * 加载 YAML 文件
   */
  async load(filePath: string): Promise<T | null> {
    const fullPath = join(this.basePath, filePath);
    const cacheKey = fullPath;

    // 检查缓存
    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.data;
      }
    }

    try {
      const content = await readFile(fullPath, "utf-8");
      const data = yaml.load(content) as T;

      // 更新缓存
      if (this.cacheEnabled) {
        this.cache.set(cacheKey, {
          data,
          timestamp: Date.now(),
        });
      }

      return data;
    } catch (error) {
      console.warn(`[YamlLoader] 加载失败: ${fullPath}`, error);
      return null;
    }
  }

  /**
   * 加载目录下的所有 YAML 文件
   */
  async loadDirectory<T = unknown>(
    dirPath: string,
    extension: string = ".yaml",
  ): Promise<Map<string, T>> {
    const fullPath = join(this.basePath, dirPath);
    const results = new Map<string, T>();

    try {
      const entries = await readdir(fullPath);

      for (const entry of entries) {
        const entryPath = join(fullPath, entry);
        const stats = await stat(entryPath);

        if (stats.isFile() && extname(entry) === extension) {
          const key = entry.replace(extension, "");
          const data = await this.load(join(dirPath, entry));
          if (data) {
            results.set(key, data as T);
          }
        }
      }
    } catch (error) {
      console.warn(`[YamlLoader] 目录加载失败: ${fullPath}`, error);
    }

    return results;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 清除特定文件的缓存
   */
  clearCacheForFile(filePath: string): void {
    const fullPath = join(this.basePath, filePath);
    this.cache.delete(fullPath);
  }

  /**
   * 设置基础路径
   */
  setBasePath(basePath: string): void {
    this.basePath = basePath;
    this.clearCache();
  }
}

// =============================================================================
// 便捷函数
// =============================================================================

/**
 * 同步加载 YAML（简化版本，用于不需要缓存的场景）
 */
export async function loadYaml<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return yaml.load(content) as T;
  } catch {
    return null;
  }
}

/**
 * 同步加载 YAML 文件（简化版本）
 */
export function loadYamlSync<T = unknown>(filePath: string): T | null {
  try {
    const content = require("fs").readFileSync(filePath, "utf-8");
    return yaml.load(content) as T;
  } catch {
    return null;
  }
}
