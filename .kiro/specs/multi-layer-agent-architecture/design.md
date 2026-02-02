# 设计文档：多层 Agent 系统架构

## 概述

本设计文档定义了一个**多层 Agent 系统架构**，通过四层分层设计，将角色扮演、任务理解、任务调度、工具执行等职责清晰分离。

### 核心设计理念

1. **职责分离**：每一层专注于自己的职责，不越界
2. **向下委托**：上层通过标准接口委托任务给下层
3. **向上反馈**：下层通过标准接口反馈结果给上层
4. **深度融合**：深度融合现有的任务分解系统
5. **渐进式迁移**：支持逐步迁移，不推倒重来

### 四层架构

```
┌─────────────────────────────────────────────────────────┐
│  虚拟世界层 (Virtual World Layer)                        │
│  - 角色：丽丝、艾莉等侍女                                │
│  - 职责：纯角色扮演，情感交互                            │
│  - 限制：不知道技术细节，不调用工具                      │
└─────────────────────────────────────────────────────────┘
                          ↓ 转发请求
┌─────────────────────────────────────────────────────────┐
│  管家层 (Butler Layer)                                   │
│  - 角色：栗娜（Agent）- 行政总监/管家                    │
│  - 职责：理解意图，分解任务，委托执行                    │
│  - 能力：调用独立技能（记忆检索、知识查询）              │
└─────────────────────────────────────────────────────────┘
                          ↓ 任务委托
┌─────────────────────────────────────────────────────────┐
│  任务调度层 (Task Orchestration Layer)                   │
│  - 组件：TaskBoard, Orchestrator, Executor               │
│  - 职责：分解任务，调度执行，跟踪进度                    │
│  - 策略：智能判断串行/并行，自动重试                     │
└─────────────────────────────────────────────────────────┘
                          ↓ 工具调用
┌─────────────────────────────────────────────────────────┐
│  执行层 (Execution Layer)                                │
│  - 组件：Tool Executor, Skill Executor                   │
│  - 职责：执行工具调用，返回结果                          │
│  - 工具：read, write, edit, exec, grep, 技能等          │
└─────────────────────────────────────────────────────────┘
```



## 与现有系统集成

### 集成点 1：Pi Agent Core

**现有组件**：`src/agents/pi-embedded-runner/run/attempt.ts`

**集成方式**：
- 在 `runEmbeddedAttempt()` 中注入多层架构的调度逻辑
- 保持现有的 Session Manager、Settings Manager 不变
- 通过 `systemPrompt` 参数控制不同层次的提示词

**关键修改点**：
```typescript
// 在 runEmbeddedAttempt() 中添加层次判断
const agentLayer = resolveAgentLayer(params.sessionKey, params.config);

if (agentLayer === "virtual-world") {
  // 虚拟世界层：只包含角色扮演提示词
  systemPrompt = buildVirtualWorldSystemPrompt(...);
} else if (agentLayer === "butler") {
  // 管家层：包含任务委托提示词
  systemPrompt = buildButlerSystemPrompt(...);
} else {
  // 执行层：包含工具使用提示词
  systemPrompt = buildExecutionSystemPrompt(...);
}
```

### 集成点 2：System Prompt 构建

**现有组件**：`src/agents/pi-embedded-runner/system-prompt.ts`

**集成方式**：
- 扩展 `buildEmbeddedSystemPrompt()` 函数，支持层次参数
- 根据层次参数选择性包含提示词内容
- 保持向后兼容，默认行为不变

**关键修改点**：
```typescript
export function buildEmbeddedSystemPrompt(params: {
  // ... 现有参数
  agentLayer?: "virtual-world" | "butler" | "execution"; // 新增
}): string {
  if (params.agentLayer === "virtual-world") {
    // 只包含角色扮演提示词，不包含工具使用提示词
    return buildAgentSystemPrompt({
      ...params,
      toolNames: [], // 不包含工具
      toolSummaries: new Map(),
    });
  }
  
  // 其他层次的处理...
}
```



### 集成点 3：任务分解系统

**现有组件**：`src/agents/task-board/`

**集成方式**：
- 任务调度层直接复用 `AgentOrchestrator`、`TaskExecutor`、`ProgressTracker`
- 管家层通过 `AgentTaskDecompositionHandler` 调用任务调度层
- 保持现有的任务分解逻辑不变

**关键修改点**：
```typescript
// 在管家层中集成任务分解
import { createAgentTaskDecompositionHandler } from "./task-board/agent-integration.js";

class ButlerAgent {
  private taskHandler: AgentTaskDecompositionHandler;
  
  constructor() {
    this.taskHandler = createAgentTaskDecompositionHandler({
      enabled: true,
      enableConcurrentExecution: false,
      enableAutoRetry: false,
    });
  }
  
  async handleMessage(message: string, context: ConversationContext) {
    // 判断是否需要任务分解
    const taskBoard = await this.taskHandler.handleMessage(message, {
      sessionId: context.sessionId,
      codebase: context.workspaceDir,
      recentMessages: context.messages,
    });
    
    if (taskBoard) {
      // 任务已分解，返回任务看板
      return this.taskHandler.formatTaskBoardMessage(taskBoard);
    }
    
    // 否则，正常处理对话
    return this.handleConversation(message, context);
  }
}
```

### 集成点 4：工具系统

**现有组件**：`src/agents/pi-tools.ts`

**集成方式**：
- 执行层直接使用现有的 `createClawdbotCodingTools()`
- 管家层和虚拟世界层不直接调用工具
- 保持现有的工具注册和调用机制不变

**关键修改点**：
```typescript
// 执行层使用现有工具系统
const tools = createClawdbotCodingTools({
  exec: execOverrides,
  sandbox,
  messageProvider,
  // ... 其他参数
});

// 管家层不直接使用工具，而是委托给任务调度层
// 虚拟世界层完全不知道工具的存在
```



## 架构设计

### 层次职责定义

#### 虚拟世界层 (Virtual World Layer)

**职责**：
- 提供纯粹的角色扮演体验
- 处理情感交互和对话
- 维护角色人格和世界观

**限制**：
- 不知道任何技术细节（工具、API、文件系统等）
- 不能直接调用工具
- 不能访问底层系统

**System Prompt 特点**：
- 只包含角色设定和世界观
- 不包含工具使用提示词
- 不包含底层系统提示词
- **预期节省 30-50% 的 token 消耗**

