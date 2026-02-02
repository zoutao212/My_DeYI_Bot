# Clawdbot 动态管道架构 v3.1

## 核心理念：从"静态分层"到"动态管道"

### 旧设计的问题

旧设计是**静态分层**的思维：

```
虚拟世界层 → 管家层 → 任务调度层 → 执行层
```

这种设计把功能**孤立**地放在不同的"层"里，忽略了它们如何**协作**完成一个完整的用户交互。

### 新设计的核心

**每一个用户交互都是一条动态组装的管道（Dynamic Pipeline）**

```
用户消息
    │
    ▼
┌────────────────────────────────────────────────────────────────┐
│                    意图识别（LLM 动态分析）                      │
│                                                                  │
│   不预设意图类型，LLM 分析用户想要什么，分解成任务清单             │
└────────────────────────────────────────────────────────────────┘
    │
    │  根据意图动态组装管道
    ▼
┌────────────────────────────────────────────────────────────────┐
│                    动态交互管道（Dynamic Pipeline）               │
│                                                                  │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│   │ 前置处理 │ → │ 核心处理 │ → │ 响应生成 │ → │ 后置处理 │   │
│   └──────────┘   └──────────┘   └──────────┘   └──────────┘   │
│         │              │              │              │          │
│         └──────────────┴──────────────┴──────────────┘          │
│                               │                                  │
│                         能力池（按需调用）                        │
│                                                                  │
│   ┌──────────────────────────────────────────────────────┐     │
│   │  [记忆检索] [人格组装] [知识加载] [任务分解] [工具执行]  │     │
│   │  [进度跟踪] [内容提取] [对话存储] [记忆归档] [提醒管理]  │     │
│   └──────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────┘
    │
    ▼
用户响应
```

### 新设计的优势

| 特性 | 旧设计（静态分层） | 新设计（动态管道） |
|------|-------------------|-------------------|
| 设计思维 | 以层次为核心 | 以用户交互流程为核心 |
| 功能组织 | 孤立在不同层 | 按需组合在管道中 |
| 调用方式 | 固定的层次调用 | 动态组装和执行 |
| 流程设计 | 分散在各层 | 端到端的管道流程 |
| 扩展性 | 需要修改层次结构 | 只需注册新能力到能力池 |

---

## 流程示例：角色扮演（丽丝）

用户输入：
```
"丽丝，我回来了，今天好累啊"
```

### 1. 意图识别（LLM 驱动）

LLM 动态分析意图（不预设类型）：

```
意图描述: "用户想要和角色'丽丝'进行角色扮演对话，表达疲惫情绪并寻求关心"
目标角色: lisi
```

### 2. 动态组装管道

根据意图，动态组装管道组件：

```
┌─────────────────────────────────────────────────────────────────┐
│                        动态组装的管道                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  前置处理：                                                       │
│  ├─ [记忆检索] 检索与丽丝的对话记忆，了解之前的互动历史            │
│  ├─ [人格组装] 加载丽丝的人格设定、背景故事和说话风格              │
│  ├─ [知识加载] 加载丽丝的剧情知识                                 │
│  └─ [关系加载] 加载用户与丽丝的关系状态                           │
│                                                                   │
│  核心处理：                                                       │
│  └─ [角色扮演处理器] 基于上下文生成角色扮演响应                   │
│                                                                   │
│  响应生成：                                                       │
│  └─ [角色化响应生成器] 应用角色说话风格、添加情感表达              │
│                                                                   │
│  后置处理：                                                       │
│  ├─ [关键内容提取] 提取对话中的关键信息（用户情绪、角色反应等）    │
│  ├─ [对话归档] 归档对话到会话记录                                 │
│  ├─ [关系更新] 更新用户与丽丝的关系状态                           │
│  └─ [记忆写入] 写入新的长期记忆                                   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 3. 执行管道

各组件依次执行，数据在管道中流动：

```
┌─────────────────────────────────────────────────────────────────┐
│                        管道执行过程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. 记忆检索                                                      │
│     ├─ 输入: { query: "丽丝 对话", userId: "peter" }              │
│     ├─ 动作: 检索最近与丽丝的对话记忆                              │
│     └─ 输出: [                                                    │
│              { content: "上次主人说要早睡...", score: 0.9 },       │
│              { content: "主人最近在忙项目...", score: 0.85 }       │
│            ]                                                      │
│                                                                   │
│  2. 人格组装                                                      │
│     ├─ 输入: { character: "lisi" }                                │
│     ├─ 动作: 加载丽丝的人格配置                                    │
│     └─ 输出: {                                                    │
│              name: "丽丝",                                        │
│              personality: ["温柔", "体贴", "有点傲娇"],           │
│              speakingStyle: "优雅但偶尔害羞",                     │
│              addressUser: "主人"                                  │
│            }                                                      │
│                                                                   │
│  3. 知识加载                                                      │
│     ├─ 输入: { character: "lisi", context: "greeting" }           │
│     └─ 输出: {                                                    │
│              background: "丽丝是主人的专属侍女，负责照顾主人起居",  │
│              currentPlot: "主人最近工作繁忙，丽丝很担心"           │
│            }                                                      │
│                                                                   │
│  4. 关系加载                                                      │
│     ├─ 输入: { character: "lisi", userId: "peter" }               │
│     └─ 输出: { intimacy: 85, recentInteractions: ["问候", "关心"] }│
│                                                                   │
│  5. 角色扮演处理（使用前面所有输出作为上下文）                     │
│     ├─ 输入: 用户消息 + 记忆 + 人格 + 知识 + 关系                 │
│     └─ 输出: "主人，您回来了！丽丝等了好久呢..."                  │
│                                                                   │
│  6. 角色化响应生成                                                 │
│     ├─ 输入: rawResponse + personality                            │
│     └─ 输出: "主人，您回来了！丽丝等了好久呢...*轻轻走上前*        │
│              看主人这么累，快坐下休息，丽丝去给主人泡杯热茶。       │
│              *眼中带着关切*"                                       │
│                                                                   │
│  7. 关键内容提取                                                   │
│     └─ 输出: { userEmotion: "疲惫", characterAction: "泡茶" }      │
│                                                                   │
│  8. 对话归档 + 关系更新 + 记忆写入（并行执行）                      │
│     └─ 副作用: archived=true, newIntimacy=87, memoryId=xxx        │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 4. 最终结果

```typescript
{
  response: "主人，您回来了！丽丝等了好久呢...*轻轻走上前*\n" +
            "看主人这么累，快坐下休息，丽丝去给主人泡杯热茶。\n" +
            "*眼中带着关切*",
  
  trace: {
    pipelineId: "pipe-20260202-001",
    intent: "用户想要和角色'丽丝'进行角色扮演对话...",
    stages: [
      { name: 'preProcess', duration: 270, components: 4 },
      { name: 'coreProcess', duration: 450, components: 1 },
      { name: 'responseGenerate', duration: 80, components: 1 },
      { name: 'postProcess', duration: 150, components: 4 },
    ],
    totalDuration: 950,
  },
  
  sideEffects: [
    { type: 'conversation_archived', path: 'sessions/2026-02-02/...' },
    { type: 'relationship_updated', character: 'lisi', newIntimacy: 87 },
    { type: 'memory_created', memoryId: 'mem-20260202-001' },
  ]
}
```

---

## 流程示例：复杂任务请求

用户输入：
```
"帮我重构 src/agents 目录下的代码，把重复的逻辑抽取成公共模块"
```

### 动态组装管道

```
前置处理：
├─ [记忆检索] 检索相关的代码重构经验和最佳实践
├─ [代码库分析] 分析 src/agents 目录的代码结构
└─ [任务历史加载] 加载类似任务的历史

核心处理：
├─ [代码模式分析] 使用 LLM 分析代码，识别重复的逻辑模式
├─ [模块设计] 设计公共模块的结构和接口
├─ [任务看板创建] 创建任务看板，跟踪重构进度
├─ [代码实现] 实现公共模块
├─ [代码重构] 重构现有文件，使用公共模块
└─ [测试执行] 运行测试验证重构结果

后置处理：
├─ [进度更新] 更新任务看板进度
└─ [经验归档] 归档重构经验到记忆系统
```

---

## 能力池设计

### 核心思想

所有功能模块都注册到**能力池**，供管道**按需调用**。

```typescript
interface CapabilityPool {
  /** 注册能力 */
  register(capability: Capability): void;
  
  /** 获取能力 */
  get(name: string): Capability | undefined;
  
  /** 获取所有能力描述（给 LLM 看的） */
  getDescriptions(): CapabilityDescription[];
}

interface Capability {
  /** 能力名称 */
  name: string;
  
  /** 能力描述（自然语言，给 LLM 看的） */
  description: string;
  
  /** 使用场景 */
  useCases: string[];
  
  /** 执行能力 */
  execute(params: unknown): Promise<unknown>;
}
```

### 已有能力（复用现有代码）

| 能力名称 | 描述 | 实现文件 |
|----------|------|----------|
| `memory_retriever` | 检索相关记忆 | `src/agents/memory/retriever.ts` |
| `memory_archiver` | 归档会话总结 | `src/agents/memory/archiver.ts` |
| `session_summarizer` | 生成会话总结 | `src/agents/session-summary.ts` |
| `personality_loader` | 加载角色人格 | `src/agents/lina/config/loader.ts` |
| `task_delegator` | 委托任务 | `src/agents/butler/task-delegator.ts` |
| `tool_executor` | 执行工具 | `src/agents/pi-tools.ts` |
| `key_content_extractor` | 提取关键内容 | 待实现 |
| `relationship_manager` | 管理关系状态 | 待实现 |

