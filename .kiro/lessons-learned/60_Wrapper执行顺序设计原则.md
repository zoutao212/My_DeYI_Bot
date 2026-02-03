# Wrapper 执行顺序设计原则

> **关键词**：Wrapper、洋葱模型、执行顺序、数据流、payload 验证、格式转换、streamFn

---

## 问题场景

当使用 Wrapper 模式（例如 `streamFn` 的多层包装）时，如果包装顺序不当，会导致：
- 验证器在数据修改之前执行，看到错误的格式
- 日志显示"操作成功"，但实际数据没有被修改
- 功能 A 依赖功能 B 的输出，但 A 在 B 之前执行

**典型症状**：
- 日志显示"格式转换成功"，但 payload 仍然是旧格式
- Payload 验证警告："message has no 'content' or 'tool_calls'"
- API 返回格式错误，但本地日志显示格式正确

---

## 根本原因

### Wrapper 的洋葱模型

Wrapper 使用"洋葱模型"：**最后包装的 wrapper 最先执行**。

**示例**：
```typescript
// 包装顺序
streamFn = wrapperA(streamFn);  // 内层
streamFn = wrapperB(streamFn);  // 外层

// 执行顺序（洋葱模型）
wrapperB.nextOnPayload() → wrapperA.nextOnPayload() → 原始 streamFn
```

**关键**：包装顺序 ≠ 执行顺序！

### 常见错误

**错误示例**：
```typescript
// ❌ 错误：先包装格式转换，再包装验证
if (formatConverter) {
  streamFn = formatConverter.wrapStreamFn(streamFn);  // 内层
}
if (validator) {
  streamFn = validator.wrapStreamFn(streamFn);  // 外层
}

// 执行顺序：validator → formatConverter
// 结果：验证器看到的是转换前的格式！
```

**正确示例**：
```typescript
// ✅ 正确：先包装验证，再包装格式转换
if (validator) {
  streamFn = validator.wrapStreamFn(streamFn);  // 内层
}
if (formatConverter) {
  streamFn = formatConverter.wrapStreamFn(streamFn);  // 外层
}

// 执行顺序：formatConverter → validator
// 结果：验证器看到的是转换后的格式！
```

---

## 设计原则

### 原则 1：数据修改在验证之前

**规则**：所有修改 payload 的 wrapper 必须在验证 payload 的 wrapper 之前执行。

**原因**：验证器应该看到最终发送给 API 的格式，而不是中间状态。

**示例**：
```typescript
// 正确顺序（从内到外）
streamFn = validator.wrapStreamFn(streamFn);        // 最内层：验证
streamFn = formatConverter.wrapStreamFn(streamFn); // 外层：格式转换
streamFn = logger.wrapStreamFn(streamFn);          // 最外层：日志

// 执行顺序（从外到内）
logger → formatConverter → validator → 原始 streamFn
```

### 原则 1.5：nextOnPayload 内部执行顺序 ⚠️ **新增**

**规则**：在 `nextOnPayload` 内部，必须先调用 `options?.onPayload?.(payload)`，再执行本 wrapper 的逻辑。

**原因**：`options?.onPayload?.()` 会触发下一个 wrapper 的 `nextOnPayload`，如果先执行本 wrapper 的逻辑（如验证），会看到下游 wrapper 处理前的数据。

**错误示例**：
```typescript
// ❌ 错误：先验证，再调用下一个 wrapper
const nextOnPayload = (payload: unknown) => {
  // 1. 先验证（此时还是 OpenAI 格式）
  const validation = validateAndLogPayload({ payload, ... });
  
  // 2. 再调用下一个 wrapper（格式转换）
  options?.onPayload?.(payload);
};

// 结果：验证器看到的是转换前的格式！
```

**正确示例**：
```typescript
// ✅ 正确：先调用下一个 wrapper，再验证
const nextOnPayload = (payload: unknown) => {
  // 1. 先调用下一个 wrapper（格式转换）
  options?.onPayload?.(payload);
  
  // 2. 再验证（此时已经是 Gemini 格式）
  const validation = validateAndLogPayload({ payload, ... });
};

// 结果：验证器看到的是转换后的格式！
```

**关键理解**：
- `options?.onPayload?.(payload)` 不是"发送给 API"
- 而是"调用下一个 wrapper 的 nextOnPayload"
- 所以应该先调用它，让下游 wrapper 处理 payload
- 然后再执行本 wrapper 的逻辑（验证、日志等）

### 原则 2：依赖关系决定顺序

**规则**：如果 wrapper A 依赖 wrapper B 的输出，则 B 必须在 A 之前执行。

**示例**：
```typescript
// thoughtSignature patcher 依赖格式转换的输出
// 所以格式转换必须在 thoughtSignature patcher 之前执行

// 正确顺序
streamFn = thoughtSignaturePatcher.wrapStreamFn(streamFn); // 内层
streamFn = formatConverter.wrapStreamFn(streamFn);         // 外层

// 执行顺序
formatConverter → thoughtSignaturePatcher
```

### 原则 3：日志/监控在最外层

**规则**：日志、监控、trace 等观察性 wrapper 应该在最外层，确保能看到所有修改后的最终状态。

**示例**：
```typescript
// 正确顺序
streamFn = validator.wrapStreamFn(streamFn);        // 最内层
streamFn = formatConverter.wrapStreamFn(streamFn); // 中间层
streamFn = logger.wrapStreamFn(streamFn);          // 最外层

// 执行顺序
logger（看到最终 payload）→ formatConverter → validator
```

