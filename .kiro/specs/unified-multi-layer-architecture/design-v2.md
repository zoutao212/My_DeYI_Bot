# Clawdbot 统一多层架构设计文档 v2.0
## 基于实际代码的架构设计

## 核心设计原则

1. **管家层是全流程控制角色**：所有消息都先到管家层，由管家层统一调度
2. **VirtualWorld 通过管家层中转**：角色扮演对话由管家层调用 VirtualWorldAgent，结果通过管家层返回
3. **贴合现有代码**：所有设计都基于现有代码结构，不推倒重来
4. **渐进式集成**：在现有 `runEmbeddedAttempt` 中集成，不改变核心流程

## 实际运行流程分析

### 当前实际流程

```
用户消息
  ↓
runReplyAgent (src/auto-reply/reply/agent-runner.ts)
  ↓
runAgentTurnWithFallback (src/auto-reply/reply/agent-runner-execution.ts)
  ↓
runEmbeddedPiAgent (src/agents/pi-embedded-runner/run.ts)
  ↓
runEmbeddedAttempt (src/agents/pi-embedded-runner/run/attempt.ts)
  ├─ buildEmbeddedSystemPrompt()  ← 这里生成 System Prompt
  └─ subscribeEmbeddedPiSession() ← 这里执行 Agent 循环
```

### 关键发现

1. **`buildEmbeddedSystemPrompt` 已支持 `agentLayer` 参数**，但 `runEmbeddedAttempt` **没有传递**
2. **`ButlerAgent` 和 `VirtualWorldAgent` 已实现**，但**没有集成到运行流程中**
3. **需要在 `runEmbeddedAttempt` 中集成管家层控制逻辑**

## 重新设计的架构

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    用户消息入口                               │
│              (Telegram / Discord / CLI / Web)               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              runEmbeddedPiAgent / runEmbeddedAttempt        │
│                    (现有运行入口)                            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   管家层（Butler）                           │
│              【全流程控制角色 - 核心调度器】                  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ButlerAgent.handleMessage()                        │  │
│  │  - 接收所有用户消息                                   │  │
│  │  - 判断消息类型（角色扮演 vs 任务 vs 技能）          │  │
│  │  - 统一调度所有功能                                   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │VirtualWorld  │  │TaskDelegator │  │MemoryService │     │
│  │Agent         │  │(任务委托)    │  │(记忆管理)    │     │
│  │(角色扮演)    │  │              │  │              │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│         │                │                │                │
│         │                │                │                │
│         └────────────────┼────────────────┘                │
│                          │                                 │
│                          ▼                                 │
│              ┌──────────────────────────┐                 │
│              │  任务调度层               │                 │
│              │  (TaskBoard/Orchestrator) │                 │
│              └──────────────────────────┘                 │
│                          │                                 │
│                          ▼                                 │
│              ┌──────────────────────────┐                 │
│              │  执行层 (Pi Agent)       │                 │
│              │  (工具调用)              │                 │
│              └──────────────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

### 关键设计点

1. **管家层是唯一入口**：所有消息都先到 `ButlerAgent.handleMessage()`
2. **VirtualWorld 通过管家层调用**：角色扮演时，管家层调用 `VirtualWorldAgent.handleMessage()`，结果通过管家层返回
3. **记忆管理在管家层**：对话前后的记忆检索和归档都在管家层完成
4. **任务委托在管家层**：所有任务委托都通过管家层的 `TaskDelegator` 完成

## 具体实现方案

### 1. 修改 `runEmbeddedAttempt` 集成管家层

**文件**：`src/agents/pi-embedded-runner/run/attempt.ts`

**修改点**：在调用 `buildEmbeddedSystemPrompt` 和 `subscribeEmbeddedPiSession` 之前，先判断是否需要使用管家层

