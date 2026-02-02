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

## 基于现有代码的实现方案

### 现有代码资产（复用，不造轮子）

| 组件 | 文件位置 | 状态 | 作为能力 |
|------|----------|------|----------|
| `MemoryService` | `src/agents/memory/service.ts` | ✅ 已实现 | `memory_retriever`, `memory_archiver` |
| `LinaAgent` | `src/agents/lina/agent.ts` | ✅ 已实现 | `personality_loader` |
| `generateSessionSummary` | `src/agents/session-summary.ts` | ✅ 已实现 | `session_summarizer` |
| `TaskDelegator` | `src/agents/butler/task-delegator.ts` | ✅ 已实现 | `task_delegator` |
| Pi Tools | `src/agents/pi-tools.ts` | ✅ 已实现 | `tool_executor` |

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

1. **动态管道架构**：每个用户交互是一条动态组装的管道
2. **能力池**：所有功能模块注册到能力池，供管道按需调用
3. **LLM 驱动**：不预设规则，LLM 动态分析意图、选择能力、组装管道
4. **端到端流程**：前置处理 → 核心处理 → 响应生成 → 后置处理

### 与旧设计的对比

| 特性 | 旧设计（静态分层） | 新设计（动态管道） |
|------|-------------------|-------------------|
| 设计思维 | 以层次为核心 | 以用户交互流程为核心 |
| 功能组织 | 孤立在不同层 | 按需组合在管道中 |
| 调用方式 | 固定的层次调用 | 动态组装和执行 |
| 意图识别 | 硬编码类型枚举 | LLM 动态分析，不预设类型 |
| 能力选择 | 预设组合 | LLM 动态选择 |
| 扩展性 | 需要修改层次结构 | 只需注册新能力到能力池 |

### 实现原则

1. **复用现有代码**：不重复造轮子
2. **最小改动**：只改动必要的地方
3. **渐进式集成**：先让基础功能工作，再迭代优化
4. **配置驱动**：通过 sessionKey 前缀或 config 控制行为

### 改动范围

- **新增文件**：2 个（`coordinator.ts`, 扩展 `layer-resolver.ts`）
- **改动文件**：1 个（`attempt.ts`）
- **改动代码量**：约 200 行新增，30 行改动

### 预期效果

- **动态管道架构**：用户交互通过动态组装的管道处理
- **能力池复用**：现有组件（MemoryService、LinaAgent 等）作为能力注册
- **LinaAgent 有了调用入口**：通过 sessionKey 前缀或 config 启用
- **记忆系统自动集成**：在管道的前置/后置处理中自动调用
- **不影响现有行为**：默认执行层行为不变

---

**版本**：v3.1  
**创建时间**：2026-02-02  
**作者**：Clawdbot AI Assistant  
**状态**：设计完成，待实现
