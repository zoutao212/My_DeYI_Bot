---
name: "safe-file-editor"
displayName: "Safe File Editor"
description: "Safe editing engine for large files with auto-backup, atomic writes, diff preview, and batch operations. Supports precise replacement by line number, keyword, or anchor."
keywords: ["safe-file-editor", "large-file-edit", "precision-replace", "code-migration", "batch-edit"]
author: "Clawdbot"
---

# Safe File Editor

## Overview

SafeFileEditor 是一个面向大文件/受限文件的"外科手术式"编辑引擎。核心理念：先备份、可预览 Diff、再原子落盘。同时支持把几百/几千行代码块先提取、再原样粘贴到目标文件，避免 LLM 复写带来的细微差异。

适用场景：
- IDE 内置写入工具无法直接修改的大文件或受限文件
- 需要精确控制替换范围的重构/迁移任务
- 跨文件的大段代码块搬运（避免 LLM 重新生成导致差异）

## Onboarding

### Prerequisites

- Python 3.8+
- `diff-match-patch` 库（精确编辑功能需要）：`pip install diff-match-patch`

### Installation

将 skill 目录中的以下文件放到项目中任意位置（推荐 `.kiro/skills/safe_file_editor/`）：

- `safe_file_editor.py` — 核心库
- `precision_editor.py` — 基于 diff-match-patch 的精确编辑器
- `diff_visualizer.py` — Diff 可视化工具
- `quick_replace.py` — CLI 工具
- `__init__.py` — 包初始化

### Verification

```bash
python quick_replace.py info path/to/any/file.txt
```

应输出文件行数、行尾符类型等基础信息。

## Common Workflows

### Workflow 1: 按行号替换（最快最安全）

知道确切行号时的首选方式。

**Python API:**
```python
import sys
sys.path.insert(0, 'path/to/safe_file_editor')
from safe_file_editor import SafeFileEditor

editor = SafeFileEditor('path/to/file.cpp')
editor.replace_by_line_numbers(
    start_line=100,
    end_line=110,
    new_code="// Your new code here\n",
    verify_vars=['Variable1', 'Variable2'],
    require_confirmation=False
)
```

**CLI:**
```bash
# 小段内容直接传参
python quick_replace.py by-lines file.cpp 100 110 "new code" --verify-vars "X,Y" -y

# 大段内容从文件读取（推荐）
python quick_replace.py by-lines file.cpp 100 110 --code-file "block.txt" -y
```

### Workflow 2: 按关键字搜索替换

不确定行号时，用关键字+上下文收敛匹配范围。

**Python API:**
```python
editor.replace_by_keywords(
    primary_keyword='FString NetworkRoleStr',
    context_keywords=['PreMoveRotation', 'bMoveSuccess'],
    end_keyword='*DebugInfo',
    new_code="// replacement\n",
    verify_vars=['PreMoveRotation']
)
```

**CLI:**
```bash
python quick_replace.py by-keywords file.cpp "Keyword" \
    --context "Context1,Context2" \
    --end "EndKeyword" \
    --code-file "block.txt" \
    --verify-vars "X,Y" -y
```

### Workflow 3: 按锚点定位（最稳定，不依赖行号）

用前后文标记定位代码块，完全绕开行号漂移问题。

**替换:**
```python
editor.replace_by_anchor(
    before_pattern="# BEGIN SECTION",
    after_pattern="# END SECTION",
    new_code="# new content\n",
    include_anchors=False
)
```

**提取:**
```bash
python quick_replace.py extract-anchor file.py "# BEGIN" "# END" --out extracted.txt
```

**插入:**
```bash
python quick_replace.py insert-anchor file.py "# INSERT POINT" --code-file block.txt -y
```

**删除:**
```bash
python quick_replace.py delete-anchor file.py "# BEGIN" "# END" --non-interactive
```

### Workflow 4: 精确替换（v4.0，基于 diff-match-patch）

自动计算最小修改集，支持模糊匹配，三阶段验证。

```python
editor.replace_precisely(
    target_block="""void OldFunction() {
    // Old implementation
}""",
    replacement_block="""void NewFunction() {
    // New implementation
}""",
    require_confirmation=False
)
```

### Workflow 5: 大段代码块"复制/粘贴"迁移

跨文件搬运几百行代码块，不经过 LLM 重新生成。

```bash
# 1. 从源文件提取
python quick_replace.py extract-lines fileA.cpp 120 260 --out block.txt

# 2. 在目标文件插入
python quick_replace.py insert-anchor fileB.py "# INSERT HERE" --code-file block.txt -y

# 3. 从源文件删除原始块
python quick_replace.py delete-range fileA.cpp 120 260 -y
```

