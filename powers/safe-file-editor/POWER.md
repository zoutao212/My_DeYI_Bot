---
name: "safe-file-editor"
displayName: "Safe File Editor"
description: "安全编辑大型文件和配置文件的工具使用指南，支持自动备份、Diff 预览、精确替换，避免格式错乱和数据丢失"
keywords: ["file", "editor", "backup", "diff", "replace", "safe", "configuration"]
author: "Clawdbot Team"
---

# Safe File Editor

## 概述

Safe File Editor 是一个专门用于安全编辑大型文件和配置文件的 Python 工具。本 Power 提供完整的使用指南和最佳实践。

**核心特性**：
- **自动备份**：每次修改前自动创建时间戳备份
- **Diff 预览**：修改前可以预览差异
- **精确替换**：支持按行号、关键字、锚点定位
- **原子写入**：避免写入中断导致文件损坏
- **格式保护**：自动检测并保持行尾符（CRLF/LF）

## Available Steering Files

- **editing-config-files.md** - 编辑配置文件的详细工作流指南（5 步流程 + 完整示例）

## 工具位置

Safe File Editor 的 Python 工具位于项目的 Skill 目录：

```
.kiro/skills/safe_file_editor/
├── safe_file_editor.py      # Python API 主类
├── quick_replace.py          # CLI 快速替换工具
├── precision_editor.py       # 精确编辑器（v4.0）
└── diff_visualizer.py        # Diff 可视化工具
```

## 为什么需要这个工具？

### 问题场景

1. **IDE 工具限制**：某些文件（如工作区外的配置文件）无法直接编辑
   - 例如：`C:\Users\zouta\.clawdbot\clawdbot.json`
   
2. **格式错乱风险**：直接修改 JSON/YAML 配置文件容易导致格式错误
   - 缺少逗号、引号不匹配、缩进错误
   
3. **大文件编辑**：大型文件（>1000 行）修改容易出错
   - 难以定位、容易误改
   
4. **无法回滚**：修改后发现错误，难以恢复原始内容

### 解决方案

Safe File Editor 提供：
- 自动备份机制（`.bak_YYYYMMDD_HHMMSS`）
- 修改前 Diff 预览
- 精确的行号/关键字定位
- 原子写入保证

## 使用方法

### Python API（推荐）

```python
import sys
sys.path.insert(0, '.kiro/skills/safe_file_editor')
from safe_file_editor import SafeFileEditor

# 创建编辑器实例
editor = SafeFileEditor('path/to/file.json')

# 方法 1: 按行号替换（最精确）
editor.replace_by_line_numbers(
    start_line=10,
    end_line=15,
    new_code='  "new_config": "value"\n',
    verify_vars=['config', 'value'],  # 验证关键词
    require_confirmation=True  # 需要确认
)

# 方法 2: 按关键字替换（更灵活）
editor.replace_by_keywords(
    primary_keyword='agents.defaults.workspace',
    context_keywords=['agents', 'defaults'],
    end_keyword='}',
    new_code='  "workspace": "D:\\\\Git_GitHub\\\\clawdbot"\n',
    verify_vars=['workspace'],
    require_confirmation=True
)

# 方法 3: 精确替换（v4.0 新功能）
editor.replace_precisely(
    target_block='''  "workspace": "C:\\\\Users\\\\zouta\\\\clawd"''',
    replacement_block='''  "workspace": "D:\\\\Git_GitHub\\\\clawdbot"'''
)
```

### CLI 工具

```bash
# 按行号替换
python .kiro/skills/safe_file_editor/quick_replace.py by-lines \
    file.json 10 15 "new content" --verify-vars "key1,key2" -y

# 按关键字替换
python .kiro/skills/safe_file_editor/quick_replace.py by-keywords \
    file.json "primary_keyword" \
    --context "context1,context2" \
    --end "end_keyword" \
    --code "new content" \
    --verify-vars "key1,key2" -y

# 从文件读取新内容（推荐用于大段内容）
python .kiro/skills/safe_file_editor/quick_replace.py by-lines \
    file.json 10 15 --code-file "new_content.txt" -y

# 提取代码块
python .kiro/skills/safe_file_editor/quick_replace.py extract-lines \
    file.json 10 15 --out "extracted.txt"

# 删除代码块
python .kiro/skills/safe_file_editor/quick_replace.py delete-range \
    file.json 10 15 -y
```

## 常见使用场景

### 场景 1: 修改工作区外的配置文件

**问题**：需要修改 `C:\Users\zouta\.clawdbot\clawdbot.json`，但 IDE 无法直接编辑

**解决方案**：

```python
import sys
sys.path.insert(0, '.kiro/skills/safe_file_editor')
from safe_file_editor import SafeFileEditor

# 1. 读取文件，查看行号
editor = SafeFileEditor('C:\\Users\\zouta\\.clawdbot\\clawdbot.json')
print(f"Total lines: {len(editor.lines)}")

# 2. 定位要修改的行（假设在第 5-7 行）
for i, line in enumerate(editor.lines[4:7], start=5):
    print(f"{i}: {line}")

# 3. 精确替换
editor.replace_by_line_numbers(
    start_line=5,
    end_line=7,
    new_code='    "workspace": "D:\\\\Git_GitHub\\\\clawdbot",\n',
    verify_vars=['workspace'],
    require_confirmation=True
)
```

### 场景 2: 修改 JSON 配置（避免格式错乱）

**问题**：直接修改 JSON 容易导致格式错乱（缺少逗号、引号不匹配等）

**解决方案**：