### LLM 驱动的能力选择

**不预设规则**，通过能力描述让 LLM 动态决定使用哪些能力：

```typescript
const systemPrompt = `
你是一个智能管家，负责分析用户意图并制定执行计划。

可用能力列表：
${capabilityPool.getDescriptions().map(d => `
- ${d.name}: ${d.description}
  使用场景: ${d.useCases.join(', ')}
`).join('\n')}

请分析用户消息，理解用户意图，然后：
1. 用自然语言描述用户意图（不限定类型）
2. 选择需要的能力组成管道
3. 确定管道的执行顺序
`;
```

---

## 详细施工方案（基于现有代码深度分析）

### 一、现有代码资产分析

#### 1.1 核心入口点（已存在，需理解）

| 文件 | 函数/类 | 作用 | 关键代码位置 |
|------|---------|------|-------------|
| `src/agents/pi-embedded-runner/run.ts` | `runEmbeddedPiAgent()` | 顶层入口，处理认证、failover、重试 | L69-650 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | `runEmbeddedAttempt()` | 核心执行逻辑，创建 session、tools、prompt | L138-1085 |
| `src/agents/pi-embedded-runner/system-prompt.ts` | `buildEmbeddedSystemPrompt()` | 生成 System Prompt | L13-176 |

#### 1.2 现有 Hook 机制（关键发现！）

`runEmbeddedAttempt` **已经有 hook 机制**，我们可以直接复用：

```typescript
// src/agents/pi-embedded-runner/run/attempt.ts L843-875
const hookRunner = getGlobalHookRunner();

// before_agent_start: 可以注入 prependContext 到 prompt
if (hookRunner?.hasHooks("before_agent_start")) {
  const hookResult = await hookRunner.runBeforeAgentStart(
    { prompt: params.prompt, messages: activeSession.messages },
    { agentId, sessionKey, workspaceDir, messageProvider },
  );
  if (hookResult?.prependContext) {
    effectivePrompt = `${hookResult.prependContext}\n\n${params.prompt}`;
  }
}

// agent_end: 对话结束后触发
if (hookRunner?.hasHooks("agent_end")) {
  hookRunner.runAgentEnd({ messages, success, error, durationMs }, ctx);
}
```

#### 1.3 现有组件资产（可直接复用）

| 组件 | 文件位置 | 状态 | 复用方式 |
|------|----------|------|----------|
| `MemoryService` | `src/agents/memory/service.ts` | ✅ 完整实现 | 直接调用 `retrieve()` 和 `archive()` |
| `LinaAgent` | `src/agents/lina/agent.ts` | ✅ 已实现但无入口 | 通过 `getSystemPrompt()` 获取人格 prompt |
| `generateSessionSummary()` | `src/agents/session-summary.ts` | ✅ 完整实现 | 直接调用生成总结 |
| `loadCharacterConfig()` | `src/agents/lina/config/loader.ts` | ✅ 已实现 | 加载角色配置 |
| `buildEmbeddedSystemPrompt()` | `src/agents/pi-embedded-runner/system-prompt.ts` | ✅ 已支持 `agentLayer` | 传入 `agentLayer` 和 `characterName` |

#### 1.4 现有 System Prompt 已支持的参数

```typescript
// src/agents/pi-embedded-runner/system-prompt.ts L13-63
async function buildEmbeddedSystemPrompt(params: {
  // ... 其他参数 ...
  agentLayer?: AgentLayer;           // ✅ 已支持：'virtual-world' | 'butler' | 'execution'
  characterName?: string;            // ✅ 已支持：如 "lina", "lisi"
  sessionSummary?: string;           // ✅ 已支持：会话总结
  taskBoard?: string;                // ✅ 已支持：任务看板
})
```

---

### 二、施工方案：利用 Hook 机制实现动态管道

#### 2.1 方案概述

**核心思路**：创建一个**内部插件** `PipelinePlugin`，注册到现有 hook 机制，实现动态管道的前置/后置处理。

```
用户消息
    │
    ▼
runEmbeddedPiAgent()
    │
    ▼
runEmbeddedAttempt()
    │
    ├─► [before_agent_start hook] ◄── PipelinePlugin.onBeforeAgentStart()
    │                                  │
    │                                  ├─ LLM 分析意图
    │                                  ├─ 执行前置处理（记忆检索、人格加载等）
    │                                  └─ 返回 prependContext（注入到 prompt）
    │
    ├─► buildEmbeddedSystemPrompt() ◄── 使用 agentLayer/characterName
    │
    ├─► activeSession.prompt() ◄── LLM 对话
    │
    └─► [agent_end hook] ◄── PipelinePlugin.onAgentEnd()
                              │
                              ├─ 执行后置处理（记忆归档、关系更新等）
                              └─ 异步执行，不阻塞响应
```

#### 2.2 新增文件清单

| 文件路径 | 作用 | 代码量 |
|----------|------|--------|
| `src/agents/pipeline/plugin.ts` | 动态管道插件，实现 hooks | ~300 行 |
| `src/agents/pipeline/intent-analyzer.ts` | LLM 意图分析器 | ~150 行 |
| `src/agents/pipeline/capability-pool.ts` | 能力池，注册所有可用能力 | ~250 行 |
| `src/agents/pipeline/types.ts` | 类型定义 | ~80 行 |

#### 2.3 需要修改的文件

| 文件路径 | 修改内容 | 代码量 |
|----------|----------|--------|
| `src/plugins/registry.ts` | 注册 PipelinePlugin | +5 行 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 传递更多上下文给 hooks | +10 行 |

---

### 三、详细实现代码

#### 3.1 类型定义

**文件**：`src/agents/pipeline/types.ts`

```typescript
/**
 * 动态管道类型定义
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ClawdbotConfig } from "../../config/config.js";

/**
 * LLM 分析后的执行计划
 */
export interface ExecutionPlan {
  /** 用户意图的自然语言描述（LLM 动态生成，不预设类型） */
  intentDescription: string;
  
  /** 管道阶段 */
  pipeline: {
    /** 前置处理：需要调用的能力列表 */
    preProcess: CapabilityCall[];
    /** 核心处理：需要调用的能力 */
    coreProcess: CapabilityCall | null;
    /** 响应生成：需要调用的能力 */
    responseGenerate: CapabilityCall | null;
    /** 后置处理：需要调用的能力列表 */
    postProcess: CapabilityCall[];
  };
}

export interface CapabilityCall {
  /** 能力名称 */
  capability: string;
  /** 能力参数（LLM 动态决定） */
  params: Record<string, unknown>;
  /** 说明（LLM 生成） */
  reason: string;
}

/**
 * 能力描述（给 LLM 看的）
 */
export interface CapabilityDescription {
  name: string;
  description: string;
  useCases: string[];
  parameters: Record<string, string>;
}

/**
 * 能力执行器
 */
export interface Capability {
  name: string;
  description: string;
  useCases: string[];
  parameters: Record<string, string>;
  execute(params: CapabilityExecuteParams): Promise<unknown>;
}

export interface CapabilityExecuteParams {
  /** LLM 指定的参数 */
  params: Record<string, unknown>;
  /** 执行上下文 */
  context: {
    userMessage: string;
    conversationHistory: AgentMessage[];
    sessionId: string;
    sessionKey?: string;
    agentId: string;
    userId?: string;
    config: ClawdbotConfig;
  };
  /** 前序能力的执行结果 */
  previousResults: Record<string, unknown>;
}

/**
 * 前置处理结果
 */
export interface PreProcessResult {
  /** 注入到 prompt 的上下文 */
  prependContext?: string;
  /** 记忆检索结果 */
  memories?: unknown;
  /** 人格配置 */
  personality?: {
    config: unknown;
    profile: string;
  };
  /** 执行计划 */
  plan?: ExecutionPlan;
}

/**
 * 后置处理结果
 */
export interface PostProcessResult {
  /** 归档是否成功 */
  archived: boolean;
  /** 归档路径 */
  archivePath?: string;
  /** 其他后置处理结果 */
  [key: string]: unknown;
}
```

#### 3.2 能力池实现

**文件**：`src/agents/pipeline/capability-pool.ts`