**实现方式**：
- 使用独立的 LLM 请求
- System Prompt 只包含角色扮演相关内容
- 当用户要求执行技术操作时，转发给管家层

**文件位置**：
- 新建：`src/agents/virtual-world/agent.ts`
- 新建：`src/agents/virtual-world/character-profiles.ts`



#### 管家层 (Butler Layer)

**职责**：
- 理解用户意图
- 分解任务为可执行的子任务
- 委托任务给任务调度层
- 将执行结果以友好的方式反馈给用户

**能力**：
- 调用独立的系统技能（记忆检索、知识查询等）
- 调用任务委托接口
- 处理对话前后的任务调度（记忆填充、总结归档）

**System Prompt 特点**：
- 包含任务委托相关提示词
- 包含独立技能的使用说明
- 不包含底层工具的详细说明

**实现方式**：
- 使用独立的 LLM 请求
- 通过 `delegateTask()` 接口委托任务
- 通过 `callSkill()` 接口调用独立技能

**文件位置**：
- 新建：`src/agents/butler/agent.ts`
- 新建：`src/agents/butler/task-delegator.ts`
- 新建：`src/agents/butler/skill-caller.ts`



#### 任务调度层 (Task Orchestration Layer)

**职责**：
- 接收管家层的任务委托
- 判断任务是否需要分解
- 分解复杂任务为子任务
- 调度执行层完成子任务
- 跟踪任务进度
- 处理失败和重试
- 汇总结果并返回

**核心组件**：
- **TaskBoard**：任务看板，管理任务状态
- **Orchestrator**：任务编排器，调度任务执行
- **Executor**：任务执行器，执行具体任务
- **FailureHandler**：失败处理器，处理失败和重试

**实现方式**：
- 深度融合现有的任务分解系统（`src/agents/task-board/`）
- 复用 TaskBoard、Orchestrator、Executor 等组件
- 扩展支持任务委托接口

**文件位置**：
- 复用：`src/agents/task-board/orchestrator.ts`
- 复用：`src/agents/task-board/executor.ts`
- 复用：`src/agents/task-board/progress-tracker.ts`
- 复用：`src/agents/task-board/failure-handler.ts`
- 新建：`src/agents/task-board/delegation-adapter.ts`（适配器）



#### 执行层 (Execution Layer)

**职责**：
- 执行具体的工具调用
- 执行技能调用
- 返回执行结果或错误信息

**限制**：
- 不做任何决策
- 只执行接收到的指令

**System Prompt 特点**：
- 包含工具使用提示词
- 包含工具参数说明
- 包含错误处理说明

**实现方式**：
- 使用现有的工具调用机制
- 通过 Pi Agent 的工具系统执行

**文件位置**：
- 复用：`src/agents/pi-tools.ts`
- 复用：`src/agents/bash-tools.exec.ts`
- 复用：`src/agents/pi-tools.read.ts`
- 新建：`src/agents/execution/tool-executor.ts`（封装）
- 新建：`src/agents/execution/skill-executor.ts`（封装）



### 层次通信协议

#### 任务委托协议 (Task Delegation Protocol)

**接口定义**：

```typescript
interface TaskDelegationRequest {
  taskId: string;              // 任务 ID
  taskType: string;            // 任务类型（simple, complex, skill）
  description: string;         // 任务描述
  parameters?: Record<string, unknown>; // 任务参数
  priority?: 'low' | 'normal' | 'high'; // 优先级
  timeout?: number;            // 超时时间（毫秒）
  onProgress?: (progress: TaskProgress) => void; // 进度回调
}

interface TaskDelegationResponse {
  taskId: string;              // 任务 ID
  status: 'success' | 'failure' | 'partial'; // 状态
  result?: unknown;            // 执行结果
  error?: string;              // 错误信息
  subtasks?: TaskResult[];     // 子任务结果
}

interface TaskProgress {
  taskId: string;              // 任务 ID
  progress: number;            // 进度（0-100）
  message: string;             // 进度消息
  currentSubtask?: string;     // 当前子任务
}
```

**通信流程**：

```
管家层                    任务调度层                  执行层
  │                          │                        │
  ├─ delegateTask() ────────>│                        │
  │                          ├─ 判断任务类型           │
  │                          ├─ 分解任务（如需要）     │
  │                          ├─ executeTask() ───────>│
  │                          │                        ├─ 执行工具调用
  │                          │<─ 返回结果 ────────────┤
  │<─ 返回结果 ──────────────┤                        │
  │                          │                        │
```



#### 进度通知协议 (Progress Notification Protocol)

**接口定义**：

```typescript
interface ProgressNotification {
  taskId: string;              // 任务 ID
  timestamp: number;           // 时间戳
  progress: number;            // 进度（0-100）
  message: string;             // 进度消息
  details?: Record<string, unknown>; // 详细信息
}
```

**通知流程**：

```
任务调度层                  管家层
  │                          │
  ├─ onProgress() ──────────>│
  │                          ├─ 更新 UI（如需要）
  │                          │
```

#### 错误处理协议 (Error Handling Protocol)

**错误类型**：

```typescript
enum TaskErrorType {
  TIMEOUT = 'timeout',           // 超时
  TOOL_ERROR = 'tool_error',     // 工具调用错误
  PARSE_ERROR = 'parse_error',   // 解析错误
  PERMISSION_ERROR = 'permission_error', // 权限错误
  UNKNOWN_ERROR = 'unknown_error' // 未知错误
}

interface TaskError {
  type: TaskErrorType;         // 错误类型
  message: string;             // 错误消息
  details?: unknown;           // 详细信息
  retryable: boolean;          // 是否可重试
}
```

**错误处理流程**：

```
执行层                    任务调度层                  管家层
  │                          │                        │
  ├─ 执行失败 ──────────────>│                        │
  │                          ├─ 判断是否可重试         │
  │                          ├─ 重试（如可重试）       │
  │                          ├─ 或返回错误 ──────────>│
  │                          │                        ├─ 友好提示用户
  │                          │                        │
```



## 组件和接口

### 虚拟世界层组件

#### VirtualWorldAgent

**职责**：处理角色扮演对话

**接口**：

