# LLM 主动生成连续任务实现方法

**日期**：2026-02-04  
**问题**：如何让 LLM 主动生成多个关联任务，每个任务单独执行并回复

---

## 问题背景

### 用户需求

用户希望 LLM 能够：
1. 生成多段内容，每段单独回复
2. 执行一系列关联任务，每个任务单独执行
3. 在每个任务之间给用户反馈

### 系统现有机制

系统现有的连续任务机制（`followup queue`）是用来处理**用户发送的多条消息**，不是用来让 **LLM 主动生成任务**。

**关键区别**：
- **用户发送的消息**：系统被动收集，然后处理
- **LLM 主动生成的任务**：LLM 需要主动告诉系统"我还有任务要做"

---

## 解决方案

### 核心思路

添加一个新工具 `enqueue_task`，让 LLM 可以主动将任务加入队列。

### 实现步骤

#### 步骤 1：创建 `enqueue_task` 工具

**文件**：`src/agents/tools/enqueue-task-tool.ts`

**关键设计**：

1. **全局上下文管理**：
```typescript
// 全局上下文：存储当前正在执行的 FollowupRun
let currentFollowupRunContext: FollowupRun["run"] | null = null;

export function setCurrentFollowupRunContext(run: FollowupRun["run"] | null): void {
  currentFollowupRunContext = run;
}

export function getCurrentFollowupRunContext(): FollowupRun["run"] | null {
  return currentFollowupRunContext;
}
```

2. **工具定义**：
```typescript
export function createEnqueueTaskTool(options?: EnqueueTaskOptions): AnyAgentTool {
  return {
    label: "Enqueue Task",
    name: "enqueue_task",
    description: "将任务加入队列，稍后自动执行...",
    parameters: Type.Object({
      prompt: Type.String({ description: "任务的提示词" }),
      summary: Type.Optional(Type.String({ description: "任务的简短描述" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const prompt = readStringParam(params, "prompt", { required: true });
      const summary = readStringParam(params, "summary");
      
      // 从全局上下文获取当前的 run
      const currentRun = getCurrentFollowupRunContext();
      
      // 构建 FollowupRun
      const followupRun: FollowupRun = {
        prompt,
        summaryLine: summary,
        enqueuedAt: Date.now(),
        run: currentRun,
      };
      
      // 使用 followup 模式，每个任务单独执行
      const resolvedQueue = resolveQueueSettings({
        cfg: config ?? ({} as ClawdbotConfig),
        sessionEntry,
        inlineMode: "followup", // ← 关键！
      });
      
      // 加入队列（不去重）
      const enqueued = enqueueFollowupRun(
        agentSessionKey,
        followupRun,
        resolvedQueue,
        "none", // ← 关键！
      );
      
      return jsonResult({ success: true });
    },
  };
}
```

#### 步骤 2：集成到系统

**文件 1**：`src/agents/clawdbot-tools.ts`
```typescript
import { createEnqueueTaskTool } from "./tools/enqueue-task-tool.js";

const tools: AnyAgentTool[] = [
  // ... 其他工具 ...
  createEnqueueTaskTool({
    agentSessionKey: options?.agentSessionKey,
    config: options?.config,
  }),
  // ... 其他工具 ...
];
```

**文件 2**：`src/auto-reply/reply/agent-runner.ts`
```typescript
import { setCurrentFollowupRunContext } from "../../agents/tools/enqueue-task-tool.js";

// 在 runReplyAgent 函数中
await typingSignals.signalRunStart();

// 🔧 设置全局上下文
setCurrentFollowupRunContext(followupRun.run);

try {
  // ... 执行 agent ...
} finally {
  blockReplyPipeline?.stop();
  typing.markRunComplete();
  // 🔧 清理全局上下文
  setCurrentFollowupRunContext(null);
}
```

#### 步骤 3：更新系统提示词

**文件**：`src/agents/system-prompt.l10n.zh.ts`
```typescript
toolSummaries: {
  // ... 其他工具 ...
  enqueue_task: "将任务加入队列，稍后自动执行",
  // ... 其他工具 ...
},
```

---

## 关键设计决策

### 1. 全局上下文管理

**问题**：工具需要访问当前的 `FollowupRun`，但工具创建时无法传递这个参数。

**解决**：使用全局上下文管理器，在 `agent-runner` 中设置和清理。

**优点**：
- 简单直接
- 不需要修改工具创建接口
- 在 `finally` 块中清理，确保不会泄漏

**缺点**：
- 全局状态（但在单线程环境下是安全的）
- 多线程环境下可能需要使用 `AsyncLocalStorage`

**替代方案**：
- 使用 `AsyncLocalStorage`（Node.js 内置）
- 修改工具创建接口，传递 `currentRun`（需要大量修改）

### 2. 队列模式选择

**关键**：使用 `followup` 模式，而不是 `collect` 模式。

**原因**：
- `collect` 模式：合并所有任务，一次性处理（用于处理用户的多条消息）
- `followup` 模式：逐个处理任务，每个任务单独回复（用于 LLM 主动生成的任务）

