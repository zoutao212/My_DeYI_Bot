# Phase 0：基础设施层 — 类型定义（Round / FSM / ExecutionContext / TaskType）

> **预估工时**：1-2 小时
> **前置依赖**：无
> **风险等级**：🟢 低（纯类型新增，零逻辑改动，不影响现有运行）
> **回滚策略**：删除新增类型，恢复 `types.ts` 备份

---

## 目标

在 `types.ts` 中新增 V2 核心类型定义，为后续 Phase 铺设类型基础。
**不改动任何运行时逻辑**，仅新增类型和接口（`PERMISSION_MATRIX` 常量除外）。

---

## 当前代码现状分析（基于实际源码）

### types.ts（667 行）关键结构定位

| 接口/类型 | 行号 | 说明 |
|-----------|------|------|
| `TaskTree` | L12-67 | 会话级容器，末尾字段 `batches?: TaskBatch[]`（L66） |
| `SubTask` | L74-141 | 执行单元，末尾字段 `metadata?: SubTaskMetadata`（L140） |
| `SubTask.rootTaskId` | L131 | 现有轮次标记（V2 用 `roundId` 替代，过渡期共存） |
| `SubTask.status` | L85 | `"pending" \| "active" \| "completed" \| "failed" \| "interrupted"` **⚠️ 缺少 "skipped"** |
| `QualityStatus` | L208-213 | 已存在，Round 类型可直接引用 |
| `ReviewDecision` | L367-371 | 已存在（continue/adjust/restart/overthrow） |
| `PostProcessResult` | L613-626 | 已存在，Phase 3 会扩展 |
| `TaskBatch` 区块 | L511-601 | 批量执行类型（Phase 0 不动） |
| `DeliveryReport` | L637-666 | 交付报告类型（Phase 0 不动） |

### queue/types.ts（154 行）FollowupRun 关键字段

| 字段 | 行号 | V2 对应 |
|------|------|---------|
| `isQueueTask` | L84 | → `ExecutionContext.role !== "user"` |
| `isRootTask` | L96 | → `ExecutionContext.role === "root"` |
| `isNewRootTask` | L105 | → `ExecutionContext.permissions.canCreateNewRound` |
| `taskDepth` | L114 | → `ExecutionContext.depth` |
| `rootTaskId` | L144 | → `ExecutionContext.roundId` |

> **Phase 0 仅在 queue/types.ts 添加注释标记**，实际字段替换在 Phase 2 进行。

---

## 任务清单

### Task 0.1：备份 types.ts

```
操作：复制 types.ts → types.ts.bak_phase0
位置：src/agents/intelligent-task-decomposition/types.ts
验证：bak 文件存在且内容一致
```

### Task 0.2：新增 Round 接口（~50 行）

**文件**：`src/agents/intelligent-task-decomposition/types.ts`
**插入位置**：在 `TaskTree` 接口闭合大括号之后（**精确位置：第 67 行 `}` 之后，第 68 行空行之前**）

**锚点上下文**（插入点前后 3 行）：
```typescript
// L65:   /** 任务批次列表 */
// L66:   batches?: TaskBatch[];
// L67: }
// --- 👆 在此之后插入 👇 ---
// L68: (空行)
// L69: /**
// L70:  * 子任务
```

