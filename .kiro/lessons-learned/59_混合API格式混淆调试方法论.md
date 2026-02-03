# 混合 API 格式混淆调试方法论

> **背景**：vectorengine API 兼容性问题 - 使用 OpenAI endpoint 但期望 Gemini payload

---

## 问题识别

### 典型症状

1. **seq=1（无历史消息）成功，seq=2（有历史消息）失败**
2. **错误信息提到特定格式字段**（如 `functionCall`、`tool_calls`）
3. **API 使用标准 endpoint**（如 `/v1/chat/completions`）**但行为异常**

### 混合 API 的特征

**混合 API**：使用一种 API 的 endpoint，但期望另一种 API 的 payload 格式

**示例**：
- vectorengine：OpenAI endpoint (`/v1/chat/completions`) + Gemini payload
- yinli：Gemini endpoint + 特殊的 thought_signature 要求

---

## 根本原因

### 为什么会出现混合 API？

1. **中转 API 的兼容性设计**
   - 为了兼容多种客户端，使用标准 endpoint
   - 但内部实现可能期望特定格式

2. **API 代理/转换层**
   - 代理层可能只转换部分字段
   - 导致格式不完全匹配

3. **文档不完整**
   - API 文档可能只说明 endpoint
   - 没有明确说明 payload 格式要求

---

## 调试方法论

### 第一步：不要相信错误信息

**错误信息可能不准确或不完整。**

**示例**：
- **错误信息说**："missing thought_signature in functionCall"
- **实际问题**：发送的是 OpenAI 格式（`tool_calls`），不是 Gemini 格式（`functionCall`）

**正确做法**：
1. 提取实际发送的 payload
2. 对比 API 文档期望的格式
3. 找到真正的差异

### 第二步：提取成功和失败的完整 payload

**不要手动对比，写脚本自动化。**

#### 提取 payload

```powershell
$trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }

# 保存 seq=1（成功）
$payloads[0].payload.payload | ConvertTo-Json -Depth 20 | Out-File "seq1_payload.json" -Encoding UTF8

# 保存 seq=2（失败）
$payloads[1].payload.payload | ConvertTo-Json -Depth 20 | Out-File "seq2_payload.json" -Encoding UTF8
```

#### 对比关键差异

```powershell
$seq1 = Get-Content "seq1_payload.json" -Encoding UTF8 | ConvertFrom-Json
$seq2 = Get-Content "seq2_payload.json" -Encoding UTF8 | ConvertFrom-Json

# 对比 messages 数量
Write-Host "seq=1 messages: $($seq1.messages.Count)"
Write-Host "seq=2 messages: $($seq2.messages.Count)"

# 对比每条消息的格式
for ($i = 0; $i -lt $seq2.messages.Count; $i++) {
    $msg = $seq2.messages[$i]
    Write-Host "[$i] role: $($msg.role), has tool_calls: $(if ($msg.tool_calls) { 'yes' } else { 'no' })"
}
```

### 第三步：识别 API 真正期望的格式

**通过错误信息中的关键词识别格式。**

| 关键词 | 格式 | 说明 |
|--------|------|------|
| `functionCall` | Gemini | Gemini API 的工具调用格式 |
| `tool_calls` | OpenAI | OpenAI API 的工具调用格式 |
| `role: model` | Gemini | Gemini API 的 assistant 角色 |
| `role: assistant` | OpenAI | OpenAI API 的 assistant 角色 |
| `role: function` | Gemini | Gemini API 的工具响应角色 |
| `role: tool` | OpenAI | OpenAI API 的工具响应角色 |
| `parts` | Gemini | Gemini API 的内容格式 |
| `content` | OpenAI | OpenAI API 的内容格式 |

**示例**：
- 错误信息包含 `functionCall` → API 期望 Gemini 格式
- 实际发送的是 `tool_calls` → 发送的是 OpenAI 格式
- **结论**：需要格式转换

### 第四步：设计格式转换逻辑

**OpenAI 格式 → Gemini 格式**

#### assistant 消息

```typescript
// OpenAI 格式
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "call_xxx",
      "type": "function",
      "function": {
        "name": "write",
        "arguments": "{...}"  // JSON 字符串
      }
    }
  ]
}

// Gemini 格式
{
  "role": "model",
  "parts": [
    {
      "functionCall": {
        "name": "write",
        "args": {...}  // JSON 对象
      }
    }
  ]
}
```

**关键差异**：
1. `role: assistant` → `role: model`
2. `tool_calls` → `parts`
3. `function.arguments`（字符串）→ `functionCall.args`（对象）
4. 删除 `content` 字段

#### tool 消息

```typescript
// OpenAI 格式
{
  "role": "tool",
  "content": "...",  // 可能是 JSON 字符串
  "tool_call_id": "call_xxx"
}

// Gemini 格式
{
  "role": "function",
  "parts": [
    {
      "functionResponse": {
        "name": "write",
        "response": {...}  // JSON 对象
      }
    }
  ]
}
```

