# V8: 系统泛化能力增强 — 完整架构设计

> 生成时间: 2026-02-12
> 状态: 设计完成，待实施
> 前置依赖: P1-P69 + S1-S4 + V3-V7 已合入

---

## 一、当前系统智能层次定位

| 层次 | 能力 | 当前状态 |
|------|------|----------|
| L1: 执行 | LLM 能完成单个子任务 | ✅ 已有 |
| L2: 分解+质检 | 系统能分解任务、检查质量、retry | ✅ 已有（但刻板） |
| L3: 自我纠正 | 系统能检测并修复自身的决策错误 | ⚠️ S1-S4 刚开始 |
| L4: 自我优化 | 系统能从历史中学习，跨任务改进策略 | ❌ 完全缺失 |

**目标**: 从 L3 推进到 L4，让系统真正"泛化解决各种任务"。

---

## 二、6 个架构增强总览

| 编号 | 名称 | 解决的核心问题 | 优先级 | 预估工作量 |
|------|------|---------------|--------|-----------|
| P0 | 上下文预算管理器 | 上下文溢出是最频繁的失败原因 | 🔴 P0 | 1-2 天 |
| P1 | 任务模板系统 | 命名/结构混乱的根因（Prompt-as-Contract） | 🔴 P1 | 2-3 天 |
| P2 | 执行策略路由器 | LLM 浪费（合并/交付不应走 LLM） | 🟡 P2 | 1 天 |
| P3 | 跨任务经验池 | 无法跨任务学习（L3→L4 的关键跃迁） | 🟡 P3 | 1-2 天 |
| P4 | 产出一致性检查器 | 单点质检无法发现跨子任务问题 | 🟡 P4 | 1 天 |
| P5 | 轮次进度仪表盘 | 用户无法感知整体进度 | 🟢 P5 | 半天 |

---

## 三、P0: 上下文预算管理器 (Context Budget Manager)

### 3.1 问题诊断

**当前 prompt 构建各组件的 token 消耗分布**（典型写作子任务）：

| 组件 | 位置 | 字符数 | 估算 tokens | 截断方式 |
|------|------|--------|------------|---------|
| 系统基础 prompt（工具描述等） | attempt.ts | ~15,000 | ~5,000 | 白名单过滤 |
| blueprintCtx (V7结构化) | followup-runner 696-833 | ~4,000 | ~2,000 | 各组件独立硬截断 |
| chapterOutlineCtx | followup-runner 744-791 | ~1,500 | ~750 | 无截断 |
| siblingCtx | followup-runner 700-701 | ~2,000 | ~1,000 | buildSiblingContext 200字上限 |
| persistInstruction | followup-runner 710-712 | ~150 | ~75 | 无 |
| 用户 prompt（含落盘+禁委派+迭代） | followup-runner 630-695 | ~3,500 | ~1,750 | previousOutput 按类型截断 |
| **输入总计** | | **~26,150** | **~10,575** | |
| 输出保留 (maxTokens) | | | **4,096** | 固定值 |
| **总消耗** | | | **~14,671** | |

**溢出场景**（在实际运行中已观察到的）：

1. **masterBlueprint 回退路径**: 8000+字 → 额外 +4000 tokens
2. **previousOutput 注入**: 2500字写作类 → 额外 +1250 tokens
3. **小 context window 模型**: 某些 provider 只有 16K-32K
4. **session 累积**: 多轮 tool call 结果在 session 中累积
5. **V7 人物卡+世界观**: 大型创作项目可能 10000+ 字

**根本缺陷**：
- 所有截断都是**字符级**硬编码，不感知 token 预算
- 各组件**独立截断**，不感知其他组件的消耗
- **没有输出空间预留**的概念——输入塞满后 LLM 只能产出极短响应
- **model.contextWindow 信息不流向 prompt 构建层**

### 3.2 设计方案

#### 3.2.1 核心接口