### Workflow 6: 批量操作（可回放）

用 JSON 定义操作列表，支持 dry-run 预览。

```bash
# 预览
python quick_replace.py apply-ops file.cpp ops.json --dry-run

# 执行
python quick_replace.py apply-ops file.cpp ops.json
```

ops.json 格式：
```json
[
  {"type": "replace_range", "start": 10, "end": 20, "new_code": "..."},
  {"type": "insert_after", "line": 30, "new_code": "..."},
  {"type": "delete_line", "line": 50}
]
```

支持的操作类型：`replace_line`, `replace_range`, `insert_after`, `insert_before`, `delete_line`, `append`。

## 重构/拆分大文件实战经验

### 行号漂移（Line Drift）

同一文件做了删块/插入后，旧行号立刻失效。

正确做法：
1. 先用搜索定位目标区块
2. 用 SafeFileEditor 执行一次操作
3. 执行后立刻再次搜索确认

### 拆分大文件的最短路径

1. `extract-lines` / `extract-anchor` 先导出代码块
2. 删除优先级：`delete-anchor` > `delete-keywords` > `delete-range`
3. 从底往上删，最大化减少行号漂移影响

### 删除代码块注意事项

- 用 `--code-file` 指向 0 字节空文件实现真正删除
- 不要用包含换行的 stub 作为删除内容

### 每步都要做"读后验证"

改完立刻 grep 关键字确认，必要时读几行上下文确认边界正确。

前端 JS 文件额外建议：执行 `node --check <file.js>` 拦截语法断裂。

### 工具报错快速判断

- `Invalid line range`：旧行号已失效，先重新定位
- `Found N matches`：关键字太宽，加 `context_keywords` 或更具体的 `end_keyword`

## 核心特性速查

| 特性 | 说明 |
|------|------|
| 自动备份 | `.bak_YYYYMMDD_HHMMSS` 时间戳备份 |
| 原子写入 | `.tmp` → `rename`，避免写一半崩溃 |
| Diff 预览 | `--dry-run` 输出 unified diff |
| 行尾符自动处理 | 自动检测 CRLF/LF 并统一 |
| 变量依赖检查 | `verify_vars` 参数验证上游变量存在 |
| 模糊匹配 | 关键字搜索支持归一化+相似度匹配 |
| 上下文管理器 | `with SafeFileEditor(...) as editor:` 失败自动恢复 |
| PowerShell 兼容 | 生成临时脚本避免特殊字符问题 |

## CLI 命令速查

| 命令 | 用途 |
|------|------|
| `info` | 输出文件基础信息 |
| `by-lines` | 按行号替换 |
| `by-keywords` | 按关键字替换 |
| `extract-lines` | 按行号提取代码块 |
| `extract-anchor` | 按锚点提取代码块 |
| `delete-range` | 按行号删除 |
| `delete-keywords` | 按关键字删除 |
| `delete-anchor` | 按锚点删除 |
| `insert-anchor` | 按锚点插入 |
| `apply-ops` | 应用 JSON 操作列表 |

## Best Practices

- 优先使用 `replace_by_line_numbers`，最快最安全
- 提供多个 `context_keywords` 减少误匹配
- 总是使用 `verify_vars` 防止编译错误
- 大段代码块永远优先 `--code-file`，避免命令行转义问题
- 脚本模式设置 `require_confirmation=False`
- 高频变动文件优先用 anchor/keywords，行号只作为最后手段
- 环境变量 `SAFEFILEEDITOR_QUIET=1` 可关闭大范围替换时的上下文输出

## Troubleshooting

### Error: "Invalid line range"
原因：使用了旧行号，文件已被前序操作修改
解决：重新搜索定位目标区块，获取最新行号

### Error: "Found N matches"
原因：关键字匹配范围太宽
解决：添加 `context_keywords` 或使用更具体的 `end_keyword`；也可用 `--pick N` 选择候选

### Error: "Could not find end of block"
原因：`end_keyword` 不在搜索范围内
解决：增大 `max_lines` 参数，或使用 `use_braces=True` 用大括号计数

### 文件编码问题
原因：文件不是 UTF-8 编码
解决：初始化时指定编码 `SafeFileEditor('file.cpp', encoding='gbk')`

---

**工具文件清单：**
- `safe_file_editor.py` — 核心库（~1280 行）
- `precision_editor.py` — 精确编辑器（~180 行）
- `diff_visualizer.py` — Diff 可视化（~180 行）
- `quick_replace.py` — CLI 工具（~280 行）
