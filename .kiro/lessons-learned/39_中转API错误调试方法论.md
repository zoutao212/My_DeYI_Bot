# 中转 API 错误调试方法论

**触发场景**：使用中转 API 时，API 返回不明确的错误信息

**核心价值**：系统化的调试流程，避免被中转 API 的错误信息误导

---

## 问题识别

### 典型症状

1. **错误信息不明确**：
   - "An unkown error ocurred"（拼写错误）
   - "Invalid request"（没有具体细节）
   - "Internal server error"（太笼统）

2. **错误信息不准确**：
   - 错误信息指向的字段不是真正的问题
   - 错误信息与实际问题不符

3. **API 行为不一致**：
   - 相同的 payload，有时成功有时失败
   - 官方 API 成功，中转 API 失败

### 为什么会发生

1. **中转 API 的适配层问题**：
   - 中转 API 需要适配官方 API 的格式
   - 适配层可能有 bug 或不完善

2. **中转 API 的限流或配额**：
   - 中转 API 可能有自己的限流规则
   - 超过限流时返回不明确的错误

3. **中转 API 的内部错误**：
   - 中转 API 自己的服务问题
   - 与官方 API 的通信问题

---

## 标准调试流程（5 步法）

### 第一步：验证 Payload 格式

**目的**：确认问题不在我们这边

**操作**：
1. 提取发送的 payload
2. 对照官方 API 文档验证格式
3. 检查所有字段是否符合规范

**关键点**：
- 不要相信中转 API 的错误信息
- 必须自己验证 payload 格式
- 重点检查：字段位置、字段类型、字段名称

**判断标准**：
- ✅ Payload 格式正确 → 继续下一步
- ❌ Payload 格式错误 → 修复 payload

### 第二步：对比成功和失败的请求

**目的**：找出导致错误的具体差异

**操作**：
1. 找到一个成功的请求
2. 提取成功和失败的 payload
3. 逐字段对比差异

**关键点**：
- 重点检查：新增的字段、修改的值、长度变化
- 不要只看顶层，要逐层对比
- 记录所有差异，不要只看第一个

**判断标准**：
- ✅ 找到差异 → 修复差异并测试
- ❌ 没有差异 → 继续下一步

### 第三步：简化 Payload 测试

**目的**：排除某些字段的影响

**操作**：
1. 创建最简单的 payload（只保留必需字段）
2. 测试是否成功
3. 逐步添加字段，找出导致错误的字段

**简化策略**：
```typescript
// 最简 payload
{
  model: "...",
  contents: [
    { role: "user", parts: [{ text: "Hello" }] }
  ]
}

// 逐步添加
// + systemInstruction
// + tools
// + generationConfig
// + thought_signature
// ...
```

**判断标准**：
- ✅ 简化后成功 → 找到了导致错误的字段
- ❌ 简化后仍失败 → 继续下一步

### 第四步：切换到官方 API 测试

**目的**：确认是否是中转 API 的问题

**操作**：
1. 配置官方 API 的 key
2. 使用相同的 payload 测试
3. 对比官方 API 和中转 API 的响应

**关键点**：
- 使用完全相同的 payload
- 记录官方 API 的响应
- 对比错误信息的差异

**判断标准**：
- ✅ 官方 API 成功 → 确认是中转 API 的问题
- ❌ 官方 API 也失败 → payload 有问题，回到第一步

### 第五步：联系服务商或切换服务商

**目的**：获取更详细的错误信息或解决问题

**操作**：
1. 提供详细的错误信息（runId、时间戳、payload）
2. 询问服务商后台的详细日志
3. 如果服务商无法解决，考虑切换服务商

**关键点**：
- 提供完整的上下文信息
- 明确说明已经做过的调试步骤
- 如果服务商响应慢，考虑切换

---

## 常见错误模式

### 错误 1：完全信任中转 API 的错误信息

**问题**：
- 中转 API 说 "thought_signature is not valid"
- 但真正的问题是 `content: null`

**解决**：
- 不要相信错误信息
- 必须自己验证 payload 格式
- 对比成功和失败的请求

### 错误 2：没有对比官方 API

