# Clawdbot 统一多层架构图

## 完整架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          用户接口层                                       │
│              (Telegram / Discord / CLI / Web / Signal)                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    MultiLayerCoordinator                                 │
│                    (多层协调器)                                           │
│  - 消息路由                                                              │
│  - 层次切换                                                              │
│  - 上下文传递                                                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│ 虚拟世界层    │         │   管家层      │         │   执行层      │
│ Virtual World │         │    Butler     │         │  Execution    │
│    Layer      │         │    Layer      │         │    Layer      │
└───────────────┘         └───────────────┘         └───────────────┘
        │                           │                           │
        │                           │                           │
        │                           ▼                           │
        │              ┌──────────────────────────┐             │
        │              │   任务调度层             │             │
        │              │ Task Orchestration       │             │
        │              │    Layer                 │             │
        │              └──────────────────────────┘             │
        │                           │                           │
        │                           │                           │
        └───────────────────────────┼───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │    Pi Agent Core          │
                    │  (工具执行引擎)            │
                    └───────────────────────────┘
```

## 详细组件图

### 虚拟世界层组件

```
┌─────────────────────────────────────────────────────────┐
│               VirtualWorldAgent                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  CharacterProfile (角色配置)                      │  │
│  │  - profile.md (角色设定)                          │  │
│  │  - config.json (功能开关)                         │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  System Prompt Generator                          │  │
│  │  - 只包含角色设定                                 │  │
│  │  - 不包含工具提示词                               │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Request Forwarder                               │  │
│  │  - 检测技术操作关键词                             │  │
│  │  - 转发给管家层                                   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 管家层组件

```
┌─────────────────────────────────────────────────────────┐
│                    ButlerAgent                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Lina Personality (人格化)                       │  │
│  │  - CharacterConfig (角色配置)                     │  │
│  │  - CharacterProfile (角色档案)                   │  │
│  │  - System Prompt (人格化提示词)                   │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │TaskDelegator│  │MemoryService │  │ReminderManager│ │
│  │(任务委托)   │  │(记忆管理)    │  │(提醒管理)     │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│  ┌──────────────┐  ┌──────────────┐                   │
│  │ SkillCaller │  │IntentParser  │                   │
│  │(技能调用)   │  │(意图理解)    │                   │
│  └──────────────┘  └──────────────┘                   │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Conversation Hooks                               │  │
│  │  - beforeConversation() (记忆填充)                │  │
│  │  - afterConversation() (总结归档)                 │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 任务调度层组件

```
┌─────────────────────────────────────────────────────────┐
│                    Orchestrator                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │TaskDecomposer│  │   Executor   │  │ProgressTracker│ │
│  │(任务分解)    │  │  (任务执行)  │  │(进度跟踪)    │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│  ┌──────────────┐  ┌──────────────┐                   │
│  │FailureHandler│  │  TaskBoard  │                   │
│  │(失败处理)    │  │(任务看板)    │                   │
│  └──────────────┘  └──────────────┘                   │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌───────────────────────────┐
              │   TaskBoard Storage        │
              │   (持久化存储)              │
              │   - TASK_BOARD.json        │
              │   - TASK_BOARD.md          │
              └───────────────────────────┘
```

### 执行层组件

```
┌─────────────────────────────────────────────────────────┐
│                    Execution Layer                       │
│  ┌──────────────┐  ┌──────────────┐                   │
│  │ToolExecutor │  │SkillExecutor │                   │
│  │(工具执行)    │  │(技能执行)    │                   │
│  └──────────────┘  └──────────────┘                   │
│                            │                           │
│                            ▼                           │
│              ┌───────────────────────────┐             │
│              │   Pi Agent Core           │             │
│              │   - createClawdbotTools() │             │
│              │   - Tool Registry        │             │
│              └───────────────────────────┘             │
└─────────────────────────────────────────────────────────┘
```

### 记忆系统组件

```
┌─────────────────────────────────────────────────────────┐
│                    MemoryService                        │
│  ┌──────────────┐  ┌──────────────┐                   │
│  │MemoryRetriever│ │MemoryArchiver│                   │
│  │(记忆检索)    │  │(记忆归档)    │                   │
│  └──────────────┘  └──────────────┘                   │
│                            │                           │
│        ┌───────────────────┼───────────────────┐       │
│        ▼                   ▼                   ▼       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │MemoryIndex   │  │SessionSummary│  │ContextInjector│ │
│  │Manager       │  │Generator    │  │(上下文注入)   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
│                            │                           │
│                            ▼                           │
│              ┌───────────────────────────┐             │
│              │   Memory Storage           │             │
│              │   - SQLite (索引)          │             │
│              │   - Files (会话总结)       │             │
│              └───────────────────────────┘             │
└─────────────────────────────────────────────────────────┘
```

## 数据流图

### 消息处理流程

```
用户消息
  │
  ▼