```typescript
class VirtualWorldAgent {
  constructor(
    private characterName: string,
    private characterProfile: CharacterProfile,
    private llmProvider: LLMProvider
  ) {}

  /**
   * 处理用户消息
   */
  async handleMessage(
    message: string,
    context: ConversationContext
  ): Promise<string> {
    // 1. 构建 System Prompt（只包含角色设定）
    const systemPrompt = this.buildSystemPrompt();
    
    // 2. 调用 LLM
    const response = await this.llmProvider.chat({
      systemPrompt,
      messages: context.messages,
      userMessage: message
    });
    
    // 3. 检查是否需要转发给管家层
    if (this.needsButlerLayer(response)) {
      return this.forwardToButler(message, context);
    }
    
    return response;
  }

  /**
   * 构建 System Prompt（只包含角色设定）
   */
  private buildSystemPrompt(): string {
    return `你是${this.characterName}，${this.characterProfile.description}
    
你生活在一个虚拟的文字世界中，不知道任何技术细节。
你只能通过对话与主人互动，不能执行任何技术操作。
如果主人要求你执行技术操作，你应该礼貌地告诉主人你无法做到。`;
  }

  /**
   * 判断是否需要转发给管家层
   */
  private needsButlerLayer(response: string): boolean {
    // 检查响应中是否包含技术操作的关键词
    const technicalKeywords = ['写入文件', '读取文件', '执行命令', '搜索'];
    return technicalKeywords.some(keyword => response.includes(keyword));
  }

  /**
   * 转发给管家层
   */
  private async forwardToButler(
    message: string,
    context: ConversationContext
  ): Promise<string> {
    // 转发给管家层处理
    return `[转发给栗娜处理]`;
  }
}
```



### 管家层组件

#### ButlerAgent

**职责**：理解意图，委托任务，反馈结果

**接口**：

```typescript
class ButlerAgent {
  constructor(
    private taskDelegator: TaskDelegator,
    private skillCaller: SkillCaller,
    private llmProvider: LLMProvider
  ) {}

  /**
   * 处理用户消息
   */
  async handleMessage(
    message: string,
    context: ConversationContext
  ): Promise<string> {
    // 1. 对话前任务调度（记忆填充）
    await this.beforeConversation(context);
    
    // 2. 理解用户意图
    const intent = await this.understandIntent(message, context);
    
    // 3. 根据意图执行操作
    let result: string;
    if (intent.type === 'task') {
      result = await this.handleTask(intent);
    } else if (intent.type === 'skill') {
      result = await this.handleSkill(intent);
    } else {
      result = await this.handleConversation(message, context);
    }
    
    // 4. 对话后任务调度（总结归档）
    await this.afterConversation(context, result);
    
    return result;
  }

  /**
   * 对话前任务调度（记忆填充）
   */
  private async beforeConversation(
    context: ConversationContext
  ): Promise<void> {
    // 委托记忆填充任务
    const memoryTask: TaskDelegationRequest = {
      taskId: `memory-fill-${Date.now()}`,
      taskType: 'skill',
      description: '填充相关记忆到上下文',
      parameters: {
        userId: context.userId,
        conversationId: context.conversationId
      }
    };
    
    const response = await this.taskDelegator.delegate(memoryTask);
    
    if (response.status === 'success' && response.result) {
      // 将记忆注入到上下文
      context.memories = response.result as Memory[];
    }
  }

  /**
   * 对话后任务调度（总结归档）
   */
  private async afterConversation(
    context: ConversationContext,
    result: string
  ): Promise<void> {
    // 委托总结归档任务
    const summaryTask: TaskDelegationRequest = {
      taskId: `summary-archive-${Date.now()}`,
      taskType: 'skill',
      description: '总结对话并归档到长期记忆',
      parameters: {
        userId: context.userId,
        conversationId: context.conversationId,
        messages: context.messages,
        result
      }
    };
    
    // 异步执行，不等待结果
    this.taskDelegator.delegate(summaryTask).catch(err => {
      console.error('Summary archive failed:', err);
    });
  }

  /**
   * 处理任务
   */
  private async handleTask(intent: Intent): Promise<string> {
    // 委托任务给任务调度层
    const task: TaskDelegationRequest = {
      taskId: `task-${Date.now()}`,
      taskType: intent.complexity === 'simple' ? 'simple' : 'complex',
      description: intent.description,
      parameters: intent.parameters
    };
    
    const response = await this.taskDelegator.delegate(task);
    
    if (response.status === 'success') {
      return this.formatSuccessResponse(response);
    } else {
      return this.formatErrorResponse(response);
    }
  }

  /**
   * 处理技能调用
   */
  private async handleSkill(intent: Intent): Promise<string> {
    const result = await this.skillCaller.call(
      intent.skillName,
      intent.parameters
    );
    
    return this.formatSkillResponse(result);
  }

  /**
   * 处理普通对话
   */
  private async handleConversation(
    message: string,
    context: ConversationContext
  ): Promise<string> {
    // 构建 System Prompt（包含任务委托相关提示词）
    const systemPrompt = this.buildSystemPrompt();
    
    // 调用 LLM
    const response = await this.llmProvider.chat({
      systemPrompt,
      messages: context.messages,
      userMessage: message
    });
    
    return response;
  }

  /**
   * 构建 System Prompt（包含任务委托相关提示词）
   */
  private buildSystemPrompt(): string {
    return `你是栗娜，主人的行政总监和管家。

你的职责：
1. 理解主人的意图
2. 将任务委托给底层系统执行
3. 将执行结果以友好的方式反馈给主人

你可以调用以下能力：
- delegateTask(): 委托任务给底层系统
- callSkill(): 调用独立技能（记忆检索、知识查询等）

注意：你不直接执行工具调用，而是委托给底层系统。`;
  }
}
```



### 任务调度层组件

#### TaskDelegator

**职责**：接收任务委托，调度任务执行

**接口**：

