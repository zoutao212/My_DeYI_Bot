# Hook 副作用检测模式

**日期**：2026-02-04  
**问题**：Hook 会影响所有消息，导致队列任务行为异常

---

## 问题场景

### 典型问题

当系统使用 Hook 机制时，Hook 会对所有消息生效，包括：
- 用户直接发送的消息
- 队列任务（`enqueue_task` 创建的任务）
- 原始用户消息在队列中（`collect` 模式）

**结果**：Hook 修改了队列任务的 prompt，导致 LLM 行为异常。

### 实战案例

**场景**：Pipeline Hook 在 `before_agent_start` 中添加 `prependContext`

```typescript
// Pipeline Hook
return {
  prependContext: `\n\n🔵 [Pipeline Active] 动态管道已激活，使用默认系统提示词\n`,
};
```

**问题**：
1. 用户消息："请帮我生成 5 段内容"
2. LLM 调用 `enqueue_task` 5 次，创建 5 个队列任务
3. 队列任务 1 的 prompt："请生成第 1 段内容..."
4. **Pipeline Hook 触发**，添加 `prependContext`
5. LLM 看到的 prompt：
   ```
   🔵 [Pipeline Active] 动态管道已激活，使用默认系统提示词
   
   请生成第 1 段内容...
   ```
6. **但是**，如果是 `collect` 模式，原始用户消息也会被加入队列
7. 原始用户消息在队列中执行时，LLM 看到的是：
   ```
   🔵 [Pipeline Active] 动态管道已激活，使用默认系统提示词
   
   请帮我生成 5 段内容，每段单独回复...
   ```
8. **LLM 又调用了 5 次 `enqueue_task`** ❌

---

## 根本原因

### 原因 1：Hook 没有区分消息类型

Hook 对所有消息生效，没有区分：
- 用户消息（应该添加 `prependContext`）
- 队列任务（不应该添加 `prependContext`）
- 原始用户消息在队列中（不应该添加 `prependContext`）

### 原因 2：`collect` 模式的副作用

`collect` 模式会将原始用户消息也加入队列：

```typescript
const shouldFollowup =
  resolvedQueue.mode === "followup" ||
  resolvedQueue.mode === "collect" ||
  resolvedQueue.mode === "steer-backlog";
```

**结果**：原始用户消息在队列中执行时，LLM 会重复执行。

### 原因 3：队列任务的 prompt 被修改

Hook 修改了队列任务的 prompt，导致 LLM 看到的不是纯净的任务描述，而是包含了额外的上下文。

---

## 解决方案

### 核心思路

**在 Hook 中检测消息类型，针对不同类型采取不同策略。**

### 实施步骤

#### 步骤 1：识别消息类型

**方法 1：检测队列任务**

队列任务的 prompt 通常以"请生成第 X 段"开头：

```typescript
const isQueueTask = /^请生成第\s*\d+\s*段/.test(userMessage);
```

**方法 2：检测原始用户消息在队列中**

原始用户消息在队列中包含 `[message_id: ...]`：

```typescript
const isOriginalUserMessageInQueue = userMessage.includes("[message_id:");
```

#### 步骤 2：跳过修改

如果是队列任务或原始用户消息在队列中，跳过修改：

```typescript
if (isQueueTask) {
  log.info("🔵 [Pipeline] ⚠️ Detected queue task, skipping character detection");
  return undefined; // 不修改 prompt
}

if (isOriginalUserMessageInQueue) {
  log.info("🔵 [Pipeline] ⚠️ Detected original user message in queue, skipping modification");
  return undefined; // 不修改 prompt
}
```

#### 步骤 3：验证

**验证方法**：
1. 发送用户消息："请生成 3 段内容"
2. 观察 LLM 是否调用 `enqueue_task` 3 次
3. 观察队列任务是否正确执行
4. 观察 LLM 是否重复调用 `enqueue_task`

**预期结果**：
- 用户消息：LLM 调用 `enqueue_task` 3 次 ✅
- 队列任务：LLM 直接生成内容，不调用 `enqueue_task` ✅
- 原始用户消息在队列中：LLM 不重复调用 `enqueue_task` ✅

---

## 完整示例

### 修复前（错误）

