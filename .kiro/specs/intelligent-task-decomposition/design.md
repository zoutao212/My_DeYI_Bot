# 设计文档：智能任务分解与队列执行系统

## 概述

本设计文档描述了 Clawdbot 的智能任务分解与队列执行系统的技术实现。该系统通过系统提示词引导 LLM 自动识别大型任务、智能分解任务、自动执行队列和动态调整任务。

### 核心设计理念

1. **LLM 驱动**：所有任务识别和分解都由 LLM 完成，系统只提供工具和基础设施
2. **系统提示词引导**：通过系统提示词引导 LLM 的行为，确保 LLM 正确使用 `enqueue_task` 工具
3. **自动执行**：队列自动排空，无需用户手动触发
4. **动态调整**：LLM 根据完成情况自动检查并调整任务
5. **安全防护**：循环检测、Hook 副作用防护、队列状态管理

### 与现有系统的集成

本系统将完全融合现有的连续任务机制：
- 复用 `enqueue_task` 工具（`.kiro/lessons-learned/81_LLM主动生成连续任务实现方法.md`）
- 复用循环检测机制（`.kiro/lessons-learned/82_LLM工具调用循环检测模式.md`）
- 复用 Hook 副作用检测（`.kiro/lessons-learned/83_Hook副作用检测模式.md`）
- 复用队列管理机制（`.kiro/lessons-learned/84_队列管理的自动加入陷阱.md`）

## 架构

### 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         User Interface                       │
│  (Telegram / Discord / CLI / Web)                           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    LLM (Gemini / Claude)                     │
│  - 接收用户请求和系统提示词                                  │
│  - 分析任务复杂度和规模                                      │
│  - 决定是否需要分解任务                                      │
│  - 调用 enqueue_task 工具创建子任务                          │
│  - 检查任务完成情况并动态调整                                │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┬────────────┐
        │            │            │            │
        ▼            ▼            ▼            ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   System     │ │  enqueue_    │ │   Loop       │ │   Hook       │
│   Prompt     │ │   task       │ │  Detector    │ │   Guard      │
│   (引导)     │ │   (工具)     │ │  (循环检测)  │ │  (Hook防护)  │
└──────────────┘ └──────┬───────┘ └──────────────┘ └──────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │   Task Queue     │
              │   (任务队列)     │
              └──────────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │  Queue Executor  │
              │  (队列执行器)    │
              └──────────────────┘
```

### 组件职责

1. **LLM**：
   - 接收用户请求和系统提示词
   - 分析任务的复杂度和规模
   - 决定是否需要分解任务
   - 调用 `enqueue_task` 工具创建子任务
   - 检查任务完成情况并动态调整

2. **System Prompt**：
   - 引导 LLM 分析任务复杂度
   - 引导 LLM 使用 `enqueue_task` 工具
   - 引导 LLM 提供清晰的 prompt 和 summary
   - 引导 LLM 检查任务完成情况
   - 引导 LLM 生成补充任务或跳过任务

3. **enqueue_task Tool**：
   - 接收 LLM 的任务创建请求
   - 将任务加入队列
   - 返回任务 ID

4. **Queue Executor**：
   - 自动排空队列并执行所有任务
   - 使用任务的 prompt 作为 LLM 输入
   - 记录任务状态和产出

5. **Loop Detector**：
   - 检测 LLM 在执行队列任务时调用 `enqueue_task`
   - 检测 LLM 重复调用相同的工具
   - 检测队列深度超过阈值
   - 返回明确的错误信息和正确做法

6. **Hook Guard**：
   - 检测消息类型（用户消息、队列任务、原始用户消息在队列中）
   - 跳过对队列任务的 Hook 修改
   - 记录跳过日志供调试

## 组件和接口

### System Prompt（系统提示词）

#### 设计原则

系统提示词是引导 LLM 行为的核心机制。设计时需要遵循以下原则：

1. **简单直接**：使用简单的语言，避免复杂的概念和条件判断
2. **负面规则**：使用"不要做"而不是"要做"
3. **可选步骤**：让 LLM 根据需要决定，不强制执行某些步骤
4. **具体示例**：提供具体的示例，而不是抽象的描述
5. **短句子**：使用短句子，避免复杂的从句

#### 系统提示词内容

```markdown
## 任务分解与队列执行

当你收到一个复杂的任务时，你可以将它分解成多个子任务，然后使用 `enqueue_task` 工具创建这些子任务。

### 什么时候需要分解任务？

