# 实现计划：智能任务分解与队列执行系统

## 概述

本实现计划将智能任务分解与队列执行系统的设计转换为可执行的开发任务。实现将分为以下几个阶段：

1. 核心数据模型和接口定义
2. Task Analyzer 实现
3. Task Decomposer 实现
4. Queue Executor 实现（复用现有 `enqueue_task`）
5. Self Checker 实现
6. Loop Detector 实现（复用现有机制）
7. Hook Guard 实现（复用现有机制）
8. Agent Orchestrator 集成
9. 测试和文档

## 任务列表

### 1. 核心数据模型和接口定义

- [ ] 1.1 定义核心数据模型
  - 创建 `src/agents/intelligent-task-decomposition/types.ts` 文件
  - 定义 TaskAnalysis、DecomposedTask、SubTask、TaskDependency 接口
  - 定义 CheckResult、FinalSummary、QueueExecutionResult、QueueStatus 接口
  - 定义 MessageType 类型
  - _需求: 1.1, 2.1, 3.1, 4.1, 4.4, 6.1, 7.1_

- [ ]* 1.2 编写数据模型的属性测试
  - **属性 1: 任务分析结果完整性**
  - **属性 3: 任务分解输出格式正确性**
  - **属性 12: 完成情况检查结果完整性**
  - **属性 14: 最终总结生成完整性**
  - **验证需求: 1.1, 2.1, 4.1, 4.4**

### 2. Task Analyzer 实现

- [ ] 2.1 实现 TaskAnalyzer 接口
  - 创建 `src/agents/intelligent-task-decomposition/task-analyzer.ts` 文件
  - 实现 `isLargeTask(task: string): Promise<boolean>` 方法
  - 实现 `analyzeTask(task: string): Promise<TaskAnalysis>` 方法
  - 实现规模判断逻辑（内容生成、数据处理、多步骤）
  - 实现类型识别逻辑
  - _需求: 1.1, 1.2, 1.3, 1.4_

- [ ]* 2.2 编写 Task Analyzer 的属性测试
  - **属性 1: 任务分析结果完整性**
  - **属性 2: 大型任务识别正确性**
  - **验证需求: 1.1, 1.2, 1.3, 1.4**

### 3. Task Decomposer 实现

- [ ] 3.1 实现 TaskDecomposer 接口
  - 创建 `src/agents/intelligent-task-decomposition/task-decomposer.ts` 文件
  - 实现 `decompose(task: string, analysis: TaskAnalysis): Promise<DecomposedTask>` 方法
  - 实现 `redecompose(task: string, feedback: string, previousDecomposition: DecomposedTask): Promise<DecomposedTask>` 方法
  - _需求: 2.1_

- [ ] 3.2 实现连续任务分解策略
  - 实现连续任务分解逻辑
  - 将大型任务分解成多个顺序执行的子任务
  - 每个子任务的规模相似
  - _需求: 2.2_

- [ ]* 3.3 编写连续任务分解的属性测试
  - **属性 4: 连续任务分解正确性**
  - **验证需求: 2.2**

- [ ] 3.4 实现树形任务分解策略
  - 实现树形任务分解逻辑
  - 将复杂任务分解成主任务和子任务
  - 子任务可以有自己的子任务（parentId）
  - _需求: 2.3_

- [ ]* 3.5 编写树形任务分解的属性测试
  - **属性 5: 树形任务分解正确性**
  - **属性 22: 树形任务父子关系正确性**
  - **验证需求: 2.3, 8.2**

- [ ] 3.6 实现分支任务分解策略
  - 实现分支任务分解逻辑
  - 将可并行的任务分解成多个分支
  - 每个分支可以独立执行（canParallel: true）
  - _需求: 2.4_

- [ ]* 3.7 编写分支任务分解的属性测试
  - **属性 6: 分支任务分解正确性**
  - **验证需求: 2.4**

- [ ] 3.8 实现依赖任务分解策略
  - 实现依赖任务分解逻辑
  - 识别任务之间的依赖关系
  - 生成依赖图（dependencies）
  - _需求: 2.5_

- [ ]* 3.9 编写依赖任务分解的属性测试
  - **属性 7: 依赖任务分解正确性**
  - **验证需求: 2.5**

