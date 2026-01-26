---
name: task-continuity-board
description: 维护结构化的“当前任务进展看板”，用于在对话中断/上下文丢失/重启后快速恢复任务状态并继续执行。
---

# 任务连续性看板（Task Continuity Board）

## 一句话定位
这是一个让 Agent 在“对话意外中断 / 上下文窗口耗尽 / 重启”后，仍能**快速恢复任务状态并继续执行**的结构化任务进展看板能力。

## 目标（解决什么问题）
- **恢复成本最小化**：不依赖回忆整段对话，也不依赖链式推理复盘。
- **可执行恢复态**：只保留“继续干活必须知道的内容”（结论级、状态级、下一步行动）。
- **可持续维护**：在关键节点自动/半自动刷新看板，保证随时可重启。

## 核心原则（记忆压缩准则）
1. **不记录链式思考**：不写试错过程、不写冗余对话。
2. **只记录可恢复信息**：已确认结论、任务结构、下一步动作、风险与阻塞。
3. **可执行优先**：看板里的信息必须能回答：
   - 我们要做什么？
   - 当前做到哪？
   - 接下来做什么？
   - 卡点是什么？

一句话判断：**如果它不能帮助“恢复后继续执行”，就不应该进入看板。**

## 触发场景（满足任一即可触发）
### 自动触发（推荐）
1. **任务进入新阶段**：方向变化、方案选型落定、关键接口/文件路径确认。
2. **子任务完成/切换**：完成一个子任务或当前聚焦点变化。
3. **出现风险或阻塞**：依赖缺失、环境问题、权限/配置不确定。
4. **疑似上下文压力**：对话内容变长、信息密度上升、即将进行长时间执行。

### 用户显式触发
用户说出类似：
- “继续刚才的任务”
- “我们刚才在干嘛”
- “恢复任务”
- “把当前进展整理一下”

## 看板数据结构（推荐 Schema）
看板可以用 **YAML 风格**或**JSON 风格**存放在对话中（建议每次更新都完整输出一份“最新板子”，避免增量补丁难以合并）。

### 1) YAML 版（人读友好）
```yaml
TaskBoard:
  MainTask:
    title: ""
    objective: ""
    status: active | paused | completed | blocked
    progress: ""  # 例如："30%" / "已完成需求澄清" / "实现中"

  SubTasks:
    - id: T1
      title: ""
      description: ""
      status: pending | active | completed | blocked
      progress: ""
      dependencies: []
      outputs:
        - ""  # 产物：文件/函数/路由/命令/决定
      notes: ""   # 仅写结论级要点

  CurrentFocus:
    task_id: "T1"
    reasoning_summary: ""  # 结论级摘要（不是推理链）
    next_action: ""        # 可执行下一步（越具体越好）

  Checkpoints:
    - timestamp: ""
      summary: ""     # 本阶段结论摘要
      decisions: []    # 已确认的关键决策
      open_questions: []

  RisksAndBlocks:
    - description: ""
      mitigation: ""

  ContextAnchors:
    code_locations:
      - ""  # 例如："入口：d:/.../app.py::main"（尽量精确到文件/函数）
    commands:
      - ""  # 例如："Start_Cognito.bat"

  LastUpdated: ""
  Version: "v20260122_1"
```

### 2) JSON 版（工具友好）
```json
{
  "TaskBoard": {
    "MainTask": {
      "title": "",
      "objective": "",
      "status": "active",
      "progress": ""
    },
    "SubTasks": [
      {
        "id": "T1",
        "title": "",
        "description": "",
        "status": "pending",
        "progress": "",
        "dependencies": [],
        "outputs": [],
        "notes": ""
      }
    ],
    "CurrentFocus": {
      "task_id": "T1",
      "reasoning_summary": "",
      "next_action": ""
    },
    "Checkpoints": [
      {
        "timestamp": "",
        "summary": "",
        "decisions": [],
        "open_questions": []
      }
    ],
    "RisksAndBlocks": [
      {
        "description": "",
        "mitigation": ""
      }
    ],
    "ContextAnchors": {
      "code_locations": [],
      "commands": []
    },
    "LastUpdated": "",
    "Version": "v20260122_1"
  }
}
```

## 工作流（固定闭环）
### A. 正常执行中（持续刷新）
1. **初始化看板**：首次明确主任务后创建 `MainTask` + 2-5 个 `SubTasks`。
2. **每次只允许一个 active**：
   - `CurrentFocus.task_id` 指向当前子任务。
   - 其他子任务是 `pending` 或 `completed`。
3. **关键节点更新**：
   - 完成子任务 -> 把该子任务标为 `completed`，把产物写进 `outputs`。
   - 切换焦点 -> 更新 `CurrentFocus`（结论级摘要 + 下一步）。
   - 新风险出现 -> 追加到 `RisksAndBlocks`。

### B. 中断前（最小恢复态落地）
当判断即将中断/或用户要求“总结进展”时：
1. **刷新看板**：确保 `MainTask/SubTasks/CurrentFocus` 是最新。
2. **压缩为可恢复态**：
   - `CurrentFocus.reasoning_summary`：只写 3-8 行结论要点。
   - `CurrentFocus.next_action`：写成可执行动作（含文件路径/命令/下一步要修改的函数）。
