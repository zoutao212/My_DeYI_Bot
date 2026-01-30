# 实现计划：任务分解、展示和总结机制

## 概述

本实现计划将任务分解、展示和总结机制的设计转换为可执行的开发任务。实现将分为以下几个阶段：

1. 核心数据模型和持久化
2. 任务分解器实现
3. 任务执行器和进度跟踪器
4. 失败处理和恢复机制
5. 用户界面集成
6. 测试和文档

## 任务列表

### 1. 核心数据模型和持久化

- [x] 1.1 定义 TaskBoard 数据模型
  - 创建 `src/agents/task-board/types.ts` 文件
  - 定义 TaskBoard、MainTask、SubTask、CurrentFocus、Checkpoint、Risk、ContextAnchors 接口
  - 添加 SubTaskStatus 类型定义
  - _需求: 1.2, 2.1, 2.2, 3.1, 3.2, 3.3, 5.1, 5.2, 5.3, 7.1, 7.2_

- [ ]* 1.2 编写数据模型的属性测试
  - **属性 5: 任务看板数据完整性**
  - **验证需求: 2.1, 2.2, 2.3, 2.5**

- [x] 1.3 实现 TaskBoard 持久化层
  - 创建 `src/agents/task-board/persistence.ts` 文件
  - 实现 `saveTaskBoard(board: TaskBoard, sessionId: string): Promise<void>` 方法
  - 实现 `loadTaskBoard(sessionId: string): Promise<TaskBoard | null>` 方法
  - 使用原子写入确保数据一致性
  - 保存到 `.clawdbot/tasks/{sessionId}/TASK_BOARD.json`
  - _需求: 1.4, 3.4, 3.5_

- [ ]* 1.4 编写持久化的属性测试
  - **属性 3: 任务持久化 Round-Trip 一致性**
  - **验证需求: 1.4, 3.4, 3.5**

- [x] 1.5 实现 TaskBoard 渲染器
  - 创建 `src/agents/task-board/renderer.ts` 文件
  - 实现 `renderToMarkdown(board: TaskBoard): string` 方法
  - 实现 `renderToJSON(board: TaskBoard): string` 方法
  - 确保 Markdown 格式包含标题、列表、表格等元素
  - 同时保存 JSON 和 Markdown 到文件系统
  - _需求: 8.1, 8.2, 8.3, 8.4, 8.5_

- [ ]* 1.6 编写渲染器的属性测试
  - **属性 22: 双格式保存一致性**
  - **属性 23: JSON 格式符合 Schema**
  - **属性 24: Markdown 格式包含必需元素**
  - **验证需求: 8.1, 8.2, 8.3, 8.4, 8.5**

### 2. 任务分解器实现

- [x] 2.1 实现 TaskDecomposer 接口
  - 创建 `src/agents/task-board/decomposer.ts` 文件
  - 实现 `shouldDecompose(task: string): Promise<boolean>` 方法
  - 实现复杂度判断逻辑（长度、动词数量、文件数量）
  - _需求: 1.1_

- [ ]* 2.2 编写复杂度判断的属性测试
  - **属性 1: 任务复杂度判断一致性**
  - **验证需求: 1.1**

- [x] 2.3 实现任务拆解逻辑
  - 实现 `decompose(task: string, context: DecompositionContext): Promise<SubTask[]>` 方法
  - 使用 LLM 分析任务描述并生成 2-8 个子任务
  - 识别子任务之间的依赖关系
  - 为每个子任务生成 ID、标题、描述、预期产出
  - _需求: 1.2_

- [ ]* 2.4 编写任务拆解的属性测试
  - **属性 2: 任务拆解输出格式正确性**
  - **验证需求: 1.2**

- [x] 2.5 实现任务重新拆解功能
  - 实现 `redecompose(task: string, feedback: string, previousDecomposition: SubTask[]): Promise<SubTask[]>` 方法
  - 根据用户反馈调整拆解结果
  - _需求: 1.5_

- [ ]* 2.6 编写重新拆解的属性测试
  - **属性 4: 任务重新拆解产生不同结果**
  - **验证需求: 1.5**

### 3. 进度跟踪器实现

- [x] 3.1 实现 ProgressTracker 接口
  - 创建 `src/agents/task-board/progress-tracker.ts` 文件
  - 实现 `initialize(mainTask: MainTask, subTasks: SubTask[]): Promise<TaskBoard>` 方法
  - 实现 `getTaskBoard(): Promise<TaskBoard>` 方法
  - 在内存中维护任务看板状态
  - _需求: 2.1, 2.5_

- [x] 3.2 实现状态更新方法
  - 实现 `updateSubTaskStatus(subTaskId: string, status: SubTaskStatus, progress?: string): Promise<void>` 方法
  - 实现 `updateCurrentFocus(subTaskId: string, reasoning: string, nextAction: string): Promise<void>` 方法
  - 每次状态变化后自动调用 persist 方法
  - _需求: 2.4, 3.1, 3.2, 3.3, 5.2_

