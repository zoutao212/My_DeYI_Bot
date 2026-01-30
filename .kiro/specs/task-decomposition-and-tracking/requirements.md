# 需求文档：任务分解、展示和总结机制

## 介绍

本文档定义了 Clawdbot 的任务分解、展示和总结机制的需求。该机制旨在解决当前 Clawdbot 在处理复杂任务时的黑盒问题，提供清晰的任务拆解、进度可视化、失败处理和自我改进能力。

## 术语表

- **Task_Decomposer**：任务分解器，负责将复杂任务拆解成可执行的子任务
- **Task_Board**：任务看板，用于展示主任务、子任务、进度和状态的可视化界面
- **Task_Executor**：任务执行器，负责执行子任务并记录结果
- **Failure_Handler**：失败处理器，负责处理子任务失败、重试和总结
- **Progress_Tracker**：进度跟踪器，负责跟踪和更新任务进度
- **Session**：会话，指一次完整的用户交互过程
- **Checkpoint**：检查点，任务执行过程中的关键节点
- **Context_Anchor**：上下文锚点，用于快速定位代码位置和命令的引用

## 需求

### 需求 1：任务自动拆解

**用户故事**：作为用户，我希望当我提出复杂任务时，系统能自动将其拆解成可执行的子任务，这样我就能清楚地知道系统会做哪些事情。

#### 验收标准

1. WHEN 用户提交一个复杂任务 THEN Task_Decomposer SHALL 分析任务复杂度并判断是否需要拆解
2. WHEN 任务需要拆解 THEN Task_Decomposer SHALL 生成 2-8 个子任务，每个子任务包含标题、描述、依赖关系和预期产出
3. WHEN 子任务生成后 THEN Task_Decomposer SHALL 向用户展示完整的任务拆解结果并等待确认
4. WHEN 用户确认任务拆解 THEN System SHALL 保存任务结构到持久化存储
5. WHEN 任务拆解被拒绝 THEN Task_Decomposer SHALL 根据用户反馈重新拆解任务

### 需求 2：任务看板展示

**用户故事**：作为用户，我希望能看到一个清晰的任务看板，展示主任务、所有子任务、当前焦点和进度，这样我就能随时了解任务执行状态。

#### 验收标准

1. WHEN 任务开始执行 THEN Task_Board SHALL 展示主任务的标题、目标和状态
2. WHEN 子任务列表存在 THEN Task_Board SHALL 展示所有子任务的 ID、标题、状态、进度和依赖关系
3. WHEN 有子任务正在执行 THEN Task_Board SHALL 高亮显示当前焦点任务并展示推理摘要和下一步行动
4. WHEN 任务状态变化 THEN Progress_Tracker SHALL 实时更新 Task_Board 的显示内容
5. WHEN 用户请求查看任务看板 THEN System SHALL 展示最新的 Task_Board 内容

### 需求 3：进度跟踪和持久化

**用户故事**：作为用户，我希望系统能持续跟踪任务进度并保存到磁盘，这样即使会话中断也能恢复任务状态。

#### 验收标准

1. WHEN 子任务开始执行 THEN Progress_Tracker SHALL 将子任务状态更新为 "active"
2. WHEN 子任务完成 THEN Progress_Tracker SHALL 将子任务状态更新为 "completed" 并记录产出
3. WHEN 子任务失败 THEN Progress_Tracker SHALL 将子任务状态更新为 "blocked" 并记录失败原因
4. WHEN 任务状态变化 THEN System SHALL 将 Task_Board 保存到 `.clawdbot/tasks/{session_id}/TASK_BOARD.json` 和 `TASK_BOARD.md`
5. WHEN 会话中断后恢复 THEN System SHALL 从持久化存储加载最新的 Task_Board 并继续执行

### 需求 4：失败处理和重试

**用户故事**：作为用户，我希望当子任务失败时，系统能提供清晰的失败原因和重试选项，这样我就能决定如何处理失败。

#### 验收标准

1. WHEN 子任务执行失败 THEN Failure_Handler SHALL 捕获错误并记录详细的失败原因
2. WHEN 子任务失败 THEN Failure_Handler SHALL 向用户展示失败原因和可选的处理方式（重试、跳过、修改任务）
3. WHEN 用户选择重试 THEN Task_Executor SHALL 重新执行失败的子任务
4. WHEN 用户选择跳过 THEN Progress_Tracker SHALL 将子任务标记为 "skipped" 并继续执行下一个子任务
5. WHEN 用户选择修改任务 THEN Task_Decomposer SHALL 允许用户修改子任务描述并重新执行

### 需求 5：检查点和总结