```typescript
class TaskDelegator {
  constructor(
    private taskBoard: TaskBoard,
    private orchestrator: Orchestrator,
    private executor: Executor
  ) {}

  /**
   * 委托任务
   */
  async delegate(
    request: TaskDelegationRequest
  ): Promise<TaskDelegationResponse> {
    // 1. 创建任务
    const task = await this.taskBoard.createTask({
      id: request.taskId,
      type: request.taskType,
      description: request.description,
      parameters: request.parameters,
      priority: request.priority || 'normal',
      timeout: request.timeout
    });
    
    // 2. 判断任务类型
    if (request.taskType === 'simple') {
      // 简单任务：直接执行
      return this.executeSimpleTask(task, request.onProgress);
    } else if (request.taskType === 'complex') {
      // 复杂任务：分解后执行
      return this.executeComplexTask(task, request.onProgress);
    } else if (request.taskType === 'skill') {
      // 技能调用：直接执行
      return this.executeSkillTask(task, request.onProgress);
    }
    
    throw new Error(`Unknown task type: ${request.taskType}`);
  }

  /**
   * 执行简单任务
   */
  private async executeSimpleTask(
    task: Task,
    onProgress?: (progress: TaskProgress) => void
  ): Promise<TaskDelegationResponse> {
    try {
      // 直接调用执行层
      const result = await this.executor.execute(task);
      
      return {
        taskId: task.id,
        status: 'success',
        result
      };
    } catch (error) {
      return {
        taskId: task.id,
        status: 'failure',
        error: error.message
      };
    }
  }

  /**
   * 执行复杂任务
   */
  private async executeComplexTask(
    task: Task,
    onProgress?: (progress: TaskProgress) => void
  ): Promise<TaskDelegationResponse> {
    try {
      // 1. 分解任务
      const subtasks = await this.orchestrator.decompose(task);
      
      // 2. 执行子任务
      const results: TaskResult[] = [];
      for (let i = 0; i < subtasks.length; i++) {
        const subtask = subtasks[i];
        
        // 通知进度
        if (onProgress) {
          onProgress({
            taskId: task.id,
            progress: (i / subtasks.length) * 100,
            message: `执行子任务 ${i + 1}/${subtasks.length}`,
            currentSubtask: subtask.description
          });
        }
        
        // 执行子任务
        const result = await this.executor.execute(subtask);
        results.push({
          subtaskId: subtask.id,
          status: 'success',
          result
        });
      }
      
      // 3. 汇总结果
      return {
        taskId: task.id,
        status: 'success',
        result: this.aggregateResults(results),
        subtasks: results
      };
    } catch (error) {
      return {
        taskId: task.id,
        status: 'failure',
        error: error.message
      };
    }
  }

  /**
   * 执行技能任务
   */
  private async executeSkillTask(
    task: Task,
    onProgress?: (progress: TaskProgress) => void
  ): Promise<TaskDelegationResponse> {
    try {
      // 调用技能执行器
      const result = await this.executor.executeSkill(
        task.parameters.skillName,
        task.parameters
      );
      
      return {
        taskId: task.id,
        status: 'success',
        result
      };
    } catch (error) {
      return {
        taskId: task.id,
        status: 'failure',
        error: error.message
      };
    }
  }

  /**
   * 汇总结果
   */
  private aggregateResults(results: TaskResult[]): unknown {
    // 简单实现：返回所有结果的数组
    return results.map(r => r.result);
  }
}
```

#### Orchestrator（复用现有组件）

**职责**：任务编排，分解复杂任务

**接口**：

```typescript
class Orchestrator {
  constructor(
    private decomposer: TaskDecomposer,
    private failureHandler: FailureHandler
  ) {}

  /**
   * 分解任务
   */
  async decompose(task: Task): Promise<Task[]> {
    // 使用现有的任务分解器
    return this.decomposer.decompose(task);
  }

  /**
   * 处理失败
   */
  async handleFailure(
    task: Task,
    error: TaskError
  ): Promise<void> {
    // 使用现有的失败处理器
    await this.failureHandler.handle(task, error);
  }
}
```

#### Executor（复用现有组件）

**职责**：执行具体任务

**接口**：

```typescript
class Executor {
  constructor(
    private toolExecutor: ToolExecutor,
    private skillExecutor: SkillExecutor
  ) {}

  /**
   * 执行任务
   */
  async execute(task: Task): Promise<unknown> {
    // 根据任务类型选择执行器
    if (task.type === 'tool') {
      return this.toolExecutor.execute(task);
    } else if (task.type === 'skill') {
      return this.skillExecutor.execute(task);
    }
    
    throw new Error(`Unknown task type: ${task.type}`);
  }

  /**
   * 执行技能
   */
  async executeSkill(
    skillName: string,
    parameters: Record<string, unknown>
  ): Promise<unknown> {
    return this.skillExecutor.execute({
      skillName,
      parameters
    });
  }
}
```



### 执行层组件

#### ToolExecutor

**职责**：执行工具调用

**接口**：

```typescript
class ToolExecutor {
  constructor(
    private piAgent: PiAgent
  ) {}

  /**
   * 执行工具调用
   */
  async execute(task: Task): Promise<unknown> {
    // 使用 Pi Agent 的工具系统执行
    const toolName = task.parameters.toolName;
    const toolArgs = task.parameters.toolArgs;
    
    return this.piAgent.callTool(toolName, toolArgs);
  }
}
```

#### SkillExecutor

**职责**：执行技能调用

**接口**：

```typescript
class SkillExecutor {
  constructor(
    private skillRegistry: SkillRegistry
  ) {}

  /**
   * 执行技能调用
   */
  async execute(task: {
    skillName: string;
    parameters: Record<string, unknown>;
  }): Promise<unknown> {
    // 从技能注册表获取技能
    const skill = this.skillRegistry.get(task.skillName);
    
    if (!skill) {
      throw new Error(`Skill not found: ${task.skillName}`);
    }
    
    // 执行技能
    return skill.execute(task.parameters);
  }
}
```



## 数据模型

### 任务模型

```typescript
interface Task {
  id: string;                  // 任务 ID
  type: 'simple' | 'complex' | 'tool' | 'skill'; // 任务类型
  description: string;         // 任务描述
  parameters: Record<string, unknown>; // 任务参数
  priority: 'low' | 'normal' | 'high'; // 优先级
  timeout?: number;            // 超时时间（毫秒）
  status: TaskStatus;          // 任务状态
  createdAt: number;           // 创建时间
  startedAt?: number;          // 开始时间
  completedAt?: number;        // 完成时间
  result?: unknown;            // 执行结果
  error?: TaskError;           // 错误信息
  subtasks?: Task[];           // 子任务
}

enum TaskStatus {
  PENDING = 'pending',         // 待执行
  RUNNING = 'running',         // 执行中
  SUCCESS = 'success',         // 成功
  FAILURE = 'failure',         // 失败
  CANCELLED = 'cancelled'      // 已取消
}
```

