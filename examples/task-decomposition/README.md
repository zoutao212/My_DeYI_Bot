# 任务分解示例和教程

本目录包含任务分解、展示和总结机制的示例和教程。

## 目录结构

```
examples/task-decomposition/
├── README.md                    # 本文件
├── simple-task.ts               # 简单任务示例
├── complex-task.ts              # 复杂任务示例
├── task-recovery.ts             # 任务恢复示例
├── failure-handling.ts          # 失败处理示例
├── concurrent-execution.ts      # 并发执行示例
└── self-improvement.ts          # 自我改进示例
```

## 快速开始

### 1. 简单任务示例

演示如何处理不需要拆解的简单任务。

```bash
bun examples/task-decomposition/simple-task.ts
```

### 2. 复杂任务示例

演示如何自动拆解复杂任务并跟踪进度。

```bash
bun examples/task-decomposition/complex-task.ts
```

### 3. 任务恢复示例

演示如何在会话中断后恢复任务。

```bash
bun examples/task-decomposition/task-recovery.ts
```

### 4. 失败处理示例

演示如何处理子任务失败并提供恢复选项。

```bash
bun examples/task-decomposition/failure-handling.ts
```

### 5. 并发执行示例

演示如何并发执行没有依赖关系的子任务。

```bash
bun examples/task-decomposition/concurrent-execution.ts
```

### 6. 自我改进示例

演示如何识别可复用的模式并固化为规则或技能。

```bash
bun examples/task-decomposition/self-improvement.ts
```

## 详细教程

### 教程 1：创建和执行任务

```typescript
import { createOrchestrator } from "../../src/agents/task-board/index.js";

// 1. 创建 Orchestrator
const orchestrator = createOrchestrator({
  sessionId: "tutorial_1",
  enableConcurrentExecution: false,
  enableAutoRetry: false,
  maxRetries: 3
});

// 2. 定义任务
const task = "创建一个简单的 Web 服务器，支持 GET 和 POST 请求";

// 3. 定义上下文
const context = {
  codebase: process.cwd(),
  recentMessages: []
};

// 4. 处理任务
const taskBoard = await orchestrator.handleTask(task, context);

// 5. 查看任务看板
console.log("任务看板已保存到:", `~/.clawdbot/tasks/${taskBoard.sessionId}/TASK_BOARD.md`);
```

### 教程 2：手动控制任务执行

```typescript
import {
  createTaskDecomposer,
  createProgressTracker,
  createTaskExecutor
} from "../../src/agents/task-board/index.js";

// 1. 创建组件
const decomposer = createTaskDecomposer();
const tracker = createProgressTracker("tutorial_2");
const executor = createTaskExecutor();

// 2. 拆解任务
const task = "实现用户认证功能";
const subTasks = await decomposer.decompose(task, context);

// 3. 初始化任务看板
const mainTask = {
  title: task,
  objective: task,
  status: "active" as const,
  progress: "0%"
};

const taskBoard = await tracker.initialize(mainTask, subTasks);

// 4. 手动执行每个子任务
for (const subTask of subTasks) {
  // 更新当前焦点
  await tracker.updateCurrentFocus(
    subTask.id,
    `正在执行: ${subTask.title}`,
    `执行 ${subTask.description}`
  );

  // 更新状态为 active
  await tracker.updateSubTaskStatus(subTask.id, "active", "0%");

  // 执行子任务
  const result = await executor.execute(subTask, {
    sessionId: "tutorial_2",
    taskBoard
  });

  // 更新状态
  if (result.status === "completed") {
    await tracker.updateSubTaskStatus(subTask.id, "completed", "100%");
    
    // 创建检查点
    await tracker.createCheckpoint(
      `完成: ${subTask.title}`,
      [`产出: ${result.outputs.join(", ")}`],
      []
    );
  }
}
```

### 教程 3：处理失败和重试

```typescript
import {
  createOrchestrator,
  createFailureHandler
} from "../../src/agents/task-board/index.js";

// 1. 创建 Orchestrator（启用自动重试）
const orchestrator = createOrchestrator({
  sessionId: "tutorial_3",
  enableAutoRetry: true,
  maxRetries: 3
});

// 2. 处理任务
try {
  const taskBoard = await orchestrator.handleTask(task, context);
  console.log("任务完成!");
} catch (error) {
  console.error("任务失败:", error);
  
  // 3. 分析失败原因
  const failureHandler = createFailureHandler();
  const failureSummary = await failureHandler.analyzeFailure(subTask, error);
  
  console.log("失败分析:");
  console.log("  错误类型:", failureSummary.errorType);
  console.log("  根本原因:", failureSummary.rootCause);
  console.log("  建议修复:", failureSummary.suggestedFix);
  
  // 4. 建议固化经验
  const shouldCreateRule = await failureHandler.suggestRuleCreation(failureSummary);
  if (shouldCreateRule) {
    console.log("建议将此失败经验固化为规则");
  }
}
```

### 教程 4：恢复中断的任务

