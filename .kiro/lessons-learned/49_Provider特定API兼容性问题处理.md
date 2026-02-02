# Provider 特定 API 兼容性问题处理方法论

> **来源**：多次遇到不同 provider 不支持 `thought_signature` 字段的问题  
> **版本**：v20260202_2  
> **最后更新**：2026-02-02  
> **变更**：新增"三向清理"方法论（位置 3：transcript-policy）

---

## 问题识别

### 典型症状

当使用新的 API provider 时，出现以下错误：

```
Corrupted thought signature. (request id: ...)
```

或类似的格式错误：
- `Invalid field: thought_signature`
- `Unrecognized field: thoughtSignature`
- `Bad Request: thought_signature not supported`

### 根本原因

不同的 API provider 对 Gemini API 格式的支持程度不同：
- **官方 Gemini API**：支持所有标准字段
- **中转 API**：可能支持或不支持扩展字段（如 `thought_signature`）
- **自建 API**：通常只支持核心字段

**关键**：`thought_signature` 是 Clawdbot 为了兼容某些中转 API 而添加的扩展字段，不是 Gemini 官方 API 的标准字段。

---

## 定位流程

### 步骤 1：确认错误来源

从日志中确认：
1. 错误信息包含 `thought_signature` 或 `thoughtSignature`
2. 错误来自 LLM API 调用（不是本地代码错误）
3. 记录 provider 名称（如 `yinli`、`vectorengine`）

**日志示例**：
```
[llm] ← LLM回复 seq=1 ok durationMs=1721 model=yinli/gemini-3-flash-preview
⚠️ API 返回了错误响应：{"error":{"message":"Corrupted thought signature. ..."}}
```

### 步骤 2：检查 patcher 是否启用

搜索日志中的 patcher 启用信息：
```
[agent/gemini-payload] gemini payload thoughtSignature patcher enabled
```

如果看到这条日志，说明 patcher 被启用了，正在添加 `thought_signature` 字段。

### 步骤 3：确认 provider 配置

检查配置文件中的 provider 名称：
```powershell
pnpm clawdbot config get agents.defaults.model.primary
```

输出示例：
```
"yinli/gemini-3-flash-preview"
```

提取 provider 名称：`yinli`

---

## 修复流程（三向清理）⭐ **重要**

**核心原则**：必须在三个位置都修复，缺一不可！

### 位置 1：禁用 patcher（入站修复）

**文件**：`src/agents/gemini-payload-thought-signature.ts`

**位置**：`shouldEnable` 函数

**作用**：禁用请求中的 `thought_signature` patcher

**操作**：添加 provider 特定的禁用逻辑

**模板**：
```typescript
function shouldEnable(params: {
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
}): boolean {
  const provider = (params.provider ?? "").trim().toLowerCase();
  
  // 对 vectorengine 禁用 thought_signature
  if (provider.includes("vectorengine")) {
    log.debug(`[thought_signature] Disabled for vectorengine provider`);
    return false;
  }
  
  // 对 yinli 禁用 thought_signature
  // 原因：yinli 的 API 不支持 thought_signature，会返回 "Corrupted thought signature" 错误
  if (provider.includes("yinli")) {
    log.debug(`[thought_signature] Disabled for yinli provider`);
    return false;
  }
  
  // 对 <新 provider> 禁用 thought_signature
  // 原因：<具体原因>
  if (provider.includes("<provider_name>")) {
    log.debug(`[thought_signature] Disabled for <provider_name> provider`);
    return false;
  }
  
  // 对其他 provider，默认启用 thought_signature patcher
  log.debug(`[thought_signature] Enabled for provider: ${provider}`);
  return true;
}
```

**关键点**：
- 使用 `provider.includes("provider_name")` 检测（支持前缀匹配）
- 添加注释说明禁用原因
- 返回 `false` 禁用 patcher

---

### 位置 2：移除响应字段（出站修复）

**文件**：`src/agents/session-tool-result-guard.ts`

