# 智能任务分解系统 V2 — 顶层架构设计

> **状态**：设计评审中（待主人确认后分阶段实施）
> **日期**：2026-02-09
> **作者**：安娜（基于 6 轮 BUG 修复的根因回溯）

---

## 一、现状诊断：为什么打补丁越补越脆弱

### 1.1 六个 BUG 的共同根因

| BUG | 表面症状 | **根因模式** |
|-----|---------|-------------|
| BUG1: 上下文污染 | 旧任务历史误导新任务 LLM | 上下文管理是后补的，不是核心管道 |
| BUG2: 失败树复活 | failed→active 状态被新子任务重置 | 状态机隐式散落，无集中守卫 |
| BUG3: overthrow 不停止 | 级联失败逻辑缺失 | 队列(drain)和任务树(orchestrator)各管各的 |
| BUG4: 集成点缺失 | pruning 未插入正确位置 | 管道各阶段无统一编排协议 |
| BUG5: 质量评审误判 | 用旧根任务对比新轮次子任务 | **没有"轮次"这个一等公民概念** |
| BUG6: 子任务套娃 | 叶子任务调用 enqueue_task 再分解 | 权限模型靠布尔标记拼凑，无角色语义 |

### 1.2 抽象缺陷总结

当前系统的根本问题**不是缺少功能，而是缺少正确的抽象**：

```
❌ 当前：TaskTree 是一个"超级大杂烩"
     ┌─ rootTask（过期的全局描述）
     ├─ subTasks[]（扁平数组 + 树嵌套混用）
     ├─ status（全局状态 vs 轮次状态 混淆）
     ├─ rootTaskId（散落在 SubTask 字段上的轮次标记）
     └─ 布尔标记海洋（isQueueTask, isRootTask, isNewRootTask, isRoundCompleted...）

✅ 应该：分层抽象，每层职责清晰
     TaskTree → 拥有多个 Round
     Round → 拥有自己的根描述、状态机、子任务
     SubTask → 知道自己属于哪个 Round、执行上下文是什么
     ExecutionContext → 决定权限（可分解/仅执行/系统自动）
```

---

## 二、V2 架构设计

### 2.1 核心抽象：四层模型

```
┌────────────────────────────────────────────┐
│                 TaskTree                    │  会话级容器
│  id, sessionId, createdAt                  │  一个 session 一棵树
├────────────────────────────────────────────┤
│  Round[]                                   │  ← 新增一等公民
│  ┌──────────────────────────────────────┐  │
│  │  Round                               │  │  用户级任务批次
│  │  id, goal, status(FSM), createdAt    │  │
│  │  ┌────────────────────────────────┐  │  │
│  │  │  SubTask[]                     │  │  │  执行单元
│  │  │  id, prompt, summary, status   │  │  │
│  │  │  roundId, parentId, depth      │  │  │
│  │  │  executionRole                 │  │  │  ← 新增
│  │  └────────────────────────────────┘  │  │
│  └──────────────────────────────────────┘  │
├────────────────────────────────────────────┤
│  ExecutionContext                           │  ← 新增
│  role: user | root | sub | system          │
│  permissions: canDecompose, canEnqueue...   │
└────────────────────────────────────────────┘
```

### 2.2 Round：任务轮次（核心新增概念）

```typescript
/** 任务轮次 — 用户一次请求产生的所有子任务的容器 */
interface Round {
  /** 轮次 ID（替代散落在 SubTask 上的 rootTaskId） */
  id: string;

  /** 轮次目标（用户实际要做的事，质量评审用这个对比） */
  goal: string;

  /** 轮次状态（有限状态机，见 2.3 节） */
  status: RoundStatus;

  /** 该轮次的所有子任务 ID */
  subTaskIds: string[];

  /** 创建时间 */
  createdAt: number;

  /** 完成时间 */
  completedAt?: number;

  /** 是否有任务被 overthrow（级联守卫用） */
  hasOverthrow: boolean;

  /** 该轮次的质量评审摘要 */
  qualityReview?: RoundQualityReview;
}

type RoundStatus =
  | "active"      // 有 pending/active 子任务
  | "completed"   // 所有子任务 completed
  | "failed"      // 有子任务 failed 或被 overthrow
  | "cancelled";  // 用户主动取消
```

**Round 解决了什么？**

| 之前的问题 | Round 如何解决 |
|-----------|--------------|
| `taskTree.rootTask` 过期 → 质量评审误判 | 每个 Round 有自己的 `goal`，评审用 `round.goal` |
| `rootTaskId` 散落在 SubTask 上 | Round 是一等公民，SubTask 通过 `roundId` 关联 |
| drain 级联逻辑用布尔标记拼凑 | 检查 `round.hasOverthrow` 即可决定是否级联 |
| 多轮累积导致 tree.status 混乱 | `taskTree.status` 由所有 `round.status` 聚合计算 |

### 2.3 状态机（FSM）：显式转换 + 守卫

```
Round FSM:
  ┌─────────┐   addSubTask   ┌────────┐
  │ (start) │ ──────────────→│ active │
  └─────────┘                └───┬────┘
                                 │
                    ┌────────────┼────────────┐
                    │ allDone    │ overthrow   │ cancel
                    ▼            ▼             ▼
              ┌───────────┐ ┌────────┐ ┌───────────┐
              │ completed │ │ failed │ │ cancelled │
              └───────────┘ └────────┘ └───────────┘

SubTask FSM:
  pending → active → completed
                  ↘ failed
                  ↘ skipped (级联丢弃)

守卫规则（集中定义，不再散落各文件）：
  - Round.active → Round.failed：
      当任一 SubTask overthrow → round.hasOverthrow=true
      级联：同 Round 所有 pending SubTask → skipped
  - Round.active → Round.completed：
      当且仅当所有 SubTask 为 completed/skipped 且 hasOverthrow=false
  - TaskTree.status = aggregate(rounds.map(r => r.status))
```

### 2.4 执行上下文（ExecutionContext）：替代布尔标记海洋

```typescript
/** 执行上下文 — 决定当前 agent 调用的权限边界 */
interface ExecutionContext {
  /** 执行角色 */
  role: ExecutionRole;

  /** 所属轮次 ID */
  roundId: string;

  /** 当前任务深度 */
  depth: number;

  /** 权限集（由 role 推导，不可手动覆盖） */
  permissions: ExecutionPermissions;
}

type ExecutionRole =
  | "user"    // 用户直接发消息 → 完整权限
  | "root"    // 根任务（用户消息触发的第一层 LLM 调用）→ 可分解
  | "leaf"    // 叶子子任务（队列执行的具体工作）→ 仅执行，禁止 enqueue
  | "system"; // 系统自动分解（shouldAutoDecompose）→ 受控分解

/** 权限矩阵（设计时确定，运行时只读） */
const PERMISSION_MATRIX: Record<ExecutionRole, ExecutionPermissions> = {
  user:   { canEnqueue: true,  canDecompose: true,  canCreateNewRound: true  },
  root:   { canEnqueue: true,  canDecompose: true,  canCreateNewRound: false },
  leaf:   { canEnqueue: false, canDecompose: false, canCreateNewRound: false },
  system: { canEnqueue: true,  canDecompose: true,  canCreateNewRound: false },
};
```

**ExecutionContext 解决了什么？**

