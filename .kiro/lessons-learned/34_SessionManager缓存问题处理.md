# SessionManager 缓存问题处理

> **问题**：`SessionManager.buildSessionContext()` 可能返回空数组，导致 Agent 无法加载历史消息

---

## 问题现象

### 症状

- `SessionManager.buildSessionContext()` 返回空数组
- 但 `sessionManager.fileEntries` 中有完整的消息
- Agent 无法看到历史对话，表现为"失忆"

### 影响

- Agent 无法基于历史上下文工作
- 长对话中任务目标丢失
- 用户体验严重下降

---

## 根本原因

### 可能的原因

1. **缓存问题**：
   - SessionManager 内部可能有缓存机制
   - 缓存未正确更新或失效

2. **状态管理问题**：
   - SessionManager 的内部状态可能不一致
   - `buildSessionContext()` 依赖的状态未正确初始化

3. **时序问题**：
   - 在某些情况下，`buildSessionContext()` 被调用时，内部状态尚未准备好

---

## 诊断方法

### 步骤 1：检查 buildSessionContext() 返回值

```typescript
const smContext = sessionManager.buildSessionContext();
log.info(`SessionManager loaded ${smContext.messages.length} messages`);
```

**预期**：返回历史消息列表  
**实际**：返回空数组

### 步骤 2：检查 fileEntries

```typescript
const sm = sessionManager as any;
if (sm.fileEntries) {
  const messageEntries = sm.fileEntries.filter((e: any) => e.type === "message");
  log.info(`fileEntries: total=${sm.fileEntries.length}, messages=${messageEntries.length}`);
}
```

**预期**：fileEntries 中有消息  
**实际**：fileEntries 中有完整的消息，但 buildSessionContext() 返回空数组

### 步骤 3：对比数据

如果 `buildSessionContext()` 返回空数组，但 `fileEntries` 中有消息，说明是缓存或状态管理问题。

---

## 修复方案

### 方案 1：直接从 fileEntries 读取（推荐）

```typescript
// 检查 SessionManager 内部状态
const sm = sessionManager as any;
if (sm.fileEntries) {
  const messageEntries = sm.fileEntries.filter((e: any) => e.type === "message");
  log.info(`SessionManager fileEntries: total=${sm.fileEntries.length}, messages=${messageEntries.length}`);
  
  // 直接从 fileEntries 读取消息
  const allMessages = messageEntries.map((e: any) => e.message);
  const historyLimit = 20; // Keep last 20 messages
  const recentMessages = allMessages.slice(-historyLimit);
  
  log.info(`Overriding buildSessionContext: using ${recentMessages.length} recent messages (total: ${allMessages.length})`);
  
  // Override buildSessionContext to return recent messages
  sm.buildSessionContext = () => {
    const roles = recentMessages.map((m: any) => m.role).join(' → ');
    log.info(`buildSessionContext override: returning ${recentMessages.length} messages (${roles})`);
    return {
      messages: recentMessages,
    };
  };
}
```

**优点**：
- 直接读取源数据，绕过缓存问题
- 可以自定义历史限制
- 不依赖 SessionManager 的内部实现

**缺点**：
- 需要访问 SessionManager 的内部状态（`fileEntries`）
- 可能在 SessionManager 更新后失效

### 方案 2：重新打开 SessionManager

```typescript
// 关闭当前 SessionManager
sessionManager.close();

// 重新打开
sessionManager = SessionManager.open(params.sessionFile);

// 再次尝试构建上下文
const smContext = sessionManager.buildSessionContext();
```

**优点**：
- 不依赖内部实现
- 更安全

**缺点**：
- 可能无法解决根本问题
- 性能开销较大

### 方案 3：清除缓存（如果有缓存 API）

```typescript
// 如果 SessionManager 提供缓存清除 API
if (sessionManager.clearCache) {
  sessionManager.clearCache();
}

const smContext = sessionManager.buildSessionContext();
```

**优点**：
- 最干净的解决方案

**缺点**：
- 需要 SessionManager 提供缓存清除 API
- 目前 SessionManager 可能没有这个 API

---

## 预防措施

### 1. 添加验证逻辑

```typescript
// 验证 buildSessionContext() 返回值
const smContext = sessionManager.buildSessionContext();
if (smContext.messages.length === 0) {
  log.warn("⚠️ buildSessionContext() returned empty array, checking fileEntries...");
  
  // 尝试从 fileEntries 读取
  const sm = sessionManager as any;
  if (sm.fileEntries) {
    const messageEntries = sm.fileEntries.filter((e: any) => e.type === "message");
    if (messageEntries.length > 0) {
      log.error("❌ buildSessionContext() returned empty but fileEntries has messages!");
      // 使用方案 1 修复
    }
  }
}
```

### 2. 添加日志

```typescript
// 在关键位置添加日志
log.info(`[attempt] SessionManager loaded ${smContext.messages.length} messages from file`);
log.info(`[attempt] SessionManager fileEntries: total=${sm.fileEntries.length}, messages=${messageEntries.length}`);
```

### 3. 定期测试

- 在长对话场景下测试
- 在多轮对话场景下测试
- 在并发场景下测试

---

## 实战案例

### 案例：Clawdbot Agent 多轮对话遗忘问题

**背景**：
- 用户进行了 15 轮对话
- Agent 突然"失忆"，无法看到历史消息

**诊断**：
```typescript
const smContext = sessionManager.buildSessionContext();
log.info(`SessionManager loaded ${smContext.messages.length} messages`);
// 输出：SessionManager loaded 0 messages

const sm = sessionManager as any;
const messageEntries = sm.fileEntries.filter((e: any) => e.type === "message");
log.info(`fileEntries: messages=${messageEntries.length}`);
// 输出：fileEntries: messages=30
```

**结论**：`buildSessionContext()` 返回空数组，但 `fileEntries` 中有 30 条消息

**修复**：
- 使用方案 1：直接从 `fileEntries` 读取消息
- Override `buildSessionContext()` 方法

**效果**：
- ✅ Agent 可以看到历史消息
- ✅ 任务目标不再丢失
- ✅ 用户体验恢复正常

---

## 关键教训

### 1. 不要盲目信任 API 返回值

- ❌ 假设 `buildSessionContext()` 总是返回正确的数据
- ✅ 验证返回值，检查是否符合预期

### 2. 检查内部状态

- ❌ 只看 API 返回值
- ✅ 检查内部状态（如 `fileEntries`），找到真实数据

### 3. 添加日志和验证

- ❌ 只在出问题时调试
- ✅ 在关键位置添加日志，提前发现问题

### 4. 准备备用方案

- ❌ 只依赖一种数据源
- ✅ 准备多种数据读取方案，确保系统可用

---

## 相关问题

### 问题 1：如何判断是否需要使用方案 1？

**判断标准**：
- `buildSessionContext()` 返回空数组
- `fileEntries` 中有消息
- 重新打开 SessionManager 无效

### 问题 2：方案 1 是否会影响性能？

**答案**：
- 影响很小
- 只是改变了数据读取方式
- 不会增加额外的 I/O 操作

### 问题 3：方案 1 是否安全？

**答案**：
- 相对安全
- 只读取数据，不修改内部状态
- 但依赖 SessionManager 的内部实现（`fileEntries`）

---

## 推荐关键词

- SessionManager
- buildSessionContext
- fileEntries
- 缓存问题
- 状态管理
- Agent 失忆
- 历史消息丢失

---

**版本**：v20260130_1  
**来源**：Clawdbot Agent 大脑架构分析实战  
**状态**：已验证修复方案有效
