# enqueue_task 工具使用说明设计

## 任务目标

设计 `enqueue_task` 工具在 Tooling section 中的简短说明。

## 设计要求

根据任务 1.1.3 的要求：
- 在 Tooling section 中添加 `enqueue_task` 工具的简短说明
- 说明格式：`- enqueue_task: 将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。`

## 当前状态

查看 `src/agents/system-prompt.l10n.zh.ts` 文件，发现 `toolSummaries` 中已经有 `enqueue_task` 的说明：

```typescript
enqueue_task: "将任务加入队列，稍后自动执行（仅在用户直接要求时使用，执行队列任务时不要调用）",
```

## 设计方案

### 方案 1：更新现有说明（推荐）

**优点**：
- 复用现有机制
- 不需要修改系统提示词生成逻辑
- 保持一致性

**缺点**：
- 需要同时更新中文和英文翻译

**实施步骤**：

1. 更新 `src/agents/system-prompt.l10n.zh.ts` 中的 `enqueue_task` 说明：
   ```typescript
   enqueue_task: "将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。",
   ```

2. 更新 `src/agents/system-prompt.l10n.en.ts` 中的 `enqueue_task` 说明：
   ```typescript
   enqueue_task: "Enqueue a task for automatic execution later. Use for generating multiple content segments or executing a series of related tasks. Each task will be executed and replied to separately.",
   ```

### 方案 2：在设计文档中添加说明

**优点**：
- 不修改代码
- 只在设计文档中记录

**缺点**：
- 不会影响实际的系统提示词
- 只是文档记录

**实施步骤**：

在 `.kiro/specs/intelligent-task-decomposition/design.md` 中添加 Tooling section：

```markdown
## Tooling

### enqueue_task 工具

**说明**：将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。

**参数**：
- `prompt` (string, required): 任务的提示词（LLM 将收到这个 prompt）
- `summary` (string, required): 任务的简短描述（用于显示给用户）

**返回值**：
- `taskId` (string): 任务 ID

**使用场景**：
- 生成多段内容（如生成 10000 字的文章）
- 处理大量数据（如总结多个文档）
- 多步骤流程（如先读取文件，再分析内容，最后生成报告）
- 并行处理多个文件或数据

**重要规则**：
- ✅ 用户直接要求时：可以调用 enqueue_task 加入多个任务
- ❌ 执行队列任务时：不要调用 enqueue_task，直接生成内容
```

## 推荐方案

**推荐方案 1**：更新现有说明

**理由**：
1. 任务要求是"在 Tooling section 中添加说明"，而 Tooling section 是系统提示词的一部分
2. 现有的 `toolSummaries` 机制已经支持在 Tooling section 中显示工具说明
3. 更新现有说明可以确保实际的系统提示词包含正确的说明
4. 保持代码和文档的一致性

## 对比分析

### 当前说明 vs 任务要求

**当前说明**：
```
将任务加入队列，稍后自动执行（仅在用户直接要求时使用，执行队列任务时不要调用）
```

**任务要求**：
```
将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。
```

**差异**：
1. 当前说明包含使用限制（"仅在用户直接要求时使用，执行队列任务时不要调用"）
2. 任务要求包含使用场景（"用于生成多段内容或执行一系列关联任务"）
3. 任务要求包含执行方式（"每个任务会单独执行并回复"）

**建议**：
- 保留当前说明中的使用限制（这是重要的安全规则）
- 添加任务要求中的使用场景和执行方式
- 综合后的说明：
  ```
  将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。仅在用户直接要求时使用，执行队列任务时不要调用。
  ```

## 最终设计

### 中文说明

```typescript
enqueue_task: "将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。",
```

**说明**：
- 简洁明了，符合任务要求
- 包含使用场景和执行方式
- 长度适中，不会让系统提示词过长

**注意**：使用限制（"仅在用户直接要求时使用，执行队列任务时不要调用"）已经在系统提示词的其他部分（`enqueueTaskRulesTitle` 等）中详细说明，不需要在工具说明中重复。

### 英文说明

```typescript
enqueue_task: "Enqueue a task for automatic execution later. Use for generating multiple content segments or executing a series of related tasks. Each task will be executed and replied to separately.",
```

## 验收标准

- ✅ 说明简短、清晰
- ✅ 说明了工具的用途（"将任务加入队列，稍后自动执行"）
- ✅ 说明了使用场景（"用于生成多段内容或执行一系列关联任务"）
- ✅ 说明了执行方式（"每个任务会单独执行并回复"）
- ✅ 符合任务要求的格式

## 实施计划

1. 更新 `src/agents/system-prompt.l10n.zh.ts` 中的 `enqueue_task` 说明
2. 更新 `src/agents/system-prompt.l10n.en.ts` 中的 `enqueue_task` 说明
3. 构建系统：`pnpm build`
4. 验证系统提示词中的工具说明是否正确
5. 标记任务为完成

---

**版本**：v20260204_1  
**创建时间**：2026-02-04  
**任务**：1.1.3 设计 enqueue_task 工具使用说明