| 之前的问题 | ExecutionContext 如何解决 |
|-----------|------------------------|
| `isQueueTask && !isRootTask && depth < 3` 让叶子节点 enqueue | `role=leaf` → `canEnqueue=false`，一行代码 |
| 套娃分解（叶子任务创建更多子任务） | `leaf` 角色完全禁止 enqueue，递归分解只走 `system` 角色 |
| 布尔标记组合爆炸（5 个布尔 = 32 种组合） | 4 个角色 = 4 种明确行为，无歧义 |

### 2.5 上下文管道（Context Pipeline）：从"后补"到"内建"

```
当前（散装拼凑）：
  sanitizeSessionHistory → pruneIrrelevantContext → validateTurns → limitHistory
  （每步独立，不知道 Round 是什么，靠正则/启发式猜任务边界）

V2（Round 感知的管道）：
  ┌─ Stage 1: loadSessionHistory
  │    从 session 文件加载原始消息
  │
  ├─ Stage 2: identifyRounds（Round 元数据驱动，不再猜）
  │    直接从 TaskTree.rounds[] 读取轮次边界
  │    每条消息按时间戳归属到具体 Round
  │
  ├─ Stage 3: compressOldRounds
  │    非当前 Round 的消息 → 压缩为 1-2 行摘要
  │    摘要内容 = round.goal + 统计信息（来自 Round 元数据）
  │
  ├─ Stage 4: injectTaskContext
  │    注入当前 Round 的兄弟任务输出（sibling context）
  │    注入当前 SubTask 的父任务上下文
  │
  └─ Stage 5: tokenBudget
       按 model 的 context window 做最终截断
       保证：当前 Round 完整 > 注入上下文 > 历史摘要
```

**核心改进**：Stage 2 不再用正则/启发式猜任务边界。Round 是显式数据结构，边界已知。

---

## 三、任务生命周期钩子：替代"散装逻辑"

当前系统的最大维护痛点：子任务的创建、执行、完成、失败逻辑散落在 4+ 个文件中：
- `enqueue-task-tool.ts`（创建）
- `followup-runner.ts`（执行 + 完成 + 失败 + 轮次完成 + 合并文件 + 发送报告）
- `drain.ts`（队列守卫 + 级联丢弃）
- `orchestrator.ts`（质量评审 + 状态更新 + 文件管理）

V2 用生命周期钩子将逻辑集中到 Orchestrator：

```typescript
class Orchestrator {
  // ── 创建阶段 ──
  onTaskCreating(round: Round, task: SubTask, ctx: ExecutionContext): CreateDecision {
    // 1. 权限检查：ctx.permissions.canEnqueue?
    // 2. 深度检查：task.depth < maxDepth?
    // 3. Round 状态检查：round.hasOverthrow → 拒绝
    // 4. 返回 allow / deny（附原因）
  }

  onTaskCreated(round: Round, task: SubTask): void {
    // 1. 更新 Round.subTaskIds
    // 2. 更新 Round.status FSM
    // 3. 持久化
  }

  // ── 执行阶段 ──
  onTaskStarting(round: Round, task: SubTask): ExecutionContext {
    // 1. 确定 ExecutionRole
    // 2. 构建 ExecutionContext
    // 3. 启动文件追踪
    // 返回 ctx（传给 followup-runner）
  }

  // ── 完成阶段 ──
  onTaskCompleted(round: Round, task: SubTask): PostProcessDecision {
    // 1. 质量评审（用 round.goal 而非 taskTree.rootTask）
    // 2. 文件产出验证
    // 3. 更新 Round FSM
    // 4. 如果 Round 完成 → 合并输出 + 发送报告
    // 返回 continue / restart / overthrow
  }

  // ── 失败阶段 ──
  onTaskFailed(round: Round, task: SubTask, error: Error): FailureDecision {
    // 1. 判断是否可重试
    // 2. 级联检查：round.hasOverthrow → 级联 skip 所有 pending
    // 3. 更新 Round FSM
    // 返回 retry / cascade-fail / stop
  }

  // ── 轮次完成 ──
  onRoundCompleted(round: Round): void {
    // 1. 合并子任务输出
    // 2. 生成交付报告
    // 3. 归档到 memory
    // 4. 重算 TaskTree.status
  }
}
```

**钩子模式的好处**：
- `followup-runner.ts` 瘦身为"纯执行器"（调用 agent、收集 payload），不再包含业务逻辑
- `drain.ts` 瘦身为"纯队列调度器"（取任务、调 runner），守卫逻辑移到 `onTaskCreating` 和 `onTaskStarting`
- 所有**决策逻辑**集中在 Orchestrator，便于测试和调试

---

## 四、迁移策略：渐进式重构（不破坏现有功能）

### Phase 0：类型基础（1-2 小时）
- 在 `types.ts` 中新增 `Round`、`ExecutionContext`、`ExecutionRole` 类型
- `TaskTree` 新增 `rounds?: Round[]` 字段（向后兼容，可选）
- 不改动任何逻辑

### Phase 1：Round 一等公民化（2-3 小时）
- `enqueue-task-tool.ts`：创建子任务时自动创建/关联 Round
  - `isNewRootTask=true` → 创建新 Round
  - `isNewRootTask=false` → 复用当前 Round
- `orchestrator.ts`：新增 Round CRUD 方法
- `quality-reviewer.ts`：评审时使用 `round.goal` 替代 `taskTree.rootTask`
- **向后兼容**：如果 `rounds` 为空，回退到现有 `rootTaskId` 逻辑

### Phase 2：ExecutionContext 替代布尔标记（1-2 小时）
- 新增 `execution-context.ts`：定义角色推导逻辑
- `enqueue-task-tool.ts`：`canEnqueue` 改为 `ctx.permissions.canEnqueue`
- `followup-runner.ts`：创建 `ExecutionContext` 传给工具上下文
- **向后兼容**：保留旧字段（`isQueueTask` 等）但标记 deprecated

### Phase 3：上下文管道 Round 感知（1-2 小时）
- `context-pruning.ts`：`detectTaskSegments` 优先从 `TaskTree.rounds[]` 读取边界
- 无 Round 数据时回退到现有启发式规则
- 删除冗余的正则匹配逻辑

### Phase 4：生命周期钩子（2-3 小时）
- Orchestrator 新增钩子方法
- `followup-runner.ts` 逐步将业务逻辑替换为钩子调用
- `drain.ts` 将守卫逻辑替换为 `onTaskCreating` / `onTaskStarting` 调用
- 这一步改动最大，但前三步已经把数据层铺好，这步只是"搬逻辑"

### Phase 5：清理（0.5-1 小时）
- 删除 `SubTask.rootTaskId`（被 `Round.id` 替代）
- 删除 `FollowupRun` 上的 `isQueueTask/isRootTask/isNewRootTask/taskDepth`（被 `ExecutionContext` 替代）
- 清理 `drain.ts` 中残留的 ad-hoc 守卫

---

## 五、效果预测

### 5.1 BUG 免疫性

| BUG 类型 | V1（当前） | V2（Round + Context + Hooks） |
|---------|----------|-------------------------------|
| 上下文污染 | 启发式猜边界，易漏 | Round 边界已知，精确裁剪 |
| 状态混乱 | 散装 if-else，条件组合爆炸 | FSM + 集中守卫，状态转换可审计 |
| 质量误判 | 用全局 rootTask 对比 | 用 round.goal 对比，永远正确 |
| 套娃分解 | 布尔标记拼凑权限 | ExecutionRole 一步到位 |
| 级联失败 | drain 和 orchestrator 各做各的 | onTaskFailed 钩子统一处理 |
| 新 BUG | 容易引入（改一处漏三处） | 逻辑集中在钩子，影响面可控 |

