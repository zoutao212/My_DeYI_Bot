# Response body 重复读取导致崩溃

**问题**：尝试多次读取 Response body 导致 "Response body object should not be disturbed or locked" 错误，系统崩溃

---

## 问题描述

### 错误现象

**场景**：Telegram 频道发送文件时系统崩溃

**错误日志**：
```
[llm-gated-fetch] Request error (TypeError): TypeError: Response body object should not be disturbed or locked
[tools] message failed: Network request for 'sendDocument' failed!
[clawdbot] Unhandled promise rejection: TypeError: Response body object should not be disturbed or locked
```

### 错误代码

**位置**：`src/media/fetch.ts`

```typescript
// ❌ 错误：直接读取 Response body，如果已被读取会抛出错误
async function readErrorBodySnippet(res: Response, maxChars = 200): Promise<string | undefined> {
  try {
    const text = await res.text();  // 如果 body 已被读取，会抛出 TypeError
    if (!text) return undefined;
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) return undefined;
    if (collapsed.length <= maxChars) return collapsed;
    return `${collapsed.slice(0, maxChars)}…`;
  } catch {
    return undefined;
  }
}
```

### 根本原因

**Response body 的特性**：
1. **只能读取一次**：调用 `res.text()`, `res.json()`, `res.arrayBuffer()` 等方法后，body 被消耗
2. **读取后 `bodyUsed` 为 true**：表示 body 已被读取
3. **重复读取会抛出 TypeError**："Response body object should not be disturbed or locked"

**问题链条**：
1. Telegram `sendDocument` API 调用失败
2. `fetchRemoteMedia` 捕获错误，尝试读取错误 Response 的 body
3. **如果 body 已被其他代码读取**（如重试逻辑、日志记录等），`res.text()` 会抛出 TypeError
4. 错误没有被正确处理，导致 unhandled promise rejection
5. 系统崩溃

---

## 核心原则

### 原则 1：检查 `bodyUsed` 再读取

**正确做法**：
```typescript
// ✅ 正确：检查 body 是否已被读取
async function readErrorBodySnippet(res: Response, maxChars = 200): Promise<string | undefined> {
  try {
    // 检查 body 是否已被读取
    if (res.bodyUsed) {
      console.warn("[fetchRemoteMedia] Response body already consumed, cannot read error snippet");
      return undefined;
    }
    
    const text = await res.text();
    // ... 后续处理
  } catch (error) {
    console.warn("[fetchRemoteMedia] Failed to read error body snippet:", error);
    return undefined;
  }
}
```

### 原则 2：使用 `clone()` 避免消耗原始 body

**正确做法**：
```typescript
// ✅ 正确：克隆 Response 以避免消耗原始 body
async function readErrorBodySnippet(res: Response, maxChars = 200): Promise<string | undefined> {
  try {
    // 克隆 Response 以避免消耗原始 body
    const clone = res.clone();
    const text = await clone.text();
    
    if (!text) return undefined;
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) return undefined;
    if (collapsed.length <= maxChars) return collapsed;
    return `${collapsed.slice(0, maxChars)}…`;
  } catch (error) {
    console.warn("[fetchRemoteMedia] Failed to read error body snippet:", error);
    return undefined;
  }
}
```

### 原则 3：错误处理要完整

**错误做法**：
```typescript
// ❌ 错误：catch 块中不记录错误，难以调试
try {
  const text = await res.text();
  // ...
} catch {
  return undefined;  // 静默失败，不知道发生了什么
}
```

**正确做法**：
```typescript
// ✅ 正确：记录错误但不抛出，避免崩溃
try {
  const text = await res.text();
  // ...
} catch (error) {
  console.warn("[fetchRemoteMedia] Failed to read error body snippet:", error);
  return undefined;
}
```

---

## 修复方案

### 修复 1：检查 `bodyUsed` + 克隆 Response

**位置**：`src/media/fetch.ts`

```typescript
async function readErrorBodySnippet(res: Response, maxChars = 200): Promise<string | undefined> {
  try {
    // 检查 body 是否已被读取
    if (res.bodyUsed) {
      console.warn("[fetchRemoteMedia] Response body already consumed, cannot read error snippet");
      return undefined;
    }
    
    // 克隆 Response 以避免消耗原始 body
    const clone = res.clone();
    const text = await clone.text();
    
    if (!text) return undefined;
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) return undefined;
    if (collapsed.length <= maxChars) return collapsed;
    return `${collapsed.slice(0, maxChars)}…`;
  } catch (error) {
    // 记录错误但不抛出
    console.warn("[fetchRemoteMedia] Failed to read error body snippet:", error);
    return undefined;
  }
}
```