你可以根据以下情况判断是否需要分解任务：

- 任务涉及大量内容生成（如生成 10000 字的文章）
- 任务涉及大量数据处理（如总结 100 万字的电子书）
- 任务涉及多个步骤（如先读取文件，再分析内容，最后生成报告）
- 任务需要并行处理多个文件或数据

### 如何分解任务？

1. **分析任务**：理解用户的需求，识别任务的关键步骤
2. **创建子任务**：为每个步骤创建一个子任务，使用 `enqueue_task` 工具
3. **提供清晰的 prompt**：每个子任务的 prompt 应该清晰、具体、可执行
4. **提供简短的 summary**：每个子任务的 summary 应该简短地描述任务的目标

### 示例

**用户请求**：请帮我生成一个 10000 字的科幻小说

**你的分解**：
1. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 1-2000 字，包括开头和人物介绍"，summary: "生成小说第 1-2000 字"
2. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 2001-4000 字，继续故事发展"，summary: "生成小说第 2001-4000 字"
3. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 4001-6000 字，推进情节"，summary: "生成小说第 4001-6000 字"
4. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 6001-8000 字，进入高潮"，summary: "生成小说第 6001-8000 字"
5. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 8001-10000 字，完成结局"，summary: "生成小说第 8001-10000 字"

### 重要规则

- ❌ **不要在执行队列任务时调用 `enqueue_task`**：如果你正在执行一个队列任务，不要再调用 `enqueue_task` 创建新的任务，这会导致无限循环
- ❌ **不要重复调用相同的工具**：如果你发现自己在重复调用相同的工具，停下来思考是否有更好的方法
- ✅ **检查任务完成情况**：每个子任务完成后，检查产出是否符合预期，如果不符合，可以创建补充任务
- ✅ **向用户展示计划**：在开始分解任务之前，向用户展示你的分解计划，询问用户是否同意

### 任务完成后的检查

当所有子任务完成后，你应该：

1. **检查产出**：验证所有子任务的产出是否符合预期
2. **生成总结**：生成一个最终总结，说明完成了哪些任务，产出了什么
3. **询问用户**：询问用户是否满意，如果不满意，根据用户反馈创建新的任务
```

### enqueue_task Tool（现有工具）

#### 接口

```typescript
interface EnqueueTaskTool {
  /**
   * 创建一个新的队列任务
   * @param prompt 任务的提示词（LLM 将收到这个 prompt）
   * @param summary 任务的简短描述（用于显示给用户）
   * @returns 任务 ID
   */
  enqueueTask(prompt: string, summary: string): Promise<string>;
}
```

#### 实现策略

1. **复用现有工具**：
   - 使用 `src/agents/tools/enqueue-task-tool.ts` 中的现有实现
   - 不需要修改现有代码

2. **循环检测**：
   - 复用 `.kiro/lessons-learned/82_LLM工具调用循环检测模式.md` 中的机制
   - 如果检测到 LLM 在执行队列任务时调用 `enqueue_task`，返回错误信息

3. **队列管理**：
   - 复用 `.kiro/lessons-learned/84_队列管理的自动加入陷阱.md` 中的机制
   - 检查队列深度，防止重复加入用户消息

### Queue Executor（队列执行器）

#### 接口

```typescript
interface QueueExecutor {
  /**
   * 执行队列中的所有任务
   * @returns 执行结果
   */
  executeQueue(): Promise<QueueExecutionResult>;

  /**
   * 获取队列状态
   * @returns 队列状态
   */
  getQueueStatus(): Promise<QueueStatus>;
}

interface QueueExecutionResult {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  duration: number; // 毫秒
}

interface QueueStatus {
  depth: number; // 队列深度
  currentTaskPrompt: string | null; // 当前正在执行的任务 prompt
  remainingTasks: number; // 剩余任务数量
}
```

#### 实现策略

1. **队列管理**：
   - 复用 `src/auto-reply/reply/followup-runner.ts` 中的现有实现
   - 使用 `followup` 模式（每个任务单独执行）
   - 不去重（`dedupeMode: "none"`）

2. **自动执行**：
   - 队列自动排空
   - 按照 LLM 创建的顺序执行
   - 每个任务使用其 prompt 作为 LLM 输入

3. **状态管理**：
   - 记录任务状态和产出
   - 通知 LLM 所有任务已完成

### Loop Detector（循环检测器）

#### 接口

```typescript
interface LoopDetector {
  /**
   * 检测是否在执行队列任务
   * @returns 是否在执行队列任务
   */
  isExecutingQueueTask(): boolean;

