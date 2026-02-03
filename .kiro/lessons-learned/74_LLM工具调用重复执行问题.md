# LLM 工具调用重复执行问题

**日期**：2026-02-03  
**问题**：LLM 反复执行相同的工具调用，不相信或不理解工具结果  
**根本原因**：LLM 缺乏对工具结果的信任，或者不知道何时停止

---

## 🔍 问题特征

### 典型表现

1. **重复执行相同的工具调用**
   - 例如：反复执行 `Get-Date`（9 次）
   - 例如：反复读取 `SOUL.md`, `USER.md`

2. **工具结果正确返回，但 LLM 不使用**
   - 工具返回了正确的数据
   - 但 LLM 使用了错误的数据（幻觉）

3. **LLM 的 thinking 显示不确定性**
   - "I need to verify..."
   - "Let me check again..."
   - "I'm not sure if..."

### 实战案例

#### 案例 1：反复执行 Get-Date

**现象**：
- seq=11: `Get-Date` → 返回 `2026-02-03`
- seq=12: `Get-Date` → 返回 `2026-02-03`
- seq=13: `Get-Date` → 返回 `2026-02-03`
- seq=14: `Get-Date` → 返回 `2026-02-03`
- seq=15: 写入 `memory\2025-03-03.md`（错误的日期！）

**问题**：
- LLM 执行了 4 次 `Get-Date`
- 每次都返回了正确的日期（2026-02-03）
- 但 LLM 最终使用了错误的日期（2025-03-03）

**LLM 的 thinking**：
```
**Testing Memory Updates**
I'm currently focused on implementing memory updates...
My immediate goal is to establish the correct workflow...
```

**分析**：
- LLM 在"测试"记忆更新
- LLM 不确定日期是否正确
- LLM 反复获取日期来"验证"
- 但最终还是使用了错误的日期（幻觉）

#### 案例 2：反复读取文件

**现象**：
- seq=2: 读取 `SOUL.md`, `USER.md`, `MEMORY.md`
- seq=9: 读取 `SOUL.md`, `USER.md`, `MEMORY.md`（又读了一次！）

**问题**：
- LLM 在"会话初始化"时读取了文件
- 但在工具调用后又重新读取了相同的文件

**详见**：`.kiro/lessons-learned/73_LLM无限循环的根本解决方案.md`

---

## 🎯 根本原因

### 1. LLM 缺乏对工具结果的信任

**问题**：LLM 不相信工具返回的结果是正确的

**表现**：
- 反复执行相同的工具调用
- 使用错误的数据（幻觉）而不是工具返回的数据

**原因**：
- 系统提示词中没有明确告诉 LLM"相信工具结果"
- LLM 的训练数据中可能包含"需要验证"的模式

### 2. LLM 不知道何时停止

**问题**：LLM 不知道工具调用已经完成，应该停止了

**表现**：
- 反复执行相同的工具调用
- 没有明确的"停止条件"

**原因**：
- 系统提示词中没有明确告诉 LLM"工具调用一次就够了"
- LLM 的 thinking 显示它在"测试"或"验证"

### 3. LLM 的日期理解错误

**问题**：LLM 看到了正确的日期，但使用了错误的日期

**表现**：
- `Get-Date` 返回 `2026-02-03`
- 但 LLM 写入 `2025-03-03.md`

**原因**：
- LLM 的日期推理能力有问题
- LLM 可能在"幻觉"日期

---

## 🔧 解决方案

### 方案 1：在系统提示词中强调"相信工具结果"

**添加到系统提示词**：

```markdown
## 工具调用原则

**相信工具返回的结果：**
- ✅ 工具返回的结果是正确的，不需要验证
- ✅ 不要反复执行相同的工具调用
- ✅ 执行一次就够了，不要重复

**示例**：
- 执行 `Get-Date` 一次 → 得到日期 → 直接使用
- 读取 `SOUL.md` 一次 → 得到内容 → 直接使用
- ❌ 不要反复执行 `Get-Date` 来"验证"日期
- ❌ 不要反复读取 `SOUL.md` 来"确认"内容
```

