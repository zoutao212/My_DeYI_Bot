# 任务看板架构文档

## 概述

本文档描述了任务分解、展示和总结机制的技术架构和实现细节。该机制通过引入结构化的任务看板（Task Board）、任务分解器（Task Decomposer）和进度跟踪器（Progress Tracker），将复杂任务的执行过程从黑盒变为透明可控的白盒。

## 架构设计

### 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         User Interface                       │
│  (Telegram / Discord / CLI / Web)                           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent Orchestrator                        │
│  - 接收用户请求                                              │
│  - 判断是否需要任务分解                                      │
│  - 协调各组件执行                                            │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Task       │ │   Task       │ │   Progress   │
│ Decomposer   │ │  Executor    │ │   Tracker    │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       │                │                │
       └────────────────┼────────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │   Task Board     │
              │   (Persistence)  │
              └──────────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │  File System     │
              │  .clawdbot/tasks/│
              └──────────────────┘
```

### 核心组件

#### 1. Agent Orchestrator

**职责**：
- 接收用户请求并判断任务复杂度
- 决定是否启用任务分解模式
- 协调 Task Decomposer、Task Executor 和 Progress Tracker
- 处理用户交互（确认、重试、跳过等）

**实现**：`src/agents/task-board/orchestrator.ts`

**关键方法**：
```typescript
class AgentOrchestrator {
  async handleTask(task: string, context: DecompositionContext): Promise<TaskBoard>
  async resumeTask(sessionId: string): Promise<TaskBoard | null>
  private async executeSubTasks(subTasks: SubTask[], taskBoard: TaskBoard): Promise<void>
  private async executeSubTaskWithRetry(subTask: SubTask, context: ExecutionContext): Promise<ExecutionResult>
}
```

#### 2. Task Decomposer

**职责**：
- 分析任务并拆解成子任务
- 识别子任务之间的依赖关系
- 生成任务看板的初始结构
- 支持任务重新拆解

**实现**：`src/agents/task-board/decomposer.ts`

**关键方法**：
```typescript
interface TaskDecomposer {
  shouldDecompose(task: string): Promise<boolean>
  decompose(task: string, context: DecompositionContext): Promise<SubTask[]>
  redecompose(task: string, feedback: string, previousDecomposition: SubTask[]): Promise<SubTask[]>
}
```

**复杂度判断标准**：
1. 任务描述长度 > 200 字符
2. 包含多个动词（"创建"、"修改"、"测试"等）
3. 涉及多个文件或模块
4. 用户明确要求拆解

#### 3. Task Executor

**职责**：
- 执行单个子任务
- 捕获执行结果和错误
- 记录任务产出
- 支持并发执行

**实现**：`src/agents/task-board/executor.ts`

**关键方法**：
```typescript
interface TaskExecutor {
  execute(subTask: SubTask, context: ExecutionContext): Promise<ExecutionResult>
  executeConcurrent(subTasks: SubTask[], context: ExecutionContext): Promise<ExecutionResult[]>
  cancel(subTaskId: string): Promise<void>
}
```

**并发执行策略**：
- 使用 `Promise.all` 并发执行多个子任务
- 每个子任务在独立的执行上下文中运行
- 如果任一子任务失败，暂停其他子任务
- 等待用户决策后再继续

#### 4. Progress Tracker

**职责**：
- 跟踪任务和子任务的状态变化
- 更新任务看板
- 持久化任务状态到磁盘
- 生成检查点和总结

**实现**：`src/agents/task-board/progress-tracker.ts`

**关键方法**：
```typescript
interface ProgressTracker {
  initialize(mainTask: MainTask, subTasks: SubTask[]): Promise<TaskBoard>
  updateSubTaskStatus(subTaskId: string, status: SubTaskStatus, progress?: string): Promise<void>
  updateCurrentFocus(subTaskId: string, reasoning: string, nextAction: string): Promise<void>
  createCheckpoint(summary: string, decisions: string[], openQuestions: string[]): Promise<void>
  addRisk(description: string, mitigation: string): Promise<void>
  addContextAnchor(type: "code_location" | "command", value: string): Promise<void>
  persist(): Promise<void>
  load(sessionId: string): Promise<TaskBoard | null>
}
```

**状态管理**：
- 在内存中维护任务看板的当前状态
- 每次状态变化后立即持久化到磁盘
- 使用事务机制确保数据一致性

#### 5. Failure Handler

**职责**：
- 处理子任务失败
- 分析失败原因
- 提供恢复选项
- 建议经验固化

**实现**：`src/agents/task-board/failure-handler.ts`

**关键方法**：
```typescript
interface FailureHandler {
  handleFailure(subTask: SubTask, error: Error): Promise<FailureDecision>
  analyzeFailure(subTask: SubTask, error: Error): Promise<FailureSummary>
  suggestRuleCreation(failureSummary: FailureSummary): Promise<boolean>
}
```

**失败分析策略**：
- 解析错误堆栈和消息
- 识别错误类型（语法错误、运行时错误、工具调用失败等）
- 分析根本原因（配置错误、依赖缺失、逻辑错误等）
- 生成建议的修复方案

#### 6. Self-Improvement Engine

**职责**：
- 识别可复用的模式
- 生成改进建议
- 调用 maintain-rules Power 固化经验

**实现**：`src/agents/task-board/self-improvement.ts`

**关键方法**：
```typescript
class SelfImprovementEngine {
  identifyReusablePatterns(taskBoard: TaskBoard): ReusablePattern[]
  generateImprovementSuggestions(patterns: ReusablePattern[]): ImprovementSuggestion[]
  async solidifyExperience(suggestion: ImprovementSuggestion): Promise<boolean>
}
```

## 数据模型

### TaskBoard

```typescript
interface TaskBoard {
  sessionId: string;              // 会话 ID
  mainTask: MainTask;             // 主任务
  subTasks: SubTask[];            // 子任务列表
  currentFocus: CurrentFocus;     // 当前焦点
  checkpoints: Checkpoint[];      // 检查点列表
  risksAndBlocks: Risk[];         // 风险和阻塞列表
  contextAnchors: ContextAnchors; // 上下文锚点
  lastUpdated: string;            // 最后更新时间（ISO 8601）
  version: string;                // 版本号
}
```

### MainTask

```typescript
interface MainTask {
  title: string;       // 任务标题
  objective: string;   // 任务目标
  status: MainTaskStatus; // 任务状态
  progress: string;    // 进度描述
}

