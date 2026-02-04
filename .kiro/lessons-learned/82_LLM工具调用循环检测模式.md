# LLM 工具调用循环检测模式

**日期**：2026-02-04  
**场景**：当 LLM 可能在执行任务时又调用工具生成新任务，导致无限循环

---

## 问题识别

### 典型场景

**场景 1：连续任务生成**
- 用户："请生成 5 段内容"
- LLM 调用 `enqueue_task` 5 次
- 系统执行队列任务："请生成第 1 段内容"
- LLM 又调用 `enqueue_task` 5 次 ❌
- 无限循环

**场景 2：递归工具调用**
- 用户："分析这个项目"
- LLM 调用 `analyze_project` 工具
- 工具内部又调用 `analyze_project` ❌
- 无限递归

### 根本原因

1. **LLM 无法区分执行上下文**
   - 无法区分"用户直接要求"和"执行任务"
   - 无法理解"当前正在执行某个任务"

2. **系统提示词不够**
   - 只在系统提示词中说明，LLM 可能不理解
   - LLM 可能忘记或误解规则

3. **缺少技术层面的保护**
   - 没有在工具层添加检测逻辑
   - 依赖 LLM 的"自觉"

---

## 解决方案

### 核心思路

**在工具层添加循环检测机制，技术手段防止循环。**

### 实施步骤

#### 步骤 1：添加全局标志

```typescript
// 全局标志：标记当前是否正在执行某个任务
let isExecutingTask = false;

export function setExecutingTaskFlag(flag: boolean): void {
  isExecutingTask = flag;
}

export function getExecutingTaskFlag(): boolean {
  return isExecutingTask;
}
```

#### 步骤 2：在任务执行时设置标志

```typescript
// 在任务执行前设置标志
async function executeTask(task: Task) {
  try {
    setExecutingTaskFlag(true);
    
    // 执行任务
    await runTask(task);
  } finally {
    // 清理标志
    setExecutingTaskFlag(false);
  }
}
```

#### 步骤 3：在工具中检测循环

```typescript
export function createTaskTool(): AnyAgentTool {
  return {
    name: "create_task",
    execute: async (_toolCallId, args) => {
      // 检测循环
      if (getExecutingTaskFlag()) {
        return jsonResult({
          success: false,
          error: `❌ 不能在执行任务时创建新任务。

✅ 正确做法：
1. 直接完成当前任务
2. 不要调用 create_task
3. 完成后系统会自动执行下一个任务

示例：
任务：分析项目
→ 正确：直接输出分析结果
→ 错误：调用 create_task 创建更多任务`,
        });
      }
      
      // 正常逻辑
      // ...
    },
  };
}
```

#### 步骤 4：优化错误信息

**关键**：错误信息要明确告诉 LLM 应该做什么

**错误示例**：
```
"不能在执行任务时创建新任务"
```

**正确示例**：
```
❌ 不能在执行任务时创建新任务。

✅ 正确做法：
1. 直接完成当前任务
2. 不要调用 create_task
3. 完成后系统会自动执行下一个任务

示例：
任务：分析项目
→ 正确：直接输出分析结果
→ 错误：调用 create_task 创建更多任务
```

#### 步骤 5：更新系统提示词

在系统提示词中添加简短说明：

```markdown
## 工具使用规则

**create_task 工具**：
- ✅ 用户直接要求时：可以调用
- ❌ 执行任务时：不要调用，直接完成任务
```

---

## 实战案例

### 案例：enqueue_task 工具

**问题**：LLM 在执行队列任务时又调用 `enqueue_task`，导致无限循环

**解决**：

1. **添加全局标志**：
```typescript
let isExecutingQueueTask = false;

export function setCurrentFollowupRunContext(
  run: FollowupRun["run"] | null,
  isQueueTask = false,
): void {
  currentFollowupRunContext = run;
  isExecutingQueueTask = isQueueTask;
}
```

2. **在任务执行时设置标志**：
```typescript
// agent-runner.ts（用户消息）
setCurrentFollowupRunContext(followupRun.run, false);

// followup-runner.ts（队列任务）
setCurrentFollowupRunContext(queued.run, true);
```

3. **在工具中检测循环**：
```typescript
if (isExecutingQueueTask) {
  return jsonResult({
    success: false,
    error: "不能在执行队列任务时加入新任务...",
  });
}
```

4. **优化错误信息**：
```typescript
error: `❌ 不能在执行队列任务时加入新任务。

✅ 正确做法：
1. 直接生成当前任务要求的内容
2. 不要调用任何工具（包括 enqueue_task）
3. 完成后系统会自动执行下一个任务`,
```

**效果**：
- ✅ 成功阻止了循环
- ✅ LLM 理解了错误信息（需要进一步验证）

---

## 关键教训

### 1. 技术手段 > 提示词约束

**问题**：只在系统提示词中说明，LLM 可能不理解或忘记

**解决**：在工具层添加检测逻辑，技术手段防止循环

### 2. 错误信息要明确

**问题**：只说"不能做 X"，LLM 不知道应该做什么

**解决**：错误信息中包含：
- ❌ 不能做什么
- ✅ 应该做什么
- 📝 具体示例

### 3. 全局标志的生命周期管理

**关键**：
- 在任务执行前设置标志
- 在 `finally` 块中清理标志
- 确保标志不会泄漏

### 4. 多层防护

**最佳实践**：
1. **系统提示词**：简短说明规则
2. **工具层检测**：技术手段防止循环
3. **错误信息**：明确告诉 LLM 应该做什么

---

## 适用场景

### 场景 1：任务队列系统

- LLM 可以生成任务
- 系统自动执行任务
- 需要防止 LLM 在执行任务时又生成新任务

### 场景 2：递归工具调用

- 工具内部可能调用其他工具
- 需要防止无限递归

### 场景 3：状态机系统

- LLM 可以改变状态
- 需要防止 LLM 在某些状态下执行某些操作

---

## 实施检查清单

实施循环检测时，必须检查：

- [ ] **添加全局标志**：区分执行上下文
- [ ] **设置标志**：在任务执行前设置
- [ ] **清理标志**：在 `finally` 块中清理
- [ ] **工具检测**：在工具中检测并拒绝循环
- [ ] **优化错误信息**：明确告诉 LLM 应该做什么
- [ ] **更新系统提示词**：添加简短说明
- [ ] **测试验证**：验证循环检测是否生效
- [ ] **验证 LLM 行为**：验证 LLM 是否理解错误信息

---

## 相关文档

- `.kiro/lessons-learned/81_LLM主动生成连续任务实现方法.md`
- `Runtimelog/tempfile/连续任务循环检测修复_20260204.md`

---

**版本**：v20260204_1  
**最后更新**：2026-02-04  
**关键词**：循环检测、全局标志、工具层防护、错误信息优化、LLM 行为引导、无限循环、递归调用、任务队列