---

## 调试方法

### 方法 1：查看包装顺序

在代码中查看 wrapper 的包装顺序：

```typescript
// 在 src/agents/pi-embedded-runner/run/attempt.ts 中
if (geminiPayloadThoughtSignaturePatcher) {
  streamFn = geminiPayloadThoughtSignaturePatcher.wrapStreamFn(streamFn);
}
if (llmCallConsoleLogger) {
  streamFn = llmCallConsoleLogger.wrapStreamFn(streamFn);
}
```

**分析**：
- `geminiPayloadThoughtSignaturePatcher` 先包装（内层）
- `llmCallConsoleLogger` 后包装（外层）
- 执行顺序：`llmCallConsoleLogger` → `geminiPayloadThoughtSignaturePatcher`

### 方法 2：查看日志顺序

观察日志的输出顺序：

```
[format] Converting OpenAI format to Gemini format  ← 应该在前
[payload-validator] ⚠️ Payload validation warnings  ← 应该在后
```

**如果顺序反了**：说明包装顺序错误。

### 方法 3：查看 trace 日志

提取 trace 日志，查看事件顺序：

```powershell
Get-Content "trace__*.jsonl" -Encoding UTF8 | 
  ConvertFrom-Json | 
  Where-Object { $_.event -like "*payload*" -or $_.event -like "*format*" } | 
  Select event, @{N="time";E={Get-Date $_.ts -Format "HH:mm:ss"}}
```

**期望顺序**：
1. `format.convert`（格式转换）
2. `payload.validate`（payload 验证）
3. `llm.payload`（发送给 API）

---

## 实战案例

### 案例：vectorengine API 格式转换

**问题**：
- vectorengine 使用 OpenAI endpoint，但期望 Gemini 格式的 payload
- 格式转换在 `geminiPayloadThoughtSignaturePatcher` 中执行
- Payload 验证在 `llmCallConsoleLogger` 中执行
- 原始包装顺序：先包装格式转换，再包装验证
- 结果：验证器看到的是转换前的 OpenAI 格式

**修复**：
```typescript
// ❌ 错误顺序
if (geminiPayloadThoughtSignaturePatcher) {
  streamFn = geminiPayloadThoughtSignaturePatcher.wrapStreamFn(streamFn);
}
if (llmCallConsoleLogger) {
  streamFn = llmCallConsoleLogger.wrapStreamFn(streamFn);
}

// ✅ 正确顺序
if (llmCallConsoleLogger) {
  streamFn = llmCallConsoleLogger.wrapStreamFn(streamFn);
}
if (geminiPayloadThoughtSignaturePatcher) {
  streamFn = geminiPayloadThoughtSignaturePatcher.wrapStreamFn(streamFn);
}
```

**效果**：
- 格式转换在验证之前执行
- 验证器看到的是转换后的 Gemini 格式
- 不再有 payload 验证警告

---

## 检查清单

设计 Wrapper 顺序时，必须检查：

- [ ] **识别依赖关系**：哪些 wrapper 依赖其他 wrapper 的输出？
- [ ] **确定执行顺序**：根据依赖关系确定正确的执行顺序
- [ ] **反推包装顺序**：根据执行顺序反推包装顺序（洋葱模型）
- [ ] **添加注释**：在代码中添加注释说明包装顺序和执行顺序
- [ ] **验证日志顺序**：运行后查看日志，确认执行顺序正确
- [ ] **验证功能正确性**：确认所有 wrapper 都能正常工作

---

## 常见错误

### 错误 1：忽略洋葱模型

**错误认知**：认为包装顺序就是执行顺序

**正确认知**：包装顺序是反向的（最后包装的最先执行）

### 错误 2：只看局部

**错误做法**：只关注单个 wrapper 的功能，不考虑与其他 wrapper 的交互

**正确做法**：从整体数据流的角度设计 wrapper 顺序

### 错误 3：缺少注释

**错误做法**：代码中没有注释说明包装顺序和执行顺序

**正确做法**：添加清晰的注释，说明为什么这样包装

**示例**：
```typescript
// ⚠️ 重要：wrapper 的嵌套顺序决定了执行顺序
// 最后包装的 wrapper 最先执行（洋葱模型）
// 我们需要：格式转换 → payload 验证 → 发送
// 所以包装顺序应该是：validator → formatConverter
if (validator) {
  streamFn = validator.wrapStreamFn(streamFn);
}
if (formatConverter) {
  streamFn = formatConverter.wrapStreamFn(streamFn);
}
```

---

## 关键教训

1. **Wrapper 使用洋葱模型**：最后包装的最先执行
2. **数据修改在验证之前**：确保验证器看到最终格式
3. **依赖关系决定顺序**：被依赖的 wrapper 先执行
4. **日志/监控在最外层**：确保能看到所有修改
5. **添加清晰注释**：说明包装顺序和执行顺序
6. **验证日志顺序**：确认执行顺序正确

---

## 相关文档

- `.kiro/lessons-learned/59_混合API格式混淆调试方法论.md`：混合 API 格式问题
- `.kiro/lessons-learned/18_修复无效的根因分析方法论.md`：修复无效的调试方法
- `.kiro/lessons-learned/32_数据流断点调试方法论.md`：数据流调试方法

---

**版本：** v20260203_1  
**最后更新：** 2026-02-03  
**来源：** vectorengine API 兼容性问题调试实战  
**变更：** 新增"Wrapper 执行顺序设计原则"