- [ ]* 3.3 编写状态更新的属性测试
  - **属性 6: 子任务状态更新正确性**
  - **属性 7: 任务看板实时更新响应性**
  - **属性 11: 焦点切换更新正确性**
  - **验证需求: 2.4, 3.1, 3.2, 3.3, 5.2**

- [x] 3.4 实现检查点和风险管理
  - 实现 `createCheckpoint(summary: string, decisions: string[], openQuestions: string[]): Promise<void>` 方法
  - 实现 `addRisk(description: string, mitigation: string): Promise<void>` 方法
  - 实现 `addContextAnchor(type: "code_location" | "command", value: string): Promise<void>` 方法
  - 上下文锚点最多保留 10 个
  - _需求: 5.1, 5.3, 7.1, 7.2, 7.5_

- [ ]* 3.5 编写检查点和风险管理的属性测试
  - **属性 10: 检查点创建完整性**
  - **属性 12: 风险记录完整性**
  - **属性 19: 上下文锚点记录和查询**
  - **属性 20: 上下文锚点数量限制**
  - **验证需求: 5.1, 5.3, 7.1, 7.2, 7.4, 7.5**

- [x] 3.6 实现持久化集成
  - 实现 `persist(): Promise<void>` 方法
  - 实现 `load(sessionId: string): Promise<TaskBoard | null>` 方法
  - 集成 persistence 和 renderer 模块
  - _需求: 3.4, 3.5, 10.1_

### 4. 任务执行器实现

- [x] 4.1 实现 TaskExecutor 接口
  - 创建 `src/agents/task-board/executor.ts` 文件
  - 实现 `execute(subTask: SubTask, context: ExecutionContext): Promise<ExecutionResult>` 方法
  - 调用 Agent 工具集执行子任务
  - 捕获所有工具调用和结果
  - 提取产出（修改的文件、创建的函数等）
  - _需求: 4.1_

- [x] 4.2 实现并发执行功能
  - 实现 `executeConcurrent(subTasks: SubTask[], context: ExecutionContext): Promise<ExecutionResult[]>` 方法
  - 使用 Promise.all 并发执行多个子任务
  - 如果任一子任务失败，暂停其他子任务
  - _需求: 6.1, 6.3, 6.4, 6.5_

- [ ]* 4.3 编写并发执行的属性测试
  - **属性 15: 并发任务识别正确性**
  - **属性 16: 并发执行同时启动**
  - **属性 17: 并发任务状态展示**
  - **属性 18: 并发失败暂停其他任务**
  - **验证需求: 6.1, 6.3, 6.4, 6.5**

- [x] 4.3 实现取消功能
  - 实现 `cancel(subTaskId: string): Promise<void>` 方法
  - 支持取消正在执行的子任务
  - _需求: 6.5_

### 5. 失败处理器实现

- [x] 5.1 实现 FailureHandler 接口
  - 创建 `src/agents/task-board/failure-handler.ts` 文件
  - 实现 `analyzeFailure(subTask: SubTask, error: Error): Promise<FailureSummary>` 方法
  - 解析错误堆栈和消息
  - 识别错误类型和根本原因
  - 生成建议的修复方案
  - _需求: 4.1, 4.2_

- [ ]* 5.2 编写失败分析的属性测试
  - **属性 8: 失败处理捕获所有错误**
  - **验证需求: 4.1, 4.2**

- [x] 5.3 实现用户交互逻辑
  - 实现 `handleFailure(subTask: SubTask, error: Error): Promise<FailureDecision>` 方法
  - 展示失败原因和建议的修复方案
  - 提供选项：重试、跳过、修改任务、中止
  - 记录用户决策到任务看板
  - _需求: 4.2, 4.3, 4.4, 4.5_

- [ ]* 5.4 编写失败处理决策的属性测试
  - **属性 9: 失败处理决策有效性**
  - **验证需求: 4.3, 4.4, 4.5**

- [x] 5.5 实现经验固化建议
  - 实现 `suggestRuleCreation(failureSummary: FailureSummary): Promise<boolean>` 方法
  - 识别可复用的失败模式
  - 建议将经验添加到 lessons-learned
  - _需求: 9.4_

- [ ]* 5.6 编写经验固化的属性测试
  - **属性 27: 失败经验建议添加到 Lessons Learned**
  - **验证需求: 9.4**

### 6. Agent Orchestrator 集成