  /**
   * 检测工具调用循环
   * @param toolName 工具名称
   * @param args 工具参数
   * @returns 是否检测到循环
   */
  detectToolCallLoop(toolName: string, args: unknown): boolean;

  /**
   * 检测队列深度超限
   * @param queueDepth 队列深度
   * @returns 是否超限
   */
  detectQueueDepthExceeded(queueDepth: number): boolean;

  /**
   * 生成循环错误信息
   * @param loopType 循环类型
   * @returns 错误信息
   */
  generateLoopError(loopType: "queue_task" | "tool_call" | "queue_depth"): string;
}
```

#### 实现策略

1. **队列任务检测**：
   - 复用现有的全局标志 `isExecutingQueueTask`
   - 在 `enqueue_task` 工具中检测
   - 如果检测到，返回明确的错误信息：
     ```
     ❌ 错误：你正在执行一个队列任务，不能再调用 enqueue_task 创建新的任务。
     
     这会导致无限循环。
     
     正确做法：
     - 如果你需要创建更多任务，应该在最初的任务分解时就创建所有任务
     - 如果你发现需要补充任务，应该等所有队列任务完成后再创建
     ```

2. **工具调用循环检测**：
   - 记录最近的工具调用历史（最多 10 次）
   - 检测是否有相同的工具调用重复出现
   - 如果检测到，警告用户

3. **队列深度检测**：
   - 检查队列深度是否超过阈值（默认 50）
   - 如果超过，暂停队列执行并请求用户确认

### Hook Guard（Hook 守卫）

#### 接口

```typescript
interface HookGuard {
  /**
   * 检测消息类型
   * @param message 消息内容
   * @returns 消息类型
   */
  detectMessageType(message: string): MessageType;

  /**
   * 判断是否应该跳过 Hook
   * @param messageType 消息类型
   * @returns 是否跳过
   */
  shouldSkipHook(messageType: MessageType): boolean;
}

type MessageType = "user_message" | "queue_task" | "original_user_message_in_queue";
```

#### 实现策略

1. **消息类型检测**：
   - 队列任务：prompt 以特定格式开头（如"请生成第 X 段"）
   - 原始用户消息在队列中：包含 `[message_id: ...]`
   - 用户消息：其他情况

2. **Hook 跳过**：
   - 如果是队列任务，跳过 Hook 修改
   - 如果是原始用户消息在队列中，跳过 Hook 修改
   - 如果是用户消息，允许 Hook 修改

3. **日志记录**：
   - 记录消息类型、时间戳和跳过原因
   - 便于调试

### TaskTreeManager（任务树管理器）

#### 接口

```typescript
interface TaskTreeManager {
  /**
   * 初始化任务树
   * @param rootTask 根任务描述
   * @param sessionId 会话 ID
   * @returns 任务树
   */
  initialize(rootTask: string, sessionId: string): Promise<TaskTree>;

  /**
   * 保存任务树到磁盘
   * @param taskTree 任务树
   */
  save(taskTree: TaskTree): Promise<void>;

  /**
   * 从磁盘加载任务树
   * @param sessionId 会话 ID
   * @returns 任务树（如果不存在返回 null）
   */
  load(sessionId: string): Promise<TaskTree | null>;

  /**
   * 更新子任务状态
   * @param taskTree 任务树
   * @param subTaskId 子任务 ID
   * @param status 新状态
   */
  updateSubTaskStatus(taskTree: TaskTree, subTaskId: string, status: SubTask["status"]): Promise<void>;

  /**
   * 创建检查点
   * @param taskTree 任务树
   * @returns 检查点 ID
   */
  createCheckpoint(taskTree: TaskTree): Promise<string>;

  /**
   * 从检查点恢复
   * @param taskTree 任务树
   * @param checkpointId 检查点 ID
   * @returns 恢复后的任务树
   */
  restoreFromCheckpoint(taskTree: TaskTree, checkpointId: string): Promise<TaskTree>;

