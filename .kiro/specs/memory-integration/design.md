# 记忆系统集成设计文档

## 1. 架构设计

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    多层 Agent 架构                           │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐         ┌──────────────┐                  │
│  │ 虚拟世界层   │         │   管家层     │                  │
│  │ (角色扮演)   │────────▶│  (栗娜)      │                  │
│  └──────────────┘         └──────────────┘                  │
│         │                        │                           │
│         │                        │                           │
│         ▼                        ▼                           │
│  ┌─────────────────────────────────────────┐                │
│  │        记忆服务 (Memory Service)        │                │
│  ├─────────────────────────────────────────┤                │
│  │  - 记忆检索 (Memory Retrieval)          │                │
│  │  - 记忆归档 (Memory Archival)           │                │
│  │  - 上下文注入 (Context Injection)       │                │
│  └─────────────────────────────────────────┘                │
│         │                        │                           │
│         ▼                        ▼                           │
│  ┌──────────────┐         ┌──────────────┐                  │
│  │ 记忆索引管理 │         │ 会话总结     │                  │
│  │ (Manager)    │         │ (Summary)    │                  │
│  └──────────────┘         └──────────────┘                  │
│         │                        │                           │
│         ▼                        ▼                           │
│  ┌─────────────────────────────────────────┐                │
│  │          记忆存储 (SQLite + Files)      │                │
│  └─────────────────────────────────────────┘                │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 核心组件

#### 1.2.1 记忆服务 (MemoryService)
- **职责**：提供统一的记忆检索和归档接口
- **位置**：`src/agents/memory/service.ts`
- **依赖**：`MemoryIndexManager`, `SessionSummary`

#### 1.2.2 记忆检索器 (MemoryRetriever)
- **职责**：检索相关记忆并格式化为上下文
- **位置**：`src/agents/memory/retriever.ts`
- **依赖**：`MemoryIndexManager`

#### 1.2.3 记忆归档器 (MemoryArchiver)
- **职责**：生成总结并归档到记忆存储
- **位置**：`src/agents/memory/archiver.ts`
- **依赖**：`SessionSummary`, `MemoryIndexManager`

---

## 2. 接口设计

### 2.1 记忆服务接口

```typescript
/**
 * 记忆服务配置
 */
export interface MemoryServiceConfig {
  /** 检索配置 */
  retrieval: {
    /** 最大结果数 */
    maxResults: number;
    /** 最小相关性分数 */
    minScore: number;
    /** 检索来源 */
    sources: ("memory" | "sessions")[];
    /** 检索超时（毫秒） */
    timeoutMs: number;
  };
  /** 归档配置 */
  archival: {
    /** 归档策略 */
    strategy: "always" | "on-demand" | "threshold";
    /** 归档路径 */
    path: string;
    /** 归档格式 */
    format: "markdown" | "json";
    /** 归档频率（轮数） */
    frequency: number;
  };
}

/**
 * 记忆检索请求
 */
export interface MemoryRetrievalRequest {
  /** 查询文本 */
  query: string;
  /** 上下文信息 */
  context: {
    userId: string;
    sessionId: string;
    agentId?: string;
    layer?: "virtual-world" | "butler" | "execution";
  };
  /** 检索参数（可选，覆盖默认配置） */
  params?: {
    maxResults?: number;
    minScore?: number;
    sources?: ("memory" | "sessions")[];
  };
}

/**
 * 记忆检索结果
 */
export interface MemoryRetrievalResult {
  /** 检索到的记忆列表 */
  memories: Array<{
    /** 文件路径 */
    path: string;
    /** 内容片段 */
    snippet: string;
    /** 相关性分数 */
    score: number;
    /** 来源 */
    source: "memory" | "sessions";
    /** 时间戳 */
    timestamp?: number;
    /** 起始行 */
    startLine: number;
    /** 结束行 */
    endLine: number;
  }>;
  /** 格式化的上下文（可直接注入 System Prompt） */
  formattedContext: string;
  /** 检索耗时（毫秒） */
  durationMs: number;
}

/**
 * 记忆归档请求
 */
export interface MemoryArchivalRequest {
  /** 会话总结 */
  summary: SessionSummary;
  /** 上下文信息 */
  context: {
    userId: string;
    sessionId: string;
    agentId?: string;
  };
  /** 归档参数（可选，覆盖默认配置） */
  params?: {
    path?: string;
    format?: "markdown" | "json";
  };
}

/**
 * 记忆归档结果
 */
export interface MemoryArchivalResult {
  /** 归档文件路径 */
  path: string;
  /** 归档是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
  /** 归档耗时（毫秒） */
  durationMs: number;
}

/**
 * 记忆服务接口
 */
export interface IMemoryService {
  /**
   * 检索相关记忆
   */
  retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult>;

  /**
   * 归档会话总结
   */
  archive(request: MemoryArchivalRequest): Promise<MemoryArchivalResult>;

  /**
   * 获取记忆服务状态
   */
  status(): {
    enabled: boolean;
    retrieval: { enabled: boolean; available: boolean };
    archival: { enabled: boolean; available: boolean };
  };
}
```

---