```typescript
/**
 * 能力池 - 注册所有可用能力供 LLM 动态选择
 * 
 * 设计原则：
 * 1. 复用现有代码，不重复造轮子
 * 2. 每个能力都有自然语言描述，供 LLM 理解
 * 3. 能力可以动态注册和扩展
 */

import type { ClawdbotConfig } from "../../config/config.js";
import type { Capability, CapabilityDescription, CapabilityExecuteParams } from "./types.js";
import { createMemoryService, resolveMemoryServiceConfig } from "../memory/service.js";
import type { IMemoryService } from "../memory/types.js";
import { loadCharacterConfig, loadCharacterProfile } from "../lina/config/loader.js";
import { generateSessionSummary, formatSessionSummary } from "../session-summary.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("pipeline:capability");

export class CapabilityPool {
  private capabilities = new Map<string, Capability>();

  register(capability: Capability): void {
    this.capabilities.set(capability.name, capability);
    log.debug(`Registered capability: ${capability.name}`);
  }

  get(name: string): Capability | undefined {
    return this.capabilities.get(name);
  }

  getDescriptions(): CapabilityDescription[] {
    return Array.from(this.capabilities.values()).map(c => ({
      name: c.name,
      description: c.description,
      useCases: c.useCases,
      parameters: c.parameters,
    }));
  }

  async execute(name: string, params: CapabilityExecuteParams): Promise<unknown> {
    const capability = this.capabilities.get(name);
    if (!capability) {
      throw new Error(`Capability not found: ${name}`);
    }
    log.debug(`Executing capability: ${name}`, { params: params.params });
    return capability.execute(params);
  }
}

/**
 * 创建默认能力池，注册所有已实现的能力
 * 
 * 复用现有组件：
 * - MemoryService (src/agents/memory/service.ts)
 * - loadCharacterConfig/loadCharacterProfile (src/agents/lina/config/loader.ts)
 * - generateSessionSummary (src/agents/session-summary.ts)
 */
export function createDefaultCapabilityPool(config: {
  agentId: string;
  sessionId: string;
  userId?: string;
  config: ClawdbotConfig;
}): CapabilityPool {
  const pool = new CapabilityPool();

  // ========== 记忆服务能力（复用 MemoryService） ==========
  
  const memoryConfig = resolveMemoryServiceConfig(config.config, config.agentId);
  let memoryService: IMemoryService | null = null;
  
  if (memoryConfig) {
    memoryService = createMemoryService(memoryConfig, config.config);
    
    // 记忆检索能力
    pool.register({
      name: "memory_retriever",
      description: "从长期记忆系统中检索相关的对话记忆、会话总结或重要信息。这些记忆可以帮助理解用户的历史偏好、之前的对话内容和关系状态。",
      useCases: [
        "在角色扮演前检索之前与该角色的对话记忆",
        "在执行任务前检索相关的经验教训和最佳实践",
        "在回答问题时检索相关的知识记忆",
        "了解用户的历史偏好和习惯",
      ],
      parameters: {
        query: "检索关键词，通常使用用户消息的关键内容",
        maxResults: "最大结果数，默认 5",
        minScore: "最小相关性分数（0-1），默认 0.7",
      },
      execute: async (execParams) => {
        if (!memoryService) return { memories: [], formattedContext: "" };
        
        const query = (execParams.params.query as string) || execParams.context.userMessage;
        
        return memoryService.retrieve({
          query,
          context: {
            userId: execParams.context.userId ?? "default",
            sessionId: execParams.context.sessionId,
            agentId: execParams.context.agentId,
          },
          params: {
            maxResults: execParams.params.maxResults as number,
            minScore: execParams.params.minScore as number,
          },
        });
      },
    });

    // 记忆归档能力
    pool.register({
      name: "memory_archiver",
      description: "将对话总结归档到长期记忆系统，以便将来检索。应该在重要对话结束后调用，保存关键信息和决策。",
      useCases: [
        "对话结束后归档重要内容",
        "保存任务执行经验和教训",
        "记录关键决策和原因",
        "保存与角色的互动记忆",
      ],
      parameters: {
        importance: "重要性（1-10），决定归档优先级",
      },
      execute: async (execParams) => {
        if (!memoryService) return { archived: false };
        
        // 使用前序结果中的会话总结，或者生成新的
        const summary = execParams.previousResults.session_summarizer || 
          generateSessionSummary(execParams.context.conversationHistory);
        
        if (!summary) return { archived: false };

        return memoryService.archive({
          summary: summary as any,
          context: {
            userId: execParams.context.userId ?? "default",
            sessionId: execParams.context.sessionId,
            agentId: execParams.context.agentId,
          },
        });
      },
    });
  }

  // ========== 人格加载能力（复用 LinaAgent 的配置加载） ==========
  
  pool.register({
    name: "personality_loader",
    description: "加载角色的人格设定、背景故事和说话风格。用于角色扮演时让 AI 扮演特定角色。",
    useCases: [
      "角色扮演前加载角色人格（如丽丝、栗娜等）",
      "需要特定角色风格回复时",
      "切换不同角色身份时",
    ],
    parameters: {
      character: "角色名称，如 lina（栗娜）、lisi（丽丝）",
    },
    execute: async (execParams) => {
      const characterName = execParams.params.character as string;
      if (!characterName) return null;

      try {
        const [charConfig, profile] = await Promise.all([
          loadCharacterConfig(characterName, process.cwd()),
          loadCharacterProfile(characterName, process.cwd()),
        ]);

        return { 
          config: charConfig, 
          profile,
          formattedPrompt: `## 角色设定\n\n${profile}`,
        };
      } catch (err) {
        log.warn(`Failed to load personality for ${characterName}: ${err}`);
        return null;
      }
    },
  });

  // ========== 会话总结能力（复用 generateSessionSummary） ==========
  
  pool.register({
    name: "session_summarizer",
    description: "生成当前对话的总结，提取任务目标、关键操作、重要决策等信息。",
    useCases: [
      "对话结束后生成总结用于归档",
      "提取对话中的关键决策和任务",
      "为长对话生成中间总结",
    ],
    parameters: {},
    execute: async (execParams) => {
      const summary = generateSessionSummary(execParams.context.conversationHistory);
      if (!summary) return null;
      
      return {
        summary,
        formattedText: formatSessionSummary(summary),
      };
    },
  });

  // ========== 关键内容提取能力 ==========
  
  pool.register({
    name: "key_content_extractor",
    description: "从对话中提取关键信息，如用户情绪、重要事件、决策点、待办事项等。",
    useCases: [
      "角色扮演后提取用户情绪和角色反应",
      "任务完成后提取关键决策",
      "提取对话中的待办事项",
    ],
    parameters: {
      extractTypes: "要提取的类型，可选：emotion（情绪）, event（事件）, decision（决策）, todo（待办）",
    },
    execute: async (execParams) => {
      // 基于规则的简单提取（后续可以改为 LLM 提取）
      const messages = execParams.context.conversationHistory;
      const lastUserMessage = messages.filter(m => m.role === "user").pop();
      
      const result: Record<string, unknown> = {};
      
      // 简单的情绪检测
      const userText = lastUserMessage?.content?.toString() || "";
      if (userText.includes("累") || userText.includes("疲惫")) {
        result.emotion = "疲惫";
      } else if (userText.includes("开心") || userText.includes("高兴")) {
        result.emotion = "开心";
      }
      
      return result;
    },
  });

  // ========== 关系更新能力（占位，后续实现） ==========
  
  pool.register({
    name: "relationship_updater",
    description: "更新用户与角色的关系状态，如亲密度、好感度等。",
    useCases: [
      "角色扮演后更新亲密度",
      "记录重要互动事件",
      "追踪关系发展",
    ],
    parameters: {
      character: "角色名称",
      intimacyDelta: "亲密度变化值（正数增加，负数减少）",
      event: "触发更新的事件描述",
    },
    execute: async (execParams) => {
      // 占位实现，后续接入关系系统
      log.debug("relationship_updater called", { params: execParams.params });
      return { updated: true, note: "Relationship system not yet implemented" };
    },
  });

  return pool;
}
```

#### 3.3 意图分析器

**文件**：`src/agents/pipeline/intent-analyzer.ts`

```typescript
/**
 * LLM 驱动的意图分析器
 * 
 * 核心职责：
 * 1. 分析用户消息，理解用户意图（不预设类型）
 * 2. 根据意图选择需要的能力
 * 3. 组装执行管道
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ClawdbotConfig } from "../../config/config.js";
import type { CapabilityDescription, ExecutionPlan } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("pipeline:intent");

export interface IntentAnalyzerConfig {
  config: ClawdbotConfig;
  sessionKey?: string;
}

export interface AnalyzeParams {
  userMessage: string;
  conversationHistory: AgentMessage[];
  capabilities: CapabilityDescription[];
}

/**
 * 意图分析器
 * 
 * 设计原则：
 * 1. 不预设意图类型，让 LLM 自由分析
 * 2. 基于能力描述让 LLM 选择合适的能力
 * 3. 返回完整的执行计划
 */
export class IntentAnalyzer {
  constructor(private readonly config: IntentAnalyzerConfig) {}