### 5.2 可扩展性

Round + ExecutionContext 架构天然支持未来需求：

- **并行执行**：同一 Round 内无依赖的子任务自动并行（当前已支持，V2 更清晰）
- **跨 Round 依赖**：Round B 依赖 Round A 的输出（当前不支持）
- **任务类型泛化**：不同类型任务（写作/编程/分析）使用不同的质量评审策略
- **优先级调度**：Round 级别的优先级，紧急任务插队
- **用户干预**：用户取消/暂停某个 Round，不影响其他 Round

### 5.3 代码量预估

| 组件 | 当前行数 | V2 预计行数 | 变化 |
|------|---------|-----------|-----|
| types.ts | ~670 | ~750 | +80（Round + ExecutionContext 类型） |
| orchestrator.ts | ~2000 | ~1800 | -200（钩子替代散装逻辑） |
| followup-runner.ts | ~700 | ~400 | -300（业务逻辑移到钩子） |
| drain.ts | ~310 | ~200 | -110（守卫逻辑移到钩子） |
| enqueue-task-tool.ts | ~415 | ~300 | -115（权限检查简化） |
| context-pruning.ts | ~560 | ~400 | -160（Round 感知，删除猜测逻辑） |
| execution-context.ts | 0 | ~80 | 新增 |
| **总计** | ~4655 | ~3930 | **-725（净减 15%）** |

---

## 六、关键设计决策记录

### Q1：为什么不用独立的 Round 存储文件？
**答**：Round 内嵌在 TaskTree JSON 中。独立文件增加 I/O 和一致性风险，且 Round 数量有限（通常 < 10/session），内嵌开销可忽略。

### Q2：为什么 ExecutionRole 只有 4 种而不是更细？
**答**：4 种角色覆盖了所有已知场景。更细的粒度（如区分"写作子任务"和"编程子任务"）应该用任务类型标签而非角色，避免角色爆炸。

### Q3：为什么保留 shouldAutoDecompose 而不是全交给 LLM？
**答**：LLM 的分解决策不可控（BUG6 的教训）。系统用规则判断是否需要分解，LLM 只负责"怎么分解"，不负责"是否分解"。这是**决策权回收**的核心原则。

### Q4：Phase 顺序能否调整？
**答**：Phase 0-1 必须先做（类型基础）。Phase 2-4 可以并行或调序，但建议按编号来，每步都可独立验证。

---

## 七、附录：当前系统文件地图

```
src/agents/intelligent-task-decomposition/
  ├── types.ts                  # 核心类型（TaskTree, SubTask, ...）
  ├── orchestrator.ts           # 协调器（~2000行，过重）
  ├── task-tree-manager.ts      # 持久化（CRUD + checkpoint）
  ├── quality-reviewer.ts       # 质量评审（LLM 驱动）
  ├── task-adjuster.ts          # 任务调整（apply changes）
  ├── llm-task-decomposer.ts    # LLM 分解器
  ├── complexity-scorer.ts      # 复杂度评分
  ├── file-manager.ts           # 文件管理
  ├── file-tracker.ts           # 文件追踪
  ├── delivery-reporter.ts      # 交付报告
  ├── system-llm-caller.ts      # 系统 LLM 调用
  ├── task-intent-classifier.ts # 意图分类
  └── ...

src/agents/tools/
  └── enqueue-task-tool.ts      # enqueue_task 工具（权限 + 入队）

src/auto-reply/reply/
  ├── followup-runner.ts        # 子任务执行器（过重，~700行）
  └── queue/
      ├── drain.ts              # 队列调度（守卫逻辑过多）
      └── types.ts              # FollowupRun（布尔标记海洋）

src/agents/pi-embedded-runner/
  └── context-pruning.ts        # 上下文剪枝（启发式）
```

---

## 八、运行时日志根因分析：V2 尚未覆盖的深层问题

> 以下分析基于 2026-02-09 实际运行日志（九天星辰录 · 交付篇任务）

### 8.1 日志事件链还原

```
seq=1  payload=69KB   LLM调用exec列出文件           → ok (toolUse)
seq=2  payload=70KB   LLM读取大纲+第1-4章           → ok (toolUse)
seq=3  payload=87KB   LLM读取第5-9章                → ok (toolUse)
seq=4  payload=105KB  LLM试图读取第10-14章           → ❌ stopReason="stop"
       输出 = "[Historical context: a different model called tool 'read'...]"
       LLM 把 tool call 幻觉为纯文本，不再发起真实调用

→ 任务被标记 completed（output=810字幻觉文本）
→ 质量评审正确识别问题，触发 restart
→ restart 后同样的上下文膨胀必然再次失败 → 死循环
```

### 8.2 七个深层问题（V2 原设计未覆盖）

| # | 问题 | 根因 | V2 原设计状态 |
|---|------|------|-------------|
| P7 | **LLM 上下文窗口耗尽** | 单次执行读取 15 章内容，payload 从 69KB→105KB，超出有效推理窗口 | ❌ 未涉及 |
| P8 | **合并任务不应由 LLM 执行** | 系统已有 `producedFilePaths` + `mergeTaskOutputs()`，但仍创建 LLM 子任务做手动合并 | ❌ 未涉及 |
| P9 | **无重启预算/熔断器** | restart 后同样失败，无限循环 | ❌ 未涉及 |
| P10 | **输出完整性前置验证缺失** | LLM 输出 810 字幻觉文本就被标记 completed | ❌ 未涉及 |
| P11 | **无上下文预算预检** | 不知道任务是否能在 context window 内完成 | ❌ 未涉及 |
| P12 | **任务类型无感知** | 写作/合并/分析走同一执行管道 | 部分提及（Q2） |
| P13 | **缺少执行策略抽象** | 所有任务 = runEmbeddedPiAgent()，无分流 | ❌ 未涉及 |

---

## 九、执行策略层（ExecutionStrategy）— 解决 P7/P8/P12/P13

### 9.1 核心洞察

当前系统的根本盲区：**所有子任务都走同一条执行路径** — `runEmbeddedPiAgent()`。
但不同类型的任务有完全不同的执行需求：

```
写作任务（写第 3 章）    → LLM 创作，输出到文件           → 标准路径 ✅
合并任务（整合全书）     → 系统级文件拼接 + 轻量 LLM 校对  → 不应走 LLM 全量读取
分析任务（逻辑一致性）   → 需要读多文件但不生成大量内容    → 需要分片读取策略
发送任务（send_file）    → 纯系统操作，不需要 LLM          → 不应占用 LLM 调用
```

### 9.2 策略接口设计

```typescript
/**
 * 执行策略 — 根据任务类型选择不同的执行路径
 * 
 * 关键原则：LLM 只做 LLM 擅长的事（创作/推理），
 *           系统操作（文件合并/发送）由系统直接完成。
 */
interface ExecutionStrategy {
  /** 策略名称（用于日志/调试） */
  name: string;

  /** 预检：评估此策略是否适用 + 资源预算是否足够 */
  preflight(task: SubTask, round: Round, ctx: ExecutionContext): PreflightResult;

  /** 执行 */
  execute(task: SubTask, round: Round, ctx: ExecutionContext): Promise<ExecutionResult>;
}

interface PreflightResult {
  /** 是否可执行 */
  feasible: boolean;
  /** 预估上下文消耗（tokens） */
  estimatedContextTokens: number;
  /** 可用上下文预算（tokens） */
  availableContextBudget: number;
  /** 不可执行时的原因 + 建议的替代策略 */
  fallbackStrategy?: string;
  reason?: string;
}

type ExecutionResult = {
  success: boolean;
  output: string;
  producedFiles: string[];
  tokensUsed: number;
  strategyUsed: string;
};
```

