# 需求文档：AI 自主质量驱动的递归任务系统

## 简介

AI 自主质量驱动的递归任务系统是 Clawdbot 现有任务系统的增强版本，在现有的任务看板（Task Board）、任务树管理器（Task Tree Manager）、重试管理器（Retry Manager）和连续任务机制（enqueue_task）的基础上，增加递归分解、动态调整、**AI 自主质量评估**和失败学习能力。

**核心原则**：
1. **AI 完全自主**：所有决策由 AI 自己完成，无需人工审核
2. **质量驱动**：以质量为核心，不满意就重来
3. **失败是学习的机会**：失败结果作为经验输入新任务树

本系统将完全复用现有代码，不重复造轮子，确保与现有系统的深度融合。

## 术语表

- **System（系统）**: AI 自主质量驱动的递归任务系统
- **Task_Board（任务看板）**: 现有的任务看板系统（`src/agents/task-board/`）
- **Task_Tree（任务树）**: 现有的任务树结构（`src/agents/intelligent-task-decomposition/`）
- **enqueue_task（入队工具）**: 现有的连续任务工具（`src/agents/tools/enqueue-task-tool.ts`）
- **Orchestrator（编排器）**: 现有的任务编排器（`src/agents/task-board/orchestrator.ts`）
- **Decomposer（分解器）**: 现有的任务分解器（`src/agents/task-board/decomposer-llm.ts`）
- **Executor（执行器）**: 现有的任务执行器（`src/agents/task-board/executor.ts`）
- **Recursive_Decomposition（递归分解）**: 新增能力 - 分解过程本身也可以被分解
- **Dynamic_Decomposition（动态分解）**: 新增能力 - 执行时发现任务复杂而触发的分解
- **Quality_Review（质量评估）**: 新增能力 - AI 自主评估任务质量
- **Self_Improvement（自我改进）**: 现有能力 - 从失败中学习（`src/agents/task-board/self-improvement.ts`）
- **Restart（重启）**: 新增能力 - 保留当前结果作为经验，重新分解任务
- **Overthrow（推翻）**: 新增能力 - 完全推翻当前方案，从头开始

## 需求

### 需求 1：增强现有的复杂度分析（基于 Task Board Decomposer）

**用户故事：** 作为 AI，我希望能够更智能地判断任务的复杂度，包括判断"分解任务本身是否复杂"。

#### 验收标准

1. WHEN 系统接收到任务 THEN 系统 SHALL 复用 `TaskDecomposer.shouldDecompose()` 分析任务复杂度
2. WHEN 任务被判定为简单任务 THEN 系统 SHALL 直接执行任务并返回结果
3. WHEN 任务被判定为复杂任务 THEN 系统 SHALL 启动任务分解流程
4. WHEN 分解任务本身很复杂（如"写100万字小说"需要上百次规划）THEN 系统 SHALL 将分解过程作为一个任务进行分解
5. THE 系统 SHALL 提供复杂度判断的理由和依据

### 需求 2：递归任务分解（增强 LLM Decomposer）

**用户故事：** 作为 AI，我希望能够递归地分解任务，以便处理"分解任务本身就很复杂"的情况。

#### 验收标准

1. WHEN 系统需要分解一个复杂任务 THEN 系统 SHALL 复用 `LLMTaskDecomposer.decompose()` 进行分解
2. WHEN 分解过程本身很复杂（如需要生成超过 8 个子任务）THEN 系统 SHALL 将分解过程作为一个任务进行分解
3. THE 系统 SHALL 支持无限深度的递归分解
4. THE 系统 SHALL 维护分解任务的任务树结构（复用 `TaskTreeManager`）
5. WHEN 分解完成 THEN 系统 SHALL 生成完整的子任务列表

### 需求 3：动态任务分解（增强 Executor）

**用户故事：** 作为 AI，我希望在执行任务时能够动态判断是否需要进一步分解，以便灵活应对任务复杂度的变化。

#### 验收标准

1. WHEN 系统执行某个子任务（通过 `TaskExecutor.execute()`）THEN 系统 SHALL 评估该任务的实际复杂度
2. WHEN 执行过程中发现任务仍然复杂 THEN 系统 SHALL 暂停执行并触发动态分解
3. WHEN 动态分解完成 THEN 系统 SHALL 用新的子任务替换原任务
4. THE 系统 SHALL 保持任务树的一致性（通过 `TaskTreeManager`）
5. THE 系统 SHALL 记录动态分解的原因和过程

### 需求 4：AI 自主质量评估机制（新增能力）

**用户故事：** 作为 AI，我希望能够自主评估任务分解和执行的质量，以便确保任务质量。

#### 验收标准

1. WHEN 初始任务分解完成 THEN 系统 SHALL 自主评估分解的合理性
2. WHEN 每个子任务执行完成 THEN 系统 SHALL 自主评估完成质量
3. WHEN 所有子任务完成 THEN 系统 SHALL 自主评估整体质量
4. WHEN 质量评估不通过 THEN 系统 SHALL 生成改进方案
5. THE 系统 SHALL 记录质量评估的标准、过程和结果

### 需求 5：AI 自主调整机制（新增能力）

**用户故事：** 作为 AI，我希望能够根据质量评估结果自主调整任务树，以便提高任务质量。

#### 验收标准