### 意图模型

```typescript
interface Intent {
  type: 'task' | 'skill' | 'conversation'; // 意图类型
  description: string;         // 意图描述
  complexity?: 'simple' | 'complex'; // 复杂度（仅任务）
  skillName?: string;          // 技能名称（仅技能）
  parameters?: Record<string, unknown>; // 参数
}
```

### 对话上下文模型

```typescript
interface ConversationContext {
  userId: string;              // 用户 ID
  conversationId: string;      // 对话 ID
  messages: Message[];         // 消息历史
  memories?: Memory[];         // 相关记忆
  metadata?: Record<string, unknown>; // 元数据
}

interface Message {
  role: 'user' | 'assistant' | 'system'; // 角色
  content: string;             // 内容
  timestamp: number;           // 时间戳
}

interface Memory {
  id: string;                  // 记忆 ID
  type: 'short_term' | 'long_term'; // 记忆类型
  content: string;             // 记忆内容
  relevance: number;           // 相关度（0-1）
  timestamp: number;           // 时间戳
}
```

### 角色配置模型

```typescript
interface CharacterProfile {
  name: string;                // 角色名称
  description: string;         // 角色描述
  personality: string[];       // 性格特点
  background: string;          // 背景故事
  worldView: string;           // 世界观
  restrictions: string[];      // 限制条件
}
```

### 任务结果模型

```typescript
interface TaskResult {
  subtaskId: string;           // 子任务 ID
  status: 'success' | 'failure'; // 状态
  result?: unknown;            // 结果
  error?: string;              // 错误信息
}
```



## 正确性属性

*属性（Property）是一个特征或行为，应该在系统的所有有效执行中保持为真——本质上是关于系统应该做什么的形式化陈述。属性是人类可读规范和机器可验证正确性保证之间的桥梁。*

### 属性 1：虚拟世界层隔离性

*对于任何*用户消息和虚拟世界层的响应，响应中不应该包含任何工具调用或技术操作描述

**验证：需求 1.1, 1.2, 1.4, 7.1**

### 属性 2：虚拟世界层转发机制

*对于任何*包含技术操作关键词的用户消息，虚拟世界层应该将请求转发给管家层处理

**验证：需求 1.5**

### 属性 3：管家层任务委托

*对于任何*任务请求，管家层应该通过 delegateTask() 接口委托给任务调度层，而不是直接执行工具调用

**验证：需求 2.2, 2.4**

### 属性 4：管家层结果反馈

*对于任何*任务调度层返回的结果，管家层应该将结果以友好的方式反馈给用户

**验证：需求 2.3**

### 属性 5：任务分解判断

*对于任何*任务，任务调度层应该根据任务复杂度自动判断是否需要分解

**验证：需求 3.1**

### 属性 6：复杂任务分解

*对于任何*复杂任务，任务调度层应该将任务分解为多个子任务并逐一执行

**验证：需求 3.2, 8.2**

### 属性 7：子任务调度

*对于任何*分解后的子任务，任务调度层应该调度执行层完成每个子任务

**验证：需求 3.3**

### 属性 8：失败处理和重试

*对于任何*执行失败的子任务，任务调度层应该自动处理失败并根据错误类型决定是否重试

**验证：需求 3.4, 8.5**

### 属性 9：结果汇总

*对于任何*包含多个子任务的任务，任务调度层应该将所有子任务结果汇总并返回给管家层

**验证：需求 3.5**

### 属性 10：执行策略选择

*对于任何*任务，任务调度层应该根据任务依赖关系智能选择串行或并行执行策略

**验证：需求 3.8, 8.3, 8.4**

### 属性 11：工具调用执行

*对于任何*工具调用请求，执行层应该执行对应的工具并返回结果或错误信息

**验证：需求 4.1, 4.2, 4.3**

### 属性 12：技能调用支持

*对于任何*技能调用请求，执行层应该执行对应的技能并返回结果

**验证：需求 4.6**

### 属性 13：任务传递

*对于任何*通过任务委托接口提交的任务，系统应该将任务正确传递给任务调度层并返回结果

**验证：需求 5.2, 5.3**

### 属性 14：异步任务支持

*对于任何*异步任务，任务委托机制应该支持异步执行并通过回调通知进度

**验证：需求 5.4, 5.5**

### 属性 15：任务取消

*对于任何*正在执行的任务，任务委托机制应该支持取消操作

**验证：需求 5.6, 6.5**

### 属性 16：错误处理和重试

*对于任何*通信错误，系统应该根据错误类型决定是否重试

**验证：需求 6.3**

### 属性 17：进度通知

*对于任何*长时间运行的任务，系统应该定期发送进度通知

**验证：需求 6.4**

### 属性 18：执行层纯粹性

*对于任何*执行层的操作，不应该包含角色扮演逻辑或决策逻辑

**验证：需求 7.2**

### 属性 19：职责分离

*对于任何*管家层的操作，应该清晰区分角色扮演和工具调用

**验证：需求 7.3**

### 属性 20：隔离性

*对于任何*角色扮演操作和工具调用操作，两者应该相互独立，不相互干扰

**验证：需求 7.5**

### 属性 21：简单任务直接执行

*对于任何*简单任务，任务调度层应该直接调用执行层完成任务，不进行分解

**验证：需求 8.1**

### 属性 22：任务流转日志

*对于任何*任务在各层之间的流转，系统应该记录详细的日志，包含任务 ID、层次、时间戳、状态等信息

**验证：需求 11.1, 11.2**

### 属性 23：日志查询

*对于任何*任务 ID，系统应该支持查询该任务的完整流转过程

**验证：需求 11.3**

### 属性 24：性能监控

*对于任何*任务执行，系统应该收集性能监控指标（延迟、token 消耗等）

**验证：需求 11.5**

### 属性 25：对话前记忆填充

*对于任何*虚拟世界层的对话，系统应该在对话前自动执行记忆填充任务并将相关记忆注入到上下文中

**验证：需求 14.1, 14.2**

### 属性 26：对话后总结归档

*对于任何*虚拟世界层的对话，系统应该在对话后自动执行总结归档任务并将对话内容归档到长期记忆中

**验证：需求 14.3, 14.4**

### 属性 27：自定义任务支持