```typescript
// ========================================
// 🆕 V2: Round — 任务轮次（一等公民）
// ========================================

/**
 * 轮次状态
 *
 * active   → 有 pending/active 子任务
 * completed→ 所有子任务 completed（且无 overthrow）
 * failed   → 有子任务 failed 或被 overthrow
 * cancelled→ 用户主动取消
 */
export type RoundStatus = "active" | "completed" | "failed" | "cancelled";

/**
 * 轮次质量评审摘要
 */
export interface RoundQualityReview {
  /** 评审状态 */
  status: QualityStatus;
  /** 评审决策 */
  decision: ReviewDecision;
  /** 发现的问题 */
  findings: string[];
  /** 改进建议 */
  suggestions: string[];
  /** 评审时间 */
  reviewedAt: number;
}

/**
 * 任务轮次 — 用户一次请求产生的所有子任务的容器
 *
 * 替代散落在 SubTask 上的 rootTaskId 字段，
 * 让"轮次"成为显式数据结构而非隐式标记。
 */
export interface Round {
  /** 轮次 ID（替代散落在 SubTask 上的 rootTaskId） */
  id: string;

  /** 轮次目标（用户实际要做的事，质量评审用这个对比） */
  goal: string;

  /** 轮次状态（有限状态机） */
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

  /** 熔断器状态（Phase 7 扩展） */
  circuitBreaker?: {
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

**验证**：
- `tsc --noEmit` 无新增类型错误
- `Round` 类型可被其他文件 import

### Task 0.3：扩展 TaskTree 接口（~5 行）

**文件**：`src/agents/intelligent-task-decomposition/types.ts`
**修改位置**：`TaskTree` 接口内部，**精确位置：第 66 行 `batches?: TaskBatch[];` 之后，第 67 行 `}` 之前**

**锚点上下文**：
```typescript
// L64:   // 🆕 批量执行相关字段
// L65:   /** 任务批次列表 */
// L66:   batches?: TaskBatch[];
// --- 👆 在此之后插入 👇 ---
// L67: }
```

```typescript
  // 🆕 V2: Round 支持（向后兼容，可选字段）

  /** 轮次列表（V2 新增，按创建时间排序） */
  rounds?: Round[];
```

**向后兼容说明**：
- `rounds` 是**可选字段**（`?`），旧 JSON 无此字段时不会报错
- 所有读取 `rounds` 的代码必须做 nullish 检查
- Phase 1 中会添加"无 rounds 时回退到 rootTaskId 逻辑"的兼容层

**验证**：
- 旧的 `TASK_TREE.json` 文件仍能被 `JSON.parse` 后赋值给 `TaskTree` 类型
- `taskTree.rounds?.length` 语法合法

### Task 0.3b：扩展 SubTask.status — 新增 `"skipped"`

**文件**：`src/agents/intelligent-task-decomposition/types.ts`
**修改位置**：**精确位置：第 85 行**

**为什么必须在 Phase 0 做**：
Round FSM 的级联守卫需要“当 overthrow 时，同 Round 所有 pending 子任务 → skipped”。
如果不在 Phase 0 扩展 status 类型，Phase 1 的状态机代码将无法编译。

**当前代码**（L85）：
```typescript
  status: "pending" | "active" | "completed" | "failed" | "interrupted";
```

**修改为**：
```typescript
  status: "pending" | "active" | "completed" | "failed" | "interrupted" | "skipped";
```

**向后兼容说明**：
- 这是对现有类型的**扩展**（联合类型新增一个候选值）
- 现有代码不会用到 `"skipped"`，不影响运行时
- **风险点**：如果现有代码中有对 `SubTask.status` 做穷举检查（switch/exhaustive），可能报编译告警
- **排查方法**：全局搜索 `case "interrupted"` 确认是否有 exhaustive switch

**验证**：
```bash
# 搜索是否有 exhaustive switch
rg "case \"interrupted\"" src/agents/intelligent-task-decomposition/
# 类型检查
pnpm build
```

### Task 0.3c：新增 FSM 转换规则类型（~40 行）

**文件**：`src/agents/intelligent-task-decomposition/types.ts`
**插入位置**：在 Round 接口定义之后（紧接 Task 0.2 插入的内容）

**为什么在 Phase 0 定义**：
Phase 1 实现状态机守卫时需要这些类型，提前定义避免 Phase 1 再回头改 types.ts。

```typescript
// ========================================
// 🆕 V2: FSM 转换规则（Phase 1 状态机实现的类型基础）
// ========================================

/**
 * SubTask 状态类型别名（方便引用）
 */
export type SubTaskStatus = SubTask["status"];

/**
 * FSM 转换规则
 * 
 * from → to 的合法转换，附带可选的守卫函数。
 * Phase 1 实现时会用这个类型构建实际的转换表。
 */
export interface FSMTransitionRule<S extends string> {
  /** 起始状态 */
  from: S;
  /** 目标状态 */
  to: S;
  /** 守卫条件描述（人读） */
  guard?: string;
}

/**
 * Round FSM 合法转换列表（常量，设计时确定，运行时只读）
 * 
 * Phase 1 中会实现实际的 transition() 函数，这里只定义类型。
 */
