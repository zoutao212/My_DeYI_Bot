**版本：** v20260129_3
**最后更新：** 2026-01-29
**变更：** 新增配置项验证方法论


---

## Kiro Power 创建规范 ⚠️ 极其重要

### 触发场景
创建或修复 Kiro Power 时。

### 核心规则

#### 1. 文件限制（严格）

**允许的文件**：
- ✅ `POWER.md`（必需）
- ✅ `mcp.json`（Guided MCP Power 需要）
- ✅ `steering/*.md`（可选）

**不允许的文件**：
- ❌ Python 脚本（`.py`）
- ❌ 二进制文件（`.pyc`、`.exe`、`.so`）
- ❌ 隐藏文件（`.git`、`.DS_Store`）
- ❌ 凭证文件（`.env`、`credentials.json`）
- ❌ 压缩包（`.zip`、`.tar.gz`）
- ❌ README.md（不是标准 Power 文件）

**原因**：
- Powers 是文档和配置，不是代码分发工具
- 安全考虑：避免执行不受信任的代码
- 简化管理：只需要管理文档和 MCP 配置

#### 2. POWER.md Frontmatter 格式（严格）

**必须**：
- Frontmatter 必须在文件**最开头**（第一行）
- 格式：`---\n...\n---`
- 不能有任何内容在 frontmatter 之前（包括标题、注释）

**错误示例**：
```markdown
# Safe File Editor

---
name: "safe-file-editor"
...
---
```

**正确示例**：
```markdown
---
name: "safe-file-editor"
displayName: "Safe File Editor"
description: "..."
keywords: [...]
author: "..."
---

# Safe File Editor
```

**必需字段**：
- `name`（必需）：lowercase kebab-case
- `displayName`（必需）：human-readable title
- `description`（必需）：clear, concise (max 3 sentences)

**可选字段**：
- `keywords`（推荐）：array of search terms
- `author`（推荐）：creator name or organization

**不存在的字段**（不要使用）：
- ❌ `version`
- ❌ `tags`
- ❌ `repository`
- ❌ `license`

#### 3. Power 与 Skill 的分工

**Power（说明书）**：
- 📖 提供使用指南和最佳实践
- 🔧 配置 MCP 服务器（如果需要）
- 📋 提供工作流文档
- ❌ 不包含代码

**Skill（工具箱）**：
- 🛠️ 包含实际的工具代码
- 📦 提供可执行的脚本
- 🔌 提供 Python/JavaScript 库
- 📍 位置：`.kiro/skills/`

**正确做法**：
- 代码放在 Skill 目录（`.kiro/skills/`）
- Power 提供使用指南，指向 Skill 目录
- Power 是"说明书"，Skill 是"工具箱"

**示例**：
```markdown
## 工具位置

Safe File Editor 的 Python 工具位于项目的 Skill 目录：

```
.kiro/skills/safe_file_editor/
├── safe_file_editor.py      # Python API 主类
├── quick_replace.py          # CLI 快速替换工具
└── SKILL.md                  # 完整文档
```

## 使用方法

```python
import sys
sys.path.insert(0, '.kiro/skills/safe_file_editor')
from safe_file_editor import SafeFileEditor
```
```

#### 4. Power 类型选择

**Guided MCP Power**：
- 包含 MCP 服务器配置（`mcp.json`）
- 提供 MCP 工具的使用指南
- 示例：git MCP、Supabase MCP

**Knowledge Base Power**：
- 纯文档，无 MCP 配置
- 提供工具使用指南、最佳实践、工作流
- 示例：CLI 工具指南、最佳实践文档

### 验证清单

创建 Power 后，必须验证：

- ✅ POWER.md frontmatter 在文件开头
- ✅ POWER.md 包含所有必需字段
- ✅ 只包含允许的文件（POWER.md + mcp.json + steering/*.md）
- ✅ 没有 Python 文件
- ✅ 没有二进制文件
- ✅ 没有隐藏文件
- ✅ 如果包含代码引用，指向正确的 Skill 目录

### 常见错误

#### 错误 1：包含 Python 代码

**错误**：
```
powers/my-power/
├── POWER.md
└── python/
    └── tool.py  ❌ 不允许
```

**正确**：
```
powers/my-power/
└── POWER.md  ✅ 指向 .kiro/skills/my-tool/

.kiro/skills/my-tool/
└── tool.py  ✅ 代码放在 Skill 目录
```

#### 错误 2：Frontmatter 不在开头

**错误**：
```markdown
# My Power  ❌ 标题在 frontmatter 之前

---
name: "my-power"
---
```

**正确**：
```markdown
---
name: "my-power"
---

# My Power  ✅ 标题在 frontmatter 之后
```

#### 错误 3：使用不存在的字段

**错误**：
```yaml
---
name: "my-power"
version: "1.0.0"  ❌ 不存在的字段
repository: "..."  ❌ 不存在的字段
---
```

**正确**：
```yaml
---
name: "my-power"
displayName: "My Power"
description: "..."
keywords: [...]
author: "..."
---
```

### 调试方法

#### 1. 验证 Frontmatter 格式

```powershell
# 读取文件前 10 行
Get-Content "powers/my-power/POWER.md" -Head 10 -Encoding UTF8

# 检查是否以 --- 开头
$content = Get-Content "powers/my-power/POWER.md" -Raw -Encoding UTF8
if ($content -match '^---\n') {
    Write-Host "✅ Frontmatter 格式正确"
} else {
    Write-Host "❌ Frontmatter 格式错误"
}
```

#### 2. 检查不允许的文件

```powershell
# 检查 Python 文件
Get-ChildItem "powers/my-power" -Recurse -Filter "*.py"

# 检查二进制文件
Get-ChildItem "powers/my-power" -Recurse -Filter "*.pyc"

# 检查隐藏文件
Get-ChildItem "powers/my-power" -Recurse -Force | Where-Object { $_.Name -like ".*" }
```

#### 3. 验证 Power 结构

```powershell
# 列出所有文件
Get-ChildItem "powers/my-power" -Recurse | ForEach-Object {
    $relativePath = $_.FullName.Replace((Get-Location).Path + "\", "")
    Write-Host $relativePath
}
```

### 参考资料

- **power-builder Power**：完整的 Power 创建指南
- **power-builder interactive.md**：交互式创建流程
- **power-builder testing.md**：测试和验证指南

---

**版本：** v20260129_4  
**最后更新：** 2026-01-29  
**变更：** 新增 Kiro Power 创建规范
