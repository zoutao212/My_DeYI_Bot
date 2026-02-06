# Clawdbot Agent 能力全面优化方案

**版本**: v1.0
**日期**: 2026-02-10
**目标**: 全面优化 Agent 的复杂任务分解能力、执行能力和交付能力

---

## 一、现状分析

### 1.1 已有模块清单

| 模块 | 路径 | 状态 | 核心问题 |
|------|------|------|----------|
| **多层协调器** | `src/agents/multi-layer/` | 骨架完成 | 层次判断基于关键词硬编码，无 LLM 意图分析 |
| **管家层 (Butler)** | `src/agents/butler/` | 骨架完成 | `understandIntent` 依赖 LLM JSON 解析，无容错；记忆注入用 `as any` 强转 |
| **虚拟世界层** | `src/agents/virtual-world/` | 骨架完成 | 未接入真实 LLM，转发逻辑基于字符串匹配 |
| **执行层** | `src/agents/execution/` | 骨架完成 | `task-executor.ts` 全是 TODO 占位，返回模拟数据 |
| **智能任务分解** | `src/agents/intelligent-task-decomposition/` | **最成熟** | Orchestrator 43K 行，功能丰富但与 task-board 存在职责重叠 |
| **任务看板** | `src/agents/task-board/` | 功能完整 | 与 intelligent-task-decomposition 的 Orchestrator 存在两套并行的编排逻辑 |
| **记忆服务** | `src/agents/memory/` | 功能完整 | 检索/归档已实现，但未与 Pi Agent 主流程深度集成 |
| **Lina Agent** | `src/agents/lina/` | 骨架完成 | 能力路由返回占位字符串，未接入真实 LLM 和工具链 |

### 1.2 核心痛点

1. **两套编排系统并行**：`intelligent-task-decomposition/orchestrator.ts`（43K 行，功能丰富）和 `task-board/orchestrator.ts`（351 行，轻量级）职责重叠，维护成本高
2. **执行层是空壳**：`execution/task-executor.ts` 全是 TODO，无法真正执行任务
3. **层次判断太粗糙**：`MultiLayerCoordinator.determineLayer()` 基于关键词硬编码，无法处理复杂意图
4. **管家层未接入主流程**：Butler/Lina 与 Pi Agent 的 `runEmbeddedPiAgent` 主循环完全脱节
5. **记忆系统孤岛化**：MemoryService 已实现但未在 Pi Agent 对话循环中自动调用
6. **缺乏统一入口**：没有一个统一的"请求 → 路由 → 分解 → 执行 → 交付"管线

---

## 二、优化架构设计

### 2.1 统一管线架构（核心创新）

```
用户消息
  │
  ▼
┌─────────────────────────────────────────────────┐
│  RequestPipeline（统一请求管线）                  │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐   │
│  │ Classifier│→ │ Planner   │→ │ Executor  │   │
│  │ (意图分类)│  │ (任务规划)│  │ (任务执行)│   │
│  └───────────┘  └───────────┘  └───────────┘   │
│        │              │              │           │
│        ▼              ▼              ▼           │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐   │
│  │MemoryCtx  │  │ TaskTree  │  │ Deliverer │   │
│  │(记忆上下文)│  │(任务树)   │  │(交付管理) │   │
│  └───────────┘  └───────────┘  └───────────┘   │
└─────────────────────────────────────────────────┘
```

**核心思路**：不再维护两套编排系统，而是建立一条统一的请求处理管线，每个阶段可插拔。

### 2.2 三大能力升级

#### A. 任务分解能力升级

**现状**：LLM 驱动的分解已实现（`LLMTaskDecomposer`），但缺乏：
- 分解前的上下文增强（不知道代码库结构）
- 分解质量的自动校验闭环
- 递归分解的深度控制不够智能

**优化方向**：

1. **上下文增强分解（Context-Enriched Decomposition）**
   - 分解前自动注入：代码库结构摘要、最近修改文件、相关记忆
   - 利用已有的 `MemoryRetriever` 检索历史任务经验
   - 利用已有的 `bootstrap-files.ts` 获取代码库上下文