3. **固化检查点**：把本阶段关键决策与未决问题写入 `Checkpoints`。

### C. 重启后（恢复与继续）
1. **加载最新看板**：优先以“最近一次完整看板”为准。
2. **恢复主任务与焦点**：
   - 直接对齐 `CurrentFocus.task_id`。
   - 严禁先复盘整段对话。
3. **按 next_action 执行**：如果 `next_action` 不可执行，先把问题写入 `open_questions` 或 `RisksAndBlocks`，再重新制定下一步。

## 输出模板（建议每次更新都输出一份完整看板）
你可以直接复制下面模板来创建/刷新：

```yaml
TaskBoard:
  MainTask:
    title: ""
    objective: ""
    status: active
    progress: ""

  SubTasks:
    - id: T1
      title: ""
      description: ""
      status: active
      progress: ""
      dependencies: []
      outputs: []
      notes: ""
    - id: T2
      title: ""
      description: ""
      status: pending
      progress: ""
      dependencies: ["T1"]
      outputs: []
      notes: ""

  CurrentFocus:
    task_id: "T1"
    reasoning_summary: |
      - 
    next_action: ""

  Checkpoints:
    - timestamp: ""
      summary: ""
      decisions: []
      open_questions: []

  RisksAndBlocks: []

  ContextAnchors:
    code_locations: []
    commands: []

  LastUpdated: ""
  Version: "v20260122_1"
```

## 持久化与可视化（强烈推荐启用）

### 为什么建议在目录内落盘看板文件
把看板写到磁盘文件里，相当于给“对话中断/上下文耗尽”准备一个**不依赖聊天记录**的恢复锚点。
你不需要记得我们聊了什么，只要打开面板文件就能立刻恢复执行。

### 约定文件（本 Skill 的默认落点）
在本目录下固定维护两份文件：
- `TASK_BOARD.md`
  - 作用：人类/IDE 直接阅读的“面板文件”（建议固定打开当作看板面板）。
  - 内容：以 YAML 看板为主，附带“恢复口令”。
- `TASK_BOARD.json`
  - 作用：工具友好、便于后续自动化（例如未来写脚本把 JSON 渲染成 Markdown）。
  - 内容：与 YAML 同构的 JSON 看板。

### 写入策略（必须遵守）
1. **整板覆盖**：每次更新都输出“完整看板”，并覆盖写入 `TASK_BOARD.md` / `TASK_BOARD.json`。
2. **一源多视图**（推荐实践）：
   - 以 `TASK_BOARD.json` 作为结构化主源（更稳定）
   - `TASK_BOARD.md` 作为展示面板（更好读）
3. **更新频率**：
   - 子任务完成/切换焦点/风险变化 -> 立刻更新

### 重启恢复的标准动作
1. 打开 `TASK_BOARD.md`，读取 `CurrentFocus.next_action`
2. 把看板整段粘贴到新对话
3. 明确一句：按 `CurrentFocus.next_action` 继续，不要复盘旧对话

### 方案 B（一源多视图）的推荐工作流（JSON -> 面板 MD）
你把 `TASK_BOARD.json` 作为主源维护（结构稳定），然后用脚本渲染出更“面板化”的 `TASK_BOARD.md`：

1. **更新主源**：编辑 `TASK_BOARD.json`（或由 Agent 在对话中生成 JSON 后写入）
2. **一键渲染**（在本目录运行）：
   - `python render_task_board.py`
3. **固定打开面板**：在 IDE 中常驻打开 `TASK_BOARD.md`

脚本位置：`render_task_board.py`
默认输入输出：
- 输入：`TASK_BOARD.json`
- 输出：`TASK_BOARD.md`

可选参数：
- `python render_task_board.py --json TASK_BOARD.json --md TASK_BOARD.md`

## 与现有机制的协同建议
- 与 IDE 的 `todo_list` 工具：
  - **`todo_list` 负责“本轮执行的行动清单”**（更细、更可执行）
  - **本 Skill 的看板负责“跨中断的任务恢复态”**（更稳、更结论级）
- 与 `project_memory_gardening`：
  - 当任务涉及复杂代码定位、入口/调用链需要固化：用 `project_memory_gardening` 把“定位地图”写入 `ProjectMemory/00_索引/*`。
- 与 `maintain_rules`：
  - 当你发现“为什么会中断/为什么恢复困难”是因为规则缺失：用 `maintain_rules` 固化新规则或升级本 Skill。

## 极简示例（恢复时要达到的效果）
```text
Task Continuity Board Loaded
主任务：创建 agent skill —— task-continuity-board
当前子任务：T2 设计看板数据结构与触发条件（80%）
下一步：把 schema/触发/流程写入 .windsurf/skills/task-continuity-board/SKILL.md，并补一份可复制模板
风险：字段过多导致维护成本上升 -> 保持结论级、每次整板覆盖更新
```

---
版本：v20260122_3（新增：`render_task_board.py`，支持从 `TASK_BOARD.json` 自动渲染面板 `TASK_BOARD.md`）