### 修复 2：避免全局拦截器拦截非 LLM 请求

**位置**：`src/infra/llm-gated-fetch.ts`

**问题**：`llm-gated-fetch` 拦截了所有 fetch 请求，包括 Telegram API 请求

**修复**：只拦截 LLM 请求

```typescript
const wrapped: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    const ctx = getLlmRequestContext();
    
    // 如果没有 LLM 请求上下文，直接调用原始 fetch
    if (!ctx) {
      return await original(input, init);
    }
    
    // 检查是否是 LLM API 请求
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const isLlmRequest = 
      url.includes("openai.com") ||
      url.includes("anthropic.com") ||
      url.includes("generativelanguage.googleapis.com") ||
      url.includes("vectorengine") ||
      url.includes("gemini");
    
    // 如果不是 LLM 请求，直接调用原始 fetch
    if (!isLlmRequest) {
      return await original(input, init);
    }
    
    // ... 后续 LLM 请求处理逻辑
  } catch (error) {
    // ... 错误处理
  }
};
```

---

## 验证方法

### 1. 构建系统

```powershell
pnpm build
```

### 2. 验证修改生效

```powershell
# 检查源码
Get-Content src/media/fetch.ts | Select-String -Pattern "bodyUsed|clone\(\)" -Context 2,2

# 检查构建输出
Get-Content dist/media/fetch.js | Select-String -Pattern "bodyUsed|clone\(\)" -Context 2,2
```

### 3. 测试 Telegram 文件发送

1. 在 Telegram 频道中发送消息："发我一个文件"
2. 观察系统是否崩溃
3. 检查错误日志

### 4. 模拟网络错误

1. 断开网络连接
2. 尝试发送文件
3. 观察错误处理是否正确

---

## 相关场景

### 场景 1：读取 Response body 用于日志

**错误做法**：
```typescript
// ❌ 错误：直接读取 body，后续代码无法再读取
const res = await fetch(url);
const text = await res.text();  // body 被消耗
console.log("Response:", text);

// 后续代码无法再读取 body
const json = await res.json();  // ❌ 抛出 TypeError
```

**正确做法**：
```typescript
// ✅ 正确：克隆 Response
const res = await fetch(url);
const clone = res.clone();
const text = await clone.text();  // 读取克隆的 body
console.log("Response:", text);

// 原始 Response 的 body 仍然可用
const json = await res.json();  // ✅ 正常工作
```

### 场景 2：错误处理中读取 body

**错误做法**：
```typescript
// ❌ 错误：不检查 bodyUsed
if (!res.ok) {
  const errorText = await res.text();  // 如果 body 已被读取，会抛出错误
  throw new Error(`Request failed: ${errorText}`);
}
```

**正确做法**：
```typescript
// ✅ 正确：检查 bodyUsed 或使用 clone()
if (!res.ok) {
  let errorText = "Unknown error";
  if (!res.bodyUsed) {
    try {
      const clone = res.clone();
      errorText = await clone.text();
    } catch (error) {
      console.warn("Failed to read error body:", error);
    }
  }
  throw new Error(`Request failed: ${errorText}`);
}
```

### 场景 3：重试逻辑中的 Response 处理

**错误做法**：
```typescript
// ❌ 错误：重试时 Response body 已被消耗
async function fetchWithRetry(url: string, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const errorText = await res.text();  // body 被消耗
        throw new Error(errorText);
      }
      return await res.json();  // ❌ 如果前面读取了 text，这里会失败
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
```

**正确做法**：
```typescript
// ✅ 正确：使用 clone() 或分开处理
async function fetchWithRetry(url: string, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let errorText = "Unknown error";
        if (!res.bodyUsed) {
          try {
            const clone = res.clone();
            errorText = await clone.text();
          } catch {}
        }
        throw new Error(errorText);
      }
      return await res.json();  // ✅ 正常工作
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
```

---

## 关键词

Response body, bodyUsed, clone, disturbed, locked, TypeError, fetch, unhandled promise rejection, 系统崩溃, 重复读取, 错误处理, Telegram, sendDocument, fetchRemoteMedia

---

**版本**：v20260206_1  
**最后更新**：2026-02-06  
**变更**：新增"Response body 重复读取导致崩溃"（当尝试多次读取 Response body 时的正确处理方法）
