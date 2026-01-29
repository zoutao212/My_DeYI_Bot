# read 工具编码支持

`read` 工具现在支持多种文本编码，可以正确读取非 UTF-8 编码的文件（如 GBK、GB2312 等）。

---

## 快速开始

### 自动检测编码（推荐）

```typescript
read({
  path: "文件.txt",
  encoding: "auto"  // 自动检测编码
})
```

### 指定编码

```typescript
// 读取 GBK 编码的文件
read({
  path: "文件.txt",
  encoding: "gbk"
})
```

---

## 支持的编码

| 编码 | 说明 | 使用场景 |
|------|------|----------|
| `utf-8` | UTF-8 编码 | 现代文本文件（默认） |
| `gbk` | 简体中文 GBK | 旧版 Windows 中文系统 |
| `gb2312` | 简体中文 GB2312 | 早期中文系统 |
| `big5` | 繁体中文 Big5 | 繁体中文系统 |
| `shift_jis` | 日文 Shift_JIS | 日文系统 |
| `auto` | 自动检测 | 不确定编码时使用 |

---

## 使用场景

### 场景 1：读取中文小说

很多中文小说文件使用 GBK 或 GB2312 编码：

```typescript
// 自动检测编码
read({
  path: "小说.txt",
  encoding: "auto"
})

// 或明确指定 GBK
read({
  path: "小说.txt",
  encoding: "gbk"
})
```

### 场景 2：读取旧系统导出的文件

旧版 Windows 系统导出的文件通常使用 GBK 编码：

```typescript
read({
  path: "导出数据.txt",
  encoding: "gbk"
})
```

### 场景 3：读取日文文件

```typescript
read({
  path: "日本語.txt",
  encoding: "shift_jis"
})
```

---

## 工作原理

### 编码检测

当使用 `encoding: "auto"` 时，工具会：

1. 尝试使用 UTF-8 解码
2. 如果失败，尝试 GBK
3. 如果失败，尝试 GB2312
4. 如果失败，尝试 Big5
5. 如果失败，尝试 Shift_JIS
6. 如果都失败，回退到 UTF-8

### 错误处理

如果指定的编码无法正确解码文件：

1. 显示警告信息
2. 回退到默认编码
3. 尽可能显示文件内容

**示例输出**：
```
⚠️ Warning: Failed to read with encoding utf-8: ...
Falling back to default encoding.

[文件内容]
```

---

## 最佳实践

### 1. 优先使用 auto

除非你确定文件编码，否则使用 `auto`：

```typescript
// ✅ 推荐
read({ path: "文件.txt", encoding: "auto" })

// ❌ 不推荐（除非确定编码）
read({ path: "文件.txt", encoding: "gbk" })
```

### 2. 转换为 UTF-8

如果经常读取非 UTF-8 文件，建议先转换为 UTF-8：

```powershell
# 使用 PowerShell 脚本转换
.\scripts\detect-and-convert-encoding.ps1 -FilePath "文件.txt"
```

### 3. 文件命名规范

对于编码敏感的文件，在文件名中标注编码：

```
原文件.txt          # 未知编码
原文件_gbk.txt      # GBK 编码
原文件_utf8.txt     # UTF-8 编码
```

---

## 常见问题

### Q: 为什么会出现乱码？

A: 文件使用非 UTF-8 编码，但工具默认使用 UTF-8 读取。解决方法：

```typescript
// 使用 auto 自动检测
read({ path: "文件.txt", encoding: "auto" })
```

### Q: 如何知道文件使用什么编码？

A: 使用 `auto` 让工具自动检测，或使用 PowerShell 脚本：

```powershell
.\scripts\detect-and-convert-encoding.ps1 -FilePath "文件.txt"
```

### Q: 编码检测不准确怎么办？

A: 手动指定编码：

```typescript
// 尝试不同编码
read({ path: "文件.txt", encoding: "gbk" })
read({ path: "文件.txt", encoding: "gb2312" })
read({ path: "文件.txt", encoding: "big5" })
```

### Q: 是否支持二进制文件？

A: 编码参数只对文本文件有效。二进制文件（图片、视频等）会使用默认读取方式。

---

## 技术细节

### 编码检测算法

```typescript
async function detectTextEncoding(filePath: string): Promise<string> {
  const encodings = ["utf-8", "gbk", "gb2312", "big5", "shift_jis"];
  const buffer = await fs.promises.readFile(filePath);
  
  for (const encoding of encodings) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: true });
      const text = decoder.decode(buffer);
      
      // Check for replacement characters
      if (!text.includes("\uFFFD")) {
        return encoding;
      }
    } catch {
      continue;
    }
  }
  
  return "utf-8";
}
```

### 支持的文件类型

编码参数对以下文件类型有效：

- `.txt` - 文本文件
- `.md` - Markdown 文件
- `.json` - JSON 文件
- `.xml` - XML 文件
- `.html` - HTML 文件
- `.css` - CSS 文件
- `.js` / `.ts` - JavaScript/TypeScript 文件
- `.py` - Python 文件
- `.java` - Java 文件
- `.c` / `.cpp` / `.h` / `.hpp` - C/C++ 文件
- `.sh` / `.bat` / `.ps1` - 脚本文件
- `.yaml` / `.yml` - YAML 文件
- `.toml` - TOML 文件
- `.ini` / `.cfg` / `.conf` - 配置文件
- `.log` - 日志文件

---

## 相关工具

### 编码转换脚本

使用 PowerShell 脚本转换文件编码：

```powershell
# 检测并转换为 UTF-8
.\scripts\detect-and-convert-encoding.ps1 -FilePath "文件.txt"

# 覆盖原文件
.\scripts\detect-and-convert-encoding.ps1 -FilePath "文件.txt" -Overwrite

# 添加 BOM
.\scripts\detect-and-convert-encoding.ps1 -FilePath "文件.txt" -WithBOM
```

### 批量转换

```powershell
# 转换当前目录下的所有 .txt 文件
Get-ChildItem -Path . -Filter "*.txt" | ForEach-Object {
    .\scripts\detect-and-convert-encoding.ps1 -FilePath $_.FullName
}
```

---

## 参考资料

- [中文文本文件编码问题处理](.kiro/lessons-learned/27_中文文本文件编码问题处理.md)
- [编码转换脚本](scripts/detect-and-convert-encoding.ps1)
- [read 工具实现](src/agents/pi-tools.read.ts)

---

**版本：** v20260129_1  
**最后更新：** 2026-01-29
