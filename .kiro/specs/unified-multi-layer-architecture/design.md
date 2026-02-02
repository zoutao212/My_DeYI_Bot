# Clawdbot 统一多层架构设计文档

## 概述

本文档整合了 Clawdbot 的所有功能模块，设计了一个统一、完整、有机融合的多层 Agent 架构。该架构将角色扮演、任务管理、记忆系统、任务分解等所有功能有机地结合在一起。

### 核心设计理念

1. **统一架构**：所有功能都在统一的多层架构下运行
2. **职责清晰**：每一层有明确的职责，不越界
3. **有机融合**：各功能模块无缝集成，不重复实现
4. **配置驱动**：通过配置文件控制行为，易于扩展
5. **渐进式迁移**：支持逐步迁移，保持向后兼容

### 架构层次

```
┌─────────────────────────────────────────────────────────────┐
│  虚拟世界层 (Virtual World Layer)                            │
│  - 角色：丽丝、艾莉等侍女                                    │
│  - 职责：纯角色扮演，情感交互                                │
│  - 能力：对话、转发技术请求                                  │
└─────────────────────────────────────────────────────────────┘
                          ↓ 转发请求
┌─────────────────────────────────────────────────────────────┐
│  管家层 (Butler Layer)                                       │
│  - 角色：栗娜（Lina）- 行政总监/管家                        │
│  - 职责：理解意图，分解任务，委托执行                        │
│  - 能力：任务管理、记忆管理、提醒管理、任务委托              │
│  - 组件：ButlerAgent, TaskDelegator, MemoryService,         │
│          ReminderManager, SkillCaller                       │
└─────────────────────────────────────────────────────────────┘
                          ↓ 任务委托
┌─────────────────────────────────────────────────────────────┐
│  任务调度层 (Task Orchestration Layer)                       │
│  - 组件：TaskBoard, Orchestrator, Executor,                 │
│          ProgressTracker, FailureHandler                    │
│  - 职责：分解任务，调度执行，跟踪进度                        │
│  - 策略：智能判断串行/并行，自动重试                         │
└─────────────────────────────────────────────────────────────┘
                          ↓ 工具调用
┌─────────────────────────────────────────────────────────────┐
│  执行层 (Execution Layer)                                    │
│  - 组件：ToolExecutor, SkillExecutor                        │
│  - 职责：执行工具调用，返回结果                              │
│  - 工具：read, write, edit, exec, grep, 技能等              │
└─────────────────────────────────────────────────────────────┘
```

## 详细架构设计

### 1. 虚拟世界层 (Virtual World Layer)

#### 1.1 职责

- **角色扮演**：提供纯粹的角色扮演体验
- **情感交互**：处理情感对话和陪伴
- **请求转发**：检测技术操作并转发给管家层

#### 1.2 组件

```typescript
// src/agents/virtual-world/agent.ts
export class VirtualWorldAgent {
  constructor(
    private characterName: string,
    private characterProfile: CharacterProfile,
    private llmProvider: LLMProvider,
    private coordinator: MultiLayerCoordinator
  ) {}

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
}
```

#### 1.3 System Prompt 特点

- 只包含角色设定和世界观
- 不包含工具使用提示词
- 不包含底层系统提示词
- **预期节省 30-50% 的 token 消耗**

#### 1.4 角色配置

角色配置通过 `clawd/characters/{characterName}/` 目录管理：

```
clawd/characters/lisi/
├── profile.md       # 角色设定（性格、能力、对话风格）
└── config.json      # 角色配置（功能开关、参数）
```

### 2. 管家层 (Butler Layer)

#### 2.1 职责

- **意图理解**：理解用户意图
- **任务分解**：分解任务为可执行的子任务
- **任务委托**：委托任务给任务调度层
- **记忆管理**：对话前后的记忆检索和归档
- **提醒管理**：管理用户的提醒事项（Lina 独有）
- **结果反馈**：将执行结果以友好的方式反馈给用户