```typescript
// 新文件: src/agents/intelligent-task-decomposition/context-budget-manager.ts

/**
 * Token 预算分配结果
 *
 * 为 prompt 的每个组件分配 token 预算，
 * 确保总消耗不超过模型的 context window。
 */
export interface BudgetAllocation {
  /** 各组件的 token 预算 */
  slots: {
    /** 系统基础 prompt（工具描述+agent info）— 不可压缩 */
    systemBase: number;
    /** 纲领上下文（blueprint/characterCards/worldBuilding/styleGuide） */
    blueprint: number;
    /** 章节大纲（chapterOutline + 相邻章节摘要） */
    chapterOutline: number;
    /** 兄弟上下文（siblingCtx） */
    siblingContext: number;
    /** 迭代优化（previousOutput + failureFindings） */
    iterationContext: number;
    /** 用户 prompt 本体（含强制指令） */
    userPrompt: number;
    /** LLM 输出保留空间 */
    outputReserve: number;
  };
  /** 模型总 context window (tokens) */
  totalBudget: number;
  /** 实际分配的输入 token 预算 */
  inputBudget: number;
  /** 是否触发了预算压缩 */
  compressed: boolean;
  /** 压缩摘要（各组件实际分配 vs 期望分配） */
  compressionLog?: string;
}

/**
 * 预算请求 — 各组件申报自己的"期望"和"最低"token 数
 */
export interface BudgetRequest {
  /** 组件名 */
  slot: keyof BudgetAllocation["slots"];
  /** 期望 token 数（理想状态） */
  desired: number;
  /** 最低可接受 token 数（低于此值该组件无意义） */
  minimum: number;
  /** 优先级（0=最高，数字越大越容易被压缩） */
  priority: number;
  /** 实际内容（用于截断） */
  content?: string;
}

/**
 * 上下文预算管理器
 *
 * 核心职责：
 * 1. 根据模型 contextWindow 和 maxTokens 计算可用输入预算
 * 2. 按优先级为各组件分配 token 预算
 * 3. 超预算时按优先级从低到高压缩
 * 4. 返回每个组件的截断后内容
 */
export class ContextBudgetManager {
  /**
   * 分配预算
   *
   * @param contextWindow 模型 context window (tokens)
   * @param maxOutputTokens 模型 max output tokens
   * @param requests 各组件的预算申请
   * @returns 分配结果（含截断后的内容）
   */
  static allocate(
    contextWindow: number,
    maxOutputTokens: number,
    requests: BudgetRequest[],
  ): BudgetAllocation;

  /**
   * 估算文本的 token 数
   *
   * 轻量级估算（不调用 tokenizer）：
   * - 中文：1 字符 ≈ 1.5 tokens（保守估计）
   * - 英文：4 字符 ≈ 1 token
   * - 混合文本：按比例加权
   */
  static estimateTokens(text: string): number;

  /**
   * 按 token 预算智能截断文本
   *
   * 不是简单的 substring，而是找最近的完整边界：
   * - 段落边界（\n\n）
   * - 句子边界（。！？.!?）
   * - 行边界（\n）
   */
  static truncateToTokenBudget(
    text: string,
    tokenBudget: number,
    options?: {
      /** 截断方向: head=保留开头, tail=保留结尾, both=首尾各保留 */
      direction?: "head" | "tail" | "both";
      /** both 模式下的头部比例 (0-1) */
      headRatio?: number;
      /** 内容类型（影响边界检测策略） */
      contentType?: "writing" | "coding" | "generic";
    },
  ): string;
}
```

#### 3.2.2 预算分配策略

**预算池计算**：
```
inputBudget = contextWindow - maxOutputTokens - sessionOverhead(500)
```

**优先级分配表**（priority 越小越重要）：

| 优先级 | 组件 | 最低占比 | 期望占比 | 压缩策略 |
|--------|------|---------|---------|---------|
| 0 | systemBase | 不可压缩 | 实际消耗 | 不压缩 |
| 1 | userPrompt | 15% | 30% | 智能截断迭代部分 |
| 2 | outputReserve | maxTokens | maxTokens | 不压缩 |
| 3 | chapterOutline | 3% | 8% | 截断到核心段落 |
| 4 | blueprint | 5% | 20% | 按组件优先级逐个裁剪 |
| 5 | iterationContext | 0% | 10% | 先砍 previousOutput |
| 6 | siblingContext | 0% | 5% | 可完全丢弃 |

**压缩流程**：
1. 计算 `inputBudget = contextWindow - maxOutputTokens - 500`
2. 所有组件先按"期望"分配
3. 如果总和 > inputBudget，从优先级最低的组件开始：
   - 先压缩到 minimum
   - 仍然超预算则该组件设为 0（完全丢弃）
   - 继续向高优先级组件压缩
4. 永远不压缩 systemBase 和 outputReserve

