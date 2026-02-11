---
name: safe-file-editor
description: 大型文件安全编辑工具：自动备份+原子写入+Diff预览，支持按行号/关键字/锚点精确替换，适用于修改本地记忆文件、规则文件、配置文件等场景。
metadata: {"clawdbot":{"emoji":"🔧","os":["win32","darwin","linux"],"always":true}}
---

# SafeFileEditor

大型文件/规则文件的"外科手术式"编辑引擎：先备份、可预览 Diff、再原子落盘。

## 核心能力

- **安全性**：自动创建时间戳备份 + 原子写入
- **可定位**：按行号 / 关键字 / 锚点定位并替换
- **可搬运**：`extract-*` + `--code-file` 实现大段代码块迁移
- **可回放**：操作列表可用 JSON 记录并重复执行

## 快速开始

工具位置：`skills/safe-file-editor/`

```bash
# 查看文件信息
python skills/safe-file-editor/quick_replace.py info <file>

# 按行号替换
python skills/safe-file-editor/quick_replace.py by-lines <file> <start> <end> "new code" -y

# 按行号替换（从文件读取新代码，推荐用于大段内容）
python skills/safe-file-editor/quick_replace.py by-lines <file> <start> <end> --code-file <code.txt> -y

# 按关键字替换
python skills/safe-file-editor/quick_replace.py by-keywords <file> "主关键字" \
    --context "上下文1,上下文2" \
    --end "结束关键字" \
    --code "new code" -y

# 按锚点插入
python skills/safe-file-editor/quick_replace.py insert-anchor <file> "锚点文本" --code "new code" -y

# 按锚点删除
python skills/safe-file-editor/quick_replace.py delete-anchor <file> "开始锚点" "结束锚点" --non-interactive

# 提取代码块到文件
python skills/safe-file-editor/quick_replace.py extract-lines <file> <start> <end> --out <output.txt>

# 删除代码块
python skills/safe-file-editor/quick_replace.py delete-range <file> <start> <end> -y
```

## 典型场景

### 1. 修改本地记忆/规则文件

```bash
# 替换 .kiro/steering/ 下的规则文件某段内容
python skills/safe-file-editor/quick_replace.py by-lines \
    ".kiro/steering/always/work_style.md" 10 20 \
    "新的规则内容\n" -y
```

### 2. 按锚点定位修改（推荐，不依赖行号）

```bash
# 在 "## 核心信条" 后插入新内容
python skills/safe-file-editor/quick_replace.py insert-anchor \
    ".kiro/steering/always/lina-soul.md" \
    "## 核心信条" \
    --code "- **新增信条**：xxx\n" -y
```

### 3. 大段代码迁移

```bash
# 1. 提取源文件代码块
python skills/safe-file-editor/quick_replace.py extract-lines \
    src/old-file.ts 100 200 --out temp/block.txt

# 2. 插入到目标文件
python skills/safe-file-editor/quick_replace.py insert-anchor \
    src/new-file.ts "// INSERT HERE" \
    --code-file temp/block.txt -y

# 3. 删除源文件代码块
python skills/safe-file-editor/quick_replace.py delete-range \
    src/old-file.ts 100 200 -y
```

## 命令参考

| 命令 | 用途 |
|------|------|
| `info` | 查看文件行数、行尾符等信息 |
| `by-lines` | 按行号替换 |
| `by-keywords` | 按关键字搜索替换 |
| `extract-lines` | 按行号提取代码块 |
| `extract-anchor` | 按锚点提取代码块 |
| `insert-anchor` | 在锚点位置插入代码 |
| `delete-range` | 按行号删除 |
| `delete-anchor` | 按锚点删除 |
| `delete-keywords` | 按关键字删除 |
| `apply-ops` | 应用 JSON 操作列表 |

## 常用参数

- `-y` / `--yes` / `--non-interactive`：跳过确认
- `--code-file <path>`：从文件读取新代码（推荐用于大段内容）
- `--out <path>`：输出到文件
- `--clamp`：行号越界时自动夹取到合法范围
- `--end-exclusive`：end 行号为排他式（不包含）
- `--pick <N>`：多个匹配时选择第 N 个（0-based）

## 注意事项

1. 工具会自动创建 `.bak_YYYYMMDD_HHMMSS` 备份
2. 优先使用锚点定位（`*-anchor` 命令），避免行号漂移问题
3. 大段代码用 `--code-file` 而非命令行参数，避免转义问题
