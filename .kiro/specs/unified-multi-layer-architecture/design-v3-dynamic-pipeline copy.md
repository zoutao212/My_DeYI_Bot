# Clawdbot 动态管道架构 v3.1 - 基于现有代码的集成方案

## 核心理念：复用现有代码，快速实现新架构

### 现有代码资产

已实现的核心组件（**复用，不重复造轮子**）：

| 组件 | 文件位置 | 状态 | 用途 |
|------|----------|------|------|
| `runEmbeddedPiAgent` | `src/agents/pi-embedded-runner/run.ts` | ✅ 已实现 | Agent 运行入口 |
| `runEmbeddedAttempt` | `src/agents/pi-embedded-runner/run/attempt.ts` | ✅ 已实现 | 单次执行尝试 |
| `buildEmbeddedSystemPrompt` | `src/agents/pi-embedded-runner/system-prompt.ts` | ✅ 已实现 | System Prompt 生成，支持 `agentLayer` |
| `ButlerAgent` | `src/agents/butler/agent.ts` | ✅ 已实现 | 管家层，含记忆填充/归档 |
| `LinaAgent` | `src/agents/lina/agent.ts` | ✅ 已实现 | 人格化 Agent（**缺少调用入口**） |
| `MemoryService` | `src/agents/memory/service.ts` | ✅ 已实现 | 记忆检索/归档 |
| `TaskDelegator` | `src/agents/butler/task-delegator.ts` | ✅ 已实现 | 任务委托 |

### 核心问题

1. **LinaAgent 没有调用入口**：完全独立，无法集成到 `runEmbeddedPiAgent`
2. **管家层未真正启用**：`buildEmbeddedSystemPrompt` 支持 `agentLayer='butler'`，但 `runEmbeddedAttempt` 没有调用 `ButlerAgent`
3. **功能孤立**：各组件独立实现，缺少协调器

---

## 架构设计：最小改动，快速集成

### 核心改动点

```
                           ┌─────────────────────────────────────┐
                           │        runEmbeddedPiAgent           │
                           │      (现有入口，不改动)              │
                           └─────────────────────────────────────┘
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         runEmbeddedAttempt                                   │
│                       (需要小改动：集成管家层)                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  新增：resolveAgentLayer()                                           │  │
│   │  - 根据 sessionKey/config 决定使用哪个层                              │  │
│   │  - 'butler' → 启用管家层协调                                         │  │
│   │  - 'virtual-world' → 纯角色扮演                                      │  │
│   │  - 'execution' → 默认，当前行为（不变）                               │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  新增：if (layer === 'butler') { ... }                               │  │
│   │  - 初始化 ButlerCoordinator                                          │  │
│   │  - 调用 coordinator.beforeConversation() ← 记忆检索                  │  │
│   │  - 注入记忆上下文到 systemPrompt                                     │  │
│   │  - 执行原有逻辑                                                       │  │
│   │  - 调用 coordinator.afterConversation() ← 记忆归档                   │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  现有：buildEmbeddedSystemPrompt()                                   │  │
│   │  - 已支持 agentLayer 参数 ✅                                         │  │
│   │  - 已支持 characterName 参数 ✅                                      │  │
│   │  - 只需传入正确的参数                                                 │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 实现方案：三个新增文件 + 一个小改动

### 1. 新增：ButlerCoordinator（管家层协调器）

**文件**：`src/agents/butler/coordinator.ts`

**职责**：协调管家层的生命周期，复用现有组件

```typescript
/**
 * 管家层协调器
 * 
 * 复用现有组件：
 * - MemoryService: 记忆检索/归档
 * - LinaAgent: 人格化（可选）
 * - ButlerAgent: 意图理解、任务委托（可选）
 */

import type { ClawdbotConfig } from "../../config/config.js";
import type { IMemoryService, MemoryRetrievalResult } from "../memory/types.js";
import { createMemoryService, resolveMemoryServiceConfig } from "../memory/service.js";
import { createLinaAgent, type LinaAgent } from "../lina/agent.js";
import { generateSessionSummary } from "../session-summary.js";