#### 2.2 核心组件

##### 2.2.1 ButlerAgent

```typescript
// src/agents/butler/agent.ts
export class ButlerAgent {
  constructor(
    private taskDelegator: TaskDelegator,
    private memoryService: IMemoryService,
    private reminderManager: ReminderManager, // Lina 独有
    private skillCaller: SkillCaller,
    private llmProvider: LLMProvider,
    private characterConfig?: CharacterConfig // Lina 人格配置
  ) {}

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
    } else if (intent.type === 'reminder') {
      result = await this.handleReminder(intent); // Lina 独有
    } else {
      result = await this.handleConversation(message, context);
    }
    
    // 4. 对话后任务调度（总结归档）
    await this.afterConversation(context, result);
    
    return result;
  }

  private async beforeConversation(
    context: ConversationContext
  ): Promise<void> {
    // 检索相关记忆并注入到上下文
    const result = await this.memoryService.retrieve({
      query: context.messages[context.messages.length - 1]?.content || "",
      context: {
        userId: context.userId,
        sessionId: context.sessionId,
        layer: "butler",
      },
    });

    if (result.memories.length > 0) {
      (context as any).memories = result.memories;
      (context as any).memoryContext = result.formattedContext;
    }
  }

  private async afterConversation(
    context: ConversationContext,
    result: string
  ): Promise<void> {
    // 生成会话总结并归档
    const summary = generateSessionSummary(context.messages);
    
    if (summary) {
      // 异步归档（不等待结果）
      this.memoryService.archive({
        summary,
        context: {
          userId: context.userId,
          sessionId: context.sessionId,
        },
      }).catch((err) => {
        console.error("Memory archival failed:", err);
      });
    }
  }
}
```

##### 2.2.2 TaskDelegator

```typescript
// src/agents/butler/task-delegator.ts
export class TaskDelegator {
  constructor(
    private orchestrator: Orchestrator,
    private executor: Executor
  ) {}

  async delegateTask(
    request: TaskDelegationRequest
  ): Promise<TaskDelegationResponse> {
    // 委托给任务调度层
    return this.orchestrator.delegate(request);
  }
}
```

##### 2.2.3 ReminderManager (Lina 独有)

```typescript
// src/agents/butler/reminder-manager.ts
export class ReminderManager {
  async createReminder(reminder: Reminder): Promise<string> {
    // 创建提醒并持久化
  }

  async checkDueReminders(): Promise<Reminder[]> {
    // 检查到期提醒
  }
}
```

#### 2.3 Lina 人格化集成

Lina 是 Butler 的人格化定义，通过配置文件驱动：

```typescript
// 加载 Lina 配置
const linaConfig = await loadCharacterConfig("lina", basePath);
const linaProfile = await loadCharacterProfile("lina", basePath);

// 创建 Butler Agent 时注入人格配置
const butlerAgent = new ButlerAgent(
  taskDelegator,
  memoryService,
  reminderManager,
  skillCaller,
  llmProvider,
  linaConfig // 注入人格配置
);

// System Prompt 中包含 Lina 的人格设定
const systemPrompt = buildButlerSystemPrompt({
  characterConfig: linaConfig,
  characterProfile: linaProfile,
  // ... 其他参数
});
```

### 3. 任务调度层 (Task Orchestration Layer)

#### 3.1 职责

- **任务分解**：接收管家层的任务委托，判断是否需要分解
- **任务调度**：调度执行层完成子任务
- **进度跟踪**：跟踪任务进度并更新任务看板
- **失败处理**：处理失败和重试
- **结果汇总**：汇总结果并返回给管家层

#### 3.2 核心组件

##### 3.2.1 Orchestrator

