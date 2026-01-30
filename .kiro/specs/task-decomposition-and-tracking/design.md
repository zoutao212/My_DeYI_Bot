# 设计文档：任务分解、展示和总结机制

## 概述

本设计文档描述了 Clawdbot 的任务分解、展示和总结机制的技术实现。该机制通过引入结构化的任务看板（Task Board）、任务分解器（Task Decomposer）和进度跟踪器（Progress Tracker），将复杂任务的执行过程从黑盒变为透明可控的白盒。

### 核心设计理念

1. **透明性优先**：用户应该清楚地知道系统会做什么、正在做什么、已经做了什么
2. **可恢复性**：任务状态持久化到磁盘，支持会话中断后快速恢复
3. **渐进式执行**：一次只执行一个子任务，完成后再继续下一个
4. **失败友好**：失败不是终点，而是学习和改进的机会
5. **自我改进**：从任务执行中提炼经验，固化为规则和技能

### 与现有系统的集成

本机制将集成到 Clawdbot 的 Agent 系统中，作为一个可选的任务执行模式。当用户提交复杂任务时，Agent 可以选择启用任务分解模式，将任务拆解成子任务并使用任务看板跟踪进度。

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

### 组件职责

1. **Agent Orchestrator**：
   - 接收用户请求并判断任务复杂度
   - 决定是否启用任务分解模式
   - 协调 Task Decomposer、Task Executor 和 Progress Tracker
   - 处理用户交互（确认、重试、跳过等）

2. **Task Decomposer**：
   - 分析任务并拆解成子任务
   - 识别子任务之间的依赖关系
   - 生成任务看板的初始结构
   - 支持任务重新拆解

3. **Task Executor**：
   - 执行单个子任务
   - 捕获执行结果和错误
   - 记录任务产出
   - 支持并发执行

4. **Progress Tracker**：
   - 跟踪任务和子任务的状态变化
   - 更新任务看板
   - 持久化任务状态到磁盘
   - 生成检查点和总结

5. **Task Board**：
   - 存储任务结构和状态
   - 提供查询和更新接口
   - 支持序列化和反序列化
   - 渲染为 JSON 和 Markdown 格式

## 组件和接口

### Task Decomposer

#### 接口

```typescript
interface TaskDecomposer {
  /**
   * 分析任务并判断是否需要拆解
   * @param task 用户提交的任务描述
   * @returns 是否需要拆解
   */
  shouldDecompose(task: string): Promise<boolean>;

  /**
   * 将任务拆解成子任务
   * @param task 用户提交的任务描述
   * @param context 当前上下文（代码库、历史对话等）
   * @returns 子任务列表
   */
  decompose(task: string, context: DecompositionContext): Promise<SubTask[]>;

  /**
   * 根据用户反馈重新拆解任务
   * @param task 原始任务描述
   * @param feedback 用户反馈
   * @param previousDecomposition 之前的拆解结果
   * @returns 新的子任务列表
   */
  redecompose(
    task: string,
    feedback: string,
    previousDecomposition: SubTask[]
  ): Promise<SubTask[]>;
}

interface DecompositionContext {
  codebase: string; // 代码库路径
  recentMessages: Message[]; // 最近的对话历史
  projectMemory: ProjectMemory; // 项目记忆
}
```

#### 实现策略

1. **复杂度判断**：
   - 任务描述长度 > 200 字符
   - 包含多个动词（"创建"、"修改"、"测试"等）
   - 涉及多个文件或模块
   - 用户明确要求拆解

2. **拆解算法**：
   - 使用 LLM 分析任务描述
   - 识别任务的主要步骤和依赖关系
   - 生成 2-8 个子任务（过多会增加管理成本）
   - 每个子任务包含：ID、标题、描述、依赖、预期产出

3. **依赖分析**：
   - 识别子任务之间的顺序依赖（A 必须在 B 之前完成）
   - 识别可并发执行的子任务（A 和 B 可以同时执行）
   - 生成依赖图

### Task Executor

#### 接口