2. **分解质量闭环（Decomposition Quality Loop）**
   - 复用已有的 `QualityReviewer`，但增加"分解完整性检查"维度
   - 新增"子任务可执行性验证"：每个子任务必须映射到至少一个工具/技能
   - 分解后自动生成依赖图，检测循环依赖和孤立任务

3. **自适应深度控制（Adaptive Depth Control）**
   - 基于任务复杂度动态调整 `maxDepth`（当前固定为 3）
   - 引入"分解收益递减检测"：当子任务已经足够简单时停止分解
   - 复用 `SubTaskMetadata.complexity` 做判断

#### B. 执行能力升级

**现状**：`execution/task-executor.ts` 全是占位代码，`intelligent-task-decomposition/orchestrator.ts` 有真实执行逻辑但未与执行层对接。

**优化方向**：

1. **执行层真实化（Real Execution Layer）**
   - 将 `task-executor.ts` 从占位代码升级为真实的 Pi Agent 工具调用桥接
   - 核心：`executeSimpleTask` → 调用 `runEmbeddedPiAgent` 的工具链
   - 复用已有的 `pi-tools.ts` 工具注册机制

2. **批量执行优化（已有设计，需落地）**
   - `TaskGrouper` 和 `BatchExecutor` 已实现但未在主流程中启用
   - 在 Orchestrator 中增加批量执行路径：当检测到多个独立子任务时自动分组
   - 复用 `GroupingOptions` 和 `BatchExecutionOptions` 配置

3. **执行监控与自愈（Execution Monitoring & Self-Healing）**
   - 复用 `RetryManager` 和 `ErrorHandler`，增加：
     - 执行超时自动降级（复杂任务 → 简单任务）
     - 工具调用失败自动切换备选工具
     - 执行卡死检测（基于 `RecoveryManager`）

4. **并行执行引擎（Parallel Execution Engine）**
   - 当前 `task-board/orchestrator.ts` 的 `executeSubTasks` 是串行的
   - 升级为：分析依赖图 → 识别可并行子任务 → `Promise.allSettled` 并发执行
   - 复用 `SubTask.dependencies` 字段做依赖分析

#### C. 交付能力升级

**现状**：`send_file` 工具已实现 Telegram 和 Web 频道，但缺乏结构化交付。

**优化方向**：

1. **结构化交付管理器（Structured Deliverer）**
   - 新增 `Deliverer` 组件，负责：
     - 收集所有子任务产出（文件、代码变更、命令输出）
     - 生成结构化交付报告（Markdown + JSON）
     - 根据频道类型选择最佳交付方式

2. **增量交付（Incremental Delivery）**
   - 子任务完成后立即交付阶段性成果（已有 `send_file` 基础）
   - 全部完成后交付汇总报告
   - 复用 `FileManager.mergeTaskOutputs` 做文件合并

3. **交付质量保证（Delivery QA）**
   - 交付前自动运行验证（如 `pnpm build`、`pnpm test`）
   - 交付报告包含：变更摘要、测试结果、风险提示
   - 复用 `self-improvement.ts` 的经验固化能力

---

## 三、具体实施计划

### 阶段 1：统一编排层（优先级：最高）

**目标**：消除两套编排系统的冗余，建立统一的任务处理管线

**具体任务**：

1. **合并两个 Orchestrator**
   - 以 `intelligent-task-decomposition/orchestrator.ts`（功能更丰富）为基础
   - 将 `task-board/orchestrator.ts` 的 TaskBoard 集成、进度跟踪、失败处理能力合并进来
   - 最终产出：一个统一的 `UnifiedOrchestrator`

2. **建立 RequestPipeline**
   - 新增 `src/agents/pipeline/request-pipeline.ts`
   - 实现 `classify → plan → execute → deliver` 四阶段管线
   - 每个阶段可通过配置启用/禁用