type MainTaskStatus = "active" | "paused" | "completed" | "blocked";
```

### SubTask

```typescript
interface SubTask {
  id: string;           // 子任务 ID（例如："T1", "T2"）
  title: string;        // 子任务标题
  description: string;  // 子任务描述
  status: SubTaskStatus; // 子任务状态
  progress: string;     // 进度描述
  dependencies: string[]; // 依赖的子任务 ID 列表
  outputs: string[];    // 产出列表（文件路径、函数名等）
  notes: string;        // 结论级要点
}

type SubTaskStatus = "pending" | "active" | "completed" | "blocked" | "skipped";
```

### CurrentFocus

```typescript
interface CurrentFocus {
  taskId: string;          // 当前焦点的子任务 ID
  reasoningSummary: string; // 结论级摘要（不是推理链）
  nextAction: string;      // 可执行的下一步行动
}
```

### Checkpoint

```typescript
interface Checkpoint {
  timestamp: string;       // 时间戳（ISO 8601）
  summary: string;         // 本阶段结论摘要
  decisions: string[];     // 已确认的关键决策
  openQuestions: string[]; // 未决问题
}
```

### Risk

```typescript
interface Risk {
  description: string; // 风险描述
  mitigation: string;  // 缓解措施
}
```

### ContextAnchors

```typescript
interface ContextAnchors {
  codeLocations: string[]; // 代码位置列表（例如："src/agents/pi-tools.ts::readFile"）
  commands: string[];      // 命令列表（例如："pnpm build"）
}
```

## 持久化机制

### 存储位置

任务看板保存在 `~/.clawdbot/tasks/{sessionId}/` 目录：
- `TASK_BOARD.json`：机器可读的 JSON 格式
- `TASK_BOARD.md`：人类可读的 Markdown 格式

### 原子写入

为了确保数据一致性，持久化使用原子写入：

```typescript
function atomicWriteFileSync(filePath: string, content: string): void {
  // 1. 创建临时文件
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  
  // 2. 写入临时文件
  writeFileSync(tmpPath, content, "utf-8");
  
  // 3. 原子性地重命名临时文件为目标文件
  renameSync(tmpPath, filePath);
}
```

### 数据验证

加载任务看板时会验证数据结构：

```typescript
async function loadTaskBoard(sessionId: string): Promise<TaskBoard | null> {
  // 读取文件
  const jsonContent = readFileSync(jsonPath, "utf-8");
  const board = JSON.parse(jsonContent) as TaskBoard;
  
  // 验证基本结构
  if (!board.sessionId || !board.mainTask || !Array.isArray(board.subTasks)) {
    throw new Error("Invalid TaskBoard structure");
  }
  
  // 验证 sessionId 一致性
  if (board.sessionId !== sessionId) {
    throw new Error(`TaskBoard sessionId mismatch`);
  }
  
  return board;
}
```

## 渲染机制

### JSON 渲染

JSON 渲染直接使用 `JSON.stringify`：

```typescript
function renderToJSON(board: TaskBoard): string {
  return JSON.stringify(board, null, 2);
}
```

### Markdown 渲染

Markdown 渲染将任务看板转换为人类可读的格式：

```typescript
function renderToMarkdown(board: TaskBoard): string {
  // 1. 渲染标题和元数据
  // 2. 渲染主任务
  // 3. 渲染子任务列表
  // 4. 渲染当前焦点
  // 5. 渲染检查点
  // 6. 渲染风险和阻塞
  // 7. 渲染上下文锚点
}
```

**状态 Emoji**：
- `✅` completed
- `🔄` active
- `⏳` pending
- `🚫` blocked
- `⏭️` skipped

## 扩展指南

### 添加新的任务分解策略

1. 创建新的 `TaskDecomposer` 实现：

```typescript
class CustomTaskDecomposer implements TaskDecomposer {
  async shouldDecompose(task: string): Promise<boolean> {
    // 自定义复杂度判断逻辑
  }

