# 历史消息 Tool Call 重复执行问题

**日期**：2026-02-04  
**问题**：LLM 重复执行历史消息中的 tool call  
**根因**：历史消息中保留了完整的 tool call 格式，LLM 无法区分"已执行"和"待执行"

---

## 问题描述

### 现象

用户发送消息后，LLM 会重复执行历史消息中的 tool call：

```
用户: 你好，请帮我读取 SOUL.md 文件
LLM: [调用 read 工具读取 SOUL.md] ✅

用户: 现在请帮我读取 USER.md 文件
LLM: [调用 read 工具读取 SOUL.md] ❌ 重复执行
LLM: [调用 read 工具读取 USER.md] ✅
```

### 根本原因

1. **API 格式混淆**
   - 使用 Gemini 模型，但通过 OpenAI 兼容接口（vectorengine）
   - 请求格式：OpenAI 格式（`tool_calls`）
   - 响应格式：Gemini 格式（`functionCall`）
   - 历史消息格式：混合格式

2. **历史消息中的 Tool Call**
   - 历史消息中保留了完整的 `functionCall` 格式
   - LLM 看到历史消息中的 `functionCall`，认为是"待执行的工具调用"
   - LLM 无法区分"已执行"和"待执行"

**示例**：
```json
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

LLM 看到这个消息，会认为："哦，我需要调用 read 工具读取 SOUL.md"

---

## 解决方案

### 核心思路

**将历史消息中的 tool call 转换为"伪代码化"的文本描述，而不是保留实际的 tool call 格式。**

### 实现步骤

#### 步骤 1：添加选项参数

在 `convertOpenAIToGeminiFormat` 函数中添加 `markHistoryToolCalls` 选项：

```typescript
function convertOpenAIToGeminiFormat(messages: unknown[], options?: {
  markHistoryToolCalls?: boolean;  // 是否标记历史 tool call
}): unknown[] {
  const markHistory = options?.markHistoryToolCalls ?? false;
  // ...
}
```

#### 步骤 2：转换历史消息中的 tool call

```typescript
// 转换 assistant 消息
if (role === "assistant") {
  const toolCalls = msgRec.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    // 如果是历史消息，转换为文本描述
    if (markHistory) {
      const toolCallDescriptions = toolCalls
        .map((tc) => {
          const name = typeof funcRec.name === "string" ? funcRec.name : "unknown";
          const argsStr = typeof funcRec.arguments === "string" ? funcRec.arguments : "{}";
          return `[已执行工具调用] ${name}(${argsStr})`;
        })
        .filter(Boolean)
        .join("\n");
      
      return {
        role: "model",
        parts: [{ text: toolCallDescriptions }],
      };
    }
    
    // 当前消息：保留完整的 functionCall 格式
    // ...
  }
}
```

#### 步骤 3：转换历史消息中的 tool result

```typescript
// 转换 tool 消息（OpenAI 格式）
if (role === "tool") {
  // ...
  
  // 如果是历史消息，转换为文本描述
  if (markHistory) {
    const resultText = typeof response === "object" && response !== null
      ? JSON.stringify(response, null, 2)
      : String(response);
    
    return {
      role: "user",
      parts: [{ text: `[工具执行结果] ${name}:\n${resultText}` }],
    };
  }
  
  // 当前消息：保留完整的 functionResponse 格式
  // ...
}
```

#### 步骤 4：区分历史消息和当前消息

在构建 payload 时，区分历史消息和当前消息：

```typescript
// 找到最后一条用户消息的索引
let lastUserIndex = -1;
for (let i = messages.length - 1; i >= 0; i--) {
  const msg = messages[i] as any;
  if (msg?.role === "user") {
    lastUserIndex = i;
    break;
  }
}

const convertedMessages = messages.map((msg, index) => {
  // 判断是否是历史消息
  const isHistory = index < lastUserIndex;
  
  // 转换消息
  return convertOpenAIToGeminiFormat([msg], {
    markHistoryToolCalls: isHistory,  // 历史消息标记 tool call
  })[0];
});
```

---

## 效果对比

### 修复前

**历史消息**：
```json
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

