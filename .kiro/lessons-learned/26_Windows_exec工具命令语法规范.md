# Windows exec 工具命令语法规范

> **背景**：Windows 平台 `exec` 工具默认使用 PowerShell 执行命令，导致 CMD 命令报错和中文路径乱码

---

## 问题现象

### 典型错误

```
Get-ChildItem : 找不到接受实际参数"C:\Users\zouta\clawd\*.txt"的位置形参。
所在位置 行:1 字符: 1
+ dir /s /b C:\Users\zouta\clawd\*.txt
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

### 错误特征

- 用户输入 CMD 命令（例如 `dir /s /b`）
- 系统报错提示 `Get-ChildItem`（PowerShell 命令）
- 路径中的中文字符显示为乱码
- 参数格式不兼容（`/s /b` vs `-Recurse -File`）

---

## 根本原因

### 系统设计选择

`src/agents/shell-utils.ts` 中的 `getShellConfig()` 函数：

```typescript
export function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    // Use PowerShell instead of cmd.exe on Windows.
    // Problem: Many Windows system utilities (ipconfig, systeminfo, etc.) write
    // directly to the console via WriteConsole API, bypassing stdout pipes.
    // When Node.js spawns cmd.exe with piped stdio, these utilities produce no output.
    // PowerShell properly captures and redirects their output to stdout.
    return {
      shell: resolvePowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command"],
    };
  }
  // ...
}
```

**设计原因**：
- Windows CMD 的很多工具（`ipconfig`、`systeminfo` 等）直接写入控制台（WriteConsole API）
- 绕过 stdout 管道，导致 Node.js 无法捕获输出
- PowerShell 能正确捕获和重定向这些工具的输出

### 问题链条

```
用户输入 CMD 命令
  ↓
系统使用 PowerShell 执行
  ↓
PowerShell 尝试解析 CMD 命令
  ↓
参数格式不兼容 + 中文编码错误
  ↓
报错
```

---

## 解决方案

### 方案 1：使用 PowerShell 命令（推荐）

**原则**：在 Windows 平台使用 `exec` 工具时，使用 PowerShell 命令语法。

#### 常用命令对照表

| 功能 | CMD 命令 | PowerShell 命令（推荐） |
|------|----------|------------------------|
| 列出目录 | `dir` | `Get-ChildItem` 或 `ls` |
| 递归查找文件 | `dir /s /b *.txt` | `Get-ChildItem -Path "." -Filter "*.txt" -Recurse -File \| Select-Object -ExpandProperty FullName` |
| 搜索文件内容 | `findstr /s "关键词" *.txt` | `Select-String -Path "*.txt" -Pattern "关键词" -Encoding UTF8` |
| 切换目录 | `cd /d C:\path` | `Set-Location -Path "C:\path"` |
| 创建目录 | `mkdir dir` | `New-Item -ItemType Directory -Path "dir"` |
| 删除文件 | `del file.txt` | `Remove-Item -Path "file.txt"` |
| 复制文件 | `copy src dst` | `Copy-Item -Path "src" -Destination "dst"` |
| 查看文件内容 | `type file.txt` | `Get-Content -Path "file.txt" -Encoding UTF8` |

#### 示例

```powershell
# ✅ 正确：使用 PowerShell 命令
Get-ChildItem -Path "C:\Users\zouta\clawd" -Filter "*.txt" -Recurse -File | Select-Object -ExpandProperty FullName

# ✅ 正确：使用 PowerShell 别名
ls -Path "C:\Users\zouta\clawd" -Filter "*.txt" -Recurse -File

# ❌ 错误：使用 CMD 命令
dir /s /b C:\Users\zouta\clawd\*.txt
```

### 方案 2：强制使用 CMD（不推荐）

如果必须使用 CMD 命令，在命令前加 `cmd /c` 前缀：

```powershell
# ✅ 可行：强制使用 CMD
cmd /c "dir /s /b C:\Users\zouta\clawd\*.txt"