```typescript
interface TaskExecutor {
  /**
   * 执行单个子任务
   * @param subTask 要执行的子任务
   * @param context 执行上下文
   * @returns 执行结果
   */
  execute(subTask: SubTask, context: ExecutionContext): Promise<ExecutionResult>;

  /**
   * 并发执行多个子任务
   * @param subTasks 要执行的子任务列表
   * @param context 执行上下文
   * @returns 执行结果列表
   */
  executeConcurrent(
    subTasks: SubTask[],
    context: ExecutionContext
  ): Promise<ExecutionResult[]>;

  /**
   * 取消正在执行的子任务
   * @param subTaskId 子任务 ID
   */
  cancel(subTaskId: string): Promise<void>;
}

interface ExecutionContext {
  sessionId: string; // 会话 ID
  taskBoard: TaskBoard; // 任务看板
  tools: AgentTools; // Agent 工具集
}

interface ExecutionResult {
  subTaskId: string;
  status: "completed" | "failed" | "cancelled";
  outputs: string[]; // 产出列表（文件路径、函数名等）
  error?: Error; // 错误信息（如果失败）
  duration: number; // 执行时长（毫秒）
}
```

#### 实现策略

1. **单任务执行**：
   - 调用 Agent 的工具集执行子任务
   - 捕获所有工具调用和结果
   - 记录执行日志
   - 提取产出（修改的文件、创建的函数等）

2. **并发执行**：
   - 使用 Promise.all 并发执行多个子任务
   - 每个子任务在独立的执行上下文中运行
   - 如果任一子任务失败，暂停其他子任务
   - 等待用户决策后再继续

3. **错误处理**：
   - 捕获所有异常并转换为 ExecutionResult
   - 记录详细的错误堆栈和上下文
   - 不自动重试（由 Failure Handler 决定）

### Progress Tracker

#### 接口

```typescript
interface ProgressTracker {
  /**
   * 初始化任务看板
   * @param mainTask 主任务
   * @param subTasks 子任务列表
   * @returns 初始化的任务看板
   */
  initialize(mainTask: MainTask, subTasks: SubTask[]): Promise<TaskBoard>;

  /**
   * 更新子任务状态
   * @param subTaskId 子任务 ID
   * @param status 新状态
   * @param progress 进度描述
   */
  updateSubTaskStatus(
    subTaskId: string,
    status: SubTaskStatus,
    progress?: string
  ): Promise<void>;

  /**
   * 更新当前焦点
   * @param subTaskId 当前焦点的子任务 ID
   * @param reasoning 推理摘要
   * @param nextAction 下一步行动
   */
  updateCurrentFocus(
    subTaskId: string,
    reasoning: string,
    nextAction: string
  ): Promise<void>;

  /**
   * 创建检查点
   * @param summary 摘要
   * @param decisions 关键决策
   * @param openQuestions 未决问题
   */
  createCheckpoint(
    summary: string,
    decisions: string[],
    openQuestions: string[]
  ): Promise<void>;

  /**
   * 添加风险或阻塞
   * @param description 描述
   * @param mitigation 缓解措施
   */
  addRisk(description: string, mitigation: string): Promise<void>;

  /**
   * 添加上下文锚点
   * @param type 类型（code_location 或 command）
   * @param value 值
   */
  addContextAnchor(type: "code_location" | "command", value: string): Promise<void>;

  /**
   * 获取当前任务看板
   * @returns 任务看板
   */
  getTaskBoard(): Promise<TaskBoard>;

  /**
   * 持久化任务看板到磁盘
   */
  persist(): Promise<void>;

  /**
   * 从磁盘加载任务看板
   * @param sessionId 会话 ID
   * @returns 任务看板
   */
  load(sessionId: string): Promise<TaskBoard | null>;
}
```

#### 实现策略

1. **状态管理**：
   - 在内存中维护任务看板的当前状态
   - 每次状态变化后立即持久化到磁盘
   - 使用事务机制确保数据一致性

2. **持久化**：
   - 保存到 `.clawdbot/tasks/{sessionId}/TASK_BOARD.json`
   - 同时生成 `.clawdbot/tasks/{sessionId}/TASK_BOARD.md`
   - 使用原子写入避免数据损坏

3. **上下文锚点管理**：
   - 最多保留 10 个最相关的锚点
   - 按时间倒序排列
   - 自动去重

### Failure Handler

#### 接口