export interface ButlerCoordinatorConfig {
  agentId: string;
  sessionId: string;
  userId?: string;
  characterName?: string;  // 如 "lina"，用于加载人格
  enableMemory?: boolean;  // 是否启用记忆系统
  enableTaskDelegation?: boolean;  // 是否启用任务委托
}

export interface CoordinationContext {
  userMessage: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

export interface BeforeConversationResult {
  /** 记忆检索结果 */
  memories?: MemoryRetrievalResult;
  /** 格式化的记忆上下文（注入到 System Prompt） */
  memoryContext?: string;
  /** 人格化 System Prompt（如果启用了角色） */
  characterSystemPrompt?: string;
}

export interface AfterConversationResult {
  /** 是否成功归档 */
  archived: boolean;
  /** 归档路径 */
  archivePath?: string;
}

export class ButlerCoordinator {
  private memoryService: IMemoryService | null = null;
  private linaAgent: LinaAgent | null = null;

  constructor(
    private readonly config: ButlerCoordinatorConfig,
    private readonly clawdbotConfig: ClawdbotConfig,
  ) {}

  /**
   * 初始化协调器
   */
  async initialize(): Promise<void> {
    // 1. 初始化记忆服务（复用 MemoryService）
    if (this.config.enableMemory !== false) {
      const memoryConfig = resolveMemoryServiceConfig(
        this.clawdbotConfig,
        this.config.agentId,
      );
      if (memoryConfig) {
        this.memoryService = createMemoryService(memoryConfig, this.clawdbotConfig);
      }
    }

    // 2. 初始化人格化 Agent（复用 LinaAgent）
    if (this.config.characterName) {
      this.linaAgent = await createLinaAgent({
        characterName: this.config.characterName,
        basePath: process.cwd(),
        memoryService: this.memoryService ?? undefined,
      });
    }
  }

  /**
   * 对话前处理（记忆检索）
   * 
   * 复用 MemoryService.retrieve()
   */
  async beforeConversation(
    context: CoordinationContext,
  ): Promise<BeforeConversationResult> {
    const result: BeforeConversationResult = {};

    // 1. 记忆检索（复用 MemoryService）
    if (this.memoryService) {
      try {
        const memories = await this.memoryService.retrieve({
          query: context.userMessage,
          context: {
            userId: this.config.userId ?? "default",
            sessionId: this.config.sessionId,
            agentId: this.config.agentId,
            layer: "butler",
          },
        });

        if (memories.memories.length > 0) {
          result.memories = memories;
          result.memoryContext = memories.formattedContext;
        }
      } catch (error) {
        console.error("[ButlerCoordinator] Memory retrieval failed:", error);
      }
    }

    // 2. 获取人格化 System Prompt（复用 LinaAgent）
    if (this.linaAgent) {
      result.characterSystemPrompt = this.linaAgent.getSystemPrompt();
    }

    return result;
  }

  /**
   * 对话后处理（记忆归档）
   * 
   * 复用 MemoryService.archive() 和 generateSessionSummary()
   */
  async afterConversation(
    context: CoordinationContext,
    response: string,
  ): Promise<AfterConversationResult> {
    if (!this.memoryService) {
      return { archived: false };
    }

    try {
      // 生成会话总结（复用 generateSessionSummary）
      const messages = [
        ...(context.conversationHistory || []),
        { role: "user", content: context.userMessage },
        { role: "assistant", content: response },
      ];
      
      const summary = generateSessionSummary(messages as any);
      
      if (!summary) {
        return { archived: false };
      }

      // 异步归档（复用 MemoryService.archive）
      const archiveResult = await this.memoryService.archive({
        summary,
        context: {
          userId: this.config.userId ?? "default",
          sessionId: this.config.sessionId,
          agentId: this.config.agentId,
        },
      });

      return {
        archived: archiveResult.success,
        archivePath: archiveResult.path,
      };
    } catch (error) {
      console.error("[ButlerCoordinator] Memory archival failed:", error);
      return { archived: false };
    }
  }