*对于任何*自定义任务（如情感分析、关键词提取等），对话前后的任务调度应该支持添加和执行

**验证：需求 14.6**

### 属性 28：任务失败容错

*对于任何*对话前后的任务执行失败，系统应该记录错误但不影响对话流程

**验证：需求 14.7**



## 错误处理

### 错误类型

系统定义以下错误类型：

1. **TIMEOUT**：任务执行超时
2. **TOOL_ERROR**：工具调用错误
3. **PARSE_ERROR**：解析错误
4. **PERMISSION_ERROR**：权限错误
5. **UNKNOWN_ERROR**：未知错误

### 错误处理策略

#### 虚拟世界层

- **错误类型**：无（不执行工具调用）
- **处理策略**：如果检测到技术操作请求，转发给管家层

#### 管家层

- **错误类型**：任务委托失败、技能调用失败
- **处理策略**：
  - 将错误信息以友好的方式反馈给用户
  - 记录错误日志
  - 不重试（由任务调度层负责重试）

#### 任务调度层

- **错误类型**：任务分解失败、子任务执行失败
- **处理策略**：
  - 判断错误是否可重试
  - 如果可重试，自动重试（最多 3 次）
  - 如果不可重试或重试失败，返回错误给管家层
  - 记录详细的错误日志

#### 执行层

- **错误类型**：工具调用失败、技能调用失败
- **处理策略**：
  - 捕获所有错误
  - 返回标准的错误响应
  - 记录错误日志
  - 不重试（由任务调度层负责重试）

### 错误恢复

#### 部分失败恢复

当复杂任务的部分子任务失败时：

1. 记录失败的子任务
2. 继续执行其他子任务（如果可以）
3. 返回部分成功的结果
4. 在响应中标记失败的子任务

#### 完全失败恢复

当任务完全失败时：

1. 记录完整的错误信息
2. 返回友好的错误提示
3. 建议用户采取的操作
4. 不影响系统的其他功能

### 错误日志

所有错误都应该记录到日志系统，包含：

- 错误类型
- 错误消息
- 错误堆栈
- 任务 ID
- 层次信息
- 时间戳
- 上下文信息



## 测试策略

### 双重测试方法

系统采用**单元测试**和**属性测试**相结合的方法：

- **单元测试**：验证具体示例、边界情况、错误条件
- **属性测试**：验证所有输入的通用属性
- 两者互补，共同确保全面覆盖

### 单元测试

单元测试专注于：

- **具体示例**：演示正确行为的特定示例
- **集成点**：组件之间的集成点
- **边界情况和错误条件**：特殊情况和错误处理

**示例**：

```typescript
describe('VirtualWorldAgent', () => {
  it('should not call tools when handling user message', async () => {
    const agent = new VirtualWorldAgent('丽丝', profile, llmProvider);
    const response = await agent.handleMessage('你好', context);
    
    // 验证没有调用工具
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });
  
  it('should forward technical requests to butler layer', async () => {
    const agent = new VirtualWorldAgent('丽丝', profile, llmProvider);
    const response = await agent.handleMessage('请写入文件', context);
    
    // 验证转发给管家层
    expect(response).toContain('[转发给栗娜处理]');
  });
});
```

### 属性测试

属性测试专注于：

- **通用属性**：适用于所有输入的属性
- **通过随机化实现全面的输入覆盖**

**配置**：

- 每个属性测试最少运行 **100 次迭代**（由于随机化）
- 每个测试必须引用其设计文档属性
- 标签格式：**Feature: multi-layer-agent-architecture, Property {number}: {property_text}**

**示例**：