### 4. Queue Executor 实现（复用现有 `enqueue_task`）

- [ ] 4.1 实现 QueueExecutor 接口
  - 创建 `src/agents/intelligent-task-decomposition/queue-executor.ts` 文件
  - 实现 `enqueueSubTasks(subTasks: SubTask[], taskType: DecomposedTask["taskType"]): Promise<number>` 方法
  - 实现 `executeQueue(): Promise<QueueExecutionResult>` 方法
  - 实现 `getQueueStatus(): Promise<QueueStatus>` 方法
  - 复用现有的 `enqueue_task` 工具
  - _需求: 3.1, 3.2, 7.1_

- [ ]* 4.2 编写队列管理的属性测试
  - **属性 8: 队列深度增加正确性**
  - **属性 21: 队列任务执行后深度减少**
  - **验证需求: 3.1, 7.1, 7.4**

- [ ] 4.3 实现顺序执行逻辑
  - 按顺序将子任务加入队列
  - 使用 `followup` 模式
  - 不去重（`dedupeMode: "none"`）
  - _需求: 3.3_

- [ ]* 4.4 编写顺序执行的属性测试
  - **属性 9: 顺序执行正确性**
  - **验证需求: 3.3**

- [ ] 4.5 实现并行执行逻辑
  - 将可并行的子任务同时加入队列
  - 使用 Promise.all 并发执行
  - _需求: 3.4_

- [ ]* 4.6 编写并行执行的属性测试
  - **属性 10: 并行执行正确性**
  - **属性 23: 分支任务并行执行正确性**
  - **验证需求: 3.4, 8.3**

- [ ] 4.7 实现依赖执行逻辑
  - 检查依赖关系
  - 等待依赖任务完成后再加入队列
  - _需求: 3.5_

- [ ]* 4.8 编写依赖执行的属性测试
  - **属性 11: 依赖执行正确性**
  - **属性 24: 依赖任务执行顺序正确性**
  - **验证需求: 3.5, 8.4**

### 5. Self Checker 实现

- [ ] 5.1 实现 SelfChecker 接口
  - 创建 `src/agents/intelligent-task-decomposition/self-checker.ts` 文件
  - 实现 `checkCompletion(subTask: SubTask, output: string): Promise<CheckResult>` 方法
  - 实现 `generateSupplementaryTasks(checkResult: CheckResult): Promise<SubTask[]>` 方法
  - 实现 `generateFinalSummary(allResults: CheckResult[]): Promise<FinalSummary>` 方法
  - _需求: 4.1, 4.2, 4.4_

- [ ]* 5.2 编写 Self Checker 的属性测试
  - **属性 12: 完成情况检查结果完整性**
  - **属性 13: 补充任务生成正确性**
  - **属性 14: 最终总结生成完整性**
  - **验证需求: 4.1, 4.2, 4.4**

### 6. Loop Detector 实现（复用现有机制）

- [ ] 6.1 集成现有的循环检测机制
  - 复用 `.kiro/lessons-learned/82_LLM工具调用循环检测模式.md` 中的机制
  - 复用现有的全局标志 `isExecutingQueueTask`
  - 在 `enqueue_task` 工具中检测循环
  - _需求: 5.1_

- [ ] 6.2 实现工具调用循环检测
  - 创建 `src/agents/intelligent-task-decomposition/loop-detector.ts` 文件
  - 实现 `detectToolCallLoop(toolName: string, args: unknown): boolean` 方法
  - 记录最近的工具调用历史（最多 10 次）
  - 检测是否有相同的工具调用重复出现
  - _需求: 5.2_

- [ ]* 6.3 编写工具调用循环检测的属性测试
  - **属性 15: 工具调用循环检测正确性**
  - **验证需求: 5.2**

- [ ] 6.4 实现队列深度检测
  - 实现 `detectQueueDepthExceeded(queueDepth: number): boolean` 方法
  - 检查队列深度是否超过阈值（默认 50）
  - 如果超过，暂停队列执行并请求用户确认
  - _需求: 5.3_

- [ ] 6.5 实现循环错误信息生成
  - 实现 `generateLoopError(loopType: "queue_task" | "tool_call" | "queue_depth"): string` 方法
  - 生成明确的错误信息和正确做法
  - _需求: 5.4_