### 9.3 内建策略矩阵

```
┌──────────────────────────────────────────────────────────────┐
│              ExecutionStrategyRouter                          │
│  输入：SubTask + Round + ExecutionContext                     │
│  输出：选择最优策略                                           │
├──────────────────┬───────────────────────────────────────────┤
│ 策略             │ 适用场景                                   │
├──────────────────┼───────────────────────────────────────────┤
│ LLMCreation      │ 写作/编码/分析 — 标准 LLM 执行路径         │
│                  │ preflight: 估算 context 占用，预留输出空间  │
├──────────────────┼───────────────────────────────────────────┤
│ SystemMerge      │ 合并/整合任务 — 系统直接拼接文件            │
│                  │ 不调用 LLM 读取内容，直接用 fs 操作         │
│                  │ 可选：轻量 LLM 调用做目录/前言生成           │
├──────────────────┼───────────────────────────────────────────┤
│ SystemDelivery   │ 发送/交付任务 — 系统调用 send_file          │
│                  │ 零 LLM 调用，纯系统操作                    │
├──────────────────┼───────────────────────────────────────────┤
│ ChunkedAnalysis  │ 多文件分析 — 分片读取 + 流式汇总           │
│                  │ 每次只读 2-3 个文件，中间结果传递            │
│                  │ 防止上下文窗口耗尽                          │
├──────────────────┼───────────────────────────────────────────┤
│ CompositeStrategy│ 复合策略 — 串联多个子策略                   │
│                  │ 例：SystemMerge → 轻量LLM校对 → SystemDelivery│
└──────────────────┴───────────────────────────────────────────┘
```

### 9.4 策略路由器（StrategyRouter）

```typescript
class StrategyRouter {
  private strategies: ExecutionStrategy[] = [
    new SystemDeliveryStrategy(),   // 优先匹配：纯发送
    new SystemMergeStrategy(),      // 优先匹配：纯合并
    new ChunkedAnalysisStrategy(),  // 多文件分析
    new LLMCreationStrategy(),      // 兜底：标准 LLM
  ];

  /**
   * 为任务选择最优执行策略
   * 
   * 核心逻辑：
   * 1. 任务意图分类（从 prompt/summary/metadata 推断）
   * 2. 按优先级遍历策略，执行 preflight
   * 3. 选择第一个 feasible 的策略
   * 4. 全部不可行 → 任务分裂（拆成更小的子任务）
   */
  async selectStrategy(
    task: SubTask,
    round: Round,
    ctx: ExecutionContext,
  ): Promise<{ strategy: ExecutionStrategy; preflight: PreflightResult }> {

    // 1. 意图分类（复用已有的 task-intent-classifier.ts）
    const intent = classifyTaskIntent(task.prompt, task.summary);

    // 2. 按意图筛选候选策略
    const candidates = this.strategies.filter(s =>
      this.isStrategyApplicable(s, intent)
    );

    // 3. 执行 preflight，选择第一个可行策略
    for (const strategy of candidates) {
      const result = strategy.preflight(task, round, ctx);
      if (result.feasible) {
        console.log(
          `[StrategyRouter] ✅ ${task.id} → ${strategy.name} ` +
          `(est=${result.estimatedContextTokens}, budget=${result.availableContextBudget})`
        );
        return { strategy, preflight: result };
      }
      console.log(
        `[StrategyRouter] ⏭️ ${strategy.name} 不可行: ${result.reason}`
      );
    }

    // 4. 全部不可行 → 返回 LLMCreation + 标记需要拆分
    return {
      strategy: new LLMCreationStrategy(),
      preflight: {
        feasible: false,
        estimatedContextTokens: 0,
        availableContextBudget: 0,
        reason: "所有策略 preflight 失败，建议拆分任务",
        fallbackStrategy: "task_split",
      },
    };
  }
}
```

### 9.5 SystemMergeStrategy 详解（解决 P8：交付篇问题）

```typescript
/**
 * 系统合并策略 — 不依赖 LLM 读取文件内容
 * 
 * 适用：合并/整合/汇总类任务
 * 核心优势：零上下文消耗（文件操作全在系统侧）
 */
class SystemMergeStrategy implements ExecutionStrategy {
  name = "SystemMerge";

  preflight(task: SubTask, round: Round): PreflightResult {
    // 检查 round 中是否有已完成的子任务及其文件产出
    const completedTasks = round.subTaskIds
      .map(id => findSubTask(id))
      .filter(t => t?.status === "completed" && t.metadata?.producedFilePaths?.length);

    return {
      feasible: completedTasks.length > 0,
      estimatedContextTokens: 0,  // 零 LLM 上下文消耗！
      availableContextBudget: Infinity,
      reason: completedTasks.length === 0
        ? "无已完成子任务的文件产出"
        : undefined,
    };
  }

  async execute(task: SubTask, round: Round): Promise<ExecutionResult> {
    // 1. 收集所有已完成子任务的文件路径（按创建顺序排列）
    const filePaths = this.collectOrderedFilePaths(round);

    // 2. 系统级文件拼接（fs.readFile + concat，不走 LLM）
    const merged = await this.mergeFiles(filePaths);

    // 3. 可选：轻量 LLM 调用生成目录/前言（< 2000 tokens）
    const frontMatter = await this.generateFrontMatter(task, round, merged.stats);

    // 4. 写入最终文件
    const outputPath = await this.writeOutput(frontMatter + merged.content);

    // 5. 发送到用户频道
    await this.sendToChannel(outputPath, task);

    return {
      success: true,
      output: `合并完成：${filePaths.length} 个文件 → ${outputPath}`,
      producedFiles: [outputPath],
      tokensUsed: frontMatter ? 2000 : 0,
      strategyUsed: this.name,
    };
  }
}
```

**交付篇问题的彻底解决**：

```
❌ 当前（V1）：
  LLM 子任务 → exec列出文件 → read 15个章节 → 上下文爆炸 → 幻觉 → 失败

✅ V2 + Strategy：
  StrategyRouter 识别"合并/整合" → SystemMergeStrategy
  → 系统直接从 producedFilePaths 读取文件
  → fs 拼接（零 LLM 上下文消耗）
  → 轻量 LLM 生成目录/前言（< 2000 tokens）
  → send_file 发送
  → 完成（总 LLM 消耗 < 3000 tokens，而非 30000+）
```

---

## 十、熔断器与重启预算（CircuitBreaker）— 解决 P9

### 10.1 问题复现

```
交付篇执行 → 上下文爆炸 → 输出幻觉 → 质量评审 restart
→ 交付篇再次执行 → 同样的上下文爆炸 → 同样的幻觉 → 又 restart
→ ∞ 死循环（当前代码没有任何上限）
```

当前 `SubTask.retryCount` 只在 `catch` 分支递增（LLM 抛异常时），
但质量评审 restart 走的是 `postProcessSubTaskCompletion()` → `status="pending"` → 重入队，
**retryCount 虽然 +1，但没有上限检查**。

### 10.2 三级熔断设计

