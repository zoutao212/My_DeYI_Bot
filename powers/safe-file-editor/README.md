# Safe File Editor Power

安全编辑大型文件和配置文件的 Python 工具集。

## 快速开始

### 1. 激活 Power

```javascript
kiroPowers.activate("safe-file-editor")
```

### 2. 使用 Python API

```python
import sys
import os

# 添加 Power Python 路径
power_dir = os.path.join(os.getcwd(), 'powers', 'safe-file-editor', 'python')
sys.path.insert(0, power_dir)

from safe_file_editor import SafeFileEditor

# 创建编辑器
editor = SafeFileEditor('config.json')

# 按行号替换
editor.replace_by_line_numbers(
    start_line=10,
    end_line=15,
    new_code='new content',
    verify_vars=['key1', 'key2'],
    require_confirmation=True
)
```

### 3. 使用 CLI 工具

```bash
# 按行号替换
python powers/safe-file-editor/python/quick_replace.py by-lines \
    file.json 10 15 "new content" --verify-vars "key1,key2" -y

# 查看帮助
python powers/safe-file-editor/python/quick_replace.py --help
```

## 文件结构

```
powers/safe-file-editor/
├── POWER.md                              # 主文档
├── README.md                             # 本文件
├── test_power.py                         # 测试脚本
├── python/                               # Python 工具
│   ├── safe_file_editor.py              # 主类
│   ├── quick_replace.py                 # CLI 工具
│   ├── precision_editor.py              # 精确编辑器
│   └── diff_visualizer.py               # Diff 可视化
└── steering/                             # 工作流指南
    └── editing-config-files.md          # 编辑配置文件指南
```

## 测试

运行测试脚本验证 Power 是否正确安装：

```bash
python powers/safe-file-editor/test_power.py
```

## 文档

- **主文档**: `POWER.md` - 完整的使用指南
- **工作流指南**: `steering/editing-config-files.md` - 详细的工作流程

## 核心特性

- ✅ 自动备份（`.bak_YYYYMMDD_HHMMSS`）
- ✅ Diff 预览
- ✅ 精确替换（行号/关键字/锚点）
- ✅ 原子写入
- ✅ 格式保护（CRLF/LF）

## 常见问题

### Q: 如何编辑工作区外的配置文件？

A: 使用 Safe File Editor 可以安全编辑任何文件，包括工作区外的配置文件。参见 `POWER.md` 中的"场景 1"。

### Q: 如何避免 JSON 格式错乱？

A: 使用 Python 的 `json` 模块解析和格式化，然后用 Safe File Editor 写入。参见 `POWER.md` 中的"场景 2"。

### Q: 如何验证修改是否正确？

A: 使用 PowerShell 交叉验证：

```powershell
$config = Get-Content "config.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$config.key
```

## 支持

- **问题反馈**: 查看 `POWER.md` 中的"故障排除"章节
- **详细文档**: 阅读 `steering/editing-config-files.md`

---

**版本**: v1.0  
**最后更新**: 2026-01-29