- [ ]* 6.6 编写循环错误信息的属性测试
  - **属性 16: 循环错误信息完整性**
  - **验证需求: 5.4**

- [ ] 6.7 实现循环检测日志记录
  - 记录循环类型、时间戳和上下文信息
  - _需求: 5.5_

- [ ]* 6.8 编写循环检测日志的属性测试
  - **属性 17: 循环检测日志记录**
  - **验证需求: 5.5**

### 7. Hook Guard 实现（复用现有机制）

- [ ] 7.1 集成现有的 Hook 副作用检测机制
  - 复用 `.kiro/lessons-learned/83_Hook副作用检测模式.md` 中的机制
  - 创建 `src/agents/intelligent-task-decomposition/hook-guard.ts` 文件
  - 实现 `detectMessageType(message: string): MessageType` 方法
  - 实现 `shouldSkipHook(messageType: MessageType): boolean` 方法
  - _需求: 6.1, 6.2, 6.3, 6.4_

- [ ]* 7.2 编写 Hook Guard 的属性测试
  - **属性 18: 消息类型检测正确性**
  - **属性 19: Hook 跳过逻辑正确性**
  - **验证需求: 6.1, 6.2, 6.3, 6.4**

- [ ] 7.3 实现 Hook 跳过日志记录
  - 记录消息类型、时间戳和跳过原因
  - _需求: 6.5_

- [ ]* 7.4 编写 Hook 跳过日志的属性测试
  - **属性 20: Hook 跳过日志记录**
  - **验证需求: 6.5**

### 8. Agent Orchestrator 集成

- [ ] 8.1 实现 Agent Orchestrator
  - 创建 `src/agents/intelligent-task-decomposition/orchestrator.ts` 文件
  - 实现任务规模判断和分解触发逻辑
  - 协调 TaskAnalyzer、TaskDecomposer、QueueExecutor 和 SelfChecker
  - 处理用户交互（确认、调整等）
  - _需求: 1.1, 1.5, 2.1_

- [ ] 8.2 实现队列状态管理
  - 复用 `.kiro/lessons-learned/84_队列管理的自动加入陷阱.md` 中的机制
  - 检查队列深度
  - 防止重复加入用户消息
  - _需求: 7.1, 7.2, 7.3_

- [ ] 8.3 实现用户场景支持
  - 支持生成大量内容场景（连续任务）
  - 支持总结大量内容场景（依赖任务）
  - 支持分析复杂项目场景（树形任务）
  - 支持并行处理多个文件场景（分支任务）
  - 支持多步骤流程场景（依赖任务）
  - _需求: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 8.4 实现混合任务类型支持
  - 支持多种任务类型的组合
  - 正确执行所有子任务
  - _需求: 8.5_

- [ ]* 8.5 编写混合任务类型的属性测试
  - **属性 25: 混合任务类型支持正确性**
  - **验证需求: 8.5**

### 9. 任务树持久化与管理

- [ ] 9.1 实现 TaskTreeManager 接口
  - 创建 `src/agents/intelligent-task-decomposition/task-tree-manager.ts` 文件
  - 实现 `initialize(decomposedTask: DecomposedTask, sessionId: string): Promise<TaskTree>` 方法
  - 实现 `save(taskTree: TaskTree): Promise<void>` 方法
  - 实现 `load(sessionId: string): Promise<TaskTree | null>` 方法
  - 实现 `updateSubTaskStatus(taskTree: TaskTree, subTaskId: string, status: SubTaskStatus): Promise<void>` 方法
  - _需求: 10.1, 10.2, 10.3_

- [ ] 9.2 实现检查点管理
  - 实现 `createCheckpoint(taskTree: TaskTree): Promise<string>` 方法
  - 实现 `restoreFromCheckpoint(taskTree: TaskTree, checkpointId: string): Promise<TaskTree>` 方法
  - 最多保留 10 个检查点
  - _需求: 14.1, 14.2, 14.3, 14.4, 14.5_

- [ ] 9.3 实现任务树渲染
  - 实现 `renderToMarkdown(taskTree: TaskTree): string` 方法
  - 生成清晰的 Markdown 格式
  - 同时保存 JSON 和 Markdown 到文件系统
  - _需求: 10.1, 10.2_