**关键差异**：
1. `role: tool` → `role: function`
2. `content`（字符串）→ `parts[].functionResponse.response`（对象）
3. 需要从 `content` 中提取工具名称

### 第五步：实现格式转换

**在 payload 发送前执行转换。**

**位置**：`src/agents/gemini-payload-thought-signature.ts` 的 `nextOnPayload` 函数

**实现**：
```typescript
// 检测 provider 是否需要格式转换
if (base.provider && base.provider.toLowerCase().includes("vectorengine")) {
  if (payload && typeof payload === "object" && "messages" in payload) {
    const payloadObj = payload as Record<string, unknown>;
    const messages = payloadObj.messages;
    
    if (Array.isArray(messages)) {
      log.info(`[format] Converting OpenAI format to Gemini format for vectorengine`);
      payloadObj.messages = convertOpenAIToGeminiFormat(messages);
      log.info(`[format] ✓ Converted ${messages.length} messages to Gemini format`);
    }
  }
}
```

### 第六步：验证转换是否完整

**验证清单**：

- ✅ **assistant 消息**：`role: assistant` → `role: model`
- ✅ **tool_calls**：转换为 `parts[].functionCall`
- ✅ **arguments**：JSON 字符串 → JSON 对象
- ✅ **tool 消息**：`role: tool` → `role: function`
- ✅ **content**：转换为 `parts[].functionResponse`
- ✅ **thought_signature**：在正确位置（如果需要）

**验证方法**：
1. 提取转换后的 payload
2. 对比 API 文档期望的格式
3. 测试 seq=1、seq=2、seq=3

---

## 常见错误模式

### 错误 1：只看错误信息，不看实际 payload

**问题**：
- 错误信息说 "missing thought_signature"
- 就只添加 `thought_signature`
- 但实际问题是格式不对

**正确做法**：
- 提取实际 payload
- 对比期望格式
- 找到真正的差异

### 错误 2：盲目尝试，不系统分析

**问题**：
- 看到错误就改
- 改了又错
- 反复修改

**正确做法**：
- 停下来系统性分析
- 提取 payload 对比
- 设计完整的转换逻辑
- 一次性修复

### 错误 3：只修复单向，不考虑双向

**问题**：
- 只修复请求格式
- 不修复响应格式
- 导致历史消息格式错误

**正确做法**：
- 入站修复：转换请求格式
- 出站修复：清理响应格式
- 双向保护

---

## 实战案例

### 案例 1：vectorengine API

**问题**：
- seq=1 成功，seq=2 失败
- 错误信息："missing thought_signature in functionCall"

**分析**：
1. 提取 seq=1 和 seq=2 的 payload
2. 发现 seq=2 包含 assistant 和 tool 消息
3. 发现发送的是 OpenAI 格式（`tool_calls`）
4. 错误信息提到 `functionCall`（Gemini 格式）
5. **结论**：vectorengine 期望 Gemini 格式

**修复**：
1. 在 `gemini-payload-thought-signature.ts` 中添加格式转换
2. 转换 assistant 消息：`role: assistant` → `role: model`
3. 转换 tool 消息：`role: tool` → `role: function`
4. 确保 `thought_signature` 在正确位置

### 案例 2：yinli API

**问题**：
- seq=1 成功，seq=2 失败
- 错误信息："Corrupted thought signature"

**分析**：
1. 提取 seq=1 和 seq=2 的 payload
2. 发现 seq=2 包含 `thought_signature`
3. 发现 yinli 不接受 `functionCall` 内部的 `thought_signature`
4. **结论**：yinli 只接受 wrapper 上的 `thought_signature`

**修复**：
1. 在 `gemini-payload-thought-signature.ts` 中添加清理逻辑
2. 移除 `functionCall` 内部的 `thought_signature`
3. 保留 wrapper 上的 `thought_signature`

---

## 关键教训

1. **不要相信错误信息** - 必须通过 payload 对比找到真正的差异
2. **不要盲目尝试** - 停下来系统性分析，设计完整的转换逻辑
3. **不要只修复单向** - 入站和出站都要修复
4. **不要只看表面** - 深入理解 API 的真正期望
5. **不要手动对比** - 写脚本自动化，提高效率和准确性

---

## 调试检查清单

修复混合 API 问题时，必须检查：

- [ ] **提取成功和失败的完整 payload**
- [ ] **对比 payload 差异**（不要只看错误信息）
- [ ] **识别 API 真正期望的格式**（通过关键词）
- [ ] **设计完整的格式转换逻辑**
- [ ] **验证转换是否完整**（所有字段都正确）
- [ ] **测试 seq=1、seq=2、seq=3**
- [ ] **验证不影响其他 provider**

---

## 给未来的自己

当你再次遇到"混合 API 格式混淆"的问题时，记住：

**不要相信错误信息，提取 payload 对比，找到真正的差异，设计完整的转换逻辑。**

---

**版本：** v20260203_1  
**来源：** vectorengine API 兼容性问题调试实战  
**变更：** 新增"混合 API 格式混淆调试方法论"
