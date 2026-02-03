---
priority: high
applies_to: provider_compatibility, api_integration
last_updated: 2026-02-03
source: vectorengine_thought_signature_position_issue
---

# Provider 字段位置差异处理方法论

> **背景**：不同 provider 对同一字段的位置要求不同，导致兼容性问题

---

## 问题场景

当集成多个 provider 时，可能遇到：
- **相同的字段名**（如 `thought_signature`）
- **不同的位置要求**
- **不同的格式要求**

### 典型案例：thought_signature 位置差异

**yinli provider**：
```json
{
  "parts": [
    {
      "functionCall": {...},
      "thought_signature": "xxx"  // ✅ 只接受 wrapper 上的
    }
  ]
}
```

**vectorengine provider**：
```json
{
  "parts": [
    {
      "functionCall": {
        "name": "write",
        "args": {...},
        "thought_signature": "xxx"  // ✅ 需要在内部
      },
      "thought_signature": "xxx"  // ✅ wrapper 上也要有
    }
  ]
}
```

---

## 错误的解决方案 ❌

### 方案 1：只添加到一个位置

```typescript
// ❌ 错误：只添加到 wrapper
if (rec.functionCall) {
  rec.thought_signature = "xxx";
  // 不添加到 functionCall 内部
}
```

**问题**：
- yinli 正常 ✅
- vectorengine 报错 ❌（缺少内部的 thought_signature）

### 方案 2：根据 provider 分别处理

```typescript
// ❌ 错误：代码重复，难以维护
if (provider === "yinli") {
  // 只添加到 wrapper
  rec.thought_signature = "xxx";
} else if (provider === "vectorengine") {
  // 添加到 wrapper 和内部
  rec.thought_signature = "xxx";
  rec.functionCall.thought_signature = "xxx";
}
```

**问题**：
- 每增加一个 provider，都要修改代码
- 容易遗漏新的 provider
- 代码重复，难以维护

---

## 正确的解决方案 ✅

### 核心思路：分层处理

1. **先统一添加**（所有位置，所有 provider）
2. **再根据 provider 清理**（移除不需要的位置）

### 实现步骤

#### 步骤 1：统一添加（所有位置）

```typescript
function walkAndPatch(value: unknown) {
  // 添加到 wrapper
  if (rec.functionCall) {
    rec.thought_signature = "xxx";
    rec.thoughtSignature = "xxx";
    
    // 添加到 functionCall 内部
    rec.functionCall.thought_signature = "xxx";
    rec.functionCall.thoughtSignature = "xxx";
  }
}
```

#### 步骤 2：根据 provider 清理

```typescript
// 对于 yinli，移除内部的 thought_signature
if (provider.includes("yinli")) {
  function stripInnerThoughtSignatures(value: unknown) {
    if (rec.functionCall) {
      delete rec.functionCall.thought_signature;
      delete rec.functionCall.thoughtSignature;
    }
    // 递归处理所有子对象
  }
  
  stripInnerThoughtSignatures(payload);
}
```

### 完整流程

```typescript
// 1. 先统一添加（所有位置）
walkAndPatch(payload);

// 2. 再根据 provider 清理
if (provider.includes("yinli")) {
  stripInnerThoughtSignatures(payload);
}
```

---

## 优势

### 1. 可扩展性

新增 provider 时，只需要：
- 如果需要所有位置：不需要修改代码 ✅
- 如果需要特殊处理：只需要添加清理逻辑 ✅

### 2. 可维护性

- 添加逻辑统一（`walkAndPatch`）
- 清理逻辑独立（`stripInnerThoughtSignatures`）
- 职责清晰，易于理解

### 3. 容错性

- 默认添加所有位置，不会遗漏
- 只有明确不需要的，才清理
- 降低出错概率

---

## 通用模式

### 适用场景

当遇到以下情况时，使用分层处理：
- 多个 provider 对同一字段的位置要求不同
- 多个 provider 对同一字段的格式要求不同
- 需要兼容多个 API 版本

### 通用流程

```typescript
// 1. 统一处理（最宽松的要求）
applyMaximalFormat(payload);

// 2. 根据 provider 调整
if (needsSpecialHandling(provider)) {
  adjustForProvider(payload, provider);
}
```

---

## 实战案例

### 案例 1：thought_signature 位置差异

**问题**：
- yinli：只接受 wrapper 上的 `thought_signature`
- vectorengine：需要 `functionCall` 内部的 `thought_signature`

**解决**：
1. 统一添加到所有位置
2. 对 yinli 清理内部的 `thought_signature`

**结果**：
- yinli：wrapper 上有，内部没有 ✅
- vectorengine：wrapper 和内部都有 ✅

### 案例 2：systemInstruction 格式差异

**问题**：
- 官方 API：接受 `string` 格式
- yinli：只接受 `{parts: [{text: "..."}]}` 格式

**解决**：
1. 统一转换为 `{parts: [{text: "..."}]}` 格式
2. 对官方 API，保持 `string` 格式（不需要清理）

**结果**：
- 官方 API：`string` 格式 ✅
- yinli：`{parts: [{text: "..."}]}` 格式 ✅

---

## 调试检查清单

当遇到字段位置差异问题时：

- [ ] **识别所有 provider 的要求**：列出每个 provider 对字段位置的要求
- [ ] **找到最宽松的要求**：确定需要添加字段的所有位置
- [ ] **统一添加**：在所有位置添加字段
- [ ] **识别特殊 provider**：找出需要特殊处理的 provider
- [ ] **添加清理逻辑**：为特殊 provider 添加清理逻辑
- [ ] **验证所有 provider**：测试所有 provider，确认都能正常工作

---

## 关键教训

1. **不要假设所有 provider 的要求相同**
   - 即使字段名相同，位置可能不同
   - 即使格式相同，验证规则可能不同

2. **优先使用分层处理**
   - 先统一添加（最宽松）
   - 再根据需要清理（特殊处理）

3. **记录每个 provider 的特殊要求**
   - 在代码注释中说明原因
   - 在文档中记录差异

4. **测试所有 provider**
   - 不要只测试一个 provider
   - 确保修改不会破坏其他 provider

5. **API 错误信息可能不准确**
   - 不要只看错误信息
   - 要对比成功和失败的 payload
   - 要查看 API 文档确认格式要求

---

## 给未来的自己

当你再次遇到"provider 兼容性问题"时，记住：

**分层处理：先统一添加，再根据需要清理。**

不要试图一次性处理所有 provider 的差异，那样会导致代码复杂且难以维护。

---

**版本：** v20260203_1  
**来源：** vectorengine thought_signature 位置差异调试实战  
**变更：** 新增"Provider 字段位置差异处理方法论"

**关键词**：provider 兼容性、字段位置差异、分层处理、统一添加、选择性清理、thought_signature、functionCall、API 格式差异、多 provider 支持、兼容性设计