  /**
   * 获取 Lina Agent（用于人格化响应）
   */
  getLinaAgent(): LinaAgent | null {
    return this.linaAgent;
  }

  /**
   * 获取记忆服务
   */
  getMemoryService(): IMemoryService | null {
    return this.memoryService;
  }
}

/**
 * 创建管家层协调器
 */
export async function createButlerCoordinator(
  config: ButlerCoordinatorConfig,
  clawdbotConfig: ClawdbotConfig,
): Promise<ButlerCoordinator> {
  const coordinator = new ButlerCoordinator(config, clawdbotConfig);
  await coordinator.initialize();
  return coordinator;
}
```

### 2. 新增：层级解析器

**文件**：`src/agents/multi-layer/layer-resolver.ts`（已存在，需扩展）

```typescript
/**
 * Agent 层级解析器
 * 
 * 根据 sessionKey/config/params 决定使用哪个层
 */

export type AgentLayer = 'virtual-world' | 'butler' | 'execution';

export interface LayerResolverParams {
  sessionKey?: string;
  config?: ClawdbotConfig;
  agentId?: string;
  explicitLayer?: AgentLayer;
}

/**
 * 解析 Agent 层级
 * 
 * 优先级：
 * 1. explicitLayer（显式指定）
 * 2. sessionKey 前缀（如 "butler:xxx", "lina:xxx", "lisi:xxx"）
 * 3. config 中的默认配置
 * 4. 默认 'execution'
 */
export function resolveAgentLayer(params: LayerResolverParams): AgentLayer {
  // 1. 显式指定
  if (params.explicitLayer) {
    return params.explicitLayer;
  }

  // 2. 从 sessionKey 推断
  const sessionKey = params.sessionKey?.toLowerCase();
  if (sessionKey) {
    if (sessionKey.startsWith("butler:") || sessionKey.startsWith("lina:")) {
      return "butler";
    }
    if (sessionKey.startsWith("lisi:") || sessionKey.startsWith("aili:")) {
      return "virtual-world";
    }
  }

  // 3. 从 config 读取默认层
  const agentCfg = params.config?.agents?.list?.find(
    (a) => a.id === params.agentId,
  );
  if (agentCfg?.defaultLayer) {
    return agentCfg.defaultLayer as AgentLayer;
  }

  // 4. 默认执行层
  return "execution";
}

/**
 * 从 sessionKey 解析角色名
 */
export function resolveCharacterFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  
  const lower = sessionKey.toLowerCase();
  
  // "lina:xxx" → "lina"
  // "lisi:xxx" → "lisi"
  const match = lower.match(/^(lina|lisi|aili|butler):(.+)$/);
  if (match) {
    return match[1];
  }
  
  return undefined;
}
```

### 3. 改动：runEmbeddedAttempt（最小改动）

**文件**：`src/agents/pi-embedded-runner/run/attempt.ts`

**改动范围**：约 30 行新增代码

```typescript
// 在 runEmbeddedAttempt 函数开头添加

