# API 格式混淆调试方法论

> **来源**：vectorengine API 格式错误调试实战（2026-02-03）

---

## 问题场景

当中转 API 返回模糊错误（如"请求失败,如果多次出现，请联系客服"），不知道 API 期望什么格式时。

**典型症状：**
- ✅ 日志显示格式转换成功
- ✅ trace 日志显示 payload 正确
- ❌ API 仍然返回错误
- ❌ 错误信息不明确

---

## 根本原因

**API 格式混淆**：错误地将 OpenAI 格式转换为 Gemini 格式（或反之）。

### OpenAI Completions API 格式

```json
{
  "messages": [
    {
      "role": "assistant",
      "tool_calls": [
        {
          "id": "call_xxx",
          "type": "function",
          "function": {
            "name": "write",
            "arguments": "{\"path\":\"test.txt\",\"content\":\"hello\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_xxx",
      "content": "success"
    }
  ]
}
```

### Gemini 原生 API 格式

```json
{
  "contents": [
    {
      "role": "model",
      "parts": [
        {
          "functionCall": {
            "name": "write",
            "args": {
              "path": "test.txt",
              "content": "hello"
            }
          }
        }
      ]
    },
    {
      "role": "function",
      "parts": [
        {
          "functionResponse": {
            "name": "write",
            "response": {
              "result": "success"
            }
          }
        }
      ]
    }
  ]
}
```

### 关键差异

| 维度 | OpenAI 格式 | Gemini 格式 |
|------|-------------|-------------|
| **顶层字段** | `messages` | `contents` |
| **assistant role** | `"assistant"` | `"model"` |
| **tool role** | `"tool"` | `"function"` |
| **工具调用** | `tool_calls: [...]` | `parts: [{functionCall: ...}]` |
| **工具结果** | `tool_call_id` + `content` | `parts: [{functionResponse: ...}]` |
| **参数格式** | `arguments: "JSON字符串"` | `args: {对象}` |

---

## 调试流程

### 第一步：确认 API 类型

**检查日志中的 `api=` 字段：**

```
[llm] → LLM请求 seq=1 model=vectorengine/gemini-3-flash-preview api=openai-completions
```

- `api=openai-completions` → 使用 OpenAI 格式
- `api=gemini` → 使用 Gemini 格式

**关键**：不要被 provider 名称误导！
- `vectorengine` 虽然名字像 Gemini，但使用的是 `openai-completions` API
- 必须以 `api=` 字段为准

### 第二步：检查格式转换逻辑

**搜索代码中的格式转换：**

```powershell
Select-String -Path "src/agents/**/*.ts" -Pattern "role.*model|functionCall|tool_calls" -Recurse
```

**检查是否有错误的转换：**
- ❌ OpenAI API 却转换为 Gemini 格式
- ❌ Gemini API 却保持 OpenAI 格式

### 第三步：验证 trace 日志的时机

**trace 日志可能记录的是转换前的 payload！**

**检查日志记录顺序：**

```typescript
// llm-call-console-log.ts
void appendRuntimeTrace({
  event: "llm.payload",
  payload: payload, // ← 记录原始 payload
});
options?.onPayload?.(payload); // ← 然后才调用转换逻辑
```

**验证方法：**
1. 检查日志中的 payload 格式
2. 检查代码中的转换逻辑
3. 如果不一致，说明 trace 记录的是转换前的 payload

### 第四步：创建最小测试

**创建简单的测试脚本，直接调用 API：**

```javascript
// test_api_format.mjs
const payload = {
  model: "gemini-3-flash-preview",
  messages: [
    { role: "user", content: "你好" },
    { role: "assistant", tool_calls: [...] } // 测试 OpenAI 格式
  ]
};

const response = await fetch("https://api.vectorengine.ai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`
  },
  body: JSON.stringify(payload)
});

console.log(await response.json());
```

**对比测试：**
- 测试 `role: "assistant"` vs `role: "model"`
- 测试 `tool_calls` vs `content: [{functionCall: ...}]`
- 找到 API 真正期望的格式

---

## 修复策略

### 策略 1：移除错误的格式转换

**如果 API 使用 OpenAI 格式，不要转换为 Gemini 格式：**

```typescript
// ❌ 错误：OpenAI API 却转换为 Gemini 格式
if (msgRec.role === "assistant" && Array.isArray(msgRec.tool_calls)) {
  msgRec.content = contentBlocks;
  delete msgRec.tool_calls;
  msgRec.role = "model"; // ← 错误！
}