#### 3.2.3 Token 估算公式

```typescript
static estimateTokens(text: string): number {
  if (!text) return 0;
  // 统计中文字符数
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjkCount = text.length - cjkCount;
  // 中文: ~1.5 tokens/char (保守), 英文: ~0.25 tokens/char
  return Math.ceil(cjkCount * 1.5 + nonCjkCount * 0.25);
}
```

#### 3.2.4 集成点（followup-runner.ts 改造）

**当前流程**：
```
extraSystemPrompt = [base, siblingCtx, persistInstruction, blueprintCtx, chapterOutlineCtx].join("")
```

**改造后流程**：
```typescript
// 1. 收集所有组件的原始内容
const components = {
  systemBase: base + persistInstruction,
  blueprint: rawBlueprintCtx,
  chapterOutline: rawChapterOutlineCtx,
  siblingContext: rawSiblingCtx,
  iterationContext: rawIterationHint,
  userPrompt: rawPrompt,
};

// 2. 构建预算请求
const requests: BudgetRequest[] = [
  { slot: "systemBase", desired: estimateTokens(components.systemBase), minimum: estimateTokens(components.systemBase), priority: 0, content: components.systemBase },
  { slot: "userPrompt", desired: estimateTokens(components.userPrompt), minimum: estimateTokens(rawPromptWithoutIteration), priority: 1, content: components.userPrompt },
  { slot: "chapterOutline", desired: estimateTokens(components.chapterOutline), minimum: 200, priority: 3, content: components.chapterOutline },
  { slot: "blueprint", desired: estimateTokens(components.blueprint), minimum: 500, priority: 4, content: components.blueprint },
  { slot: "iterationContext", desired: estimateTokens(components.iterationContext), minimum: 0, priority: 5, content: components.iterationContext },
  { slot: "siblingContext", desired: estimateTokens(components.siblingContext), minimum: 0, priority: 6, content: components.siblingContext },
];

// 3. 分配预算（需要 model.contextWindow 和 maxOutputTokens）
const allocation = ContextBudgetManager.allocate(contextWindow, maxOutputTokens, requests);

// 4. 按分配结果截断各组件
const truncatedBlueprint = ContextBudgetManager.truncateToTokenBudget(
  components.blueprint, allocation.slots.blueprint, { direction: "both", headRatio: 0.7 }
);
// ... 其他组件类似

// 5. 拼接
extraSystemPrompt = [truncatedSystemBase, truncatedSiblingCtx, truncatedBlueprint, truncatedChapterOutline].join("");
```

#### 3.2.5 模型信息传递链改造

**当前**：`model.contextWindow` 在 `run.ts` 中解析，但不传递给 followup-runner。

**改造**：

1. `FollowupRun` 接口新增字段：
```typescript
// src/auto-reply/reply/followup-types.ts (或 types 所在文件)
interface FollowupRun {
  // ... 现有字段
  /** 模型 context window (tokens) — 由 enqueue 时填入 */
  modelContextWindow?: number;
  /** 模型 max output tokens — 由 enqueue 时填入 */
  modelMaxOutputTokens?: number;
}
```

2. `enqueue-task-tool.ts` 构建 FollowupRun 时，从 config 或全局 orchestrator 获取模型配置并填入。

3. `followup-runner.ts` 在构建 prompt 时读取 `queued.modelContextWindow`，传给 ContextBudgetManager。

4. **回退策略**：如果 FollowupRun 中没有模型信息，默认使用保守的 32K context window。

#### 3.2.6 需要修改的文件

| 文件 | 改动 |
|------|------|
| **新建** `src/agents/intelligent-task-decomposition/context-budget-manager.ts` | 核心模块（~200行） |
| `src/auto-reply/reply/followup-runner.ts` | 集成 BudgetManager 到 prompt 构建流程 |
| `src/agents/tools/enqueue-task-tool.ts` | FollowupRun 填入模型配置 |
| `src/auto-reply/reply/followup-types.ts` 或等效类型文件 | FollowupRun 新增字段 |

---

## 四、P1: 任务模板系统 (Task Template)

### 4.1 问题诊断

当前系统每次创作任务都从零开始，LLM 自由决定：
- 分解结构（几个子任务、如何拆分）
- 文件命名（中英混杂、非法字符）
- 章节拆分粒度（5-6章合并、分段数不合理）
- 质检标准（字数阈值、完成度判定）