```typescript
// src/agents/task-board/orchestrator.ts
export class Orchestrator {
  constructor(
    private taskBoard: TaskBoard,
    private decomposer: TaskDecomposer,
    private executor: Executor,
    private progressTracker: ProgressTracker,
    private failureHandler: FailureHandler
  ) {}

  async delegate(
    request: TaskDelegationRequest
  ): Promise<TaskDelegationResponse> {
    // 1. 创建任务
    const task = await this.taskBoard.createTask({
      id: request.taskId,
      type: request.taskType,
      description: request.description,
      parameters: request.parameters,
    });

    // 2. 判断任务类型
    if (request.taskType === 'simple') {
      return this.executeSimpleTask(task, request.onProgress);
    } else if (request.taskType === 'complex') {
      return this.executeComplexTask(task, request.onProgress);
    }

    throw new Error(`Unknown task type: ${request.taskType}`);
  }

  private async executeComplexTask(
    task: Task,
    onProgress?: (progress: TaskProgress) => void
  ): Promise<TaskDelegationResponse> {
    // 1. 分解任务
    const subtasks = await this.decomposer.decompose(task);

    // 2. 初始化任务看板
    await this.progressTracker.initialize(task, subtasks);

    // 3. 执行子任务
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
      try {
        const result = await this.executor.execute(subtask);
        results.push({
          subtaskId: subtask.id,
          status: 'success',
          result
        });
        
        // 更新进度
        await this.progressTracker.updateSubTaskStatus(
          subtask.id,
          'completed'
        );
      } catch (error) {
        // 处理失败
        const decision = await this.failureHandler.handleFailure(
          subtask,
          error
        );
        
        if (decision.action === 'retry') {
          // 重试
          continue;
        } else if (decision.action === 'skip') {
          // 跳过
          await this.progressTracker.updateSubTaskStatus(
            subtask.id,
            'skipped'
          );
        } else if (decision.action === 'abort') {
          // 中止
          return {
            taskId: task.id,
            status: 'failure',
            error: 'Task aborted by user'
          };
        }
      }
    }

    // 4. 汇总结果
    return {
      taskId: task.id,
      status: 'success',
      result: this.aggregateResults(results),
      subtasks: results
    };
  }
}
```

##### 3.2.2 TaskBoard

```typescript
// src/agents/task-board/task-board.ts
export class TaskBoard {
  private board: TaskBoardData;

  async createTask(task: Task): Promise<Task> {
    // 创建任务并持久化
  }

  async getTask(taskId: string): Promise<Task | null> {
    // 从持久化存储加载任务
  }

  async persist(): Promise<void> {
    // 持久化到磁盘（JSON + Markdown）
  }

  async load(sessionId: string): Promise<TaskBoardData | null> {
    // 从磁盘加载任务看板
  }
}
```

##### 3.2.3 ProgressTracker

```typescript
// src/agents/task-board/progress-tracker.ts
export class ProgressTracker {
  constructor(private taskBoard: TaskBoard) {}

  async initialize(
    mainTask: MainTask,
    subTasks: SubTask[]
  ): Promise<TaskBoard> {
    // 初始化任务看板
  }

  async updateSubTaskStatus(
    subTaskId: string,
    status: SubTaskStatus,
    progress?: string
  ): Promise<void> {
    // 更新子任务状态并持久化
  }

  async createCheckpoint(
    summary: string,
    decisions: string[],
    openQuestions: string[]
  ): Promise<void> {
    // 创建检查点
  }
}
```

### 4. 执行层 (Execution Layer)

#### 4.1 职责

- **工具执行**：执行具体的工具调用
- **技能执行**：执行技能调用
- **结果返回**：返回执行结果或错误信息

#### 4.2 核心组件

##### 4.2.1 ToolExecutor

```typescript
// src/agents/execution/tool-executor.ts
export class ToolExecutor {
  constructor(
    private piAgent: PiAgent
  ) {}

  async execute(task: Task): Promise<unknown> {
    // 使用 Pi Agent 的工具系统执行
    const toolName = task.parameters.toolName;
    const toolArgs = task.parameters.toolArgs;
    
    return this.piAgent.callTool(toolName, toolArgs);
  }
}
```