export const ROUND_TRANSITIONS: ReadonlyArray<FSMTransitionRule<RoundStatus>> = [
  { from: "active",    to: "completed", guard: "allSubTasksDone && !hasOverthrow" },
  { from: "active",    to: "failed",    guard: "anySubTaskOverthrown" },
  { from: "active",    to: "cancelled", guard: "userCancelled" },
] as const;

/**
 * SubTask FSM 合法转换列表
 */
export const SUBTASK_TRANSITIONS: ReadonlyArray<FSMTransitionRule<SubTaskStatus>> = [
  { from: "pending",  to: "active",    guard: "taskPickedUp" },
  { from: "active",   to: "completed", guard: "executionSuccess" },
  { from: "active",   to: "failed",    guard: "executionFailed" },
  { from: "pending",  to: "skipped",   guard: "roundOverthrown (cascade)" },
  { from: "active",   to: "skipped",   guard: "roundOverthrown (cascade)" },
] as const;
```

**验证**：
- `ROUND_TRANSITIONS` 和 `SUBTASK_TRANSITIONS` 可被 import
- 类型推导正确：`ROUND_TRANSITIONS[0].from` 类型为 `RoundStatus`

### Task 0.4：新增 ExecutionContext 与权限矩阵（~60 行）

**文件**：`src/agents/intelligent-task-decomposition/types.ts`
**插入位置**：在 Task 0.3c 的 FSM 转换规则之后（即 Round 相关类型区块末尾）

```typescript
// ========================================
// 🆕 V2: ExecutionContext — 执行上下文（替代布尔标记海洋）
// ========================================

/**
 * 执行角色
 *
 * user   → 用户直接发消息，完整权限
 * root   → 根任务（用户消息触发的第一层 LLM 调用），可分解
 * leaf   → 叶子子任务（队列执行的具体工作），仅执行，禁止 enqueue
 * system → 系统自动分解（shouldAutoDecompose），受控分解
 */
export type ExecutionRole = "user" | "root" | "leaf" | "system";

/**
 * 执行权限集
 */
export interface ExecutionPermissions {
  /** 是否允许调用 enqueue_task */
  canEnqueue: boolean;
  /** 是否允许触发分解 */
  canDecompose: boolean;
  /** 是否允许创建新 Round */
  canCreateNewRound: boolean;
}

/**
 * 权限矩阵（设计时确定，运行时只读）
 *
 * 替代 isQueueTask/isRootTask/isNewRootTask 布尔标记组合。
 * 4 个角色 = 4 种明确行为，无歧义。
 */
export const PERMISSION_MATRIX: Record<ExecutionRole, ExecutionPermissions> = {
  user:   { canEnqueue: true,  canDecompose: true,  canCreateNewRound: true  },
  root:   { canEnqueue: true,  canDecompose: true,  canCreateNewRound: false },
  leaf:   { canEnqueue: false, canDecompose: false, canCreateNewRound: false },
  system: { canEnqueue: true,  canDecompose: true,  canCreateNewRound: false },
};

/**
 * 执行上下文 — 决定当前 agent 调用的权限边界
 *
 * 由 Orchestrator.onTaskStarting() 在任务执行前构建。
 * 传递给 followup-runner，followup-runner 再传递给工具上下文。
 */
export interface ExecutionContext {
  /** 执行角色 */
  role: ExecutionRole;

  /** 所属轮次 ID */
  roundId: string;

  /** 当前任务深度 */
  depth: number;

  /** 权限集（由 role 推导，不可手动覆盖） */
  permissions: ExecutionPermissions;
}
```

**验证**：
- `PERMISSION_MATRIX["leaf"].canEnqueue === false`
- `ExecutionContext` 类型可被 import

### Task 0.5：新增 TaskType 枚举（~30 行）

**文件**：`src/agents/intelligent-task-decomposition/types.ts`
**插入位置**：在 ExecutionContext 定义之后

```typescript
// ========================================
// 🆕 V2: TaskType — 任务类型感知
// ========================================

/**
 * 任务类型 — 决定执行策略和质量评审标准
 *
 * 设计原则：按"执行方式"分类，而非"内容领域"分类。
 * （"科幻小说"和"游记"都是 writing，执行方式相同）
 */