// ✅ 正确：保持 OpenAI 格式不变
// 不需要转换
```

### 策略 2：添加正确的格式转换

**如果 API 使用 Gemini 格式，需要转换 OpenAI 格式：**

```typescript
// ✅ 正确：OpenAI 格式 → Gemini 格式
if (base.modelApi === "gemini") {
  // 转换 assistant → model
  // 转换 tool_calls → content.functionCall
  // 转换 tool → function
}
```

### 策略 3：根据 API 类型动态选择

**最佳实践：根据 `modelApi` 字段动态选择格式：**

```typescript
const needsGeminiFormat = base.modelApi === "gemini";
const needsOpenAIFormat = base.modelApi === "openai-completions";

if (needsGeminiFormat) {
  // 转换为 Gemini 格式
} else if (needsOpenAIFormat) {
  // 保持 OpenAI 格式
}
```

---

## 验证方法

### 1. 检查构建输出

```powershell
pnpm build
Select-String -Path "dist/agents/*.js" -Pattern "role.*model|functionCall" -Context 2,2
```

### 2. 检查运行日志

```powershell
# 检查格式转换日志
Get-Content "runtimelog/*.log" | Select-String "Converted.*format"

# 检查 API 响应
Get-Content "runtimelog/*.log" | Select-String "LLM回复.*ok|error"
```

### 3. 检查 trace 日志

```powershell
$trace = Get-Content "runtimelog/trace__*.jsonl" | ConvertFrom-Json
$payload = $trace | Where-Object { $_.event -eq "llm.payload" } | Select-Object -Last 1
$payload.payload.payload.messages | ConvertTo-Json -Depth 10
```

**验证点：**
- ✅ `role` 是否正确（`assistant` vs `model`）
- ✅ 工具调用格式是否正确（`tool_calls` vs `content.functionCall`）
- ✅ 工具结果格式是否正确（`tool` vs `function`）

---

## 常见错误

### 错误 1：被 provider 名称误导

```typescript
// ❌ 错误：根据 provider 名称判断格式
if (provider.includes("gemini")) {
  // 转换为 Gemini 格式
}
```

**问题**：`vectorengine` 虽然名字像 Gemini，但使用的是 OpenAI API

**正确做法**：根据 `modelApi` 字段判断

```typescript
// ✅ 正确：根据 API 类型判断格式
if (modelApi === "gemini") {
  // 转换为 Gemini 格式
}
```

### 错误 2：相信 trace 日志

```typescript
// ❌ 错误：相信 trace 日志中的 payload 格式
// trace 可能记录的是转换前的 payload
```

**问题**：trace 日志可能在格式转换之前记录

**正确做法**：检查代码中的转换逻辑，不要只看 trace 日志

### 错误 3：盲目转换格式

```typescript
// ❌ 错误：看到 Gemini 就转换格式
if (provider.includes("gemini") || provider.includes("vectorengine")) {
  // 转换为 Gemini 格式
}
```

**问题**：不是所有 Gemini 相关的 API 都使用 Gemini 格式

**正确做法**：先确认 API 类型，再决定是否转换

---

## 关键教训

1. **不要被 provider 名称误导**
   - 必须以 `modelApi` 字段为准
   - `vectorengine` 使用 OpenAI 格式，不是 Gemini 格式

2. **trace 日志可能不准确**
   - trace 可能记录的是转换前的 payload
   - 必须检查代码中的转换逻辑

3. **创建最小测试验证**
   - 不要盲目相信日志
   - 创建简单的测试脚本直接调用 API

4. **格式转换要谨慎**
   - 只在确认需要时才转换
   - 转换后必须验证

5. **错误信息可能不准确**
   - 中转 API 的错误信息可能模糊
   - 必须通过测试找到真正的问题

---

## 检查清单

调试 API 格式问题时，必须检查：

- [ ] **确认 API 类型**：检查 `api=` 字段
- [ ] **检查格式转换逻辑**：搜索代码中的转换代码
- [ ] **验证 trace 日志时机**：确认 trace 记录的是转换前还是转换后
- [ ] **创建最小测试**：直接调用 API 验证格式
- [ ] **检查构建输出**：确认转换逻辑是否生效
- [ ] **检查运行日志**：确认 API 响应是否正常
- [ ] **对比成功和失败的请求**：找到真正的差异

---

**版本：** v20260203_1  
**最后更新：** 2026-02-03  
**变更：** 新增"API 格式混淆调试方法论"（vectorengine 格式错误调试实战）