```typescript
interface FailureHandler {
  /**
   * 处理子任务失败
   * @param subTask 失败的子任务
   * @param error 错误信息
   * @returns 用户决策
   */
  handleFailure(
    subTask: SubTask,
    error: Error
  ): Promise<FailureDecision>;

  /**
   * 分析失败原因并生成总结
   * @param subTask 失败的子任务
   * @param error 错误信息
   * @returns 失败总结
   */
  analyzeFailure(subTask: SubTask, error: Error): Promise<FailureSummary>;

  /**
   * 建议将失败经验固化为规则
   * @param failureSummary 失败总结
   * @returns 是否建议固化
   */
  suggestRuleCreation(failureSummary: FailureSummary): Promise<boolean>;
}

interface FailureDecision {
  action: "retry" | "skip" | "modify" | "abort";
  modifiedTask?: SubTask; // 如果 action 是 "modify"
}

interface FailureSummary {
  subTaskId: string;
  errorType: string;
  rootCause: string;
  context: string;
  suggestedFix: string;
}
```

#### 实现策略

1. **失败分析**：
   - 解析错误堆栈和消息
   - 识别错误类型（语法错误、运行时错误、工具调用失败等）
   - 分析根本原因（配置错误、依赖缺失、逻辑错误等）
   - 生成建议的修复方案

2. **用户交互**：
   - 展示失败原因和建议的修复方案
   - 提供选项：重试、跳过、修改任务、中止
   - 如果用户选择修改，允许编辑子任务描述
   - 记录用户决策到任务看板

3. **经验固化**：
   - 识别可复用的失败模式
   - 建议将经验添加到 lessons-learned
   - 如果用户同意，调用 maintain-rules Power

## 数据模型

### TaskBoard

```typescript
interface TaskBoard {
  sessionId: string;
  mainTask: MainTask;
  subTasks: SubTask[];
  currentFocus: CurrentFocus;
  checkpoints: Checkpoint[];
  risksAndBlocks: Risk[];
  contextAnchors: ContextAnchors;
  lastUpdated: string; // ISO 8601 时间戳
  version: string; // 版本号
}

interface MainTask {
  title: string;
  objective: string;
  status: "active" | "paused" | "completed" | "blocked";
  progress: string; // 例如："30%" 或 "已完成需求澄清"
}

interface SubTask {
  id: string; // 例如："T1", "T2"
  title: string;
  description: string;
  status: "pending" | "active" | "completed" | "blocked" | "skipped";
  progress: string;
  dependencies: string[]; // 依赖的子任务 ID 列表
  outputs: string[]; // 产出列表
  notes: string; // 结论级要点
}

interface CurrentFocus {
  taskId: string; // 当前焦点的子任务 ID
  reasoningSummary: string; // 结论级摘要（不是推理链）
  nextAction: string; // 可执行的下一步行动
}

interface Checkpoint {
  timestamp: string; // ISO 8601 时间戳
  summary: string; // 本阶段结论摘要
  decisions: string[]; // 已确认的关键决策
  openQuestions: string[]; // 未决问题
}

interface Risk {
  description: string;
  mitigation: string;
}

interface ContextAnchors {
  codeLocations: string[]; // 例如："src/agents/pi-tools.ts::readFile"
  commands: string[]; // 例如："pnpm build"
}

type SubTaskStatus = "pending" | "active" | "completed" | "blocked" | "skipped";
```

### 持久化格式

#### JSON 格式（TASK_BOARD.json）

```json
{
  "sessionId": "session_20260130_123456",
  "mainTask": {
    "title": "创建任务分解和跟踪机制",
    "objective": "实现任务自动拆解、进度可视化和失败处理",
    "status": "active",
    "progress": "40%"
  },
  "subTasks": [
    {
      "id": "T1",
      "title": "设计数据模型",
      "description": "定义 TaskBoard、SubTask 等数据结构",
      "status": "completed",
      "progress": "100%",
      "dependencies": [],
      "outputs": ["design.md"],
      "notes": "已完成数据模型设计"
    },
    {
      "id": "T2",
      "title": "实现 Task Decomposer",
      "description": "实现任务拆解逻辑",
      "status": "active",
      "progress": "50%",
      "dependencies": ["T1"],
      "outputs": [],
      "notes": "正在实现拆解算法"
    }
  ],
  "currentFocus": {
    "taskId": "T2",
    "reasoningSummary": "已完成数据模型设计，现在实现任务拆解器",
    "nextAction": "实现 TaskDecomposer.decompose 方法"
  },
  "checkpoints": [
    {
      "timestamp": "2026-01-30T10:00:00Z",
      "summary": "完成数据模型设计",
      "decisions": ["使用 TypeScript 接口定义数据结构"],
      "openQuestions": []
    }
  ],
  "risksAndBlocks": [],
  "contextAnchors": {
    "codeLocations": ["src/agents/task-decomposer.ts"],
    "commands": ["pnpm build"]
  },
  "lastUpdated": "2026-01-30T10:30:00Z",
  "version": "v1.0.0"
}
```