  /**
   * 渲染任务树为 Markdown
   * @param taskTree 任务树
   * @returns Markdown 字符串
   */
  renderToMarkdown(taskTree: TaskTree): string;
}
```

#### 实现策略

1. **文件系统结构**：
   ```
   .clawdbot/tasks/{sessionId}/
     ├── TASK_TREE.json          # 任务树主文件
     ├── TASK_TREE.json.bak      # 任务树备份文件
     ├── TASK_TREE.md            # 任务树 Markdown 格式
     ├── checkpoints/            # 检查点目录
     │   ├── {checkpointId}.json
     │   └── ...
     ├── failures.log            # 失败日志
     └── errors.log              # 错误日志
   ```

2. **原子写入**：
   - 先写入临时文件（`.tmp`）
   - 写入成功后，重命名为目标文件
   - 确保数据一致性

3. **备份机制**：
   - 每次保存前，先备份当前文件到 `.bak`
   - 如果主文件损坏，从备份文件恢复

4. **检查点管理**：
   - 每次任务状态变化时创建检查点
   - 最多保留 10 个检查点
   - 删除最旧的检查点

### RetryManager（重试管理器）

#### 接口

```typescript
interface RetryManager {
  /**
   * 判断错误是否可重试
   * @param error 错误对象
   * @returns 是否可重试
   */
  isRetryable(error: Error): boolean;

  /**
   * 执行任务并自动重试
   * @param subTask 子任务
   * @param executor 执行函数
   * @param maxRetries 最大重试次数
   * @returns 执行结果
   */
  executeWithRetry<T>(subTask: SubTask, executor: () => Promise<T>, maxRetries: number): Promise<T>;

  /**
   * 记录失败日志
   * @param subTask 子任务
   * @param error 错误对象
   * @param sessionId 会话 ID
   */
  logFailure(subTask: SubTask, error: Error, sessionId: string): Promise<void>;

  /**
   * 获取失败日志
   * @param sessionId 会话 ID
   * @returns 失败日志列表
   */
  getFailureLogs(sessionId: string): Promise<FailureLog[]>;
}
```

#### 实现策略

1. **可重试错误识别**：
   - 网络超时：`ETIMEDOUT`、`ECONNRESET`
   - 网络连接失败：`ECONNREFUSED`、`ENOTFOUND`
   - LLM 请求限流：`429 Too Many Requests`
   - 不可重试错误：代码错误、文件不存在、权限错误

2. **重试策略**：
   - 使用指数退避：1s, 2s, 4s
   - 最多重试 3 次
   - 记录每次重试的日志

3. **失败日志记录**：
   - 保存到 `.clawdbot/tasks/{sessionId}/failures.log`
   - 包含时间戳、子任务 ID、错误信息、堆栈跟踪、重试次数

### ErrorHandler（错误处理器）

#### 接口

```typescript
interface ErrorHandler {
  /**
   * 处理错误
   * @param error 错误对象
   * @param context 上下文信息
   * @param sessionId 会话 ID
   */
  handleError(error: Error, context: Record<string, unknown>, sessionId: string): Promise<void>;

  /**
   * 记录错误日志
   * @param errorType 错误类型
   * @param error 错误对象
   * @param context 上下文信息
   * @param sessionId 会话 ID
   */
  logError(errorType: ErrorLog["errorType"], error: Error, context: Record<string, unknown>, sessionId: string): Promise<void>;

  /**
   * 获取错误日志
   * @param sessionId 会话 ID
   * @returns 错误日志列表
   */
  getErrorLogs(sessionId: string): Promise<ErrorLog[]>;

  /**
   * 尝试恢复
   * @param error 错误对象
   * @param context 上下文信息
   * @returns 是否恢复成功
   */
  tryRecover(error: Error, context: Record<string, unknown>): Promise<boolean>;
}
```

#### 实现策略

1. **错误分类**：
   - LLM 请求失败：重试
   - 文件系统操作失败：备份到临时位置
   - 内存不足：释放资源
   - 系统崩溃：从检查点恢复

2. **错误日志记录**：
   - 保存到 `.clawdbot/tasks/{sessionId}/errors.log`
   - 包含时间戳、错误类型、错误信息、堆栈跟踪、上下文信息

3. **错误恢复策略**：
   - LLM 请求失败：使用 RetryManager 重试
   - 文件系统操作失败：备份到 `~/.clawdbot/temp/`
   - 内存不足：清理缓存、释放资源
   - 系统崩溃：从最近的检查点恢复

### RecoveryManager（恢复管理器）

#### 接口

```typescript
interface RecoveryManager {
  /**
   * 检查是否有未完成的任务
   * @param sessionId 会话 ID
   * @returns 是否有未完成的任务
   */
  hasUnfinishedTasks(sessionId: string): Promise<boolean>;