```typescript
describe('Property Tests', () => {
  // Feature: multi-layer-agent-architecture, Property 1: 虚拟世界层隔离性
  it('should not include tool calls in virtual world layer responses', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(), // 随机用户消息
        async (userMessage) => {
          const agent = new VirtualWorldAgent('丽丝', profile, llmProvider);
          const response = await agent.handleMessage(userMessage, context);
          
          // 验证响应中不包含工具调用
          const technicalKeywords = ['写入文件', '读取文件', '执行命令', '搜索'];
          const hasTechnicalKeywords = technicalKeywords.some(
            keyword => response.includes(keyword)
          );
          
          expect(hasTechnicalKeywords).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
  
  // Feature: multi-layer-agent-architecture, Property 3: 管家层任务委托
  it('should delegate tasks instead of executing tools directly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          taskType: fc.constantFrom('simple', 'complex'),
          description: fc.string(),
          parameters: fc.dictionary(fc.string(), fc.anything())
        }),
        async (taskRequest) => {
          const butler = new ButlerAgent(taskDelegator, skillCaller, llmProvider);
          await butler.handleTask(taskRequest);
          
          // 验证调用了 delegateTask()
          expect(taskDelegator.delegate).toHaveBeenCalled();
          
          // 验证没有直接调用工具
          expect(toolExecutor.execute).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

### 集成测试

集成测试验证各层之间的协作：

```typescript
describe('Multi-Layer Integration', () => {
  it('should handle end-to-end task delegation', async () => {
    // 1. 用户向管家层发送任务请求
    const butler = new ButlerAgent(taskDelegator, skillCaller, llmProvider);
    const response = await butler.handleMessage('请写入文件到 /tmp/test.txt', context);
    
    // 2. 验证任务被委托给任务调度层
    expect(taskDelegator.delegate).toHaveBeenCalled();
    
    // 3. 验证任务调度层调用执行层
    expect(executor.execute).toHaveBeenCalled();
    
    // 4. 验证执行层调用工具
    expect(toolExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: expect.objectContaining({
          toolName: 'write'
        })
      })
    );
    
    // 5. 验证结果返回给用户
    expect(response).toContain('文件已写入');
  });
});
```

### 性能测试

性能测试验证系统性能指标：

```typescript
describe('Performance Tests', () => {
  it('should not increase latency significantly', async () => {
    const startTime = Date.now();
    
    // 执行任务
    await butler.handleMessage('请写入文件', context);
    
    const endTime = Date.now();
    const latency = endTime - startTime;
    
    // 验证延迟不超过基准的 120%
    expect(latency).toBeLessThan(baselineLatency * 1.2);
  });
  
  it('should reduce token consumption significantly', async () => {
    // 测量虚拟世界层的 token 消耗
    const virtualWorldTokens = await measureTokens(() => {
      return virtualWorldAgent.handleMessage('你好', context);
    });
    
    // 测量旧架构的 token 消耗
    const oldArchitectureTokens = await measureTokens(() => {
      return oldAgent.handleMessage('你好', context);
    });
    
    // 验证 token 消耗降低至少 30%
    expect(virtualWorldTokens).toBeLessThan(oldArchitectureTokens * 0.7);
  });
});
```

### 测试覆盖率

目标测试覆盖率：

- **行覆盖率**：≥ 80%
- **分支覆盖率**：≥ 75%
- **函数覆盖率**：≥ 80%
- **语句覆盖率**：≥ 80%

### 测试工具

- **单元测试框架**：Vitest
- **属性测试库**：fast-check
- **覆盖率工具**：V8 coverage
- **性能测试工具**：自定义性能测量工具



## 实现路径

### 阶段 1：基础设施准备（第 1-2 周）

**目标**：搭建多层架构的基础设施，不影响现有功能

**任务**：

1. **创建目录结构**
   - `src/agents/virtual-world/`：虚拟世界层
   - `src/agents/butler/`：管家层
   - `src/agents/execution/`：执行层封装
   - `src/agents/multi-layer/`：多层架构协调器

2. **定义接口和类型**
   - 创建 `src/agents/multi-layer/types.ts`
   - 定义 TaskDelegationRequest、TaskDelegationResponse 等接口
   - 定义 Intent、ConversationContext 等数据模型

3. **实现层次判断逻辑**
   - 在 `src/agents/multi-layer/layer-resolver.ts` 中实现
   - 根据 sessionKey 或配置判断当前应该使用哪一层
   - 保持向后兼容，默认使用执行层

4. **扩展 System Prompt 构建器**
   - 修改 `src/agents/pi-embedded-runner/system-prompt.ts`
   - 添加 `agentLayer` 参数
   - 根据层次选择性包含提示词内容

**验收标准**：
- 目录结构创建完成
- 接口和类型定义完成
- 层次判断逻辑实现并测试通过
- System Prompt 构建器扩展完成并向后兼容



### 阶段 2：执行层封装（第 3 周）

**目标**：将现有的工具调用机制封装为执行层，为上层提供统一接口

**任务**：

1. **实现 ToolExecutor**
   - 创建 `src/agents/execution/tool-executor.ts`
   - 封装现有的 `createClawdbotCodingTools()` 调用
   - 提供统一的 `execute(task)` 接口

2. **实现 SkillExecutor**
   - 创建 `src/agents/execution/skill-executor.ts`
   - 封装技能调用逻辑
   - 提供统一的 `execute(skill)` 接口

3. **实现 Executor**
   - 创建 `src/agents/execution/executor.ts`
   - 整合 ToolExecutor 和 SkillExecutor
   - 根据任务类型选择执行器

4. **编写单元测试**
   - 测试 ToolExecutor 的工具调用
   - 测试 SkillExecutor 的技能调用
   - 测试 Executor 的任务分发

**验收标准**：
- ToolExecutor 实现完成并测试通过
- SkillExecutor 实现完成并测试通过
- Executor 实现完成并测试通过
- 单元测试覆盖率 ≥ 80%

### 阶段 3：任务调度层适配（第 4-5 周）

**目标**：将现有的任务分解系统适配为任务调度层，支持任务委托接口

**任务**：

1. **实现 TaskDelegator**
   - 创建 `src/agents/task-board/delegation-adapter.ts`
   - 实现 `delegate(request)` 接口
   - 适配现有的 AgentOrchestrator

2. **扩展 AgentOrchestrator**
   - 修改 `src/agents/task-board/orchestrator.ts`
   - 支持从 TaskDelegationRequest 创建任务
   - 支持进度回调

3. **扩展 Executor**
   - 修改 `src/agents/task-board/executor.ts`
   - 集成执行层的 ToolExecutor 和 SkillExecutor
   - 支持工具调用和技能调用

4. **编写集成测试**
   - 测试任务委托流程
   - 测试简单任务执行
   - 测试复杂任务分解和执行

**验收标准**：
- TaskDelegator 实现完成并测试通过
- AgentOrchestrator 扩展完成并向后兼容
- Executor 集成完成并测试通过
- 集成测试覆盖率 ≥ 75%



### 阶段 4：管家层实现（第 6-7 周）

**目标**：实现管家层，支持任务委托和技能调用

**任务**：

1. **实现 ButlerAgent**
   - 创建 `src/agents/butler/agent.ts`
   - 实现 `handleMessage()` 方法
   - 实现意图理解逻辑
   - 实现任务委托逻辑

2. **实现 SkillCaller**
   - 创建 `src/agents/butler/skill-caller.ts`
   - 封装独立技能调用
   - 支持记忆检索、知识查询等技能

3. **实现对话前后任务调度**
   - 实现 `beforeConversation()` 方法（记忆填充）
   - 实现 `afterConversation()` 方法（总结归档）
   - 支持自定义任务

4. **集成到 Pi Agent**
   - 修改 `src/agents/pi-embedded-runner/run/attempt.ts`
   - 在 `runEmbeddedAttempt()` 中集成管家层
   - 根据层次判断选择执行路径

5. **编写端到端测试**
   - 测试管家层的任务委托
   - 测试对话前后的任务调度
   - 测试端到端的任务执行流程

**验收标准**：
- ButlerAgent 实现完成并测试通过
- SkillCaller 实现完成并测试通过
- 对话前后任务调度实现完成
- 集成到 Pi Agent 完成并向后兼容
- 端到端测试覆盖率 ≥ 70%

### 阶段 5：虚拟世界层实现（第 8 周）

**目标**：实现虚拟世界层，提供纯粹的角色扮演体验

**任务**：

1. **实现 VirtualWorldAgent**
   - 创建 `src/agents/virtual-world/agent.ts`
   - 实现 `handleMessage()` 方法
   - 实现技术操作检测和转发逻辑

2. **定义角色配置**
   - 创建 `src/agents/virtual-world/character-profiles.ts`
   - 定义丽丝、艾莉等角色的配置
   - 包含角色设定、性格、背景等

3. **实现 System Prompt 构建**
   - 实现虚拟世界层的 System Prompt 构建逻辑
   - 只包含角色扮演相关内容
   - 不包含工具使用提示词

4. **集成到 Pi Agent**
   - 修改 `src/agents/pi-embedded-runner/run/attempt.ts`
   - 支持虚拟世界层的执行路径
   - 支持转发到管家层

5. **编写性能测试**
   - 测试虚拟世界层的 token 消耗
   - 验证 token 消耗降低 30-50%
   - 测试延迟不超过基准的 120%

**验收标准**：
- VirtualWorldAgent 实现完成并测试通过
- 角色配置定义完成
- System Prompt 构建实现完成
- 集成到 Pi Agent 完成
- 性能测试通过（token 消耗降低 ≥ 30%）



### 阶段 6：可观测性和监控（第 9 周）

**目标**：实现任务流转日志、性能监控和可视化

**任务**：

1. **实现任务流转日志**
   - 在每一层记录任务流转日志
   - 包含任务 ID、层次、时间戳、状态等信息
   - 支持按任务 ID 查询完整流转过程

2. **实现性能监控**
   - 收集延迟、token 消耗等指标
   - 按层次统计性能数据
   - 提供性能报告

3. **实现可视化**
   - 提供任务流转图
   - 提供性能监控仪表板
   - 支持实时监控

4. **编写监控测试**
   - 测试日志记录功能
   - 测试性能监控功能
   - 测试可视化功能

**验收标准**：
- 任务流转日志实现完成
- 性能监控实现完成
- 可视化实现完成
- 监控测试通过

### 阶段 7：文档和培训（第 10 周）

**目标**：编写完整的文档和培训材料

**任务**：

1. **编写用户文档**
   - 多层架构概述
   - 各层的职责和使用方法
   - 配置指南
   - 常见问题解答

2. **编写开发者文档**
   - 架构设计文档
   - API 参考文档
   - 扩展指南
   - 最佳实践

3. **编写迁移指南**
   - 从旧架构迁移到新架构的步骤
   - 兼容性说明
   - 常见问题和解决方案

4. **准备培训材料**
   - 演示视频
   - 示例代码
   - 实战案例

**验收标准**：
- 用户文档完成
- 开发者文档完成
- 迁移指南完成
- 培训材料准备完成

### 阶段 8：灰度发布和优化（第 11-12 周）

**目标**：灰度发布新架构，收集反馈并优化

**任务**：

1. **灰度发布**
   - 选择部分用户进行灰度测试
   - 收集用户反馈
   - 监控性能指标

2. **问题修复**
   - 修复灰度测试中发现的问题
   - 优化性能
   - 改进用户体验

3. **全量发布**
   - 逐步扩大灰度范围
   - 最终全量发布
   - 持续监控和优化

4. **回顾和总结**
   - 总结实施经验
   - 记录最佳实践
   - 规划后续优化

**验收标准**：
- 灰度发布完成
- 问题修复完成
- 全量发布完成
- 回顾和总结完成



## 风险和缓解措施

### 风险 1：性能开销

**描述**：多层架构可能增加系统延迟和 token 消耗

**影响**：用户体验下降

**缓解措施**：
- 通过 System Prompt 分层优化，预期降低 30-50% 的 token 消耗
- 优化层次通信，减少不必要的数据传递
- 实施性能监控，及时发现和优化性能瓶颈
- 设置性能基准，确保延迟增加不超过 20%

### 风险 2：兼容性问题

**描述**：新架构可能破坏现有功能

**影响**：现有用户受影响

**缓解措施**：
- 保持向后兼容，默认使用执行层
- 渐进式迁移，逐步启用新功能
- 完整的回归测试，确保现有功能正常
- 提供配置开关，允许用户选择使用旧架构或新架构

### 风险 3：复杂度增加

**描述**：多层架构增加系统复杂度

**影响**：开发和维护成本增加

**缓解措施**：
- 清晰的职责分离，降低理解成本
- 完整的文档和培训材料
- 标准化的接口和协议
- 充分的单元测试和集成测试

### 风险 4：任务分解失败

**描述**：任务调度层可能无法正确分解复杂任务

**影响**：任务执行失败

**缓解措施**：
- 复用现有的任务分解系统，已经过验证
- 实施失败处理和重试机制
- 提供人工介入机制
- 记录详细的日志，便于调试

### 风险 5：用户接受度

**描述**：用户可能不习惯新的交互方式

**影响**：用户流失

**缓解措施**：
- 提供详细的用户文档和培训
- 灰度发布，逐步推广
- 收集用户反馈，持续优化
- 保留旧架构作为备选方案



## 总结

### 核心优势

1. **职责清晰**：每一层专注于自己的职责，不越界
2. **易于扩展**：可以独立扩展每一层，不影响其他层
3. **易于测试**：每一层可以独立测试，提高测试覆盖率
4. **性能优化**：通过 System Prompt 分层，预期降低 30-50% 的 token 消耗
5. **用户体验**：角色扮演和工具调用完全分离，提供更好的用户体验

### 关键设计决策

1. **深度融合现有系统**：复用现有的任务分解系统、工具系统、Session Manager
2. **渐进式迁移**：支持逐步迁移，不推倒重来，保持向后兼容
3. **标准化接口**：定义清晰的层次通信协议，确保数据传递的准确性
4. **双重测试方法**：单元测试和属性测试相结合，确保全面覆盖
5. **可观测性**：实现任务流转日志、性能监控和可视化，便于调试和优化

### 实施建议

1. **按阶段实施**：严格按照实施路径的 8 个阶段进行，每个阶段都有明确的目标和验收标准
2. **持续测试**：每个阶段完成后都要进行充分的测试，确保质量
3. **及时反馈**：灰度发布期间及时收集用户反馈，快速迭代优化
4. **文档先行**：在实施前完成详细的文档，确保团队理解一致
5. **性能监控**：实施过程中持续监控性能指标，及时发现和解决问题

### 后续优化方向

1. **智能任务分解**：使用机器学习优化任务分解算法
2. **自适应层次选择**：根据任务类型自动选择最优的层次
3. **分布式执行**：支持任务在多个节点上分布式执行
4. **更多角色**：扩展虚拟世界层，支持更多角色和场景
5. **更多技能**：扩展管家层，支持更多独立技能

---

**版本**：v1.0  
**最后更新**：2026-01-31  
**作者**：Kiro AI Assistant  
**状态**：设计完成，待评审

