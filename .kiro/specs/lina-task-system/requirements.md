# 需求文档：栗娜主代理任务系统

## 引言

栗娜主代理任务系统（Lina Task System）是为 Clawdbot 的管家层（Butler Agent）设计的任务管理和执行能力。该系统使栗娜能够理解和执行 .kiro/specs/ 目录下的规范文档，类似于 Kiro 的 spec 工作流，但集成到 Clawdbot 的多层 Agent 架构中。

该系统的核心目标是让栗娜能够：
- 读取和理解 Spec 文档（requirements.md, design.md, tasks.md）
- 解析和执行任务列表
- 跟踪任务进度并更新状态
- 与现有的任务分解和记忆系统集成

## 术语表

- **栗娜（Lina）**：Clawdbot 的管家层 Agent，负责任务管理和协调
- **Spec 文档**：规范文档，包括 requirements.md（需求）、design.md（设计）、tasks.md（任务列表）
- **任务系统（Task System）**：栗娜用于管理和执行 Spec 任务的子系统
- **TaskBoard**：现有的任务看板系统，用于任务分解和跟踪
- **TaskDelegator**：任务委托器，负责将复杂任务分解并委托给执行层
- **MemoryService**：记忆服务，用于存储和检索任务执行经验
- **必需任务（Required Task）**：tasks.md 中未标记为可选的任务，必须执行
- **可选任务（Optional Task）**：tasks.md 中标记为 "*" 的任务，可以跳过

## 需求

### 需求 1：Spec 文档读取和解析

**用户故事：** 作为栗娜，我想读取和解析 .kiro/specs/ 目录下的 Spec 文档，以便理解任务的需求、设计和执行计划。

#### 验收标准

1. WHEN 用户请求执行某个 Spec 时，THE 栗娜 SHALL 定位到 .kiro/specs/{spec-name}/ 目录
2. WHEN 栗娜读取 requirements.md 时，THE 栗娜 SHALL 提取需求列表和验收标准
3. WHEN 栗娜读取 design.md 时，THE 栗娜 SHALL 提取设计概述、架构和正确性属性
4. WHEN 栗娜读取 tasks.md 时，THE 栗娜 SHALL 解析任务列表、任务编号、任务状态和任务依赖关系
5. IF Spec 目录不存在或文档缺失，THEN THE 栗娜 SHALL 返回清晰的错误信息

### 需求 2：任务列表解析

**用户故事：** 作为栗娜，我想解析 tasks.md 中的任务列表，以便识别任务的结构、状态和依赖关系。

#### 验收标准

1. WHEN 栗娜解析 tasks.md 时，THE 栗娜 SHALL 识别 Markdown checkbox 语法（`- [ ]`, `- [x]`, `- [-]`）
2. WHEN 栗娜解析任务时，THE 栗娜 SHALL 提取任务编号（如 1.1, 2.3）、任务描述和任务状态
3. WHEN 栗娜解析任务时，THE 栗娜 SHALL 识别可选任务标记（任务描述末尾的 "*"）
4. WHEN 栗娜解析任务时，THE 栗娜 SHALL 识别任务层级（顶层任务和子任务）
5. WHEN 栗娜解析任务时，THE 栗娜 SHALL 提取任务的需求引用（如 _Requirements: X.Y_）

### 需求 3：任务执行模式

**用户故事：** 作为用户，我想让栗娜支持不同的任务执行模式，以便灵活地执行任务。

#### 验收标准

1. WHEN 用户请求"运行所有任务"时，THE 栗娜 SHALL 按顺序执行所有未完成的必需任务
2. WHEN 用户请求"运行单个任务"时，THE 栗娜 SHALL 执行指定编号的任务
3. WHEN 栗娜执行任务时，THE 栗娜 SHALL 跳过已完成的任务（状态为 `[x]`）
4. WHEN 栗娜执行任务时，THE 栗娜 SHALL 跳过可选任务（除非用户明确要求执行）
5. WHEN 栗娜遇到正在进行的任务（状态为 `[-]`）时，THE 栗娜 SHALL 询问用户是继续还是重新开始

### 需求 4：任务状态管理

**用户故事：** 作为栗娜，我想管理任务的状态，以便跟踪任务进度并更新 tasks.md 文件。

#### 验收标准

1. WHEN 栗娜开始执行任务时，THE 栗娜 SHALL 将任务状态更新为 `in_progress`（`[-]`）
2. WHEN 栗娜完成任务时，THE 栗娜 SHALL 将任务状态更新为 `completed`（`[x]`）
3. WHEN 栗娜更新任务状态时，THE 栗娜 SHALL 修改 tasks.md 文件中的 checkbox 标记
4. WHEN 栗娜更新任务状态时，THE 栗娜 SHALL 保持 tasks.md 文件的格式和结构不变
5. WHEN 栗娜更新任务状态时，THE 栗娜 SHALL 验证文件确实被修改（使用独立验证）

