# 递归任务系统改进设计文档

**日期**: 2026-02-06  
**状态**: 草稿

---

## 1. 系统架构

### 1.1 改进概览

本次改进涉及三个独立的模块:

```
┌─────────────────────────────────────────────────────────────┐
│                    递归任务系统改进                          │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────┐│
│  │  改进 1:         │  │  改进 2:         │  │  改进 3:   ││
│  │  精确匹配        │  │  富文本报告      │  │  智能深度  ││
│  │                  │  │                  │  │  控制      ││
│  │  - subTaskId     │  │  - HTML 模板     │  │  - 复杂度  ││
│  │  - ID 匹配逻辑   │  │  - 格式选择      │  │    评分    ││
│  │                  │  │  - 频道适配      │  │  - 动态    ││
│  │                  │  │                  │  │    深度    ││
│  └──────────────────┘  └──────────────────┘  └────────────┘│
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 改进 1: 精确的并行任务匹配

### 2.1 问题分析

**当前实现** (`src/auto-reply/reply/queue/drain.ts:145`):
```typescript
const idx = queue.items.findIndex((item) => item.prompt === pgTask.prompt);
```

**问题**:
- 使用 `prompt` 字符串匹配
- 当两个子任务的 prompt 相同时,会匹配到第一个,导致误匹配
- 例如: "编写测试" 这个 prompt 可能对应多个不同的子任务

### 2.2 解决方案

#### 2.2.1 数据结构扩展

**扩展 `FollowupRun` 接口** (`src/auto-reply/reply/queue/types.ts`):
```typescript
export interface FollowupRun {
  prompt: string;
  run: SessionRun;
  enqueuedAt: number;
  originatingChannel?: string;
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: number;
  isQueueTask?: boolean;
  
  // 🆕 新增字段
  subTaskId?: string;  // 关联的子任务 ID
}
```

#### 2.2.2 ID 传递流程

```
enqueue_task 工具
    ↓ (创建 FollowupRun 时携带 subTaskId)
队列系统 (FOLLOWUP_QUEUES)
    ↓ (保持 subTaskId)
drain.ts 并行匹配
    ↓ (优先使用 subTaskId 匹配)
runFollowup 执行
```

#### 2.2.3 匹配逻辑

**新的匹配逻辑** (`src/auto-reply/reply/queue/drain.ts`):
```typescript
// 从队列中提取与并行组匹配的 items
for (const pgTask of parallelGroup) {
  const idx = queue.items.findIndex((item) => {
    // 🆕 优先使用 ID 匹配
    if (item.subTaskId && pgTask.id) {
      return item.subTaskId === pgTask.id;
    }
    // 回退到 prompt 匹配(向后兼容)
    return item.prompt === pgTask.prompt;
  });
  
  if (idx >= 0) {
    parallelItems.push(queue.items.splice(idx, 1)[0]);
  }
}
```

### 2.3 向后兼容性

- 旧的队列项(没有 `subTaskId`)仍使用 prompt 匹配
- 新的队列项优先使用 ID 匹配
- 不影响现有功能

---

## 3. 改进 2: 富文本交付报告

### 3.1 问题分析

**当前实现** (`src/auto-reply/reply/followup-runner.ts:344`):
```typescript
const report = reporter.generateReport(taskTree);
const markdown = reporter.formatAsMarkdown(report);
await sendFollowupPayloads([{ text: markdown }], queued);
```

**问题**:
- 只支持纯文本 Markdown
- 缺乏视觉吸引力
- 统计数据不够直观

### 3.2 解决方案

#### 3.2.1 报告格式器架构

```typescript
interface ReportFormatter {
  format(report: DeliveryReport): string;
  supportsChannel(channel: string): boolean;
}

class MarkdownFormatter implements ReportFormatter {
  format(report: DeliveryReport): string {
    // 现有的 Markdown 格式化逻辑
  }
  
  supportsChannel(channel: string): boolean {
    return true; // 所有频道都支持
  }
}

class HTMLFormatter implements ReportFormatter {
  format(report: DeliveryReport): string {
    // 🆕 HTML 格式化逻辑
  }
  
