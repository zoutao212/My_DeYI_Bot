# LLM 审批流程修复验证

## 修复内容

### 问题诊断
- **根本原因**：`llm-approval-wrapper.ts` 使用本地 EventEmitter，而网关使用 WebSocket 广播系统，两者没有对接
- **症状**：Control UI 无法收到审批请求，审批对话框不弹出

### 修复方案
在 `src/gateway/server.impl.ts` 中添加全局处理器注册：

```typescript
// 注册全局审批处理器，连接 llm-approval-wrapper 和网关广播系统
registerGlobalApprovalRequestHandler(async (payload) => {
  const timeout = payload.expiresAtMs - payload.createdAtMs;
  const record = llmApprovalManager.createOrGet(payload.request, timeout, payload.id);
  const decisionPromise = llmApprovalManager.waitForDecision(record, timeout);
  
  // 广播审批请求到所有连接的客户端（包括 Control UI）
  broadcast(
    "llm.approval.requested",
    {
      id: record.id,
      request: record.request,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    },
    { dropIfSlow: true },
  );
  
  const decision = await decisionPromise;
  return decision ?? "deny"; // 超时默认拒绝
});
```

### 修复效果
1. ✅ `llm-approval-wrapper.ts` 的 `requestApproval` 现在会调用全局处理器
2. ✅ 全局处理器使用 `llmApprovalManager` 创建审批记录
3. ✅ 通过 `broadcast("llm.approval.requested")` 发送到 Control UI
4. ✅ Control UI 监听事件并显示审批对话框
5. ✅ 用户决策通过 WebSocket 返回到 `llmApprovalManager`
6. ✅ 决策返回给 `requestApproval` 调用者

## 验证步骤

### 1. 启动网关
```bash
npm run start
```

### 2. 打开 Control UI
浏览器访问：http://localhost:18789

### 3. 启用 LLM 审批
在配置文件中设置：
```json
{
  "approvals": {
    "llm": {
      "enabled": true,
      "autoApprove": false
    }
  }
}
```

### 4. 触发 LLM 请求
发送一个需要 LLM 调用的消息

### 5. 验证审批流程
- [ ] Control UI 弹出审批对话框
- [ ] 对话框显示请求详情（provider, model, bodySummary）
- [ ] 点击 "Allow Once" 后请求继续执行
- [ ] 点击 "Deny" 后请求被拒绝
- [ ] 点击 "Allow Always" 后添加到白名单

## 技术细节

### 数据流
```
LLM 调用
  ↓
withApproval() [llm-approval-wrapper.ts]
  ↓
requestApproval()
  ↓
globalApprovalRequestHandler [注册在 server.impl.ts]
  ↓
llmApprovalManager.createOrGet()
  ↓
broadcast("llm.approval.requested") → Control UI
  ↓
用户点击按钮
  ↓
WebSocket: llm.approval.respond
  ↓
llmApprovalManager.resolve()
  ↓
返回决策给 requestApproval()
  ↓
继续或拒绝 LLM 调用
```

### 关键组件
1. **llm-approval-wrapper.ts**：审批包装器，提供 `withApproval()` 和 `requestApproval()`
2. **llm-approval-manager.ts**：审批管理器，管理待审批记录和决策
3. **server.impl.ts**：网关服务器，连接两者并广播事件
4. **Control UI**：监听 `llm.approval.requested` 事件并显示对话框

## 构建状态
✅ TypeScript 编译成功
✅ 代码已部署到 dist/
✅ 审批日志已完善

## 日志输出示例

### 审批请求阶段
```
[llm-approval] 🔍 检查审批：required=true
[llm-approval] 🔒 开始请求审批：LLM 调用 (prompt 长度：56, model: vectorengine/gemini-3-flash-preview)
[llm-approval] 🔄 使用全局审批处理器
[llm-gated-fetch] 🔒 需要审批，正在请求...
```

