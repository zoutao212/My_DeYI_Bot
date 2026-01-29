# 编辑配置文件工作流

本指南提供使用 Safe File Editor 安全编辑配置文件的详细步骤。

---

## 工作流程

### 第一步：分析配置文件

在修改前，先了解配置文件的结构：

```python
import sys
import json
sys.path.insert(0, '.kiro/skills/safe_file_editor')
from safe_file_editor import SafeFileEditor

# 1. 创建编辑器实例
config_path = 'C:\\Users\\zouta\\.clawdbot\\clawdbot.json'
editor = SafeFileEditor(config_path)

# 2. 查看文件信息
print(f"文件路径: {editor.file_path}")
print(f"总行数: {len(editor.lines)}")
print(f"行尾符: {getattr(editor, 'line_ending_name', 'UNKNOWN')}")

# 3. 查看文件内容（前 20 行）
for i, line in enumerate(editor.lines[:20], start=1):
    print(f"{i:3d}: {line.rstrip()}")
```

### 第二步：定位要修改的位置

有三种定位方法：

#### 方法 A: 按行号定位（最精确）

```python
# 查看特定行范围
start_line = 5
end_line = 10

print(f"\n行 {start_line}-{end_line}:")
for i, line in enumerate(editor.lines[start_line-1:end_line], start=start_line):
    print(f"{i:3d}: {line.rstrip()}")
```

#### 方法 B: 按关键字搜索

```python
# 搜索包含关键字的行
keyword = 'workspace'
matches = []

for i, line in enumerate(editor.lines, start=1):
    if keyword in line:
        matches.append((i, line.rstrip()))

print(f"\n包含 '{keyword}' 的行:")
for line_num, content in matches:
    print(f"{line_num:3d}: {content}")
```

#### 方法 C: 解析 JSON 结构

```python
import json

# 读取并解析 JSON
with open(config_path, 'r', encoding='utf-8') as f:
    config = json.load(f)

# 查看结构
print("\n配置结构:")
print(json.dumps(config, indent=2, ensure_ascii=False))

# 定位特定配置项
if 'agents' in config and 'defaults' in config['agents']:
    print(f"\n当前 workspace: {config['agents']['defaults'].get('workspace')}")
```

### 第三步：准备新内容

根据配置格式准备新内容：

```python
# JSON 配置示例
new_workspace = 'D:\\Git_GitHub\\clawdbot'

# 方法 1: 直接修改 JSON 对象
config['agents']['defaults']['workspace'] = new_workspace
new_content = json.dumps(config, indent=2, ensure_ascii=False)

# 方法 2: 准备替换的行内容（保持原格式）
new_line = f'    "workspace": "{new_workspace}",\n'
```

### 第四步：执行替换（带预览）

```python
# 使用 SafeFileEditor 替换
editor = SafeFileEditor(config_path)

# 按行号替换（推荐）
success = editor.replace_by_line_numbers(
    start_line=5,  # 要替换的起始行
    end_line=5,    # 要替换的结束行
    new_code=new_line,
    verify_vars=['workspace'],  # 验证关键词
    require_confirmation=True   # 显示 Diff 并要求确认
)

if success:
    print("✅ 替换成功")
else:
    print("❌ 替换失败")
```

### 第五步：验证修改

使用 PowerShell 验证修改是否正确：

```powershell
# 读取文件
$config = Get-Content "C:\Users\zouta\.clawdbot\clawdbot.json" -Raw -Encoding UTF8 | ConvertFrom-Json

# 验证配置值
Write-Host "当前 workspace: $($config.agents.defaults.workspace)" -ForegroundColor Green

# 验证 JSON 格式
if ($config) {
    Write-Host "✅ JSON 格式正确" -ForegroundColor Green
} else {
    Write-Host "❌ JSON 格式错误" -ForegroundColor Red
}
```

---

## 完整示例：修改 clawdbot.json

### 场景：修改 agents.defaults.workspace

```python
import sys
import json
sys.path.insert(0, '.kiro/skills/safe_file_editor')
from safe_file_editor import SafeFileEditor

# 配置
config_path = 'C:\\Users\\zouta\\.clawdbot\\clawdbot.json'
new_workspace = 'D:\\Git_GitHub\\clawdbot'

# 第一步：读取并解析 JSON
with open(config_path, 'r', encoding='utf-8') as f:
    config = json.load(f)

# 第二步：修改配置
if 'agents' not in config:
    config['agents'] = {}
if 'defaults' not in config['agents']:
    config['agents']['defaults'] = {}

config['agents']['defaults']['workspace'] = new_workspace

# 第三步：格式化 JSON
new_content = json.dumps(config, indent=2, ensure_ascii=False)

# 第四步：使用 SafeFileEditor 写入（自动备份）
editor = SafeFileEditor(config_path)

# 创建备份
import shutil
from datetime import datetime
timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
backup_path = f'{config_path}.manual_backup_{timestamp}'
shutil.copy(config_path, backup_path)
print(f"✅ 手动备份已创建: {backup_path}")

# 写入新内容
with open(config_path, 'w', encoding='utf-8') as f:
    f.write(new_content)

print(f"✅ 配置已更新")
print(f"   workspace: {new_workspace}")
```