import { resolveAgentLayer, resolveCharacterFromSessionKey } from "../../multi-layer/layer-resolver.js";
import { createButlerCoordinator, type ButlerCoordinator } from "../../butler/coordinator.js";

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  // ========== 新增：管家层集成 ==========
  
  // 1. 解析 Agent 层级
  const agentLayer = resolveAgentLayer({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.sessionId,
    explicitLayer: params.agentLayer,  // 新增参数
  });
  
  // 2. 解析角色名（用于人格化）
  const characterName = resolveCharacterFromSessionKey(params.sessionKey);
  
  // 3. 如果是管家层，初始化协调器
  let butlerCoordinator: ButlerCoordinator | null = null;
  let beforeResult: { memoryContext?: string; characterSystemPrompt?: string } | null = null;
  
  if (agentLayer === 'butler') {
    butlerCoordinator = await createButlerCoordinator({
      agentId: params.sessionId ?? "main",
      sessionId: params.sessionId ?? `session-${Date.now()}`,
      userId: params.messageTo,
      characterName,
      enableMemory: true,
    }, params.config);
    
    // 对话前处理（记忆检索）
    beforeResult = await butlerCoordinator.beforeConversation({
      userMessage: params.prompt,
    });
  }
  
  // ========== 现有逻辑 ==========
  
  // ... 现有的 buildEmbeddedSystemPrompt 调用 ...
  
  const systemPrompt = await buildEmbeddedSystemPrompt({
    // ... 现有参数 ...
    agentLayer,  // 传入层级
    characterName,  // 传入角色名
    // 新增：注入记忆上下文
    extraSystemPrompt: [
      params.extraSystemPrompt,
      beforeResult?.memoryContext,
      beforeResult?.characterSystemPrompt,
    ].filter(Boolean).join("\n\n") || undefined,
  });
  
  // ... 执行 Agent 的现有逻辑 ...
  
  // ========== 新增：对话后处理 ==========
  
  if (butlerCoordinator && !aborted) {
    // 异步归档（不阻塞响应）
    butlerCoordinator.afterConversation({
      userMessage: params.prompt,
    }, assistantTexts.join("\n")).catch((err) => {
      console.error("[runEmbeddedAttempt] Memory archival failed:", err);
    });
  }
  
  // ... 现有的返回逻辑 ...
}
```

---

## 配置支持

### 新增配置项

在 `clawdbot.json` 中添加：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "defaultLayer": "execution",  // 默认层级
        "memory": {
          "retrieval": {
            "maxResults": 5,
            "minScore": 0.7,
            "timeoutMs": 5000
          },
          "archival": {
            "strategy": "threshold",
            "frequency": 5
          }
        }
      }
    ]
  }
}
```

### sessionKey 前缀约定

| 前缀 | 层级 | 角色 | 示例 |
|------|------|------|------|
| `butler:` | butler | 无 | `butler:user123` |
| `lina:` | butler | lina | `lina:user123` |
| `lisi:` | virtual-world | lisi | `lisi:user123` |
| `aili:` | virtual-world | aili | `aili:user123` |
| 无前缀 | execution | 无 | `user123` |

---

## 流程示例

### 示例 1：管家层对话（带记忆）

**用户消息**：`lina:peter` → "栗娜，帮我看看上次我们讨论的项目进度"

```
1. resolveAgentLayer() → 'butler'
2. resolveCharacterFromSessionKey() → 'lina'
3. createButlerCoordinator({ characterName: 'lina', enableMemory: true })
4. coordinator.beforeConversation()
   ├─ memoryService.retrieve() → 检索相关记忆
   └─ linaAgent.getSystemPrompt() → 获取人格 Prompt
5. buildEmbeddedSystemPrompt({ agentLayer: 'butler', characterName: 'lina' })
   ├─ 注入记忆上下文
   └─ 注入人格 Prompt
6. 执行 Agent（现有逻辑）
7. coordinator.afterConversation()
   ├─ generateSessionSummary()
   └─ memoryService.archive()
```

### 示例 2：虚拟世界层对话（纯角色扮演）

**用户消息**：`lisi:peter` → "丽丝，我回来了"

```
1. resolveAgentLayer() → 'virtual-world'
2. resolveCharacterFromSessionKey() → 'lisi'
3. buildEmbeddedSystemPrompt({ agentLayer: 'virtual-world', characterName: 'lisi' })
   └─ 不包含工具，纯角色扮演
4. 执行 Agent（不调用工具）
```

### 示例 3：执行层（默认）

**用户消息**：`peter` → "帮我重构这个文件"

```
1. resolveAgentLayer() → 'execution'
2. buildEmbeddedSystemPrompt({ agentLayer: 'execution' })
   └─ 包含完整工具列表
3. 执行 Agent（可调用工具）
```

---

## 能力池设计（LLM 驱动）

### 核心思想

不预设规则，通过能力描述让 LLM 动态决定如何使用能力。

### 能力注册