```typescript
// 在 runEmbeddedAttempt 中
export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  // ... 现有代码 ...

  // 🆕 1. 判断是否使用管家层
  const agentLayer = resolveAgentLayer(
    params.sessionKey || params.sessionId,
    params.config
  );

  // 🆕 2. 如果使用管家层，初始化 ButlerAgent
  let butlerAgent: ButlerAgent | null = null;
  if (agentLayer === 'butler' || agentLayer === 'virtual-world') {
    // 初始化管家层需要的依赖
    const memoryService = await createMemoryService(params.config, sessionAgentId);
    const taskDelegator = createTaskDelegator(/* ... */);
    const skillCaller = createSkillCaller(/* ... */);
    const llmProvider = createLLMProvider(/* ... */);
    
    // 创建 ButlerAgent
    butlerAgent = new ButlerAgent(
      taskDelegator,
      skillCaller,
      llmProvider,
      memoryService
    );
  }

  // 🆕 3. 如果使用管家层，先让管家层处理消息
  if (butlerAgent) {
    const conversationContext: ConversationContext = {
      sessionId: params.sessionId,
      userId: params.agentAccountId || 'unknown',
      messages: [], // 从 sessionManager 加载
    };

    // 让管家层处理消息
    const butlerResponse = await butlerAgent.handleMessage(
      params.prompt,
      conversationContext
    );

    // 如果管家层返回了结果，直接返回（不继续执行 Pi Agent）
    // 如果管家层需要继续执行，则继续原有流程
    if (butlerResponse.shouldContinue === false) {
      return {
        payloads: [{ text: butlerResponse.message }],
        meta: { /* ... */ },
      };
    }
  }

  // 4. 继续原有流程（如果管家层没有拦截）
  const appendPrompt = await buildEmbeddedSystemPrompt({
    // ... 现有参数 ...
    agentLayer, // 🆕 传递层次参数
    characterName: params.config?.agents?.defaults?.character,
  });

  // ... 继续原有代码 ...
}
```

### 2. 修改 `ButlerAgent` 支持 VirtualWorld 调度

**文件**：`src/agents/butler/agent.ts`

**修改点**：在 `handleMessage` 中判断是否需要角色扮演，如果需要，调用 `VirtualWorldAgent`

```typescript
export class ButlerAgent {
  constructor(
    private taskDelegator: TaskDelegator,
    private skillCaller: SkillCaller,
    private llmProvider: LLMProvider,
    private memoryService?: IMemoryService,
    private virtualWorldAgent?: VirtualWorldAgent, // 🆕 支持 VirtualWorld
  ) {}

  async handleMessage(
    message: string,
    context: ConversationContext
  ): Promise<ButlerResponse> {
    // 1. 对话前任务调度（记忆填充）
    await this.beforeConversation(context);

    // 🆕 2. 判断是否需要角色扮演
    const needsRolePlay = await this.shouldUseVirtualWorld(message, context);
    
    if (needsRolePlay && this.virtualWorldAgent) {
      // 调用 VirtualWorldAgent 处理角色扮演
      const virtualWorldResponse = await this.virtualWorldAgent.handleMessage(
        message,
        context
      );

      // 检查 VirtualWorld 是否要求转发给管家层
      if (virtualWorldResponse.needsButler) {
        // VirtualWorld 检测到技术操作，继续用管家层处理
        return this.handleAsButler(message, context);
      }

      // 返回角色扮演结果
      return {
        message: virtualWorldResponse.message,
        shouldContinue: false,
      };
    }

    // 3. 作为管家层处理（任务、技能、对话）
    return this.handleAsButler(message, context);
  }

  /**
   * 🆕 判断是否需要使用 VirtualWorld
   */
  private async shouldUseVirtualWorld(
    message: string,
    context: ConversationContext
  ): Promise<boolean> {
    // 检查 sessionKey 前缀
    if (context.sessionId?.startsWith('virtual-world:')) {
      return true;
    }

    // 检查配置
    if (context.metadata?.useVirtualWorld === true) {
      return true;
    }

    // 使用 LLM 判断是否是角色扮演对话
    const systemPrompt = `判断用户消息是否需要角色扮演回复。
如果是情感对话、陪伴、聊天、讲故事等，返回 true。
如果是技术操作、任务请求等，返回 false。`;
    
    const response = await this.llmProvider.chat({
      systemPrompt,
      messages: [],
      userMessage: message,
    });

    return response.toLowerCase().includes('true');
  }

  /**
   * 🆕 作为管家层处理消息
   */
  private async handleAsButler(
    message: string,
    context: ConversationContext
  ): Promise<ButlerResponse> {
    // 理解用户意图
    const intent = await this.understandIntent(message, context);

    // 根据意图执行操作
    let result: string;
    if (intent.type === "task") {
      result = await this.handleTask(intent);
    } else if (intent.type === "skill") {
      result = await this.handleSkill(intent);
    } else {
      result = await this.handleConversation(message, context);
    }

    // 对话后任务调度（总结归档）
    await this.afterConversation(context, result);

    return {
      message: result,
      shouldContinue: false,
    };
  }
}
```