### 方案 2：添加工具调用次数限制

**在代码中添加限制**：

```typescript
// 检测重复的工具调用
const recentToolCalls = context.messages
  .slice(-10)
  .filter(msg => msg.role === 'assistant' && msg.toolCalls)
  .flatMap(msg => msg.toolCalls);

const duplicates = recentToolCalls.filter((call, index) => {
  return recentToolCalls.slice(0, index).some(prev => 
    prev.name === call.name && 
    JSON.stringify(prev.arguments) === JSON.stringify(call.arguments)
  );
});

if (duplicates.length >= 3) {
  log.warn(`⚠️ 检测到重复的工具调用: ${duplicates[0].name}`);
  // 可以选择：
  // 1. 阻止工具调用
  // 2. 在系统提示词中添加警告
  // 3. 强制 LLM 回复用户
}
```

### 方案 3：在工具结果中添加"确认"信息

**修改工具结果格式**：

```typescript
// 原来的格式
{
  result: "2026-02-03"
}

// 新的格式
{
  result: "2026-02-03",
  _meta: {
    confirmed: true,
    message: "这是正确的日期，不需要再次获取"
  }
}
```

---

## 📊 验证方法

### 1. 检查工具调用次数

```powershell
# 统计相同工具调用的次数
$trace = Get-Content "trace.jsonl" -Encoding UTF8 | ConvertFrom-Json
$toolStarts = $trace | Where-Object { $_.event -eq "tool.start" }
$toolStarts | Group-Object { $_.payload.toolName + ":" + $_.payload.meta } | 
  Where-Object { $_.Count -gt 1 } | 
  Select-Object Name, Count
```

### 2. 检查 LLM 的 thinking

```powershell
# 查找"验证"、"测试"等关键词
$trace = Get-Content "trace.jsonl" -Encoding UTF8 | ConvertFrom-Json
$llmDone = $trace | Where-Object { $_.event -eq "llm.done" }
$thinking = $llmDone.payload.responseSummary.samples | 
  Where-Object { $_.type -eq 'thinking_delta' }
$thinking | Where-Object { $_.delta -like "*verify*" -or $_.delta -like "*test*" }
```

### 3. 检查数据一致性

```powershell
# 检查工具返回的数据和 LLM 使用的数据是否一致
$toolEnds = $trace | Where-Object { $_.event -eq "tool.end" }
$writes = $trace | Where-Object { $_.event -eq "tool.start" -and $_.payload.toolName -eq "write" }

# 对比日期
$dates = $toolEnds | Where-Object { $_.payload.meta -like "*Get-Date*" } | 
  Select-Object -ExpandProperty payload | 
  Select-Object -ExpandProperty tail

$writeFiles = $writes | Select-Object -ExpandProperty payload | 
  Select-Object -ExpandProperty meta

Write-Host "工具返回的日期: $dates"
Write-Host "LLM 写入的文件: $writeFiles"
```

---

## 🎓 通用原则

### 当 LLM 反复执行相同的工具调用时

1. **检查工具结果是否正确返回**
   - 工具是否真的执行了？
   - 工具结果是否被发送给 LLM？
   - 工具结果的格式是否正确？

2. **检查 LLM 的 thinking**
   - LLM 为什么要重复执行？
   - LLM 是否在"验证"或"测试"？
   - LLM 是否不相信工具结果？

3. **检查数据一致性**
   - 工具返回的数据是什么？
   - LLM 使用的数据是什么？
   - 两者是否一致？

4. **修复方案**
   - 在系统提示词中强调"相信工具结果"
   - 在系统提示词中强调"不要重复执行"
   - 添加工具调用次数限制
   - 在工具结果中添加"确认"信息

---

## 🔗 相关文档

- `.kiro/lessons-learned/70_LLM行为异常的完整调试流程.md`
- `.kiro/lessons-learned/73_LLM无限循环的根本解决方案.md`
- `.kiro/steering/always/system-prompt-design-principles.md`

---

**版本**：v20260203_1  
**状态**：已分析，待修复  
**关键词**：LLM 工具调用、重复执行、不相信结果、日期幻觉、验证循环