### 需求 5：任务分解和委托

**用户故事：** 作为栗娜，我想判断任务是否需要分解，以便简单任务直接执行，复杂任务委托给任务调度层。

#### 验收标准

1. WHEN 栗娜评估任务复杂度时，THE 栗娜 SHALL 根据任务描述、需求引用和设计文档判断复杂度
2. WHEN 任务是简单任务（如"创建文件"、"修改配置"）时，THE 栗娜 SHALL 直接执行
3. WHEN 任务是复杂任务（如"实现完整模块"、"集成多个系统"）时，THE 栗娜 SHALL 委托给 TaskDelegator
4. WHEN 栗娜委托任务时，THE 栗娜 SHALL 传递任务描述、需求引用和相关设计文档
5. WHEN 栗娜委托任务时，THE 栗娜 SHALL 等待任务完成并接收执行结果

### 需求 6：任务失败处理

**用户故事：** 作为栗娜，我想处理任务失败的情况，以便提供清晰的错误信息并支持重试。

#### 验收标准

1. WHEN 任务执行失败时，THE 栗娜 SHALL 记录失败原因和错误信息
2. WHEN 任务执行失败时，THE 栗娜 SHALL 询问用户是重试、跳过还是停止
3. WHEN 用户选择重试时，THE 栗娜 SHALL 重新执行失败的任务
4. WHEN 用户选择跳过时，THE 栗娜 SHALL 继续执行下一个任务
5. WHEN 用户选择停止时，THE 栗娜 SHALL 停止任务执行并生成进度报告

### 需求 7：任务执行报告

**用户故事：** 作为用户，我想在任务执行完成后看到执行报告，以便了解任务的执行情况。

#### 验收标准

1. WHEN 栗娜完成任务执行时，THE 栗娜 SHALL 生成任务执行报告
2. WHEN 栗娜生成报告时，THE 栗娜 SHALL 包含已完成任务数量、失败任务数量和跳过任务数量
3. WHEN 栗娜生成报告时，THE 栗娜 SHALL 列出每个任务的执行结果（成功、失败、跳过）
4. WHEN 栗娜生成报告时，THE 栗娜 SHALL 包含失败任务的错误信息
5. WHEN 栗娜生成报告时，THE 栗娜 SHALL 提供下一步建议（如重试失败任务、执行可选任务）

### 需求 8：记忆系统集成

**用户故事：** 作为栗娜，我想将任务执行经验存储到记忆系统，以便未来执行类似任务时参考。

#### 验收标准

1. WHEN 栗娜完成任务时，THE 栗娜 SHALL 将任务执行经验归档到记忆系统
2. WHEN 栗娜归档经验时，THE 栗娜 SHALL 包含任务描述、执行步骤、遇到的问题和解决方案
3. WHEN 栗娜开始执行任务时，THE 栗娜 SHALL 从记忆系统检索相关经验
4. WHEN 栗娜检索到相关经验时，THE 栗娜 SHALL 参考经验中的执行步骤和解决方案
5. WHEN 栗娜检索不到相关经验时，THE 栗娜 SHALL 正常执行任务并归档新经验

### 需求 9：与现有系统集成

**用户故事：** 作为开发者，我想让栗娜任务系统与现有的多层架构和任务分解系统集成，以便复用现有能力。

#### 验收标准

1. WHEN 栗娜执行任务时，THE 栗娜 SHALL 使用现有的 ButlerAgent 接口
2. WHEN 栗娜委托任务时，THE 栗娜 SHALL 使用现有的 TaskDelegator 接口
3. WHEN 栗娜跟踪任务时，THE 栗娜 SHALL 使用现有的 TaskBoard 系统
4. WHEN 栗娜存储经验时，THE 栗娜 SHALL 使用现有的 MemoryService 接口
5. WHEN 栗娜执行工具调用时，THE 栗娜 SHALL 使用现有的工具系统（bash-tools, pi-tools）

### 需求 10：用户交互

**用户故事：** 作为用户，我想通过自然语言与栗娜交互，以便方便地请求任务执行。

#### 验收标准

1. WHEN 用户说"执行 {spec-name} 的所有任务"时，THE 栗娜 SHALL 理解为运行所有任务模式
2. WHEN 用户说"执行 {spec-name} 的任务 {task-id}"时，THE 栗娜 SHALL 理解为运行单个任务模式
3. WHEN 用户说"继续执行 {spec-name}"时，THE 栗娜 SHALL 从上次中断的地方继续执行
4. WHEN 用户说"查看 {spec-name} 的进度"时，THE 栗娜 SHALL 显示任务执行进度
5. WHEN 栗娜需要用户决策时，THE 栗娜 SHALL 提供清晰的选项和建议