  supportsChannel(channel: string): boolean {
    return ["telegram", "web"].includes(channel);
  }
}
```

#### 3.2.2 HTML 模板设计

**基本结构**:
```html
<!DOCTYPE html>
<html>
<head>
  <style>
    .report-container { font-family: sans-serif; }
    .status-success { color: #28a745; }
    .status-failed { color: #dc3545; }
    .status-pending { color: #ffc107; }
    .progress-bar { background: #e9ecef; height: 20px; }
    .progress-fill { background: #28a745; height: 100%; }
  </style>
</head>
<body>
  <div class="report-container">
    <h2>📦 任务交付报告</h2>
    
    <!-- 统计概览 -->
    <div class="statistics">
      <div class="stat-item">
        <span class="label">总任务数:</span>
        <span class="value">{{totalTasks}}</span>
      </div>
      <div class="stat-item">
        <span class="label">成功率:</span>
        <span class="value status-success">{{successRate}}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: {{successRate}}%"></div>
      </div>
    </div>
    
    <!-- 任务详情 -->
    <details>
      <summary>任务详情 ({{completedTasks}} 已完成)</summary>
      <ul>
        {{#each tasks}}
        <li class="status-{{status}}">
          {{name}} - {{status}}
          {{#if output}}
          <details>
            <summary>查看输出</summary>
            <pre>{{output}}</pre>
          </details>
          {{/if}}
        </li>
        {{/each}}
      </ul>
    </details>
  </div>
</body>
</html>
```

#### 3.2.3 格式选择逻辑

```typescript
function selectFormatter(channel?: string): ReportFormatter {
  const formatters = [
    new HTMLFormatter(),
    new MarkdownFormatter(), // 默认回退
  ];
  
  for (const formatter of formatters) {
    if (formatter.supportsChannel(channel || "")) {
      return formatter;
    }
  }
  
  return new MarkdownFormatter();
}
```

#### 3.2.4 安全性

- 使用模板引擎自动转义 HTML
- 或手动转义所有用户输入:
  ```typescript
  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  ```

---

## 4. 改进 3: 智能的自适应深度控制

### 4.1 问题分析

**当前实现** (`src/agents/intelligent-task-decomposition/orchestrator.ts:1343`):
```typescript
calculateAdaptiveMaxDepth(rootTask: string, subTaskCount: number): number {
  if (subTaskCount <= 3) return 1;
  if (subTaskCount <= 10) return 2;
  return 3;
}
```

**问题**:
- 只考虑子任务数量
- 未考虑任务类型(写作 vs 编码)
- 未考虑任务复杂度
- 未利用历史数据

### 4.2 解决方案

#### 4.2.1 复杂度评分模型

**评分维度**:

1. **Prompt 长度** (0-25 分):
   ```typescript
   const lengthScore = Math.min(25, prompt.length / 40);
   ```

2. **任务类型** (0-25 分):
   ```typescript
   const typeScores = {
     writing: 15,      // 写作任务
     coding: 20,       // 编码任务
     data: 10,         // 数据处理
     research: 18,     // 研究任务
     default: 12,      // 默认
   };
   ```

3. **工具依赖** (0-25 分):
   ```typescript
   const toolScore = Math.min(25, estimatedToolCount * 5);
   ```

4. **历史数据** (0-25 分):
   ```typescript
   const historicalScore = getAverageDepthForSimilarTasks(prompt);
   ```

**总分计算**:
```typescript
complexityScore = lengthScore + typeScore + toolScore + historicalScore;
// 范围: 0-100
```

#### 4.2.2 深度计算公式

```typescript
calculateAdaptiveMaxDepth(
  rootTask: string,
  subTaskCount: number,
  metadata?: TaskMetadata
): number {
  // 🆕 计算复杂度评分
  const complexityScore = this.calculateComplexityScore(
    rootTask,
    subTaskCount,
    metadata
  );
  
  // 🆕 基于复杂度计算深度
  let maxDepth = 1 + Math.floor(complexityScore / 25);
  
  // 限制范围: 1-4
  maxDepth = Math.max(1, Math.min(4, maxDepth));
  
  // 🆕 记录评分(用于后续优化)
  if (metadata) {
    metadata.complexityScore = complexityScore;
    metadata.calculatedMaxDepth = maxDepth;
  }
  
  return maxDepth;
}
```

#### 4.2.3 任务类型识别

```typescript
function identifyTaskType(prompt: string): string {
  const keywords = {
    writing: ["写", "撰写", "编写文章", "创作", "write", "compose"],
    coding: ["代码", "实现", "开发", "编程", "code", "implement", "develop"],
    data: ["数据", "分析", "处理", "统计", "data", "analyze", "process"],
    research: ["研究", "调查", "查找", "搜索", "research", "investigate"],
  };
  
  for (const [type, words] of Object.entries(keywords)) {
    if (words.some(word => prompt.toLowerCase().includes(word))) {
      return type;
    }
  }
  
  return "default";
}
```

#### 4.2.4 历史数据收集

**数据结构**:
```typescript
interface TaskHistoryRecord {
  prompt: string;
  type: string;
  actualDepth: number;
  subTaskCount: number;
  complexityScore: number;
  timestamp: number;
}
```

**存储位置**: `~/.clawdbot/tasks/history.jsonl`

**查询逻辑**:
```typescript
function getAverageDepthForSimilarTasks(prompt: string): number {
  const history = loadTaskHistory();
  const type = identifyTaskType(prompt);
  
  const similarTasks = history.filter(
    record => record.type === type
  );
  
  if (similarTasks.length === 0) return 12; // 默认分数
  
  const avgDepth = similarTasks.reduce(
    (sum, r) => sum + r.actualDepth, 0
  ) / similarTasks.length;
  
  // 转换为 0-25 分
  return Math.min(25, avgDepth * 8);
}
```

---

## 5. 实现顺序

### 5.1 阶段 1: 精确匹配 (高优先级)

1. 扩展 `FollowupRun` 接口
2. 修改 `enqueue_task` 工具传递 `subTaskId`
3. 更新 `drain.ts` 匹配逻辑
4. 编写单元测试和集成测试

### 5.2 阶段 2: 智能深度控制 (中优先级)

1. 实现复杂度评分模型
2. 实现任务类型识别
3. 更新 `calculateAdaptiveMaxDepth` 方法
4. 实现历史数据收集和查询
5. 编写单元测试

### 5.3 阶段 3: 富文本报告 (低优先级)

1. 设计 HTML 模板
2. 实现 `HTMLFormatter` 类
3. 实现格式选择逻辑
4. 更新 `followup-runner.ts` 发送逻辑
5. 编写快照测试

---

## 6. 测试策略

### 6.1 单元测试

- `FollowupRun` 接口扩展的类型测试
- 匹配逻辑的各种场景测试
- 复杂度评分的边界测试
- HTML 转义的安全性测试

### 6.2 集成测试

- 并行执行的端到端测试
- 不同频道的报告格式测试
- 深度控制的实际任务测试

### 6.3 性能测试

- 复杂度评分的性能测试(< 100ms)
- HTML 生成的性能测试(< 200ms)
- 大规模并行匹配的性能测试

---

## 7. 监控与指标

### 7.1 关键指标

- 并行匹配准确率
- 复杂度评分与实际深度的相关性
- HTML 报告的采用率
- 报告生成时间

### 7.2 日志记录

```typescript
console.log(`[task-matching] Using ID match: ${item.subTaskId} === ${pgTask.id}`);
console.log(`[complexity] Score: ${score}, Type: ${type}, Depth: ${depth}`);
console.log(`[report] Format: ${format}, Channel: ${channel}`);
```

---

## 8. 回滚计划

### 8.1 功能开关

```typescript
const FEATURE_FLAGS = {
  USE_ID_MATCHING: true,
  USE_HTML_REPORTS: true,
  USE_SMART_DEPTH: true,
};
```

### 8.2 回滚步骤

1. 关闭对应的功能开关
2. 系统自动回退到旧逻辑
3. 不影响现有数据

---

**版本**: v1.0  
**最后更新**: 2026-02-06  
**状态**: 待审核