### 3. 修改 `VirtualWorldAgent` 通过管家层返回

**文件**：`src/agents/virtual-world/agent.ts`

**修改点**：`forwardToButler` 不再返回占位符，而是返回需要转发的信号

```typescript
export class VirtualWorldAgent {
  async handleMessage(
    message: string,
    context: ConversationContext
  ): Promise<VirtualWorldResponse> {
    // ... 现有代码 ...

    // 6. 检查是否需要转发给管家层
    if (this.needsButlerLayer(response)) {
      return {
        message: response, // 先返回角色扮演的回复
        needsButler: true, // 标记需要转发
        originalMessage: message, // 保留原始消息
      };
    }

    return {
      message: response,
      needsButler: false,
    };
  }

  /**
   * 🆕 判断是否需要转发给管家层
   */
  private needsButlerLayer(response: string): boolean {
    const technicalKeywords = [
      "写入文件", "读取文件", "执行命令", "搜索",
      "创建文件", "删除文件", "修改文件",
    ];

    return technicalKeywords.some((keyword) => response.includes(keyword));
  }
}
```

### 4. 在 `buildEmbeddedSystemPrompt` 中集成角色配置

**文件**：`src/agents/pi-embedded-runner/system-prompt.ts`

**修改点**：实际使用 `characterName` 参数加载角色配置

```typescript
export async function buildEmbeddedSystemPrompt(params: {
  // ... 现有参数 ...
  agentLayer?: AgentLayer;
  characterName?: string;
  characterBasePath?: string;
}): Promise<string> {
  const layer = params.agentLayer || 'execution';
  
  // 🆕 加载角色配置（如果提供了 characterName）
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

  // 合并角色 System Prompt
  const effectiveExtraSystemPrompt = characterPrompt
    ? (params.extraSystemPrompt ? `${characterPrompt}\n\n${params.extraSystemPrompt}` : characterPrompt)
    : params.extraSystemPrompt;

  // 虚拟世界层：只包含角色设定
  if (layer === 'virtual-world') {
    return buildAgentSystemPrompt({
      // ... 现有参数 ...
      extraSystemPrompt: effectiveExtraSystemPrompt,
      toolNames: [],
      toolSummaries: {},
    });
  }
  
  // 管家层：包含任务委托提示词 + 角色人格（如果有）
  if (layer === 'butler') {
    const basePrompt = buildAgentSystemPrompt({
      // ... 现有参数 ...
      extraSystemPrompt: effectiveExtraSystemPrompt,
      toolNames: [],
      toolSummaries: {},
    });
    
    const delegationPrompt = `
## 任务委托能力

你可以调用以下能力：
- delegateTask(): 委托任务给底层执行系统
- callSkill(): 调用独立技能（记忆检索、知识查询等）

注意：你不直接执行工具调用，而是委托给底层系统。`;
    
    return basePrompt + delegationPrompt;
  }
  
  // 执行层：包含完整的工具使用提示词
  return buildAgentSystemPrompt({
    // ... 现有参数 ...
    extraSystemPrompt: effectiveExtraSystemPrompt,
    toolNames: params.tools.map((tool) => tool.name),
    toolSummaries: buildToolSummaryMap(params.tools),
  });
}
```

## 数据流设计

### 完整消息流程

```
用户消息
  ↓
runEmbeddedAttempt()
  ↓
resolveAgentLayer() → 'butler' 或 'virtual-world'
  ↓
创建 ButlerAgent
  ↓
ButlerAgent.handleMessage()
  ├─ beforeConversation() → MemoryService.retrieve()
  ├─ shouldUseVirtualWorld() → 判断是否需要角色扮演
  │
  ├─ [需要角色扮演]
  │   └─ VirtualWorldAgent.handleMessage()
  │       ├─ 角色扮演对话
  │       └─ needsButlerLayer() → 检测技术操作
  │           ├─ [需要转发] → 返回 needsButler: true
  │           └─ [不需要转发] → 返回角色扮演结果
  │
  └─ [不需要角色扮演 或 需要转发]
      ├─ understandIntent() → 理解意图
      ├─ handleTask() → TaskDelegator.delegate()
      ├─ handleSkill() → SkillCaller.call()
      └─ handleConversation() → 普通对话
  ↓
afterConversation() → MemoryService.archive()
  ↓
返回结果给用户
```

