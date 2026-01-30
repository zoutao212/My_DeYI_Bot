# Buffer 解码编码问题处理

> **背景**：Node.js 处理 Buffer 时，默认使用 UTF-8 解码，但 Windows 命令行输出是 GBK 编码，导致中文乱码

---

## 问题现象

### 典型乱码

```
����λ�� ��:1 �ַ�: 1
```

### 错误特征

- 命令行工具输出中文时显示为乱码
- PowerShell 错误信息乱码
- 日志中的中文内容乱码
- 英文和数字正常显示

---

## 根本原因

### Buffer 解码不匹配

**问题链条**：
```
Windows 命令行输出 GBK 编码的 Buffer
  ↓
Node.js 使用 UTF-8 解码（buffer.toString()）
  ↓
编码不匹配
  ↓
乱码
```

### 代码示例

**错误代码**：
```typescript
// ❌ 错误：默认 UTF-8 解码
child.stdout.on("data", (data: Buffer) => {
  const text = data.toString();  // 默认 UTF-8
  console.log(text);  // 乱码
});
```

**问题**：
- `data` 是 Buffer 类型
- `data.toString()` 默认使用 UTF-8 解码
- Windows 命令行输出是 GBK 编码
- 导致中文乱码

---

## 解决方案

### 方案 1：智能解码（推荐）

根据平台自动选择合适的编码：

```typescript
function decodeBuffer(data: Buffer | string): string {
  // 如果已经是字符串，直接返回
  if (typeof data === "string") {
    return data;
  }
  
  // Windows 平台：优先尝试 GBK
  if (process.platform === "win32") {
    try {
      const decoder = new TextDecoder("gbk", { fatal: false });
      const text = decoder.decode(data);
      
      // 检查是否有替换字符（表示解码失败）
      if (!text.includes("\uFFFD") || text.length === 0) {
        return text;
      }
    } catch {
      // 继续尝试其他编码
    }
  }
  
  // 回退到 UTF-8
  try {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    return decoder.decode(data);
  } catch {
    // 最后的回退：使用默认 toString()
    return data.toString();
  }
}
```

**使用**：
```typescript
child.stdout.on("data", (data: Buffer) => {
  const text = decodeBuffer(data);  // ✅ 正确解码
  console.log(text);
});
```

### 方案 2：指定编码

如果确定编码类型，直接指定：

```typescript
function decodeBuffer(data: Buffer, encoding: string = "utf-8"): string {
  if (typeof data === "string") return data;
  
  try {
    const decoder = new TextDecoder(encoding, { fatal: false });
    return decoder.decode(data);
  } catch {
    return data.toString();
  }
}

// 使用
const text = decodeBuffer(data, "gbk");
```

### 方案 3：配置化

允许用户配置编码：

```typescript
interface DecoderOptions {
  platform?: "win32" | "linux" | "darwin";
  encoding?: string;
  fallback?: string;
}

function createDecoder(options: DecoderOptions = {}) {
  const platform = options.platform ?? process.platform;
  const primaryEncoding = options.encoding ?? (platform === "win32" ? "gbk" : "utf-8");
  const fallbackEncoding = options.fallback ?? "utf-8";
  
  return (data: Buffer | string): string => {
    if (typeof data === "string") return data;
    
    // 尝试主编码
    try {
      const decoder = new TextDecoder(primaryEncoding, { fatal: false });
      const text = decoder.decode(data);
      if (!text.includes("\uFFFD")) return text;
    } catch {}
    
    // 尝试回退编码
    try {
      const decoder = new TextDecoder(fallbackEncoding, { fatal: false });
      return decoder.decode(data);
    } catch {
      return data.toString();
    }
  };
}

// 使用
const decoder = createDecoder({ encoding: "gbk", fallback: "utf-8" });
const text = decoder(data);
```

---

## 核心技术

### TextDecoder API

**基本用法**：
```typescript
const decoder = new TextDecoder(encoding, options);
const text = decoder.decode(buffer);
```

