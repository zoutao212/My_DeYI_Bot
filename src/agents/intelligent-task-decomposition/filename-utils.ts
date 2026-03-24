/**
 * 文件名工具函数 — 统一管理文件名生成逻辑
 * 
 * 🔧 P116: 解决超长文件名问题
 * 
 * 核心问题：LLM 分解任务时可能返回超长的 summary（数百甚至数千字符），
 * 如果直接用 summary 生成文件名，会导致：
 * 1. 文件系统无法创建超长文件名（Windows 限制 260 字符）
 * 2. 日志和调试信息难以阅读
 * 3. 文件名重复使用完整 prompt 内容
 * 
 * 解决方案：
 * 1. 限制文件名基础名长度（默认 50 字符）
 * 2. 自动清洗非法字符（Windows/Unix）
 * 3. 超长时自动截断并添加标记
 */

/**
 * Windows 非法文件名字符（不包括路径分隔符）
 */
const WINDOWS_ILLEGAL_CHARS = /[：:*?"<>|]/g;

/**
 * 生成安全的文件名
 * 
 * @param baseName 基础名（如 task.summary）
 * @param extension 文件扩展名（默认 ".txt"）
 * @param maxLength 基础名最大长度（默认 50）
 * @returns 安全的文件名
 */
export function generateSafeFileName(
  baseName: string,
  extension: string = ".txt",
  maxLength: number = 50
): string {
  // 1. 替换非法字符
  let safeBase = baseName.replace(WINDOWS_ILLEGAL_CHARS, "_");
  
  // 2. 移除首尾空白和特殊字符
  safeBase = safeBase.trim().replace(/^[\s_\-]+|[\s_\-]+$/g, "");
  
  // 3. 限制长度
  if (safeBase.length > maxLength) {
    safeBase = safeBase.substring(0, maxLength) + "_截断";
  }
  
  // 4. 确保非空
  if (!safeBase || safeBase.length === 0) {
    safeBase = "output";
  }
  
  return safeBase + extension;
}

/**
 * 生成基于任务摘要的文件名
 * 
 * @param summary 任务摘要（可能很长）
 * @param fallback 默认文件名（如 "output"）
 * @returns 安全的文件名
 */
export function generateFileNameFromSummary(
  summary: string | undefined,
  fallback: string = "output"
): string {
  const baseName = summary ?? fallback;
  return generateSafeFileName(baseName);
}

/**
 * 清洗文件名中的非法字符（不截断长度）
 * 
 * @param fileName 文件名
 * @returns 清洗后的文件名
 */
export function sanitizeFileName(fileName: string): string {
  return fileName.replace(WINDOWS_ILLEGAL_CHARS, "_");
}

/**
 * 验证文件名是否合法
 * 
 * @param fileName 文件名
 * @param maxLength 最大长度（默认 100）
 * @returns 是否合法
 */
export function isValidFileName(
  fileName: string,
  maxLength: number = 100
): boolean {
  // 检查长度
  if (fileName.length > maxLength) {
    return false;
  }
  
  // 检查非法字符
  if (WINDOWS_ILLEGAL_CHARS.test(fileName)) {
    return false;
  }
  
  // 检查空文件名
  if (!fileName || fileName.trim().length === 0) {
    return false;
  }
  
  return true;
}