export type TaskType =
  | "writing"      // 创作型：LLM 生成内容并写入文件
  | "coding"       // 编码型：LLM 编写/修改代码
  | "analysis"     // 分析型：LLM 阅读内容并产出结论
  | "merge"        // 合并型：系统拼接多个文件（不应走 LLM）
  | "delivery"     // 交付型：系统发送文件到用户（不应走 LLM）
  | "planning"     // 规划型：LLM 产出大纲/计划
  | "review"       // 审校型：LLM 阅读并校对/修改
  | "generic";     // 通用型：无法分类，走标准 LLM
```

### Task 0.6：扩展 SubTask 接口（~10 行）

**文件**：`src/agents/intelligent-task-decomposition/types.ts`
**修改位置**：`SubTask` 接口内部，**精确位置：第 139 行 `metadata?: SubTaskMetadata;` 之前，第 138 行 `fallbackReason?: string;`（属于 SubTaskMetadata 内部）之后**

> ❗ 注意：上面的行号是基于**原始文件**的，实际插入时因前面 Task 已新增 ~140 行，实际行号会偏移。
> 推荐用锚点定位：搜索 `metadata?: SubTaskMetadata;` 在 `SubTask` 接口内的位置。

**锚点上下文**（原始文件）：
```typescript
// L136:   /** 质量状态 */
// L137:   qualityStatus?: QualityStatus;
// L138:   (空行)
// --- 👆 在 L138 之后插入，L139 之前 👇 ---
// L139:   /** 元数据（复杂度、优先级、时长估算等） */
// L140:   metadata?: SubTaskMetadata;
// L141: }
```

```typescript
  // 🆕 V2: 新增字段（向后兼容，全部可选）

  /** 所属轮次 ID（V2 新增，与 Round.id 关联） */
  roundId?: string;

  /** 任务类型（分解时由系统自动分类或 LLM 标注） */
  taskType?: TaskType;

  /** 执行角色（由 ExecutionContext 在执行时填入） */
  executionRole?: ExecutionRole;

  /** 执行策略偏好（由 StrategyRouter 在 preflight 阶段填入） */
  preferredStrategy?: string;
```

**向后兼容说明**：
- 所有新增字段都是**可选的**（`?`），旧数据不受影响
- `roundId` 与现有 `rootTaskId` 共存，Phase 5 清理时再移除 `rootTaskId`
- `taskType` 在 Phase 8 实施任务类型感知时才会被实际填充

### Task 0.7：新增 FollowupRun 扩展字段类型提示（仅文档注释）

**文件**：`src/auto-reply/reply/queue/types.ts`
**插入位置**：**精确位置：第 144 行 `rootTaskId?: string;` 之后，第 145 行 `};` 之前**

**锚点上下文**：
```typescript
// L142:    * @since v2026.2.6 - 任务系统轮次隔离
// L143:    */
// L144:   rootTaskId?: string;
// --- 👆 在此之后插入 👇 ---
// L145: };
```

**插入内容**：
```typescript

  // 🆕 V2: 以下字段将在后续 Phase 中新增（当前仍使用旧布尔标记）
  // executionContext?: ExecutionContext;  // Phase 2 新增（替代 isQueueTask/isRootTask/isNewRootTask/taskDepth）
  // roundId?: string;                    // Phase 1 新增（替代 rootTaskId）
```

**说明**：这一步**只添加注释**，不添加实际字段。避免提前引入运行时变更。

### Task 0.8：导出验证

**操作**：确保所有新增类型和常量正确导出

**文件**：`src/agents/intelligent-task-decomposition/types.ts`

验证以下 import 语句在其他文件中可正常工作：
```typescript
// 类型导入
import type {
  Round,
  RoundStatus,
  RoundQualityReview,
  ExecutionContext,
  ExecutionRole,
  ExecutionPermissions,
  TaskType,
  SubTaskStatus,
  FSMTransitionRule,
} from "./types.js";

// 运行时常量导入
import {
  PERMISSION_MATRIX,
  ROUND_TRANSITIONS,
  SUBTASK_TRANSITIONS,
} from "./types.js";
```

**验证方法**：在任意同目录文件中添加上述 import，运行 `pnpm build` 确认无报错，然后删除测试 import。

### Task 0.9：编译与测试验证

```bash
# 1. 类型检查
pnpm build