  async decompose(task: string, context: DecompositionContext): Promise<SubTask[]> {
    // 自定义拆解逻辑
  }

  async redecompose(task: string, feedback: string, previousDecomposition: SubTask[]): Promise<SubTask[]> {
    // 自定义重新拆解逻辑
  }
}
```

2. 在 `AgentOrchestrator` 中使用自定义分解器：

```typescript
const orchestrator = new AgentOrchestrator({
  sessionId: "session_123"
});

// 替换默认分解器
orchestrator.decomposer = new CustomTaskDecomposer();
```

### 添加新的失败处理策略

1. 创建新的 `FailureHandler` 实现：

```typescript
class CustomFailureHandler implements FailureHandler {
  async analyzeFailure(subTask: SubTask, error: Error): Promise<FailureSummary> {
    // 自定义失败分析逻辑
  }

  async handleFailure(subTask: SubTask, error: Error): Promise<FailureDecision> {
    // 自定义失败处理逻辑
  }

  async suggestRuleCreation(failureSummary: FailureSummary): Promise<boolean> {
    // 自定义经验固化建议逻辑
  }
}
```

2. 在 `AgentOrchestrator` 中使用自定义失败处理器：

```typescript
const orchestrator = new AgentOrchestrator({
  sessionId: "session_123"
});

// 替换默认失败处理器
orchestrator.failureHandler = new CustomFailureHandler();
```

### 添加新的用户界面

1. 创建 UI 适配器：

```typescript
class TelegramTaskBoardAdapter {
  async displayTaskBoard(taskBoard: TaskBoard): Promise<void> {
    // 将任务看板渲染为 Telegram 消息
  }

  async promptFailureDecision(subTask: SubTask, error: Error): Promise<FailureDecision> {
    // 在 Telegram 中展示失败原因和选项
  }
}
```

2. 在 Orchestrator 中集成 UI 适配器：

```typescript
const orchestrator = new AgentOrchestrator({
  sessionId: "session_123"
});

const uiAdapter = new TelegramTaskBoardAdapter();

// 在任务执行过程中调用 UI 适配器
await uiAdapter.displayTaskBoard(taskBoard);
```

## 测试策略

### 单元测试

每个组件都应该有对应的单元测试：

```typescript
// decomposer.test.ts
describe("TaskDecomposer", () => {
  it("should decompose complex tasks", async () => {
    const decomposer = createTaskDecomposer();
    const subTasks = await decomposer.decompose("复杂任务", context);
    expect(subTasks.length).toBeGreaterThanOrEqual(2);
    expect(subTasks.length).toBeLessThanOrEqual(8);
  });
});

