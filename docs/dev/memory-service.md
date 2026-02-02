# 记忆服务开发文档

## 概述

记忆服务（Memory Service）是 Clawdbot 多层 Agent 架构的核心组件，负责：
- **对话前记忆检索**：自动检索相关历史记忆并注入上下文
- **对话后总结归档**：自动生成会话总结并归档到长期记忆
- **统一记忆接口**：为各层 Agent 提供一致的记忆访问方式

---

## 架构设计

### 核心组件

```
┌─────────────────────────────────────────┐
│        记忆服务 (MemoryService)         │
├─────────────────────────────────────────┤
│                                         │
│  ┌──────────────┐  ┌──────────────┐   │
│  │ 记忆检索器   │  │ 记忆归档器   │   │
│  │ (Retriever)  │  │ (Archiver)   │   │
│  └──────────────┘  └──────────────┘   │
│         │                  │           │
│         ▼                  ▼           │
│  ┌──────────────┐  ┌──────────────┐   │
│  │ 索引管理器   │  │ 会话总结     │   │
│  │ (Manager)    │  │ (Summary)    │   │
│  └──────────────┘  └──────────────┘   │
│         │                  │           │
│         ▼                  ▼           │
│  ┌─────────────────────────────────┐  │
│  │   记忆存储 (SQLite + Files)    │  │
│  └─────────────────────────────────┘  │
│                                         │
└─────────────────────────────────────────┘
```

### 数据流

**对话前（记忆检索）**：
```
用户消息 → 管家层 → 记忆服务.retrieve()
  → 索引管理器.search() → 格式化结果
  → 注入上下文 → 继续对话
```

**对话后（记忆归档）**：
```
对话结束 → 管家层 → 生成总结
  → 记忆服务.archive() → 格式化总结
  → 写入文件 → 更新索引
```

---

## API 接口

### 记忆检索

#### 接口定义

```typescript
interface MemoryRetrievalRequest {
  /** 查询文本 */
  query: string;
  /** 上下文信息 */
  context: {
    userId: string;
    sessionId: string;
    agentId?: string;
    layer?: "virtual-world" | "butler" | "execution";
  };
  /** 检索参数（可选） */
  params?: {
    maxResults?: number;    // 最大结果数
    minScore?: number;      // 最小相关性分数 (0-1)
    sources?: ("memory" | "sessions")[];  // 检索来源
  };
}

interface MemoryRetrievalResult {
  /** 检索到的记忆列表 */
  memories: MemoryItem[];
  /** 格式化的上下文（可直接注入 System Prompt） */
  formattedContext: string;
  /** 检索耗时（毫秒） */
  durationMs: number;
}

interface MemoryItem {
  path: string;           // 文件路径
  snippet: string;        // 内容片段
  score: number;          // 相关性分数 (0-1)
  source: "memory" | "sessions";
  timestamp?: number;
  startLine: number;
  endLine: number;
}
```

#### 使用示例

```typescript
// 基本用法
const result = await memoryService.retrieve({
  query: "如何使用多层架构",
  context: {
    userId: "user123",
    sessionId: "session456",
    layer: "butler",
  },
});

console.log(`找到 ${result.memories.length} 条相关记忆`);
console.log(`检索耗时: ${result.durationMs}ms`);

// 自定义参数
const result = await memoryService.retrieve({
  query: "任务分解",
  context: { userId: "user123", sessionId: "session456" },
  params: {
    maxResults: 10,        // 最多返回 10 条
    minScore: 0.8,         // 相关性至少 80%
    sources: ["memory"],   // 只搜索 memory 文件
  },
});
```

#### 返回格式

```typescript
{
  memories: [
    {
      path: "memory/projects/multi-layer-architecture.md",
      snippet: "多层架构包括虚拟世界层、管家层和执行层...",
      score: 0.92,
      source: "memory",
      startLine: 10,
      endLine: 25
    }
  ],
  formattedContext: `
## 相关记忆 (Relevant Memories)

### 记忆 1 (相关性: 92%)
**来源**: memory/projects/multi-layer-architecture.md (行 10-25)

多层架构包括虚拟世界层、管家层和执行层...
  `,
  durationMs: 234
}
```

### 记忆归档

#### 接口定义