  /**
   * 恢复未完成的任务
   * @param sessionId 会话 ID
   * @returns 恢复后的任务树
   */
  recoverUnfinishedTasks(sessionId: string): Promise<TaskTree>;

  /**
   * 识别中断的任务
   * @param taskTree 任务树
   * @returns 中断的任务列表
   */
  identifyInterruptedTasks(taskTree: TaskTree): SubTask[];

  /**
   * 重新执行中断的任务
   * @param taskTree 任务树
   * @param interruptedTasks 中断的任务列表
   */
  reexecuteInterruptedTasks(taskTree: TaskTree, interruptedTasks: SubTask[]): Promise<void>;
}
```

#### 实现策略

1. **未完成任务检测**：
   - 检查 `.clawdbot/tasks/{sessionId}/TASK_TREE.json` 是否存在
   - 检查任务树中是否有状态为 "pending"、"active" 或 "interrupted" 的任务

2. **恢复流程**：
   - 从磁盘加载任务树
   - 识别未完成的任务
   - 将 "active" 状态的任务标记为 "interrupted"
   - 从最近的检查点恢复
   - 继续执行未完成的任务

3. **中断任务处理**：
   - 将 "interrupted" 状态的任务重新标记为 "pending"
   - 重新执行这些任务
   - 记录恢复日志


## 数据模型

### 核心数据结构

```typescript
// 队列执行结果
interface QueueExecutionResult {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  duration: number; // 毫秒
}

// 队列状态
interface QueueStatus {
  depth: number; // 队列深度
  currentTaskPrompt: string | null; // 当前正在执行的任务 prompt
  remainingTasks: number; // 剩余任务数量
}

// 消息类型
type MessageType = "user_message" | "queue_task" | "original_user_message_in_queue";

// 任务树
interface TaskTree {
  id: string; // 任务树 ID（通常是 sessionId）
  rootTask: string; // 根任务描述
  subTasks: SubTask[]; // 所有子任务
  status: "pending" | "active" | "completed" | "failed"; // 任务树状态
  createdAt: number; // 创建时间戳
  updatedAt: number; // 更新时间戳
  checkpoints: string[]; // 检查点 ID 列表
}

// 子任务
interface SubTask {
  id: string; // 子任务 ID
  prompt: string; // 任务提示词
  summary: string; // 任务简短描述
  status: "pending" | "active" | "completed" | "failed" | "interrupted"; // 任务状态
  output?: string; // 任务输出
  error?: string; // 错误信息
  retryCount: number; // 重试次数
  createdAt: number; // 创建时间戳
  completedAt?: number; // 完成时间戳
}

// 检查点
interface Checkpoint {
  id: string; // 检查点 ID
  taskTree: TaskTree; // 任务树快照
  createdAt: number; // 创建时间戳
}

// 失败日志
interface FailureLog {
  subTaskId: string; // 子任务 ID
  error: string; // 错误信息
  stackTrace: string; // 堆栈跟踪
  retryCount: number; // 重试次数
  timestamp: number; // 时间戳
}