// progress-tracker.test.ts
describe("ProgressTracker", () => {
  it("should update sub-task status", async () => {
    const tracker = createProgressTracker("session_123");
    await tracker.initialize(mainTask, subTasks);
    await tracker.updateSubTaskStatus("T1", "completed", "100%");
    const board = await tracker.getTaskBoard();
    expect(board.subTasks[0].status).toBe("completed");
  });
});
```

### 集成测试

测试组件之间的协作：

```typescript
describe("AgentOrchestrator", () => {
  it("should handle task end-to-end", async () => {
    const orchestrator = createOrchestrator({
      sessionId: "session_123"
    });

    const taskBoard = await orchestrator.handleTask("复杂任务", context);
    
    expect(taskBoard.mainTask.status).toBe("completed");
    expect(taskBoard.subTasks.every(t => t.status === "completed")).toBe(true);
  });
});
```

### 属性测试

使用属性测试验证系统的正确性：

```typescript
import { fc, test } from "@fast-check/vitest";

test.prop([fc.string()])("should persist and load task board correctly", async (sessionId) => {
  const tracker = createProgressTracker(sessionId);
  const board = await tracker.initialize(mainTask, subTasks);
  
  await tracker.persist();
  const loadedBoard = await tracker.load(sessionId);
  
  expect(loadedBoard).toEqual(board);
});
```

## 性能优化

### 1. 批量更新

避免频繁的持久化操作：

```typescript
class OptimizedProgressTracker extends DefaultProgressTracker {
  private pendingUpdates: Array<() => void> = [];
  private persistTimer: NodeJS.Timeout | null = null;

  async updateSubTaskStatus(subTaskId: string, status: SubTaskStatus, progress?: string): Promise<void> {
    // 添加到待更新队列
    this.pendingUpdates.push(() => {
      // 更新状态
    });

    // 延迟持久化
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => this.persist(), 1000);
  }
}
```

### 2. 增量渲染

只渲染变化的部分：

```typescript
class IncrementalRenderer {
  private lastRendered: TaskBoard | null = null;

  renderToMarkdown(board: TaskBoard): string {
    if (!this.lastRendered) {
      // 首次渲染，渲染完整内容
      this.lastRendered = board;
      return this.renderFull(board);
    }

    // 增量渲染，只渲染变化的部分
    const changes = this.detectChanges(this.lastRendered, board);
    this.lastRendered = board;
    return this.renderChanges(changes);
  }
}
```

### 3. 并发优化

使用 Worker 线程执行耗时操作：

```typescript
import { Worker } from "node:worker_threads";

class ParallelTaskExecutor extends DefaultTaskExecutor {
  async execute(subTask: SubTask, context: ExecutionContext): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker("./task-worker.js", {
        workerData: { subTask, context }
      });

      worker.on("message", resolve);
      worker.on("error", reject);
    });
  }
}
```

## 安全考虑

### 1. 输入验证

验证所有用户输入：

```typescript
function validateSubTask(subTask: SubTask): void {
  if (!subTask.id || typeof subTask.id !== "string") {
    throw new Error("Invalid sub-task ID");
  }

  if (!subTask.title || typeof subTask.title !== "string") {
    throw new Error("Invalid sub-task title");
  }

  // 验证其他字段...
}
```

### 2. 路径安全

防止路径遍历攻击：

```typescript
import { resolve, normalize } from "node:path";

function getTaskBoardDir(sessionId: string): string {
  // 验证 sessionId
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("Invalid session ID");
  }

  const baseDir = resolve(homedir(), ".clawdbot", "tasks");
  const taskDir = resolve(baseDir, sessionId);

  // 确保路径在 baseDir 内
  if (!taskDir.startsWith(baseDir)) {
    throw new Error("Path traversal detected");
  }

  return taskDir;
}
```

### 3. 错误处理

避免泄露敏感信息：

```typescript
function sanitizeError(error: Error): Error {
  // 移除敏感信息（路径、密码等）
  const sanitizedMessage = error.message
    .replace(/\/home\/[^/]+/g, "/home/user")
    .replace(/password=\S+/g, "password=***");

  return new Error(sanitizedMessage);
}
```

## 相关文档

- [用户文档](../task-decomposition.md)
- [API 参考](../api/task-board.md)
- [示例和教程](../../examples/task-decomposition/)

## 贡献指南

如果你想为任务分解机制贡献代码，请：

1. 阅读 [贡献指南](../../CONTRIBUTING.md)
2. 遵循 [代码风格指南](../../docs/dev/code-style.md)
3. 编写单元测试和集成测试
4. 更新相关文档
5. 提交 Pull Request