**问题**：LLM 看到 `functionCall`，认为需要执行

### 修复后

**历史消息**：
```json
{
  "role": "model",
  "parts": [
    { "text": "[已执行工具调用] read({\"path\":\"SOUL.md\"})" }
  ]
}
```

**效果**：LLM 看到的是文本描述，不会重复执行

---

## 验证方法

### 方法 1：查看 trace 日志

```powershell
# 发送测试消息
pnpm clawdbot message send "你好，请帮我读取 SOUL.md 文件"

# 查看最新的 trace 日志
$trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }

# 检查第二个 payload（应该包含文本描述）
$payloads[1].payload.payload.messages | ConvertTo-Json -Depth 10
```

### 方法 2：观察 LLM 行为

1. 发送第一条消息："你好，请帮我读取 SOUL.md 文件"
2. 观察 LLM 是否调用 read 工具
3. 发送第二条消息："现在请帮我读取 USER.md 文件"
4. 观察 LLM 是否重复调用 read 工具读取 SOUL.md

**预期结果**：
- 第一轮：LLM 调用 read 工具读取 SOUL.md ✅
- 第二轮：LLM 只调用 read 工具读取 USER.md，不会重复读取 SOUL.md ✅

---

## 关键教训

### 1. 历史消息和当前消息必须区分

**问题**：LLM 无法区分"已执行"和"待执行"的 tool call

**解决**：
- 历史消息：已执行的 tool call，转换为文本描述
- 当前消息：待执行的 tool call，保留完整格式

### 2. API 格式混淆是根本问题

**问题**：vectorengine 声称 OpenAI 兼容，但实际上期望 Gemini 格式

**解决**：
- 在发送前转换格式
- 区分历史消息和当前消息

### 3. 伪代码化是最佳方案

**优点**：
- 保留了工具调用的信息（用于上下文理解）
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

### 4. 兼容性问题

**问题**：`findLastIndex` 需要 ES2023

**解决**：使用 for 循环替代
```typescript
// ❌ 不兼容 ES2022
const lastUserIndex = messages.findLastIndex((msg: any) => msg?.role === "user");

// ✅ 兼容 ES2022
let lastUserIndex = -1;
for (let i = messages.length - 1; i >= 0; i--) {
  const msg = messages[i] as any;
  if (msg?.role === "user") {
    lastUserIndex = i;
    break;
  }
}
```

---

## 相关问题

### 问题 1：如何判断是否是历史消息？

**方法**：找到最后一条用户消息的索引，之前的都是历史消息

**原因**：
- 最后一条用户消息是"当前消息"
- 之前的消息都是"历史消息"

### 问题 2：为什么不在 session 中标记历史消息？

**原因**：
- session 是持久化存储，不应该包含临时标记
- 格式转换应该在发送前进行，不应该修改 session

### 问题 3：为什么不使用 Gemini 官方 API？

**原因**：
- 用户使用的是 vectorengine 中转 API
- 切换到官方 API 需要用户配置

---

## 适用场景

### 适用

- ✅ 使用 OpenAI 兼容接口的 Gemini 模型
- ✅ 历史消息中包含 tool call
- ✅ LLM 重复执行历史消息中的 tool call

### 不适用

- ❌ 使用 Gemini 官方 API（不需要格式转换）
- ❌ 使用 OpenAI 官方 API（不需要格式转换）
- ❌ 历史消息中不包含 tool call

---

## 实施清单

- [x] 修改 `convertOpenAIToGeminiFormat` 函数签名
- [x] 添加 `markHistoryToolCalls` 选项
- [x] 修改 assistant 消息转换逻辑
- [x] 修改 tool 消息转换逻辑
- [x] 修改 payload 构建逻辑
- [x] 构建验证
- [ ] 测试验证
- [ ] 更新文档

---

**版本**：v20260204_1  
**文件**：`src/agents/gemini-payload-thought-signature.ts`  
**关键词**：历史消息、tool call、重复执行、格式转换、伪代码化、OpenAI 兼容 API、Gemini 格式