##### 4.2.2 SkillExecutor

```typescript
// src/agents/execution/skill-executor.ts
export class SkillExecutor {
  constructor(
    private skillRegistry: SkillRegistry
  ) {}

  async execute(task: {
    skillName: string;
    parameters: Record<string, unknown>;
  }): Promise<unknown> {
    // 从技能注册表获取技能并执行
    const skill = this.skillRegistry.get(task.skillName);
    
    if (!skill) {
      throw new Error(`Skill not found: ${task.skillName}`);
    }
    
    return skill.execute(task.parameters);
  }
}
```

## 系统集成

### 1. 多层协调器 (MultiLayerCoordinator)

```typescript
// src/agents/multi-layer/coordinator.ts
export class MultiLayerCoordinator {
  constructor(
    private virtualWorldAgent: VirtualWorldAgent | null,
    private butlerAgent: ButlerAgent | null,
    private toolExecutor: ToolExecutor | null,
    private skillExecutor: SkillExecutor | null,
    config?: CoordinatorConfig
  ) {}

  async handleMessage(
    message: LayerMessage
  ): Promise<LayerResponse> {
    // 1. 确定目标层次
    const targetLayer = message.targetLayer || this.determineLayer(message);

    // 2. 切换到目标层次（如果需要）
    if (targetLayer !== this.currentLayer) {
      await this.switchLayer(targetLayer);
    }

    // 3. 在当前层次处理消息
    const response = await this.processInCurrentLayer(message);

    // 4. 检查是否需要切换层次
    const switchInfo = this.checkLayerSwitch(response);

    return {
      content: response,
      currentLayer: this.currentLayer,
      needsSwitch: switchInfo.needsSwitch,
      targetLayer: switchInfo.targetLayer,
      switchReason: switchInfo.switchReason,
    };
  }

  private determineLayer(message: LayerMessage): AgentLayer {
    const content = message.content.toLowerCase();

    // 检查是否包含技术操作关键词
    const technicalKeywords = [
      "写入文件", "读取文件", "执行命令", "搜索",
      "创建文件", "删除文件", "修改文件"
    ];

    const hasTechnicalKeyword = technicalKeywords.some((keyword) =>
      content.includes(keyword.toLowerCase())
    );

    if (hasTechnicalKeyword) {
      return this.butlerAgent ? "butler" : "execution";
    }

    // 检查是否是角色扮演对话
    const rolePlayKeywords = ["聊天", "对话", "陪我", "讲故事"];

    const hasRolePlayKeyword = rolePlayKeywords.some((keyword) =>
      content.includes(keyword)
    );

    if (hasRolePlayKeyword && this.virtualWorldAgent) {
      return "virtual-world";
    }

    // 默认使用当前层次
    return this.currentLayer;
  }
}
```

### 2. System Prompt 生成

```typescript
// src/agents/pi-embedded-runner/system-prompt.ts
export async function buildEmbeddedSystemPrompt(params: {
  // ... 现有参数
  agentLayer?: AgentLayer;
  characterName?: string;
  characterBasePath?: string;
}): Promise<string> {
  const layer = params.agentLayer || 'execution';
  
  // 加载角色配置（如果提供了 characterName）
  let characterPrompt: string | undefined;
  if (params.characterName) {
    try {
      const basePath = params.characterBasePath || params.workspaceDir;
      const config = await loadCharacterConfig(params.characterName, basePath);
      const profile = await loadCharacterProfile(params.characterName, basePath);
      characterPrompt = generateSystemPrompt({
        config,
        profile,
        currentDate: new Date().toLocaleDateString("zh-CN"),
      });
    } catch (error) {
      log.warn(`Failed to load character ${params.characterName}:`, error);
    }
  }

  // 合并角色 System Prompt 到 extraSystemPrompt
  const effectiveExtraSystemPrompt = characterPrompt
    ? (params.extraSystemPrompt ? `${characterPrompt}\n\n${params.extraSystemPrompt}` : characterPrompt)
    : params.extraSystemPrompt;

  // 虚拟世界层：只包含角色设定
  if (layer === 'virtual-world') {
    return buildAgentSystemPrompt({
      ...params,
      extraSystemPrompt: effectiveExtraSystemPrompt,
      toolNames: [], // 不包含工具
      toolSummaries: {}, // 不包含工具摘要
    });
  }
  
  // 管家层：包含任务委托提示词
  if (layer === 'butler') {
    const basePrompt = buildAgentSystemPrompt({
      ...params,
      extraSystemPrompt: effectiveExtraSystemPrompt,
      toolNames: [], // 管家层不直接调用工具
      toolSummaries: {},
    });
    
    // 添加任务委托相关提示词
    const delegationPrompt = `