# 2. 运行现有测试（确保零回归）
pnpm test

# 3. 验证旧 TASK_TREE.json 兼容性
# 手动检查：加载一个不含 rounds 字段的旧 JSON，确认无报错

# 4. 验证 SubTask.status 扩展无副作用
rg "case \"interrupted\"" src/agents/intelligent-task-decomposition/
```

**通过标准**：
- ✅ `pnpm build` 零错误
- ✅ `pnpm test` 所有测试通过
- ✅ 旧 `TASK_TREE.json` 可正常加载
- ✅ 新增类型和常量可被 import
- ✅ 无 exhaustive switch 编译告警

### Task 0.10：新增工厂函数类型签名（~30 行）

**文件**：`src/agents/intelligent-task-decomposition/types.ts`
**插入位置**：在 TaskType 定义之后（文件末尾方向，避免影响现有类型的行号）

**为什么在 Phase 0 定义**：
Phase 1/2 实现时需要这些工厂函数创建 Round 和 ExecutionContext。
提前定义接口签名，后续 Phase 只需实现即可。

```typescript
// ========================================
// 🆕 V2: 工厂函数类型签名（Phase 1/2 实现）
// ========================================

/**
 * 创建 Round 的参数
 */
export interface CreateRoundParams {
  /** 轮次目标（用户原始 prompt 或摘要） */
  goal: string;
  /** 会话 ID（用于生成唯一 Round ID） */
  sessionId: string;
}

/**
 * 创建 ExecutionContext 的参数
 */
export interface CreateExecutionContextParams {
  /** 执行角色 */
  role: ExecutionRole;
  /** 所属轮次 ID */
  roundId: string;
  /** 当前任务深度 */
  depth: number;
}
```

**验证**：`pnpm build` 无报错

---

## 施工顺序（依赖关系）

```
Task 0.1  备份
  │
  ├─→ Task 0.3b  SubTask.status += "skipped"（无依赖，最先执行）
  │
  ├─→ Task 0.2   Round 接口（依赖 QualityStatus/ReviewDecision，已存在）
  │      │
  │      └─→ Task 0.3c  FSM 转换规则（依赖 RoundStatus + SubTaskStatus）
  │
  ├─→ Task 0.3   TaskTree.rounds?（依赖 Round 类型）
  │
  ├─→ Task 0.4   ExecutionContext + PERMISSION_MATRIX（无依赖）
  │      │
  │      └─→ Task 0.5  TaskType（无依赖）
  │
  ├─→ Task 0.6   SubTask 扩展（依赖 Round + TaskType + ExecutionRole）
  │
  ├─→ Task 0.10  工厂函数类型（依赖 ExecutionRole）
  │
  ├─→ Task 0.7   FollowupRun 注释标记（无依赖，可并行）
  │
  └─→ Task 0.8 + 0.9  导出验证 + 编译测试（最后执行）
```

**推荐执行顺序**：
`0.1` → `0.3b` → `0.2` → `0.3` → `0.3c` → `0.4` → `0.5` → `0.6` → `0.10` → `0.7` → `0.8` → `0.9`

---

## Phase 0 产出物

| 文件 | 变更类型 | 新增行数 | 内容 |
|------|---------|--------|------|
| `types.ts` | 扩展 | ~200 行 | Round + FSM规则 + ExecutionContext + TaskType + 工厂类型 |
| `types.ts` | 修改 | 1 行 | SubTask.status += "skipped" |
| `types.ts` | 扩展 | ~15 行 | TaskTree.rounds? + SubTask V2 字段 |
| `queue/types.ts` | 注释 | 3 行 | FollowupRun V2 注释标记 |
| `types.ts.bak_phase0` | 新增 | - | 备份文件 |

---

## 风险与回滚

| 风险点 | 影响 | 应对措施 |
|--------|------|----------|
| `PERMISSION_MATRIX` / `ROUND_TRANSITIONS` / `SUBTASK_TRANSITIONS` 是运行时常量 | 如果 types.ts 被构建工具当作纯类型文件处理，可能被 tree-shake | 在 Phase 1 中拆分到 `constants.ts` |
| SubTask.status += "skipped" 可能触发 exhaustive switch 告警 | 编译时告警（不报错） | 搜索并补充 case "skipped" 分支 |
| 新增类型与现有类型同名冲突 | 编译报错 | 新增前先搜索同名类型 |

**回滚操作**：
```bash
# 一步回滚
cp src/agents/intelligent-task-decomposition/types.ts.bak_phase0 \
   src/agents/intelligent-task-decomposition/types.ts