1. WHEN 质量评估发现问题 THEN 系统 SHALL 自主生成调整方案
2. WHEN 调整方案生成 THEN 系统 SHALL 自主应用调整
3. WHEN 调整应用完成 THEN 系统 SHALL 重新评估质量
4. THE 系统 SHALL 支持多种调整类型（添加、删除、修改、合并、拆分子任务）
5. THE 系统 SHALL 记录调整的原因、方案和结果

### 需求 6：重启机制（新增能力）

**用户故事：** 作为 AI，我希望在质量不满意时能够重启任务，以便从失败中学习并改进。

#### 验收标准

1. WHEN 质量评估严重不通过 THEN 系统 SHALL 决定是否需要重启
2. WHEN 决定重启 THEN 系统 SHALL 保留当前结果作为失败经验
3. WHEN 重启任务 THEN 系统 SHALL 将失败经验作为上下文输入新任务树
4. THE 系统 SHALL 记录重启的原因和失败经验
5. THE 系统 SHALL 支持配置最大重启次数（默认 2 次）

### 需求 7：推翻机制（新增能力）

**用户故事：** 作为 AI，我希望在发现根本性错误时能够完全推翻当前方案，以便从头开始设计。

#### 验收标准

1. WHEN 质量评估发现根本性错误 THEN 系统 SHALL 决定是否需要推翻
2. WHEN 决定推翻 THEN 系统 SHALL 完全丢弃当前任务树
3. WHEN 推翻任务 THEN 系统 SHALL 从头开始重新分解任务
4. THE 系统 SHALL 记录推翻的原因和根本性错误
5. THE 系统 SHALL 支持配置最大推翻次数（默认 1 次）

### 需求 8：失败学习机制（增强 Self Improvement Engine）

**用户故事：** 作为 AI，我希望能够从失败中学习，以便不断优化执行策略。

#### 验收标准

1. WHEN 任务失败 THEN 系统 SHALL 复用 `RetryManager.logFailure()` 记录失败模式
2. THE 系统 SHALL 复用 `SelfImprovementEngine.identifyReusablePatterns()` 分析失败模式的共性
3. THE 系统 SHALL 生成优化建议
4. WHEN 重启或推翻任务 THEN 系统 SHALL 将失败经验作为上下文
5. THE 系统 SHALL 持久化失败经验和优化建议

### 需求 9：智能重试机制（复用 Retry Manager）

**用户故事：** 作为 AI，我希望能够从失败中学习并智能重试，以便提高任务成功率。

#### 验收标准

1. WHEN 子任务执行失败 THEN 系统 SHALL 复用 `FailureHandler.analyzeFailure()` 分析失败原因
2. WHEN 系统分析完失败原因 THEN 系统 SHALL 生成改进建议
3. WHEN 系统重试任务 THEN 系统 SHALL 复用 `RetryManager.executeWithRetry()` 参考失败原因和改进建议
4. THE 系统 SHALL 支持配置最大重试次数（默认 3 次）
5. WHEN 重试次数耗尽仍失败 THEN 系统 SHALL 记录失败原因并触发质量评估

### 需求 10：任务持久化（复用 Task Tree Manager）

**用户故事：** 作为 AI，我希望能够保存任务状态，以便在中断后能够恢复执行。

#### 验收标准

1. THE 系统 SHALL 复用 `TaskTreeManager.save()` 将任务树结构持久化到文件系统
2. THE 系统 SHALL 保存每个任务的状态、执行历史和失败原因
3. WHEN 任务状态变化 THEN 系统 SHALL 立即更新持久化文件
4. THE 系统 SHALL 使用结构化的文件格式（JSON）
5. THE 系统 SHALL 确保文件格式便于读取和写入

### 需求 11：任务恢复（复用 Task Tree Manager）

**用户故事：** 作为 AI，我希望能够从中断点恢复任务执行，以便处理长时间运行的任务。

#### 验收标准

1. WHEN 系统启动 THEN 系统 SHALL 复用 `TaskTreeManager.load()` 检查是否存在未完成的任务
2. WHEN 存在未完成的任务 THEN 系统 SHALL 加载任务树和任务状态
3. WHEN 任务恢复 THEN 系统 SHALL 从最后一个未完成的任务继续执行
4. THE 系统 SHALL 跳过已完成的任务
5. THE 系统 SHALL 保持任务执行的连续性

### 需求 12：任务树可视化（复用 Task Board Renderer）

**用户故事：** 作为用户，我希望能够查看任务树的结构和状态，以便了解任务执行进度。

#### 验收标准

1. THE 系统 SHALL 复用 `renderToMarkdown()` 提供任务树的文本可视化
2. THE 系统 SHALL 显示每个任务的状态（待执行、执行中、已完成、失败）
3. THE 系统 SHALL 显示任务的层级关系
4. THE 系统 SHALL 显示任务的执行进度
5. THE 系统 SHALL 支持查看任务的详细信息

### 需求 13：工具接口（复用现有工具）

**用户故事：** 作为 LLM，我希望有清晰的工具接口来操作任务系统，以便高效地管理任务。

#### 验收标准

1. THE 系统 SHALL 复用 `enqueue_task` 工具创建任务
2. THE 系统 SHALL 复用 `show_task_board` 工具查看任务树
3. THE 系统 SHALL 提供质量评估的工具接口（新增）
4. THE 系统 SHALL 提供动态分解任务的工具接口（新增）
5. THE 系统 SHALL 确保工具接口参数清晰、易用