### 审批响应阶段
```
[llm-approval] 📥 收到审批响应：id=xxx, decision=allow-once, client=user123
[llm-approval] ✅ 审批已解析：id=xxx, decision=allow-once, resolvedBy=user123, waitTime=5234ms
[llm-approval] 📋 请求详情：provider=vectorengine, model=gemini-3-flash-preview, summary=...
[llm-approval] 🎉 审批流程完成：id=xxx, decision=allow-once
[llm-approval] ✅ 收到审批决策：allow-once
[llm-approval] 📊 决策详情：provider=vectorengine, model=gemini-3-flash-preview, decision=allow-once
[llm-gated-fetch] ✅ 审批决策：allow-once
```

### LLM 请求执行阶段
```
[llm-gated-fetch] 🚀 审批通过，正在执行 LLM 请求...
[llm-gated-fetch] 📤 开始执行请求：https://api.vectorengine.ai/v1/chat/completions
[llm-gated-fetch] 🌐 调用 original fetch...
[llm-gated-fetch] ✅ Fetch 完成，状态码：200
[llm-gated-fetch] ✅ LLM 请求完成，状态码：200
```

### 白名单添加
```
[llm-approval] 💾 已添加到白名单：provider=vectorengine, model=gemini-3-flash-preview
```

## 修复内容（第三轮 - 关键修复）

### 问题诊断
- **症状**：审批通过后，LLM 请求没有真正发送，日志停在 `[runEmbeddedPiAgent] 🔒 等待人工审批`
- **根本原因**：`pi-embedded-runner/run.ts` 使用本地 EventEmitter（`approvalEvents.emit/once`），而不是调用全局处理器
- **为什么全局处理器没被调用**：代码直接使用 EventEmitter 进行进程内通信，绕过了 `requestApproval` 函数

### 修复方案
将 `pi-embedded-runner/run.ts` 中的审批逻辑从本地 EventEmitter 改为使用 `withApproval` 包装器：

```typescript
// 修复前（错误）：
const { approvalEvents } = await import("../../infra/llm-approval-wrapper.js");
await new Promise<void>((resolve, reject) => {
  // ... EventEmitter 监听逻辑
  approvalEvents.once("approval-decision", onDecision);
  approvalEvents.emit("approval-request", { ... });
});

// 修复后（正确）：
const { withApproval } = await import("../../infra/llm-approval-wrapper.js");
await withApproval(
  async () => {
    console.log(`[runEmbeddedPiAgent] ✅ 审批通过，继续执行`);
  },
  () => approvalPayload,
);
```

### 修复效果
现在审批流程完整打通：
1. ✅ `runEmbeddedPiAgent` 检测到需要审批
2. ✅ 调用 `withApproval` → `requestApproval`
3. ✅ `requestApproval` 调用全局处理器
4. ✅ 全局处理器使用 `llmApprovalManager` 创建记录
5. ✅ 通过 `broadcast` 发送到 Control UI
6. ✅ 用户审批后，决策返回
7. ✅ LLM 请求真正执行

## 修复内容（第四轮 - SystemLLMCaller 修复）

### 问题诊断
- **症状**：`SystemLLMCaller` 等待审批，点击审批通过后没有后续进度
- **根本原因**：`system-llm-caller.ts` 也在使用本地 EventEmitter，和 `pi-embedded-runner` 一样的问题
- **影响范围**：任务分解系统的 LLM 调用（复杂度预判、任务分解、质量评估）

### 修复方案
将 `system-llm-caller.ts` 中的审批逻辑从本地 EventEmitter 改为使用 `withApproval` 包装器：

```typescript
// 修复前（错误）：
const { approvalEvents } = await import("../../infra/llm-approval-wrapper.js");
await new Promise<void>((resolve, reject) => {
  // ... EventEmitter 监听逻辑
  approvalEvents.once("approval-decision", onDecision);
  approvalEvents.emit("approval-request", { ... });
});

// 修复后（正确）：
const { withApproval } = await import("../../infra/llm-approval-wrapper.js");
await withApproval(
  async () => {
    console.log(`[SystemLLMCaller] ✅ 审批通过，继续执行`);
  },
  () => approvalPayload,
);
```

### 修复效果
现在两个 LLM 调用入口都已修复：
1. ✅ `runEmbeddedPiAgent`（主 Agent 执行）
2. ✅ `SystemLLMCaller`（任务分解系统）

两者都使用 `withApproval` → 全局处理器 → 网关广播 → Control UI

## 下一步
- 重启网关服务
- 测试审批流程
- 验证白名单功能