```typescript
/**
 * 熔断器 — 防止无效重试耗尽资源
 * 
 * 三级递进：
 * Level 1: 单任务重启预算（最多 N 次）
 * Level 2: 轮次级熔断（同 Round 连续失败超限）
 * Level 3: 全局 token 预算（防止 LLM 成本失控）
 */
interface CircuitBreakerConfig {
  /** L1: 单个子任务最大重启次数（含 restart + retry） */
  maxTaskRestarts: number;       // 默认 2

  /** L2: 同一 Round 内累计失败任务数上限 */
  maxRoundFailures: number;      // 默认 3

  /** L3: 单轮次 LLM token 消耗上限 */
  maxRoundTokenBudget: number;   // 默认 500_000

  /** 熔断后的降级策略 */
  fallbackAction: "skip" | "system_merge" | "notify_user";
}

/** Round 扩展 — 新增熔断状态 */
interface Round {
  // ...原有字段...

  /** 熔断器状态 */
  circuitBreaker: {
    /** 累计失败次数 */
    totalFailures: number;
    /** 累计 token 消耗 */
    totalTokensUsed: number;
    /** 是否已熔断 */
    tripped: boolean;
    /** 熔断原因 */
    tripReason?: string;
  };
}
```

### 10.3 熔断触发点（集成到生命周期钩子）

```typescript
class Orchestrator {
  onTaskCompleted(round: Round, task: SubTask): PostProcessDecision {
    // ...质量评审...

    if (decision === "restart") {
      // ── L1: 单任务重启预算 ──
      if (task.retryCount >= config.maxTaskRestarts) {
        console.warn(
          `[CircuitBreaker] L1: 任务 ${task.id} 已重启 ${task.retryCount} 次，` +
          `超过上限 ${config.maxTaskRestarts}，触发降级`
        );
        return this.applyFallback(round, task, "L1_max_restarts");
      }

      // ── L2: 轮次级熔断 ──
      round.circuitBreaker.totalFailures++;
      if (round.circuitBreaker.totalFailures >= config.maxRoundFailures) {
        console.warn(
          `[CircuitBreaker] L2: Round ${round.id} 累计失败 ${round.circuitBreaker.totalFailures} 次，熔断`
        );
        round.circuitBreaker.tripped = true;
        round.circuitBreaker.tripReason = "L2_round_failures";
        return this.cascadeSkipRemaining(round, "轮次熔断：连续失败过多");
      }
    }

    // ── L3: Token 预算检查（每次 LLM 调用后更新） ──
    round.circuitBreaker.totalTokensUsed += task.metadata?.tokensUsed ?? 0;
    if (round.circuitBreaker.totalTokensUsed >= config.maxRoundTokenBudget) {
      console.warn(
        `[CircuitBreaker] L3: Round ${round.id} token 消耗 ${round.circuitBreaker.totalTokensUsed} ` +
        `超过预算 ${config.maxRoundTokenBudget}，熔断`
      );
      round.circuitBreaker.tripped = true;
      return this.cascadeSkipRemaining(round, "Token 预算耗尽");
    }

    return decision;
  }

  /** 降级处理：尝试用系统策略补救，否则通知用户 */
  private applyFallback(
    round: Round, task: SubTask, reason: string
  ): PostProcessDecision {
    // 尝试 SystemMerge 策略（如果任务是合并类型）
    const intent = classifyTaskIntent(task.prompt, task.summary);
    if (intent.type === "merge" || intent.type === "delivery") {
      return { decision: "system_fallback", strategy: "SystemMerge" };
    }

    // 无法降级 → 标记 skip + 通知用户
    task.status = "failed";
    task.error = `熔断降级 (${reason})：任务已重试 ${task.retryCount} 次仍失败`;
    return { decision: "skip", notifyUser: true };
  }
}
```

### 10.4 用户通知（熔断后不静默丢弃）

```
当熔断触发时，系统发送消息到用户频道：

⚠️ 任务执行遇到瓶颈

📋 轮次目标：创作长篇玄幻小说《九天星辰录》
🔥 熔断原因：任务"全书整合与发送"已重试 2 次仍失败（LLM 上下文窗口不足）
📊 当前进度：14/15 个子任务已完成

🛠️ 系统已自动降级处理：
  → 使用 SystemMerge 策略直接合并 14 个章节文件
  → 合并文件已保存到：九天星辰录_完整版.txt

如需人工干预，请回复 "继续" 或 "取消"。
```

---

## 十一、输出完整性验证门（OutputValidator）— 解决 P10

### 11.1 问题：幻觉文本被当作合法输出

当前流程：LLM 返回 → 提取 payloads 文本 → `subTask.status = "completed"` → 质量评审。

问题在于：**先标记 completed，再做质量评审**。LLM 输出 810 字幻觉文本
（`[Historical context: a different model called tool "read"...]`）也会被标记 completed。
虽然质量评审能事后纠正，但增加了一轮无意义的 LLM 调用（评审本身也消耗 token）。

### 11.2 前置验证门设计

```typescript
/**
 * 输出验证门 — 在标记 completed 之前拦截明显无效输出
 * 
 * 位置：followup-runner 中，LLM 返回之后、标记 completed 之前
 * 原则：快速、规则驱动、零 LLM 调用
 */
interface OutputValidator {
  validate(task: SubTask, output: string, toolMetas: ToolMeta[]): ValidationResult;
}

interface ValidationResult {
  /** 是否通过 */
  valid: boolean;
  /** 失败原因（机器可读） */
  failureCode?: OutputFailureCode;
  /** 人类可读的失败描述 */
  failureReason?: string;
  /** 建议的补救动作 */
  suggestedAction?: "retry" | "strategy_switch" | "skip";
}

type OutputFailureCode =
  | "hallucinated_tool_calls"   // LLM 把 tool call 幻觉为文本
  | "output_too_short"          // 输出远短于预期
  | "no_file_produced"          // 写作任务未产生文件
  | "empty_output"              // 空输出
  | "context_overflow_signal";  // 检测到上下文溢出特征
```

### 11.3 内建验证规则

```typescript
const BUILTIN_VALIDATORS: OutputValidationRule[] = [
  {
    name: "hallucination_detector",
    check: (output) => {
      // 检测 LLM 把 tool call 幻觉为文本的特征模式
      const patterns = [
        /\[Historical context:.*called tool/i,
        /Do not mimic this format/i,
        /use proper function calling/i,
      ];
      const isHallucinated = patterns.some(p => p.test(output));
      return isHallucinated
        ? { valid: false, failureCode: "hallucinated_tool_calls",
            suggestedAction: "strategy_switch" }
        : { valid: true };
    },
  },
  {
    name: "output_length_check",
    check: (output, task) => {
      // 写作任务：输出应 ≥ 预期长度的 30%
      const isWritingTask = task.metadata?.taskType === "writing";
      const expectedMinChars = isWritingTask ? 1000 : 200;
      return output.length < expectedMinChars
        ? { valid: false, failureCode: "output_too_short",
            suggestedAction: "retry" }
        : { valid: true };
    },
  },
  {
    name: "file_production_check",
    check: (_output, task, toolMetas) => {
      // 需要文件输出的任务：必须调用过 write/send_file
      if (!task.metadata?.requiresFileOutput) return { valid: true };
      const FILE_TOOLS = new Set(["write", "send_file"]);
      const produced = toolMetas.some(m => FILE_TOOLS.has(m.toolName));
      return produced
        ? { valid: true }
        : { valid: false, failureCode: "no_file_produced",
            suggestedAction: "retry" };
    },
  },
  {
    name: "context_overflow_detector",
    check: (_output, _task, _toolMetas, llmResponse) => {
      // 检测上下文溢出信号：
      // 1. stopReason="stop" 但任务未完成（预期 toolUse）
      // 2. usage.input 接近 model 的 context limit
      // 3. 输出 tokens 异常低（< 50）
      const overflow =
        llmResponse.stopReason === "stop" &&
        llmResponse.usage.output < 50 &&
        llmResponse.usage.input > 20000;
      return overflow
        ? { valid: false, failureCode: "context_overflow_signal",
            suggestedAction: "strategy_switch" }
        : { valid: true };
    },
  },
];
```