## 任务委托能力

你可以调用以下能力：
- delegateTask(): 委托任务给底层执行系统
- callSkill(): 调用独立技能（记忆检索、知识查询等）
- manageReminder(): 管理提醒事项（Lina 独有）

注意：你不直接执行工具调用，而是委托给底层系统。`;
    
    return basePrompt + delegationPrompt;
  }
  
  // 执行层：包含完整的工具使用提示词（默认行为）
  return buildAgentSystemPrompt({
    ...params,
    extraSystemPrompt: effectiveExtraSystemPrompt,
    toolNames: params.tools.map((tool) => tool.name),
    toolSummaries: buildToolSummaryMap(params.tools),
  });
}
```

### 3. 记忆系统集成

记忆系统通过 `MemoryService` 集成到管家层：

```typescript
// src/agents/memory/service.ts
export class MemoryService implements IMemoryService {
  async retrieve(
    request: MemoryRetrievalRequest
  ): Promise<MemoryRetrievalResult> {
    // 检索相关记忆
  }

  async archive(
    request: MemoryArchivalRequest
  ): Promise<MemoryArchivalResult> {
    // 归档会话总结
  }
}
```

### 4. 任务分解系统集成

任务分解系统通过 `TaskBoard` 和 `Orchestrator` 集成到任务调度层：

```typescript
// 在管家层中集成任务分解
const orchestrator = new Orchestrator(
  taskBoard,
  taskDecomposer,
  executor,
  progressTracker,
  failureHandler
);

// 委托任务
const response = await orchestrator.delegate({
  taskId: `task-${Date.now()}`,
  taskType: 'complex',
  description: intent.description,
  parameters: intent.parameters
});
```

## 数据流设计

### 1. 完整消息流程

```
用户消息
  ↓
MultiLayerCoordinator.determineLayer()
  ↓
[虚拟世界层] VirtualWorldAgent.handleMessage()
  ├─ 角色扮演对话
  └─ 检测技术操作 → 转发给管家层
  ↓
[管家层] ButlerAgent.handleMessage()
  ├─ beforeConversation() → MemoryService.retrieve()
  ├─ understandIntent()
  ├─ handleTask() → TaskDelegator.delegateTask()
  ├─ handleReminder() → ReminderManager (Lina 独有)
  └─ afterConversation() → MemoryService.archive()
  ↓
[任务调度层] Orchestrator.delegate()
  ├─ TaskDecomposer.decompose()
  ├─ ProgressTracker.initialize()
  ├─ Executor.execute() (循环执行子任务)
  ├─ ProgressTracker.updateSubTaskStatus()
  └─ FailureHandler.handleFailure() (如果失败)
  ↓
[执行层] ToolExecutor.execute() / SkillExecutor.execute()
  ├─ PiAgent.callTool()
  └─ SkillRegistry.execute()
  ↓
结果返回给用户
```

### 2. 记忆系统数据流

```
对话前：
用户消息 → ButlerAgent.beforeConversation()
  → MemoryService.retrieve()
    → MemoryIndexManager.search()
      → 格式化上下文
        → 注入到 ConversationContext

对话后：
对话结束 → ButlerAgent.afterConversation()
  → generateSessionSummary()
    → MemoryService.archive()
      → 写入文件
        → 触发索引更新
```

