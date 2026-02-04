# 需求文档：智能任务分解与队列执行系统

## 介绍

本文档定义了 Clawdbot 的智能任务分解与队列执行系统的需求。该系统旨在让 LLM 能够自动识别大型任务、智能分解任务、自动执行队列，并根据完成情况动态调整任务。

该系统将融合现有的连续任务机制（`enqueue_task` 工具）、循环检测机制、Hook 副作用检测和队列管理机制，确保与现有系统的兼容性。

## 术语表

- **LLM**：大型语言模型，负责理解用户任务、分解任务、检查完成情况
- **Task_Queue**：任务队列，存储待执行的任务
- **Queue_Executor**：队列执行器，负责自动排空队列并执行所有任务
- **Continuous_Task**：连续任务，指需要顺序执行的一系列任务
- **Loop_Detector**：循环检测器，负责检测并防止无限循环
- **Hook_Guard**：Hook 守卫，负责检测并防止 Hook 副作用
- **System_Prompt**：系统提示词，用于引导 LLM 的行为

## 需求

### 需求 1：LLM 驱动的任务识别

**用户故事**：作为用户，我希望 LLM 能通过分析任务内容自动识别需要分解的大型任务，这样我就不需要手动拆分任务。

#### 验收标准

1. WHEN 用户提交一个任务 THEN LLM SHALL 通过系统提示词引导分析任务的复杂度和规模
2. WHEN LLM 判断任务需要分解 THEN LLM SHALL 主动调用 `enqueue_task` 工具创建子任务
3. WHEN LLM 判断任务不需要分解 THEN LLM SHALL 直接执行任务
4. WHEN LLM 不确定是否需要分解 THEN LLM SHALL 向用户询问并根据用户反馈决定
5. WHEN LLM 识别为大型任务 THEN LLM SHALL 向用户展示分解计划并询问是否继续

### 需求 2：LLM 驱动的任务分解

**用户故事**：作为用户，我希望 LLM 能智能地将大型任务分解成合理的子任务，这样我就能清楚地知道系统会做哪些事情。

#### 验收标准

1. WHEN 用户确认需要分解任务 THEN LLM SHALL 通过系统提示词引导分析任务类型并生成分解计划
2. WHEN LLM 决定分解任务 THEN LLM SHALL 调用 `enqueue_task` 工具创建每个子任务
3. WHEN LLM 创建子任务 THEN LLM SHALL 为每个子任务提供清晰的 prompt 和 summary
4. WHEN LLM 创建子任务 THEN LLM SHALL 确保子任务之间的逻辑关系清晰
5. WHEN LLM 完成分解 THEN LLM SHALL 向用户展示完整的任务列表并询问是否继续

### 需求 3：自动执行队列

**用户故事**：作为用户，我希望系统能自动执行队列中的所有任务，这样我就不需要手动触发每个任务。

#### 验收标准

1. WHEN LLM 调用 `enqueue_task` 创建子任务 THEN System SHALL 将子任务加入队列
2. WHEN 队列中有待执行的任务 THEN System SHALL 自动排空队列并执行所有任务
3. WHEN 执行队列任务 THEN System SHALL 按照 LLM 创建的顺序执行
4. WHEN 队列任务执行完成 THEN System SHALL 自动执行下一个任务
5. WHEN 所有队列任务完成 THEN System SHALL 通知用户所有任务已完成

### 需求 4：LLM 驱动的自我检查与动态调整

**用户故事**：作为用户，我希望 LLM 能根据完成情况自动检查并调整任务，这样我就能确保任务按预期完成。

#### 验收标准

1. WHEN 子任务完成 THEN LLM SHALL 通过系统提示词引导检查任务完成情况并验证产出
2. WHEN LLM 判断任务完成情况不符合预期 THEN LLM SHALL 调用 `enqueue_task` 生成补充任务
3. WHEN LLM 判断任务完成情况超出预期 THEN LLM SHALL 跳过后续不必要的任务
4. WHEN 所有任务完成 THEN LLM SHALL 生成最终总结并询问用户是否满意
5. WHEN 用户不满意 THEN LLM SHALL 根据用户反馈调用 `enqueue_task` 生成新的任务

### 需求 5：循环检测与防护

**用户故事**：作为用户，我希望系统能检测并防止无限循环，这样我就不会因为 LLM 错误而导致系统卡死。

#### 验收标准