- [ ] 9.4 实现原子写入和备份
  - 使用原子写入确保数据一致性
  - 创建备份文件 `.clawdbot/tasks/{sessionId}/TASK_TREE.json.bak`
  - 如果主文件损坏，从备份文件恢复
  - _需求: 10.3, 10.4_

### 10. 重试机制实现

- [ ] 10.1 实现 RetryManager 接口
  - 创建 `src/agents/intelligent-task-decomposition/retry-manager.ts` 文件
  - 实现 `isRetryable(error: Error): boolean` 方法
  - 实现 `executeWithRetry<T>(subTask: SubTask, executor: () => Promise<T>, maxRetries: number): Promise<T>` 方法
  - 实现 `logFailure(subTask: SubTask, error: Error, sessionId: string): Promise<void>` 方法
  - 实现 `getFailureLogs(sessionId: string): Promise<FailureLog[]>` 方法
  - _需求: 12.1, 12.2, 12.3, 12.4, 12.5_

- [ ] 10.2 实现可重试错误识别
  - 识别网络超时、网络连接失败、LLM 请求限流等可重试错误
  - 识别代码错误、文件不存在等不可重试错误
  - _需求: 12.2, 12.3_

- [ ] 10.3 实现重试策略
  - 使用指数退避（1s, 2s, 4s）
  - 最多重试 3 次
  - 记录每次重试的日志
  - _需求: 12.2, 12.4_

- [ ] 10.4 实现失败日志记录
  - 保存到 `.clawdbot/tasks/{sessionId}/failures.log`
  - 包含时间戳、子任务 ID、错误信息、堆栈跟踪、重试次数
  - _需求: 12.5_

### 11. 错误处理实现

- [ ] 11.1 实现 ErrorHandler 接口
  - 创建 `src/agents/intelligent-task-decomposition/error-handler.ts` 文件
  - 实现 `handleError(error: Error, context: Record<string, unknown>, sessionId: string): Promise<void>` 方法
  - 实现 `logError(errorType: ErrorLog["errorType"], error: Error, context: Record<string, unknown>, sessionId: string): Promise<void>` 方法
  - 实现 `getErrorLogs(sessionId: string): Promise<ErrorLog[]>` 方法
  - 实现 `tryRecover(error: Error, context: Record<string, unknown>): Promise<boolean>` 方法
  - _需求: 13.1, 13.2, 13.3, 13.4, 13.5_

- [ ] 11.2 实现错误分类
  - 分类 LLM 请求失败、文件系统操作失败、内存不足、系统崩溃等错误
  - 针对不同错误类型采取不同的处理策略
  - _需求: 13.1, 13.2, 13.3, 13.4_

- [ ] 11.3 实现错误日志记录
  - 保存到 `.clawdbot/tasks/{sessionId}/errors.log`
  - 包含时间戳、错误类型、错误信息、堆栈跟踪、上下文信息
  - _需求: 13.5_

- [ ] 11.4 实现错误恢复策略
  - LLM 请求失败：重试
  - 文件系统操作失败：备份到临时位置
  - 内存不足：释放资源
  - 系统崩溃：从检查点恢复
  - _需求: 13.1, 13.2, 13.3, 13.4_

### 12. 断点恢复实现

- [ ] 12.1 实现 RecoveryManager 接口
  - 创建 `src/agents/intelligent-task-decomposition/recovery-manager.ts` 文件
  - 实现 `hasUnfinishedTasks(sessionId: string): Promise<boolean>` 方法
  - 实现 `recoverUnfinishedTasks(sessionId: string): Promise<TaskTree>` 方法
  - 实现 `identifyInterruptedTasks(taskTree: TaskTree): SubTask[]` 方法
  - 实现 `reexecuteInterruptedTasks(taskTree: TaskTree, interruptedTasks: SubTask[]): Promise<void>` 方法
  - _需求: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ] 12.2 实现未完成任务检测
  - 检查任务树文件是否存在
  - 检查是否有状态为 "pending"、"active" 或 "interrupted" 的任务
  - _需求: 11.1, 11.2_

- [ ] 12.3 实现恢复流程
  - 从磁盘加载任务树
  - 识别未完成的任务
  - 将 "active" 状态的任务标记为 "interrupted"
  - 从最近的检查点恢复
  - 继续执行未完成的任务
  - _需求: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ] 12.4 实现中断任务处理
  - 将 "interrupted" 状态的任务重新标记为 "pending"
  - 重新执行这些任务
  - 记录恢复日志
  - _需求: 11.3, 11.4_

