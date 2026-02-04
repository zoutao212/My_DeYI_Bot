# LLM 历史消息格式处理原则

**目的**：确保 LLM 不会重复执行历史消息中的操作

---

## 核心原则

**LLM 无法区分"已执行"和"待执行"的操作，必须通过格式转换来明确区分。**

---

## 问题场景

### 典型问题

当历史消息中保留完整的操作格式时，LLM 会误认为是"待执行"的操作：

```json
// ❌ 错误：历史消息中保留完整的 tool call 格式
{
  "role": "model",
  "parts": [
    {
      "functionCall": {
        "name": "read",
        "args": { "path": "SOUL.md" }
      }
    }
  ]
}
```

**结果**：LLM 看到 `functionCall`，认为需要执行，导致重复执行。

### 根本原因

1. **LLM 只看到消息内容**
   - 无法判断时间顺序
   - 无法区分"已执行"和"待执行"

2. **完整的操作格式会被误解**
   - `functionCall`、`tool_calls` 等格式会被理解为"待执行"
   - LLM 无法理解"这是历史记录"

---

## 解决方案

### 核心思路

**将历史消息中的操作转换为"伪代码化"的文本描述。**

### 实施规则

#### 规则 1：区分历史消息和当前消息

**定义**：
- **历史消息**：最后一条用户消息之前的所有消息
- **当前消息**：最后一条用户消息及其之后的消息

**实现**：
```typescript
// 找到最后一条用户消息的索引
let lastUserIndex = -1;
for (let i = messages.length - 1; i >= 0; i--) {
  if (messages[i].role === "user") {
    lastUserIndex = i;
    break;
  }
}

// 判断是否是历史消息
const isHistory = index < lastUserIndex;
```

#### 规则 2：转换历史消息中的操作

**历史消息中的 tool call**：
```typescript
// ✅ 正确：转换为文本描述
{
  "role": "model",
  "parts": [
    { "text": "[已执行工具调用] read({\"path\":\"SOUL.md\"})" }
  ]
}
```

**历史消息中的 tool result**：
```typescript
// ✅ 正确：转换为文本描述
{
  "role": "user",
  "parts": [
    { "text": "[工具执行结果] read:\n{\"result\":\"...\"}" }
  ]
}
```

#### 规则 3：保留当前消息的完整格式

**当前消息中的 tool call**：
```typescript
// ✅ 正确：保留完整格式
{
  "role": "model",
  "parts": [
    {
      "functionCall": {
        "name": "read",
        "args": { "path": "USER.md" }
      }
    }
  ]
}
```

---

## 实施位置

### 适用场景

- ✅ 所有涉及历史消息的 LLM 交互
- ✅ 所有使用 tool call 的系统
- ✅ 所有需要区分"已执行"和"待执行"的场景

### 实施位置

**在构建 payload 时进行格式转换**：

```typescript
// 示例：在 convertOpenAIToGeminiFormat 中实现
function convertOpenAIToGeminiFormat(messages: unknown[], options?: {
  markHistoryToolCalls?: boolean;  // 是否标记历史 tool call
}): unknown[] {
  const markHistory = options?.markHistoryToolCalls ?? false;
  
  // 如果是历史消息，转换为文本描述
  if (markHistory && role === "assistant" && toolCalls) {
    return {
      role: "model",
      parts: [{ text: `[已执行工具调用] ${name}(${args})` }],
    };
  }
  
  // 当前消息：保留完整格式
  // ...
}
```

---

## 验证方法

### 方法 1：查看 trace 日志

```powershell
# 查看 payload 中的历史消息
$trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
$payloads[1].payload.payload.messages | ConvertTo-Json -Depth 10
```

**预期结果**：
- 历史消息中的 tool call 被转换为文本描述
- 当前消息中的 tool call 保留完整格式

### 方法 2：观察 LLM 行为

1. 发送第一条消息："请帮我读取 SOUL.md 文件"
2. 观察 LLM 是否调用 read 工具
3. 发送第二条消息："现在请帮我读取 USER.md 文件"
4. 观察 LLM 是否重复调用 read 工具读取 SOUL.md

**预期结果**：
- 第一轮：LLM 调用 read 工具读取 SOUL.md ✅
- 第二轮：LLM 只调用 read 工具读取 USER.md，不会重复读取 SOUL.md ✅

---

## 关键教训

### 1. LLM 无法理解时间顺序

**问题**：LLM 只看到消息内容，无法判断"已执行"和"待执行"

**解决**：通过格式转换明确区分

### 2. 伪代码化是最佳方案

**优点**：
- 保留了操作的信息（用于上下文理解）
- 避免了 LLM 重复执行
- 不影响 LLM 的理解能力

**示例**：
```
[已执行工具调用] read({"path":"SOUL.md"})
[工具执行结果] read:
{
  "result": "..."
}
```

### 3. 必须在 payload 构建时转换

**原因**：
- session 是持久化存储，不应该包含临时标记
- 格式转换应该在发送前进行，不应该修改 session

---

## 相关文档

- `.kiro/lessons-learned/79_历史消息Tool_Call重复执行问题.md`
- `.kiro/lessons-learned/78_历史消息格式处理策略.md`
- `.kiro/lessons-learned/75_对话历史格式混乱导致LLM行为异常.md`

---

## 实施清单

当你需要实现历史消息格式转换时，确保：

- [ ] 区分历史消息和当前消息
- [ ] 转换历史消息中的 tool call 为文本描述
- [ ] 转换历史消息中的 tool result 为文本描述
- [ ] 保留当前消息的完整格式
- [ ] 在 payload 构建时进行转换（不修改 session）
- [ ] 验证 LLM 不会重复执行历史操作

---

**版本**：v20260204_1  
**最后更新**：2026-02-04  
**变更**：新增 LLM 历史消息格式处理原则
