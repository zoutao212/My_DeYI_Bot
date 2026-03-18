# LLM 审批配置完全指南

## 配置文件位置

```
C:\Users\zouta\.clawdbot\llm-approvals.json
```

## 配置结构

```json
{
  "version": 1,
  "enabled": true,           // 是否启用审批功能
  "ask": "always",           // 审批策略：off | always | on-miss
  "rules": []                // 白名单规则列表
}
```

## 审批策略详解

### 1. `ask: "off"` - 完全关闭审批
- 所有 LLM 请求直接通过，不需要审批
- 适用场景：开发测试、完全信任的环境

### 2. `ask: "always"` - 每次都审批（推荐）
- **每个 LLM 请求都需要人工审批**
- 即使命中白名单规则，也会询问
- 适用场景：最高安全级别，完全控制

### 3. `ask: "on-miss"` - 白名单模式（当前使用）
- 命中白名单规则 → 自动通过（`allow-once`）
- 未命中白名单 → 需要人工审批
- 适用场景：平衡安全性和便利性

## 当前配置分析

你的配置文件显示：
```json
{
  "version": 1,
  "enabled": true,
  "ask": "always",  // ← 这里设置的是 always
  "rules": [
    // 但是有两条白名单规则
    {
      "provider": "arpaneticu",
      "modelId": "gemini-3-flash-preview",
      "source": "webchat",
      "sessionKey": "agent:main:3df5cb35-748d-4c12-9791-fe52dd0fbf70",
      "urlHost": "arpanet.icu"
    },
    {
      "provider": "vectorengine",
      "modelId": "gemini-3-flash-preview",
      "source": "webchat",
      "sessionKey": "agent:main:3df5cb35-748d-4c12-9791-fe52dd0fbf70",
      "urlHost": "api.vectorengine.ai"
    }
  ]
}
```

### 为什么会自动审批？

**真正的原因：审批缓存机制！**

系统有一个 **5 分钟的审批缓存**：

```typescript
const APPROVAL_CACHE_TTL_MS = 5 * 60_000; // 5 分钟缓存
```

**工作流程：**
1. 第一次 LLM 请求 → 弹出审批对话框
2. 你点击 "Allow Once" → 审批通过
3. **系统缓存这个决策 5 分钟**
4. 5 分钟内相同的请求 → 直接使用缓存，不再询问
5. 5 分钟后 → 缓存过期，再次询问

**缓存键计算：**
```typescript
function computeCacheKey(payload: LlmApprovalRequestPayload): string {
  const stable = JSON.stringify({
    provider: payload.provider,
    modelId: payload.modelId,
    url: payload.url,
    method: payload.method,
    bodySummary: payload.bodySummary,
  });
  return createHash("sha256").update(stable).digest("hex");
}
```

相同的 provider + model + url + bodySummary 会被视为相同请求。

### 三层审批机制

系统实际上有三层审批机制：

1. **白名单检查**（`llm-approvals.json` 的 `rules`）
   - 命中白名单 → 跳过审批
   - 未命中 → 继续下一步

2. **审批缓存检查**（内存缓存，5 分钟）
   - 命中缓存 → 使用缓存决策
   - 未命中 → 继续下一步

3. **人工审批**（弹出对话框）
   - 用户点击 Allow/Deny
   - 决策被缓存 5 分钟

## 如何配置"每次都审批"（真正的每次）

### 方案 1：禁用审批缓存（代码修改）

修改 `src/infra/llm-approval-wrapper.ts`，将缓存时间设置为 0：

```typescript
const APPROVAL_CACHE_TTL_MS = 0; // 禁用缓存
```

### 方案 2：清空白名单 + 重启网关

编辑 `C:\Users\zouta\.clawdbot\llm-approvals.json`：

```json
{
  "version": 1,
  "enabled": true,
  "ask": "always",
  "rules": []  // ← 清空白名单
}
```

然后重启网关清除内存缓存。

### 方案 3：手动清除缓存（临时）

在代码中调用：
```typescript
import { clearApprovalCache } from "./infra/llm-approval-wrapper.js";
clearApprovalCache();
```

但这只是临时清除，5 分钟后又会缓存。

### 方案 4：修改缓存逻辑（推荐）

修改 `src/infra/llm-approval-wrapper.ts` 的 `requestApproval` 函数，添加配置选项：

```typescript
async function requestApproval(
  payload: LlmApprovalRequestPayload,
  timeoutMs: number = APPROVAL_TIMEOUT_MS,
  useCache: boolean = true,  // 新增参数
): Promise<LlmApprovalDecision> {
  if (!useCache) {
    // 跳过缓存检查，直接请求审批
    // ...
  }
  
  const cacheKey = computeCacheKey(payload);
  const cached = approvalCache.get(cacheKey);
  
  if (cached && Date.now() < cached.expiresAt) {
    return cached.decision;
  }
  // ...
}
```