P37/P40/P67/P68/P69 的命名混乱全是这个根因。S1 的 OutputContract 是正确方向，但粒度不够——它只管单个文件名，不管整体结构。

### 4.2 设计方案

```typescript
// 新文件: src/agents/intelligent-task-decomposition/task-template.ts

/**
 * 任务模板 — 为常见任务类型定义标准化的分解结构
 *
 * 核心理念：LLM 是执行者，不是架构师。
 * 系统控制结构（模板、命名、文件路径），LLM 只负责内容生产。
 */
export interface TaskTemplate {
  /** 模板 ID */
  id: string;
  /** 适用的任务类型 */
  taskType: TaskType;
  /** 模板名称 */
  name: string;
  /** 匹配条件（正则/关键词，用于自动选择模板） */
  matchPatterns: RegExp[];

  /** 分解策略 */
  decomposition: {
    /** 分解方式: "by_chapter" | "by_segment" | "by_module" | "by_phase" | "map_reduce" | "flat" */
    strategy: string;
    /** 默认分段/分章数量（可被用户 prompt 覆盖） */
    defaultPartCount?: number;
    /** 分段间是否串行依赖 */
    sequential: boolean;
    /** 是否需要纲领（masterBlueprint） */
    requiresBlueprint: boolean;
    /** 纲领生成方式: "v7_structured" | "single_pass" | "none" */
    blueprintStrategy: string;
  };

  /** 命名规则 */
  naming: {
    /** 文件名模板 (如 "{projectName}_第{NN}章.txt") */
    fileNameTemplate: string;
    /** 分段文件名模板 (如 "{projectName}_第{NN}章_第{M}节.txt") */
    segmentFileNameTemplate?: string;
    /** 续写文件名模板 (如 "{baseName}_续写{N}.txt") */
    continuationFileNameTemplate?: string;
    /** 最终合并文件名模板 */
    mergedFileNameTemplate: string;
  };

  /** 质检标准 */
  validation: {
    /** 适用的验证策略 */
    strategies: string[];
    /** 字数达标阈值（占目标字数的比例） */
    wordCountThreshold: number;
    /** 分段字数达标阈值 */
    segmentWordCountThreshold: number;
    /** 最大重试次数 */
    maxRetries: number;
  };

  /** 执行策略 */
  execution: {
    /** 推荐的工具白名单 */
    toolAllowlist: string[];
    /** 推荐的 timeout (ms) */
    timeoutMs: number;
    /** 是否可并行执行 */
    allowParallel: boolean;
    /** 并行度上限 */
    maxConcurrency: number;
  };

  /** OutputContract 模板（自动为每个子任务生成） */
  outputContractTemplate: Partial<OutputContract>;
}

/**
 * 内置模板注册表
 */
export const BUILT_IN_TEMPLATES: TaskTemplate[] = [
  // 长篇写作模板
  {
    id: "long_form_writing",
    taskType: "writing",
    name: "长篇写作（小说/报告/论文）",
    matchPatterns: [/小说|长篇|创作|章节|万字/],
    decomposition: {
      strategy: "by_chapter",
      sequential: false, // 章间可并行
      requiresBlueprint: true,
      blueprintStrategy: "v7_structured",
    },
    naming: {
      fileNameTemplate: "{projectName}_第{NN}章.txt",
      segmentFileNameTemplate: "{projectName}_第{NN}章_第{M}节.txt",
      continuationFileNameTemplate: "{baseName}_续写{N}.txt",
      mergedFileNameTemplate: "{projectName}_完整版.txt",
    },
    validation: {
      strategies: ["word_count", "file_output", "completeness"],
      wordCountThreshold: 0.6,
      segmentWordCountThreshold: 0.5,
      maxRetries: 3,
    },
    execution: {
      toolAllowlist: ["write", "read", "edit", "exec", "process"],
      timeoutMs: 180_000,
      allowParallel: true,
      maxConcurrency: 2,
    },
    outputContractTemplate: {
      expectedLanguage: "zh",
    },
  },
  // 代码重构模板
  {
    id: "code_refactor",
    taskType: "coding",
    name: "代码重构/开发",
    matchPatterns: [/重构|开发|实现|编写代码|编码/],
    decomposition: {
      strategy: "by_module",
      sequential: false,
      requiresBlueprint: false,
      blueprintStrategy: "single_pass",
    },
    naming: {
      fileNameTemplate: "{moduleName}.ts",
      mergedFileNameTemplate: "{projectName}_实现报告.md",
    },
    validation: {
      strategies: ["file_output", "completeness", "tool_usage"],
      wordCountThreshold: 0.7,
      segmentWordCountThreshold: 0.6,
      maxRetries: 2,
    },
    execution: {
      toolAllowlist: ["write", "read", "edit", "exec", "process", "test"],
      timeoutMs: 120_000,
      allowParallel: true,
      maxConcurrency: 3,
    },
    outputContractTemplate: {},
  },
  // 研究报告模板
  {
    id: "research_report",
    taskType: "research",
    name: "研究/分析报告",
    matchPatterns: [/研究|分析|调研|报告|综述/],
    decomposition: {
      strategy: "by_phase",
      sequential: true, // 收集→分析→撰写
      requiresBlueprint: true,
      blueprintStrategy: "single_pass",
    },
    naming: {
      fileNameTemplate: "{projectName}_研究报告.md",
      mergedFileNameTemplate: "{projectName}_完整报告.md",
    },
    validation: {
      strategies: ["file_output", "completeness", "structured_output"],
      wordCountThreshold: 0.5,
      segmentWordCountThreshold: 0.4,
      maxRetries: 2,
    },
    execution: {
      toolAllowlist: ["write", "read", "edit", "exec", "process", "web", "fetch"],
      timeoutMs: 180_000,
      allowParallel: false,
      maxConcurrency: 1,
    },
    outputContractTemplate: {},
  },
  // 大文本分析模板 (Map-Reduce)
  {
    id: "large_text_analysis",
    taskType: "analysis",
    name: "大文本分析（角色卡/风格学习/摘要）",
    matchPatterns: [/分析.*文件|学习.*风格|提取.*角色|生成.*角色卡/],
    decomposition: {
      strategy: "map_reduce",
      sequential: false,
      requiresBlueprint: false,
      blueprintStrategy: "none",
    },
    naming: {
      fileNameTemplate: "chunk_{NNN}_analysis.md",
      mergedFileNameTemplate: "{projectName}_分析结果.md",
    },
    validation: {
      strategies: ["file_output", "completeness"],
      wordCountThreshold: 0.4,
      segmentWordCountThreshold: 0.3,
      maxRetries: 2,
    },
    execution: {
      toolAllowlist: ["write", "read", "edit", "exec", "process"],
      timeoutMs: 120_000,
      allowParallel: true,
      maxConcurrency: 2,
    },
    outputContractTemplate: {},
  },
];

/**
 * 模板选择器
 *
 * 根据任务 prompt + taskType 自动选择最佳模板。
 * 无匹配时返回 null（走现有流程）。
 */
export function selectTemplate(
  prompt: string,
  taskType: TaskType,
): TaskTemplate | null;

/**
 * 从模板生成 OutputContract
 *
 * 将模板的命名规则 + 子任务信息 → 具体的 OutputContract。
 */
export function generateOutputContract(
  template: TaskTemplate,
  context: {
    projectName: string;
    chapterNumber?: number;
    segmentIndex?: number;
    continuationPart?: number;
  },
): OutputContract;
```