**代码**：
```typescript
const resolvedQueue = resolveQueueSettings({
  cfg: config ?? ({} as ClawdbotConfig),
  sessionEntry,
  inlineMode: "followup", // ← 关键！
});
```

### 3. 不去重

**关键**：使用 `dedupeMode: "none"`，允许相同的任务多次加入。

**原因**：
- LLM 可能需要生成多个相似的任务
- 去重会导致任务被跳过

**代码**：
```typescript
const enqueued = enqueueFollowupRun(
  agentSessionKey,
  followupRun,
  resolvedQueue,
  "none", // ← 关键！
);
```

---

## 使用示例

### 示例 1：生成多段内容

**用户**：请生成 5 段内容，每段单独回复

**LLM 第 1 次回复**：
```typescript
// 调用 enqueue_task 4 次
enqueue_task({ prompt: "生成第 2 段内容", summary: "第 2 段" })
enqueue_task({ prompt: "生成第 3 段内容", summary: "第 3 段" })
enqueue_task({ prompt: "生成第 4 段内容", summary: "第 4 段" })
enqueue_task({ prompt: "生成第 5 段内容", summary: "第 5 段" })

// 回复第 1 段内容
这是第 1 段内容...
```

**系统自动执行**：
- 执行任务 2：LLM 生成第 2 段内容 → 发送给用户
- 执行任务 3：LLM 生成第 3 段内容 → 发送给用户
- 执行任务 4：LLM 生成第 4 段内容 → 发送给用户
- 执行任务 5：LLM 生成第 5 段内容 → 发送给用户

### 示例 2：分步骤完成复杂任务

**用户**：请帮我完成一个复杂的项目设置

**LLM 第 1 次回复**：
```typescript
// 调用 enqueue_task 将后续步骤加入队列
enqueue_task({ prompt: "创建项目配置文件", summary: "步骤 2" })
enqueue_task({ prompt: "安装依赖", summary: "步骤 3" })
enqueue_task({ prompt: "初始化数据库", summary: "步骤 4" })
enqueue_task({ prompt: "运行测试", summary: "步骤 5" })

// 执行第 1 步
正在创建项目目录...
```

---

## 常见错误

### 错误 1：使用 `collect` 模式

**问题**：队列会合并所有任务，一次性处理

**解决**：使用 `followup` 模式

### 错误 2：忘记清理全局上下文

**问题**：全局上下文泄漏，导致后续请求使用错误的 `currentRun`

**解决**：在 `finally` 块中清理

### 错误 3：工具定义类型错误

**问题**：`execute` 函数签名不正确

**解决**：参考现有工具（如 `cron-tool.ts`）的实现

**正确签名**：
```typescript
execute: async (_toolCallId, args) => {
  const params = args as Record<string, unknown>;
  // ...
}
```

---

## 验证方法

### 1. 构建验证

```powershell
pnpm build
```

### 2. 功能测试

```powershell
# 启动 Clawdbot
.\.A_Start-Clawdbot.cmd

# 发送测试消息
"请生成 3 段内容，每段单独回复"
```

**验证点**：
- LLM 是否调用了 `enqueue_task` 工具
- 队列是否正确执行
- 用户是否收到 3 条独立的回复

### 3. 日志检查

```powershell
# 查看日志
Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Tail 50 -Encoding UTF8
```

**关键日志**：
```
[enqueue_task] ✅ Task enqueued: key=..., summary=...
[scheduleFollowupDrain] 🔍 Called: key=...
[scheduleFollowupDrain] ✅ Starting drain: items=...
```

---

## 扩展方向

### 1. 支持任务优先级

**需求**：某些任务需要优先执行

**实现**：
- 在 `FollowupRun` 中添加 `priority` 字段
- 在队列中按优先级排序

### 2. 支持任务依赖

**需求**：某些任务需要等待其他任务完成

**实现**：
- 在 `FollowupRun` 中添加 `dependencies` 字段
- 在队列中检查依赖关系

### 3. 支持任务取消

**需求**：用户可以取消队列中的任务

**实现**：
- 添加 `cancel_task` 工具
- 从队列中移除指定的任务

---

## 总结

**核心思路**：
- 添加 `enqueue_task` 工具，让 LLM 可以主动将任务加入队列
- 使用全局上下文管理器，让工具可以访问当前的 `FollowupRun`
- 使用 `followup` 模式，每个任务单独执行

**关键点**：
- 全局上下文必须在 `finally` 块中清理
- 队列模式必须是 `followup`，不是 `collect`
- 去重模式必须是 `none`，允许相同的任务多次加入

**适用场景**：
- LLM 需要生成多段内容，每段单独回复
- LLM 需要执行一系列关联任务，每个任务单独执行
- LLM 需要在每个任务之间给用户反馈

---

**版本**：v20260204_1  
**关键词**：LLM 主动生成任务、连续任务、enqueue_task、followup 模式、全局上下文管理