### 关键点

1. **所有消息都先到管家层**：`ButlerAgent.handleMessage()` 是唯一入口
2. **VirtualWorld 通过管家层调用**：角色扮演时，管家层调用 `VirtualWorldAgent`，结果通过管家层返回
3. **记忆管理在管家层**：对话前后的记忆检索和归档都在 `ButlerAgent` 中完成
4. **任务委托在管家层**：所有任务委托都通过 `TaskDelegator` 完成

## 集成到现有代码的具体步骤

### 步骤 1: 修改 `runEmbeddedAttempt` 判断层次

**文件**：`src/agents/pi-embedded-runner/run/attempt.ts`

**位置**：在调用 `buildEmbeddedSystemPrompt` 之前

```typescript
// 导入
import { resolveAgentLayer } from "../multi-layer/layer-resolver.js";
import { ButlerAgent } from "../butler/agent.js";
import type { ConversationContext } from "../multi-layer/types.js";

// 在 runEmbeddedAttempt 函数中
export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  // ... 现有代码 ...

  // 🆕 判断层次
  const agentLayer = resolveAgentLayer(
    params.sessionKey || params.sessionId,
    params.config
  );

  // 🆕 如果使用管家层，初始化并处理
  if (agentLayer === 'butler' || agentLayer === 'virtual-world') {
    // 初始化依赖（需要根据实际代码调整）
    const butlerAgent = await createButlerAgent({
      config: params.config,
      sessionId: params.sessionId,
      workspaceDir: effectiveWorkspace,
    });

    // 构建对话上下文
    const conversationContext: ConversationContext = {
      sessionId: params.sessionId,
      userId: params.agentAccountId || 'unknown',
      messages: [], // 需要从 sessionManager 加载
    };

    // 让管家层处理
    const butlerResponse = await butlerAgent.handleMessage(
      params.prompt,
      conversationContext
    );

    // 如果管家层返回了结果，直接返回
    if (!butlerResponse.shouldContinue) {
      return {
        payloads: [{ text: butlerResponse.message }],
        meta: {
          durationMs: Date.now() - started,
          agentMeta: {
            sessionId: params.sessionId,
            provider: params.provider,
            model: params.modelId,
          },
        },
      };
    }
  }

  // 继续原有流程
  const appendPrompt = await buildEmbeddedSystemPrompt({
    // ... 现有参数 ...
    agentLayer, // 🆕 传递层次
    characterName: params.config?.agents?.defaults?.character,
  });

  // ... 继续原有代码 ...
}
```

### 步骤 2: 创建 `createButlerAgent` 工厂函数

**文件**：`src/agents/butler/factory.ts` (新建)

```typescript
import { ButlerAgent } from "./agent.js";
import { TaskDelegator } from "./task-delegator.js";
import { VirtualWorldAgent } from "../virtual-world/agent.js";
import { createMemoryService } from "../memory/factory.js";
import { createSkillCaller } from "./skill-caller.js";
import { createLLMProvider } from "./llm-provider.js";
import { loadCharacterConfig, loadCharacterProfile } from "../lina/config/loader.js";

export async function createButlerAgent(params: {
  config?: ClawdbotConfig;
  sessionId: string;
  workspaceDir: string;
}): Promise<ButlerAgent> {
  // 1. 创建依赖
  const memoryService = await createMemoryService(params.config, sessionAgentId);
  const taskDelegator = createTaskDelegator(/* ... */);
  const skillCaller = createSkillCaller(/* ... */);
  const llmProvider = createLLMProvider(/* ... */);

  // 2. 创建 VirtualWorldAgent（如果需要）
  let virtualWorldAgent: VirtualWorldAgent | undefined;
  const characterName = params.config?.agents?.defaults?.character;
  if (characterName) {
    const config = await loadCharacterConfig(characterName, params.workspaceDir);
    const profile = await loadCharacterProfile(characterName, params.workspaceDir);
    virtualWorldAgent = new VirtualWorldAgent(
      characterName,
      profile,
      llmProvider,
      memoryService
    );
  }

  // 3. 创建 ButlerAgent
  return new ButlerAgent(
    taskDelegator,
    skillCaller,
    llmProvider,
    memoryService,
    virtualWorldAgent
  );
}
```