```typescript
interface MemoryArchivalRequest {
  /** 会话总结 */
  summary: SessionSummary;
  /** 上下文信息 */
  context: {
    userId: string;
    sessionId: string;
    agentId?: string;
  };
  /** 归档参数（可选） */
  params?: {
    path?: string;                    // 归档路径
    format?: "markdown" | "json";     // 归档格式
  };
}

interface MemoryArchivalResult {
  /** 归档文件路径 */
  path: string;
  /** 归档是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
  /** 归档耗时（毫秒） */
  durationMs: number;
}

interface SessionSummary {
  taskGoal: string;           // 任务目标
  keyActions: string[];       // 关键操作
  keyDecisions: string[];     // 关键决策
  blockers: string[];         // 遇到的问题
  totalTurns: number;         // 对话轮数
  createdAt: number;          // 创建时间
  progress?: {                // 进度（可选）
    completed: number;
    total: number;
    percentage: number;
  };
}
```

#### 使用示例

```typescript
// 基本用法
const result = await memoryService.archive({
  summary: {
    taskGoal: "实现记忆系统集成",
    keyActions: [
      "创建记忆服务接口",
      "实现记忆检索器",
      "集成到管家层"
    ],
    keyDecisions: [
      "使用异步归档避免阻塞对话"
    ],
    blockers: [],
    totalTurns: 12,
    createdAt: Date.now(),
  },
  context: {
    userId: "user123",
    sessionId: "session456",
  },
});

if (result.success) {
  console.log(`归档成功: ${result.path}`);
} else {
  console.error(`归档失败: ${result.error}`);
}
```

#### 归档文件格式

**Markdown 格式**（默认）：
```markdown
# 会话总结 - session456

**时间**: 2026-01-31T10:30:00.000Z
**用户**: user123
**对话轮数**: 12

## 任务目标

实现记忆系统集成

## 关键操作

- 创建记忆服务接口
- 实现记忆检索器
- 集成到管家层

## 关键决策

1. 使用异步归档避免阻塞对话

## 进度

12/15 (80%)
```

---

## 配置说明

### 配置结构

在 `clawdbot.json` 中配置：

```json
{
  "agents": {
    "main": {
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

### 配置项说明

#### 检索配置 (retrieval)

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxResults` | number | 5 | 最大返回结果数 |
| `minScore` | number | 0.7 | 最小相关性分数 (0-1) |
| `sources` | string[] | ["memory", "sessions"] | 检索来源 |
| `timeoutMs` | number | 5000 | 检索超时时间（毫秒） |

#### 归档配置 (archival)

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `strategy` | string | "threshold" | 归档策略（见下文） |
| `path` | string | "memory/sessions" | 归档路径 |
| `format` | string | "markdown" | 归档格式 |
| `frequency` | number | 5 | 归档频率（轮数） |

#### 归档策略 (strategy)

- **`always`**：每次对话后都归档
- **`on-demand`**：仅在显式调用时归档
- **`threshold`**：达到指定轮数后归档（由 `frequency` 控制）

### 配置示例

**高频归档（适合重要对话）**：
```json
{
  "memory": {
    "enabled": true,
    "archival": {
      "strategy": "always",
      "frequency": 1
    }
  }
}
```

**低频归档（适合日常对话）**：
```json
{
  "memory": {
    "enabled": true,
    "archival": {
      "strategy": "threshold",
      "frequency": 10
    }
  }
}
```

**禁用归档（仅检索）**：
```json
{
  "memory": {
    "enabled": true,
    "archival": {
      "strategy": "on-demand"
    }
  }
}
```

---

## 使用示例

### 在管家层中使用