# 手动删除 queue/types.ts 中的 V2 注释（3 行）
pnpm build && pnpm test
```

---

## 与后续 Phase 的衔接

| Phase 0 产出 | 消费方 | 如何使用 |
|------------|--------|----------|
| `Round` 接口 | Phase 1: RoundManager | 创建/查询/更新 Round 实例 |
| `RoundStatus` + `ROUND_TRANSITIONS` | Phase 1: FSM 守卫 | 状态转换验证（`transition(round, "completed")`） |
| `SubTaskStatus` + `SUBTASK_TRANSITIONS` | Phase 1: FSM 守卫 | SubTask 状态转换验证 |
| `ExecutionContext` + `PERMISSION_MATRIX` | Phase 2: enqueue-task-tool | 替代布尔标记海洋 |
| `TaskType` | Phase 5+: StrategyRouter | 任务类型感知执行策略 |
| `CreateRoundParams` / `CreateExecutionContextParams` | Phase 1/2: 工厂函数 | 统一创建入口 |
| `SubTask.roundId` / `SubTask.taskType` | Phase 1/5: 数据填充 | 分解时填充，执行时读取 |
| `SubTask.status: "skipped"` | Phase 1: 级联守卫 | overthrow 时级联丢弃 pending 子任务 |


====

hase 0 施工完成总结
变更文件
文件	变更类型	内容
@D:\Git_GitHub\clawdbot\src\agents\intelligent-task-decomposition\types.ts	扩展 ~230 行	Round + RoundStatus + RoundQualityReview + FSM转换规则 + ExecutionContext + PERMISSION_MATRIX + TaskType + 工厂类型签名
@D:\Git_GitHub\clawdbot\src\agents\intelligent-task-decomposition\types.ts	修改 1 行	SubTask.status += "skipped"
@D:\Git_GitHub\clawdbot\src\agents\intelligent-task-decomposition\types.ts	扩展 ~15 行	TaskTree.rounds? + SubTask V2 字段（roundId, taskType, executionRole, preferredStrategy）
@D:\Git_GitHub\clawdbot\src\auto-reply\reply\queue\types.ts	注释 3 行	FollowupRun V2 注释标记
types.ts.bak_phase0	新增	备份文件
验证结果
pnpm build ✅ 零错误通过
exhaustive switch ✅ 两处（task-tree-manager.ts:979、orchestrator.ts:1915）都有 default 分支，无编译告警
向后兼容 ✅ 所有新增字段均为可选（?），旧 JSON 数据无影响
新增可导出的类型/常量
类型：Round, RoundStatus, RoundQualityReview, SubTaskStatus, FSMTransitionRule, ExecutionRole, ExecutionPermissions, ExecutionContext, TaskType, CreateRoundParams, CreateExecutionContextParams

运行时常量：PERMISSION_MATRIX, ROUND_TRANSITIONS, SUBTASK_TRANSITIONS

Phase 0 类型基础层已就绪，可以继续推进 Phase 1（Round 一等公民化） 了。需要我继续吗？Phase 1 施工计划
核心思路：在 taskTree.rounds[] 中维护 Round 对象，与现有 rootTaskId 并行运行。向后兼容：无 rounds 时回退到旧逻辑。

Phase 0: 类型定义层 ✅

2
Phase 1.1: orchestrator 新增 Round CRUD + 更新 addSubTask/markRoundCompleted/initializeTaskTree

8 more
Phase 1.1: orchestrator.ts — Round CRUD 方法 + 现有方法升级
先更新 import，加入 Round 类型：

orchestrator.ts
+1
-1
import crypto from "node:crypto";
import type { TaskTree, SubTask, TaskTreeChange, QualityReviewResult, TaskBatch, BatchExecutionResult, BatchExecutionOptions, PostProcessResult } from "./types.js";
import type { TaskTree, SubTask, TaskTreeChange, QualityReviewResult, TaskBatch, BatchExecutionResult, BatchExecutionOptions, PostProcessResult, Round, RoundStatus } from "./types.js";
import { TaskTreeManager } from "./task-tree-manager.js";
Now add Round CRUD methods to orchestrator. I'll insert them right after the existing mergeRoundOutputs method (around line 700) and before the existing round-related section:

在现有的轮次隔离区块之前插入 Round CRUD 方法：

orchestrator.ts
+89
    console.log(`[Orchestrator] 🔄 Round ${roundId} status: ${oldStatus} → ${newStatus}`);
  }
 
  // ========================================
  // 🆕 轮次隔离：集中式完成判定

现在更新 addSubTask() 方法，让它在添加子任务时同步更新 Round.subTaskIds 和设置 subTask.roundId：

orchestrator.ts
+10
-1
      if (round) {
        round.subTaskIds.push(subTask.id);
      }
    }
 

现在更新 markRoundCompleted() 让它同时更新 Round.status：

====

## Phase 1 施工完成总结（Round 一等公民化）

### 变更文件

| 文件 | 变更类型 | 内容 |
|------|----------|------|
| `orchestrator.ts` | 修改 ~5 行 | `initializeTaskTree()` 新增 `rounds: []` 初始化 |
| `orchestrator.ts` | 修改 ~5 行 | `getRoundRootDescription()` 优先使用 `Round.goal`，回退旧启发式逻辑 |
| `orchestrator.ts` | 修改 ~8 行 | `reviewRoundCompletion()` 新增 `rootTaskId` 参数，传递 Round.goal 给质量评审 |
| `orchestrator.ts` | 修改 ~3 行 | `checkAndReviewCompletion()` 使用活跃 Round.goal 作为评审基准 |
| `enqueue-task-tool.ts` | 新增 ~6 行 | 生成 rootTaskId 后调用 `getOrCreateRound()` 同步创建 Round 对象 |
| `quality-reviewer.ts` | 修改 ~5 行 | `reviewOverallCompletion()` 新增 `rootTaskOverride` 参数 |
| `quality-reviewer.ts` | 修改 ~3 行 | `buildOverallReviewPrompt()` 使用 `effectiveRootTask` 替代 `taskTree.rootTask` |
| `followup-runner.ts` | 修改 ~4 行 | 归档摘要 `taskGoal` 优先使用 `Round.goal` |

### Phase 1 已有基础（Phase 0 后续对话中已提前实现）

以下改动在 Phase 0 完成后的对话中已提前落地，本次确认无需重复：
- `orchestrator.ts` import 已包含 `Round, RoundStatus`
- Round CRUD 方法已实现：`createRound/findRound/getOrCreateRound/getActiveRound/updateRoundStatus`
- `addSubTask()` 已设置 `subTask.roundId = rootTaskId` 并同步 `round.subTaskIds`
- `markRoundCompleted()` 已同步 Round.status（调用 `updateRoundStatus`）

### 验证结果

- `pnpm build` ✅ 零错误通过
- 向后兼容 ✅ 所有新增参数均为可选（`?`），旧调用方无影响
- Round 数据流 ✅ 完整链路：enqueue_task 创建 Round → addSubTask 关联 → 质量评审使用 Round.goal → markRoundCompleted 更新 Round.status → 归档使用 Round.goal

### 新增/变更的公开 API

| 方法 | 变更 | 说明 |
|------|------|------|
| `Orchestrator.reviewRoundCompletion(taskTree, rootTaskId?)` | 新增 `rootTaskId` 参数 | 传递 Round.goal 给整体质量评审 |
| `QualityReviewer.reviewOverallCompletion(taskTree, rootTaskOverride?)` | 新增 `rootTaskOverride` 参数 | 评审 prompt 使用 Round.goal 替代 taskTree.rootTask |

### Phase 1 完成状态

Phase 0: 类型定义层 ✅
Phase 1: Round 一等公民化 ✅
Phase 2: ExecutionContext 替代布尔标记（待施工）
Phase 3: 上下文管道 Round 感知（待施工）
Phase 4: 生命周期钩子（待施工）
Phase 5: 清理（待施工）