### 3. 任务分解数据流

```
任务委托 → Orchestrator.delegate()
  → TaskDecomposer.decompose()
    → LLM 分析任务
      → 生成子任务列表
        → ProgressTracker.initialize()
          → TaskBoard.persist()
            → 执行子任务
              → ProgressTracker.updateSubTaskStatus()
                → TaskBoard.persist()
```

## 配置设计

### 1. 多层架构配置

```json
{
  "agents": {
    "defaults": {
      "layer": "butler",
      "character": "lina",
      "characterBasePath": ".",
      "multiLayer": {
        "enabled": true,
        "autoSwitch": true,
        "defaultLayer": "butler"
      }
    }
  }
}
```

### 2. 记忆系统配置

```json
{
  "agents": {
    "defaults": {
      "memory": {
        "enabled": true,
        "retrieval": {
          "maxResults": 5,
          "minScore": 0.7,
          "sources": ["memory", "sessions"],
          "timeoutMs": 5000
        },
        "archival": {
          "strategy": "threshold",
          "path": "memory/sessions",
          "format": "markdown",
          "frequency": 5
        }
      }
    }
  }
}
```

### 3. 任务分解配置

```json
{
  "agents": {
    "defaults": {
      "taskDecomposition": {
        "enabled": true,
        "autoDecompose": true,
        "minComplexity": 200,
        "maxSubtasks": 8,
        "enableConcurrentExecution": false,
        "enableAutoRetry": false
      }
    }
  }
}
```

## 实施路径

### 阶段 1：基础设施（第 1-2 周）

1. 创建目录结构
2. 定义接口和类型
3. 实现层次判断逻辑
4. 扩展 System Prompt 构建器

### 阶段 2：执行层封装（第 3 周）

1. 实现 ToolExecutor
2. 实现 SkillExecutor
3. 实现 Executor
4. 编写单元测试

### 阶段 3：任务调度层适配（第 4-5 周）

1. 实现 TaskDelegator
2. 扩展 Orchestrator
3. 扩展 Executor
4. 编写集成测试

### 阶段 4：管家层实现（第 6-7 周）

1. 实现 ButlerAgent
2. 实现 MemoryService 集成
3. 实现 ReminderManager (Lina)
4. 实现对话前后任务调度
5. 集成到 Pi Agent

### 阶段 5：虚拟世界层实现（第 8 周）

1. 实现 VirtualWorldAgent
2. 定义角色配置
3. 实现 System Prompt 构建
4. 集成到 Pi Agent

### 阶段 6：Lina 人格化集成（第 9 周）

1. 集成角色配置加载
2. 集成 System Prompt 生成
3. 集成提醒管理功能
4. 编写端到端测试

### 阶段 7：可观测性和监控（第 10 周）

1. 实现任务流转日志
2. 实现性能监控
3. 实现可视化
4. 编写监控测试

### 阶段 8：文档和培训（第 11 周）

1. 编写用户文档
2. 编写开发者文档
3. 编写迁移指南
4. 准备培训材料

### 阶段 9：灰度发布和优化（第 12 周）

1. 灰度发布
2. 问题修复
3. 全量发布
4. 回顾和总结

## 总结

本设计文档整合了 Clawdbot 的所有功能模块，设计了一个统一、完整、有机融合的多层架构。该架构：

1. **统一架构**：所有功能都在统一的多层架构下运行
2. **职责清晰**：每一层有明确的职责，不越界
3. **有机融合**：各功能模块无缝集成，不重复实现
4. **配置驱动**：通过配置文件控制行为，易于扩展
5. **渐进式迁移**：支持逐步迁移，保持向后兼容

---

**版本**：v1.0  
**创建时间**：2025-02-01  
**作者**：Kiro AI Assistant  
**状态**：设计完成，待评审

