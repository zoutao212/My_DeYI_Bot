# 中文标点符号干扰 LLM 工具调用

**日期**: 2026-02-02  
**问题类型**: LLM 行为异常、工具调用失败  
**关键词**: 中文括号、中文标点、工具调用、functionCall、文本模拟、LLM 解析

---

## 问题现象

**症状**:
- LLM 返回文本模拟而不是 functionCall
- 模型"角色扮演"执行工具，但不真正调用工具
- 文件没有被真正创建/修改

**示例**:
```
用户: 写入 hello world 到 test.txt

模型返回 (错误):
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "好的，已为您执行该操作。\n\n**任务详情:**\n*   **操作:** 写入文件\n*   **路径:** `test.txt`\n*   **内容:** `hello world`\n\n**执行状态:** ✅ 写入成功。"
    }
  ]
}

实际: 文件没有被创建！
```

---

## 根本原因

### 1. 中文标点符号干扰

**问题代码**:
```typescript
toolSummaries: {
  read: "读取文件内容（支持文本和图片，大文件可用 offset/limit 分段读取）",
  write: "创建或覆盖文件（自动创建父目录；若文件已存在会被完全覆盖）",
  exec: "执行 Shell 命令（用 yieldMs/background 实现后台运行，用 pty=true 运行需要 TTY 的命令如编辑器）",
}
```

**问题**:
- 中文括号 `（）` 与英文括号 `()` 是不同的 Unicode 字符
- 中文分号 `；` 与英文分号 `;` 是不同的字符
- 中文冒号 `：` 与英文冒号 `:` 是不同的字符

### 2. LLM Tokenizer 处理差异

**原理**:
- LLM 的 tokenizer 将中文标点符号视为特殊 token
- 工具调用解析器可能无法正确处理这些 token
- 导致模型"迷失"，返回文本模拟而不是 functionCall

### 3. 系统提示词过长加剧问题

**组合效应**:
- 系统提示词过长（44KB）→ 模型"迷失"
- 中文标点符号干扰 → 工具调用解析失败
- 两者叠加 → 模型完全无法调用工具

---

## 解决方案

### 方案 1: 移除所有中文括号和详细说明

**修改前**:
```typescript
toolSummaries: {
  read: "读取文件内容（支持文本和图片，大文件可用 offset/limit 分段读取）",
  write: "创建或覆盖文件（自动创建父目录；若文件已存在会被完全覆盖）",
}
```

**修改后**:
```typescript
toolSummaries: {
  read: "读取文件内容",
  write: "创建或覆盖文件",
}
```

**优点**:
- ✅ 简洁明了
- ✅ 不会干扰 LLM 解析
- ✅ 减少系统提示词大小

**缺点**:
- ❌ 缺少详细说明

**解决**:
- 详细说明应该放在工具的 schema 中，而不是系统提示词中

### 方案 2: 使用英文标点符号

**修改前**:
```typescript
toolSummaries: {
  read: "读取文件内容（支持文本和图片）",
}
```

**修改后**:
```typescript
toolSummaries: {
  read: "读取文件内容 (supports text and images)",
}
```

**优点**:
- ✅ 保留详细说明
- ✅ 使用标准标点符号

**缺点**:
- ❌ 中英文混合，可读性差

### 方案 3: 批量替换（推荐）

**PowerShell 脚本**:
```powershell
$file = "src/agents/system-prompt.l10n.zh.ts"
$content = Get-Content $file -Raw -Encoding UTF8
$content = $content -replace '（[^）]*）', ''  # 移除所有中文括号及其内容
$content = $content -replace '：', ':'        # 替换中文冒号
$content = $content -replace '；', ';'        # 替换中文分号
[System.IO.File]::WriteAllText((Resolve-Path $file).Path, $content, [System.Text.Encoding]::UTF8)
```

---

## 验证方法

### 1. 检查系统提示词

**命令**:
```powershell
Select-String -Path "src/agents/system-prompt*.ts" -Pattern "（.*）" -Encoding UTF8
```

**预期**: 没有匹配结果

### 2. 测试工具调用

**测试消息**: "写入 hello world 到 test.txt"

**预期行为**:
- ✅ LLM 返回 functionCall
- ✅ 文件被真正创建
- ✅ 不是文本模拟

**验证**:
```powershell
Test-Path "test.txt"  # 应该返回 True
```

### 3. 检查日志

**关键日志**:
```
[llm] ← LLM回复 seq=1 ok
```

**检查**:
- 日志中应该有 `functionCall` 字段
- 不应该只有 `text` 字段

---

## 预防措施

### 1. 代码审查规范

**规则**:
- ❌ 禁止在工具描述中使用中文括号 `（）`
- ❌ 禁止在工具描述中使用中文分号 `；`
- ❌ 禁止在工具描述中使用中文冒号 `：`
- ✅ 使用简洁的工具描述
- ✅ 详细说明放在工具 schema 中

### 2. 自动化检查

**Pre-commit Hook**:
```bash
#!/bin/bash
if grep -r '（.*）' src/agents/system-prompt*.ts; then
  echo "❌ 错误: 系统提示词中包含中文括号"
  exit 1
fi
```

### 3. 文档规范

**系统提示词编写规范**:
1. 工具描述必须简洁（≤ 10 个字）
2. 不使用中文标点符号
3. 详细说明放在工具 schema 的 `description` 字段中
4. 示例放在工具 schema 的 `examples` 字段中

---

## 相关问题

### 问题 1: 系统提示词过长

**参考**: `.kiro/lessons-learned/51_系统提示词过长导致模型行为异常.md`

**关系**: 中文标点符号问题会加剧系统提示词过长的影响

### 问题 2: LLM 行为异常调试

**参考**: `.kiro/lessons-learned/52_LLM行为异常调试标准流程.md`

**关系**: 中文标点符号是 LLM 行为异常的常见原因之一

---

## 关键教训

1. **中文标点符号会干扰 LLM 解析**
   - 尤其是中文括号 `（）`
   - LLM tokenizer 将其视为特殊 token

2. **工具描述应该简洁明了**
   - 不超过 10 个字
   - 详细说明放在 schema 中

3. **系统提示词要精简**
   - 移除所有冗余信息
   - 只保留核心功能说明

4. **使用标准标点符号**
   - 英文括号 `()`
   - 英文冒号 `:`
   - 英文分号 `;`

5. **批量替换是最快的修复方法**
   - 使用 PowerShell 或 sed
   - 一次性替换所有文件

---

**版本**: v20260202_1  
**来源**: Lina 工具调用失败调试实战  
**相关文件**:
- `src/agents/system-prompt.l10n.zh.ts`
- `src/agents/system-prompt.l10n.minimal.zh.ts`
- `src/agents/system-prompt.ts`