### 11.4 验证门在管道中的位置

```
followup-runner 执行流程（V2）：

  LLM 执行完成
       ↓
  ┌─────────────────────────────┐
  │ OutputValidator.validate()  │  ← 新增：前置验证门
  │  规则驱动，零 LLM 调用       │
  └─────────┬───────────────────┘
            │
     ┌──────┴──────┐
     │ valid=true  │ valid=false
     ↓             ↓
  标记 completed   根据 suggestedAction:
       ↓           - retry → 直接重试（不经质量评审）
  质量评审          - strategy_switch → 切换执行策略
       ↓           - skip → 标记 failed + 通知用户
  postProcess
```

**关键区别**：验证门是**规则驱动**的（正则匹配 + 数值检查），不消耗 LLM token。
质量评审是**LLM 驱动**的（语义理解），消耗 token 但判断更精确。
两者互补：验证门拦截明显垃圾，质量评审评估内容质量。

---

## 十二、上下文预算预检（ContextBudget）— 解决 P7/P11

### 12.1 问题：任务盲目执行，不知道 context window 够不够

交付篇任务要求 LLM 读取 15 个章节文件。系统完全不知道这会消耗多少 context，
直到 payload 膨胀到 105KB、LLM 开始幻觉时才"发现"问题。

### 12.2 预算模型

```typescript
/**
 * 上下文预算计算器
 * 
 * 在任务执行前估算资源需求，决定是否可行
 */
class ContextBudgetCalculator {
  /**
   * 估算任务执行所需的 context tokens
   */
  estimate(task: SubTask, round: Round, model: string): BudgetEstimate {
    const modelLimit = getModelContextLimit(model);  // 例: 128K for gemini-flash

    // 1. 固定开销：system prompt + 历史消息 + 工具定义
    const fixedOverhead = this.estimateFixedOverhead(round);

    // 2. 任务特定开销（基于意图分类）
    const intent = classifyTaskIntent(task.prompt, task.summary);
    const taskOverhead = this.estimateTaskOverhead(intent, round);

    // 3. 预留输出空间（至少 model limit 的 20%）
    const outputReserve = Math.max(modelLimit * 0.2, 4096);

    // 4. 可用预算
    const available = modelLimit - fixedOverhead - outputReserve;

    return {
      modelLimit,
      fixedOverhead,
      taskOverhead,
      outputReserve,
      available,
      feasible: taskOverhead <= available,
      utilizationRatio: taskOverhead / available,
    };
  }

  /**
   * 估算任务特定开销
   * 
   * 关键洞察：对于"读取 N 个文件并汇总"类型的任务，
   * 每个文件的 token 开销 ≈ 文件字符数 / 3（中文约 1.5 char/token）
   */
  private estimateTaskOverhead(
    intent: TaskIntentResult, round: Round
  ): number {
    switch (intent.type) {
      case "merge":
      case "review": {
        // 需要读取的文件总大小
        const totalFileSize = round.subTaskIds
          .map(id => this.getTaskFileSize(id))
          .reduce((a, b) => a + b, 0);
        // 中文 ≈ 1.5 char/token，英文 ≈ 4 char/token
        return Math.ceil(totalFileSize / 1.5);
      }
      case "writing":
        // 写作任务：prompt + 少量上下文
        return Math.ceil(task.prompt.length / 1.5) + 2000;
      default:
        return 8000; // 保守估计
    }
  }
}

interface BudgetEstimate {
  modelLimit: number;
  fixedOverhead: number;
  taskOverhead: number;
  outputReserve: number;
  available: number;
  feasible: boolean;
  /** 任务需求占可用预算的比例（> 1.0 = 超预算） */
  utilizationRatio: number;
}
```

### 12.3 预算预检集成到 StrategyRouter

```typescript
class StrategyRouter {
  async selectStrategy(task, round, ctx) {
    // ...意图分类...

    for (const strategy of candidates) {
      const preflight = strategy.preflight(task, round, ctx);

      // ★ 对 LLM 策略额外做上下文预算检查
      if (strategy.name === "LLMCreation" && preflight.feasible) {
        const budget = this.budgetCalculator.estimate(task, round, ctx.model);
        if (!budget.feasible) {
          console.warn(
            `[StrategyRouter] ⚠️ LLMCreation 上下文预算不足: ` +
            `需要 ${budget.taskOverhead} tokens, 可用 ${budget.available} tokens ` +
            `(利用率 ${(budget.utilizationRatio * 100).toFixed(0)}%)`
          );
          // 降级到 ChunkedAnalysis 或 SystemMerge
          continue;
        }
      }

      if (preflight.feasible) return { strategy, preflight };
    }
    // ...兜底逻辑...
  }
}
```

### 12.4 预算超限时的自动降级路径

```
任务："整合全书 15 章并发送"
预算估算：15 章 × 2000 字/章 × 1.5 token/字 ≈ 45000 tokens
模型可用：128K - 20K(固定) - 25K(输出预留) ≈ 83K tokens
判定：feasible=true, 但 utilizationRatio=0.54（较高）

→ 如果只是合并：选 SystemMerge（零 LLM 消耗）
→ 如果需要分析：选 ChunkedAnalysis（分片处理）
→ 如果真的需要全量 LLM：选 LLMCreation 但加 warn

实际交付篇场景：
  文件总大小 ≈ 30000 字 × 15 章 = 450000 字
  预算估算 ≈ 300000 tokens → 远超 128K
  → 自动降级到 SystemMerge
  → 问题彻底解决
```

---

## 十三、任务类型感知与智能分解（TaskTypeAwareness）— 解决 P12

### 13.1 当前分解的盲区

当前 LLM 分解任务时，系统对分解出的子任务没有类型标记。
例如"写一部 15 章的小说"被分解为：

```
子任务 1: 创作大纲         ← 写作类
子任务 2: 写第 1 章         ← 写作类
...
子任务 15: 写第 14 章       ← 写作类
子任务 16: 全书整合与发送    ← ★ 这是合并+发送类，不是写作类！
```

**子任务 16 被当作普通写作任务执行**，导致 LLM 试图"手写"合并逻辑（读 15 个文件再拼接），
而不是让系统直接合并。

### 13.2 任务类型枚举

```typescript
/**
 * 任务类型 — 决定执行策略和质量评审标准
 * 
 * 设计原则：按"执行方式"分类，而非"内容领域"分类。
 * （"科幻小说"和"游记"都是 writing，执行方式相同）
 */
type TaskType =
  | "writing"      // 创作型：LLM 生成内容并写入文件
  | "coding"       // 编码型：LLM 编写/修改代码
  | "analysis"     // 分析型：LLM 阅读内容并产出结论
  | "merge"        // 合并型：系统拼接多个文件（★ 不应走 LLM）
  | "delivery"     // 交付型：系统发送文件到用户（★ 不应走 LLM）
  | "planning"     // 规划型：LLM 产出大纲/计划
  | "review"       // 审校型：LLM 阅读并校对/修改
  | "generic";     // 通用型：无法分类，走标准 LLM

/** SubTask 扩展 */
interface SubTask {
  // ...原有字段...

  /** 任务类型（分解时由系统自动分类或 LLM 标注） */
  taskType?: TaskType;

  /** 执行策略偏好（由 StrategyRouter 在 preflight 阶段填入） */
  preferredStrategy?: string;
}
```