### 4.3 集成点

| 现有代码 | 改造 |
|---------|------|
| `orchestrator.decomposeSubTask()` | 先选模板 → 有模板时用模板定义的分解策略 |
| `orchestrator.decomposeWritingTaskIntoSegments()` | 从模板获取 naming/validation 参数 |
| `orchestrator.decomposeFailedTask()` | 从模板获取 continuationFileNameTemplate |
| `enqueue-task-tool.ts` | 模板的 execution 参数传入 FollowupRun |
| `followup-runner.ts` | 工具白名单从模板获取 |

### 4.4 迁移策略

- 模板系统是**增量式**的——无匹配模板时 100% 走现有流程
- 先用写作模板验证，再逐步添加其他类型
- 用户可通过 `~/.clawdbot/task-templates/` 自定义模板（远期）

---

## 五、P2: 执行策略路由器 (Strategy Router)

### 5.1 问题诊断

当前所有任务走同一条执行路径：`followup-runner → LLM → 质检`。但有些任务**根本不需要 LLM**：

| 任务类型 | 当前做法 | 理想做法 |
|---------|---------|---------|
| 合并文件 | LLM 读+拼接 | 系统直接 fs 操作 |
| 发送文件 | LLM 调用 send 工具 | 系统直接调用 channel API |
| 简单文件复制 | LLM 调用 exec | 系统直接 fs.copyFile |
| 数据格式转换 | LLM + write | 系统直接 JSON/CSV 转换 |