```typescript
/**
 * 能力池
 * 
 * 所有能力都注册到池中，供 LLM 动态选择
 */
export interface CapabilityPool {
  /** 注册能力 */
  register(capability: Capability): void;
  
  /** 获取能力 */
  get(name: string): Capability | undefined;
  
  /** 获取所有能力描述（给 LLM 看的） */
  getDescriptions(): CapabilityDescription[];
}

export interface CapabilityDescription {
  /** 能力名称 */
  name: string;
  
  /** 能力描述（自然语言） */
  description: string;
  
  /** 使用场景 */
  useCases: string[];
  
  /** 参数说明 */
  parameters: string;
  
  /** 示例 */
  examples: string[];
}
```

### 已实现的能力（复用现有代码）

| 能力名称 | 描述 | 实现文件 |
|----------|------|----------|
| `memory_retriever` | 检索相关记忆 | `src/agents/memory/retriever.ts` |
| `memory_archiver` | 归档会话总结 | `src/agents/memory/archiver.ts` |
| `session_summarizer` | 生成会话总结 | `src/agents/session-summary.ts` |
| `task_delegator` | 委托任务 | `src/agents/butler/task-delegator.ts` |
| `personality_loader` | 加载角色人格 | `src/agents/lina/config/loader.ts` |
| `tool_executor` | 执行工具 | `src/agents/pi-tools.ts` |

### LLM 如何使用能力

在管家层，LLM 收到能力描述后，动态决定使用哪些能力：

```typescript
const systemPrompt = `
你是栗娜，主人的管家。

你可以使用以下能力：
${capabilityPool.getDescriptions().map(d => `
- ${d.name}: ${d.description}
  使用场景: ${d.useCases.join(', ')}
  参数: ${d.parameters}
  示例: ${d.examples.join(', ')}
`).join('\n')}

请分析用户消息，理解意图，然后选择合适的能力来完成任务。
`;
```

---

## 实现计划

### Phase 1：最小可用版本（1-2 天）

**目标**：让 LinaAgent 可以通过 sessionKey 前缀调用

**任务**：
1. 新增 `src/agents/butler/coordinator.ts`
2. 扩展 `src/agents/multi-layer/layer-resolver.ts`
3. 改动 `src/agents/pi-embedded-runner/run/attempt.ts`（约 30 行）

**验证**：
- `lina:user123` → 调用 LinaAgent + 记忆检索/归档
- `peter` → 默认行为（不变）

### Phase 2：记忆系统完善（2-3 天）

**任务**：
1. 确保 MemoryService 正常工作
2. 添加记忆上下文注入到 System Prompt
3. 添加会话总结归档

### Phase 3：能力池（可选，后续迭代）

**任务**：
1. 实现 CapabilityPool
2. 注册现有能力
3. LLM 动态选择能力

---

## 与现有代码的对比

| 方面 | 现有代码 | 新架构 |
|------|----------|--------|
| 入口 | `runEmbeddedPiAgent` | 不变 |
| 核心逻辑 | `runEmbeddedAttempt` | 小改动（+30 行） |
| System Prompt | `buildEmbeddedSystemPrompt` | 已支持 `agentLayer`，无改动 |
| 记忆系统 | `MemoryService` 已实现 | 复用 |
| 人格化 | `LinaAgent` 已实现但无入口 | 通过 ButlerCoordinator 集成 |
| 管家层 | `ButlerAgent` 已实现但未集成 | 通过 ButlerCoordinator 集成 |

---

## 总结

### 核心原则

1. **复用现有代码**：不重复造轮子
2. **最小改动**：只改动必要的地方
3. **渐进式集成**：先让基础功能工作，再迭代优化
4. **配置驱动**：通过 sessionKey 前缀或 config 控制行为

### 改动范围

- **新增文件**：2 个（`coordinator.ts`, 扩展 `layer-resolver.ts`）
- **改动文件**：1 个（`attempt.ts`）
- **改动代码量**：约 200 行新增，30 行改动

### 预期效果

- LinaAgent 有了调用入口
- 管家层可以通过 sessionKey 前缀启用
- 记忆系统在管家层自动启用
- 不影响现有的执行层行为

---

**版本**：v3.1  
**创建时间**：2026-02-02  
**作者**：Clawdbot AI Assistant  
**状态**：设计完成，待实现