  /**
   * 分析用户意图并生成执行计划
   * 
   * 这是动态管道的核心：LLM 自己决定如何处理用户请求
   */
  async analyze(params: AnalyzeParams): Promise<ExecutionPlan> {
    const { userMessage, capabilities } = params;

    // 构建能力描述文本
    const capabilityText = capabilities.map(c => `
### ${c.name}
- 描述：${c.description}
- 使用场景：${c.useCases.join('；')}
- 参数：${Object.entries(c.parameters).map(([k, v]) => `${k}（${v}）`).join('，') || '无'}
`).join('\n');

    // 构建分析 prompt
    const analysisPrompt = `你是一个智能管道编排器。请分析用户消息，理解用户意图，然后组装执行管道。

## 可用能力列表
${capabilityText}

## 用户消息
"${userMessage}"

## 你的任务

1. **分析意图**：用自然语言描述用户想要什么（不要限定为固定类型，自由描述）
2. **选择能力**：从能力列表中选择需要的能力
3. **组装管道**：将能力组织成四个阶段的管道

## 管道阶段说明

- **preProcess（前置处理）**：准备上下文的能力，如记忆检索、人格加载。这些能力的输出会被注入到后续处理中。
- **coreProcess（核心处理）**：处理主要任务的能力。对于简单对话，可以为 null（由 LLM 直接处理）。
- **responseGenerate（响应生成）**：生成最终响应的能力。通常为 null（由 LLM 直接生成）。
- **postProcess（后置处理）**：收尾工作的能力，如记忆归档、关系更新。这些在响应返回后异步执行。

## 输出格式（严格的 JSON）

{
  "intentDescription": "用户意图的自然语言描述",
  "pipeline": {
    "preProcess": [
      { "capability": "能力名称", "params": { "参数名": "参数值" }, "reason": "选择这个能力的原因" }
    ],
    "coreProcess": null,
    "responseGenerate": null,
    "postProcess": [
      { "capability": "能力名称", "params": { "参数名": "参数值" }, "reason": "选择这个能力的原因" }
    ]
  }
}

## 示例

用户消息："丽丝，我回来了"

输出：
{
  "intentDescription": "用户想要和角色'丽丝'进行角色扮演对话，这是一个日常问候场景",
  "pipeline": {
    "preProcess": [
      { "capability": "memory_retriever", "params": { "query": "丽丝 对话 问候" }, "reason": "检索之前与丽丝的对话记忆，了解关系状态" },
      { "capability": "personality_loader", "params": { "character": "lisi" }, "reason": "加载丽丝的人格设定" }
    ],
    "coreProcess": null,
    "responseGenerate": null,
    "postProcess": [
      { "capability": "key_content_extractor", "params": { "extractTypes": "emotion,event" }, "reason": "提取对话中的关键信息" },
      { "capability": "memory_archiver", "params": { "importance": 5 }, "reason": "归档这次对话到记忆系统" }
    ]
  }
}

现在请分析用户消息并输出执行计划（只输出 JSON，不要其他内容）：`;

    // 简化实现：基于规则的意图分析
    // 后续可以改为调用 LLM
    return this.analyzeByRules(userMessage, capabilities);
  }

  /**
   * 基于规则的意图分析（简化实现，后续改为 LLM 版）
   * 
   * 核心逻辑：从用户消息中动态识别角色！
   * - "丽丝，我回来了" → 识别到"丽丝" → 加载丽丝人格
   * - "栗娜，帮我安排日程" → 识别到"栗娜" → 加载栗娜人格
   * - "你好" → 无特定角色 → 使用默认系统人格（栗娜）
   */
  private async analyzeByRules(userMessage: string, capabilities: CapabilityDescription[]): Promise<ExecutionPlan> {
    const plan: ExecutionPlan = {
      intentDescription: "",
      pipeline: {
        preProcess: [],
        coreProcess: null,
        responseGenerate: null,
        postProcess: [],
      },
    };

    // ========== 核心：从用户消息中动态识别角色 ==========
    // 从配置目录加载所有角色的 recognition 信息
    const characters = await this.loadCharacterRecognitionConfig();
    
    // 从用户消息中识别角色
    let detectedCharacter: { 
      id: string; 
      name: string; 
      isSystemPersona: boolean;
      matchType: 'name' | 'trigger' | 'context';
    } | null = null;
    
    const messageLower = userMessage.toLowerCase();
    
    for (const char of characters) {
      // 1. 首先检查角色名称（最高优先级）
      const foundName = char.recognition.names.find(name => 
        messageLower.includes(name.toLowerCase())
      );
      if (foundName) {
        detectedCharacter = { 
          id: char.id, 
          name: foundName, 
          isSystemPersona: char.isSystemPersona,
          matchType: 'name'
        };
        break;
      }
      
      // 2. 检查触发词（如果是系统人格）
      if (char.isSystemPersona && char.recognition.triggers) {
        const foundTrigger = char.recognition.triggers.find(trigger =>
          messageLower.includes(trigger.toLowerCase())
        );
        if (foundTrigger) {
          detectedCharacter = { 
            id: char.id, 
            name: char.displayName, 
            isSystemPersona: true,
            matchType: 'trigger'
          };
          // 不 break，继续检查是否有更精确的角色名匹配
        }
      }
    }

    // ========== 根据识别结果，组装不同的管道 ==========
    
    if (detectedCharacter) {
      // 识别到特定角色
      const matchDesc = detectedCharacter.matchType === 'name' 
        ? `从消息中识别到角色名"${detectedCharacter.name}"` 
        : `从消息中识别到触发词，使用系统人格"${detectedCharacter.name}"`;
      
      plan.intentDescription = `用户想要和"${detectedCharacter.name}"对话（${matchDesc}）`;
      
      // 前置处理：记忆检索 + 完整人格加载
      if (capabilities.some(c => c.name === "memory_retriever")) {
        plan.pipeline.preProcess.push({
          capability: "memory_retriever",
          params: { 
            query: `${detectedCharacter.name} 对话 互动`,
            // 如果是系统人格，也检索系统级记忆
            sources: detectedCharacter.isSystemPersona 
              ? ["memory", "sessions", "characters", "system"]
              : ["memory", "sessions", "characters"]
          },
          reason: `检索与${detectedCharacter.name}相关的记忆和上下文`,
        });
      }
      
      if (capabilities.some(c => c.name === "personality_loader")) {
        plan.pipeline.preProcess.push({
          capability: "personality_loader",
          params: { 
            character: detectedCharacter.id,
            loadKnowledge: true,
            loadCoreMemories: true,
          },
          reason: `加载${detectedCharacter.name}的完整人格配置（配置+档案+知识库+核心记忆）`,
        });
      }
      
      // 后置处理
      if (capabilities.some(c => c.name === "key_content_extractor")) {
        plan.pipeline.postProcess.push({
          capability: "key_content_extractor",
          params: { extractTypes: "emotion,event,decision,todo" },
          reason: "提取对话中的关键信息",
        });
      }
      
      if (capabilities.some(c => c.name === "memory_archiver")) {
        plan.pipeline.postProcess.push({
          capability: "memory_archiver",
          params: { 
            importance: detectedCharacter.isSystemPersona ? 5 : 6,
            // 归档到角色专属目录
            characterDir: `clawd/characters/${detectedCharacter.id}/memory/sessions`
          },
          reason: `归档对话到${detectedCharacter.name}的记忆系统`,
        });
      }
      
      // 只有虚拟世界角色才更新关系
      if (!detectedCharacter.isSystemPersona && capabilities.some(c => c.name === "relationship_updater")) {
        plan.pipeline.postProcess.push({
          capability: "relationship_updater",
          params: { character: detectedCharacter.id, intimacyDelta: 1 },
          reason: `更新与${detectedCharacter.name}的亲密度`,
        });
      }
    } else {
      // 未识别到特定角色 → 使用默认系统人格（栗娜）
      const defaultChar = characters.find(c => c.isSystemPersona) || { id: "lina", displayName: "栗娜" };
      
      plan.intentDescription = `用户进行普通对话或任务请求，使用默认系统人格"${defaultChar.displayName}"`;
      
      // 前置处理
      if (capabilities.some(c => c.name === "memory_retriever")) {
        plan.pipeline.preProcess.push({
          capability: "memory_retriever",
          params: { query: userMessage.substring(0, 100) },
          reason: "检索相关记忆作为上下文",
        });
      }
      
      // 加载默认系统人格
      if (capabilities.some(c => c.name === "personality_loader")) {
        plan.pipeline.preProcess.push({
          capability: "personality_loader",
          params: { 
            character: defaultChar.id,
            loadKnowledge: true,
            loadCoreMemories: false, // 普通对话不需要加载核心记忆
          },
          reason: `加载默认系统人格"${defaultChar.displayName}"`,
        });
      }
      
      // 后置处理
      if (capabilities.some(c => c.name === "memory_archiver")) {
        plan.pipeline.postProcess.push({
          capability: "memory_archiver",
          params: { importance: 3 },
          reason: "归档对话到记忆系统",
        });
      }
    }

    log.info(`[IntentAnalyzer] Intent: ${plan.intentDescription}`);
    if (detectedCharacter) {
      log.info(`[IntentAnalyzer] Detected: ${detectedCharacter.name} (${detectedCharacter.id}), matchType=${detectedCharacter.matchType}, isSystemPersona=${detectedCharacter.isSystemPersona}`);
    }
    log.debug(`[IntentAnalyzer] Pipeline: preProcess=${plan.pipeline.preProcess.length}, postProcess=${plan.pipeline.postProcess.length}`);
    
    return plan;
  }

  /**
   * 从 clawd/characters/ 目录加载所有角色的识别配置
   */
  private async loadCharacterRecognitionConfig(): Promise<Array<{
    id: string;
    displayName: string;
    isSystemPersona: boolean;
    recognition: {
      names: string[];
      triggers?: string[];
      contexts?: string[];
    };
  }>> {
    // 简化实现：从配置文件加载
    // 实际实现会扫描 clawd/characters/ 目录
    return [
      {
        id: "lina",
        displayName: "栗娜",
        isSystemPersona: true, // 系统人格化！
        recognition: {
          names: ["栗娜", "lina", "莉娜", "管家"],
          triggers: ["帮我", "安排", "提醒", "记住", "日程", "待办"],
          contexts: ["任务", "日程", "待办", "记忆", "提醒"]
        }
      },
      {
        id: "lisi",
        displayName: "丽丝",
        isSystemPersona: false, // 虚拟世界角色
        recognition: {
          names: ["丽丝", "lisi", "莉丝"],
          triggers: [], // 虚拟世界角色不响应通用触发词
          contexts: []
        }
      },
      // 可以从配置文件动态加载更多角色...
    ];
  }
}