```python
import sys
import json
sys.path.insert(0, '.kiro/skills/safe_file_editor')
from safe_file_editor import SafeFileEditor

# 1. 读取并解析 JSON
with open('config.json', 'r', encoding='utf-8') as f:
    config = json.load(f)

# 2. 修改配置
config['agents']['defaults']['workspace'] = 'D:\\Git_GitHub\\clawdbot'

# 3. 格式化 JSON
new_content = json.dumps(config, indent=2, ensure_ascii=False)

# 4. 使用 SafeFileEditor 写入（自动备份）
editor = SafeFileEditor('config.json')
with open('config.json', 'w', encoding='utf-8') as f:
    f.write(new_content)
```

### 场景 3: 批量修改多个位置

**问题**：需要在同一个文件中修改多个位置

**解决方案**：

```python
import sys
sys.path.insert(0, '.kiro/skills/safe_file_editor')
from safe_file_editor import SafeFileEditor

editor = SafeFileEditor('config.json')

# 批量操作（自动处理行号偏移）
operations = [
    {
        'type': 'replace_by_line_numbers',
        'start_line': 10,
        'end_line': 12,
        'new_code': '  "config1": "value1"\n'
    },
    {
        'type': 'replace_by_line_numbers',
        'start_line': 20,
        'end_line': 22,
        'new_code': '  "config2": "value2"\n'
    }
]

# 执行批量操作
for op in operations:
    editor.replace_by_line_numbers(
        start_line=op['start_line'],
        end_line=op['end_line'],
        new_code=op['new_code'],
        require_confirmation=False
    )
```

## 最佳实践

### 1. 修改前先备份

Safe File Editor 会自动创建备份，但建议手动确认：

```python
import shutil
from datetime import datetime

# 手动备份
timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy('config.json', f'config.json.manual_backup_{timestamp}')

# 然后使用 SafeFileEditor
editor = SafeFileEditor('config.json')
# ... 进行修改
```

### 2. 使用 Diff 预览

修改前先预览差异：

```python
editor = SafeFileEditor('config.json')

# 预览模式（不实际修改）
editor.replace_by_line_numbers(
    start_line=10,
    end_line=15,
    new_code='new content',
    require_confirmation=True  # 会显示 Diff
)
```

### 3. 验证关键词

使用 `verify_vars` 确保修改的是正确的位置：

```python
editor.replace_by_line_numbers(
    start_line=10,
    end_line=15,
    new_code='new content',
    verify_vars=['workspace', 'agents', 'defaults']  # 必须包含这些关键词
)
```

### 4. 使用 PowerShell 验证

修改后用 PowerShell 验证：

```powershell
# 读取文件
Get-Content "config.json" -Raw -Encoding UTF8

# 验证 JSON 格式
$config = Get-Content "config.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$config.agents.defaults.workspace
```

## 故障排除

### 问题 1: 文件被锁定

**错误**：`PermissionError: [Errno 13] Permission denied`

**解决方案**：
1. 关闭正在使用该文件的程序
2. 以管理员权限运行
3. 检查文件是否为只读

### 问题 2: 编码问题

**错误**：`UnicodeDecodeError`

**解决方案**：
```python
# 指定编码
editor = SafeFileEditor('file.txt', encoding='utf-8')
```

### 问题 3: 行号不匹配

**错误**：修改后发现行号对不上

**解决方案**：
1. 使用 `info` 命令查看文件信息
2. 使用关键字定位而不是行号
3. 使用精确替换（`replace_precisely`）

### 问题 4: 备份文件过多

**解决方案**：
```bash
# 清理旧备份（保留最近 5 个）
ls -t *.bak_* | tail -n +6 | xargs rm
```

## 与 IDE 工具的对比

| 功能 | IDE 工具 | Safe File Editor |
|------|----------|------------------|
| 编辑工作区内文件 | ✅ 推荐 | ✅ 可用 |
| 编辑工作区外文件 | ❌ 受限 | ✅ 推荐 |
| 自动备份 | ❌ 无 | ✅ 自动 |
| Diff 预览 | ✅ 有 | ✅ 有 |
| 精确定位 | ✅ 有 | ✅ 有 |
| 批量操作 | ❌ 困难 | ✅ 简单 |
| 格式保护 | ⚠️ 依赖插件 | ✅ 自动 |

## 配置

### 环境要求

- Python 3.7+
- 依赖库：无（纯 Python 标准库）

### 工具位置

工具已包含在项目的 Skill 目录中：

```
.kiro/skills/safe_file_editor/
├── safe_file_editor.py      # Python API 主类
├── quick_replace.py          # CLI 快速替换工具
├── precision_editor.py       # 精确编辑器（v4.0）
├── diff_visualizer.py        # Diff 可视化工具
└── SKILL.md                  # 完整文档
```

### 验证安装

```bash
# 验证工具可用
python .kiro/skills/safe_file_editor/quick_replace.py --help
```

## 参考资料

- **工作流指南**：`steering/editing-config-files.md`（详细的 5 步工作流程）
- **完整文档**：`.kiro/skills/safe_file_editor/SKILL.md`
- **源代码**：`.kiro/skills/safe_file_editor/safe_file_editor.py`
- **CLI 工具**：`.kiro/skills/safe_file_editor/quick_replace.py`

## 版本历史

- **v4.0** (2025-12): 精确替换、字符级 Diff、三阶段验证
- **v3.0**: 行尾符自动处理、锚点定位、批量操作 API
- **v2.0**: 关键字定位、验证变量
- **v1.0**: 基础行号替换、自动备份

---

**最后更新**: 2026-01-29  
**维护者**: Clawdbot Team