### 13.3 分解时自动注入类型标签

```typescript
/**
 * 在 LLM 分解 prompt 中要求标注任务类型
 * 
 * 关键改进：分解结果不再只有 prompt + summary，
 * 还包含 taskType，供 StrategyRouter 直接使用。
 */
const DECOMPOSITION_PROMPT_ADDITION = `
对于每个子任务，你必须标注 taskType，可选值：
- "writing"：需要 LLM 创作内容（写章节、写文章、写代码）
- "merge"：需要合并/整合多个已有文件（如"全书整合"）
- "delivery"：需要发送文件给用户（如"发送最终作品"）
- "analysis"：需要阅读多个文件并产出分析结论
- "review"：需要校对/审查已有内容
- "planning"：需要产出规划/大纲

⚠️ 重要："合并全书"、"整合章节"、"汇总输出"类任务必须标注为 "merge"，
而不是 "writing"。系统会使用不同的执行策略处理合并任务（不经过 LLM 全量读取）。
`;

/**
 * 如果 LLM 未标注 taskType，系统通过规则自动推断
 */
function inferTaskType(prompt: string, summary: string): TaskType {
  const text = (prompt + " " + summary).toLowerCase();

  // 合并/整合类关键词
  if (/整合|合并|汇总|拼接|全书|完整版/.test(text)) return "merge";

  // 发送/交付类关键词
  if (/发送|交付|send_file|传送/.test(text)) return "delivery";

  // 分析/审查类关键词
  if (/分析|检查|一致性|审校|校对|review/.test(text)) return "review";

  // 规划类关键词
  if (/大纲|规划|计划|outline|plan/.test(text)) return "planning";

  // 编码类关键词
  if (/代码|函数|模块|重构|bug|fix|implement/.test(text)) return "coding";

  // 默认：写作
  return "writing";
}
```

### 13.4 类型感知的质量评审策略

```typescript
/**
 * 不同任务类型使用不同的质量评审标准
 * 
 * 当前问题：所有任务用同一套评审 prompt，
 * 导致合并任务被问"创作质量如何"，写作任务被问"文件是否完整"
 */
const QUALITY_CRITERIA: Record<TaskType, string[]> = {
  writing: [
    "内容是否达到预期字数",
    "是否与前文衔接连贯",
    "是否使用 write 工具写入文件",
  ],
  merge: [
    "是否包含所有源文件",
    "文件顺序是否正确",
    "合并后文件是否可读",
    // ★ 不评审"创作质量"，因为合并不涉及创作
  ],
  delivery: [
    "文件是否成功发送",
    "发送的文件是否正确",
    // ★ 最简评审，因为发送是确定性操作
  ],
  analysis: [
    "分析是否覆盖所有输入文件",
    "结论是否有依据",
  ],
  // ...其他类型...
};
```

### 13.5 类型感知 + 策略选择的完整联动

```
分解阶段：
  LLM 分解 → 每个子任务附带 taskType
  系统补全 → inferTaskType() 兜底

执行阶段：
  StrategyRouter.selectStrategy()
    → 读取 task.taskType
    → 按类型优先匹配策略：
        merge → SystemMergeStrategy
        delivery → SystemDeliveryStrategy
        writing → LLMCreationStrategy
        analysis → ChunkedAnalysisStrategy（如超预算）
                   LLMCreationStrategy（如预算内）
    → preflight 验证
    → 执行

评审阶段：
  QualityReviewer
    → 读取 task.taskType
    → 使用对应的 QUALITY_CRITERIA
    → 生成类型适配的评审 prompt

完整链条：taskType 贯穿分解→执行→评审三个阶段
```

---

## 十四、全景架构图：V2 增强版组件交互

### 14.1 核心数据流

```
用户消息
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ enqueue-task-tool                                        │
│  1. ExecutionContext 权限检查（替代布尔标记）              │
│  2. Round 创建/关联                                      │
│  3. taskType 推断                                        │
│  4. 构建 FollowupRun → 入队                              │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ drain.ts（瘦身后）                                        │
│  纯队列调度 + 并行分组                                    │
│  守卫逻辑已移到 Orchestrator.onTaskStarting()            │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Orchestrator.onTaskStarting()                            │
│  1. Round 状态检查（熔断器检查）                          │
│  2. ★ StrategyRouter.selectStrategy()                    │
│     ├─ 意图分类 + taskType 读取                          │
│     ├─ ContextBudget 预算预检                            │
│     └─ 选择最优策略                                      │
│  3. 返回 ExecutionContext + 选定策略                      │
└──────────────────────┬───────────────────────────────────┘
                       │
          ┌────────────┼────────────────┐
          │            │                │
          ▼            ▼                ▼
    ┌──────────┐ ┌──────────┐    ┌──────────┐
    │LLMCreation│ │SystemMerge│    │SystemDlvr│
    │ 标准 LLM  │ │ fs 合并   │    │ send_file│
    │ 执行路径  │ │ +轻量LLM │    │ 零 LLM   │
    └────┬─────┘ └────┬─────┘    └────┬─────┘
         │            │               │
         └────────────┼───────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────┐
│ OutputValidator（前置验证门）                              │
│  规则驱动，零 LLM 调用                                    │
│  拦截：幻觉输出 / 空输出 / 上下文溢出信号                 │
│  ├─ valid=true  → 继续                                   │
│  └─ valid=false → retry / strategy_switch / skip         │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│ Orchestrator.onTaskCompleted()                           │
│  1. 类型适配的质量评审（QUALITY_CRITERIA[taskType]）      │
│  2. 熔断器更新（L1/L2/L3）                               │
│  3. 文件产出验证                                         │
│  4. Round FSM 状态推进                                   │
│  5. 如 Round 完成 → onRoundCompleted()                   │
│     → 合并输出 + 交付报告 + 内存归档                     │
└──────────────────────────────────────────────────────────┘
```

### 14.2 新增文件清单

```
src/agents/intelligent-task-decomposition/
  ├── strategy/                        # ★ 新增目录
  │   ├── strategy-router.ts           # 策略路由器
  │   ├── execution-strategy.ts        # 策略接口定义
  │   ├── llm-creation-strategy.ts     # 标准 LLM 执行策略
  │   ├── system-merge-strategy.ts     # 系统合并策略
  │   ├── system-delivery-strategy.ts  # 系统发送策略
  │   └── chunked-analysis-strategy.ts # 分片分析策略
  │
  ├── validation/                      # ★ 新增目录
  │   ├── output-validator.ts          # 输出验证门
  │   └── context-budget.ts            # 上下文预算计算器
  │
  ├── circuit-breaker.ts               # ★ 新增：熔断器
  ├── round.ts                         # ★ 新增：Round 一等公民
  ├── execution-context.ts             # ★ 新增：执行上下文
  │
  ├── types.ts                         # 扩展：+Round +TaskType +CircuitBreaker
  ├── orchestrator.ts                  # 重构：生命周期钩子 + 策略集成
  ├── quality-reviewer.ts              # 扩展：类型适配的评审策略
  └── llm-task-decomposer.ts           # 扩展：分解结果含 taskType
```