```typescript
import { createOrchestrator } from "../../src/agents/task-board/index.js";

// 1. 创建 Orchestrator
const orchestrator = createOrchestrator({
  sessionId: "tutorial_4"
});

// 2. 恢复任务
const taskBoard = await orchestrator.resumeTask("tutorial_4");

if (!taskBoard) {
  console.log("没有找到可恢复的任务");
} else {
  console.log("任务已恢复!");
  console.log("主任务:", taskBoard.mainTask.title);
  console.log("当前焦点:", taskBoard.currentFocus.taskId);
  console.log("下一步行动:", taskBoard.currentFocus.nextAction);
  
  // 3. 继续执行
  if (taskBoard.currentFocus.nextAction) {
    console.log("继续执行任务...");
    // 执行下一步行动
  } else {
    console.log("下一步行动不明确，需要用户澄清");
  }
}
```

### 教程 5：自我改进

```typescript
import {
  createOrchestrator,
  createSelfImprovementEngine
} from "../../src/agents/task-board/index.js";

// 1. 创建 Orchestrator 并执行任务
const orchestrator = createOrchestrator({
  sessionId: "tutorial_5"
});

const taskBoard = await orchestrator.handleTask(task, context);

// 2. 创建自我改进引擎
const selfImprovement = createSelfImprovementEngine();

// 3. 识别可复用模式
const patterns = selfImprovement.identifyReusablePatterns(taskBoard);

console.log(`识别到 ${patterns.length} 个可复用模式:`);
for (const pattern of patterns) {
  console.log(`  - ${pattern.name} (出现 ${pattern.occurrences} 次)`);
}

// 4. 生成改进建议
const suggestions = selfImprovement.generateImprovementSuggestions(patterns);

console.log(`\n生成了 ${suggestions.length} 个改进建议:`);
for (const suggestion of suggestions) {
  console.log(`  - ${suggestion.title}`);
  console.log(`    类型: ${suggestion.type}`);
  console.log(`    描述: ${suggestion.description}`);
}

// 5. 固化经验
for (const suggestion of suggestions) {
  const success = await selfImprovement.solidifyExperience(suggestion);
  if (success) {
    console.log(`✓ 已固化: ${suggestion.title}`);
  }
}
```

## 常见问题

### Q: 如何自定义任务拆解策略？

A: 创建自定义的 `TaskDecomposer` 实现：

```typescript
import { TaskDecomposer, SubTask, DecompositionContext } from "../../src/agents/task-board/index.js";

class CustomTaskDecomposer implements TaskDecomposer {
  async shouldDecompose(task: string): Promise<boolean> {
    // 自定义复杂度判断逻辑
    return task.length > 100;
  }

  async decompose(task: string, context: DecompositionContext): Promise<SubTask[]> {
    // 自定义拆解逻辑
    return [
      {
        id: "T1",
        title: "步骤 1",
        description: "...",
        status: "pending",
        progress: "0%",
        dependencies: [],
        outputs: [],
        notes: ""
      }
    ];
  }

  async redecompose(task: string, feedback: string, previousDecomposition: SubTask[]): Promise<SubTask[]> {
    // 自定义重新拆解逻辑
    return previousDecomposition;
  }
}

// 使用自定义分解器
const orchestrator = createOrchestrator({ sessionId: "custom" });
orchestrator.decomposer = new CustomTaskDecomposer();
```

### Q: 如何自定义失败处理策略？

A: 创建自定义的 `FailureHandler` 实现：

```typescript
import { FailureHandler, SubTask, FailureDecision, FailureSummary } from "../../src/agents/task-board/index.js";

class CustomFailureHandler implements FailureHandler {
  async analyzeFailure(subTask: SubTask, error: Error): Promise<FailureSummary> {
    // 自定义失败分析逻辑
    return {
      subTaskId: subTask.id,
      errorType: "custom_error",
      rootCause: "自定义根本原因",
      context: "...",
      suggestedFix: "自定义修复建议"
    };
  }

  async handleFailure(subTask: SubTask, error: Error): Promise<FailureDecision> {
    // 自定义失败处理逻辑
    return { action: "retry" };
  }

  async suggestRuleCreation(failureSummary: FailureSummary): Promise<boolean> {
    // 自定义经验固化建议逻辑
    return true;
  }
}

// 使用自定义失败处理器
const orchestrator = createOrchestrator({ sessionId: "custom" });
orchestrator.failureHandler = new CustomFailureHandler();
```

### Q: 如何查看任务看板？

A: 任务看板会自动保存到 `~/.clawdbot/tasks/{sessionId}/` 目录：

```bash
# 查看 Markdown 格式
cat ~/.clawdbot/tasks/session_123/TASK_BOARD.md

# 查看 JSON 格式
cat ~/.clawdbot/tasks/session_123/TASK_BOARD.json

# 在 IDE 中打开
code ~/.clawdbot/tasks/session_123/TASK_BOARD.md
```

### Q: 如何启用并发执行？

A: 在创建 Orchestrator 时启用并发执行：

```typescript
const orchestrator = createOrchestrator({
  sessionId: "concurrent",
  enableConcurrentExecution: true
});
```

注意：并发执行只对没有依赖关系的子任务有效。

## 更多资源

- [用户文档](../../docs/task-decomposition.md)
- [开发者文档](../../docs/dev/task-board-architecture.md)
- [API 参考](../../docs/api/task-board.md)

## 反馈和支持

如果你在使用示例时遇到问题或有改进建议，请：

1. 查看 [常见问题](#常见问题) 部分
2. 查看 [GitHub Issues](https://github.com/clawdbot/clawdbot/issues)
3. 在 Discord 社区寻求帮助