3. **接入 Pi Agent 主流程**
   - 在 `pi-embedded-runner.ts` 中增加管线入口
   - 当检测到复杂任务时，自动切换到管线模式
   - 保持向后兼容：简单任务仍走原有流程

**预期收益**：
- 消除代码冗余 ~400 行
- 统一任务状态管理
- 为后续优化提供统一基础

### 阶段 2：执行层真实化（优先级：高）

**目标**：让执行层从占位代码变为真实可用

**具体任务**：

1. **实现 PiAgentBridge**
   - 新增 `src/agents/execution/pi-agent-bridge.ts`
   - 桥接 `IExecutor` 接口到 `runEmbeddedPiAgent` 的工具调用
   - 支持：文件读写、命令执行、代码搜索等核心工具

2. **启用批量执行**
   - 在 UnifiedOrchestrator 中集成 `TaskGrouper` + `BatchExecutor`
   - 配置驱动：`taskDecomposition.enableBatchExecution: true`

3. **实现并行执行**
   - 升级 `executeSubTasks` 为依赖感知的并行执行
   - 使用拓扑排序确定执行顺序
   - 无依赖的子任务并发执行

**预期收益**：
- 执行层从 0% 可用变为 100% 可用
- 批量执行减少 30-50% 的 LLM 调用
- 并行执行提升 2-3x 吞吐量

### 阶段 3：上下文增强分解（优先级：高）

**目标**：让任务分解更智能、更准确

**具体任务**：

1. **分解前上下文注入**
   - 在 `LLMTaskDecomposer.decompose()` 前注入：
     - 代码库文件树摘要（复用 `bootstrap-files.ts`）
     - 相关记忆（复用 `MemoryRetriever`）
     - 历史任务经验（复用 `FailureRecord.lessons`）

2. **分解质量闭环**
   - 在 `QualityReviewer` 中新增 `reviewDecomposition` 方法
   - 检查：子任务完整性、依赖合理性、可执行性
   - 不通过则自动触发 `TaskAdjuster` 调整

3. **自适应深度控制**
   - 新增 `DepthController` 组件
   - 基于 `SubTaskMetadata.complexity` 和 `estimatedTokens` 动态决定是否继续分解

**预期收益**：
- 分解准确率提升 30%+
- 减少"分解过细"或"分解不足"的情况
- 利用历史经验避免重复犯错

### 阶段 4：记忆系统深度集成（优先级：中）

**目标**：让记忆系统从孤岛变为管线的有机组成部分

**具体任务**：

1. **对话前自动记忆注入**
   - 在 RequestPipeline 的 classify 阶段自动调用 `MemoryRetriever`
   - 将检索到的记忆注入到 System Prompt 的 `extraSystemPrompt` 中
   - 不再需要 Butler 层手动调用

2. **对话后自动经验归档**
   - 在 RequestPipeline 的 deliver 阶段自动调用 `MemoryArchiver`
   - 归档内容包括：任务摘要、关键决策、失败教训
   - 复用 `self-improvement.ts` 的模式识别能力

3. **任务级记忆**
   - 每个任务树自动关联一个记忆上下文
   - 子任务执行时可查询同一任务树内的历史输出
   - 避免子任务之间的信息断裂

**预期收益**：
- 消除记忆系统的手动调用负担
- 跨会话任务恢复更智能
- 任务内子任务间信息共享

### 阶段 5：交付能力升级（优先级：中）

**目标**：从"完成任务"升级为"交付成果"

**具体任务**：

1. **实现 Deliverer 组件**
   - 新增 `src/agents/pipeline/deliverer.ts`
   - 收集所有子任务产出
   - 生成结构化交付报告

2. **增量交付**
   - 子任务完成后通过 `send_file` 发送阶段性成果
   - 全部完成后发送汇总报告
   - 支持 Discord/Slack 多频道（复用已有设计）

3. **交付前验证**
   - 代码变更后自动运行 `pnpm build` 验证
   - 生成变更摘要和风险提示

