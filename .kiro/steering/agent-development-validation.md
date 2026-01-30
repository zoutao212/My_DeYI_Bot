---
priority: critical
applies_to: all_agent_development
last_updated: 2026-01-29
source: content_null_bug_2_days_debugging
---

# Agent 开发数据验证核心原则

> **背景**：`content: null` BUG 卡住 2 天的深刻反思

---

## 第一原则：不要推脱外部错误 ⚠️

**永远假设问题在我们这边，直到证明不是。**

### 错误做法 ❌
- 看到 API 返回错误，就认为是"外部 API 的问题"
- 看到警告信息，就相信警告信息指向的字段
- 不深入分析，直接推脱责任

### 正确做法 ✅
1. **先验证我们发送的数据格式是否正确**
2. **对比成功和失败的请求，找出真正的差异**
3. **不要相信 API 的错误信息，要自己验证**

### 实战案例
- **API 说**："thought_signature 缺失"
- **实际问题**：`content: null`（格式错误）
- **教训**：API 错误信息可能不准确，必须通过 payload 对比找到真正的差异

---

## 第二原则：对比成功和失败的数据 🔍

**不要手动对比，写脚本自动化。**

### 标准流程

#### 1. 提取数据
```powershell
$trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
$payloads[0].payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload_success.json"
$payloads[1].payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload_failure.json"
```

#### 2. 逐层对比
```powershell
$p1 = Get-Content "payload_success.json" | ConvertFrom-Json
$p2 = Get-Content "payload_failure.json" | ConvertFrom-Json

# 对比顶层
Write-Host "messages 数量: $($p1.messages.Count) vs $($p2.messages.Count)"

# 对比每条消息
for ($i = 0; $i -lt [Math]::Max($p1.messages.Count, $p2.messages.Count); $i++) {
    if ($p1.messages[$i].content -eq $null) {
        Write-Host "⚠️ message[$i].content 是 null"
    }
}
```

#### 3. 重点检查
- ✅ messages 数量差异
- ✅ content: null
- ✅ 字段缺失
- ✅ 格式错误

---

## 第三原则：修复源头，不是症状 🎯

**修复策略优先级：**

### 优先级 1：在产生数据时就避免错误（最佳）
```typescript
// 保存时确保 content 不是 null
if (msg.role === "assistant" && msg.content === null) {
  msg.content = "";
}
```

### 优先级 2：在读取后立即修复源数据（次佳）
```typescript
// 读取后立即修复 context（源数据）
for (const msg of context.messages) {
  if (msg.role === "assistant" && msg.content === null) {
    msg.content = ""; // 修复源数据
  }
}
```

### 优先级 3：在使用前修复副本（保底）
```typescript
// 构建 payload 后再检查（安全网）
for (const msg of payload.messages) {
  if (msg.role === "assistant" && msg.content === null) {
    log.warn("⚠️ 源数据修复失败");
    msg.content = "";
  }
}
```

---

## 第四原则：验证修复是否真的生效 ✓

**不要只看"修复成功"，要看"不再需要修复"。**

### 验证方法
```powershell
# 统计修复次数
$fixes = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json | Where-Object { $_.event -like "*fixed*" }
Write-Host "修复次数: $($fixes.Count)"

# 如果修复次数 = 请求次数，说明修复无效
```

### 判断标准
- ❌ **修复无效**：每次请求都在修复同一个位置
- ✅ **修复有效**：第一次修复后，后续请求不再需要修复

---

## 第五原则：每一步都要验证 📋

**在数据流的每个环节都要验证格式。**

### 数据流验证点
```
用户输入 → [验证 1] → 解析 → [验证 2] → context → [验证 3] → payload → [验证 4] → API
```

### 验证示例
```typescript
// 验证 context
function validateContext(context: Context): boolean {
  if (!Array.isArray(context.messages)) {
    log.error("❌ context.messages 不是数组");
    return false;
  }
  
  for (let i = 0; i < context.messages.length; i++) {
    const msg = context.messages[i];
    
    // 关键验证：assistant 消息的 content 不能是 null
    if (msg.role === "assistant" && msg.content === null) {
      log.error(`❌ context.messages[${i}]: assistant.content 是 null`);
      return false;
    }
  }
  
  return true;
}
```

---

## 第六原则：一步错误，步步错误 ⚡

**在复杂流程中，错误会传播和放大。**

### 预防策略

