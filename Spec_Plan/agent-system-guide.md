# Clawdbot Agent 统一系统 — 详细使用指南

**版本**: v2.1（Phase 1 实施完成后）
**日期**: 2026-02-06
**状态**: 6 个阶段全部实施完成 + 人格系统升级为目录制

---

## 目录

1. [系统全景](#一系统全景)
2. [核心执行管线](#二核心执行管线)
3. [六大子系统详解](#三六大子系统详解)
4. [目录制角色系统](#四目录制角色系统)
5. [模块协同运作](#五模块协同运作)
6. [配置指南](#六配置指南)
7. [顶层设计评价](#七顶层设计评价)
8. [已知限制与改进方向](#八已知限制与改进方向)
9. [文件索引](#九文件索引)

---

## 一、系统全景

### 1.1 一句话概述

Clawdbot Agent 统一系统是一个**基于 LLM 驱动的多阶段任务管线**：接收用户消息 → 注入记忆与人格 → LLM 自主分解任务 → 并行/串行执行子任务（每个子任务拥有完整工具链）→ 生成结构化交付报告 → 自动归档经验。

### 1.2 架构总览

```
用户消息
  │
  ▼
═══ Phase 0: 上下文增强 ═══（attempt.ts 入口）
  │
  ├── PersonaInjector ─── 目录制角色加载（clawd/characters/{name}/）
  │                       或 JSON 配置 fallback（clawdbot.json）
  ├── MemoryRetriever ─── 检索相关记忆（5s 超时保护）
  ├── TaskRecovery ────── 恢复未完成任务树
  └── buildEmbeddedSystemPrompt ── 统一拼装 System Prompt
  │
  ▼
═══ Phase 1: 智能分解 ═══（LLM 自主决策）
  │
  ├── enqueue_task 工具 ── LLM 主动调用分解
  ├── Orchestrator ─────── 任务树管理 + 自适应深度控制
  ├── validateDecomposition ── 循环依赖 / 孤立任务检测
  └── QualityReviewer ──── 分解质量评估（continue/adjust/restart/overthrow）
  │
  ▼
═══ Phase 2: 高效执行 ═══（followup-runner + drain）
  │
  ├── DependencyAnalyzer ── 拓扑排序识别并行机会
  ├── drain.ts ──────────── 并行 Promise.allSettled / 串行回退
  ├── runEmbeddedPiAgent ── 每个子任务拥有完整工具链
  ├── 兄弟任务上下文注入 ── 已完成任务的输出摘要
  └── RetryManager ──────── 失败自动重试（最多 3 次）
  │
  ▼
═══ Phase 3: 结构化交付 ═══（任务完成后）
  │
  ├── DeliveryReporter ──── 生成 Markdown 交付报告
  ├── MemoryArchiver ────── 异步归档任务经验
  └── sendFollowupPayloads ── 发送报告到用户频道
```

### 1.3 设计哲学

| 原则 | 具体体现 |
|------|---------|
| **不另起炉灶** | 基于已有的 `enqueue_task → followup-runner → runEmbeddedPiAgent` 管线增强，而非重写 |
| **吸收而非叠加** | Butler/VirtualWorld/Lina 的理念融入 System Prompt 和配置，不维护独立代码 |
| **渐进式迁移** | 6 个阶段独立可部署，每阶段约 60-150 行改动 |
| **配置驱动** | 人格、能力、记忆策略全部通过文件目录或 clawdbot.json 配置 |
| **LLM 自主决策** | 系统不硬编码任务分解规则，由 LLM 自行判断是否需要调用 `enqueue_task` |

---

## 二、核心执行管线

### 2.1 完整请求生命周期

```
1. 用户发送消息
     ↓
2. chat.ts → dispatchInboundMessage → agent-runner
     ↓
3. attempt.ts: runEmbeddedAttempt()
   ├── 解析 sessionAgentId
   ├── 调用 resolvePersonaPrompt()  ← 目录制角色 / JSON fallback
   ├── 调用 retrieveMemoryContext()  ← 5s 超时保护
   ├── 拼装 enhancedExtraSystemPrompt
   └── 调用 buildEmbeddedSystemPrompt()
     ↓
4. LLM 收到增强后的 System Prompt + 用户消息
   ├── 如果任务简单 → 直接回复
   └── 如果任务复杂 → 调用 enqueue_task 工具（可调用多次）
     ↓
5. enqueue-task-tool.ts:
   ├── 循环检测（isQueueTask / isRootTask / taskDepth ≤ 3）
   ├── 加载/初始化任务树（globalOrchestrator）
   ├── 自适应 maxDepth 设置
   ├── addSubTask → 保存到 TASK_TREE.json
   └── enqueueFollowupRun → 加入队列
     ↓
6. drain.ts: scheduleFollowupDrain()
   ├── 检测并行机会（DependencyAnalyzer）
   ├── 无依赖任务 → Promise.allSettled 并发
   └── 有依赖任务 → 串行执行
     ↓
7. followup-runner.ts:
   ├── 注入兄弟任务上下文（buildSiblingContext）
   ├── runEmbeddedPiAgent（完整工具链）
   ├── 更新 taskTree 状态（completed/failed）
   ├── 失败自动重试（最多 3 次）
   └── 全部完成 → 触发交付
     ↓
8. 交付阶段:
   ├── DeliveryReporter.generateReport() → Markdown 报告
   ├── sendFollowupPayloads() → 发送到用户频道
   └── MemoryArchiver.archive() → 异步归档经验
```

### 2.2 关键认知

> **每个子任务通过 `runEmbeddedPiAgent` 执行时，已经拥有完整的 Pi Agent 工具链**（read/write/exec/edit/search 等）。这意味着任何类型的任务（写作、编码、文件操作、命令执行）都已经可以在子任务中执行。`runEmbeddedPiAgent` 就是真正的执行引擎。

---

## 三、六大子系统详解

### 3.1 记忆系统（Memory System）

**模块位置**: `src/agents/memory/`

**能力清单**:

| 能力 | 实现文件 | 说明 |
|------|---------|------|
| **记忆检索** | `retriever.ts` | 基于 MemoryIndexManager 搜索，支持相关性排序 |
| **记忆归档** | `archiver.ts` | 支持 Markdown/JSON 格式，多策略（always/on-demand/threshold） |
| **超时保护** | `pipeline-integration.ts` | 5 秒超时，失败静默跳过，不阻塞主流程 |
| **兄弟上下文** | `pipeline-integration.ts` | `buildSiblingContext()` 汇总已完成兄弟任务输出 |
| **服务工厂** | `factory.ts` | 从 ClawdbotConfig 解析配置并创建 MemoryService 实例 |

**工作流程**:

```
根任务开始
  → retrieveMemoryContext(prompt, sessionId, config)
  → 注入到 extraSystemPrompt
  → LLM 获得历史上下文

子任务执行
  → buildSiblingContext(taskTree.subTasks)
  → 注入前序任务输出摘要
  → 子任务间信息不断裂

任务完成
  → createMemoryService(config, "main")
  → archive({ summary, context })
  → 经验异步落盘
```

**注入策略**:
- **根任务**：自动检索并注入相关记忆（仅限非 isQueueTask）
- **子任务**：注入兄弟任务输出摘要（不重复检索记忆库）
- **任务完成**：异步归档到记忆系统（fire-and-forget）

### 3.2 人格系统（Persona System）

**模块位置**: `src/agents/persona-injector.ts` + `src/agents/pipeline/characters/`

**两级加载架构**:

```
resolvePersonaPrompt(cfg, agentId, characterName?)
  │
  ├── 优先级 1: 目录制角色
  │   └── CharacterService.loadCharacter(charName)
  │       ├── config.json ── 角色配置
  │       ├── prompts/system.md ── System Prompt 模板
  │       ├── knowledge/*.md ── 知识库
  │       └── memory/ ── 角色专属记忆
  │
  └── 优先级 2: JSON 配置 (fallback)
      └── clawdbot.json → agents.list[].persona
          ├── name / personality / speakingStyle
          └── capabilities / rules
```

**目录制角色详解**（见第四章）

**输出格式**: `ResolvedPersona`
- `name` — 角色内部名
- `displayName` — 角色显示名
- `prompt` — 完整 System Prompt 片段（可直接拼接）
- `source` — `"directory"` 或 `"config"`
- `character?` — 目录制角色的完整 LoadedCharacter 数据

### 3.3 智能任务分解系统（Intelligent Task Decomposition）

**模块位置**: `src/agents/intelligent-task-decomposition/`

**核心组件清单**:

| 组件 | 文件 | 职责 |
|------|------|------|
| **Orchestrator** | `orchestrator.ts` | 中央协调器：任务树管理、分解、质量评估、批量执行、渲染、交付 |
| **TaskTreeManager** | `task-tree-manager.ts` | 任务树的 CRUD、持久化（JSON 文件）、版本管理 |
| **LLMTaskDecomposer** | `llm-task-decomposer.ts` | LLM 驱动的任务分解，支持递归分解和失败学习 |
| **QualityReviewer** | `quality-reviewer.ts` | 分解质量评估，四种决策：continue/adjust/restart/overthrow |
| **TaskAdjuster** | `task-adjuster.ts` | 动态调整任务树（增删改子任务） |
| **RetryManager** | `retry-manager.ts` | 失败自动重试策略 |
| **ErrorHandler** | `error-handler.ts` | 错误分类与处理 |
| **RecoveryManager** | `recovery-manager.ts` | 任务断点恢复 |
| **TaskGrouper** | `task-grouper.ts` | 子任务分组（用于批量执行） |
| **BatchExecutor** | `batch-executor.ts` | 批量执行多个子任务 |
| **FileManager** | `file-manager.ts` | 任务产出文件管理 |
| **OutputFormatter** | `output-formatter.ts` | 输出格式化（递归完成报告等） |
| **DependencyAnalyzer** | `dependency-analyzer.ts` | 🆕 拓扑排序 + 并行分组 |
| **DeliveryReporter** | `delivery-reporter.ts` | 🆕 结构化交付报告生成 |

**Orchestrator 核心方法**:

```typescript
class Orchestrator {
  // 任务树生命周期
  initializeTaskTree(rootTask, sessionId)  // 初始化
  loadTaskTree(sessionId)                   // 加载
  saveTaskTree(taskTree)                    // 保存
  addSubTask(taskTree, prompt, summary)     // 添加子任务

  // 分解
  decomposeSubTask(taskTree, subTaskId)     // 递归分解
  calculateAdaptiveMaxDepth(root, count)    // 🆕 自适应深度
  validateDecomposition(taskTree)           // 🆕 循环依赖检测

  // 质量控制
  adjustTaskTree(taskTree, changes)         // 动态调整
  checkAndReviewCompletion(taskTree)        // 整体质量评估

  // 执行
  getExecutableTasks(taskTree, batching?)   // 获取可执行任务
  executeBatches(taskTree, batches)         // 批量执行
  setLLMCaller(caller, options?)            // 设置 LLM 调用器

  // 🆕 渲染（合并自 task-board）
  renderTaskBoard(taskTree)                 // 紧凑 Markdown 看板
  buildTaskContextPrompt(taskTree)          // 注入 System Prompt 的上下文

  // 🆕 交付
  generateDeliveryReport(taskTree)          // 交付报告数据
  generateDeliveryReportMarkdown(taskTree)  // 交付报告 Markdown
}
```

**自适应深度控制**:

| 子任务数量 | maxDepth | 说明 |
|-----------|----------|------|
| ≤ 3 | 1 | 简单任务，不递归分解 |
| 4-10 | 2 | 中等任务，允许一层递归 |
| > 10 | 3 | 复杂任务，最多三层递归 |

**分解验证（validateDecomposition）**:
- 检查子任务非空
- 检测循环依赖（DFS + 栈标记）
- 检测孤立依赖（依赖不存在的任务 ID）
- 检查空 prompt

**质量评估四种决策**:

| 决策 | 触发条件 | 行为 |
|------|---------|------|
| `continue` | 分解质量合格 | 继续执行 |
| `adjust` | 需要微调 | 应用 TaskAdjuster 变更 |
| `restart` | 质量不满意 | 保留失败经验，重新分解（最多 2 次） |
| `overthrow` | 根本性错误 | 完全推翻重做（最多 1 次） |

### 3.4 并行执行引擎（Parallel Execution Engine）

**模块位置**: `src/agents/intelligent-task-decomposition/dependency-analyzer.ts` + `src/auto-reply/reply/queue/drain.ts`

**工作原理**:

```
队列中有多个 isQueueTask 任务
  │
  ▼
DependencyAnalyzer.findParallelGroups(pendingTasks)
  │
  ├── 拓扑排序：按依赖关系分层
  ├── 同层任务互不依赖 → 可并行
  └── 循环依赖保护 → 强制归入最后一组
  │
  ▼
drain.ts 并行调度
  │
  ├── 第一个并行组有 > 1 任务 → Promise.allSettled 并发
  └── 否则 → 串行执行（回退）
```

**并行分组示例**:

```
任务 A (无依赖)  ─┐
任务 B (无依赖)  ─┤── 第 1 批次：A, B, C 并发执行
任务 C (无依赖)  ─┘
任务 D (依赖 A)  ─┐
任务 E (依赖 B)  ─┤── 第 2 批次：D, E 并发执行
```

### 3.5 结构化交付系统（Delivery System）

**模块位置**: `src/agents/intelligent-task-decomposition/delivery-reporter.ts`

**交付报告结构**:

```typescript
interface DeliveryReport {
  summary: string;           // "任务「XXX」已全部完成：5 个子任务成功，0 个失败"
  completedTasks: [...]      // 每个已完成任务的摘要 + 输出片段
  producedFiles: string[];   // 所有产出文件列表
  keyDecisions: string[];    // 从失败历史提取的关键教训
  failuresAndLessons: [...]  // 失败任务 + 错误 + 教训
  statistics: {
    total, completed, failed,
    durationMs, successRate   // "100%"
  }
}
```

**交付流程**:

```
任务树所有子任务完成
  → followup-runner 检测 allDone
  → DeliveryReporter.generateReport(taskTree)
  → DeliveryReporter.formatAsMarkdown(report)
  → sendFollowupPayloads([{ text: markdown }])  ← 发送到用户频道
  → MemoryArchiver.archive(...)                  ← 异步归档
```

**交付报告示例**:

```markdown
# 📦 任务交付报告

## 摘要
任务「写一篇 10000 字的科幻小说」已全部完成：5 个子任务成功，0 个失败。

## 📊 统计
- **总任务数**: 5
- **已完成**: 5
- **成功率**: 100%
- **耗时**: 3m 42s

## ✅ 已完成任务
- **第一章：觉醒**
  > 2147年，火星殖民地「新黎明」的第三代居民...
- **第二章：逃亡**
  > 警报声划破了凌晨四点的人造天空...
...
```

### 3.6 任务看板渲染（Task Board）

**合并状态**: task-board 的渲染能力已合入 Orchestrator，旧 `task-board/orchestrator.ts` 已标记 `@deprecated`。

**Orchestrator.renderTaskBoard(taskTree)** 输出示例:

```markdown
## 📋 任务看板

**主任务**: 写一篇科幻小说
**状态**: 🔄 active
**进度**: 3/5 (60%)

**子任务**:
1. ✅ 第一章：觉醒
2. ✅ 第二章：逃亡
3. ✅ 第三章：联盟
4. 🔄 第四章：决战
5. ⏳ 第五章：新纪元
```

**Orchestrator.buildTaskContextPrompt(taskTree)** — 注入到 System Prompt:

```markdown
## 当前任务上下文

你正在执行一个多步骤任务：**写一篇科幻小说**
总共 5 个子任务，已完成 3，待执行 1，失败 0。

### 已完成
- ✅ 第一章：觉醒: 2147年，火星殖民地「新黎明」的第三代居民...
- ✅ 第二章：逃亡: 警报声划破了凌晨四点的人造天空...

### 待执行
- ⏳ 第五章：新纪元
```

---

## 四、目录制角色系统

### 4.1 目录结构

```
clawd/characters/{characterName}/
├── config.json          ← 角色配置（名称、识别词、功能开关、提醒等）
├── prompts/
│   └── system.md        ← System Prompt 模板（支持占位符自动替换）
├── knowledge/
│   ├── capabilities.md  ← 角色能力说明
│   └── guidelines.md    ← 交互规范
└── memory/
    ├── core-memories.md ← 核心记忆（长期）
    └── sessions/        ← 会话归档（最近 5 个自动加载）
```

### 4.2 config.json 字段说明

```json
{
  "name": "lina",                      // 内部标识
  "displayName": "琳娜",              // 显示名称
  "version": "1.0",
  "type": "system-persona",           // system-persona | virtual-character
  "enabled": true,

  "recognition": {                     // 意图分析器使用
    "names": ["琳娜", "lina"],        // 触发名称
    "triggers": ["帮我", "安排"],      // 触发关键词
    "contexts": ["任务", "日程"]       // 上下文关键词
  },

  "features": {                        // 功能开关
    "reminders": true,
    "taskManagement": true,
    "memoryManagement": true
  },

  "systemPrompt": {                    // 人格核心定义
    "role": "管家助理",
    "personality": ["主动", "细心", "友好"],
    "addressUser": "主人",
    "addressSelf": "琳娜"
  },

  "memory": {
    "coreMemoriesFile": "core-memories.md",
    "sessionArchiveDir": "sessions",
    "maxRetrievalResults": 10
  },

  "prompts": {
    "systemPromptTemplate": "system.md"
  },

  "knowledge": {
    "files": ["capabilities.md", "guidelines.md"]
  }
}
```

### 4.3 System Prompt 模板占位符

| 占位符 | 自动替换为 |
|--------|-----------|
| `{currentDate}` | 当前日期（zh-CN 格式） |
| `{coreMemories}` | `memory/core-memories.md` 内容 |
| `{relevantMemories}` | 最近 5 个 `memory/sessions/*.md` 内容 |
| `{addressUser}` | config.json 中的 `systemPrompt.addressUser` |
| `{addressSelf}` | config.json 中的 `systemPrompt.addressSelf` |
| `{personality}` | 性格列表（逗号分隔） |
| `{characterProfile}` | `profile.md` 全文 |
| `{capabilities}` | profile 中的核心能力段落 |

### 4.4 角色加载链路

```
用户消息 "琳娜帮我安排日程"
  → IntentAnalyzer.analyze() → hookCharacterName = "lina"
  → attempt.ts → resolvePersonaPrompt(cfg, agentId, "lina")
  → CharacterService.loadCharacter("lina")
    → 读取 clawd/characters/lina/config.json
    → 读取 clawd/characters/lina/prompts/system.md
    → 读取 clawd/characters/lina/knowledge/*.md
    → 读取 clawd/characters/lina/memory/core-memories.md
    → 读取最近 5 个 sessions/*.md
    → formatSystemPrompt（替换占位符 + 拼接知识库）
  → 返回 ResolvedPersona { prompt, source: "directory" }
  → 注入 enhancedExtraSystemPrompt
```

### 4.5 新建角色

1. 创建目录 `clawd/characters/{name}/`
2. 编写 `config.json`（参考 4.2 模板）
3. 编写 `prompts/system.md`（使用占位符）
4. 添加知识文件到 `knowledge/`
5. （可选）添加 `memory/core-memories.md`

无需修改任何代码——角色通过 `IntentAnalyzer` 的 `recognition.names` 自动触发。

---

## 五、模块协同运作

### 5.1 记忆 × 人格 × 分解 的协同

```
attempt.ts 入口
  │
  ├── ① 人格注入（resolvePersonaPrompt）
  │   └── 生成角色 System Prompt（含知识库 + 核心记忆）
  │
  ├── ② 记忆注入（retrieveMemoryContext）
  │   └── 从记忆索引检索历史相关内容
  │
  └── ③ 拼装 enhancedExtraSystemPrompt
      = [人格 Prompt] + [原始 extraSystemPrompt] + [记忆上下文]
      │
      ▼
  LLM 收到完整上下文 → 更精准的任务分解决策
```

**设计要点**：人格在记忆之前注入，确保 LLM 先建立角色身份，再结合记忆做判断。

### 5.2 分解 × 并行 × 交付 的协同

```
enqueue_task 创建任务树
  │
  ├── 自适应 maxDepth → 避免过深分解
  ├── validateDecomposition → 早期发现循环依赖
  │
  ▼
drain.ts 调度执行
  │
  ├── DependencyAnalyzer.findParallelGroups()
  ├── 并行组 → Promise.allSettled
  ├── 串行组 → 逐个执行
  │
  ▼
followup-runner 执行每个子任务
  │
  ├── 注入兄弟上下文（buildSiblingContext）
  ├── runEmbeddedPiAgent（完整工具链）
  ├── 更新 taskTree 状态
  │
  ▼
全部完成 → 交付
  │
  ├── DeliveryReporter → Markdown 报告
  ├── sendFollowupPayloads → 发送给用户
  └── MemoryArchiver → 归档经验
```

### 5.3 Orchestrator × followup-runner × drain 三角关系

```
┌─────────────────┐     ┌──────────────────┐     ┌───────────┐
│  Orchestrator    │────▶│  followup-runner  │────▶│  drain.ts │
│                  │     │                  │     │           │
│ - 任务树管理     │     │ - 执行子任务      │     │ - 队列调度 │
│ - 质量评估       │     │ - 状态更新        │     │ - 并行检测 │
│ - 渲染看板       │     │ - 归档 + 交付     │     │ - 防重入   │
│ - 交付报告       │     │ - 重试失败任务    │     │           │
└─────────────────┘     └──────────────────┘     └───────────┘
        ▲                        │
        │                        │
        └────── enqueue-task-tool ◀── LLM 调用 enqueue_task
```

---

## 六、配置指南

### 6.1 记忆系统配置（clawdbot.json）

```json
{
  "agents": {
    "list": [{
      "id": "main",
      "memory": {
        "enabled": true,
        "archivalStrategy": "always",
        "retrievalTimeout": 5000,
        "maxRetrievalResults": 10,
        "indexDir": "~/.clawdbot/memory/index"
      }
    }]
  }
}
```

### 6.2 人格配置 — JSON 方式（简易 fallback）

```json
{
  "agents": {
    "list": [{
      "id": "main",
      "persona": {
        "name": "琳娜",
        "personality": "温柔、专业、有耐心的管家",
        "speakingStyle": "礼貌但不啰嗦，用中文交流",
        "capabilities": ["任务分解", "记忆管理", "文件操作"],
        "rules": ["复杂任务主动使用 enqueue_task 分解"]
      }
    }]
  }
}
```

### 6.3 人格配置 — 目录制角色（推荐）

```json
{
  "agents": {
    "dynamicPipeline": {
      "enabled": true,
      "charactersDir": "clawd/characters",
      "defaultCharacter": "lina",
      "systemPersona": "lina"
    }
  }
}
```

目录制角色自动从 `clawd/characters/lina/` 加载完整角色包。

### 6.4 任务分解配置

当前通过 `enqueue_task` 工具的描述文本和 Orchestrator 内置逻辑控制：

- **最大分解深度**: 自适应（1-3），由 `calculateAdaptiveMaxDepth` 计算
- **最大队列深度**: 3（`MAX_ENQUEUE_DEPTH` 硬编码）
- **重试次数**: 3（followup-runner 内置）
- **质量评估**: 默认启用（`qualityReviewEnabled !== false`）

---

## 七、顶层设计评价

### 7.1 优秀之处

#### ✅ 1. "增强而非重写"的务实哲学

系统没有推翻已有的 `runEmbeddedPiAgent` 执行引擎，而是在其上游（System Prompt）和下游（交付报告）做增强。这保证了：
- 现有 200+ 工具定义的完全复用
- 零停机迁移风险
- 每个阶段独立可部署

#### ✅ 2. LLM 自主决策的分解模式

系统不用规则引擎判断"什么任务需要分解"，而是给 LLM 提供 `enqueue_task` 工具，让它自行判断。这种设计：
- 不需要维护复杂的意图分类规则
- 自然适应任意类型的任务
- LLM 的分解能力会随模型升级自动提升

#### ✅ 3. 三层循环检测（防止无限递归）

```
方案 1: isQueueTask 标记 → 子任务不能再 enqueue
方案 2: isRootTask/isNewRootTask → 仅根任务可分解
方案 3: taskDepth ≤ 3 → 深度兜底
```

三层互为冗余，任意一层失效不会导致死循环。

#### ✅ 4. 目录制角色 + JSON fallback 的双轨设计

- 目录制支持复杂角色（多文件知识库 + 记忆 + Prompt 模板）
- JSON 配置支持快速原型（一行配置即启用角色）
- 两种模式透明切换，调用方无感知

#### ✅ 5. 自愈机制链

```
失败 → RetryManager（最多 3 次）
     → ErrorHandler（分类错误）
     → RecoveryManager（断点恢复）
     → QualityReviewer（质量评估 → adjust/restart/overthrow）
     → FailureHistory（失败经验学习）
```

#### ✅ 6. 记忆注入的分层策略

- 根任务：注入全局记忆（检索历史）
- 子任务：注入兄弟上下文（前序任务输出）
- 完成后：异步归档（不阻塞主流程）

避免了子任务重复检索记忆库的 token 浪费。

### 7.2 不足之处

#### ⚠️ 1. 并行执行的匹配精度

`drain.ts` 中用 `item.prompt === pgTask.prompt` 做队列项与任务树的匹配，当两个子任务的 prompt 相同时会产生误匹配。

**改进方向**：在 `FollowupRun` 中携带 `subTaskId`，用 ID 精确匹配。

#### ⚠️ 2. Orchestrator 单文件过大

当前 `orchestrator.ts` 已达 1500+ 行，合并了分解、执行、渲染、交付、验证等多个职责域。虽然每个方法独立，但文件级的认知负担较重。

**改进方向**：将渲染、交付、验证方法提取为独立 mixin 或 strategy 文件，Orchestrator 只做组合。

#### ⚠️ 3. 记忆检索质量依赖索引质量

`MemoryRetriever` 基于 `MemoryIndexManager` 搜索，检索质量高度依赖索引的覆盖度和更新频率。如果索引过时或稀疏，记忆注入的价值大打折扣。

**改进方向**：增加索引健康度监控；支持 embedding 向量检索（当前是关键词匹配）。

#### ⚠️ 4. 目录制角色缺少热更新

`CharacterService` 使用内存缓存（`loadedCharacters` Map），角色加载后修改磁盘文件不会自动刷新。

**改进方向**：增加文件 watcher 或 TTL 缓存失效机制。

#### ⚠️ 5. 交付报告单一通道

当前交付报告只通过 `sendFollowupPayloads` 发送文本。对于大型任务（如代码重构），纯文本不够直观。

**改进方向**：
- 支持文件附件交付（代码 diff、生成的文件）
- 支持 HTML 富文本报告
- 支持 Discord embed / Telegram inline keyboard

#### ⚠️ 6. 自适应深度控制过于简单

当前 `calculateAdaptiveMaxDepth` 仅基于子任务数量的简单分段函数，没有考虑任务类型（写作 vs 编码）、历史经验等因素。

**改进方向**：引入任务复杂度评分模型，综合考虑 prompt 长度、工具依赖数量、历史同类任务表现。

#### ⚠️ 7. 孤岛模块尚未清理

Butler、VirtualWorld、Lina、MultiLayer、Execution 等模块的代码仍在仓库中，虽已标记 deprecated 但增加了认知成本。

**改进方向**：在确认所有功能被统一管线覆盖后，执行代码清理。

---

## 八、已知限制与改进方向

### 8.1 短期可改进项

| 项目 | 当前状态 | 改进方案 | 难度 |
|------|---------|---------|------|
| 并行匹配精度 | prompt 文本匹配 | FollowupRun 携带 subTaskId | 低 |
| 角色热更新 | 无 | 文件 watcher / TTL 缓存 | 低 |
| 交付报告附件 | 仅文本 | 集成 send_file 工具 | 中 |
| 废弃代码清理 | 标记 deprecated | 逐步删除 + 迁移测试 | 中 |

### 8.2 中期演进方向

| 方向 | 说明 |
|------|------|
| **RequestPipeline 正式化** | 将 attempt.ts 中的增强逻辑提取为独立的 classify → plan → execute → deliver 管线 |
| **向量记忆检索** | 从关键词匹配升级为 embedding 向量搜索 |
| **多角色并发会话** | 支持同一用户同时与多个角色对话 |
| **执行沙箱** | 子任务在隔离环境执行，防止互相干扰 |

### 8.3 长期愿景

| 愿景 | 说明 |
|------|------|
| **自主 Agent** | 从"用户驱动"到"Agent 主动发现并执行任务" |
| **多 Agent 协作** | 多个角色 Agent 协同完成复杂项目 |
| **学习型系统** | 从执行历史中自动提炼最佳实践，优化未来分解策略 |

---

## 九、文件索引

### 核心管线

| 文件 | 职责 |
|------|------|
| `src/agents/pi-embedded-runner/run/attempt.ts` | **管线入口**：人格 + 记忆注入 → System Prompt 构建 |
| `src/agents/tools/enqueue-task-tool.ts` | **分解入口**：LLM 调用的 enqueue_task 工具 |
| `src/auto-reply/reply/queue/drain.ts` | **调度层**：队列 drain + 并行检测 |
| `src/auto-reply/reply/followup-runner.ts` | **执行层**：子任务执行 + 状态更新 + 归档 + 交付 |

### 人格系统

| 文件 | 职责 |
|------|------|
| `src/agents/persona-injector.ts` | 统一入口：resolvePersonaPrompt（目录制 + JSON fallback） |
| `src/agents/pipeline/characters/character-service.ts` | 目录制角色加载服务 |
| `src/config/types.agents.ts` | AgentConfig.persona 类型定义 |

### 记忆系统

| 文件 | 职责 |
|------|------|
| `src/agents/memory/pipeline-integration.ts` | 管线级封装：retrieveMemoryContext + buildSiblingContext |
| `src/agents/memory/retriever.ts` | 记忆检索核心 |
| `src/agents/memory/archiver.ts` | 记忆归档核心 |
| `src/agents/memory/factory.ts` | 服务工厂：createMemoryService |

### 任务分解 & 执行

| 文件 | 职责 |
|------|------|
| `src/agents/intelligent-task-decomposition/orchestrator.ts` | **中央协调器**：分解 + 执行 + 渲染 + 交付 |
| `src/agents/intelligent-task-decomposition/dependency-analyzer.ts` | 依赖分析 + 并行分组 |
| `src/agents/intelligent-task-decomposition/delivery-reporter.ts` | 结构化交付报告 |
| `src/agents/intelligent-task-decomposition/types.ts` | TaskTree / SubTask 等核心类型 |

### 废弃模块（待清理）

| 文件 | 状态 |
|------|------|
| `src/agents/task-board/orchestrator.ts` | @deprecated → 已合入 Orchestrator |
| `src/agents/butler/` | 功能已由 System Prompt + enqueue_task 覆盖 |
| `src/agents/virtual-world/` | 功能已由 PersonaInjector 覆盖 |
| `src/agents/lina/` | 功能已由目录制角色系统覆盖 |
| `src/agents/execution/task-executor.ts` | 全是占位代码，从未使用 |

---

**文档版本**: v2.1
**最后更新**: 2026-02-06
**维护者**: Cascade AI + 用户协作