**types.ts 已有 `preferredStrategy` 字段但从未被使用**——这是天然的集成点。

### 5.2 设计方案

```typescript
// 新文件: src/agents/intelligent-task-decomposition/strategy-router.ts

/**
 * 执行策略
 */
export type ExecutionStrategy =
  | "llm"           // 标准 LLM 执行（当前默认）
  | "system_merge"  // 系统直接合并文件（不走 LLM）
  | "system_deliver" // 系统直接发送/交付（不走 LLM）
  | "system_copy"   // 系统直接文件操作
  | "llm_light"     // 轻量 LLM（低 timeout、简化 prompt）
  | "llm_heavy";    // 重量 LLM（高 timeout、完整上下文）

/**
 * 策略路由器
 *
 * 在子任务执行前（followup-runner 入口处）决定执行策略。
 * 非 "llm" 策略直接在系统层完成，不调用 runEmbeddedPiAgent。
 */
export class StrategyRouter {
  /**
   * 为子任务选择执行策略
   *
   * 决策依据：
   * 1. TaskTemplate.execution（如果有模板）
   * 2. SubTask.preferredStrategy（如果已填入）
   * 3. SubTask.taskType + prompt 分析
   */
  static route(subTask: SubTask, template?: TaskTemplate): ExecutionStrategy;

  /**
   * 执行非 LLM 策略
   *
   * @returns 执行结果（output text + produced files）
   */
  static executeSystemStrategy(
    strategy: ExecutionStrategy,
    subTask: SubTask,
    context: {
      workspaceDir: string;
      taskTree: TaskTree;
    },
  ): Promise<{ output: string; producedFilePaths: string[] }>;
}
```

### 5.3 集成点

`followup-runner.ts` 执行子任务前：
```typescript
const strategy = StrategyRouter.route(subTask, template);
if (strategy !== "llm" && strategy !== "llm_light" && strategy !== "llm_heavy") {
  // 系统直接执行，不走 LLM
  const result = await StrategyRouter.executeSystemStrategy(strategy, subTask, { workspaceDir, taskTree });
  // 更新子任务状态 → postProcess → 轮次检查
  return;
}
// 走现有 LLM 路径
```

---

## 六、P3: 跨任务经验池 (Experience Pool)

### 6.1 问题诊断

当前 `failureHistory` 只在当前任务树内生效。上一轮学到的教训不会传递：
- "这个 provider 对中文续写容易输出英文文件名"
- "分段数 5 段对 3000 字章节太多，3 段更合适"
- "429 限流时并行度需要降到 1"

### 6.2 设计方案

```typescript
// 新文件: src/agents/intelligent-task-decomposition/experience-pool.ts

/**
 * 经验记录
 */
export interface ExperienceRecord {
  /** 唯一 ID */
  id: string;
  /** 任务类型 */
  taskType: TaskType;
  /** 经验类型 */
  category: "naming" | "decomposition" | "execution" | "quality" | "provider" | "merge";
  /** 模式描述（机器可读） */
  pattern: string;
  /** 教训描述（人可读，也可注入 prompt） */
  lesson: string;
  /** 建议的改进措施 */
  suggestion: string;
  /** 出现频率（同类问题出现次数） */
  frequency: number;
  /** 置信度 (0-100) */
  confidence: number;
  /** 首次记录时间 */
  firstSeen: number;
  /** 最近一次记录时间 */
  lastSeen: number;
  /** 关联的 provider/model */
  providerHint?: string;
}

/**
 * 经验池管理器
 *
 * 持久化目录: ~/.clawdbot/experience/
 * 文件: experience-pool.json (单文件，预计 <100KB)
 */
export class ExperiencePool {
  /**
   * 记录一条经验
   *
   * 如果已有同 pattern 的记录，frequency+1 并更新 lastSeen。
   */
  async record(experience: Omit<ExperienceRecord, "id" | "frequency" | "firstSeen" | "lastSeen">): Promise<void>;

  /**
   * 查询相关经验
   *
   * 按 taskType + category 过滤，按 confidence * frequency 排序。
   */
  async query(filters: {
    taskType?: TaskType;
    category?: string;
    provider?: string;
    minConfidence?: number;
  }): Promise<ExperienceRecord[]>;

  /**
   * 生成经验摘要（可注入到 decomposition prompt）
   *
   * 格式：
   * [历史经验提醒]
   * 1. 续写任务必须指定中文文件名（出现3次，置信度85%）
   * 2. 分段数建议不超过每章4段（出现2次，置信度70%）
   */
  async generateExperienceSummary(taskType: TaskType, maxTokens?: number): Promise<string>;
}
```

