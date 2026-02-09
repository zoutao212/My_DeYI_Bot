/**
 * 统一编码工具模块
 * 
 * 解决 Node.js 原生不支持 GBK/GB2312/Big5/Shift_JIS 等编码的写入问题。
 * 读取使用 TextDecoder（Node.js 原生支持多编码解码），
 * 写入使用 iconv-lite（Node.js 原生只支持 UTF-8 编码）。
 * 
 * 同时提供 UTF-8 BOM 支持，确保 Windows 记事本正确识别 UTF-8 文件。
 */

import iconv from "iconv-lite";

/**
 * 支持的编码类型
 * 
 * - utf-8 / utf8：标准 UTF-8
 * - utf-8-bom：带 BOM 的 UTF-8（Windows 友好）
 * - gbk / gb2312：中文 GBK 编码
 * - big5：繁体中文 Big5 编码
 * - shift_jis / shift-jis：日文 Shift_JIS 编码
 * - ascii / latin1：基础编码
 * - auto：自动检测（仅用于读取）
 */
export type SupportedEncoding =
  | "utf-8"
  | "utf8"
  | "utf-8-bom"
  | "gbk"
  | "gb2312"
  | "big5"
  | "shift_jis"
  | "shift-jis"
  | "ascii"
  | "latin1"
  | "auto";

/** Node.js 原生支持的编码（可直接用于 fs.readFile/writeFile） */
const NATIVE_ENCODINGS = new Set<string>([
  "utf-8", "utf8", "ascii", "latin1", "binary",
  "base64", "base64url", "hex", "ucs2", "ucs-2", "utf16le",
]);

/** UTF-8 BOM 字节序列 */
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

/**
 * 判断编码是否需要 iconv-lite 处理
 */
export function needsIconvForWrite(encoding: string): boolean {
  const normalized = normalizeEncoding(encoding);
  if (normalized === "utf-8-bom") return false; // BOM 模式用原生 UTF-8 + 前缀
  return !NATIVE_ENCODINGS.has(normalized);
}

/**
 * 规范化编码名称
 */
export function normalizeEncoding(encoding: string): string {
  const lower = encoding.toLowerCase().trim();
  // 统一别名
  switch (lower) {
    case "utf8":
      return "utf-8";
    case "shift-jis":
      return "shift_jis";
    case "gb2312":
      return "gbk"; // GB2312 是 GBK 的子集
    default:
      return lower;
  }
}

/**
 * 验证编码是否被支持
 */
export function isEncodingSupported(encoding: string): boolean {
  const normalized = normalizeEncoding(encoding);
  if (NATIVE_ENCODINGS.has(normalized)) return true;
  if (normalized === "utf-8-bom") return true;
  if (normalized === "auto") return true;
  // 检查 iconv-lite 是否支持
  return iconv.encodingExists(normalized);
}

/**
 * 将字符串编码为 Buffer
 * 
 * 支持 GBK、Big5、Shift_JIS 等 Node.js 原生不支持的编码。
 * 对于 UTF-8 BOM 模式，自动在文件头部添加 BOM 标记。
 * 
 * @param content 要编码的字符串内容
 * @param encoding 目标编码
 * @returns 编码后的 Buffer
 */
export function encodeString(content: string, encoding: SupportedEncoding = "utf-8"): Buffer {
  const normalized = normalizeEncoding(encoding);

  // UTF-8 BOM：原生编码 + BOM 前缀
  if (normalized === "utf-8-bom") {
    const contentBuffer = Buffer.from(content, "utf-8");
    return Buffer.concat([UTF8_BOM, contentBuffer]);
  }

  // 原生编码：直接用 Buffer.from
  if (NATIVE_ENCODINGS.has(normalized)) {
    return Buffer.from(content, normalized as BufferEncoding);
  }

  // 非原生编码（GBK/Big5/Shift_JIS 等）：使用 iconv-lite
  if (!iconv.encodingExists(normalized)) {
    console.warn(
      `[encoding-utils] ⚠️ 不支持的编码 "${encoding}"，回退到 UTF-8`
    );
    return Buffer.from(content, "utf-8");
  }

  return iconv.encode(content, normalized);
}