**问题**：
- 一直在中转 API 上调试
- 不知道是中转 API 的问题还是 payload 的问题

**解决**：
- 尽早切换到官方 API 测试
- 对比官方 API 和中转 API 的行为
- 确认问题的根源

### 错误 3：没有简化测试

**问题**：
- payload 太复杂，难以定位问题
- 不知道是哪个字段导致的错误

**解决**：
- 从最简单的 payload 开始
- 逐步添加字段
- 找出导致错误的字段

---

## 中转 API 的常见问题

### 问题 1：格式适配不完善

**症状**：
- 官方 API 支持的字段，中转 API 不支持
- 中转 API 返回 "Invalid field" 错误

**解决**：
- 移除不支持的字段
- 或切换到官方 API

### 问题 2：限流或配额

**症状**：
- 有时成功，有时失败
- 错误信息不明确

**解决**：
- 检查中转 API 的限流规则
- 添加重试机制
- 或切换到官方 API

### 问题 3：内部错误

**症状**：
- 错误信息太笼统（"Internal server error"）
- 无法定位具体问题

**解决**：
- 联系服务商获取详细日志
- 或切换到官方 API

---

## 临时解决方案

### 方案 A：添加重试机制

在检测到中转 API 的不明确错误时，自动重试：

```typescript
if (errorMessage.includes("unkown error") || errorMessage.includes("Internal server error")) {
  // 重试 1-2 次
  // 如果仍然失败，返回友好的错误提示
}
```

### 方案 B：自动切换到官方 API

如果中转 API 连续失败多次，自动切换：

```typescript
if (failureCount >= 3) {
  log.warn("中转 API 连续失败，切换到官方 API");
  // 切换到官方 API
}
```

### 方案 C：降级到更简单的 Payload

如果检测到错误，自动降级：

```typescript
if (error) {
  // 移除 thought_signature
  // 缩短 systemInstruction
  // 简化 tools 定义
}
```

---

## 质量门槛

每次调试中转 API 错误时必须满足：

- ✅ **验证了 payload 格式**：确认格式符合官方 API 规范
- ✅ **对比了成功和失败的请求**：找出差异
- ✅ **简化了 payload 测试**：排除字段影响
- ✅ **切换到官方 API 测试**：确认问题根源
- ✅ **记录了调试过程**：便于后续参考

---

## 实战案例

### 案例 1：thought_signature 错误

**问题**：中转 API 返回 "Thought signature is not valid"

**调试过程**：
1. 验证 payload → 发现 `content: null`
2. 对比成功和失败 → 发现成功的请求 content 不是 null
3. 修复 content → 问题解决

**教训**：不要相信中转 API 的错误信息

### 案例 2：config 字段错误

**问题**：中转 API 返回 "Request contains an invalid argument"

**调试过程**：
1. 验证 payload → 发现有 `config` 字段
2. 查阅官方 API 文档 → 确认 Gemini API 不认识 `config` 字段
3. 展开 config 字段到顶层 → 问题解决

**教训**：中转 API 的适配层可能生成不符合规范的 payload

### 案例 3：An unkown error ocurred

**问题**：中转 API 返回 "An unkown error ocurred"（拼写错误）

**调试过程**：
1. 验证 payload → 格式完全正确
2. 对比成功和失败 → 没有明显差异
3. 简化 payload → 仍然失败
4. 切换到官方 API → 成功
5. 结论：中转 API 的内部问题

**教训**：当所有调试都无效时，问题可能在中转 API 本身

---

## 最佳实践

### 1. 不要完全依赖中转 API

**原则**：中转 API 只是一个便利工具，不是必需品

**做法**：
- 保留官方 API 的配置
- 必要时随时切换
- 不要在中转 API 上浪费太多时间

### 2. 尽早验证 Payload 格式

**原则**：不要相信中转 API 的错误信息

**做法**：
- 第一步就验证 payload 格式
- 对照官方 API 文档
- 确认格式完全正确

### 3. 对比官方 API 和中转 API

**原则**：用官方 API 作为基准

**做法**：
- 相同的 payload 在两个 API 上测试
- 对比响应和错误信息
- 确认问题的根源

### 4. 添加容错机制

**原则**：系统不能因为中转 API 的问题就罢工