### 6.3 触发时机

| 时机 | 动作 |
|------|------|
| S2 文件名校验+自动重命名 | `record({ category: "naming", pattern: "wrong_filename_language", ... })` |
| 质检 restart | `record({ category: "quality", pattern: "word_count_insufficient", ... })` |
| 429 限流 | `record({ category: "provider", pattern: "rate_limit", providerHint: ... })` |
| 轮次完成时 | `record({ category: "execution", pattern: "optimal_segment_count", ... })` |
| decomposeSubTask 前 | `query + generateExperienceSummary → 注入 decomposition prompt` |

---

## 七、P4: 产出一致性检查器 (Output Coherence Checker)

### 7.1 问题诊断

当前质检只检查**单个子任务**的质量（字数、完成度、文件产出）。不检查**跨子任务**的一致性：
- 角色名是否统一（"苏晨" vs "苏辰"）
- 情节是否连贯（第3章结尾说"他离开了城市"，第4章开头说"他在城市中漫步"）
- 风格是否一致（第1章用"他"视角，第5章突然切换到"我"）

### 7.2 设计方案

```typescript
// 新文件: src/agents/intelligent-task-decomposition/coherence-checker.ts

/**
 * 一致性检查结果
 */
export interface CoherenceCheckResult {
  /** 总体一致性评分 (0-100) */
  score: number;
  /** 发现的不一致问题 */
  issues: CoherenceIssue[];
  /** 建议的修复动作 */
  suggestedActions: Array<{
    subTaskId: string;
    action: "adjust" | "rewrite";
    reason: string;
  }>;
}

export interface CoherenceIssue {
  type: "character_name" | "plot_continuity" | "style_drift" | "timeline" | "terminology";
  severity: "critical" | "warning" | "info";
  description: string;
  /** 涉及的子任务 ID */
  affectedSubTaskIds: string[];
}

/**
 * 一致性检查器
 *
 * 在 onRoundCompleted() 中运行，轮次完成后做一次全局一致性扫描。
 */
export class CoherenceChecker {
  /**
   * 运行一致性检查
   *
   * 实现：
   * 1. 收集所有子任务的 producedFilePaths
   * 2. 读取每个文件的首尾 500 字
   * 3. 构建检查 prompt（含 characterCards + 文件片段）
   * 4. 调用 LLM 检查一致性
   * 5. 返回结构化结果
   */
  async check(
    taskTree: TaskTree,
    roundId: string,
    llmCaller: LLMCaller,
  ): Promise<CoherenceCheckResult>;
}
```

### 7.3 集成点

`orchestrator.onRoundCompleted()` → `coherenceChecker.check()` → 结果写入交付报告。

**重要约束**：一致性检查是**报告性质**的，不会自动触发 adjust/restart。只在交付报告中标注问题，让用户决定是否要求修复。

---

## 八、P5: 轮次进度仪表盘 (Round Progress Dashboard)

### 8.1 设计方案

```typescript
// 新文件: src/agents/intelligent-task-decomposition/progress-dashboard.ts

export interface RoundProgress {
  roundId: string;
  goal: string;
  /** 总子任务数（含分段/续写） */
  totalTasks: number;
  /** 各状态计数 */
  statusCounts: Record<SubTaskStatus, number>;
  /** 预估完成百分比 (0-100) */
  progressPercent: number;
  /** 预估剩余时间 (ms，基于已完成任务的平均耗时) */
  estimatedRemainingMs: number;
  /** 当前正在执行的任务摘要 */
  activeTasks: Array<{ id: string; summary: string; elapsedMs: number }>;
  /** 失败的任务（高亮提示） */
  failedTasks: Array<{ id: string; summary: string; error: string; recoverable: boolean }>;
}

export class ProgressDashboard {
  /**
   * 计算轮次进度
   */
  static calculate(taskTree: TaskTree, roundId: string): RoundProgress;

  /**
   * 格式化为用户可读的进度消息
   *
   * 示例：
   * 📊 创作进度：4/6 章已完成 (67%)
   * ✅ 第1章(3012字) ✅ 第2章(2856字) ✅ 第3章(3201字) ✅ 第4章(2945字)
   * ⏳ 第5章 执行中 (已耗时 45s)
   * ⏸️ 第6章 等待中
   * 预估剩余: ~2 分钟
   */
  static formatProgressMessage(progress: RoundProgress): string;
}
```