## 3. 数据流设计

### 3.1 对话前记忆检索流程

```
用户消息
   │
   ▼
管家层 beforeConversation()
   │
   ├─▶ 构建检索请求
   │   - query: 用户消息
   │   - context: { userId, sessionId, layer }
   │
   ├─▶ 调用 memoryService.retrieve()
   │   │
   │   ├─▶ MemoryIndexManager.search()
   │   │   - 向量检索
   │   │   - 关键词检索
   │   │   - 混合排序
   │   │
   │   ├─▶ 格式化结果
   │   │   - 按相关性排序
   │   │   - 截断到最大结果数
   │   │   - 生成上下文文本
   │   │
   │   └─▶ 返回 MemoryRetrievalResult
   │
   ├─▶ 注入到上下文
   │   - context.memories = result.memories
   │   - context.memoryContext = result.formattedContext
   │
   └─▶ 继续对话流程
```

### 3.2 对话后记忆归档流程

```
对话结束
   │
   ▼
管家层 afterConversation()
   │
   ├─▶ 生成会话总结
   │   - generateSessionSummary(messages)
   │   - 提取任务目标、关键操作、决策、问题
   │
   ├─▶ 构建归档请求
   │   - summary: SessionSummary
   │   - context: { userId, sessionId }
   │
   ├─▶ 异步调用 memoryService.archive()
   │   │
   │   ├─▶ 格式化总结
   │   │   - Markdown 格式
   │   │   - 包含元数据（时间、会话 ID）
   │   │
   │   ├─▶ 写入文件
   │   │   - 路径：memory/sessions/{date}/{sessionId}.md
   │   │   - 确保目录存在
   │   │
   │   ├─▶ 触发索引更新
   │   │   - MemoryIndexManager.sync()
   │   │
   │   └─▶ 返回 MemoryArchivalResult
   │
   └─▶ 记录日志（成功或失败）
```

---

## 4. 实现细节

### 4.1 记忆检索实现

#### 4.1.1 检索策略

```typescript
async retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
  const startTime = Date.now();
  
  try {
    // 1. 获取记忆索引管理器
    const manager = await MemoryIndexManager.get({
      cfg: this.config,
      agentId: request.context.agentId || "main",
    });
    
    if (!manager) {
      return this.emptyResult(startTime);
    }
    
    // 2. 执行检索（带超时）
    const params = request.params || {};
    const maxResults = params.maxResults ?? this.config.retrieval.maxResults;
    const minScore = params.minScore ?? this.config.retrieval.minScore;
    
    const results = await this.withTimeout(
      manager.search(request.query, {
        maxResults,
        minScore,
        sessionKey: request.context.sessionId,
      }),
      this.config.retrieval.timeoutMs,
    );
    
    // 3. 格式化结果
    const formattedContext = this.formatMemoryContext(results);
    
    return {
      memories: results,
      formattedContext,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    log.warn(`Memory retrieval failed: ${error}`);
    return this.emptyResult(startTime);
  }
}

private formatMemoryContext(memories: MemorySearchResult[]): string {
  if (memories.length === 0) {
    return "";
  }
  
  const parts = [
    "## 相关记忆 (Relevant Memories)",
    "",
  ];
  
  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];
    parts.push(`### 记忆 ${i + 1} (相关性: ${(memory.score * 100).toFixed(0)}%)`);
    parts.push(`**来源**: ${memory.path} (行 ${memory.startLine}-${memory.endLine})`);
    parts.push("");
    parts.push(memory.snippet);
    parts.push("");
  }
  
  return parts.join("\n");
}
```

#### 4.1.2 降级处理

```typescript
private emptyResult(startTime: number): MemoryRetrievalResult {
  return {
    memories: [],
    formattedContext: "",
    durationMs: Date.now() - startTime,
  };
}