# ⚠️ 注意：需要用引号包裹整个命令
cmd /c "cd /d C:\path && dir"
```

**缺点**：
- 仍然可能有编码问题
- 输出捕获可能不完整（某些工具绕过 stdout）
- 不推荐作为长期方案

---

## 最佳实践

### 1. 优先使用 PowerShell 命令

**原因**：
- 避免编码问题
- 避免参数兼容性问题
- 输出捕获更可靠
- 功能更强大（管道、对象操作）

### 2. 处理中文路径

**推荐做法**：
```powershell
# ✅ 使用引号包裹路径
Get-ChildItem -Path "C:\Users\用户名\文件夹" -Encoding UTF8

# ✅ 使用 -LiteralPath 避免通配符问题
Set-Location -LiteralPath "C:\Users\用户名\文件夹"
```

**避免做法**：
```powershell
# ❌ 不要混用 CMD 和 PowerShell 语法
dir /s C:\Users\用户名\文件夹
```

### 3. 处理特殊字符

**推荐做法**：
```powershell
# ✅ 使用单引号避免变量展开
Get-Content -Path 'C:\path\$file.txt'

# ✅ 使用转义字符
Get-Content -Path "C:\path\`$file.txt"
```

### 4. 处理长命令

**推荐做法**：
```powershell
# ✅ 使用反引号换行
Get-ChildItem -Path "C:\path" `
  -Filter "*.txt" `
  -Recurse `
  -File

# ✅ 使用管道分步处理
Get-ChildItem -Path "C:\path" -Filter "*.txt" -Recurse -File |
  Where-Object { $_.Length -gt 1KB } |
  Select-Object -ExpandProperty FullName
```

---

## 调试检查清单

当 `exec` 工具报错时，按以下步骤检查：

- [ ] **确认平台**：是否在 Windows 平台？
- [ ] **确认命令语法**：是 CMD 命令还是 PowerShell 命令？
- [ ] **确认路径编码**：路径中是否有中文字符？
- [ ] **确认参数格式**：参数是否符合 PowerShell 语法？
- [ ] **尝试方案 1**：改用 PowerShell 命令
- [ ] **尝试方案 2**：如果必须用 CMD，加 `cmd /c` 前缀

---

## 常见错误模式

### 错误 1：混用 CMD 和 PowerShell 语法

```powershell
# ❌ 错误：dir 是 CMD 命令，但参数是 PowerShell 格式
dir -Recurse -Filter "*.txt"

# ✅ 正确：统一使用 PowerShell
Get-ChildItem -Recurse -Filter "*.txt"
```

### 错误 2：忘记引号包裹路径

```powershell
# ❌ 错误：路径中有空格或中文，但没有引号
Get-ChildItem -Path C:\Program Files\app

# ✅ 正确：使用引号
Get-ChildItem -Path "C:\Program Files\app"
```

### 错误 3：使用 CMD 的路径分隔符

```powershell
# ❌ 错误：使用 / 作为路径分隔符（CMD 风格）
Get-ChildItem -Path "C:/Users/zouta"

# ✅ 正确：使用 \ 作为路径分隔符（Windows 标准）
Get-ChildItem -Path "C:\Users\zouta"

# ✅ 也可以：PowerShell 支持 / 但推荐使用 \
Get-ChildItem -Path "C:/Users/zouta"  # 可行但不推荐
```

---

## 关键教训

1. **这不是 BUG，是设计选择** - 系统默认使用 PowerShell 是为了解决 CMD 的输出捕获问题
2. **统一命令语法** - 在 Windows 平台使用 PowerShell 命令，避免混用
3. **注意编码问题** - 中文路径必须用引号包裹，指定 UTF8 编码
4. **理解设计意图** - 了解为什么这样设计，才能正确使用

---

## 相关文件

- **Shell 配置**：`src/agents/shell-utils.ts` - `getShellConfig()` 函数
- **Exec 工具**：`src/agents/bash-tools.exec.ts` - exec 工具实现
- **编码处理**：`src/agents/shell-utils.ts` - `sanitizeBinaryOutput()` 函数

---

**版本：** v20260129_1  
**最后更新：** 2026-01-29  
**变更：** 新增 Windows exec 工具命令语法规范