1. WHEN LLM 在执行队列任务时调用 `enqueue_task` THEN Loop_Detector SHALL 检测到循环并拒绝操作
2. WHEN LLM 重复调用相同的工具 THEN Loop_Detector SHALL 检测到循环并警告用户
3. WHEN 队列深度超过阈值（如 50 个任务）THEN Loop_Detector SHALL 暂停队列执行并请求用户确认
4. WHEN 检测到循环 THEN System SHALL 向 LLM 返回明确的错误信息和正确做法
5. WHEN 循环被阻止 THEN System SHALL 记录循环检测日志供调试

### 需求 6：Hook 副作用防护

**用户故事**：作为用户，我希望系统能防止 Hook 修改队列任务的 prompt，这样我就能确保任务按预期执行。

#### 验收标准

1. WHEN Hook 在 `before_agent_start` 中修改 prompt THEN Hook_Guard SHALL 检测消息类型
2. WHEN 消息是队列任务 THEN Hook_Guard SHALL 跳过 Hook 修改
3. WHEN 消息是原始用户消息在队列中 THEN Hook_Guard SHALL 跳过 Hook 修改
4. WHEN 消息是用户直接发送的消息 THEN Hook_Guard SHALL 允许 Hook 修改
5. WHEN Hook 被跳过 THEN System SHALL 记录跳过日志供调试

### 需求 7：队列状态管理

**用户故事**：作为用户，我希望系统能正确管理队列状态，这样我就能避免重复加入任务或任务顺序错误。

#### 验收标准

1. WHEN LLM 调用 `enqueue_task` 创建队列任务 THEN System SHALL 检查队列深度
2. WHEN 队列中已经有任务 THEN System SHALL 不再自动加入用户消息
3. WHEN 队列中没有任务 THEN System SHALL 允许自动加入用户消息（如果配置允许）
4. WHEN 队列任务执行完成 THEN System SHALL 从队列中移除该任务
5. WHEN 队列为空 THEN System SHALL 通知用户所有任务已完成

### 需求 8：系统提示词引导

**用户故事**：作为开发者，我希望通过系统提示词引导 LLM 的行为，这样我就能确保 LLM 正确识别和分解任务。

#### 验收标准

1. WHEN LLM 收到用户任务 THEN System SHALL 通过系统提示词引导 LLM 分析任务复杂度
2. WHEN LLM 需要分解任务 THEN System SHALL 通过系统提示词引导 LLM 使用 `enqueue_task` 工具
3. WHEN LLM 创建子任务 THEN System SHALL 通过系统提示词引导 LLM 提供清晰的 prompt 和 summary
4. WHEN LLM 检查任务完成情况 THEN System SHALL 通过系统提示词引导 LLM 验证产出质量
5. WHEN LLM 需要调整任务 THEN System SHALL 通过系统提示词引导 LLM 生成补充任务或跳过任务

### 需求 9：用户场景支持

**用户故事**：作为用户，我希望 LLM 能支持常见的用户场景，这样我就能快速完成任务。

#### 验收标准

1. WHEN 用户要求生成大量内容（如 10000 字剧情）THEN LLM SHALL 通过系统提示词引导分解成多个子任务
2. WHEN 用户要求总结大量内容（如 100 万字电子书）THEN LLM SHALL 通过系统提示词引导分解成读取、总结、检查、补充等任务
3. WHEN 用户要求分析复杂项目 THEN LLM SHALL 通过系统提示词引导分解成多个分析任务
4. WHEN 用户要求并行处理多个文件 THEN LLM SHALL 通过系统提示词引导为每个文件创建任务
5. WHEN 用户要求执行多步骤流程 THEN LLM SHALL 通过系统提示词引导识别步骤并创建任务

### 需求 10：基础设施支持

**用户故事**：作为开发者，我希望系统提供必要的基础设施，这样 LLM 就能正确使用 `enqueue_task` 工具。

#### 验收标准

1. WHEN LLM 调用 `enqueue_task` THEN System SHALL 将任务加入队列并返回任务 ID
2. WHEN 队列中有任务 THEN System SHALL 自动排空队列并执行所有任务
3. WHEN 队列任务执行 THEN System SHALL 使用任务的 prompt 作为 LLM 输入
4. WHEN 队列任务完成 THEN System SHALL 记录任务状态和产出
5. WHEN 所有队列任务完成 THEN System SHALL 通知 LLM 所有任务已完成

### 需求 10：任务树持久化与管理