private async withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), timeoutMs)
    ),
  ]);
}
```

### 4.2 记忆归档实现

#### 4.2.1 归档策略

```typescript
async archive(request: MemoryArchivalRequest): Promise<MemoryArchivalResult> {
  const startTime = Date.now();
  
  try {
    // 1. 检查归档策略
    if (!this.shouldArchive(request)) {
      return {
        path: "",
        success: true,
        durationMs: Date.now() - startTime,
      };
    }
    
    // 2. 格式化总结
    const content = this.formatSummary(request.summary, request.context);
    
    // 3. 确定归档路径
    const archivePath = this.resolveArchivePath(request);
    
    // 4. 写入文件
    await this.writeArchiveFile(archivePath, content);
    
    // 5. 触发索引更新（异步）
    this.triggerIndexUpdate(request.context.agentId).catch((err) => {
      log.warn(`Memory index update failed: ${err}`);
    });
    
    return {
      path: archivePath,
      success: true,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    log.error(`Memory archival failed: ${error}`);
    return {
      path: "",
      success: false,
      error: String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

private shouldArchive(request: MemoryArchivalRequest): boolean {
  const strategy = this.config.archival.strategy;
  
  if (strategy === "always") {
    return true;
  }
  
  if (strategy === "on-demand") {
    return false; // 需要显式调用
  }
  
  if (strategy === "threshold") {
    // 检查是否达到归档阈值
    const frequency = this.config.archival.frequency;
    return request.summary.totalTurns >= frequency;
  }
  
  return false;
}

private formatSummary(
  summary: SessionSummary,
  context: { userId: string; sessionId: string },
): string {
  const date = new Date(summary.createdAt).toISOString();
  
  const parts = [
    `# 会话总结 - ${context.sessionId}`,
    "",
    `**时间**: ${date}`,
    `**用户**: ${context.userId}`,
    `**对话轮数**: ${summary.totalTurns}`,
    "",
    `## 任务目标`,
    "",
    summary.taskGoal,
    "",
  ];
  
  if (summary.keyActions.length > 0) {
    parts.push(`## 关键操作`, "");
    parts.push(...summary.keyActions.map((a) => `- ${a}`));
    parts.push("");
  }
  
  if (summary.keyDecisions.length > 0) {
    parts.push(`## 关键决策`, "");
    parts.push(...summary.keyDecisions.map((d, i) => `${i + 1}. ${d}`));
    parts.push("");
  }
  
  if (summary.blockers.length > 0) {
    parts.push(`## 遇到的问题`, "");
    parts.push(...summary.blockers.map((b, i) => `${i + 1}. ${b}`));
    parts.push("");
  }
  
  if (summary.progress) {
    parts.push(`## 进度`, "");
    parts.push(`${summary.progress.completed}/${summary.progress.total} (${summary.progress.percentage}%)`);
    parts.push("");
  }
  
  return parts.join("\n");
}
```

### 4.3 管家层集成

#### 4.3.1 修改 ButlerAgent

```typescript
export class ButlerAgent {
  constructor(
    private taskDelegator: TaskDelegator,
    private skillCaller: SkillCaller,
    private llmProvider: LLMProvider,
    private memoryService: IMemoryService, // 新增
  ) {}

  /**
   * 对话前任务调度（记忆填充）
   */
  private async beforeConversation(context: ConversationContext): Promise<void> {
    try {
      // 检索相关记忆
      const result = await this.memoryService.retrieve({
        query: context.messages[context.messages.length - 1]?.content || "",
        context: {
          userId: context.userId,
          sessionId: context.sessionId,
          layer: "butler",
        },
      });

      // 注入到上下文
      if (result.memories.length > 0) {
        (context as any).memories = result.memories;
        (context as any).memoryContext = result.formattedContext;
      }
    } catch (error) {
      // 记录错误但不影响对话流程
      console.error("Memory retrieval failed:", error);
    }
  }

  /**
   * 对话后任务调度（总结归档）
   */
  private async afterConversation(
    context: ConversationContext,
    result: string,
  ): Promise<void> {
    try {
      // 生成会话总结
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
      // 记录错误但不影响对话流程
      console.error("Memory archival failed:", error);
    }
  }
}
```

---

## 5. 配置设计

### 5.1 配置结构

```typescript
// 在 clawdbot.json 中添加
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

### 5.2 配置加载

```typescript
export function resolveMemoryServiceConfig(
  cfg: ClawdbotConfig,
  agentId: string,
): MemoryServiceConfig | null {
  const agentCfg = cfg.agents?.[agentId];
  const memoryCfg = agentCfg?.memory;
  
  if (!memoryCfg?.enabled) {
    return null;
  }
  
  return {
    retrieval: {
      maxResults: memoryCfg.retrieval?.maxResults ?? 5,
      minScore: memoryCfg.retrieval?.minScore ?? 0.7,
      sources: memoryCfg.retrieval?.sources ?? ["memory", "sessions"],
      timeoutMs: memoryCfg.retrieval?.timeoutMs ?? 5000,
    },
    archival: {
      strategy: memoryCfg.archival?.strategy ?? "threshold",
      path: memoryCfg.archival?.path ?? "memory/sessions",
      format: memoryCfg.archival?.format ?? "markdown",
      frequency: memoryCfg.archival?.frequency ?? 5,
    },
  };
}
```

---

## 6. 测试设计

### 6.1 单元测试

```typescript
describe("MemoryService", () => {
  describe("retrieve", () => {
    it("should retrieve relevant memories", async () => {
      const service = new MemoryService(config);
      const result = await service.retrieve({
        query: "如何使用多层架构",
        context: { userId: "test", sessionId: "test" },
      });
      
      expect(result.memories.length).toBeGreaterThan(0);
      expect(result.formattedContext).toContain("相关记忆");
    });
    
    it("should handle retrieval timeout", async () => {
      const service = new MemoryService({
        ...config,
        retrieval: { ...config.retrieval, timeoutMs: 1 },
      });
      
      const result = await service.retrieve({
        query: "test",
        context: { userId: "test", sessionId: "test" },
      });
      
      expect(result.memories.length).toBe(0);
    });
  });
  
  describe("archive", () => {
    it("should archive session summary", async () => {
      const service = new MemoryService(config);
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
      expect(result.path).toContain("memory/sessions");
    });
  });
});
```

---

**版本：** v1.0  
**创建时间：** 2026-01-31  
**作者：** Kiro AI Assistant
