# API 格式假设错误导致多次修复失败

**日期**：2026-02-03  
**问题类型**：API 调试、格式验证  
**严重程度**：⚠️ 高（导致多次修复失败）

---

## 问题描述

当 API 返回格式错误时，基于错误的假设进行修复，导致多次修复无效。

**典型场景**：
- API 返回错误："contents is required"
- 假设：需要 Gemini 格式（`parts`）
- 修复：添加格式转换代码
- 结果：仍然报错
- 原因：API 实际需要的是标准 OpenAI 格式

---

## 问题演变

### 第 1 次修复：假设需要 Gemini 格式

**假设**：vectorengine 是"Gemini 格式"的 API

**修复**：
```typescript
// 转换为 Gemini 格式
msgRec.parts = [{ text: "..." }];
delete msgRec.content;
```

**结果**：❌ 仍然报错 `contents is required`

### 第 2 次修复：改为 content 数组格式

**假设**：vectorengine 需要 `content` 数组格式

**修复**：
```typescript
// 转换为 content 数组格式
msgRec.content = [{ text: "..." }];
```

**结果**：❌ 仍然报错 `contents is required`

### 第 3 次验证：直接测试 API

**行动**：写一个最小的测试脚本，直接调用 API

**测试 1**：Gemini 格式
```json
{
  "model": "gemini-3-flash-preview",
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "hi" }]
    }
  ]
}
```

**结果**：❌ 报错 `field messages is required`

**测试 2**：标准 OpenAI 格式
```json
{
  "model": "gemini-3-flash-preview",
  "messages": [
    {
      "role": "user",
      "content": "hi"
    }
  ]
}
```

**结果**：✅ 成功！

### 第 4 次修复：禁用格式转换

**发现**：vectorengine 是标准的 OpenAI 兼容接口，不需要格式转换

**修复**：
```typescript
// 禁用 vectorengine 的格式转换
if (effectiveProvider.includes("vectorengine")) {
  return false;
}
```

**结果**：✅ 修复成功

---

### 第 4 次修复：禁用 Patcher（最终方案）

**发现**：vectorengine 是标准的 OpenAI 兼容接口，不需要任何特殊处理

**修复**：
```typescript
// 在 shouldEnable 函数中禁用 vectorengine 的 Patcher
if (effectiveProvider.includes("vectorengine")) {
  log.info(
    `[thought_signature] Disabled for vectorengine provider (standard OpenAI format, no conversion needed)`,
  );
  return false;
}
```

**效果**：
- vectorengine 不会进入 `wrapStreamFn`
- 不会执行格式转换
- 保持标准的 OpenAI 格式
- ✅ 单次和多轮对话都成功

**为什么这是最佳方案**：
1. **最简单**：只需要一行判断，禁用整个 Patcher
2. **最安全**：不修改格式，保持标准 OpenAI 格式
3. **最彻底**：从源头解决问题，不需要后续修复
4. **最可维护**：代码清晰，逻辑简单

---

## 根本原因

### 1. 没有验证 API 的真实行为

**错误做法**：
- 看到错误信息 `contents is required`
- 假设需要 Gemini 格式
- 直接修改代码

**正确做法**：
- 看到错误信息
- **先写测试脚本，直接调用 API**
- 测试不同的格式
- 确认 API 的真实格式要求
- 再修改代码

### 2. 基于错误的假设修复

**错误假设**：
- "OpenAI 兼容接口" = "Gemini 格式"
- "contents is required" = "需要 contents 字段"

**正确理解**：
- "OpenAI 兼容接口" = "标准 OpenAI 格式"
- "contents is required" = "API 内部错误，实际需要 messages 字段"

### 3. 没有对比成功和失败的请求

**错误做法**：
- 只看失败的请求
- 猜测可能的原因
- 尝试修复

**正确做法**：
- 找到一个成功的请求示例
- 对比成功和失败的请求格式
- 找出真正的差异
- 针对性修复

---

## 标准调试流程

### 第一步：直接测试 API

**不要修改代码，先测试 API！**

```javascript
// 写一个最小的测试脚本
const payload = {
  model: 'xxx',
  messages: [
    {
      role: 'user',
      content: 'hi'
    }
  ]
};

const response = await fetch('https://api.xxx.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify(payload)
});

console.log('Status:', response.status);
console.log('Body:', await response.text());
```

### 第二步：测试不同的格式

**测试多种可能的格式**：

1. **标准 OpenAI 格式**：
   ```json
   {
     "messages": [
       { "role": "user", "content": "hi" }
     ]
   }
   ```

2. **Gemini 格式**：
   ```json
   {
     "contents": [
       { "role": "user", "parts": [{ "text": "hi" }] }
     ]
   }
   ```