**预期收益**：
- 用户实时看到任务进展
- 交付物结构化、可追溯
- 减少"任务完成但结果不可用"的情况

### 阶段 6：多层架构激活（优先级：低）

**目标**：让多层架构从骨架变为可用

**具体任务**：

1. **升级层次判断**
   - 将 `determineLayer` 从关键词匹配升级为 LLM 意图分类
   - 或使用轻量级分类器（基于消息特征的规则引擎 + LLM 兜底）

2. **激活 Butler 层**
   - 将 Butler 的 `handleMessage` 接入 RequestPipeline
   - 记忆注入和归档由管线自动处理，Butler 专注于意图理解和任务委托

3. **激活虚拟世界层**
   - 接入真实 LLM 调用
   - 实现角色扮演 ↔ 技术操作的无缝切换

**预期收益**：
- 角色扮演和技术操作分离，节省 30-50% token
- 用户体验更自然
- 为多角色场景打下基础

---

## 四、关键设计决策

### 4.1 合并 vs 保留两套 Orchestrator

**推荐方案**：以 `intelligent-task-decomposition/orchestrator.ts` 为基础合并

**理由**：
- 它已有 43K 行成熟代码，包含递归分解、质量评估、批量执行、文件管理等
- `task-board/orchestrator.ts` 的 TaskBoard 集成能力可以作为插件合并进来
- 避免维护两套状态管理和执行逻辑

### 4.2 管线模式 vs 直接调用

**推荐方案**：管线模式（RequestPipeline）

**理由**：
- 每个阶段可独立测试和优化
- 支持配置驱动的阶段启用/禁用
- 便于后续扩展（如增加审批阶段、安全检查阶段）

### 4.3 执行层桥接方式

**推荐方案**：通过 `PiAgentBridge` 桥接到现有 Pi Agent 工具链

**理由**：
- 复用已有的 200+ 工具定义和权限控制
- 不需要重新实现文件读写、命令执行等基础能力
- 保持与现有系统的兼容性

### 4.4 记忆注入时机

**推荐方案**：在管线的 classify 阶段自动注入

**理由**：
- 意图分类需要历史上下文
- 一次检索，多处复用（分类、分解、执行都可用）
- 避免每个组件各自检索造成的重复调用

---

## 五、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 合并 Orchestrator 引入回归 | 高 | 先写集成测试覆盖现有行为，再合并 |
| 执行层桥接性能问题 | 中 | 增加执行超时和降级机制 |
| 记忆检索延迟影响响应速度 | 中 | 设置超时（5s），超时则跳过记忆注入 |
| 并行执行的状态同步问题 | 中 | 使用 `Promise.allSettled` + 原子状态更新 |
| 批量执行的输出拆分不准确 | 低 | 已有 fallback 机制（逐个重试） |

---

## 六、成功指标

1. **任务分解准确率**：从当前基线提升 30%+（通过分解质量闭环）
2. **执行成功率**：从 0%（占位代码）提升到 90%+（真实执行）
3. **LLM 调用次数**：通过批量执行减少 30-50%
4. **任务完成时间**：通过并行执行减少 40%+
5. **代码冗余**：消除两套 Orchestrator 的重复代码 ~400 行
6. **交付完整性**：100% 的任务产出有结构化报告

---

## 七、实施优先级排序

```
阶段 1（统一编排层）→ 阶段 2（执行层真实化）→ 阶段 3（上下文增强分解）
         ↓                      ↓                        ↓
    消除冗余基础            真正能执行              分解更智能
         ↓                      ↓                        ↓
阶段 4（记忆深度集成）→ 阶段 5（交付能力升级）→ 阶段 6（多层架构激活）
         ↓                      ↓                        ↓
    上下文连续            结果可交付              体验升级
```

**建议先做阶段 1 + 2**，因为它们是后续所有优化的基础。阶段 3-6 可以根据实际需求灵活调整顺序。

---

**版本**: v1.0
**作者**: Cascade AI
**状态**: 待评审