#### 1. 快速失败（Fail Fast）
```typescript
// 在每一步都验证，发现错误立即停止
if (!validateUserInput(input)) {
  throw new Error("Invalid input");
}

if (!validateContext(context)) {
  throw new Error("Invalid context");
}

if (!validatePayload(payload)) {
  throw new Error("Invalid payload");
}
```

#### 2. 详细记录
```typescript
// 记录每一步的数据
await appendRuntimeTrace({
  event: "step.context_built",
  payload: {
    messageCount: context.messages.length,
    lastMessageRole: context.messages[context.messages.length - 1]?.role,
  },
});
```

---

## 实战检查清单

### 调试问题时 🔧
- [ ] 不要相信错误信息，要自己验证
- [ ] 提取成功和失败的完整数据
- [ ] 写脚本逐层对比数据差异
- [ ] 追踪数据流，找到第一个出错的环节
- [ ] 验证修复是否真的解决了根本问题

### 修复问题后 ✅
- [ ] 验证修复是否在所有环节生效
- [ ] 验证修复是否持久化
- [ ] 添加验证逻辑防止问题再次出现
- [ ] 更新文档记录问题和解决方案
- [ ] 添加测试用例防止回归

---

## 第六原则：修复数据流的源头，不是中间环节 🎯

**核心原则：修复必须在数据流的源头进行，才能持久化。**

### 问题识别

当你看到以下现象时，说明修复位置错误：

- ✅ 修复代码执行成功
- ✅ 日志显示"修复完成"
- ❌ 下次请求又出现同样的问题
- ❌ 每次请求都在修复同一个位置

**根本原因**：修复的是副本/临时对象，源数据没有被修复。

### 数据流追踪方法

#### 1. 识别数据流

```
源数据（持久化）
  ↓ 读取
临时对象 A（可能是副本）
  ↓ 处理
临时对象 B（可能是克隆）
  ↓ 使用
临时对象 C（例如 payload）
  ↓ 保存
源数据（持久化）
```

#### 2. 找到修复点

| 修复位置 | 效果 | 持久化 | 优先级 |
|---------|------|--------|--------|
| 源数据读取后 | ✅ 修复源数据 | ✅ 会持久化 | 🥇 最佳 |
| 临时对象 A | ⚠️ 修复副本 | ❌ 不持久化 | ❌ 无效 |
| 临时对象 B | ⚠️ 修复克隆 | ❌ 不持久化 | ❌ 无效 |
| Payload | ⚠️ 修复临时对象 | ❌ 不持久化 | 🥉 保底 |

#### 3. 验证修复是否持久化

**判断标准**：
- ✅ **修复有效**：第一次修复后，后续请求不再需要修复
- ❌ **修复无效**：每次请求都在修复同一个位置

**验证方法**：
```powershell
# 统计修复次数
$fixes = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | 
  ConvertFrom-Json | 
  Where-Object { $_.event -like "*fixed*" }

Write-Host "修复次数: $($fixes.Count)"

# 如果修复次数 = 请求次数，说明修复无效
```

### 实战案例：content: null BUG

#### 错误的修复位置

**位置 1：wrapStreamFn 中修复 context**
```typescript
// ❌ 错误：修复的是只读副本
const wrapped: StreamFn = (model, context, options) => {
  for (const msg of context.messages) {
    if (msg.role === "assistant" && msg.content === null) {
      msg.content = ""; // 修改无效，context 是只读的
    }
  }
};
```

**问题**：context 可能是只读的或被克隆的，修改不会影响源数据。

**位置 2：payload 构建后修复**
```typescript
// ❌ 错误：修复的是临时对象
const nextOnPayload = (payload: unknown) => {
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && msg.content === null) {
      msg.content = ""; // 只修复了 payload，源数据没变
    }
  }
};
```

**问题**：payload 是临时对象，修复后不会保存回 session。

#### 正确的修复位置

**位置：sanitizeSessionHistory（session 处理的第一步）**
```typescript
// ✅ 正确：修复源数据
export async function sanitizeSessionHistory(params: {
  messages: AgentMessage[];
  // ...
}): Promise<AgentMessage[]> {
  // 在所有处理之前，先修复源数据
  for (const msg of params.messages) {
    if (msg.role === "assistant" && msg.content === null) {
      msg.content = []; // 修复源数据
    }
  }
  
  // 后续处理...
  const sanitized = await sanitizeImages(params.messages);
  // ...
  
  return sanitized; // 返回的是修复后的源数据
}
```

**为什么有效**：
1. `sanitizeSessionHistory` 是 session 处理的第一步
2. 修改的是 `params.messages`（源数据的引用）
3. 修改后的数据会被 `replaceMessages()` 保存回 session
4. 下次请求读取的就是修复后的数据