**做法**：
- 添加重试机制
- 自动切换到官方 API
- 提供友好的错误提示

---

## 工具脚本

### 切换 API 脚本

```typescript
// switch-api.ts
export async function switchToOfficialApi(config: Config) {
  log.warn("切换到官方 API");
  
  // 保存当前配置
  const backupConfig = { ...config };
  
  // 切换到官方 API
  config.provider = "google";
  config.apiKey = process.env.GOOGLE_API_KEY;
  
  return { backupConfig };
}
```

### 简化 Payload 脚本

```typescript
// simplify-payload.ts
export function simplifyPayload(payload: any) {
  return {
    model: payload.model,
    contents: [
      {
        role: "user",
        parts: [{ text: "Hello" }]
      }
    ]
  };
}
```

---

## 临时故障的识别和处理

### 如何识别临时故障

**典型特征**：
1. **Payload 格式完全正确**
   - 所有字段都符合 API 规范
   - 之前的修复都已生效

2. **错误信息不明确**
   - "An unkown error ocurred"
   - "Internal server error"
   - 没有具体的错误细节

3. **API 开始处理了但中途出错**
   - 第一个 chunk 正常
   - 第二个 chunk 错误

4. **等待后重试成功**
   - 相同的 payload
   - 等待 10-30 分钟后重试
   - 成功返回

### 处理策略

**步骤 1：验证 Payload 格式**
```typescript
// 确认 payload 格式正确
if (isPayloadValid(payload)) {
  log.info("Payload 格式正确，可能是 API 临时故障");
}
```

**步骤 2：等待后重试**
```typescript
// 等待 10-30 分钟后重试
await sleep(10 * 60 * 1000); // 10 分钟
const result = await retryRequest(payload);
```

**步骤 3：添加重试机制**
```typescript
async function requestWithRetry(payload: any, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await apiRequest(payload);
      return result;
    } catch (error) {
      if (isTemporaryError(error) && i < maxRetries - 1) {
        log.warn(`临时故障，等待后重试 (${i + 1}/${maxRetries})`);
        await sleep(10 * 60 * 1000); // 等待 10 分钟
      } else {
        throw error;
      }
    }
  }
}

function isTemporaryError(error: any): boolean {
  const message = error.message?.toLowerCase() || "";
  return (
    message.includes("unkown error") ||
    message.includes("internal server error") ||
    message.includes("service unavailable")
  );
}
```

**步骤 4：切换到官方 API**
```typescript
// 如果重试多次仍失败，切换到官方 API
if (retryCount >= 3) {
  log.warn("中转 API 持续失败，切换到官方 API");
  await switchToOfficialApi();
}
```

### 实战案例：An unkown error ocurred

**问题**：
- Payload 格式完全正确（config 已展开）
- API 返回 "An unkown error ocurred"
- 第一个 chunk 正常，第二个 chunk 错误

**调试过程**：
1. 验证 payload → 格式完全正确 ✅
2. 对比成功和失败 → 格式都正确 ✅
3. 简化 payload → 仍然失败 ❌
4. 等待 20 分钟后重试 → 成功 ✅

**结论**：中转 API 的临时故障

**教训**：
- 不要急于做更多修复
- 如果 payload 格式正确，等待后重试
- 中转 API 可能有临时故障

---

## 总结

中转 API 错误调试的核心原则：

1. **不要完全信任中转 API** - 错误信息可能不准确
2. **验证 payload 格式** - 确认问题不在我们这边
3. **对比官方 API** - 用官方 API 作为基准
4. **简化测试** - 排除字段影响
5. **识别临时故障** - 如果格式正确，可能是临时故障
6. **等待后重试** - 不要急于做更多修复
7. **添加容错机制** - 系统不能因为中转 API 罢工

通过这套方法论，可以：
- 快速定位问题根源
- 避免被错误信息误导
- 识别临时故障
- 确保系统稳定运行
- 降低调试时间

---

**版本：** v20260131_2  
**最后更新：** 2026-01-31  
**来源：** API 错误调试实战（thought_signature + config + An unkown error + 临时故障识别）  
**变更：** 新增"临时故障的识别和处理"章节