**用户故事**：作为用户，我希望系统在关键节点自动创建检查点并总结进展，这样我就能清楚地了解任务的阶段性成果。

#### 验收标准

1. WHEN 子任务完成 THEN System SHALL 创建一个 Checkpoint 并记录时间戳、摘要和关键决策
2. WHEN 任务焦点切换 THEN System SHALL 更新 CurrentFocus 并记录推理摘要和下一步行动
3. WHEN 出现风险或阻塞 THEN System SHALL 将风险添加到 RisksAndBlocks 列表并记录缓解措施
4. WHEN 所有子任务完成 THEN System SHALL 生成完整的任务总结，包括所有产出、关键决策和经验教训
5. WHEN 任务总结生成后 THEN System SHALL 询问用户是否需要将经验固化为规则或技能

### 需求 6：并发任务支持

**用户故事**：作为用户，我希望系统能支持并发执行多个独立的子任务，这样可以提高任务执行效率。

#### 验收标准

1. WHEN 子任务没有依赖关系 THEN Task_Executor SHALL 识别可并发执行的子任务
2. WHEN 可并发执行的子任务存在 THEN Task_Executor SHALL 向用户展示并发执行计划并等待确认
3. WHEN 用户确认并发执行 THEN Task_Executor SHALL 同时启动多个子任务的执行
4. WHEN 并发任务执行中 THEN Task_Board SHALL 展示所有正在执行的子任务及其进度
5. WHEN 并发任务中有任务失败 THEN Failure_Handler SHALL 暂停其他任务并等待用户决策

### 需求 7：上下文锚点

**用户故事**：作为用户，我希望系统能记录任务相关的代码位置和命令，这样在恢复任务时能快速定位到正确的上下文。

#### 验收标准

1. WHEN 子任务涉及代码修改 THEN System SHALL 记录相关的文件路径和函数名到 ContextAnchors
2. WHEN 子任务涉及命令执行 THEN System SHALL 记录相关的命令到 ContextAnchors
3. WHEN 任务恢复时 THEN System SHALL 展示 ContextAnchors 以帮助用户快速定位上下文
4. WHEN 用户请求查看上下文 THEN System SHALL 展示所有相关的代码位置和命令
5. WHEN 上下文锚点过多 THEN System SHALL 只保留最近 10 个最相关的锚点

### 需求 8：任务看板渲染

**用户故事**：作为用户，我希望任务看板能以友好的格式展示，既支持人类阅读也支持工具解析。

#### 验收标准

1. WHEN 任务看板保存时 THEN System SHALL 同时生成 JSON 格式（机器可读）和 Markdown 格式（人类可读）
2. WHEN 生成 Markdown 格式 THEN System SHALL 使用清晰的标题、列表和表格展示任务信息
3. WHEN 生成 JSON 格式 THEN System SHALL 确保数据结构符合 Task_Board Schema
4. WHEN 任务看板更新时 THEN System SHALL 覆盖写入两种格式的文件
5. WHEN 用户在 IDE 中打开 TASK_BOARD.md THEN System SHALL 确保内容格式化良好且易于阅读

### 需求 9：自我改进机制

**用户故事**：作为用户，我希望系统能从任务执行中学习，将有价值的经验固化为规则或技能，这样未来能更高效地处理类似任务。

#### 验收标准

1. WHEN 任务完成后 THEN System SHALL 分析任务执行过程并识别可复用的模式
2. WHEN 识别到可复用模式 THEN System SHALL 向用户建议将其固化为规则或技能
3. WHEN 用户同意固化 THEN System SHALL 调用 maintain-rules Power 创建新的规则或技能
4. WHEN 任务失败后 THEN System SHALL 分析失败原因并建议添加到 lessons-learned
5. WHEN 经验固化完成 THEN System SHALL 在任务总结中记录固化的规则或技能

### 需求 10：任务恢复

**用户故事**：作为用户，我希望在会话中断后能快速恢复任务，而不需要重新理解整个任务背景。

#### 验收标准

1. WHEN 用户说"继续任务"或"恢复任务" THEN System SHALL 从持久化存储加载最新的 Task_Board
2. WHEN Task_Board 加载后 THEN System SHALL 展示主任务、当前焦点和下一步行动
3. WHEN 下一步行动明确 THEN Task_Executor SHALL 直接执行下一步行动，不需要复盘整个对话
4. WHEN 下一步行动不明确 THEN System SHALL 将问题添加到 RisksAndBlocks 并请求用户澄清
5. WHEN 任务恢复后 THEN System SHALL 继续跟踪进度并更新 Task_Board