```typescript
import { MemoryService, resolveMemoryServiceConfig } from "../memory/service.js";

export class ButlerAgent {
  private memoryService: MemoryService | null;

  constructor(
    private cfg: ClawdbotConfig,
    // ... 其他依赖
  ) {
    // 初始化记忆服务
    const memoryConfig = resolveMemoryServiceConfig(cfg, "main");
    this.memoryService = memoryConfig 
      ? new MemoryService(memoryConfig, cfg)
      : null;
  }

  /**
   * 处理用户消息
   */
  async handleMessage(message: string, context: ConversationContext) {
    // 1. 对话前：检索相关记忆
    await this.beforeConversation(message, context);

    // 2. 处理消息
    const response = await this.processMessage(message, context);

    // 3. 对话后：归档总结
    await this.afterConversation(context, response);

    return response;
  }

  /**
   * 对话前：检索记忆
   */
  private async beforeConversation(
    message: string,
    context: ConversationContext,
  ) {
    if (!this.memoryService) {
      return;
    }

    try {
      const result = await this.memoryService.retrieve({
        query: message,
        context: {
          userId: context.userId,
          sessionId: context.sessionId,
          layer: "butler",
        },
      });

      // 注入到上下文
      if (result.memories.length > 0) {
        context.memories = result.memories;
        context.memoryContext = result.formattedContext;
      }
    } catch (error) {
      console.error("Memory retrieval failed:", error);
      // 不影响对话流程
    }
  }

  /**
   * 对话后：归档总结
   */
  private async afterConversation(
    context: ConversationContext,
    response: string,
  ) {
    if (!this.memoryService) {
      return;
    }

    try {
      // 生成总结
      const summary = generateSessionSummary(context.messages);
      if (!summary) {
        return;
      }

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
    } catch (error) {
      console.error("Memory archival failed:", error);
      // 不影响对话流程
    }
  }
}
```

### 在虚拟世界层中使用

```typescript
export class VirtualWorldAgent {
  private memoryService: MemoryService | null;

  constructor(
    private cfg: ClawdbotConfig,
    private characterName: string,
  ) {
    const memoryConfig = resolveMemoryServiceConfig(cfg, "main");
    this.memoryService = memoryConfig 
      ? new MemoryService(memoryConfig, cfg)
      : null;
  }

  /**
   * 检索角色相关记忆
   */
  async retrieveCharacterMemories(query: string, context: any) {
    if (!this.memoryService) {
      return null;
    }

    const result = await this.memoryService.retrieve({
      query: `${this.characterName}: ${query}`,
      context: {
        userId: context.userId,
        sessionId: context.sessionId,
        layer: "virtual-world",
      },
      params: {
        maxResults: 3,  // 角色记忆较少
        minScore: 0.8,  // 要求更高相关性
      },
    });

    // 过滤技术细节，保持角色设定
    return this.filterTechnicalDetails(result);
  }

  private filterTechnicalDetails(result: MemoryRetrievalResult) {
    // 移除技术术语，保持角色语气
    // ...
  }
}
```

---

## 错误处理

### 检索失败

记忆检索失败**不会影响对话流程**，会返回空结果：

```typescript
{
  memories: [],
  formattedContext: "",
  durationMs: 0
}
```

**常见失败原因**：
- 检索超时（超过 `timeoutMs`）
- 索引管理器不可用
- 数据库连接失败

### 归档失败

记忆归档失败**不会影响对话流程**，会记录错误日志：

```typescript
{
  path: "",
  success: false,
  error: "Failed to write archive file: ...",
  durationMs: 123
}
```

**常见失败原因**：
- 文件写入权限不足
- 磁盘空间不足
- 路径不存在

### 降级策略

1. **检索降级**：检索失败时，对话继续进行，不注入记忆上下文
2. **归档降级**：归档失败时，记录日志，不影响用户体验
3. **服务降级**：记忆服务不可用时，整个系统仍可正常运行

---

## 性能优化

### 检索性能

- **超时控制**：默认 5 秒超时，避免长时间等待
- **结果限制**：默认最多返回 5 条，减少处理时间
- **相关性过滤**：默认最低 0.7 分，过滤低质量结果

### 归档性能

- **异步执行**：归档操作异步执行，不阻塞对话
- **批量写入**：多个总结可以批量写入（未来优化）
- **延迟索引**：索引更新延迟执行，不影响归档速度

---

## 测试

### 单元测试

```typescript
import { MemoryService } from "./service.js";

describe("MemoryService", () => {
  it("should retrieve relevant memories", async () => {
    const service = new MemoryService(config, cfg);
    
    const result = await service.retrieve({
      query: "多层架构",
      context: { userId: "test", sessionId: "test" },
    });
    
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.formattedContext).toContain("相关记忆");
  });

  it("should archive session summary", async () => {
    const service = new MemoryService(config, cfg);
    
    const result = await service.archive({
      summary: {
        taskGoal: "测试任务",
        keyActions: ["action1"],
        keyDecisions: [],
        blockers: [],
        totalTurns: 5,
        createdAt: Date.now(),
      },
      context: { userId: "test", sessionId: "test" },
    });
    
    expect(result.success).toBe(true);
  });
});
```