### 13. 与现有系统深度集成

- [ ] 13.1 集成 `enqueue_task` 工具
  - 确保 QueueExecutor 正确调用 `src/agents/tools/enqueue-task-tool.ts` 中的 `enqueue_task`
  - 确保使用 `followup` 模式
  - 确保不去重（`dedupeMode: "none"`）
  - _需求: 15.1_

- [ ] 13.2 集成全局上下文管理
  - 确保 Loop Detector 正确使用 `src/auto-reply/reply/agent-runner.ts` 中的全局上下文管理
  - 确保在 `enqueue_task` 工具中检测循环
  - _需求: 15.2_

- [ ] 13.3 集成队列执行逻辑
  - 确保 QueueExecutor 正确使用 `src/auto-reply/reply/followup-runner.ts` 中的队列执行逻辑
  - 确保队列自动排空
  - _需求: 15.3_

- [ ] 13.4 集成任务看板机制
  - 确保 TaskTreeManager 与 `src/agents/task-board/` 中的任务看板机制兼容
  - 确保任务树和任务看板可以互相转换
  - _需求: 15.4_

- [ ] 13.5 验证不破坏现有功能
  - 运行现有的连续任务测试
  - 确保现有功能正常工作
  - _需求: 15.5_

### 14. 检查点 - 确保所有核心功能正常工作

确保所有测试通过，如有问题请向用户报告。

### 15. 文档和示例

- [ ] 15.1 编写用户文档
  - 创建 `docs/intelligent-task-decomposition.md` 文件
  - 说明如何启用智能任务分解
  - 说明如何使用不同的任务类型
  - 说明如何处理循环检测和 Hook 防护
  - 说明如何查看任务树和恢复任务
  - 说明如何处理任务失败和重试
  - _需求: 所有需求_

- [ ] 15.2 编写开发者文档
  - 创建 `docs/dev/intelligent-task-decomposition-architecture.md` 文件
  - 说明架构设计和组件职责
  - 说明如何扩展任务分解策略
  - 说明如何与现有系统集成
  - 说明任务树持久化和恢复机制
  - 说明重试机制和错误处理
  - _需求: 所有需求_

- [ ] 15.3 创建示例和教程
  - 创建 `examples/intelligent-task-decomposition/` 目录
  - 提供生成大量内容的示例
  - 提供总结大量内容的示例
  - 提供分析复杂项目的示例
  - 提供并行处理多个文件的示例
  - 提供任务恢复的示例
  - 提供任务失败重试的示例
  - _需求: 9.1, 9.2, 9.3, 9.4, 11.1, 12.1_

- [ ] 15.4 编写故障排查指南
  - 创建 `docs/troubleshooting/intelligent-task-decomposition.md` 文件
  - 说明常见错误和解决方案
  - 说明如何查看任务树和日志
  - 说明如何手动恢复任务
  - 说明如何处理系统崩溃
  - _需求: 11.1, 12.1, 13.1, 13.2, 13.3, 13.4, 13.5_

### 16. 最终检查点 - 确保所有测试通过

确保所有测试通过，如有问题请向用户报告。

## 注意事项

- 任务标记 `*` 的为可选测试任务，可以根据项目进度决定是否实现
- 每个任务都引用了相关的需求编号，便于追溯
- 属性测试应该运行至少 100 次迭代以确保覆盖足够的输入空间
- 所有与现有系统的集成都应该复用现有机制，不要重复实现
- 所有循环检测和 Hook 防护都应该使用现有的机制
- 所有队列管理都应该使用现有的 `enqueue_task` 工具
- 如果现有的 `enqueue_task` 工具不够好用也可以继续优化现有的 `enqueue_task` 工具
- 确保不破坏现有的连续任务功能
- **所有持久化操作都应该使用原子写入确保数据一致性**
- **所有错误都应该被捕获并记录日志**
- **所有任务状态变化都应该实时保存到磁盘**
- **系统崩溃后应该能够自动恢复任务**
- **任务失败后应该能够自动重试（如果是临时性错误）**


