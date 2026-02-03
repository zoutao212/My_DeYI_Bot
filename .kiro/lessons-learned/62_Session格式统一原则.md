# Session 格式统一原则

**日期**：2026-02-03  
**问题类型**：API 兼容性、格式转换、Session 管理

---

## 问题现象

当系统支持多种 API 格式时（OpenAI、Gemini），如果 session 中混合保存不同格式，会导致格式转换混乱，API 拒绝请求。

**典型症状**：
- seq=1 成功，seq=2 失败
- API 返回格式错误
- 重试后仍然失败

---

## 问题根因

1. **API 返回的格式被直接保存到 session**
2. **下次请求时，又当作原始格式来转换**
3. **导致重复转换或格式错误**

### 数据流分析

```
❌ 错误的数据流：

seq=1: 用户消息（OpenAI 格式）
  → 转换为 Gemini 格式
  → 发送给 API
  → API 返回 Gemini 格式
  → ❌ 直接保存到 session（格式错误）

seq=2: 读取 session（Gemini 格式）
  → ❌ 再次转换为 Gemini 格式（重复转换）
  → 发送给 API
  → API 拒绝（格式错误）
```

---

## 解决方案

### Session 格式统一原则

**核心原则**：Session 中只保存一种格式（推荐 OpenAI 格式）

#### 1. Session 中只保存一种格式

**推荐**：OpenAI 格式

**原因**：
- OpenAI 格式是标准格式
- 大多数 API 都支持 OpenAI 格式
- 便于调试和维护

#### 2. 发送前转换

**位置**：发送给 API 之前

**逻辑**：
```typescript
// 根据 provider 转换为对应格式
if (provider.includes("vectorengine")) {
  payload.messages = convertOpenAIToGeminiFormat(payload.messages);
}
```

#### 3. 保存前转换

**位置**：保存到 session 之前

**逻辑**：
```typescript
// 转换回统一格式
if (provider.includes("vectorengine")) {
  message = convertGeminiToOpenAIFormat(message);
}
session.append(message);
```

#### 4. 双向转换

**必须实现**：
- `convertOpenAIToGeminiFormat`（发送前）
- `convertGeminiToOpenAIFormat`（保存前）

**关键点**：
- 转换必须是可逆的
- 不能丢失信息
- 必须处理所有字段

---

## 实现细节

### 格式转换函数

**文件**：`src/agents/gemini-payload-thought-signature.ts`

**OpenAI → Gemini**：
```typescript
function convertOpenAIToGeminiFormat(messages: unknown[]): unknown[] {
  // role: "assistant" → role: "model"
  // tool_calls → parts[].functionCall
  // role: "tool" → role: "user"
  // content → parts[].functionResponse
}
```

**Gemini → OpenAI**：
```typescript
function convertGeminiToOpenAIFormat(message: unknown): unknown {
  // role: "model" → role: "assistant"
  // parts[].functionCall → tool_calls
  // role: "function" → role: "tool"
  // parts[].functionResponse → content
}
```

### 保存前转换

**文件**：`src/agents/session-tool-result-guard.ts`

**位置**：`guardedAppend` 函数开头

```typescript
const guardedAppend = (message: AgentMessage) => {
  // 转换回统一格式
  if (provider && provider.toLowerCase().includes("vectorengine")) {
    message = convertGeminiToOpenAIFormat(message) as AgentMessage;
    log.debug(`[guard] Converted Gemini format to OpenAI format for vectorengine`);
  }
  
  // 后续处理...
};
```

### 发送前转换

**文件**：`src/agents/gemini-payload-thought-signature.ts`

**位置**：`wrapStreamFn` 函数中的 `nextOnPayload`

```typescript
const nextOnPayload = (payload: unknown) => {
  // 转换为 Gemini 格式
  if (provider.includes("vectorengine")) {
    payloadObj.messages = convertOpenAIToGeminiFormat(messages);
  }
  
  // 后续处理...
};
```

---

## 验证方法

### 1. 检查 session 中的格式

```powershell
# 读取 session 文件
$session = Get-Content "C:\Users\zouta\.clawdbot\agents\main\sessions\xxx.jsonl" -Encoding UTF8 | ConvertFrom-Json

# 检查消息格式
$session | Where-Object { $_.role -eq "model" }  # 应该没有
$session | Where-Object { $_.role -eq "assistant" }  # 应该有
```

### 2. 检查 trace 日志

```powershell
# 提取 payload
$trace = Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }

# 检查发送前的格式
$payloads[0].payload.payload.messages | Select role
```

### 3. 验证转换是否生效

**检查点**：
- ✅ Session 中只有 OpenAI 格式（`role: "assistant"`、`tool_calls`）
- ✅ 发送给 API 的是 Gemini 格式（`role: "model"`、`parts`）
- ✅ seq=2、seq=3 都能成功

---

## 常见错误

### 错误 1：只转换发送，不转换保存

**问题**：API 返回的格式被直接保存到 session

**后果**：下次请求时格式混乱

**解决**：在保存前转换回统一格式

### 错误 2：重复转换

**问题**：session 中已经是 Gemini 格式，又当作 OpenAI 格式来转换

**后果**：格式完全错误，API 拒绝

**解决**：确保 session 中只保存一种格式

### 错误 3：转换不完整

**问题**：只转换了部分字段，遗漏了关键字段

**后果**：API 返回格式错误

**解决**：实现完整的双向转换，处理所有字段

---

## 适用场景

**当系统需要支持多种 API 格式时**：
- OpenAI Completions API
- Gemini API
- Claude API
- 其他自定义 API

**关键判断**：
- 如果 API 返回的格式与 session 格式不同
- 必须在保存前转换回统一格式

---

## 关键教训

1. **Session 格式必须统一**
   - 不能混合 OpenAI 和 Gemini 格式
   - 必须在保存前统一格式

2. **格式转换必须双向**
   - OpenAI → Gemini（发送前）
   - Gemini → OpenAI（保存前）

3. **不要重复转换**
   - 如果 session 中已经是统一格式，只需转换一次

4. **验证数据流的每个环节**
   - 不要只看"发送成功"
   - 要验证"保存的格式"
   - 要验证"读取的格式"

5. **转换必须是可逆的**
   - 不能丢失信息
   - 必须处理所有字段
   - 必须保持语义一致

---

## 相关文档

- `.kiro/lessons-learned/59_混合API格式混淆调试方法论.md`
- `.kiro/lessons-learned/60_Wrapper执行顺序设计原则.md`
- `.kiro/lessons-learned/61_验证器与格式转换的协同设计.md`

---

**版本**：v20260203_1  
**来源**：vectorengine API 兼容性问题调试实战  
**关键词**：session、格式统一、API 兼容性、格式转换、OpenAI、Gemini、双向转换、数据流、保存前转换、发送前转换