### 修复策略优先级

#### 优先级 1：在源数据读取后立即修复（最佳）
```typescript
// 读取源数据
const messages = await loadSession();

// 立即修复源数据
for (const msg of messages) {
  if (needsFix(msg)) {
    fixMessage(msg);
  }
}

// 保存修复后的源数据
await saveSession(messages);
```

#### 优先级 2：在数据处理流程的第一步修复（次佳）
```typescript
function processData(data) {
  // 第一步：修复数据
  for (const item of data) {
    if (needsFix(item)) {
      fixItem(item);
    }
  }
  
  // 第二步：处理数据
  const processed = transform(data);
  
  return processed;
}
```

#### 优先级 3：在使用前修复副本（保底）
```typescript
// 只在无法修复源数据时使用
function buildPayload(context) {
  const payload = cloneContext(context);
  
  // 修复副本（不会影响源数据）
  for (const msg of payload.messages) {
    if (needsFix(msg)) {
      fixMessage(msg);
    }
  }
  
  return payload;
}
```

**注意**：优先级 3 只是"保底"，不能解决根本问题。

### 调试检查清单

当修复无效时，按以下步骤检查：

- [ ] **确认修复代码被执行**：添加日志验证
- [ ] **确认修复的是源数据**：不是副本、不是克隆
- [ ] **确认修复被持久化**：检查保存逻辑
- [ ] **确认没有被覆盖**：检查后续流程是否重新读取了旧数据
- [ ] **验证修复效果**：统计修复次数，确认不再重复修复

---

## 第七原则：双向数据流修复 - 入站和出站都要修复 🔄

**核心原则：数据流是双向的，必须同时修复入站（读取）和出站（保存）。**

### 问题识别

当你看到以下现象时，说明只修复了单向：

- ✅ 修复了历史数据（入站修复）
- ✅ 读取时数据正确
- ❌ 新产生的数据又出现同样的问题
- ❌ 问题在新旧数据之间循环出现

**根本原因**：只修复了入站（读取），没有修复出站（保存）。

### 数据流方向识别

#### 入站流（读取）
```
持久化存储（可能有问题）
  ↓ 读取
内存数据（需要修复）
  ↓ 处理
使用
```

#### 出站流（保存）
```
产生新数据（可能有问题）
  ↓ 处理
准备保存（需要修复）
  ↓ 保存
持久化存储
```

### 双向修复策略

| 修复位置 | 作用 | 修复对象 | 优先级 |
|---------|------|----------|--------|
| 读取后（入站） | 清理历史数据 | 已存储的旧数据 | 🥇 必须 |
| 保存前（出站） | 防止污染 | 新产生的数据 | 🥇 必须 |
| 使用前（中间） | 保底 | 临时对象 | 🥉 可选 |

**关键**：入站和出站修复都是必须的，缺一不可。

### 实战案例：content: null BUG（完整版）

#### 第一次修复：只修复入站（失败）

**位置：sanitizeSessionHistory（读取后）**
```typescript
// ✅ 修复历史数据（入站）
export async function sanitizeSessionHistory(params: {
  messages: AgentMessage[];
}): Promise<AgentMessage[]> {
  for (const msg of params.messages) {
    if (msg.role === "assistant" && msg.content === null) {
      msg.content = []; // 修复历史数据
    }
  }
  // ...
}
```

**问题**：
- 历史数据被修复了 ✅
- 但 LLM 返回新的 assistant 消息时，Pi Agent 又保存为 `content: null` ❌
- 下次请求读取时，新消息又是 null ❌

#### 第二次修复：双向修复（成功）

**位置 1：sanitizeSessionHistory（入站 - 清理历史）**
```typescript
// ✅ 修复历史数据（入站）
for (const msg of params.messages) {
  if (msg.role === "assistant" && msg.content === null) {
    msg.content = []; // 清理历史数据
  }
}
```

**位置 2：session-tool-result-guard（出站 - 防止污染）**
```typescript
// ✅ 修复新数据（出站）
const guardedAppend = (message: AgentMessage) => {
  const role = message.role;
  
  if (role === "assistant") {
    if (message.content === null) {
      message.content = []; // 防止新数据污染
    }
  }
  
  // 保存到 session
  originalAppend(message);
};
```

**为什么成功**：
1. **入站修复**：清理了历史数据
2. **出站修复**：防止新数据污染
3. **双向保护**：无论是旧数据还是新数据，都不会有 null