```typescript
// Pipeline Hook
api.on("before_agent_start", async (event, ctx) => {
  const userMessage = event.prompt || "";
  
  // 检测角色
  let detectedCharacter: string | undefined;
  if (userMessage.includes("栗娜")) {
    detectedCharacter = "lina";
  }
  
  // 返回结果（所有消息都会添加 prependContext）
  if (detectedCharacter) {
    return {
      characterName: detectedCharacter,
      prependContext: `\n\n🔵 [Pipeline Active] 角色：${detectedCharacter}\n`,
    };
  }
  
  return {
    prependContext: `\n\n🔵 [Pipeline Active] 使用默认系统提示词\n`,
  };
});
```

**问题**：
- 队列任务也会添加 `prependContext` ❌
- 原始用户消息在队列中也会添加 `prependContext` ❌
- LLM 会重复执行 ❌

### 修复后（正确）

```typescript
// Pipeline Hook
api.on("before_agent_start", async (event, ctx) => {
  const userMessage = event.prompt || "";
  
  // 🔧 检测消息类型
  const isQueueTask = /^请生成第\s*\d+\s*段/.test(userMessage);
  const isOriginalUserMessageInQueue = userMessage.includes("[message_id:");
  
  // 🔧 跳过队列任务和原始用户消息在队列中
  if (isQueueTask) {
    log.info("🔵 [Pipeline] ⚠️ Detected queue task, skipping character detection");
    return undefined;
  }
  
  if (isOriginalUserMessageInQueue) {
    log.info("🔵 [Pipeline] ⚠️ Detected original user message in queue, skipping modification");
    return undefined;
  }
  
  // 检测角色
  let detectedCharacter: string | undefined;
  if (userMessage.includes("栗娜")) {
    detectedCharacter = "lina";
  }
  
  // 返回结果（只对用户消息添加 prependContext）
  if (detectedCharacter) {
    return {
      characterName: detectedCharacter,
      prependContext: `\n\n🔵 [Pipeline Active] 角色：${detectedCharacter}\n`,
    };
  }
  
  return {
    prependContext: `\n\n🔵 [Pipeline Active] 使用默认系统提示词\n`,
  };
});
```

**效果**：
- 用户消息：添加 `prependContext` ✅
- 队列任务：不添加 `prependContext` ✅
- 原始用户消息在队列中：不添加 `prependContext` ✅
- LLM 不会重复执行 ✅

---

## 通用模式

### 模式：Hook 副作用检测

**适用场景**：
- 使用 Hook 机制修改消息
- 系统支持队列任务
- 系统使用 `collect` 模式

**检测清单**：
- [ ] Hook 是否区分消息类型？
- [ ] 队列任务是否被正确识别？
- [ ] 原始用户消息在队列中是否被正确识别？
- [ ] Hook 是否跳过了不应该修改的消息？

**实施步骤**：
1. 识别消息类型（用户消息、队列任务、原始用户消息在队列中）
2. 在 Hook 中添加检测逻辑
3. 跳过不应该修改的消息
4. 验证 LLM 行为是否正确

---

## 关键教训

### 1. Hook 会影响所有消息

**问题**：Hook 对所有消息生效，包括队列任务

**解决**：在 Hook 中检测消息类型，针对不同类型采取不同策略

### 2. `collect` 模式的副作用

**问题**：`collect` 模式会将原始用户消息也加入队列

**解决**：检测原始用户消息在队列中（包含 `[message_id: ...]`），跳过修改

### 3. 队列任务的 prompt 应该保持纯净

**问题**：Hook 修改了队列任务的 prompt，导致 LLM 行为异常

**解决**：队列任务的 prompt 不应该被修改，保持纯净

### 4. 消息类型识别的重要性

**问题**：没有区分消息类型，导致 Hook 对所有消息生效

**解决**：通过正则表达式或特征字符串识别消息类型

---

## 相关文档

- `.kiro/lessons-learned/81_LLM主动生成连续任务实现方法.md`
- `.kiro/lessons-learned/82_LLM工具调用循环检测模式.md`
- `Runtimelog/tempfile/连续任务完整修复_系统提示词优化_20260204.md`

---

**版本**：v20260204_1  
**最后更新**：2026-02-04  
**关键词**：Hook、副作用、消息类型、队列任务、collect 模式、prependContext、LLM 行为异常