---

## 十五、修订后的迁移策略（8 Phase）

> 原 Phase 0-5（第四章）保持不变，新增 Phase 6-7 覆盖增强能力。
> 每个 Phase 可独立验证、独立回滚。

### Phase 0-5（保持不变）

- **Phase 0**：类型基础（Round, ExecutionContext, TaskType 类型定义）
- **Phase 1**：Round 一等公民化
- **Phase 2**：ExecutionContext 替代布尔标记
- **Phase 3**：上下文管道 Round 感知
- **Phase 4**：生命周期钩子
- **Phase 5**：清理旧抽象

### Phase 6：执行策略层 + 输出验证门（3-4 小时）

**前置依赖**：Phase 1（Round）+ Phase 2（ExecutionContext）

1. 新增 `strategy/` 目录 + 策略接口
2. 实现 `SystemMergeStrategy`（最高优先级 — 直接解决交付篇问题）
3. 实现 `SystemDeliveryStrategy`（纯系统操作）
4. 实现 `LLMCreationStrategy`（封装现有 `runEmbeddedPiAgent` 路径）
5. 实现 `StrategyRouter`（意图分类 + preflight + 路由）
6. 新增 `validation/output-validator.ts`（幻觉检测 + 溢出检测）
7. 在 `followup-runner.ts` 中集成：
   - 执行前：`StrategyRouter.selectStrategy()`
   - 执行后、标记 completed 前：`OutputValidator.validate()`
8. `ChunkedAnalysisStrategy` 暂不实现（标记 TODO），优先保证合并+发送路径

**验证标准**：
- 合并类任务不再触发 LLM 全量读取
- 幻觉文本被验证门拦截（不进入质量评审）
- 标准 LLM 任务不受影响

### Phase 7：熔断器 + 上下文预算（2-3 小时）

**前置依赖**：Phase 1（Round）+ Phase 6（Strategy）

1. 新增 `circuit-breaker.ts`（CircuitBreakerConfig + 状态管理）
2. 新增 `validation/context-budget.ts`（ContextBudgetCalculator）
3. Round 数据结构扩展 `circuitBreaker` 字段
4. 集成到 `Orchestrator.onTaskCompleted()`（L1/L2 检查）
5. 集成到 `StrategyRouter`（L3 + 预算预检）
6. 实现熔断后的用户通知（发送消息到频道）

**验证标准**：
- restart 超过 2 次自动熔断降级
- 合并类任务超预算时自动降级到 SystemMerge
- 熔断后用户收到清晰的通知消息

### Phase 8：任务类型感知（1-2 小时）

**前置依赖**：Phase 6（Strategy）

1. SubTask 扩展 `taskType` 字段
2. `llm-task-decomposer.ts` 分解 prompt 增加 taskType 要求
3. 实现 `inferTaskType()` 规则兜底
4. `quality-reviewer.ts` 使用 `QUALITY_CRITERIA[taskType]`
5. 端到端验证：分解 → 标注类型 → 策略选择 → 类型适配评审

### 迁移优先级总览

```
紧急度    Phase    解决的问题                           工时
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 P0    Phase 6   交付篇死循环 / 幻觉输出              3-4h
🔴 P0    Phase 7   restart 无限循环 / 成本失控           2-3h
🟡 P1    Phase 0-2 类型基础 / Round / ExecutionContext   3-5h
🟡 P1    Phase 4   生命周期钩子（集中化逻辑）           2-3h
🟢 P2    Phase 3   上下文管道 Round 感知                1-2h
🟢 P2    Phase 8   任务类型感知（锦上添花）             1-2h
🟢 P3    Phase 5   清理旧抽象                           0.5-1h
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                                              总计: ~15-20h
```

**建议执行顺序**：Phase 0 → Phase 1 → Phase 2 → Phase 6 → Phase 7 → Phase 4 → Phase 8 → Phase 3 → Phase 5

理由：Phase 6/7 解决的是**用户正在面对的实际问题**（交付篇死循环），
应在架构重构（Phase 0-2）完成后立即实施，而非等所有 Phase 做完。

---

## 十六、P1-P13 问题全量对照表

| 问题 | 描述 | 解决方案 | 所属 Phase | 新增组件 |
|------|------|---------|-----------|---------|
| P1 | 上下文污染 | Round 感知的上下文管道 | Phase 3 | context-pruning 重构 |
| P2 | 失败树复活 | Round FSM + 集中守卫 | Phase 1+4 | round.ts |
| P3 | overthrow 不停止 | Round.hasOverthrow + 级联 | Phase 1+4 | round.ts |
| P4 | 集成点缺失 | 生命周期钩子统一编排 | Phase 4 | orchestrator 重构 |
| P5 | 质量评审误判 | round.goal 替代 rootTask | Phase 1 | round.ts |
| P6 | 子任务套娃 | ExecutionContext 权限矩阵 | Phase 2 | execution-context.ts |
| **P7** | **LLM 上下文爆炸** | **ContextBudget 预算预检** | **Phase 7** | **context-budget.ts** |
| **P8** | **合并任务走 LLM** | **SystemMergeStrategy** | **Phase 6** | **system-merge-strategy.ts** |
| **P9** | **restart 死循环** | **三级熔断器** | **Phase 7** | **circuit-breaker.ts** |
| **P10** | **幻觉输出通过** | **OutputValidator 前置验证门** | **Phase 6** | **output-validator.ts** |
| **P11** | **无预算预检** | **ContextBudgetCalculator** | **Phase 7** | **context-budget.ts** |
| **P12** | **任务类型无感知** | **TaskType + 分类型评审** | **Phase 8** | **types.ts 扩展** |
| **P13** | **无执行策略** | **StrategyRouter + 4 策略** | **Phase 6** | **strategy/ 目录** |

---

## 十七、设计审核清单（供主人确认）

### 必须确认的设计决策

1. **ExecutionStrategy 是否需要插件化？**
   当前设计是内建 4 种策略。如果未来需要用户自定义策略（如 "用特定 API 执行"），
   需要暴露 strategy 注册接口。**建议**：V2 先内建，预留注册钩子。

2. **熔断后的默认行为？**
   当前设计：合并类任务降级到 SystemMerge，其他类型通知用户。
   **是否需要**：自动尝试切换到更大 context 的模型？（如 gemini-flash → gemini-pro）

3. **SystemMerge 是否需要 LLM 校对？**
   当前设计：可选的轻量 LLM 调用生成目录/前言。
   **是否需要**：在合并后做一次 LLM 一致性检查？（会增加 token 消耗但提高质量）

4. **Phase 6/7 是否可以先于 Phase 0-2 实施？**
   从架构纯度看应先做类型基础；从用户痛点看应先解决交付篇问题。
   **建议**：Phase 6/7 可以用现有数据结构先做一个"最小可用版"，
   等 Phase 0-2 完成后再迁移到 Round/ExecutionContext 上。

### 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Strategy 抽象过度 | 中 | 增加代码复杂度 | 先实现 2 个策略（LLM + SystemMerge），验证有效后再加 |
| inferTaskType 误分类 | 中 | 合并任务仍走 LLM | 关键词列表可迭代扩展 + LLM 标注双保险 |
| 熔断阈值不准 | 低 | 过早熔断或过晚熔断 | 阈值可配置，运行时观察调整 |
| 旧任务树兼容性 | 低 | 旧 JSON 无 Round 字段 | Phase 1 已设计向后兼容（rounds 可选） |