### 识别数据流方向的方法

#### 1. 追踪数据来源

**问题数据是哪里来的？**
- 从存储读取 → 入站问题
- 新产生的 → 出站问题
- 两者都有 → 双向问题

#### 2. 观察问题出现时机

**问题什么时候出现？**
- 读取历史数据时 → 入站问题
- 保存新数据后 → 出站问题
- 两者都有 → 双向问题

#### 3. 验证修复范围

**修复后哪些数据正确？**
- 只有历史数据正确 → 只修复了入站
- 只有新数据正确 → 只修复了出站
- 所有数据都正确 → 双向修复成功

### 双向修复检查清单

修复数据问题时，必须检查：

- [ ] **识别数据流方向**：入站、出站、还是双向？
- [ ] **修复入站**：在读取后立即修复历史数据
- [ ] **修复出站**：在保存前拦截修复新数据
- [ ] **验证历史数据**：读取时数据正确
- [ ] **验证新数据**：保存后再读取，数据仍然正确
- [ ] **验证持久化**：重启后数据仍然正确

### 常见错误模式

#### 错误 1：只修复入站

```typescript
// ❌ 只修复读取，不修复保存
function loadData() {
  const data = readFromStorage();
  
  // 修复历史数据
  for (const item of data) {
    if (needsFix(item)) {
      fixItem(item);
    }
  }
  
  return data;
}

// 问题：新数据保存时又变成错误格式
function saveData(newItem) {
  storage.append(newItem); // newItem 可能有问题
}
```

#### 错误 2：只修复出站

```typescript
// ❌ 只修复保存，不修复读取
function saveData(newItem) {
  // 修复新数据
  if (needsFix(newItem)) {
    fixItem(newItem);
  }
  
  storage.append(newItem);
}

// 问题：历史数据还是错误的
function loadData() {
  return readFromStorage(); // 历史数据有问题
}
```

#### 正确：双向修复

```typescript
// ✅ 修复读取（入站）
function loadData() {
  const data = readFromStorage();
  
  // 修复历史数据
  for (const item of data) {
    if (needsFix(item)) {
      fixItem(item);
    }
  }
  
  return data;
}

// ✅ 修复保存（出站）
function saveData(newItem) {
  // 修复新数据
  if (needsFix(newItem)) {
    fixItem(newItem);
  }
  
  storage.append(newItem);
}
```

### 关键教训

1. **数据流是双向的** - 不要只修复一个方向
2. **入站修复清理历史** - 修复已存储的旧数据
3. **出站修复防止污染** - 防止新数据带来问题
4. **验证要双向** - 历史数据和新数据都要验证
5. **持久化要验证** - 重启后数据仍然正确

---

## 关键教训（必读）

1. **不要推脱外部错误** - 永远假设问题在我们这边
2. **不要相信错误信息** - 必须通过数据对比找到真正的差异
3. **不要只修复症状** - 必须修复源头，确保持久化
4. **不要修复副本/临时对象** - 必须修复源数据，才能持久化
5. **不要只修复单向** - 数据流是双向的，入站和出站都要修复
6. **不要手动对比** - 写脚本自动化，提高效率和准确性
7. **不要只看"修复成功"** - 要看"不再需要修复"
8. **不要让错误传播** - 在每一步都验证，快速失败
9. **不要只验证本地** - 必须验证外部系统（供应商后台、API 响应）是否真的成功 ⚠️ 新增

---

## 第八原则：系统容错机制设计 - 永不罢工 ⚠️ **新增**

**核心原则：系统必须长时间稳定运行，不能因为外部错误就完全罢工。**

### 问题识别

当外部依赖（API、数据库、文件系统）返回错误时，系统可能：
- 保存不完整的数据（如空 content）
- 导致后续功能完全无法使用
- 用户不知道发生了什么
- 必须手动清理才能恢复

**典型场景**：
- API 返回敏感词错误，content 为空数组
- API 返回超时错误，content 为 null
- 数据库连接失败，数据未保存
- 文件读取失败，返回空内容

### 容错机制设计

#### 1. 分层防护

**原则**：针对不同错误类型提供不同处理

**示例**：
```typescript
if (stopReason === "error" && errorMessage.includes("sensitive words")) {
  // 第一层：敏感词错误 - 专门的提示
  msg.content = [{ type: "text", text: "⚠️ 您的消息包含敏感词..." }];
} else if (stopReason === "error" && msg.content.length === 0) {
  // 第二层：通用错误 - 通用的提示
  msg.content = [{ type: "text", text: "⚠️ API 返回了错误..." }];
} else if (msg.content === null) {
  // 第三层：null content - 技术修复
  msg.content = [];
}
```