#### Markdown 格式（TASK_BOARD.md）

```markdown
# 任务看板

**会话 ID**: session_20260130_123456  
**最后更新**: 2026-01-30T10:30:00Z  
**版本**: v1.0.0

## 主任务

**标题**: 创建任务分解和跟踪机制  
**目标**: 实现任务自动拆解、进度可视化和失败处理  
**状态**: 🟢 进行中  
**进度**: 40%

## 子任务

### T1: 设计数据模型 ✅

- **描述**: 定义 TaskBoard、SubTask 等数据结构
- **状态**: 已完成
- **进度**: 100%
- **依赖**: 无
- **产出**: design.md
- **备注**: 已完成数据模型设计

### T2: 实现 Task Decomposer 🔄

- **描述**: 实现任务拆解逻辑
- **状态**: 进行中
- **进度**: 50%
- **依赖**: T1
- **产出**: 无
- **备注**: 正在实现拆解算法

## 当前焦点

**任务**: T2  
**推理摘要**: 已完成数据模型设计，现在实现任务拆解器  
**下一步行动**: 实现 TaskDecomposer.decompose 方法

## 检查点

### 2026-01-30T10:00:00Z

**摘要**: 完成数据模型设计  
**关键决策**:
- 使用 TypeScript 接口定义数据结构

**未决问题**: 无

## 风险和阻塞

无

## 上下文锚点

**代码位置**:
- src/agents/task-decomposer.ts

**命令**:
- pnpm build
```

## 错误处理

### 错误类型

1. **任务拆解失败**：
   - LLM 无法理解任务描述
   - 任务过于简单不需要拆解
   - 任务过于复杂无法拆解

2. **子任务执行失败**：
   - 工具调用失败
   - 代码编译错误
   - 运行时错误

3. **持久化失败**：
   - 磁盘空间不足
   - 文件权限错误
   - 数据序列化错误

4. **恢复失败**：
   - 任务看板文件损坏
   - 版本不兼容
   - 会话 ID 不存在

### 错误处理策略

1. **任务拆解失败**：
   - 向用户展示错误原因
   - 提供手动拆解选项
   - 允许用户提供更多上下文

2. **子任务执行失败**：
   - 调用 Failure Handler 分析失败原因
   - 向用户展示失败总结和建议
   - 提供重试、跳过、修改、中止选项

3. **持久化失败**：
   - 记录错误日志
   - 尝试备份到临时位置
   - 通知用户并建议手动保存

4. **恢复失败**：
   - 尝试从备份恢复
   - 如果无法恢复，提示用户重新开始
   - 记录错误日志供调试

### 错误恢复

1. **自动重试**：
   - 对于临时性错误（网络超时、资源暂时不可用），自动重试最多 3 次
   - 使用指数退避策略（1s, 2s, 4s）

2. **降级处理**：
   - 如果任务看板持久化失败，继续执行但在内存中保留状态
   - 如果 Markdown 渲染失败，只保存 JSON 格式

3. **用户介入**：
   - 对于需要用户决策的错误，暂停执行并等待用户输入
   - 提供清晰的错误信息和可选的操作

## 测试策略

### 单元测试

1. **Task Decomposer 测试**：
   - 测试复杂度判断逻辑
   - 测试任务拆解算法
   - 测试依赖关系识别
   - 测试重新拆解功能

2. **Task Executor 测试**：
   - 测试单任务执行
   - 测试并发执行
   - 测试错误捕获
   - 测试取消功能

3. **Progress Tracker 测试**：
   - 测试状态更新
   - 测试持久化和加载
   - 测试检查点创建
   - 测试上下文锚点管理

4. **Failure Handler 测试**：
   - 测试失败分析
   - 测试用户交互
   - 测试经验固化建议

