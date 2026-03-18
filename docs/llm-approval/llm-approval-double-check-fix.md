# LLM 审批双重检查问题修复

## 问题根因

**双重检查导致缓存命中，跳过审批：**

1. `runEmbeddedPiAgent` 和 `SystemLLMCaller` 中先调用 `checkApprovalRequired()` 检查
2. 然后调用 `withApproval()` 包装器
3. `withApproval` 内部再次调用 `checkApprovalRequired()`
4. 第二次检查时，由于 cacheKey 相同，命中缓存中的 `allow-once` 决策
5. 直接返回，不再请求审批

**即使 `APPROVAL_CACHE_TTL_MS = 0`，缓存仍然在同一次调用中有效。**

## 修复方案

删除重复的 `checkApprovalRequired()` 调用，只保留 `withApproval()` 包装器。

### 修改文件

1. `src/agents/pi-embedded-runner/run.ts`
   - 删除手动调用 `checkApprovalRequired()`
   - 删除 `if (required)` 条件判断
   - 直接使用 `withApproval()` 包装器

2. `src/agents/intelligent-task-decomposition/system-llm-caller.ts`
   - 同样删除重复检查
   - 统一使用 `withApproval()` 包装器

### 修复后的逻辑

```typescript
// 构建审批 payload
const approvalPayload = { ... };

// 直接使用 withApproval 包装器（内部会调用 checkApprovalRequired）
await withApproval(
  async () => {
    console.log(`✅ 审批检查完成，准备执行 LLM 调用`);
  },
  () => approvalPayload,
);

// 继续执行 LLM 调用...
```

## 验证步骤

1. 构建：`npm run build` ✅
2. 重启 gateway
3. 测试 `enqueue_task` 创建多个子任务
4. 每个子任务执行时都应该触发审批请求

## 预期效果

- 每次 LLM 调用都会触发审批请求
- 不会因为缓存而跳过审批
- 日志中会看到每个子任务的审批请求

---
**修复时间：** 2026-03-18 09:22
**构建状态：** 成功