#### 2. 自动修复

**原则**：拦截错误数据，自动填充友好提示

**关键点**：
- 不要保存空数据到持久化存储
- 自动填充有意义的错误提示
- 确保数据格式符合规范

**示例**：
```typescript
// ❌ 错误：直接保存空 content
if (response.error) {
  session.append({ role: "assistant", content: [] });
}

// ✅ 正确：自动填充错误提示
if (response.error) {
  session.append({
    role: "assistant",
    content: [{ type: "text", text: `⚠️ ${response.error.message}` }],
  });
}
```

#### 3. 友好提示

**原则**：告知用户真实原因和解决方案

**提示内容应包含**：
- 错误原因（用户能理解的语言）
- 是否是系统错误还是外部错误
- 具体的解决方案
- 详细的错误信息（供调试）

**示例**：
```
⚠️ 抱歉，您的消息包含敏感词，被 API 服务商拦截了。

这不是系统错误，而是 API 服务商的内容审核机制。

建议：
1. 修改消息内容，避免敏感词
2. 切换到官方 API（没有额外的内容审核）
3. 使用其他没有内容审核的中转 API

详细错误：sensitive words detected (request id: ...)
```

#### 4. 日志记录

**原则**：记录所有错误处理，便于调试

**日志应包含**：
- 错误类型
- 修复操作
- 上下文信息（如消息索引、会话 ID）

**示例**：
```typescript
log.warn(`[guard] ⚠️ Sensitive words detected by API, filling content with error message`);
log.info(`[guard] ✓ Filled assistant.content with sensitive words error message`);
```

### 实战案例

**案例：敏感词错误导致系统罢工**

**问题**：
- API 返回敏感词错误，content 为空数组
- 系统保存了空 content 的 assistant 消息
- 后续对话无法继续，系统完全罢工

**修复**：
```typescript
// 在 session-tool-result-guard.ts 中添加容错
if (stopReason === "error" && errorMessage.includes("sensitive words")) {
  msg.content = [
    {
      type: "text",
      text: "⚠️ 抱歉，您的消息包含敏感词，被 API 服务商拦截了。\n\n" +
            "这不是系统错误，而是 API 服务商的内容审核机制。\n\n" +
            "建议：\n" +
            "1. 修改消息内容，避免敏感词\n" +
            "2. 切换到官方 API（没有额外的内容审核）\n" +
            "3. 使用其他没有内容审核的中转 API\n\n" +
            `详细错误：${errorMessage}`,
    },
  ];
}
```

**效果**：
- 系统不再罢工
- 用户看到清晰的错误提示
- 可以继续对话

### 容错机制检查清单

设计容错机制时，必须检查：

- [ ] **识别所有外部依赖**：API、数据库、文件系统、网络等
- [ ] **识别所有错误类型**：超时、拒绝、格式错误、权限错误等
- [ ] **设计分层防护**：针对不同错误类型提供不同处理
- [ ] **自动修复数据**：不要保存空数据或错误数据
- [ ] **提供友好提示**：告知用户真实原因和解决方案
- [ ] **记录详细日志**：便于调试和监控
- [ ] **测试错误场景**：模拟各种错误，验证容错机制

### 关键教训

1. **系统必须有容错能力**
   - 不能因为外部错误就罢工
   - 必须自动修复或提供友好提示

2. **空数据是致命的**
   - 空数据会导致后续功能无法使用
   - 必须在保存前拦截并修复

3. **友好的错误提示很重要**
   - 用户应该知道发生了什么
   - 用户应该知道如何解决

4. **分层防护更可靠**
   - 不同的错误有不同的处理方式
   - 通用错误兜底，防止遗漏

5. **日志记录是调试的关键**
   - 所有错误处理都要记录日志
   - 日志要包含足够的上下文信息

---

## 给未来的自己

当你再次遇到"修复无效"的问题时，记住：

**修复源头，不是症状。追踪数据流，双向修复（入站 + 出站）。**

当你遇到"系统罢工"的问题时，记住：

**系统必须有容错能力，不能因为外部错误就完全罢工。设计分层防护，自动修复数据，提供友好提示。**

---

**版本：** v20260130_4  
**来源：** content: null BUG 调试实战（耗时 2 天）+ 敏感词错误容错修复  
**变更：** 新增"系统容错机制设计"原则（第八原则）