**用户故事**：作为用户，我希望系统能将任务树保存到磁盘，这样我就能在系统崩溃后恢复任务。

#### 验收标准

1. WHEN LLM 分解任务 THEN System SHALL 创建任务树并保存到磁盘（`.clawdbot/tasks/{sessionId}/TASK_TREE.json`）
2. WHEN 任务树保存 THEN System SHALL 同时生成 Markdown 格式（`.clawdbot/tasks/{sessionId}/TASK_TREE.md`）
3. WHEN 任务树保存 THEN System SHALL 使用原子写入确保数据一致性
4. WHEN 任务树保存 THEN System SHALL 创建备份文件（`.clawdbot/tasks/{sessionId}/TASK_TREE.json.bak`）
5. WHEN 主文件损坏 THEN System SHALL 从备份文件恢复

### 需求 11：断点恢复

**用户故事**：作为用户，我希望系统能在崩溃后自动恢复未完成的任务，这样我就不需要重新开始。

#### 验收标准

1. WHEN 系统启动 THEN System SHALL 检查是否有未完成的任务
2. WHEN 有未完成的任务 THEN System SHALL 询问用户是否继续
3. WHEN 用户确认继续 THEN System SHALL 从最近的检查点恢复任务树
4. WHEN 恢复任务树 THEN System SHALL 识别中断的任务（状态为 "active"）
5. WHEN 识别中断的任务 THEN System SHALL 重新执行这些任务

### 需求 12：重试机制

**用户故事**：作为用户，我希望系统能自动重试临时性错误，这样我就不需要手动重试。

#### 验收标准

1. WHEN 任务执行失败 THEN System SHALL 判断错误是否可重试
2. WHEN 错误可重试（网络超时、LLM 限流等）THEN System SHALL 使用指数退避重试（1s, 2s, 4s）
3. WHEN 错误不可重试（代码错误、文件不存在等）THEN System SHALL 立即失败并记录日志
4. WHEN 重试 THEN System SHALL 记录每次重试的日志
5. WHEN 重试次数超过 3 次 THEN System SHALL 失败并记录日志

### 需求 13：错误处理

**用户故事**：作为用户，我希望系统能正确处理各种错误，这样我就能知道发生了什么。

#### 验收标准

1. WHEN LLM 请求失败 THEN System SHALL 重试（如果是临时性错误）
2. WHEN 文件系统操作失败 THEN System SHALL 备份到临时位置
3. WHEN 内存不足 THEN System SHALL 释放资源
4. WHEN 系统崩溃 THEN System SHALL 从检查点恢复
5. WHEN 错误发生 THEN System SHALL 记录错误日志（`.clawdbot/tasks/{sessionId}/errors.log`）

### 需求 14：检查点管理

**用户故事**：作为用户，我希望系统能定期创建检查点，这样我就能在出错时回滚到之前的状态。

#### 验收标准

1. WHEN 任务状态变化 THEN System SHALL 创建检查点
2. WHEN 创建检查点 THEN System SHALL 保存当前任务树到 `.clawdbot/tasks/{sessionId}/checkpoints/{checkpointId}.json`
3. WHEN 检查点数量超过 10 THEN System SHALL 删除最旧的检查点
4. WHEN 需要恢复 THEN System SHALL 从最近的检查点恢复
5. WHEN 恢复失败 THEN System SHALL 尝试从更早的检查点恢复

### 需求 15：与现有系统深度集成

**用户故事**：作为开发者，我希望新系统能与现有系统深度集成，这样我就不需要重写现有代码。

#### 验收标准

1. WHEN 新系统启用 THEN System SHALL 复用 `src/agents/tools/enqueue-task-tool.ts` 中的 `enqueue_task` 工具
2. WHEN 新系统启用 THEN System SHALL 复用 `src/auto-reply/reply/agent-runner.ts` 中的全局上下文管理
3. WHEN 新系统启用 THEN System SHALL 复用 `src/auto-reply/reply/followup-runner.ts` 中的队列执行逻辑
4. WHEN 新系统启用 THEN System SHALL 复用循环检测机制（`.kiro/lessons-learned/82_LLM工具调用循环检测模式.md`）
5. WHEN 新系统启用 THEN System SHALL 复用 Hook 副作用检测机制（`.kiro/lessons-learned/83_Hook副作用检测模式.md`）
6. WHEN 新系统启用 THEN System SHALL 不破坏现有的连续任务功能