### 验证脚本（PowerShell）

```powershell
# 验证配置
$config = Get-Content "C:\Users\zouta\.clawdbot\clawdbot.json" -Raw -Encoding UTF8 | ConvertFrom-Json

Write-Host "=== 配置验证 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "workspace: $($config.agents.defaults.workspace)" -ForegroundColor Green
Write-Host ""

# 验证 JSON 格式
try {
    $null = $config | ConvertTo-Json -Depth 10
    Write-Host "✅ JSON 格式正确" -ForegroundColor Green
} catch {
    Write-Host "❌ JSON 格式错误: $_" -ForegroundColor Red
}
```

---

## 常见错误处理

### 错误 1: JSON 格式错误

**症状**：
```
json.decoder.JSONDecodeError: Expecting ',' delimiter
```

**原因**：
- 缺少逗号
- 引号不匹配
- 括号不匹配

**解决方案**：
```python
# 使用 JSON 验证工具
import json

try:
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
    print("✅ JSON 格式正确")
except json.JSONDecodeError as e:
    print(f"❌ JSON 格式错误: {e}")
    print(f"   行 {e.lineno}, 列 {e.colno}")
    
    # 显示错误位置
    with open(config_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
        error_line = lines[e.lineno - 1]
        print(f"   错误行: {error_line.rstrip()}")
```

### 错误 2: 文件被锁定

**症状**：
```
PermissionError: [Errno 13] Permission denied
```

**解决方案**：
```python
import os
import time

# 检查文件是否被锁定
def is_file_locked(filepath):
    try:
        with open(filepath, 'a'):
            return False
    except IOError:
        return True

# 等待文件解锁
max_retries = 5
for i in range(max_retries):
    if not is_file_locked(config_path):
        break
    print(f"文件被锁定，等待 {i+1}/{max_retries}...")
    time.sleep(1)
else:
    print("❌ 文件仍被锁定，请关闭使用该文件的程序")
```

### 错误 3: 备份文件过多

**解决方案**：
```python
import os
import glob
from pathlib import Path

# 清理旧备份（保留最近 5 个）
backup_pattern = f'{config_path}.bak_*'
backups = sorted(glob.glob(backup_pattern), reverse=True)

if len(backups) > 5:
    for old_backup in backups[5:]:
        os.remove(old_backup)
        print(f"删除旧备份: {old_backup}")
```

---

## 最佳实践总结

### ✅ 推荐做法

1. **修改前先备份**
   ```python
   import shutil
   shutil.copy('config.json', 'config.json.backup')
   ```

2. **使用 JSON 库处理 JSON 文件**
   ```python
   import json
   config = json.load(f)
   config['key'] = 'value'
   json.dump(config, f, indent=2)
   ```

3. **修改后验证格式**
   ```python
   with open('config.json', 'r') as f:
       json.load(f)  # 验证 JSON 格式
   ```

4. **使用 PowerShell 交叉验证**
   ```powershell
   $config = Get-Content "config.json" -Raw | ConvertFrom-Json
   $config.key
   ```

### ❌ 避免做法

1. **不要直接字符串拼接 JSON**
   ```python
   # ❌ 错误
   new_content = '{"key": "value"}'
   
   # ✅ 正确
   config = {'key': 'value'}
   new_content = json.dumps(config, indent=2)
   ```

2. **不要忽略编码问题**
   ```python
   # ❌ 错误
   with open('config.json', 'r') as f:
       content = f.read()
   
   # ✅ 正确
   with open('config.json', 'r', encoding='utf-8') as f:
       content = f.read()
   ```

3. **不要跳过验证步骤**
   ```python
   # ❌ 错误
   with open('config.json', 'w') as f:
       f.write(new_content)
   # 没有验证
   
   # ✅ 正确
   with open('config.json', 'w') as f:
       f.write(new_content)
   # 验证
   with open('config.json', 'r') as f:
       json.load(f)
   ```

---

**最后更新**: 2026-01-29