### 集成测试

1. **端到端测试**：
   - 测试完整的任务分解和执行流程
   - 测试会话中断和恢复
   - 测试并发执行
   - 测试失败处理和重试

2. **持久化测试**：
   - 测试任务看板保存和加载
   - 测试 JSON 和 Markdown 格式一致性
   - 测试数据损坏恢复

3. **用户交互测试**：
   - 测试任务拆解确认
   - 测试失败处理决策
   - 测试任务恢复

### 性能测试

1. **大任务测试**：
   - 测试 8 个子任务的执行性能
   - 测试并发执行的性能
   - 测试持久化的性能

2. **长时间运行测试**：
   - 测试任务看板在长时间运行后的稳定性
   - 测试内存使用情况
   - 测试文件系统占用

### 用户验收测试

1. **可用性测试**：
   - 用户能否理解任务拆解结果
   - 用户能否理解任务看板
   - 用户能否顺利处理失败

2. **恢复测试**：
   - 用户能否在会话中断后快速恢复任务
   - 用户能否理解恢复后的状态

3. **自我改进测试**：
   - 用户能否理解经验固化建议
   - 用户能否顺利固化经验


## 正确性属性

*属性（Property）是一个特征或行为，应该在系统的所有有效执行中保持为真——本质上是关于系统应该做什么的形式化陈述。属性是人类可读规范和机器可验证正确性保证之间的桥梁。*

### 属性 1：任务复杂度判断一致性

*对于任何*任务描述，如果任务包含多个动词、涉及多个文件或长度超过 200 字符，则 shouldDecompose 应该返回 true

**验证需求**: 1.1

### 属性 2：任务拆解输出格式正确性

*对于任何*需要拆解的任务，decompose 方法返回的子任务数量应该在 2-8 之间，且每个子任务都包含 id、title、description、status、dependencies 和 outputs 字段

**验证需求**: 1.2

### 属性 3：任务持久化 Round-Trip 一致性

*对于任何*任务看板，保存到磁盘后再加载，应该得到与原始任务看板等价的数据结构

**验证需求**: 1.4, 3.4, 3.5

### 属性 4：任务重新拆解产生不同结果

*对于任何*任务和用户反馈，redecompose 方法返回的新子任务列表应该与原始子任务列表不同

**验证需求**: 1.5

### 属性 5：任务看板数据完整性

*对于任何*初始化的任务看板，它应该包含 mainTask、subTasks、currentFocus、checkpoints、risksAndBlocks 和 contextAnchors 字段，且 mainTask 包含 title、objective 和 status

**验证需求**: 2.1, 2.2, 2.3, 2.5

### 属性 6：子任务状态更新正确性

*对于任何*子任务和任何有效的状态值（pending、active、completed、blocked、skipped），调用 updateSubTaskStatus 后，该子任务的状态应该被更新为指定的值

**验证需求**: 3.1, 3.2, 3.3

### 属性 7：任务看板实时更新响应性

*对于任何*任务看板和任何状态变化，调用 updateSubTaskStatus 或 updateCurrentFocus 后，getTaskBoard 应该返回包含最新状态的任务看板

**验证需求**: 2.4

### 属性 8：失败处理捕获所有错误

*对于任何*子任务执行失败，Failure_Handler 应该捕获错误并返回包含 errorType、rootCause 和 suggestedFix 的 FailureSummary

**验证需求**: 4.1, 4.2

### 属性 9：失败处理决策有效性

*对于任何*失败的子任务和用户决策（retry、skip、modify、abort），系统应该根据决策执行相应的操作（重新执行、标记为 skipped、允许修改、中止任务）

**验证需求**: 4.3, 4.4, 4.5

### 属性 10：检查点创建完整性

*对于任何*子任务完成事件，系统应该创建一个包含 timestamp、summary 和 decisions 字段的 Checkpoint

**验证需求**: 5.1

### 属性 11：焦点切换更新正确性

*对于任何*焦点切换，updateCurrentFocus 应该更新 currentFocus 的 taskId、reasoningSummary 和 nextAction 字段

**验证需求**: 5.2

### 属性 12：风险记录完整性

*对于任何*风险或阻塞，addRisk 应该将包含 description 和 mitigation 的 Risk 对象添加到 risksAndBlocks 列表

**验证需求**: 5.3