/**
 * 创建意图分析器
 */
export function createIntentAnalyzer(config: IntentAnalyzerConfig): IntentAnalyzer {
  return new IntentAnalyzer(config);
}
```

#### 3.4 动态管道插件

**文件**：`src/agents/pipeline/plugin.ts`

```typescript
/**
 * 动态管道插件
 * 
 * 通过 hook 机制集成到现有的 runEmbeddedAttempt 流程
 * 
 * 设计原则：
 * 1. 复用现有 hook 机制，最小改动
 * 2. 在 before_agent_start 执行前置处理
 * 3. 在 agent_end 执行后置处理
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ClawdbotConfig } from "../../config/config.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookAgentEndEvent,
} from "../../plugins/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CapabilityPool, createDefaultCapabilityPool } from "./capability-pool.js";
import { createIntentAnalyzer, type IntentAnalyzer } from "./intent-analyzer.js";
import type { CapabilityExecuteParams, ExecutionPlan, PreProcessResult } from "./types.js";

const log = createSubsystemLogger("pipeline:plugin");

/**
 * 动态管道插件状态（按 sessionKey 存储）
 */
interface PipelineState {
  plan: ExecutionPlan;
  preProcessResults: Record<string, unknown>;
  startTime: number;
}

const pipelineStates = new Map<string, PipelineState>();

/**
 * 检查是否应该启用动态管道
 * 
 * 注意：不依赖 sessionKey 前缀！
 * 角色识别由 LLM 从用户消息中动态分析
 */
function shouldEnablePipeline(config: ClawdbotConfig): boolean {
  const pipelineConfig = (config as any).agents?.dynamicPipeline;
  return pipelineConfig?.enabled ?? false;
}

/**
 * before_agent_start hook 处理器
 * 
 * 职责：
 * 1. 分析用户意图
 * 2. 执行前置处理（记忆检索、人格加载等）
 * 3. 返回 prependContext 注入到 prompt
 */