- [x] 6.1 实现 Agent Orchestrator
  - 创建 `src/agents/task-board/orchestrator.ts` 文件
  - 实现任务复杂度判断和分解触发逻辑
  - 协调 TaskDecomposer、TaskExecutor、ProgressTracker 和 FailureHandler
  - 处理用户交互（确认、重试、跳过等）
  - _需求: 1.1, 1.3, 4.2, 4.3, 4.4, 4.5_

- [x] 6.2 实现任务恢复逻辑
  - 识别"继续任务"或"恢复任务"关键词
  - 从持久化存储加载最新的任务看板
  - 展示主任务、当前焦点和下一步行动
  - 根据下一步行动的明确性决定是直接执行还是请求用户澄清
  - _需求: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ]* 6.3 编写任务恢复的属性测试
  - **属性 29: 任务恢复触发加载**
  - **属性 30: 任务恢复展示必需信息**
  - **属性 31: 明确下一步行动直接执行**
  - **属性 32: 不明确下一步行动添加风险**
  - **属性 33: 恢复后持续跟踪**
  - **验证需求: 10.1, 10.2, 10.3, 10.4, 10.5**

- [x] 6.4 实现任务总结生成
  - 在所有子任务完成后生成任务总结
  - 包含所有子任务产出、所有检查点和所有关键决策
  - 询问用户是否需要将经验固化为规则或技能
  - _需求: 5.4, 5.5_

- [ ]* 6.5 编写任务总结的属性测试
  - **属性 13: 任务总结生成完整性**
  - **属性 14: 经验固化建议触发**
  - **验证需求: 5.4, 5.5**

### 7. 自我改进机制集成

- [x] 7.1 实现可复用模式识别
  - 分析任务执行过程中的操作模式
  - 识别重复的工具调用序列（出现 3 次以上）
  - 生成可复用模式的描述
  - _需求: 9.1_

- [ ]* 7.2 编写模式识别的属性测试
  - **属性 25: 可复用模式识别**
  - **验证需求: 9.1**

- [x] 7.3 实现 maintain-rules Power 集成
  - 调用 maintain-rules Power 创建新的规则或技能
  - 传递正确的参数（模式描述、适用场景等）
  - 在任务总结中记录固化的规则或技能
  - _需求: 9.2, 9.3, 9.5_

- [ ]* 7.4 编写 Power 集成的属性测试
  - **属性 26: 经验固化调用 Power**
  - **属性 28: 经验固化记录到总结**
  - **验证需求: 9.2, 9.3, 9.5**

### 8. 用户界面集成

- [ ] 8.1 集成到 Telegram 界面
  - 在 Telegram 消息中展示任务拆解结果
  - 提供确认、重试、跳过等按钮
  - 展示任务看板的简化版本
  - _需求: 1.3, 4.2_

- [ ] 8.2 集成到 Discord 界面
  - 在 Discord 消息中展示任务拆解结果
  - 使用 Discord 的交互组件（按钮、选择菜单）
  - 展示任务看板的简化版本
  - _需求: 1.3, 4.2_

- [ ] 8.3 集成到 CLI 界面
  - 在终端中展示任务拆解结果
  - 使用交互式提示（@clack/prompts）
  - 展示任务看板的表格格式
  - _需求: 1.3, 4.2_

- [ ] 8.4 集成到 Web 界面
  - 在 Web UI 中展示任务拆解结果
  - 提供可视化的任务看板
  - 支持拖拽调整子任务顺序
  - _需求: 1.3, 4.2_

### 9. 检查点 - 确保所有核心功能正常工作

确保所有测试通过，如有问题请向用户报告。

### 10. 文档和示例

- [x] 10.1 编写用户文档
  - 创建 `docs/task-decomposition.md` 文件
  - 说明如何启用任务分解模式
  - 说明如何查看和操作任务看板
  - 说明如何处理失败和恢复任务
  - _需求: 所有需求_

- [x] 10.2 编写开发者文档
  - 创建 `docs/dev/task-board-architecture.md` 文件
  - 说明架构设计和组件职责
  - 说明如何扩展任务分解器和执行器
  - 说明如何添加新的用户界面
  - _需求: 所有需求_

- [x] 10.3 创建示例和教程
  - 创建 `examples/task-decomposition/` 目录
  - 提供简单任务和复杂任务的示例
  - 提供任务恢复的示例
  - 提供失败处理的示例
  - _需求: 所有需求_

### 11. 最终检查点 - 确保所有测试通过

确保所有测试通过，如有问题请向用户报告。

## 注意事项

- 任务标记 `*` 的为可选测试任务，可以根据项目进度决定是否实现
- 每个任务都引用了相关的需求编号，便于追溯
- 属性测试应该运行至少 100 次迭代以确保覆盖足够的输入空间
- 所有持久化操作都应该使用原子写入确保数据一致性
- 所有用户交互都应该提供清晰的提示和选项
- 所有错误都应该被捕获并转换为友好的错误消息