// 错误日志
interface ErrorLog {
  errorType: "llm_request_failed" | "file_system_failed" | "out_of_memory" | "system_crash";
  error: string; // 错误信息
  stackTrace: string; // 堆栈跟踪
  context: Record<string, unknown>; // 上下文信息
  timestamp: number; // 时间戳
}
```

## 错误处理

### 错误类型

1. **LLM 理解错误**：
   - LLM 无法理解任务描述
   - LLM 无法决定是否需要分解任务

2. **工具调用错误**：
   - LLM 在执行队列任务时调用 `enqueue_task`（循环检测触发）
   - LLM 重复调用相同的工具
   - 队列深度超限

3. **队列执行错误**：
   - 队列任务执行失败
   - LLM 请求失败
   - 网络超时

### 错误处理策略

1. **LLM 理解错误**：
   - 通过系统提示词提供更多上下文和示例
   - 向用户展示错误原因并请求更多信息
   - 允许用户手动指导任务分解

2. **工具调用错误**：
   - 返回明确的错误信息和正确做法
   - 记录错误日志供调试
   - 暂停队列执行并请求用户确认

3. **队列执行错误**：
   - 记录错误日志
   - 向用户展示失败原因
   - 提供重试选项

## 测试策略

### 单元测试

1. **System Prompt 测试**：
   - 测试系统提示词是否清晰、简单、直接
   - 测试系统提示词是否包含必要的示例
   - 测试系统提示词是否避免复杂的概念和条件判断

2. **Loop Detector 测试**：
   - 测试队列任务检测
   - 测试工具调用循环检测
   - 测试队列深度检测

3. **Hook Guard 测试**：
   - 测试消息类型检测
   - 测试 Hook 跳过逻辑

### 集成测试

1. **端到端测试**：
   - 测试完整的任务分解和执行流程
   - 测试用户场景（生成大量内容、总结大量内容、分析复杂项目）
   - 测试循环检测和 Hook 防护

2. **与现有系统集成测试**：
   - 测试与 `enqueue_task` 工具的集成
   - 测试与循环检测机制的集成
   - 测试与 Hook 副作用检测的集成
   - 测试与队列管理机制的集成

### LLM 行为测试

1. **任务识别测试**：
   - 测试 LLM 是否能正确识别需要分解的任务
   - 测试 LLM 是否能正确识别不需要分解的任务
   - 测试 LLM 是否能向用户询问不确定的情况

2. **任务分解测试**：
   - 测试 LLM 是否能生成合理的子任务
   - 测试 LLM 是否能提供清晰的 prompt 和 summary
   - 测试 LLM 是否能正确使用 `enqueue_task` 工具

3. **任务检查测试**：
   - 测试 LLM 是否能检查任务完成情况
   - 测试 LLM 是否能生成补充任务
   - 测试 LLM 是否能生成最终总结

## 正确性属性

*属性（Property）是一个特征或行为，应该在系统的所有有效执行中保持为真——本质上是关于系统应该做什么的形式化陈述。属性是人类可读规范和机器可验证正确性保证之间的桥梁。*

### 属性 1：系统提示词完整性

*对于任何*系统提示词，应该包含任务分解的引导、`enqueue_task` 工具的使用说明、示例和重要规则

**验证需求**: 8.1, 8.2, 8.3

### 属性 2：循环检测正确性

*对于任何*在执行队列任务时调用 `enqueue_task` 的情况，Loop Detector 应该检测到循环并返回错误信息

**验证需求**: 5.1

### 属性 3：工具调用循环检测正确性

*对于任何*工具调用历史，如果相同的工具调用（工具名称和参数相同）在最近 10 次调用中出现 3 次以上，detectToolCallLoop 应该返回 true

**验证需求**: 5.2

### 属性 4：队列深度检测正确性

*对于任何*队列深度，如果超过阈值（默认 50），detectQueueDepthExceeded 应该返回 true

**验证需求**: 5.3

### 属性 5：循环错误信息完整性

*对于任何*循环类型（queue_task、tool_call、queue_depth），generateLoopError 应该返回包含错误原因和正确做法的错误信息

**验证需求**: 5.4

### 属性 6：循环检测日志记录

*对于任何*检测到的循环，系统应该记录包含循环类型、时间戳和上下文信息的日志

**验证需求**: 5.5

### 属性 7：消息类型检测正确性

*对于任何*消息内容，detectMessageType 应该根据消息特征返回正确的消息类型（user_message、queue_task 或 original_user_message_in_queue）

**验证需求**: 6.1

### 属性 8：Hook 跳过逻辑正确性

*对于任何*消息类型，shouldSkipHook 应该对 queue_task 和 original_user_message_in_queue 返回 true，对 user_message 返回 false

**验证需求**: 6.2, 6.3, 6.4

### 属性 9：Hook 跳过日志记录

*对于任何*被跳过的 Hook，系统应该记录包含消息类型、时间戳和跳过原因的日志

**验证需求**: 6.5

### 属性 10：队列任务执行后深度减少

*对于任何*队列任务，执行完成后，队列深度应该减少 1

**验证需求**: 7.4

### 属性 11：队列自动执行

*对于任何*队列中有待执行的任务的情况，系统应该自动排空队列并执行所有任务

**验证需求**: 3.2

### 属性 12：队列任务顺序执行

*对于任何*队列任务列表，任务执行的顺序应该与 LLM 创建的顺序一致

**验证需求**: 3.3

### 属性 13：enqueue_task 工具返回任务 ID

*对于任何*调用 `enqueue_task` 的情况，工具应该返回一个唯一的任务 ID

**验证需求**: 10.1

### 属性 14：队列任务使用 prompt 作为输入

*对于任何*队列任务，执行时应该使用任务的 prompt 作为 LLM 输入

**验证需求**: 10.3

### 属性 15：队列任务完成后记录状态

*对于任何*队列任务，完成后应该记录任务状态和产出

**验证需求**: 10.4