**位置**：`guardedAppend` 函数

**作用**：移除 LLM 响应中的 `thoughtSignature` 字段，防止保存到 session

**操作**：在保存 assistant 消息前清理字段

**模板**：
```typescript
const guardedAppend = (message: AgentMessage) => {
  const role = message.role;
  
  if (role === "assistant") {
    // 🔧 Fix: Remove thoughtSignature from assistant messages before saving
    // Some providers (like yinli) return thoughtSignature in responses, but reject it in requests
    // We need to remove it from saved messages to prevent errors in subsequent requests
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object") {
          const rec = block as unknown as Record<string, unknown>;
          if ("thoughtSignature" in rec) {
            delete rec.thoughtSignature;
            log.debug(`[guard] Removed thoughtSignature from content block`);
          }
          if ("thought_signature" in rec) {
            delete rec.thought_signature;
            log.debug(`[guard] Removed thought_signature from content block`);
          }
        }
      }
    }
  }
  
  // 保存到 session
  originalAppend(message);
};
```

**关键点**：
- 检查 `thoughtSignature` 和 `thought_signature` 两种格式
- 在保存前删除字段
- 添加日志记录

---

### 位置 3：清理历史消息（历史修复）⭐ **最关键**

**文件**：`src/agents/transcript-policy.ts`

**位置**：`resolveTranscriptPolicy` 函数

**作用**：清理历史消息中的 `thoughtSignature` 字段（在修复之前保存的）

**操作**：为 provider 启用 `sanitizeThoughtSignatures`

**模板**：
```typescript
export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
}): TranscriptPolicy {
  const provider = normalizeProviderId(params.provider ?? "");
  // ... 其他代码 ...
  
  // 🔧 Fix: yinli provider also needs thoughtSignature sanitization
  // yinli returns thoughtSignature in responses but rejects it in requests
  const isYinliProvider = provider.includes("yinli");
  
  // 🔧 Fix: <新 provider> also needs thoughtSignature sanitization
  // <原因>
  const is<Provider>Provider = provider.includes("<provider_name>");
  
  const sanitizeThoughtSignatures = isOpenRouterGemini || isYinliProvider || is<Provider>Provider
    ? { allowBase64Only: true, includeCamelCase: true }
    : undefined;
  
  // ... 其他代码 ...
  
  return {
    // ... 其他字段 ...
    sanitizeThoughtSignatures: isOpenAi ? undefined : sanitizeThoughtSignatures,
    // ... 其他字段 ...
  };
}
```

**关键点**：
- 为 provider 启用 `sanitizeThoughtSignatures`
- 使用 `allowBase64Only: true, includeCamelCase: true` 配置
- 添加注释说明原因

---

### 为什么需要三向清理？

| 清理位置 | 作用 | 清理对象 | 必要性 |
|---------|------|----------|--------|
| 位置 1：shouldEnable | 禁用 patcher | 请求中的 thought_signature | 🥇 必须 |
| 位置 2：session-tool-result-guard | 移除响应字段 | 新保存的 thoughtSignature | 🥇 必须 |
| 位置 3：transcript-policy | 清理历史消息 | 已保存的 thoughtSignature | 🥇 必须 |

**数据流**：
```
用户消息
  ↓
读取历史消息（位置 3：清理历史消息中的 thoughtSignature）
  ↓
构建请求 payload（位置 1：不添加 thought_signature）
  ↓
发送给 API
  ↓
API 返回响应（包含 thoughtSignature）
  ↓
保存响应（位置 2：移除 thoughtSignature）
  ↓
下次请求读取历史消息（位置 3：清理历史消息中的 thoughtSignature）
  ↓
循环...
```

**关键**：
- 位置 1 + 位置 2 = 双向修复（新数据）
- 位置 3 = 历史修复（旧数据）
- 三个位置缺一不可！

---

### 构建验证

