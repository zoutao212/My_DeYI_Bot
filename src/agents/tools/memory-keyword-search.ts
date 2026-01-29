import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface KeywordSearchResult {
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  text: string;
}

/**
 * Simple keyword-based search for memory files.
 * Used as fallback when embedding API is unavailable.
 */
export async function keywordSearch(params: {
  query: string;
  memoryDir: string;
  maxResults?: number;
}): Promise<KeywordSearchResult[]> {
  const keywords = params.query
    .toLowerCase()
    .split(/\s+/)
    .filter(k => k.length > 1); // 过滤单字符
  
  if (keywords.length === 0) return [];
  
  const results: KeywordSearchResult[] = [];
  
  try {
    // 读取所有 .md 文件
    const files = await fs.readdir(params.memoryDir);
    
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      
      const filePath = path.join(params.memoryDir, file);
      
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n");
        
        // 搜索包含关键词的行
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].toLowerCase();
          const matchCount = keywords.filter(kw => line.includes(kw)).length;
          
          if (matchCount > 0) {
            // 提取上下文（前后各 1 行）
            const contextStart = Math.max(0, i - 1);
            const contextEnd = Math.min(lines.length - 1, i + 1);
            const contextText = lines.slice(contextStart, contextEnd + 1).join("\n");
            
            results.push({
              path: file,
              lineStart: i + 1,
              lineEnd: i + 1,
              score: matchCount / keywords.length,
              text: contextText,
            });
          }
        }
      } catch (err) {
        // 跳过无法读取的文件
        console.warn(`Failed to read ${file}:`, err);
        continue;
      }
    }
    
    // 按相关性排序
    results.sort((a, b) => b.score - a.score);
    
    // 限制结果数量
    return results.slice(0, params.maxResults ?? 10);
  } catch (err) {
    console.error("Keyword search failed:", err);
    return [];
  }
}