### 集成测试

```typescript
describe("ButlerAgent with Memory", () => {
  it("should inject memories before conversation", async () => {
    const butler = new ButlerAgent(cfg);
    
    const response = await butler.handleMessage(
      "继续之前的任务",
      context,
    );
    
    expect(context.memories).toBeDefined();
    expect(context.memories.length).toBeGreaterThan(0);
  });

  it("should archive summary after conversation", async () => {
    const butler = new ButlerAgent(cfg);
    
    await butler.handleMessage("完成任务", context);
    
    // 等待异步归档完成
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const archived = await fs.readFile(
      "memory/sessions/test.md",
      "utf-8",
    );
    expect(archived).toContain("完成任务");
  });
});
```

---

## 故障排查

### 问题：检索没有返回结果

**可能原因**：
1. 记忆文件为空或不存在
2. 查询文本与记忆内容相关性太低
3. `minScore` 设置过高

**解决方法**：
```typescript
// 1. 检查记忆文件
ls -la memory/

// 2. 降低相关性阈值
const result = await memoryService.retrieve({
  query: "...",
  context: { ... },
  params: { minScore: 0.5 },  // 降低到 0.5
});

// 3. 检查日志
tail -f logs/memory-service.log
```

### 问题：归档失败

**可能原因**：
1. 归档路径不存在
2. 文件写入权限不足
3. 磁盘空间不足

**解决方法**：
```bash
# 1. 创建归档目录
mkdir -p memory/sessions

# 2. 检查权限
ls -la memory/

# 3. 检查磁盘空间
df -h
```

### 问题：记忆服务不可用

**可能原因**：
1. 配置中 `enabled: false`
2. 索引管理器初始化失败
3. 数据库连接失败

**解决方法**：
```typescript
// 1. 检查配置
const status = memoryService?.status();
console.log(status);

// 2. 检查日志
tail -f logs/memory-service.log

// 3. 重新初始化
const memoryConfig = resolveMemoryServiceConfig(cfg, "main");
const memoryService = new MemoryService(memoryConfig, cfg);
```

---

## 最佳实践

### 1. 合理设置检索参数

- **日常对话**：`maxResults: 3-5`, `minScore: 0.7`
- **技术讨论**：`maxResults: 5-10`, `minScore: 0.8`
- **快速响应**：`timeoutMs: 3000`, `maxResults: 3`

### 2. 选择合适的归档策略

- **重要项目**：`strategy: "always"` - 每次对话都归档
- **日常对话**：`strategy: "threshold"`, `frequency: 5-10`
- **临时对话**：`strategy: "on-demand"` - 手动归档

### 3. 优化记忆文件组织

```
memory/
├── projects/          # 项目相关记忆
│   ├── project-a.md
│   └── project-b.md
├── sessions/          # 会话归档
│   ├── 2026-01-31/
│   │   ├── session1.md
│   │   └── session2.md
│   └── 2026-02-01/
└── knowledge/         # 知识库
    ├── tech.md
    └── workflow.md
```

### 4. 监控记忆服务性能

```typescript
// 记录检索耗时
const result = await memoryService.retrieve(request);
if (result.durationMs > 1000) {
  console.warn(`Slow memory retrieval: ${result.durationMs}ms`);
}

// 记录归档成功率
const result = await memoryService.archive(request);
if (!result.success) {
  console.error(`Memory archival failed: ${result.error}`);
}
```

---

## 相关文档

- [多层 Agent 架构](./multi-layer-architecture.md)
- [会话总结](../src/agents/session-summary.ts)
- [记忆索引管理](../src/memory/manager.ts)
- [记忆系统集成需求](../.kiro/specs/memory-integration/requirements.md)
- [记忆系统集成设计](../.kiro/specs/memory-integration/design.md)

---

**版本：** v1.0  
**创建时间：** 2026-01-31  
**作者：** Kiro AI Assistant