/**
 * 将 Buffer 解码为字符串
 * 
 * 支持自动编码检测和多种编码解码。
 * 
 * @param buffer 要解码的 Buffer
 * @param encoding 源编码（"auto" 表示自动检测）
 * @returns 解码后的字符串
 */
export function decodeBuffer(buffer: Buffer, encoding: SupportedEncoding = "utf-8"): string {
  let normalized = normalizeEncoding(encoding);

  // 自动检测编码
  if (normalized === "auto") {
    normalized = detectEncoding(buffer);
  }

  // 处理 UTF-8 BOM：跳过 BOM 头
  if (normalized === "utf-8-bom" || normalized === "utf-8") {
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      buffer = buffer.subarray(3);
    }
    return buffer.toString("utf-8");
  }

  // 原生编码
  if (NATIVE_ENCODINGS.has(normalized)) {
    return buffer.toString(normalized as BufferEncoding);
  }

  // 非原生编码：使用 iconv-lite
  if (!iconv.encodingExists(normalized)) {
    console.warn(
      `[encoding-utils] ⚠️ 不支持的编码 "${encoding}"，回退到 UTF-8 解码`
    );
    return buffer.toString("utf-8");
  }

  return iconv.decode(buffer, normalized);
}

/**
 * 自动检测 Buffer 的编码
 * 
 * 检测策略：
 * 1. 检查 BOM 标记
 * 2. 尝试 UTF-8 严格解码（无替换字符）
 * 3. 依次尝试 GBK、Big5、Shift_JIS
 * 4. 兜底返回 UTF-8
 * 
 * @param buffer 要检测的 Buffer
 * @returns 检测到的编码名称
 */
export function detectEncoding(buffer: Buffer): string {
  // 1. 检查 BOM
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return "utf-8";
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return "utf16le";
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return "utf16le"; // Node.js 不区分 BE/LE 的 TextDecoder，这里简化处理
  }

  // 2. 尝试 UTF-8 严格解码
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(buffer);
    if (!text.includes("\uFFFD")) {
      return "utf-8";
    }
  } catch {
    // UTF-8 解码失败，继续尝试其他编码
  }

  // 3. 尝试 CJK 编码
  const candidateEncodings = ["gbk", "big5", "shift_jis"];
  for (const enc of candidateEncodings) {
    try {
      const decoded = iconv.decode(buffer, enc);
      // 简单启发式：如果解码后没有大量替换字符，认为匹配
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
      const ratio = replacementCount / decoded.length;
      if (ratio < 0.01) { // 替换字符少于 1%
        return enc;
      }
    } catch {
      continue;
    }
  }

  // 4. 兜底
  return "utf-8";
}

/**
 * 为 Windows 平台优化编码选择
 * 
 * 如果目标编码是 utf-8 且平台是 Windows，
 * 自动升级为 utf-8-bom 确保兼容性。
 * 
 * @param encoding 原始编码
 * @param forceWindowsCompat 是否强制 Windows 兼容模式
 * @returns 优化后的编码
 */
export function optimizeEncodingForPlatform(
  encoding: SupportedEncoding,
  forceWindowsCompat: boolean = false
): SupportedEncoding {
  const normalized = normalizeEncoding(encoding);
  
  if (normalized === "utf-8" && (forceWindowsCompat || process.platform === "win32")) {
    return "utf-8-bom";
  }
  
  return encoding;
}

/**
 * 获取编码的人类可读描述
 */
export function getEncodingDescription(encoding: string): string {
  const normalized = normalizeEncoding(encoding);
  const descriptions: Record<string, string> = {
    "utf-8": "UTF-8",
    "utf-8-bom": "UTF-8 (带 BOM)",
    "gbk": "GBK (简体中文)",
    "big5": "Big5 (繁体中文)",
    "shift_jis": "Shift_JIS (日文)",
    "ascii": "ASCII",
    "latin1": "Latin-1",
  };
  return descriptions[normalized] || encoding;
}