```powershell
# 构建
pnpm build

# 验证位置 1
Select-String -Path "dist/agents/gemini-payload-thought-signature.js" -Pattern "<provider_name>" -Context 1,1 -Encoding UTF8

# 验证位置 2
Select-String -Path "dist/agents/session-tool-result-guard.js" -Pattern "thoughtSignature" -Context 1,1 -Encoding UTF8

# 验证位置 3
Select-String -Path "dist/agents/transcript-policy.js" -Pattern "<provider_name>" -Context 1,1 -Encoding UTF8
```

### 重启 gateway 测试

```powershell
# 停止当前 gateway（Ctrl+C）
# 重新启动
pnpm clawdbot gateway run --bind loopback --port 18789 --force
```

### 验证修复效果

发送至少 3 轮对话消息，检查日志：
- ✅ 不再出现 `thought_signature patcher enabled` 日志
- ✅ 不再出现 `Corrupted thought signature` 错误
- ✅ LLM 正常返回响应
- ✅ 多轮对话正常（验证历史消息清理）

---

## 常见 Provider 兼容性列表

| Provider | 支持 thought_signature | 备注 |
|----------|----------------------|------|
| `google` (官方) | ❌ 不支持 | 官方 API 不需要此字段 |
| `vectorengine` | ❌ 不支持 | 已禁用 |
| `yinli` | ❌ 不支持 | 已禁用（双向清理：请求 + 响应） |
| 其他中转 API | ⚠️ 未知 | 需要测试 |

**更新规则**：
- 每次遇到新的不支持的 provider，更新此列表
- 在代码中添加对应的禁用逻辑
- 如果 provider 会在响应中返回 thoughtSignature，需要双向修复

---

## 预防措施

### 1. 测试新 Provider 时的检查清单

- [ ] 发送简单的测试消息（不包含工具调用）
- [ ] 检查日志中是否有 `thought_signature` 相关错误
- [ ] 如果出错，按照本文档的修复流程处理
- [ ] 更新兼容性列表

### 2. 配置文件不是解决方案

**错误做法**：
```json
{
  "agents": {
    "defaults": {
      "geminiPayloadPatchers": {
        "thoughtSignature": false
      }
    }
  }
}
```

**问题**：
- `geminiPayloadPatchers` 不是有效的配置项
- 配置文件无法控制 patcher 的启用/禁用
- 必须在代码层面修复

### 3. 日志监控

在生产环境中，监控以下日志：
- `thought_signature patcher enabled`
- `Corrupted thought signature`
- `Invalid field: thought_signature`

如果出现这些日志，说明有新的 provider 不兼容。

---

## yinli Provider 的特殊情况（双向修复案例）

### 问题

yinli provider 有特殊的行为：
1. **不接受请求中的 `thoughtSignature`**（会报错）
2. **但会在响应中返回 `thoughtSignature`**（LLM 自己加的）
3. **历史消息中也不能包含 `thoughtSignature`**（会报错）

### 数据流问题

```
seq=1: 用户消息
  → 请求中没有 thoughtSignature ✅
  → API 正常响应 ✅

seq=2: 工具调用
  → 请求中没有 thoughtSignature ✅
  → API 返回响应（包含 thoughtSignature）✅
  → 保存到 session（包含 thoughtSignature）❌

seq=3: 继续对话
  → 读取历史消息（包含 thoughtSignature）❌
  → 发送给 API ❌
  → API 拒绝：Thought signature is not valid ❌
```

### 双向修复方案

**修复 1：禁用请求中的 patcher（入站）**

文件：`src/agents/gemini-payload-thought-signature.ts`

```typescript
if (provider.includes("yinli")) {
  log.debug(`[thought_signature] Disabled for yinli provider`);
  return false;
}
```

**修复 2：移除响应中的 thoughtSignature（出站）**

文件：`src/agents/session-tool-result-guard.ts`

