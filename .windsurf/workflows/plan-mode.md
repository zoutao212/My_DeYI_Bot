---
description: Plan Mode（Spec 驱动开发四阶段工作流：研究→计划→执行→收尾）
auto_execution_mode: 3
---

# /plan-mode 工作流

本工作流用于把“模糊需求”推进为“可验证、可交付、可复盘”的工程结果。

核心原则：

- **Spec 是单一真相源（SSOT）**：Plan / Task / 代码 / 报告都必须可回溯到 Spec。
- **规划不是终点，而是执行入口**：Plan 产出后必须进入执行。
- **四阶段门禁**：未完成上一阶段“必产出”，不得进入下一阶段。
- **自动推进**：每阶段结束必须宣布完成并进入下一阶段；除非你明确打断，否则默认继续。

> 适用场景：需求较大、需要分阶段推进、需要可复盘/可交付结果的任务。

补充约定（本工作流的落盘产物）：

- **Plan 文件**：`.windsurf/workflows/plan-mode/PLAN.md`
- **Task/Todo 文件**：`.windsurf/workflows/plan-mode/TASKS.md`
- **任务连续性看板**（用于中断恢复）：
  - `.windsurf/workflows/plan-mode/TASK_BOARD.md`
  - `.windsurf/workflows/plan-mode/TASK_BOARD.json`

说明：

- **/plan-mode**：负责 Spec 驱动的“研究→计划→执行→收尾”完整闭环。
- **task-continuity-board**：负责“上下文耗尽/中断/重启”时快速恢复执行（面向持续执行可靠性）。
- 本工作流要求在关键节点把“可恢复态”落盘到 `TASK_BOARD.*`，避免只存在于聊天记录。

---

## Phase 1：研究与理解（Research）

目标：确保真正理解“要做什么、为什么做、怎么判定成功”。

### 1.1 必做动作

- 收集上下文：用户补充、相关文件、现状行为、报错/日志、约束条件。
- 明确三件事：
  - 目标是什么
  - 不做什么（明确范围边界）
  - 成功标准是什么（可验证）
- 列出不确定点，并提出**最少必要问题**（能推进决策/缩小范围的问题）。

### 1.2 阶段必产出（必须显式写出来）

- **问题理解摘要**（1-5 句）
- **风险/不确定点清单**（按优先级）
- **进入 Phase 2 的结论**：信息是否足够、还缺什么

同时落盘（必须）：

- 更新 `.windsurf/workflows/plan-mode/TASK_BOARD.md` 与 `.windsurf/workflows/plan-mode/TASK_BOARD.json`

### 1.3 门禁

- 如果成功标准不清晰：必须补问，禁止直接写 Plan。

---

## Phase 2：规划与任务拆解（Plan & Task）

目标：把 Spec 转成“可执行路径”。

### 2.1 必做动作

- 编写 Plan：只写“做什么 + 顺序”，不写工期。
- 将 Plan 拆解为可独立执行的 Task/Todo，并为每项补齐：
  - 输入
  - 输出
  - 验证方式

### 2.2 规则

- **禁止工期/时间估算**（小时/天/周）。
- **禁止模糊任务**（例如“优化一下”“看看情况”“后面再说”）。
- Task 必须可独立执行并可验证。

### 2.3 阶段必产出

- **Plan（Markdown）**
- **Todo/Task List（必须落地）**：优先用 `todo_list` 工具维护状态

同时落盘（必须）：

- 把 Plan 写入 `.windsurf/workflows/plan-mode/PLAN.md`
- 把 Task 写入 `.windsurf/workflows/plan-mode/TASKS.md`
- 更新 `.windsurf/workflows/plan-mode/TASK_BOARD.md` 与 `.windsurf/workflows/plan-mode/TASK_BOARD.json`

### 2.4 门禁

- Task 未覆盖“验证方式”：不得进入执行。

---

## Phase 3：执行（Execution）

目标：忠实按 Spec 与 Task 执行，而不是即兴发挥。

### 3.1 执行原则

- 严格按 Task 顺序执行。
- 每完成一项 Task：
  - 说明做了什么（对应哪个 Task）
  - 说明验证做了什么（或为什么当前无法验证）
  - 更新 `todo_list` 状态

同时落盘（必须）：

- 子任务完成/切换焦点/风险变化 -> 立刻刷新 `TASK_BOARD.*`

### 3.2 偏差处理（非常关键）

- 如果执行中发现：需求理解偏差/约束变化/方案不可行：
  - **先回溯 Spec**（问题本质是否变化）
  - **更新 Plan/Task**（保持 SSOT）
  - 再继续执行

### 3.3 允许/禁止

- 允许：改代码、跑命令、加调试、创建/修改文件。
- 禁止：越过 Spec “顺手优化”导致范围漂移；隐式决策不记录。

---

## Phase 4：完成与报告（Completion & Report）

目标：让结果可交付、可复用、可回忆。

### 4.1 必须输出

- **完成情况总览**：实现了什么、没实现什么
- **Task 对照**：每个 Task 的最终状态
- **关键设计决策（Why）**：为什么这么做
- **已知问题/技术债**：短期影响与后续建议
- **复盘**：若重来一次，会如何改进

同时落盘（必须）：

- 完成后将最终的 Plan/Task/看板保持在 `.windsurf/workflows/plan-mode/` 目录，作为可复盘资产

### 4.2 结论要求

- 明确说明：Spec 是否完整实现
- 明确说明：是否存在偏离及原因

---

## 自动推进规则（强制）

- 每阶段结束必须：
  - 显式宣布“Phase X 完成”
  - 给出本阶段产出
  - 自动进入下一阶段（除非你明确打断）

---

## Todo 维护规范（强制）

- 创建 Todo 时：必须有 1 个 `in_progress`，其余 `pending`.
- 执行中：
  - 当前在做的 Task 设为 `in_progress`
  - 完成后立刻设为 `completed`
- 发现新工作：补充到 Todo，并说明它与 Spec/Plan 的对应关系。

---

## 倒计时自动执行（Planning Mode 场景）

如果你当前处于“只规划不执行”的惯性模式，按以下规则强制闭环：

1. Phase 2 输出 Plan 与 Todo 后，追加一个 **5-20 秒倒计时任务**（写入 Todo）。
2. 倒计时结束后：自动进入 Phase 3 开始执行，无需再次询问“要不要继续”。

倒计时脚本（推荐）：

- 位置：`.windsurf/workflows/plan-mode/countdown.py`
- 用法示例：
  - `python .windsurf/workflows/plan-mode/countdown.py --seconds 10 --label "Phase2->Phase3"`
  - `python .windsurf/workflows/plan-mode/countdown.py --phase 2`

---

## 最小提问原则（减少打断心流）

- 只有当缺信息会导致错误决策/返工时才提问。
- 能靠读文件/搜索定位解决的，不要问用户。
