# 多层 Agent 架构 - 开发者文档

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                   MultiLayerCoordinator                  │
│                    (消息路由和层次切换)                    │
└─────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ VirtualWorld  │   │    Butler     │   │   Execution   │
│     Agent     │   │     Agent     │   │     Layer     │
│ (角色扮演)     │   │  (任务委托)    │   │  (工具执行)    │
└───────────────┘   └───────────────┘   └───────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ TaskScheduler │
                    │  (任务分解)    │
                    └───────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   Execution   │
                    │     Layer     │
                    └───────────────┘
```

### 消息流程

#### 1. 虚拟世界层 → 管家层

```
用户: "帮我创建一个文件"
  ↓
虚拟世界层: 检测到技术操作关键词
  ↓
协调器: 切换到管家层
  ↓
管家层: 理解意图，委托任务
  ↓
任务调度层: 分解任务
  ↓
执行层: 执行工具调用
  ↓
管家层: 格式化结果
  ↓
虚拟世界层: 以角色身份回复
```

#### 2. 管家层 → 任务调度层

```
管家层: 委托任务
  ↓
DelegationAdapter: 转换请求格式
  ↓
TaskBoard: 分解任务
  ↓
Orchestrator: 调度执行
  ↓
Executor: 执行子任务
  ↓
DelegationAdapter: 转换响应格式
  ↓
管家层: 返回结果
```

#### 3. 任务调度层 → 执行层

```
任务调度层: 调用工具/技能
  ↓
ToolExecutor/SkillExecutor: 验证参数
  ↓
工具/技能: 执行操作
  ↓
ToolExecutor/SkillExecutor: 转换结果
  ↓
任务调度层: 返回结果
```

## 核心组件

### 1. MultiLayerCoordinator

**职责**：
- 管理各层实例
- 路由消息到目标层次
- 处理层次切换
- 管理上下文传递

**关键方法**：
- `handleMessage(message: LayerMessage): Promise<LayerResponse>`
- `switchLayer(targetLayer: AgentLayer): Promise<void>`
- `popLayer(): Promise<void>`
- `getCurrentLayer(): AgentLayer`

**使用示例**：
```typescript
const coordinator = new MultiLayerCoordinator(
  virtualWorldAgent,
  butlerAgent,
  toolExecutor,
  skillExecutor,
  {
    defaultLayer: "execution",
    enableAutoSwitch: true,
    enableLogging: true
  }
);

const response = await coordinator.handleMessage({
  content: "你好",
  context: {
    userId: "user123",
    sessionId: "session456",
    messages: []
  }
});
```

### 2. VirtualWorldAgent

**职责**：
- 提供角色扮演体验
- 检测技术操作并转发
- 维护角色人格

**关键方法**：
- `handleMessage(message: string, context: ConversationContext): Promise<string>`
- `buildSystemPrompt(): string`
- `needsButlerLayer(response: string): boolean`

**使用示例**：
```typescript
const agent = new VirtualWorldAgent(
  "丽丝",
  LISI_PROFILE,
  llmProvider
);

const response = await agent.handleMessage("你好", context);
```

### 3. ButlerAgent

**职责**：
- 理解用户意图
- 委托任务
- 管理记忆

**关键方法**：
- `handleMessage(message: string, context: ConversationContext): Promise<string>`
- `understandIntent(message: string, context: ConversationContext): Promise<Intent>`
- `handleTask(intent: Intent): Promise<string>`

**使用示例**：
```typescript
const agent = new ButlerAgent(
  taskDelegator,
  skillCaller,
  llmProvider
);

const response = await agent.handleMessage("帮我创建一个文件", context);
```

### 4. ToolExecutor / SkillExecutor

**职责**：
- 封装工具/技能调用
- 验证参数
- 处理错误
- 记录指标

**关键方法**：
- `execute(request: ExecutionRequest): Promise<ExecutionResponse>`
- `getMetrics(name?: string): Record<string, unknown>`

**使用示例**：
```typescript
const executor = new ToolExecutor(toolCaller, {
  defaultTimeout: 30000,
  enableLogging: true,
  enableMetrics: true
});

const response = await executor.execute({
  type: "tool",
  name: "read",
  parameters: { path: "file.txt" }
});
```

## System Prompt 分层

### 1. 虚拟世界层 System Prompt

**内容**：
- 角色设定
- 性格特点
- 背景故事
- 世界观
- 限制条件

**Token 消耗**：约 500-800 tokens（节省 40-50%）

**构建方法**：
```typescript
import { buildVirtualWorldPrompt } from "./src/agents/pi-embedded-runner/prompts/virtual-world.js";

const prompt = buildVirtualWorldPrompt(characterProfile);
```

### 2. 管家层 System Prompt

**内容**：
- 角色设定
- 任务委托接口
- 独立技能说明
- 工作流程

**Token 消耗**：约 800-1200 tokens（节省 30-40%）

**构建方法**：
```typescript
import { buildButlerPrompt } from "./src/agents/pi-embedded-runner/prompts/butler.js";

const prompt = buildButlerPrompt();
```

### 3. 执行层 System Prompt

**内容**：
- 工具使用说明
- 工具参数说明
- 错误处理说明
- 调试信息说明

**Token 消耗**：约 1500-2000 tokens（无节省）

**构建方法**：
```typescript
import { buildExecutionPrompt } from "./src/agents/pi-embedded-runner/prompts/execution.js";

const prompt = buildExecutionPrompt();
```

### 4. 动态加载

使用 `PromptLoader` 动态加载和缓存 System Prompt：

```typescript
import { PromptLoader } from "./src/agents/pi-embedded-runner/prompts/loader.js";

const loader = new PromptLoader({
  enableCache: true,
  enableTokenEstimation: true
});