```typescript
// 在保存 assistant 消息时
if (Array.isArray(msg.content)) {
  for (const block of msg.content) {
    if (block && typeof block === "object") {
      const rec = block as unknown as Record<string, unknown>;
      if ("thoughtSignature" in rec) {
        delete rec.thoughtSignature;
      }
      if ("thought_signature" in rec) {
        delete rec.thought_signature;
      }
    }
  }
}
```

### 为什么需要双向修复？

**只修复入站（请求）**：
- seq=1 成功
- seq=2 成功
- seq=3 失败（历史消息中有 seq=2 返回的 thoughtSignature）

**只修复出站（响应）**：
- seq=1 可能失败（如果之前有保存的 thoughtSignature）
- seq=2 可能失败

**双向修复**：
- 所有 seq 都成功
- 数据在整个循环中都是正确的

### 关键教训

1. **数据流是循环的**：响应 → 保存 → 历史消息 → 请求 → 响应
2. **LLM 响应可能包含意外字段**：必须在保存时清理
3. **历史消息会影响后续请求**：必须确保保存的数据符合 API 要求
4. **单向修复会导致问题在循环中重现**：必须双向修复

---

## 关键教训

1. **不要假设所有 provider 都支持相同的字段**
   - 每个 provider 的实现不同
   - 扩展字段（如 `thought_signature`）不是标准字段

2. **错误信息可能不准确**
   - API 返回的错误信息可能指向错误的字段
   - 必须通过日志和代码分析确认真正的原因

3. **配置文件不是万能的**
   - 某些行为必须在代码层面控制
   - 不要尝试通过配置文件解决所有问题

4. **测试新 provider 时要谨慎**
   - 先发送简单的测试消息
   - 检查日志中的错误信息
   - 确认兼容性后再正式使用

5. **文档和代码要同步**
   - 每次添加新的禁用逻辑，更新兼容性列表
   - 在代码中添加清晰的注释

---

## 相关文档

- `.kiro/lessons-learned/16_外部API报错调试方法论.md` - 外部 API 错误调试
- `.kiro/lessons-learned/39_中转API错误调试方法论.md` - 中转 API 错误调试
- `.kiro/lessons-learned/38_API_Payload格式错误调试方法论.md` - Payload 格式错误调试

---

**版本**：v20260202_2  
**最后更新**：2026-02-02  
**变更**：
- 初始版本，总结 provider 特定 API 兼容性问题的处理方法论
- 新增 yinli provider 的双向修复案例（请求 + 响应）
- 更新兼容性列表，标注需要双向修复的 provider


---

## yinli Provider 的其他扩展字段

### textSignature

**问题**：yinli provider 在响应中返回 `textSignature` 字段（用于验证响应完整性）。

**示例**：
```json
{
  "type": "text",
  "text": "好的，任务已收到...",
  "textSignature": "EusfCugfAXLI2nySFa7XZaumdO2xHa9WmlI5hE+CcbC7OZj/lf+GpNXA9T9QaRtq..."
}
```

**解决方案**：
- **出站修复**：在 `session-tool-result-guard.ts` 中移除响应中的字段（不保存到 session）

**代码位置**：
- 出站：`src/agents/session-tool-result-guard.ts`

**注意**：`textSignature` 只在响应中出现，不需要入站修复（不会在请求中添加）。

**修复代码**：
```typescript
// src/agents/session-tool-result-guard.ts
if (Array.isArray(msg.content)) {
  for (const block of msg.content) {
    if (block && typeof block === "object") {
      const rec = block as unknown as Record<string, unknown>;
      if ("thoughtSignature" in rec) {
        delete rec.thoughtSignature;
      }
      if ("thought_signature" in rec) {
        delete rec.thought_signature;
      }
      if ("textSignature" in rec) {
        delete rec.textSignature;
        log.debug(`[guard] Removed textSignature from content block`);
      }
    }
  }
}
```

---

**版本**：v20260202_3  
**最后更新**：2026-02-02  
**变更**：新增 yinli provider 的 `textSignature` 字段处理