3. **混合格式**：
   ```json
   {
     "messages": [
       { "role": "user", "content": [{ "text": "hi" }] }
     ]
   }
   ```

### 第三步：确认成功的格式

**找到成功的格式后，记录下来**：

```markdown
## vectorengine API 格式要求

**成功的格式**：
- Endpoint: `/v1/chat/completions`
- 格式：标准 OpenAI 格式
- messages: 必需
- content: 字符串（不是数组）

**示例**：
{
  "model": "gemini-3-flash-preview",
  "messages": [
    { "role": "user", "content": "hi" }
  ]
}
```

### 第四步：修改代码

**基于测试结果修改代码**：

```typescript
// 禁用 vectorengine 的格式转换
if (effectiveProvider.includes("vectorengine")) {
  log.debug(`[format] vectorengine uses standard OpenAI format, no conversion needed`);
  return false;
}
```

### 第五步：验证修复

**验证修复是否生效**：

1. 构建代码
2. 重启服务
3. 发送测试消息
4. 检查日志
5. 确认 API 调用成功

---

## 关键教训

### 1. 不要基于假设修复

**错误**：
- 看到错误信息
- 猜测可能的原因
- 直接修改代码

**正确**：
- 看到错误信息
- **先测试 API**
- 确认真实原因
- 再修改代码

### 2. 不要相信错误信息

**错误信息可能不准确**：
- API 说 `contents is required`
- 实际需要的是 `messages` 字段
- 错误信息指向的是内部实现细节

**正确做法**：
- 不要只看错误信息
- 直接测试 API
- 找到成功的格式

### 3. 不要假设"兼容"的含义

**错误假设**：
- "OpenAI 兼容接口" = "Gemini 格式"
- "兼容" = "需要特殊格式"

**正确理解**：
- "OpenAI 兼容接口" = "标准 OpenAI 格式"
- "兼容" = "不需要特殊处理"

### 4. 先测试，再修复

**标准流程**：
1. 遇到 API 错误
2. **写测试脚本，直接调用 API**
3. 测试不同的格式
4. 找到成功的格式
5. 修改代码
6. 验证修复

**不要跳过第 2-4 步！**

---

## 实战案例

### 案例：vectorengine API 格式错误

**问题**：
- API 返回错误：`contents is required`
- 假设：需要 Gemini 格式
- 修复：添加格式转换代码
- 结果：仍然报错

**正确流程**：

1. **写测试脚本**：
   ```javascript
   // test_vectorengine_api.mjs
   const payload = {
     model: 'gemini-3-flash-preview',
     messages: [
       { role: 'user', content: 'hi' }
     ]
   };
   
   const response = await fetch('https://api.vectorengine.ai/v1/chat/completions', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'Authorization': `Bearer ${apiKey}`
     },
     body: JSON.stringify(payload)
   });
   
   console.log('Status:', response.status);
   console.log('Body:', await response.text());
   ```

2. **测试标准 OpenAI 格式**：
   ```json
   {
     "model": "gemini-3-flash-preview",
     "messages": [
       { "role": "user", "content": "hi" }
     ]
   }
   ```
   
   **结果**：✅ 成功！

3. **修改代码**：
   ```typescript
   // 禁用 vectorengine 的格式转换
   if (effectiveProvider.includes("vectorengine")) {
     return false;
   }
   ```

4. **验证修复**：
   - 构建代码
   - 重启服务
   - 发送测试消息
   - ✅ 成功！

---

## 检查清单

### 遇到 API 错误时

- [ ] **不要立即修改代码**
- [ ] **写一个最小的测试脚本**
- [ ] **直接调用 API**
- [ ] **测试不同的格式**
- [ ] **找到成功的格式**
- [ ] **记录 API 的格式要求**
- [ ] **修改代码**
- [ ] **验证修复**

### 修复后验证

- [ ] **构建代码**
- [ ] **重启服务**
- [ ] **发送测试消息**
- [ ] **检查日志**
- [ ] **确认 API 调用成功**
- [ ] **记录修复过程**

---

## 相关文档

- `.kiro/lessons-learned/70_LLM行为异常的完整调试流程.md` - LLM 行为异常调试
- `.kiro/lessons-learned/39_中转API错误调试方法论.md` - 中转 API 错误调试
- `.kiro/lessons-learned/59_混合API格式混淆调试方法论.md` - 混合 API 格式混淆

---

**版本**：v20260203_1  
**最后更新**：2026-02-03  
**关键词**：API 格式、假设错误、直接测试、OpenAI 兼容、Gemini 格式、vectorengine、多次修复失败、测试脚本

