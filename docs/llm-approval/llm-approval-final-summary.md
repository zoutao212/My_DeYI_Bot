# LLM 审批流程修复 - 最终总结

## 本次对话完成的所有工作

### 第一阶段：修复审批流程核心 BUG

#### 问题诊断
- Control UI 无法收到审批请求
- 审批对话框不弹出
- 点击审批后没有后续进度

#### 根本原因
1. `llm-approval-wrapper` 使用本地 EventEmitter
2. 网关使用 WebSocket 广播系统
3. 两者没有对接

#### 修复内容

**1. 连接审批系统**（`server.impl.ts`）
```typescript
registerGlobalApprovalRequestHandler(async (payload) => {
  const timeout = payload.expiresAtMs - payload.createdAtMs;
  const record = llmApprovalManager.createOrGet(payload.request, timeout, payload.id);
  const decisionPromise = llmApprovalManager.waitForDecision(record, timeout);
  
  broadcast("llm.approval.requested", {
    id: record.id,
    request: record.request,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  }, { dropIfSlow: true });
  
  const decision = await decisionPromise;
  return decision ?? "deny";
});
```

**2. 修复 pi-embedded-runner**（`pi-embedded-runner/run.ts`）
```typescript
// 修复前：使用本地 EventEmitter
const { approvalEvents } = await import("../../infra/llm-approval-wrapper.js");
await new Promise<void>((resolve, reject) => {
  approvalEvents.once("approval-decision", onDecision);
  approvalEvents.emit("approval-request", { ... });
});

// 修复后：使用全局处理器
const { withApproval } = await import("../../infra/llm-approval-wrapper.js");
await withApproval(
  async () => {
    console.log(`[runEmbeddedPiAgent] ✅ 审批通过，继续执行`);
  },
  () => approvalPayload,
);
```

**3. 修复 SystemLLMCaller**（`system-llm-caller.ts`）
```typescript
// 同样从 EventEmitter 改为 withApproval
const { withApproval } = await import("../../infra/llm-approval-wrapper.js");
await withApproval(
  async () => {
    console.log(`[SystemLLMCaller] ✅ 审批通过，继续执行`);
  },
  () => approvalPayload,
);
```

### 第二阶段：完善日志追踪

#### 添加的日志点

**1. 审批管理器**（`llm-approval-manager.ts`）
- 审批解析日志（决策、等待时间、请求详情）
- 白名单添加日志

**2. 审批处理器**（`server-methods/llm-approval.ts`）
- 收到审批响应日志
- 审批流程完成日志

**3. 审批包装器**（`llm-approval-wrapper.ts`）
- 收到审批决策日志
- 决策详情日志

**4. LLM 请求执行**（`llm-gated-fetch.ts`）
- 审批决策接收日志
- 审批通过确认日志
- 执行请求日志
- Fetch 调用日志
- 响应接收日志

#### 日志输出示例

```
[llm-approval] 🔍 检查审批：required=true
[runEmbeddedPiAgent] 🔒 等待人工审批：LLM 调用 (prompt 长度：472, model: vectorengine/gemini-3-flash-preview)
[llm-approval] 📥 收到审批响应：id=xxx, decision=allow-once, client=user123
[llm-approval] ✅ 审批已解析：id=xxx, decision=allow-once, resolvedBy=user123, waitTime=5234ms
[llm-approval] 📋 请求详情：provider=vectorengine, model=gemini-3-flash-preview, summary=...
[llm-approval] 🎉 审批流程完成：id=xxx, decision=allow-once
[runEmbeddedPiAgent] ✅ 审批通过，继续执行
[llm-gated-fetch] 🚀 审批通过，正在执行 LLM 请求...
[llm-gated-fetch] 📤 开始执行请求：https://api.vectorengine.ai/v1/chat/completions
[llm-gated-fetch] 🌐 调用 original fetch...
[llm-gated-fetch] ✅ Fetch 完成，状态码：200
```

### 第三阶段：配置"每次都审批"

#### 问题分析

用户发现审批会自动通过，原因是：

**三层审批机制**
1. 白名单检查（`llm-approvals.json` 的 `rules`）
2. **审批缓存**（内存，5 分钟 TTL）⭐ 关键
3. 人工审批（Control UI 对话框）

**自动通过的真正原因**：审批缓存
- 第一次审批通过后，缓存 5 分钟
- 相同的 provider + model + url + bodySummary 会命中缓存
- 缓存命中 → 直接返回 `allow-once`

#### 解决方案

**1. 禁用审批缓存**（代码修改）
```typescript
// src/infra/llm-approval-wrapper.ts
const APPROVAL_CACHE_TTL_MS = 0; // 从 5 * 60_000 改为 0
```

**2. 清空白名单**（配置修改）
```json
{
  "version": 1,
  "enabled": true,
  "ask": "always",
  "rules": []
}
```

**3. 构建并部署**
```powershell
npm run build
```

## 最终状态

### ✅ 已完成的修改

1. **审批流程核心修复**
   - ✅ 全局处理器注册
   - ✅ pi-embedded-runner 修复
   - ✅ SystemLLMCaller 修复

2. **完整日志追踪**
   - ✅ 审批请求日志
   - ✅ 审批响应日志
   - ✅ LLM 执行日志

3. **每次都审批配置**
   - ✅ 禁用审批缓存
   - ✅ 清空白名单
   - ✅ 设置 ask=always

### 🎯 最终效果

现在系统的审批行为：
- ✅ 每个 LLM 请求都会触发审批
- ✅ 不使用缓存，每次都弹出对话框
- ✅ 不使用白名单，所有请求都需要审批
- ✅ 完整的日志追踪整个流程

### 📋 验证方法

重启网关后，发送任何需要 LLM 的消息：
1. 日志显示 `required=true`
2. Control UI 弹出审批对话框
3. 点击 Allow 后继续执行
4. **下次请求仍然会弹出对话框**

### 📁 相关文档

- 修复验证文档：`Runtimelog/tempfile/llm-approval-fix-verification.md`
- 配置完全指南：`Runtimelog/tempfile/llm-approval-configuration-guide.md`
- 最终总结：`Runtimelog/tempfile/llm-approval-final-summary.md`

## 修改的文件清单

1. `src/gateway/server.impl.ts` - 注册全局处理器
2. `src/gateway/llm-approval-manager.ts` - 添加日志
3. `src/gateway/server-methods/llm-approval.ts` - 添加日志
4. `src/infra/llm-approval-wrapper.ts` - 添加日志 + 禁用缓存
5. `src/infra/llm-gated-fetch.ts` - 添加日志
6. `src/agents/pi-embedded-runner/run.ts` - 修复审批逻辑
7. `src/agents/intelligent-task-decomposition/system-llm-caller.ts` - 修复审批逻辑
8. `C:\Users\zouta\.clawdbot\llm-approvals.json` - 清空白名单

## 构建状态

✅ TypeScript 编译成功  
✅ 代码已部署到 dist/  
✅ 配置文件已更新  
✅ 所有文档已完成

## 下一步

重启网关，所有修改立即生效！