然后在配置文件中添加：
```json
{
  "version": 1,
  "enabled": true,
  "ask": "always",
  "useCache": false,  // 禁用缓存
  "rules": []
}
```

## 立即生效的临时方案

如果你想立即测试"每次都审批"，最简单的方法是：

1. 清空白名单：
```powershell
$config = Get-Content "$env:USERPROFILE\.clawdbot\llm-approvals.json" | ConvertFrom-Json
$config.rules = @()
$config | ConvertTo-Json -Depth 10 | Set-Content "$env:USERPROFILE\.clawdbot\llm-approvals.json"
```

2. 重启网关（清除内存缓存）

3. 等待 5 分钟（让旧缓存过期）

或者直接修改代码，将缓存时间改为 0。

## 白名单规则详解

### 规则匹配逻辑

一个请求命中白名单需要满足所有指定的条件：

```typescript
{
  "provider": "vectorengine",      // 匹配 provider
  "modelId": "gemini-3-flash-preview",  // 匹配 model
  "source": "webchat",             // 匹配来源
  "sessionKey": "agent:main:...",  // 匹配会话
  "urlHost": "api.vectorengine.ai", // 匹配域名
  "urlPathPrefix": "/v1/chat/completions"  // 匹配路径前缀
}
```

### 规则字段说明

- `id`: 规则唯一标识（自动生成）
- `enabled`: 是否启用（默认 true）
- `provider`: 提供商名称（可选）
- `modelId`: 模型 ID（可选）
- `source`: 来源标识（可选）
- `sessionKey`: 会话密钥（可选）
- `urlHost`: URL 域名（可选）
- `urlPathPrefix`: URL 路径前缀（可选）
- `lastUsedAt`: 最后使用时间（自动更新）
- `lastUsedSummary`: 最后使用摘要（自动更新）

### 如何添加白名单

点击 Control UI 中的 "Allow Always" 按钮，系统会自动添加规则。

## 推荐配置

### 开发环境（完全信任）

```json
{
  "version": 1,
  "enabled": false,  // 关闭审批
  "ask": "off",
  "rules": []
}
```

### 生产环境（最高安全）

```json
{
  "version": 1,
  "enabled": true,
  "ask": "always",  // 每次都审批
  "rules": []       // 不使用白名单
}
```

### 日常使用（平衡模式）

```json
{
  "version": 1,
  "enabled": true,
  "ask": "on-miss",  // 白名单模式
  "rules": [
    // 信任的 provider/model 组合
  ]
}
```

## 立即生效

修改配置文件后，**无需重启网关**，下次 LLM 请求时自动加载新配置。

## 验证配置

查看日志中的审批检查：

```
[llm-approval] 🔍 检查审批：required=true   // 需要审批
[llm-approval] 🔍 检查审批：required=false, matchedRuleId=xxx  // 命中白名单
```

## 总结

要实现"每次都审批"，已完成以下修改：

### ✅ 已完成的修改

1. **禁用审批缓存**（代码修改）
   - 文件：`src/infra/llm-approval-wrapper.ts`
   - 修改：`APPROVAL_CACHE_TTL_MS = 0`（从 5 分钟改为 0）
   - 状态：✅ 已构建到 dist/

2. **清空白名单**（配置修改）
   - 文件：`C:\Users\zouta\.clawdbot\llm-approvals.json`
   - 修改：`rules: []`（清空所有白名单规则）
   - 状态：✅ 已更新

3. **设置审批策略**
   - 配置：`ask: "always"`
   - 状态：✅ 已确认

### 🎯 最终效果

现在系统的审批行为：
- ✅ 每个 LLM 请求都会触发审批
- ✅ 不使用缓存，每次都弹出对话框
- ✅ 不使用白名单，所有请求都需要审批
- ✅ 用户必须点击 Allow/Deny 才能继续

### 🔄 下一步

重启网关，新配置立即生效：
```powershell
# 停止当前网关
# 重新启动
npm run start
```

### 📋 验证方法

重启后，发送任何需要 LLM 的消息，应该看到：
1. 日志：`[llm-approval] 🔍 检查审批：required=true`
2. 日志：`[runEmbeddedPiAgent] 🔒 等待人工审批`
3. Control UI 弹出审批对话框
4. 点击 Allow 后才继续执行
5. **下次请求仍然会弹出对话框**（不使用缓存）

### 📝 配置文件内容

```json
{
  "version": 1,
  "enabled": true,
  "ask": "always",
  "rules": []
}
```

所有任务已完成！