**参数**：
- `encoding`：编码类型
  - `"utf-8"`：UTF-8 编码
  - `"gbk"`：简体中文 GBK 编码
  - `"gb2312"`：简体中文 GB2312 编码
  - `"big5"`：繁体中文 Big5 编码
  - `"shift_jis"`：日文 Shift_JIS 编码
  - 更多：[Encoding API 标准](https://encoding.spec.whatwg.org/)

- `options.fatal`：是否在遇到无效字符时抛出错误
  - `true`：抛出错误
  - `false`：插入替换字符（`\uFFFD`）

**返回值**：
- 解码后的字符串
- 如果解码失败且 `fatal: false`，包含替换字符（`\uFFFD`）

### 替换字符检测

**原理**：
```typescript
const text = decoder.decode(buffer);

// 检查是否有替换字符
if (text.includes("\uFFFD")) {
  // 解码失败，有无效字符
} else {
  // 解码成功
}
```

**替换字符**：
- Unicode：`U+FFFD`
- JavaScript：`"\uFFFD"`
- 显示：`�`

**用途**：
- 判断解码是否成功
- 选择合适的编码
- 实现自动回退

### 平台检测

**Node.js 平台标识**：
```typescript
process.platform
// "win32"  - Windows
// "linux"  - Linux
// "darwin" - macOS
// "freebsd" - FreeBSD
// "openbsd" - OpenBSD
// "sunos"  - SunOS
// "aix"    - AIX
```

**使用**：
```typescript
if (process.platform === "win32") {
  // Windows 特定处理
} else {
  // 其他平台
}
```

---

## 实战案例

### 案例 1：exec 工具输出解码

**问题**：
- exec 工具执行命令后，中文输出乱码
- 原因：Windows 命令行输出 GBK，Node.js 默认 UTF-8

**解决**：
```typescript
// src/agents/bash-tools.exec.ts

const decodeOutput = (data: Buffer | string): string => {
  if (typeof data === "string") return data;
  
  // Windows: 优先 GBK
  if (process.platform === "win32") {
    try {
      const decoder = new TextDecoder("gbk", { fatal: false });
      const text = decoder.decode(data);
      if (!text.includes("\uFFFD")) return text;
    } catch {}
  }
  
  // 回退到 UTF-8
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(data);
};

const handleStdout = (data: Buffer) => {
  const text = decodeOutput(data);
  // 处理文本...
};
```

### 案例 2：日志文件读取

**问题**：
- 读取日志文件时，中文显示乱码
- 原因：日志文件是 GBK 编码

**解决**：
```typescript
import fs from "node:fs";

async function readLogFile(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  
  // 尝试 GBK
  try {
    const decoder = new TextDecoder("gbk", { fatal: false });
    const text = decoder.decode(buffer);
    if (!text.includes("\uFFFD")) return text;
  } catch {}
  
  // 回退到 UTF-8
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(buffer);
}
```

### 案例 3：HTTP 响应解码

**问题**：
- HTTP 响应中的中文乱码
- 原因：响应头未指定编码，默认 UTF-8

**解决**：
```typescript
async function fetchWithEncoding(url: string, encoding: string = "utf-8"): Promise<string> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  
  const decoder = new TextDecoder(encoding, { fatal: false });
  return decoder.decode(buffer);
}

// 使用
const html = await fetchWithEncoding("https://example.com", "gbk");
```

---

## 最佳实践

### 1. 平台特定处理

**原则**：不同平台使用不同的默认编码

**实施**：
```typescript
const defaultEncoding = process.platform === "win32" ? "gbk" : "utf-8";
```

### 2. 检测替换字符

**原则**：通过替换字符判断解码是否成功

**实施**：
```typescript
const text = decoder.decode(buffer);
if (!text.includes("\uFFFD")) {
  // 解码成功
}
```

### 3. 提供回退机制

**原则**：解码失败时要有备选方案

**实施**：
```typescript
try {
  return decodeWithPrimaryEncoding(buffer);
} catch {
  return decodeWithFallbackEncoding(buffer);
}
```

### 4. 配置化

**原则**：允许用户配置编码

**实施**：
```json
{
  "encoding": {
    "default": "auto",
    "stdout": "gbk",
    "stderr": "gbk",
    "files": "utf-8"
  }
}
```

---

## 调试检查清单

当遇到 Buffer 解码乱码时，按以下步骤检查：

- [ ] **确认数据类型**：是 Buffer 还是 string？
- [ ] **检查平台**：Windows、Linux、还是 macOS？
- [ ] **确认来源编码**：命令行输出、文件、HTTP 响应？
- [ ] **尝试不同编码**：UTF-8、GBK、GB2312、Big5
- [ ] **检查替换字符**：是否有 `\uFFFD`？
- [ ] **验证解码结果**：中文是否正确显示？
- [ ] **添加回退机制**：解码失败时的备选方案

---

## 常见错误模式

### 错误 1：假设所有 Buffer 都是 UTF-8

```typescript
// ❌ 错误
const text = buffer.toString();  // 默认 UTF-8

// ✅ 正确
const text = decodeBuffer(buffer);  // 智能检测编码
```

### 错误 2：不检查解码结果

```typescript
// ❌ 错误：不检查替换字符
const decoder = new TextDecoder("gbk");
const text = decoder.decode(buffer);
// 可能包含 \uFFFD

// ✅ 正确：检查替换字符
const decoder = new TextDecoder("gbk", { fatal: false });
const text = decoder.decode(buffer);
if (text.includes("\uFFFD")) {
  // 解码失败，尝试其他编码
}
```

### 错误 3：没有回退机制

```typescript
// ❌ 错误：只尝试一种编码
const decoder = new TextDecoder("gbk");
return decoder.decode(buffer);

// ✅ 正确：提供回退
try {
  const decoder = new TextDecoder("gbk", { fatal: false });
  const text = decoder.decode(buffer);
  if (!text.includes("\uFFFD")) return text;
} catch {}

// 回退到 UTF-8
const decoder = new TextDecoder("utf-8");
return decoder.decode(buffer);
```

---

## 相关问题

### 问题 1：如何检测 Buffer 的编码？

**方法 1：尝试不同编码**
```typescript
function detectEncoding(buffer: Buffer): string {
  const encodings = ["utf-8", "gbk", "gb2312", "big5"];
  
  for (const encoding of encodings) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: false });
      const text = decoder.decode(buffer);
      
      if (!text.includes("\uFFFD")) {
        return encoding;
      }
    } catch {}
  }
  
  return "utf-8";  // 默认
}
```

**方法 2：检查 BOM**
```typescript
function detectBOM(buffer: Buffer): string | null {
  if (buffer.length < 2) return null;
  
  // UTF-8 BOM: EF BB BF
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return "utf-8";
  }
  
  // UTF-16 LE BOM: FF FE
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return "utf-16le";
  }
  
  // UTF-16 BE BOM: FE FF
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return "utf-16be";
  }
  
  return null;
}
```

### 问题 2：如何处理混合编码？

**场景**：文件中部分内容是 UTF-8，部分是 GBK

**解决**：
```typescript
// 方案 1：分段解码
function decodeMixed(buffer: Buffer): string {
  // 尝试整体解码
  const utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  
  // 如果有替换字符，尝试分段解码
  if (utf8Text.includes("\uFFFD")) {
    // 实现分段解码逻辑...
  }
  
  return utf8Text;
}

// 方案 2：转换为统一编码
// 建议将所有文件转换为 UTF-8
```

### 问题 3：如何处理大文件？

**问题**：大文件一次性读取到内存可能导致内存溢出

**解决**：
```typescript
import fs from "node:fs";
import { Transform } from "node:stream";

class DecoderTransform extends Transform {
  private decoder: TextDecoder;
  
  constructor(encoding: string = "utf-8") {
    super();
    this.decoder = new TextDecoder(encoding, { fatal: false });
  }
  
  _transform(chunk: Buffer, encoding: string, callback: Function) {
    const text = this.decoder.decode(chunk, { stream: true });
    this.push(text);
    callback();
  }
  
  _flush(callback: Function) {
    const text = this.decoder.decode();  // 处理剩余数据
    if (text) this.push(text);
    callback();
  }
}

// 使用
const readStream = fs.createReadStream("large-file.txt");
const decoderStream = new DecoderTransform("gbk");

readStream.pipe(decoderStream).on("data", (text: string) => {
  console.log(text);
});
```

---

## 关键教训

1. **不要假设编码** - Buffer 不一定是 UTF-8
2. **平台差异** - Windows 默认 GBK，Linux/Mac 默认 UTF-8
3. **检测替换字符** - `\uFFFD` 表示解码失败
4. **提供回退机制** - 解码失败时要有备选方案
5. **配置化** - 允许用户配置编码
6. **流式处理** - 大文件使用流式解码

---

## 相关文档

- **read 工具编码支持**：`Runtimelog/tempfile/read工具编码支持完成_20260129.md`
- **exec 工具输出编码修复**：`Runtimelog/tempfile/exec工具输出编码修复_20260129.md`
- **中文文本文件编码问题**：`.kiro/lessons-learned/27_中文文本文件编码问题处理.md`
- **修改的代码**：`src/agents/bash-tools.exec.ts`

---

**版本：** v20260129_1  
**最后更新：** 2026-01-29  
**变更：** 新增 Buffer 解码编码问题处理规范