### 步骤 3: 修改 `ButlerAgent` 支持 VirtualWorld

**文件**：`src/agents/butler/agent.ts`

```typescript
export interface ButlerResponse {
  message: string;
  shouldContinue: boolean; // 是否继续执行 Pi Agent
}

export class ButlerAgent {
  constructor(
    private taskDelegator: TaskDelegator,
    private skillCaller: SkillCaller,
    private llmProvider: LLMProvider,
    private memoryService?: IMemoryService,
    private virtualWorldAgent?: VirtualWorldAgent, // 🆕
  ) {}

  async handleMessage(
    message: string,
    context: ConversationContext
  ): Promise<ButlerResponse> {
    // 1. 对话前任务调度（记忆填充）
    await this.beforeConversation(context);

    // 🆕 2. 判断是否需要角色扮演
    if (this.virtualWorldAgent && await this.shouldUseVirtualWorld(message, context)) {
      const virtualWorldResponse = await this.virtualWorldAgent.handleMessage(
        message,
        context
      );

      if (virtualWorldResponse.needsButler) {
        // VirtualWorld 检测到技术操作，继续用管家层处理
        return this.handleAsButler(message, context);
      }

      // 返回角色扮演结果
      return {
        message: virtualWorldResponse.message,
        shouldContinue: false,
      };
    }

    // 3. 作为管家层处理
    return this.handleAsButler(message, context);
  }

  // ... 其他方法 ...
}
```

### 步骤 4: 修改 `VirtualWorldAgent` 返回结构

**文件**：`src/agents/virtual-world/agent.ts`

```typescript
export interface VirtualWorldResponse {
  message: string;
  needsButler: boolean; // 是否需要转发给管家层
  originalMessage?: string; // 原始消息（如果需要转发）
}

export class VirtualWorldAgent {
  async handleMessage(
    message: string,
    context: ConversationContext
  ): Promise<VirtualWorldResponse> {
    // ... 现有代码 ...

    // 检查是否需要转发给管家层
    if (this.needsButlerLayer(response)) {
      return {
        message: response, // 先返回角色扮演的回复
        needsButler: true,
        originalMessage: message,
      };
    }

    return {
      message: response,
      needsButler: false,
    };
  }
}
```

## 配置支持

### 配置文件结构

```json
{
  "agents": {
    "defaults": {
      "layer": "butler",
      "character": "lina",
      "memory": {
        "enabled": true,
        "retrieval": { /* ... */ },
        "archival": { /* ... */ }
      }
    }
  }
}
```

### sessionKey 前缀支持

- `butler:lina` → 使用管家层（Lina 人格）
- `virtual-world:lisi` → 使用虚拟世界层（丽丝角色）
- `default-session` → 使用执行层（默认行为）

## 总结

### 核心设计

1. **管家层是全流程控制角色**：所有消息都先到 `ButlerAgent.handleMessage()`
2. **VirtualWorld 通过管家层调用**：角色扮演时，管家层调用 `VirtualWorldAgent`，结果通过管家层返回
3. **贴合现有代码**：在 `runEmbeddedAttempt` 中集成，不改变核心流程
4. **渐进式集成**：可以逐步启用，保持向后兼容

### 关键修改点

1. **`runEmbeddedAttempt`**：判断层次，初始化管家层，让管家层处理消息
2. **`ButlerAgent`**：支持 VirtualWorld 调度，统一控制所有功能
3. **`VirtualWorldAgent`**：返回结构包含 `needsButler` 标志
4. **`buildEmbeddedSystemPrompt`**：实际使用 `characterName` 参数

### 实施优先级

1. **P0**：修改 `runEmbeddedAttempt` 集成管家层
2. **P0**：修改 `ButlerAgent` 支持 VirtualWorld 调度
3. **P1**：修改 `buildEmbeddedSystemPrompt` 集成角色配置
4. **P1**：创建 `createButlerAgent` 工厂函数
5. **P2**：完善记忆系统集成
6. **P2**：完善任务委托集成

---

**版本**：v2.0  
**创建时间**：2025-02-01  
**作者**：Kiro AI Assistant  
**状态**：基于实际代码重新设计