const result = loader.load("virtual-world", {
  characterProfile: LISI_PROFILE
});

console.log(`Prompt: ${result.prompt}`);
console.log(`Estimated tokens: ${result.estimatedTokens}`);
```

## 扩展指南

### 1. 添加新的层次

1. 创建 Agent 类：
```typescript
export class MyCustomAgent {
  async handleMessage(message: string, context: ConversationContext): Promise<string> {
    // 实现逻辑
  }
}
```

2. 更新 `AgentLayer` 类型：
```typescript
export type AgentLayer = 'virtual-world' | 'butler' | 'execution' | 'my-custom';
```

3. 在 `MultiLayerCoordinator` 中添加支持：
```typescript
case "my-custom":
  if (!this.myCustomAgent) {
    throw new Error("My custom agent not available");
  }
  return this.myCustomAgent.handleMessage(message.content, message.context);
```

### 2. 自定义 System Prompt

1. 创建提示词模板：
```typescript
export function buildMyCustomPrompt(): string {
  return `你是一个自定义 Agent...`;
}
```

2. 在 `PromptLoader` 中添加支持：
```typescript
case "my-custom":
  return buildMyCustomPrompt();
```

### 3. 自定义路由规则

扩展 `MultiLayerCoordinator.determineLayer()` 方法：

```typescript
private determineLayer(message: LayerMessage): AgentLayer {
  const content = message.content.toLowerCase();
  
  // 自定义规则
  if (content.includes("my-keyword")) {
    return "my-custom";
  }
  
  // 默认规则
  return this.currentLayer;
}
```

## 性能优化

### 1. System Prompt 缓存

使用 `PromptLoader` 的缓存功能：

```typescript
const loader = new PromptLoader({
  enableCache: true
});

// 第一次加载（构建 System Prompt）
const result1 = loader.load("virtual-world", { characterProfile });

// 第二次加载（从缓存读取）
const result2 = loader.load("virtual-world", { characterProfile });
```

### 2. 层次切换优化

减少不必要的层次切换：

```typescript
// 检查是否需要切换
if (targetLayer !== this.currentLayer) {
  await this.switchLayer(targetLayer);
}
```

### 3. 并发执行

使用 `Promise.all` 并发执行独立任务：

```typescript
const [memory, knowledge] = await Promise.all([
  this.skillCaller.call("memory_search", params),
  this.skillCaller.call("knowledge_query", params)
]);
```

## 测试指南

### 1. 单元测试

测试单个组件：

```typescript
import { describe, it, expect } from "vitest";
import { ToolExecutor } from "./src/agents/execution/tool-executor.js";

describe("ToolExecutor", () => {
  it("should execute tool successfully", async () => {
    const executor = new ToolExecutor(mockToolCaller);
    const response = await executor.execute({
      type: "tool",
      name: "read",
      parameters: { path: "file.txt" }
    });
    
    expect(response.status).toBe("success");
  });
});
```

### 2. 集成测试

测试多个组件的集成：

```typescript
describe("MultiLayerCoordinator", () => {
  it("should switch from virtual-world to butler", async () => {
    const coordinator = new MultiLayerCoordinator(
      virtualWorldAgent,
      butlerAgent,
      toolExecutor,
      skillExecutor
    );
    
    const response = await coordinator.handleMessage({
      content: "帮我创建一个文件",
      context
    });
    
    expect(response.currentLayer).toBe("butler");
  });
});
```

### 3. 性能测试

测试性能指标：

```typescript
describe("Performance", () => {
  it("should reduce token consumption by 30-50%", async () => {
    const virtualWorldTokens = estimateVirtualWorldPromptTokens(profile);
    const executionTokens = estimateExecutionPromptTokens();
    
    const reduction = (executionTokens - virtualWorldTokens) / executionTokens;
    expect(reduction).toBeGreaterThan(0.3);
  });
});
```

## 故障排查

### 1. 层次切换失败

**症状**：层次切换时抛出错误

**原因**：目标层次的 Agent 未初始化

**解决**：确保所有需要的 Agent 都已初始化

```typescript
const coordinator = new MultiLayerCoordinator(
  virtualWorldAgent,  // 确保不为 null
  butlerAgent,        // 确保不为 null
  toolExecutor,       // 确保不为 null
  skillExecutor       // 确保不为 null
);
```

### 2. System Prompt 过长

**症状**：Token 消耗仍然很高

**原因**：使用了错误的层次或 System Prompt 未优化

**解决**：检查当前层次和 System Prompt 内容

```typescript
const result = loader.load(layer, options);
console.log(`Layer: ${result.layer}`);
console.log(`Estimated tokens: ${result.estimatedTokens}`);
```

### 3. 性能下降

**症状**：响应时间明显增加

**原因**：频繁的层次切换或缓存未启用

**解决**：
1. 启用 System Prompt 缓存
2. 减少不必要的层次切换
3. 使用性能监控工具分析瓶颈

## 最佳实践

### 1. 选择合适的层次

- 角色扮演对话 → 虚拟世界层
- 任务管理 → 管家层
- 工具调用 → 执行层

### 2. 优化 System Prompt

- 移除不必要的内容
- 简化表达
- 合并重复的提示词

### 3. 启用缓存

- System Prompt 缓存
- 层次实例缓存
- 工具结果缓存（如果适用）

### 4. 监控性能

- 记录层次切换次数
- 记录 Token 消耗
- 记录响应时间

### 5. 错误处理

- 捕获所有错误
- 提供友好的错误消息
- 实现错误恢复机制

## 更多资源

- [用户文档](../multi-layer-agent-architecture.md)
- [API 文档](../api/multi-layer-architecture.md)
- [示例代码](../../examples/multi-layer-agent/)
- [贡献指南](../CONTRIBUTING.md)