export async function onBeforeAgentStart(
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeAgentStartResult | void> {
  const config = ctx.config as ClawdbotConfig | undefined;
  if (!config || !shouldEnablePipeline(config)) {
    return;
  }

  const started = Date.now();
  log.info(`[Pipeline] Starting pre-process for session: ${ctx.sessionKey}`);

  try {
    // 1. 创建能力池
    const capabilityPool = createDefaultCapabilityPool({
      agentId: ctx.agentId,
      sessionId: ctx.sessionKey ?? ctx.agentId,
      userId: undefined, // 从 ctx 中获取 userId（如果可用）
      config,
    });

    // 2. 创建意图分析器
    const intentAnalyzer = createIntentAnalyzer({ config, sessionKey: ctx.sessionKey });

    // 3. 分析意图并生成执行计划
    const plan = await intentAnalyzer.analyze({
      userMessage: event.prompt,
      conversationHistory: (event.messages as AgentMessage[]) || [],
      capabilities: capabilityPool.getDescriptions(),
    });

    log.info(`[Pipeline] Intent: ${plan.intentDescription}`);

    // 4. 执行前置处理
    const preProcessResults: Record<string, unknown> = {};
    const contextParts: string[] = [];

    for (const call of plan.pipeline.preProcess) {
      try {
        const execParams: CapabilityExecuteParams = {
          params: call.params,
          context: {
            userMessage: event.prompt,
            conversationHistory: (event.messages as AgentMessage[]) || [],
            sessionId: ctx.sessionKey ?? ctx.agentId,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            userId: undefined,
            config,
          },
          previousResults: preProcessResults,
        };

        const result = await capabilityPool.execute(call.capability, execParams);
        preProcessResults[call.capability] = result;

        // 构建上下文注入
        if (call.capability === "memory_retriever" && result) {
          const memResult = result as { formattedContext?: string };
          if (memResult.formattedContext) {
            contextParts.push(`## 相关记忆\n\n${memResult.formattedContext}`);
          }
        }

        if (call.capability === "personality_loader" && result) {
          const personality = result as { formattedPrompt?: string };
          if (personality.formattedPrompt) {
            contextParts.push(personality.formattedPrompt);
          }
        }

        log.debug(`[Pipeline] Pre-process ${call.capability} completed`);
      } catch (err) {
        log.warn(`[Pipeline] Pre-process ${call.capability} failed: ${err}`);
      }
    }

    // 5. 保存状态，供 agent_end 使用
    const stateKey = ctx.sessionKey ?? ctx.agentId;
    pipelineStates.set(stateKey, {
      plan,
      preProcessResults,
      startTime: started,
    });

    // 6. 返回结果
    const prependContext = contextParts.length > 0 ? contextParts.join("\n\n") : undefined;
    
    log.info(`[Pipeline] Pre-process completed in ${Date.now() - started}ms, context length: ${prependContext?.length ?? 0}`);

    return prependContext ? { prependContext } : undefined;

  } catch (err) {
    log.error(`[Pipeline] Pre-process failed: ${err}`);
    return;
  }
}

/**
 * agent_end hook 处理器
 * 
 * 职责：
 * 1. 执行后置处理（记忆归档、关系更新等）
 * 2. 清理状态
 */
export async function onAgentEnd(
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
): Promise<void> {
  const config = ctx.config as ClawdbotConfig | undefined;
  const stateKey = ctx.sessionKey ?? ctx.agentId;
  const state = pipelineStates.get(stateKey);

  if (!state || !config) {
    return;
  }

  log.info(`[Pipeline] Starting post-process for session: ${stateKey}`);

  try {
    // 1. 创建能力池（重新创建，保证状态隔离）
    const capabilityPool = createDefaultCapabilityPool({
      agentId: ctx.agentId,
      sessionId: stateKey,
      userId: undefined,
      config,
    });

    // 2. 执行后置处理
    for (const call of state.plan.pipeline.postProcess) {
      try {
        const execParams: CapabilityExecuteParams = {
          params: call.params,
          context: {
            userMessage: "", // agent_end 没有原始消息
            conversationHistory: (event.messages as AgentMessage[]) || [],
            sessionId: stateKey,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            userId: undefined,
            config,
          },
          previousResults: {
            ...state.preProcessResults,
            response: event.messages?.[event.messages.length - 1],
          },
        };

        await capabilityPool.execute(call.capability, execParams);
        log.debug(`[Pipeline] Post-process ${call.capability} completed`);
      } catch (err) {
        log.warn(`[Pipeline] Post-process ${call.capability} failed: ${err}`);
      }
    }

    const totalDuration = Date.now() - state.startTime;
    log.info(`[Pipeline] Post-process completed. Total pipeline duration: ${totalDuration}ms`);

  } catch (err) {
    log.error(`[Pipeline] Post-process failed: ${err}`);
  } finally {
    // 3. 清理状态
    pipelineStates.delete(stateKey);
  }
}

/**
 * 导出插件定义
 */
export const pipelinePlugin = {
  id: "clawdbot-pipeline",
  name: "Dynamic Pipeline Plugin",
  version: "1.0.0",
  hooks: [
    {
      hookName: "before_agent_start" as const,
      handler: onBeforeAgentStart,
      priority: 100, // 高优先级，确保先执行
    },
    {
      hookName: "agent_end" as const,
      handler: onAgentEnd,
      priority: 100,
    },
  ],
};
```

#### 3.5 注册插件

**修改文件**：`src/plugins/registry.ts`

在插件注册处添加：

```typescript
// 在适当位置导入
import { pipelinePlugin } from "../agents/pipeline/plugin.js";

// 在 createPluginRegistry 或初始化时注册
export function registerBuiltInPlugins(registry: PluginRegistry): void {
  // ... 其他内置插件 ...
  
  // 注册动态管道插件
  for (const hook of pipelinePlugin.hooks) {
    registry.registerHook({
      pluginId: pipelinePlugin.id,
      hookName: hook.hookName,
      handler: hook.handler,
      priority: hook.priority,
    });
  }
}
```

---

### 四、配置支持

### 四、角色系统设计（核心！）

#### 4.1 角色目录结构

每个角色都有完整的配置体系，不是简单的名称映射：

```
clawd/
└── characters/
    ├── lina/                          # 栗娜 - 系统人格化（特殊！）
    │   ├── config.json                # 功能配置、性格参数
    │   ├── profile.md                 # 角色卡（背景、性格、能力、互动风格）
    │   ├── memory/                    # 角色专属记忆目录
    │   │   ├── core-memories.md       # 核心记忆
    │   │   └── sessions/              # 会话归档
    │   ├── prompts/                   # 角色专属提示词
    │   │   ├── system.md              # 系统提示词模板
    │   │   └── scenarios/             # 场景提示词
    │   └── knowledge/                 # 角色专属知识库
    │       ├── capabilities.md        # 能力说明
    │       └── guidelines.md          # 交互指南
    │
    ├── lisi/                          # 丽丝 - 虚拟世界角色
    │   ├── config.json
    │   ├── profile.md
    │   ├── memory/
    │   ├── prompts/
    │   └── knowledge/
    │       ├── background.md          # 背景故事
    │       ├── personality.md         # 性格详设
    │       └── relationships.md       # 关系网络
    │
    └── {other-characters}/
```

#### 4.2 栗娜（Lina）- 系统人格化

**栗娜不是普通角色，她是整个系统的人格化！**

```
src/agents/lina/                       # 栗娜代码实现
├── agent.ts                           # LinaAgent 主类
├── config/
│   └── loader.ts                      # 配置加载器
├── prompts/
│   └── system-prompt-generator.ts     # System Prompt 生成器
├── routing/
│   └── capability-router.ts           # 能力路由器
├── managers/                          # 栗娜专属管理器
│   ├── reminder-manager.ts            # 提醒管理
│   └── schedule-manager.ts            # 日程管理
└── types.ts
```

**栗娜的能力等同于整个系统**：
- ✅ 任务管理（TaskDelegator）
- ✅ 记忆服务（MemoryService）
- ✅ 日程规划（ScheduleManager）
- ✅ 提醒器（ReminderManager）
- ✅ 任务委托（委托给执行层）
- ✅ 知识查询（从知识库检索）

#### 4.3 角色配置文件详解

**config.json 示例**（栗娜）：

```json
{
  "name": "lina",
  "displayName": "栗娜",
  "version": "1.0",
  "type": "system-persona",           // 系统人格化（特殊类型）
  "enabled": true,
  
  "recognition": {
    "names": ["栗娜", "lina", "莉娜", "管家"],
    "triggers": ["帮我", "安排", "提醒", "记住"],
    "contexts": ["任务", "日程", "待办", "记忆"]
  },
  
  "features": {
    "reminders": true,
    "taskManagement": true,
    "memoryManagement": true,
    "taskDelegation": true,
    "dailyPlanning": true,
    "knowledgeQuery": true
  },
  
  "systemPrompt": {
    "role": "管家助理 / 系统人格化",
    "personality": ["主动", "细心", "友好", "专业", "体贴"],
    "addressUser": "主人",
    "addressSelf": "栗娜"
  },
  
  "memory": {
    "directory": "clawd/characters/lina/memory",
    "coreMemoriesFile": "core-memories.md",
    "sessionArchiveDir": "sessions",
    "maxRetrievalResults": 10
  },
  
  "prompts": {
    "systemPromptTemplate": "clawd/characters/lina/prompts/system.md",
    "scenarioPrompts": "clawd/characters/lina/prompts/scenarios"
  },
  
  "knowledge": {
    "directory": "clawd/characters/lina/knowledge",
    "files": ["capabilities.md", "guidelines.md"]
  },
  
  "reminders": {
    "enabled": true,
    "checkInterval": 60000,
    "advanceNotice": 15
  }
}
```

**profile.md 示例**（栗娜角色卡）：

```markdown
# 栗娜（Lina）角色卡

## 基本信息
- **姓名**：栗娜（Lina）
- **角色**：管家助理 / 系统人格化
- **性别**：女性
- **年龄**：外表 25 岁左右

## 核心定位

**栗娜是整个 Clawdbot 系统的人格化体现**。
她不仅是用户的管家助理，更是系统所有能力的友好界面。

## 性格特征
- **主动**：不等用户开口，主动提醒和协助
- **细心**：注意细节，不遗漏重要事项
- **友好**：用温暖、礼貌的语气与用户交流
- **专业**：高效、可靠，像真正的管家一样
- **体贴**：理解用户的需求和习惯

## 核心能力

### 1. 日常事务管理
- 管理待办事项和日程安排
- 跟踪任务进度
- 提醒重要事项

### 2. 记忆管理
- 记住用户的对话和偏好
- 检索历史信息
- 总结重要话题

### 3. 任务委托
- 将技术操作委托给底层系统
- 跟踪委托任务的进度
- 报告任务结果

### 4. 智能提醒
- 定时提醒
- 提前提醒即将到期的任务
- 检测日程冲突
- 跟进长时间未完成的任务

## 对话风格
- 称呼用户为"主人"
- 自称"栗娜"
- 礼貌、温暖、专业
- 适当使用表情符号

## 工作原则
1. **主动服务**：不等用户开口，主动提醒和协助
2. **保护隐私**：妥善保管用户的信息和记忆
3. **高效执行**：快速响应用户请求
4. **友好沟通**：用温暖的语气让用户感到舒适
5. **持续学习**：记住用户的偏好和习惯
```

#### 4.4 动态管道中的角色加载

**能力池中的 `personality_loader` 需要加载完整的角色配置**：

```typescript
pool.register({
  name: "personality_loader",
  description: "加载角色的完整配置：人格设定、背景故事、说话风格、能力、知识库等",
  useCases: [
    "角色扮演前加载角色人格（如丽丝、栗娜等）",
    "需要特定角色风格回复时",
    "系统人格化（栗娜）需要访问系统能力时",
  ],
  parameters: {
    character: "角色ID（如 lina, lisi）",
  },
  execute: async (execParams) => {
    const characterName = execParams.params.character as string;
    if (!characterName) return null;

    // 1. 加载角色配置
    const config = await loadCharacterConfig(characterName, process.cwd());
    
    // 2. 加载角色档案
    const profile = await loadCharacterProfile(characterName, process.cwd());
    
    // 3. 加载角色知识库
    const knowledge = await loadCharacterKnowledge(characterName, process.cwd());
    
    // 4. 加载角色记忆
    const coreMemories = await loadCharacterCoreMemories(characterName, process.cwd());
    
    // 5. 生成完整的 System Prompt
    const systemPrompt = generateSystemPrompt({
      config,
      profile,
      knowledge,
      coreMemories,
      currentDate: new Date().toLocaleDateString("zh-CN"),
    });

    return {
      config,
      profile,
      knowledge,
      coreMemories,
      systemPrompt,
      
      // 特殊标记：是否是系统人格化
      isSystemPersona: config.type === "system-persona",
      
      // 可用能力列表（栗娜 = 全部能力）
      enabledFeatures: config.features,
    };
  },
});
```

#### 4.5 clawdbot.json 配置

```json
{
  "agents": {
    "dynamicPipeline": {
      "enabled": true,
      "charactersDir": "clawd/characters",
      "defaultCharacter": "lina",
      "systemPersona": "lina"
    },
    "list": [
      {
        "id": "main",
        "memory": {
          "retrieval": {
            "maxResults": 5,
            "minScore": 0.7,
            "sources": ["memory", "sessions", "characters"],
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
    ]
  }
}
```

**关键设计要点**：

1. **角色识别由 LLM 从用户消息中动态分析**（不依赖 sessionKey）
2. **每个角色都有完整的配置体系**（config.json + profile.md + memory/ + prompts/ + knowledge/）
3. **栗娜是系统人格化**，她的能力等同于整个系统
4. **角色配置集中在 clawd/characters/ 目录**，代码实现在 src/agents/
5. **personality_loader 加载完整的角色上下文**（配置 + 档案 + 知识 + 核心记忆）

---

### 五、测试计划

#### 5.1 单元测试

| 测试文件 | 测试内容 |
|----------|----------|
| `capability-pool.test.ts` | 能力注册、获取、执行 |
| `intent-analyzer.test.ts` | 意图分析、角色识别、计划生成 |
| `plugin.test.ts` | Hook 触发、状态管理 |

#### 5.2 集成测试

**核心：LLM 从用户消息中动态分析出和谁对话，不依赖 sessionKey 前缀！**

| 用户消息 | LLM 分析结果 | 管道行为 |
|----------|--------------|----------|
| "你好" | 普通对话，无特定角色 | 仅记忆检索/归档 |
| "丽丝，我回来了" | 用户想和丽丝对话 | 加载丽丝人格 + 记忆检索 + 关系更新 |
| "栗娜，帮我安排今天的日程" | 用户想和栗娜对话，任务请求 | 加载栗娜人格 + 任务分解 |
| "帮我重构这个文件" | 代码任务，无特定角色 | 记忆检索 + 任务执行 |
| "我今天好累啊" | 情绪表达，无特定角色 | 记忆检索 + 情绪分析 |

#### 5.3 验证命令

```bash
# 普通对话（LLM 分析：无特定角色）
pnpm clawdbot message send "你好"

# 角色扮演（LLM 分析：用户消息中提到"丽丝"→加载丽丝人格）
pnpm clawdbot message send "丽丝，我回来了"

# 角色扮演（LLM 分析：用户消息中提到"栗娜"→加载栗娜人格）
pnpm clawdbot message send "栗娜，今天好累"

# 任务请求（LLM 分析：代码任务，不需要角色人格）
pnpm clawdbot message send "帮我看看 src/agents 目录的代码结构"
```

**关键：sessionKey 只用于会话隔离，不决定角色！角色由 LLM 从用户消息中动态分析！**

---

### 六、实现计划

| 阶段 | 内容 | 工时 |
|------|------|------|
| Phase 1 | 类型定义 + 能力池 | 2h |
| Phase 2 | 意图分析器（规则版） | 2h |
| Phase 3 | 管道插件 + Hook 集成 | 3h |
| Phase 4 | 配置支持 + 测试 | 2h |
| Phase 5 | 文档更新 | 1h |
| **总计** | | **10h** |

---

## 核心实现：动态管道执行器（LLM 驱动）

### 1. 管道执行器（PipelineExecutor）

**文件**：`src/agents/pipeline/executor.ts`

**核心思想**：LLM 动态分析意图，动态选择能力，动态组装管道

```typescript
/**
 * 动态管道执行器
 * 
 * 核心流程：
 * 1. LLM 分析用户意图（不预设类型）
 * 2. LLM 动态选择需要的能力
 * 3. LLM 动态组装管道
 * 4. 按管道执行各能力
 * 5. 返回结果
 */

import type { ClawdbotConfig } from "../../config/config.js";
import type { LLMProvider } from "../butler/agent.js";
import { CapabilityPool, createDefaultCapabilityPool } from "./capability-pool.js";

export interface PipelineExecutorConfig {
  agentId: string;
  sessionId: string;
  userId?: string;
  config: ClawdbotConfig;
  llmProvider: LLMProvider;
}

export interface PipelineContext {
  userMessage: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

/**
 * LLM 分析后的执行计划
 */
export interface ExecutionPlan {
  /** 用户意图的自然语言描述（LLM 动态生成，不预设类型） */
  intentDescription: string;
  
  /** 管道阶段 */
  pipeline: {
    /** 前置处理：需要调用的能力列表 */
    preProcess: CapabilityCall[];
    /** 核心处理：需要调用的能力 */
    coreProcess: CapabilityCall;
    /** 响应生成：需要调用的能力 */
    responseGenerate: CapabilityCall;
    /** 后置处理：需要调用的能力列表 */
    postProcess: CapabilityCall[];
  };
}

export interface CapabilityCall {
  /** 能力名称 */
  capability: string;
  /** 能力参数（LLM 动态决定） */
  params: Record<string, unknown>;
  /** 说明（LLM 生成） */
  reason: string;
}

export class PipelineExecutor {
  private capabilityPool: CapabilityPool;

  constructor(
    private readonly config: PipelineExecutorConfig,
  ) {
    // 初始化能力池，注册所有可用能力
    this.capabilityPool = createDefaultCapabilityPool(config);
  }

  /**
   * 执行动态管道
   */
  async execute(context: PipelineContext): Promise<PipelineResult> {
    const started = Date.now();

    // 1. LLM 分析意图并生成执行计划（动态，不预设）
    const plan = await this.analyzeAndPlan(context);

    // 2. 执行前置处理
    const preProcessResults = await this.executeStage(
      plan.pipeline.preProcess,
      context,
      {},
    );

    // 3. 执行核心处理（使用前置处理的结果作为上下文）
    const coreResult = await this.executeCapability(
      plan.pipeline.coreProcess,
      context,
      preProcessResults,
    );

    // 4. 执行响应生成
    const response = await this.executeCapability(
      plan.pipeline.responseGenerate,
      context,
      { ...preProcessResults, coreResult },
    );

    // 5. 执行后置处理（异步，不阻塞响应）
    this.executeStage(
      plan.pipeline.postProcess,
      context,
      { ...preProcessResults, coreResult, response },
    ).catch((err) => {
      console.error("[PipelineExecutor] Post-process failed:", err);
    });

    return {
      response: response as string,
      trace: {
        intentDescription: plan.intentDescription,
        pipeline: plan.pipeline,
        durationMs: Date.now() - started,
      },
    };
  }

  /**
   * LLM 动态分析意图并生成执行计划
   * 
   * 关键：不预设意图类型，让 LLM 自由分析
   */
  private async analyzeAndPlan(context: PipelineContext): Promise<ExecutionPlan> {
    const capabilityDescriptions = this.capabilityPool.getDescriptions();

    const systemPrompt = `你是一个智能管道编排器。请分析用户消息，理解用户意图，然后组装执行管道。

## 可用能力列表

${capabilityDescriptions.map(d => `
### ${d.name}
- 描述: ${d.description}
- 使用场景: ${d.useCases.join(', ')}
- 参数: ${JSON.stringify(d.parameters)}
`).join('\n')}

## 你的任务

1. 分析用户消息，用自然语言描述用户的意图（不要限定为固定类型）
2. 根据意图，从能力列表中选择需要的能力
3. 将能力组装成管道：
   - 前置处理（preProcess）: 准备上下文的能力（如记忆检索、人格加载等）
   - 核心处理（coreProcess）: 处理主要任务的能力
   - 响应生成（responseGenerate）: 生成最终响应的能力
   - 后置处理（postProcess）: 收尾工作的能力（如记忆归档、关系更新等）

## 输出格式（JSON）

{
  "intentDescription": "用户意图的自然语言描述",
  "pipeline": {
    "preProcess": [
      { "capability": "能力名称", "params": { ... }, "reason": "为什么需要这个能力" }
    ],
    "coreProcess": { "capability": "能力名称", "params": { ... }, "reason": "..." },
    "responseGenerate": { "capability": "能力名称", "params": { ... }, "reason": "..." },
    "postProcess": [
      { "capability": "能力名称", "params": { ... }, "reason": "..." }
    ]
  }
}`;

    const response = await this.config.llmProvider.chat({
      systemPrompt,
      messages: context.conversationHistory || [],
      userMessage: context.userMessage,
    });

    return JSON.parse(response);
  }

  /**
   * 执行管道阶段
   */
  private async executeStage(
    calls: CapabilityCall[],
    context: PipelineContext,
    previousResults: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    for (const call of calls) {
      results[call.capability] = await this.executeCapability(
        call,
        context,
        { ...previousResults, ...results },
      );
    }

    return results;
  }

  /**
   * 执行单个能力
   */
  private async executeCapability(
    call: CapabilityCall,
    context: PipelineContext,
    previousResults: Record<string, unknown>,
  ): Promise<unknown> {
    const capability = this.capabilityPool.get(call.capability);
    if (!capability) {
      throw new Error(`Capability not found: ${call.capability}`);
    }

    // 合并参数：LLM 指定的参数 + 上下文 + 前序结果
    const params = {
      ...call.params,
      _context: context,
      _previousResults: previousResults,
    };

    return capability.execute(params);
  }
}

export interface PipelineResult {
  response: string;
  trace: {
    intentDescription: string;
    pipeline: ExecutionPlan['pipeline'];
    durationMs: number;
  };
}
```

### 2. 能力池（CapabilityPool）

**文件**：`src/agents/pipeline/capability-pool.ts`

```typescript
/**
 * 能力池
 * 
 * 注册所有可用能力，供 LLM 动态选择
 */

import type { ClawdbotConfig } from "../../config/config.js";
import { createMemoryService, resolveMemoryServiceConfig } from "../memory/service.js";
import { loadCharacterConfig, loadCharacterProfile } from "../lina/config/loader.js";
import { generateSessionSummary } from "../session-summary.js";

export interface Capability {
  name: string;
  description: string;
  useCases: string[];
  parameters: Record<string, unknown>;
  execute(params: unknown): Promise<unknown>;
}

export interface CapabilityDescription {
  name: string;
  description: string;
  useCases: string[];
  parameters: Record<string, unknown>;
}

export class CapabilityPool {
  private capabilities = new Map<string, Capability>();

  register(capability: Capability): void {
    this.capabilities.set(capability.name, capability);
  }

  get(name: string): Capability | undefined {
    return this.capabilities.get(name);
  }

  getDescriptions(): CapabilityDescription[] {
    return Array.from(this.capabilities.values()).map(c => ({
      name: c.name,
      description: c.description,
      useCases: c.useCases,
      parameters: c.parameters,
    }));
  }
}

/**
 * 创建默认能力池，注册所有已实现的能力
 */
export function createDefaultCapabilityPool(config: {
  agentId: string;
  sessionId: string;
  userId?: string;
  config: ClawdbotConfig;
}): CapabilityPool {
  const pool = new CapabilityPool();

  // 注册记忆检索能力（复用 MemoryService）
  const memoryConfig = resolveMemoryServiceConfig(config.config, config.agentId);
  const memoryService = memoryConfig
    ? createMemoryService(memoryConfig, config.config)
    : null;

  if (memoryService) {
    pool.register({
      name: "memory_retriever",
      description: "从长期记忆系统中检索相关的对话记忆、会话总结或重要信息",
      useCases: [
        "在角色扮演前检索之前的对话记忆",
        "在执行任务前检索相关的经验教训",
        "在回答问题时检索相关的知识记忆",
      ],
      parameters: {
        query: "检索关键词",
        maxResults: "最大结果数（默认5）",
        minScore: "最小相关性分数（默认0.7）",
      },
      execute: async (params: any) => {
        return memoryService.retrieve({
          query: params.query || params._context?.userMessage || "",
          context: {
            userId: config.userId ?? "default",
            sessionId: config.sessionId,
            agentId: config.agentId,
          },
          params: {
            maxResults: params.maxResults,
            minScore: params.minScore,
          },
        });
      },
    });

    pool.register({
      name: "memory_archiver",
      description: "将对话总结归档到长期记忆系统",
      useCases: [
        "对话结束后归档重要内容",
        "保存任务执行经验",
        "记录关键决策和原因",
      ],
      parameters: {
        content: "要归档的内容",
        importance: "重要性（1-10）",
      },
      execute: async (params: any) => {
        const summary = params._previousResults?.session_summarizer || 
          generateSessionSummary([
            { role: "user", content: params._context?.userMessage },
            { role: "assistant", content: params._previousResults?.response },
          ] as any);
        
        if (!summary) return { archived: false };

        return memoryService.archive({
          summary,
          context: {
            userId: config.userId ?? "default",
            sessionId: config.sessionId,
            agentId: config.agentId,
          },
        });
      },
    });
  }

  // 注册人格加载能力（复用 LinaAgent 的配置加载）
  pool.register({
    name: "personality_loader",
    description: "加载角色的人格设定、背景故事和说话风格",
    useCases: [
      "角色扮演前加载角色人格",
      "需要特定角色风格回复时",
    ],
    parameters: {
      character: "角色名称（如 lina, lisi）",
    },
    execute: async (params: any) => {
      const characterName = params.character;
      if (!characterName) return null;

      const [charConfig, profile] = await Promise.all([
        loadCharacterConfig(characterName, process.cwd()),
        loadCharacterProfile(characterName, process.cwd()),
      ]);

      return { config: charConfig, profile };
    },
  });

  // 注册会话总结能力
  pool.register({
    name: "session_summarizer",
    description: "生成对话的总结，提取关键信息",
    useCases: [
      "对话结束后生成总结",
      "提取对话中的关键决策和任务",
    ],
    parameters: {},
    execute: async (params: any) => {
      const messages = [
        ...(params._context?.conversationHistory || []),
        { role: "user", content: params._context?.userMessage },
        { role: "assistant", content: params._previousResults?.coreResult },
      ];
      return generateSessionSummary(messages as any);
    },
  });

  // 注册 LLM 对话能力（用于核心处理和响应生成）
  pool.register({
    name: "llm_chat",
    description: "调用 LLM 进行对话，可以注入人格和上下文",
    useCases: [
      "生成角色扮演响应",
      "处理用户问题",
      "生成任务执行计划",
    ],
    parameters: {
      systemPromptOverride: "自定义 System Prompt（可选）",
      temperature: "温度（可选）",
    },
    execute: async (params: any) => {
      // 从前序结果构建上下文
      const personality = params._previousResults?.personality_loader;
      const memories = params._previousResults?.memory_retriever;

      let systemPrompt = params.systemPromptOverride || "";

      // 注入人格
      if (personality?.profile) {
        systemPrompt += `\n\n## 角色设定\n${personality.profile}`;
      }

      // 注入记忆
      if (memories?.formattedContext) {
        systemPrompt += `\n\n${memories.formattedContext}`;
      }

      // 这里需要实际调用 LLM，简化处理返回占位符
      // 实际实现会调用 config.llmProvider.chat()
      return `[LLM Response based on context]`;
    },
  });

  // 注册关键内容提取能力
  pool.register({
    name: "key_content_extractor",
    description: "从对话中提取关键信息（情感、事件、决策等）",
    useCases: [
      "角色扮演后提取用户情绪和角色反应",
      "任务完成后提取关键决策",
    ],
    parameters: {
      extractTypes: "要提取的类型（emotion, event, decision, todo）",
    },
    execute: async (params: any) => {
      // 简化实现，实际会调用 LLM 提取
      return {
        emotion: "extracted emotion",
        events: [],
        decisions: [],
      };
    },
  });

  // 注册关系更新能力
  pool.register({
    name: "relationship_updater",
    description: "更新用户与角色的关系状态",
    useCases: [
      "角色扮演后更新亲密度",
      "记录重要互动",
    ],
    parameters: {
      character: "角色名称",
      intimacyDelta: "亲密度变化",
    },
    execute: async (params: any) => {
      // 简化实现
      return { updated: true };
    },
  });

  return pool;
}
```

### 3. 集成到 runEmbeddedAttempt

**文件**：`src/agents/pi-embedded-runner/run/attempt.ts`

```typescript
// 在 runEmbeddedAttempt 函数开头添加

import { PipelineExecutor } from "../../pipeline/executor.js";

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  
  // ========== 新增：动态管道执行 ==========
  
  // 检查是否启用动态管道模式
  const useDynamicPipeline = params.config?.agents?.dynamicPipeline?.enabled ?? false;
  
  if (useDynamicPipeline) {
    // 创建管道执行器
    const executor = new PipelineExecutor({
      agentId: params.sessionId ?? "main",
      sessionId: params.sessionId ?? `session-${Date.now()}`,
      userId: params.messageTo,
      config: params.config,
      llmProvider: /* 从现有代码获取 LLM Provider */,
    });
    
    // 执行动态管道（LLM 分析意图 → 动态组装 → 执行）
    const pipelineResult = await executor.execute({
      userMessage: params.prompt,
      conversationHistory: /* 从 session 获取历史 */,
    });
    
    return {
      payloads: [{ text: pipelineResult.response }],
      meta: {
        durationMs: pipelineResult.trace.durationMs,
        pipelineTrace: pipelineResult.trace,
      },
    };
  }
  
  // ========== 现有逻辑（保持不变） ==========
  // ...
}
```

---

## 配置支持

在 `clawdbot.json` 中添加：

```json
{
  "agents": {
    "dynamicPipeline": {
      "enabled": true,
      "capabilities": {
        "memory": true,
        "personality": true,
        "taskDelegation": true
      }
    }
  }
}
```

---

## 总结

### 核心设计思想

**从"静态分层"到"动态管道"**

```
旧设计（静态分层）：
虚拟世界层 → 管家层 → 任务调度层 → 执行层
↑ 功能孤立，难以协作

新设计（动态管道）：
用户消息 → [意图分析] → [动态组装管道] → [执行管道] → 响应
                              │
                              ▼
                      ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
                      │ 前置处理 │ → │ 核心处理 │ → │ 响应生成 │ → │ 后置处理 │
                      └──────────┘   └──────────┘   └──────────┘   └──────────┘
                              │              │              │              │
                              └──────────────┴──────────────┴──────────────┘
                                                    │
                                              能力池（按需调用）
```

### 设计原则

1. **LLM 驱动**：不预设意图类型，LLM 动态分析意图、选择能力、组装管道
2. **能力池模式**：所有功能模块注册到能力池，供管道按需调用
3. **复用优先**：利用现有 hook 机制、MemoryService、LinaAgent 等，不重复造轮子
4. **最小改动**：通过插件机制集成，不修改核心执行逻辑
5. **渐进式集成**：先实现规则版意图分析，后续迭代为 LLM 版

### 与旧设计的对比

| 特性 | 旧设计（静态分层） | 新设计（动态管道） |
|------|-------------------|-------------------|
| 设计思维 | 以层次为核心 | 以用户交互流程为核心 |
| 功能组织 | 孤立在不同层 | 按需组合在管道中 |
| 调用方式 | 固定的层次调用 | 动态组装和执行 |
| 意图识别 | 硬编码类型枚举 | LLM 动态分析，不预设类型 |
| 能力选择 | 预设组合 | LLM 动态选择 |
| 扩展性 | 需要修改层次结构 | 只需注册新能力到能力池 |
| 集成方式 | 需要改动核心代码 | 通过 hook 插件集成 |

### 实现方案亮点

1. **利用现有 Hook 机制**
   - `before_agent_start`：注入记忆上下文和人格提示
   - `agent_end`：执行记忆归档和关系更新
   - 不修改 `runEmbeddedAttempt` 核心逻辑

2. **复用现有组件**
   - `MemoryService`：直接调用 `retrieve()` 和 `archive()`
   - `LinaAgent`：通过 `loadCharacterConfig()` 获取人格配置
   - `generateSessionSummary()`：生成会话总结
   - `buildEmbeddedSystemPrompt()`：已支持 `agentLayer` 参数

3. **配置驱动**
   - 通过 `clawdbot.json` 启用/禁用动态管道
   - **角色识别由 LLM 从用户消息中动态分析，不依赖 sessionKey 前缀**
   - 不影响现有默认行为

### 改动范围

| 类型 | 文件 | 改动量 |
|------|------|--------|
| 新增 | `src/agents/pipeline/types.ts` | ~80 行 |
| 新增 | `src/agents/pipeline/capability-pool.ts` | ~250 行 |
| 新增 | `src/agents/pipeline/intent-analyzer.ts` | ~150 行 |
| 新增 | `src/agents/pipeline/plugin.ts` | ~300 行 |
| 修改 | `src/plugins/registry.ts` | +5 行 |
| **总计** | | **~785 行新增，5 行修改** |

### 预期效果

✅ **动态管道架构**：用户交互通过动态组装的管道处理  
✅ **能力池复用**：现有组件（MemoryService、LinaAgent 等）作为能力注册  
✅ **LLM 动态识别角色**：从用户消息中识别 "丽丝"/"栗娜" 等角色名，自动加载对应人格  
✅ **记忆系统自动集成**：在管道的前置/后置处理中自动调用  
✅ **不影响现有行为**：默认行为不变，只有配置启用时才触发管道  

**关键：角色由 LLM 从用户消息动态分析，不依赖任何硬编码规则！**  

### 后续迭代方向

1. **Phase 2**：将规则版意图分析升级为 LLM 版
2. **Phase 3**：支持更多能力（任务分解、进度跟踪等）
3. **Phase 4**：支持管道的动态调整（基于中间结果）
4. **Phase 5**：支持跨会话的管道状态持久化

---

**版本**：v3.2  
**创建时间**：2026-02-02  
**作者**：Clawdbot AI Assistant  
**状态**：详细施工方案完成，可以开始实现