### 8.2 集成点

1. **定期推送**：每个子任务完成后 → `formatProgressMessage()` → 发送到 channel
2. **renderTaskBoard 增强**：现有的 `renderTaskBoard()` 委托给 ProgressDashboard
3. **交付报告**：`delivery-reporter.ts` 引用 ProgressDashboard 格式化最终统计

---

## 九、实施顺序与依赖关系

```
P0 (ContextBudgetManager) ──────────────────────────┐
  │                                                  │
  ├── 独立模块，无外部依赖                              │
  ├── 集成到 followup-runner                          │
  └── 需要 FollowupRun 传递模型信息                     │
                                                     │
P1 (TaskTemplate) ───────────────────────────────────┤
  │                                                  │
  ├── 依赖 P0（模板定义 timeout/并发度）                  │
  ├── 集成到 orchestrator + enqueue-task-tool          │
  └── S1 OutputContract 自然升级                       │
                                                     │
P2 (StrategyRouter) ─────────────────────────────────┤
  │                                                  │
  ├── 依赖 P1（从模板获取策略偏好）                       │
  ├── 集成到 followup-runner 入口                      │
  └── 实现 system_merge / system_deliver               │
                                                     ├→ 核心管线完成
P3 (ExperiencePool) ─────────────────────────────────┤
  │                                                  │
  ├── 独立模块（持久化到 ~/.clawdbot/experience/）       │
  ├── 集成到 orchestrator 分解前 + 质检后                │
  └── 跨 session 持久化                               │
                                                     │
P4 (CoherenceChecker) ───────────────────────────────┤
  │                                                  │
  ├── 依赖 LLMCaller（system-llm-caller.ts）           │
  ├── 集成到 onRoundCompleted                          │
  └── 结果注入交付报告                                  │
                                                     │
P5 (ProgressDashboard) ──────────────────────────────┘
  │
  ├── 独立工具模块
  ├── 集成到子任务完成回调 + 交付报告
  └── 可选：推送到 channel
```

---

## 十、核心设计原则

1. **LLM 是执行者，不是架构师** — 系统控制结构（模板/命名/路径），LLM 只负责内容生产
2. **契约先行** — 每个任务在创建时就确定产出契约（OutputContract），执行后用契约校验
3. **失败是信号，不是终点** — 每次失败记录到经验池，下次同类任务自动规避
4. **预算感知** — 所有 prompt 构建都要感知 token 预算，而非无限堆叠上下文
5. **渐进式降级** — 最优策略失败时有明确的降级路径（LLM 质检 → 规则质检 → 默认通过）
6. **增量式改造** — 每个增强都是可选的、渐进的——无匹配模板时走现有流程、无经验时不注入

---

## 十一、推荐执行计划

| 阶段 | 内容 | 预估时间 |
|------|------|---------|
| Phase 1 | P0: ContextBudgetManager 独立模块 + 单元测试 | 半天 |
| Phase 2 | P0: 集成到 followup-runner + FollowupRun 模型信息传递 | 半天 |
| Phase 3 | P5: ProgressDashboard（最简单，先做用户可见的改善） | 半天 |
| Phase 4 | P1: TaskTemplate 数据模型 + 内置写作模板 | 1天 |
| Phase 5 | P1: 集成到 orchestrator 分解流程 | 1天 |
| Phase 6 | P2: StrategyRouter + system_merge 实现 | 1天 |
| Phase 7 | P3: ExperiencePool 持久化 + 触发点集成 | 1天 |
| Phase 8 | P4: CoherenceChecker + 交付报告集成 | 1天 |

**总计约 6-7 天**，建议每个 Phase 完成后做一次端到端验证（用《九天星辰录》创作任务）。