MultiLayerCoordinator.determineLayer()
  │
  ├─ [角色扮演] → VirtualWorldAgent
  │     │
  │     ├─ 纯对话 → 直接回复
  │     │
  │     └─ 技术操作 → 转发给管家层
  │
  ├─ [任务请求] → ButlerAgent
  │     │
  │     ├─ beforeConversation()
  │     │   └─ MemoryService.retrieve()
  │     │
  │     ├─ understandIntent()
  │     │
  │     ├─ handleTask()
  │     │   └─ TaskDelegator.delegateTask()
  │     │       └─ Orchestrator.delegate()
  │     │           ├─ TaskDecomposer.decompose()
  │     │           ├─ ProgressTracker.initialize()
  │     │           ├─ Executor.execute() (循环)
  │     │           └─ ProgressTracker.updateStatus()
  │     │
  │     └─ afterConversation()
  │         └─ MemoryService.archive()
  │
  └─ [直接执行] → Execution Layer
        │
        └─ ToolExecutor / SkillExecutor
            └─ Pi Agent Core
```

### 记忆系统数据流

```
对话前记忆填充：
  User Message
    │
    ▼
  ButlerAgent.beforeConversation()
    │
    ▼
  MemoryService.retrieve()
    │
    ├─ MemoryIndexManager.search()
    │   └─ 向量检索 + 关键词检索
    │
    └─ formatMemoryContext()
        │
        ▼
  ConversationContext.memoryContext
    │
    ▼
  System Prompt (注入)

对话后记忆归档：
  Conversation End
    │
    ▼
  ButlerAgent.afterConversation()
    │
    ├─ generateSessionSummary()
    │   └─ 提取任务目标、关键操作、决策
    │
    └─ MemoryService.archive()
        │
        ├─ formatSummary()
        │
        ├─ writeArchiveFile()
        │   └─ memory/sessions/{date}/{sessionId}.md
        │
        └─ triggerIndexUpdate()
            └─ MemoryIndexManager.sync()
```

### 任务分解数据流

```
任务委托：
  TaskDelegationRequest
    │
    ▼
  Orchestrator.delegate()
    │
    ├─ TaskBoard.createTask()
    │   └─ 持久化到 TASK_BOARD.json
    │
    ├─ TaskDecomposer.decompose()
    │   ├─ LLM 分析任务
    │   ├─ 识别依赖关系
    │   └─ 生成子任务列表
    │
    ├─ ProgressTracker.initialize()
    │   └─ 创建任务看板
    │
    └─ Executor.execute() (循环)
        │
        ├─ 执行子任务
        │   └─ ToolExecutor / SkillExecutor
        │
        ├─ 更新进度
        │   └─ ProgressTracker.updateSubTaskStatus()
        │
        ├─ 持久化状态
        │   └─ TaskBoard.persist()
        │
        └─ 失败处理 (如果失败)
            └─ FailureHandler.handleFailure()
```

## 系统集成点

### 1. Pi Agent 集成

```
runEmbeddedPiAgent()
  │
  ▼
runEmbeddedAttempt()
  │
  ├─ resolveAgentLayer()
  │   └─ 根据配置或 sessionKey 确定层次
  │
  ├─ buildEmbeddedSystemPrompt()
  │   ├─ 加载角色配置 (如果 characterName 存在)
  │   ├─ 生成角色 System Prompt
  │   └─ 根据层次选择性包含提示词
  │
  └─ subscribeEmbeddedPiSession()
      └─ 执行 Agent 循环
```

### 2. 配置加载

```
ClawdbotConfig
  │
  ├─ agents.defaults.layer
  │   └─ 默认层次 (virtual-world | butler | execution)
  │
  ├─ agents.defaults.character
  │   └─ 角色名称 (lina | lisi | ...)
  │
  ├─ agents.defaults.memory
  │   └─ 记忆系统配置
  │
  └─ agents.defaults.taskDecomposition
      └─ 任务分解配置
```

### 3. 角色配置加载

```
clawd/characters/{characterName}/
  │
  ├─ config.json
  │   └─ CharacterConfig
  │       ├─ name, version
  │       ├─ personality
  │       ├─ capabilities
  │       └─ system_prompt
  │
  └─ profile.md
      └─ CharacterProfile
          ├─ background
          ├─ personality
          ├─ capabilities
          └─ interaction_style
```

## 关键设计决策

### 1. 层次分离

- **虚拟世界层**：纯角色扮演，不知道技术细节
- **管家层**：理解意图，委托任务，管理记忆和提醒
- **任务调度层**：分解任务，调度执行，跟踪进度
- **执行层**：执行工具调用，返回结果

### 2. 有机融合

- **Lina = Butler 的人格化**：通过配置驱动，不重复实现
- **记忆系统**：集成到管家层，对话前后自动调用
- **任务分解**：集成到任务调度层，自动判断是否需要分解
- **角色配置**：统一通过 `clawd/characters/` 管理

### 3. 配置驱动

- **层次选择**：通过配置或 sessionKey 控制
- **角色选择**：通过 `characterName` 配置
- **功能开关**：通过配置文件控制各功能启用/禁用

### 4. 渐进式迁移

- **向后兼容**：默认使用执行层，不影响现有功能
- **逐步启用**：可以逐步启用新功能
- **配置开关**：提供配置开关控制功能启用

---

**版本**：v1.0  
**创建时间**：2025-02-01  
**作者**：Kiro AI Assistant