### 属性 13：任务总结生成完整性

*对于任何*所有子任务都完成的任务看板，系统应该生成包含所有子任务产出、所有检查点和所有关键决策的任务总结

**验证需求**: 5.4

### 属性 14：经验固化建议触发

*对于任何*任务总结，如果识别到可复用的模式，系统应该建议用户将其固化为规则或技能

**验证需求**: 5.5, 9.2

### 属性 15：并发任务识别正确性

*对于任何*一组子任务，如果它们之间没有依赖关系（dependencies 为空或不相互引用），Task_Executor 应该识别它们为可并发执行

**验证需求**: 6.1

### 属性 16：并发执行同时启动

*对于任何*一组可并发执行的子任务，executeConcurrent 应该同时启动所有子任务的执行

**验证需求**: 6.3

### 属性 17：并发任务状态展示

*对于任何*并发执行中的任务看板，所有正在执行的子任务的状态都应该是 "active"

**验证需求**: 6.4

### 属性 18：并发失败暂停其他任务

*对于任何*并发执行中的任务组，如果其中一个子任务失败，其他子任务应该被暂停（状态不再更新）

**验证需求**: 6.5

### 属性 19：上下文锚点记录和查询

*对于任何*类型的上下文锚点（code_location 或 command），调用 addContextAnchor 后，该锚点应该出现在 contextAnchors 中

**验证需求**: 7.1, 7.2, 7.4

### 属性 20：上下文锚点数量限制

*对于任何*任务看板，如果添加超过 10 个上下文锚点，contextAnchors 应该只保留最近的 10 个

**验证需求**: 7.5

### 属性 21：上下文锚点恢复展示

*对于任何*从持久化存储加载的任务看板，contextAnchors 应该包含所有保存时的锚点

**验证需求**: 7.3

### 属性 22：双格式保存一致性

*对于任何*任务看板，调用 persist 后，文件系统中应该同时存在 TASK_BOARD.json 和 TASK_BOARD.md 文件

**验证需求**: 8.1, 8.4

### 属性 23：JSON 格式符合 Schema

*对于任何*保存的 TASK_BOARD.json 文件，其内容应该符合 TaskBoard 接口定义（包含所有必需字段且类型正确）

**验证需求**: 8.3

### 属性 24：Markdown 格式包含必需元素

*对于任何*保存的 TASK_BOARD.md 文件，其内容应该包含主任务标题、子任务列表、当前焦点和检查点等必需元素

**验证需求**: 8.2, 8.5

### 属性 25：可复用模式识别

*对于任何*完成的任务，如果任务执行过程中出现了重复的操作模式（例如，相同的工具调用序列出现 3 次以上），系统应该识别出该模式

**验证需求**: 9.1

### 属性 26：经验固化调用 Power

*对于任何*用户同意固化的经验，系统应该调用 maintain-rules Power 并传递正确的参数

**验证需求**: 9.3

### 属性 27：失败经验建议添加到 Lessons Learned

*对于任何*任务失败，系统应该分析失败原因并建议将其添加到 lessons-learned

**验证需求**: 9.4

### 属性 28：经验固化记录到总结

*对于任何*完成的经验固化，任务总结中应该包含固化的规则或技能的引用

**验证需求**: 9.5

### 属性 29：任务恢复触发加载

*对于任何*包含"继续任务"或"恢复任务"关键词的用户输入，系统应该调用 load 方法加载最新的任务看板

**验证需求**: 10.1

### 属性 30：任务恢复展示必需信息

*对于任何*加载的任务看板，系统应该展示 mainTask.title、currentFocus.taskId 和 currentFocus.nextAction

**验证需求**: 10.2

### 属性 31：明确下一步行动直接执行

*对于任何*恢复的任务看板，如果 currentFocus.nextAction 不为空且格式正确，Task_Executor 应该直接执行该行动

**验证需求**: 10.3

### 属性 32：不明确下一步行动添加风险

*对于任何*恢复的任务看板，如果 currentFocus.nextAction 为空或格式不正确，系统应该添加一个 Risk 到 risksAndBlocks 并请求用户澄清

**验证需求**: 10.4

### 属性 33：恢复后持续跟踪

*对于任何*恢复的任务，执行任何操作后，任务看板应该被正确更新并持久化

**验证需求**: 10.5
