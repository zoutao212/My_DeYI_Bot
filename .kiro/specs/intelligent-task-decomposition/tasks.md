# 智能任务分解系统 - 任务列表

> **核心原则**：LLM 驱动，系统只提供工具和基础设施

---

## 📋 任务概览

本 spec 实现一个智能任务分解系统，让 LLM 能够主动将复杂任务分解为多个子任务，并通过队列机制自动执行。

**关键特性**：
- ✅ LLM 驱动：所有任务识别和分解都由 LLM 完成
- ✅ 复用现有机制：复用现有的队列管理和任务执行流程
- ✅ 循环检测：防止无限循环
- ✅ Hook 防护：防止副作用

---

## 阶段 1：系统提示词设计和实现

### 1.1 设计系统提示词内容

**目标**：设计清晰、简单、有效的系统提示词，引导 LLM 主动分解任务

**背景知识**：
- 系统提示词位置：`src/agents/system-prompt.ts`
- 构建函数：`buildAgentSystemPrompt`
- 设计原则：`.kiro/steering/system-prompt-design-principles.md`

- [x] 1.1.1 阅读现有系统提示词结构
  - 查看 `src/agents/system-prompt.ts` 中的 `buildAgentSystemPrompt` 函数
  - 理解现有的 section 结构（Identity、Tooling、Workspace 等）
  - 确定任务分解 section 的插入位置（Tooling 之后，Workspace 之前）

- [x] 1.1.2 设计任务分解引导内容（遵循设计原则）
  - 遵循"简单直接、负面规则、可选步骤、具体示例、短句子"的原则
  - 设计"什么时候需要分解任务？"部分（4 种场景）
  - 设计"如何分解任务？"部分（4 个步骤）
  - 设计示例部分（生成 10000 字小说的完整示例）
  - 设计重要规则部分（3 条规则）

- [x] 1.1.3 设计 enqueue_task 工具使用说明
  - 在 Tooling section 中添加 `enqueue_task` 工具的简短说明
  - 说明格式：`- enqueue_task: 将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。`

**验收标准**：
- ✅ 系统提示词内容清晰、简单、易懂
- ✅ 遵循系统提示词设计原则
- ✅ 提供了具体的示例和规则
- ✅ 不使用复杂的概念和条件判断


### 1.2 实现系统提示词注入

**目标**：将任务分解引导内容注入到系统提示词中

**关键文件**：
- `src/agents/system-prompt.ts` - 系统提示词构建逻辑
- `src/agents/system-prompt.l10n.zh.ts` - 中文翻译
- `src/agents/system-prompt.l10n.en.ts` - 英文翻译

- [x] 1.2.1 修改 `src/agents/system-prompt.ts`
  - 创建 `buildTaskDecompositionSection` 函数
  - 函数参数：`{ isMinimal: boolean; l10n: typeof SYSTEM_PROMPT_L10N_EN }`
  - 如果 `isMinimal` 为 true，返回空数组
  - 否则返回包含所有翻译字符串的数组
  - 在 `buildAgentSystemPrompt` 函数中调用此函数
  - 将返回的数组插入到 `lines` 数组中（Tooling 之后，Workspace 之前）

- [x] 1.2.2 添加中文翻译到 `src/agents/system-prompt.l10n.zh.ts`
  - 添加 `taskDecompositionTitle`：`"## 任务分解（可选）"`
  - 添加 `taskDecompositionIntro`：`"当你收到一个复杂的任务时，你可以将它分解成多个子任务。"`
  - 添加 `taskDecompositionWhenTitle`：`"### 什么时候需要分解任务？"`
  - 添加 4 条 `taskDecompositionWhenLine` 字符串
  - 添加 `taskDecompositionHowTitle`：`"### 如何分解任务？"`
  - 添加 4 条 `taskDecompositionHowLine` 字符串
  - 添加 `taskDecompositionExampleTitle`：`"### 示例"`
  - 添加 7 条 `taskDecompositionExample` 字符串（请求、分解、5 个步骤、回复）
  - 添加 `taskDecompositionRulesTitle`：`"### 重要规则"`
  - 添加 3 条 `taskDecompositionRulesLine` 字符串

- [x] 1.2.3 添加英文翻译到 `src/agents/system-prompt.l10n.en.ts`
  - 添加所有对应的英文翻译字符串
  - 确保翻译准确、清晰

- [ ] 1.2.4 验证注入效果（检查 trace 日志）
  - 运行 `pnpm build` 构建系统
  - 启动系统：`.\.A_Start-Clawdbot.cmd`
  - 在 UI 中发送测试消息："你好"
  - 检查 trace 日志中的 system prompt：
    ```powershell
    $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
    $payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
    $systemPrompt = $payloads[0].payload.payload.systemInstruction.parts[0].text
    $systemPrompt | Out-File "runtimelog/tempfile/system_prompt_check.txt" -Encoding UTF8
    ```
  - 验证系统提示词中包含"任务分解"相关内容

**验收标准**：
- ✅ 系统提示词中包含任务分解引导内容
- ✅ 中英文翻译完整
- ✅ trace 日志中可以看到完整的系统提示词
- ✅ 系统提示词格式正确，没有语法错误


### 1.3 验证 LLM 理解和行为

**目标**：验证 LLM 是否理解系统提示词，并能正确使用 `enqueue_task` 工具

- [ ] 1.3.1 测试场景 1：生成多段内容
  - 在 UI 中发送消息："请生成 3 段内容，每段 100 字"
  - 预期行为：
    - LLM 调用 `enqueue_task` 创建任务 2 和任务 3
    - LLM 回复第 1 段内容
    - 系统自动执行任务 2 和任务 3
  - 检查 trace 日志中的 `enqueue_task` 调用次数（预期：2 次）
  - 检查每个任务的 `prompt` 和 `summary` 是否清晰

- [ ] 1.3.2 测试场景 2：处理大量数据
  - 在 UI 中发送消息："请总结 docs/ 目录下的所有文档"
  - 预期行为：
    - LLM 读取文档列表
    - LLM 调用 `enqueue_task` 为每个文档创建总结任务
    - LLM 回复第一个文档的总结
    - 系统自动执行其他文档的总结任务
  - 检查工具调用顺序（read → enqueue_task × N → 回复）

- [ ] 1.3.3 测试场景 3：多步骤流程
  - 在 UI 中发送消息："请先读取 README.md，然后分析内容，最后生成报告"
  - 预期行为：
    - LLM 调用 `enqueue_task` 创建"分析内容"和"生成报告"任务
    - LLM 读取 README.md 并回复
    - 系统自动执行"分析内容"和"生成报告"任务
  - 检查任务执行顺序是否正确

- [ ] 1.3.4 检查 LLM 的 thinking
  - 查看 LLM 的 thinking（如果启用了 reasoning）
  - 验证 LLM 是否理解了任务分解的概念
  - 验证 LLM 是否按照系统提示词的引导进行分解

**验收标准**：
- ✅ LLM 能够识别需要分解的任务
- ✅ LLM 能够正确调用 `enqueue_task` 工具
- ✅ LLM 能够提供清晰的 `prompt` 和 `summary`
- ✅ 系统能够自动执行队列中的任务
- ✅ LLM 的 thinking 显示它理解了任务分解的概念

---

## 阶段 2：验证现有基础设施

### 2.1 验证 enqueue_task 工具

**目标**：确认 `enqueue_task` 工具已经实现并可以正常工作

**关键文件**：
- `src/agents/tools/enqueue-task-tool.ts` - 工具定义
- `src/agents/clawdbot-tools.ts` - 工具注册

- [ ] 2.1.1 检查工具定义
  - 查看 `src/agents/tools/enqueue-task-tool.ts` 中的 `createEnqueueTaskTool` 函数
  - 验证工具 schema 是否完整（`prompt` 和 `summary` 参数）
  - 验证工具 `execute` 函数是否正确实现

- [ ] 2.1.2 检查工具注册
  - 查看 `src/agents/clawdbot-tools.ts` 中的工具注册逻辑
  - 验证 `enqueue_task` 工具是否已注册
  - 验证工具在 `src/agents/pi-tools.ts` 中是否可见

- [ ] 2.1.3 检查工具调用（trace 日志验证）
  - 发送测试消息，触发 LLM 调用 `enqueue_task`
  - 检查 trace 日志中的 `tool.call` 事件
  - 验证工具调用参数是否正确
  - 检查 trace 日志中的 `tool.result` 事件
  - 验证工具返回结果是否正确（`success: true`）

**验收标准**：
- ✅ `enqueue_task` 工具已经实现
- ✅ 工具已经注册到工具列表
- ✅ LLM 可以成功调用工具
- ✅ 工具返回正确的结果（`success: true`）


### 2.2 验证队列管理机制

**目标**：确认队列管理机制已经实现并可以正常工作

**关键文件**：
- `src/auto-reply/reply/queue/types.ts` - 队列数据结构
- `src/auto-reply/reply/queue/enqueue.ts` - 入队逻辑
- `src/auto-reply/reply/queue/drain.ts` - 出队逻辑
- `src/auto-reply/reply/queue/state.ts` - 队列存储

- [ ] 2.2.1 检查队列数据结构
  - 查看 `src/auto-reply/reply/queue/types.ts` 中的 `FollowupRun` 类型定义
  - 验证 `FollowupRun` 包含必要的字段（`prompt`、`summary`、`isQueueTask` 等）
  - 查看 `QueueSettings` 类型定义
  - 验证队列配置选项是否完整

- [ ] 2.2.2 检查队列入队逻辑
  - 查看 `src/auto-reply/reply/queue/enqueue.ts` 中的 `enqueueFollowupRun` 函数
  - 验证入队逻辑是否正确（添加到队列、触发排空）
  - 验证队列深度检查是否存在

- [ ] 2.2.3 检查队列出队逻辑
  - 查看 `src/auto-reply/reply/queue/drain.ts` 中的 `scheduleFollowupDrain` 函数
  - 验证出队逻辑是否正确（按顺序执行、自动排空）
  - 验证任务执行完成后是否从队列中移除

- [ ] 2.2.4 检查队列存储
  - 查看 `src/auto-reply/reply/queue/state.ts` 中的队列存储实现
  - 验证队列存储是否可靠（内存 Map）
  - 验证队列状态管理是否正确

- [ ] 2.2.5 测试队列功能（trace 日志验证）
  - 发送测试消息："请生成 5 段内容"
  - 检查 trace 日志中的队列操作事件
  - 验证任务是否按顺序执行
  - 验证所有任务是否都被执行

**验收标准**：
- ✅ 队列数据结构完整（`FollowupRun`、`QueueSettings`）
- ✅ 入队逻辑正确（`enqueueFollowupRun`）
- ✅ 出队逻辑正确（`scheduleFollowupDrain`）
- ✅ 队列存储可靠（内存 Map）
- ✅ 任务按顺序执行


### 2.3 验证任务执行流程

**目标**：确认任务执行流程已经实现并可以正常工作

**关键文件**：
- `src/auto-reply/reply/agent-runner.ts` - 任务执行入口
- `src/agents/tools/enqueue-task-tool.ts` - 上下文传递

- [ ] 2.3.1 检查任务执行入口
  - 查看 `src/auto-reply/reply/agent-runner.ts` 中的 `runReplyAgent` 函数
  - 验证任务执行入口是否正确
  - 验证任务执行流程是否完整（读取队列 → 执行任务 → 保存结果）

- [ ] 2.3.2 检查上下文传递
  - 查看 `src/agents/tools/enqueue-task-tool.ts` 中的 `setCurrentFollowupRunContext` 函数
  - 验证上下文设置是否正确
  - 查看 `getCurrentFollowupRunContext` 函数
  - 验证上下文获取是否正确

- [ ] 2.3.3 检查任务标记
  - 查看 `src/auto-reply/reply/agent-runner.ts` 中的 `isQueueTask` 字段使用
  - 验证任务标记是否正确设置
  - 验证任务标记是否正确传递

- [ ] 2.3.4 测试任务执行（trace 日志验证）
  - 发送测试消息："请生成 3 段内容"
  - 检查 trace 日志中的 LLM 请求次数（预期：3 次）
  - 检查 trace 日志中的 LLM 回复次数（预期：3 次）
  - 验证每个任务的执行结果是否正确

**验收标准**：
- ✅ 任务执行入口正确（`runReplyAgent`）
- ✅ 上下文传递正确（`setCurrentFollowupRunContext`、`getCurrentFollowupRunContext`）
- ✅ 任务标记正确（`isQueueTask`）
- ✅ 队列任务能够正确执行
- ✅ 每个任务的执行结果正确

---

## 阶段 3：循环检测机制

### 3.1 实现循环检测逻辑

**目标**：防止 LLM 在执行队列任务时再次调用 `enqueue_task`，导致无限循环

**关键文件**：
- `src/agents/tools/enqueue-task-tool.ts` - 循环检测逻辑
- `src/auto-reply/reply/agent-runner.ts` - 任务标记

- [ ] 3.1.1 修改 `enqueue_task` 工具（添加循环检测）
  - 在 `src/agents/tools/enqueue-task-tool.ts` 的 `execute` 函数中添加循环检测
  - 从全局上下文获取 `currentFollowupRun`
  - 检查 `isQueueTask` 字段
  - 如果 `isQueueTask` 为 true，返回错误信息：
    ```
    ❌ 不能在执行队列任务时加入新任务。
    
    ✅ 正确做法：
    1. 直接生成当前任务要求的内容
    2. 不要调用任何工具（包括 enqueue_task）
    3. 完成后系统会自动执行下一个任务
    
    示例：
    任务提示词：请生成第 1 段内容
    → 正确：直接输出"这是第 1 段内容..."
    → 错误：调用 enqueue_task 生成更多任务
    ```

- [ ] 3.1.2 修改任务执行流程（设置 isQueueTask 标记）
  - 在 `src/auto-reply/reply/agent-runner.ts` 中设置 `isQueueTask` 标记
  - 执行用户消息时：`setCurrentFollowupRunContext({ ...followupRun, isQueueTask: false })`
  - 执行队列任务时：`setCurrentFollowupRunContext({ ...followupRun, isQueueTask: true })`
  - 注意：需要在队列任务执行的地方添加（可能在 `queue/drain.ts` 中）

- [ ] 3.1.3 添加日志记录
  - 在循环检测触发时，记录日志：
    ```typescript
    console.log(`[enqueue_task] 🔍 Checking loop: isQueueTask=${isQueueTask}`);
    if (isQueueTask) {
      console.warn("[enqueue_task] ⚠️ Loop detected! Rejecting enqueue request.");
    }
    ```
  - 在任务执行时，记录 `isQueueTask` 状态：
    ```typescript
    console.log(`[agent-runner] 🔍 Executing task: isQueueTask=${followupRun.isQueueTask}`);
    ```

**验收标准**：
- ✅ 循环检测逻辑正确
- ✅ 队列任务无法调用 `enqueue_task`
- ✅ 用户消息可以调用 `enqueue_task`
- ✅ 日志记录完整
- ✅ 错误消息清晰，提供了正确做法


### 3.2 测试循环检测

**目标**：验证循环检测机制是否有效

- [ ] 3.2.1 测试场景 1：正常情况（队列任务不调用 enqueue_task）
  - 在 UI 中发送消息："请生成 3 段内容"
  - 预期行为：
    - LLM 调用 `enqueue_task` 创建任务 2 和任务 3 ✅
    - LLM 回复第 1 段内容 ✅
    - 系统执行任务 2，LLM 直接回复第 2 段内容（不调用 `enqueue_task`）✅
    - 系统执行任务 3，LLM 直接回复第 3 段内容（不调用 `enqueue_task`）✅
  - 检查 trace 日志中的 `enqueue_task` 调用次数（预期：2 次）
  - 验证循环检测正常工作

- [ ] 3.2.2 测试场景 2：循环检测触发（验证错误消息）
  - 如果 LLM 在执行任务 2 时尝试调用 `enqueue_task`
  - 检查工具返回结果中的错误消息
  - 验证错误消息包含：
    - 错误原因："不能在执行队列任务时加入新任务"
    - 正确做法："直接生成当前任务要求的内容"
    - 示例
  - 验证 LLM 看到错误后，会调整行为

- [ ] 3.2.3 检查日志记录
  - 查看 trace 日志中的循环检测日志
  - 验证日志包含 `isQueueTask` 状态
  - 验证日志包含循环检测触发信息（如果触发）

**验收标准**：
- ✅ 正常情况下，队列任务不会调用 `enqueue_task`
- ✅ 如果 LLM 尝试调用，循环检测会阻止
- ✅ LLM 看到错误后，会调整行为
- ✅ 日志记录完整
- ✅ 错误消息清晰

---

## 阶段 4：Hook 防护机制

### 4.1 实现 Hook 防护逻辑

**目标**：防止 Hook 在队列任务执行时触发，导致副作用

**关键文件**：
- `src/agents/pi-embedded-runner/run/attempt.ts` - Hook 触发逻辑

- [ ] 4.1.1 检查 Hook 触发逻辑
  - 查看 `src/agents/pi-embedded-runner/run/attempt.ts` 中的 Hook 触发逻辑
  - 找到 Hook 触发的位置（通常在 `agentStop` 事件）
  - 理解 Hook 触发的条件和时机

- [ ] 4.1.2 添加 Hook 防护（检查 isQueueTask）
  - 在 Hook 触发前，添加检查：
    ```typescript
    import { getCurrentFollowupRunContext } from "../../tools/enqueue-task-tool.js";
    
    const currentFollowupRun = getCurrentFollowupRunContext();
    const isQueueTask = currentFollowupRun?.isQueueTask ?? false;
    
    if (isQueueTask) {
      console.log("[hook] Skipping hook trigger during queue task execution");
      return; // 跳过 Hook 触发
    }
    
    // 继续执行 Hook
    // ...
    ```

- [ ] 4.1.3 添加日志记录
  - 在 Hook 检查时，记录日志：
    ```typescript
    console.log(`[hook] 🔍 Checking hook trigger: isQueueTask=${isQueueTask}`);
    if (isQueueTask) {
      console.log("[hook] ⚠️ Skipping hook trigger (queue task execution)");
    } else {
      console.log("[hook] ✅ Triggering hook");
    }
    ```

**验收标准**：
- ✅ Hook 防护逻辑正确
- ✅ 队列任务执行时，Hook 不会触发
- ✅ 用户消息执行时，Hook 正常触发
- ✅ 日志记录完整


### 4.2 测试 Hook 防护

**目标**：验证 Hook 防护机制是否有效

- [ ] 4.2.1 创建测试 Hook
  - 创建文件：`.kiro/hooks/test-hook.json`
  - 内容：
    ```json
    {
      "name": "Test Hook",
      "version": "1.0.0",
      "when": {
        "type": "agentStop"
      },
      "then": {
        "type": "askAgent",
        "prompt": "记录日志：LLM 回复完成"
      }
    }
    ```

- [ ] 4.2.2 测试场景 1：用户消息（Hook 正常触发）
  - 在 UI 中发送消息："你好"
  - 预期行为：
    - LLM 回复 ✅
    - Hook 触发 ✅
  - 检查 trace 日志中的 Hook 触发次数（预期：1 次）

- [ ] 4.2.3 测试场景 2：队列任务（Hook 不触发）
  - 在 UI 中发送消息："请生成 3 段内容"
  - 预期行为：
    - LLM 调用 `enqueue_task` 创建任务 2 和任务 3 ✅
    - LLM 回复第 1 段内容 ✅
    - Hook 触发 ✅
    - 系统执行任务 2，LLM 回复第 2 段内容 ✅
    - Hook 不触发 ✅
    - 系统执行任务 3，LLM 回复第 3 段内容 ✅
    - Hook 不触发 ✅
  - 检查 trace 日志中的 Hook 触发次数（预期：1 次，只在第一次回复时触发）

- [ ] 4.2.4 检查日志记录
  - 查看 trace 日志中的 Hook 防护日志
  - 验证日志包含 `isQueueTask` 状态
  - 验证日志包含 Hook 跳过信息（如果跳过）

**验收标准**：
- ✅ 用户消息执行时，Hook 正常触发
- ✅ 队列任务执行时，Hook 不触发
- ✅ 日志记录完整

---

## 阶段 5：文档和示例

### 5.1 编写用户文档

**目标**：为用户提供清晰的使用说明

- [ ] 5.1.1 创建用户文档
  - 创建文件：`docs/intelligent-task-decomposition.md`
  - 内容包括：
    - 功能介绍
    - 使用场景（生成大量内容、处理大量数据、多步骤流程、并行处理）
    - 示例（生成 10000 字小说、总结多个文档、分析项目）
    - 常见问题（如何判断是否需要分解、如何编写清晰的 prompt、如何检查任务完成情况）

- [ ] 5.1.2 更新 README.md
  - 在 `README.md` 中添加智能任务分解功能的简介
  - 添加链接到详细文档

**验收标准**：
- ✅ 用户文档完整
- ✅ README 更新完成


### 5.2 编写开发者文档

**目标**：为开发者提供技术细节

- [ ] 5.2.1 创建开发者文档
  - 创建文件：`docs/dev/intelligent-task-decomposition-architecture.md`
  - 内容包括：
    - 系统架构（LLM、System Prompt、enqueue_task Tool、Queue Executor、Loop Detector、Hook Guard）
    - 数据流（用户请求 → LLM 分析 → 调用工具 → 队列管理 → 任务执行）
    - 关键文件（系统提示词、工具定义、队列管理、任务执行）
    - 扩展指南（如何添加新的任务类型、如何自定义系统提示词、如何调试）

- [ ] 5.2.2 更新 AGENTS.md
  - 在 `AGENTS.md` 中添加智能任务分解相关的开发规范
  - 添加关键文件位置清单
  - 添加调试技巧

**验收标准**：
- ✅ 开发者文档完整
- ✅ AGENTS.md 更新完成

### 5.3 创建示例

**目标**：提供可运行的示例代码

- [ ] 5.3.1 创建示例目录
  - 创建目录：`examples/intelligent-task-decomposition/`

- [ ] 5.3.2 创建示例脚本
  - 创建文件：`examples/intelligent-task-decomposition/test-task-decomposition.mjs`
  - 内容：
    - 示例 1：生成多段内容
    - 示例 2：总结多个文档
    - 示例 3：多步骤流程

- [ ] 5.3.3 创建 README.md
  - 创建文件：`examples/intelligent-task-decomposition/README.md`
  - 内容：
    - 示例说明
    - 运行方法
    - 预期结果

**验收标准**：
- ✅ 示例目录创建完成
- ✅ 示例脚本可运行
- ✅ README 完整

---

## 阶段 6：测试和优化

### 6.1 单元测试

**目标**：为关键功能编写单元测试

- [ ] 6.1.1 测试 `enqueue_task` 工具
  - 创建文件：`src/agents/tools/enqueue-task-tool.test.ts`
  - 测试用例：
    - 正常情况：调用工具成功
    - 循环检测：队列任务调用工具失败
    - 参数验证：缺少 `prompt` 参数失败
    - 上下文传递：`currentFollowupRun` 未设置失败

- [ ] 6.1.2 测试队列管理
  - 创建文件：`src/auto-reply/reply/queue/enqueue.test.ts`
  - 测试用例：
    - 入队成功
    - 队列深度检查
    - 队列排空

- [ ] 6.1.3 测试循环检测
  - 在 `src/agents/tools/enqueue-task-tool.test.ts` 中添加测试用例
  - 测试用例：
    - 用户消息可以调用 `enqueue_task`
    - 队列任务无法调用 `enqueue_task`
    - 错误消息正确

**验收标准**：
- ✅ 单元测试覆盖率 > 80%
- ✅ 所有测试通过


### 6.2 集成测试

**目标**：测试完整的任务分解流程

- [ ] 6.2.1 创建集成测试
  - 创建文件：`test/intelligent-task-decomposition.e2e.test.ts`
  - 测试用例：
    - 场景 1：生成多段内容
    - 场景 2：总结多个文档
    - 场景 3：多步骤流程
    - 场景 4：循环检测触发
    - 场景 5：Hook 防护

- [ ] 6.2.2 运行集成测试
  - 运行命令：`pnpm test test/intelligent-task-decomposition.e2e.test.ts`
  - 验证所有测试通过

**验收标准**：
- ✅ 集成测试通过
- ✅ 所有场景覆盖

### 6.3 性能优化

**目标**：优化系统性能，确保高效运行

- [ ] 6.3.1 分析性能瓶颈
  - 使用 trace 日志分析任务执行时间
  - 识别性能瓶颈（队列管理、任务执行、LLM 调用）

- [ ] 6.3.2 优化队列管理
  - 优化入队逻辑（减少不必要的检查）
  - 优化出队逻辑（批量处理）
  - 优化队列存储（使用更高效的数据结构）

- [ ] 6.3.3 优化任务执行
  - 优化上下文传递（减少不必要的复制）
  - 优化任务标记（使用更高效的标记方式）
  - 优化日志记录（减少不必要的日志）

**验收标准**：
- ✅ 任务执行时间 < 5 秒
- ✅ 队列操作时间 < 100 毫秒

---

## 阶段 7：最终验收

### 7.1 功能验收

**验收清单**：

- [ ] 7.1.1 验证 LLM 能够识别需要分解的任务
  - 测试场景：生成大量内容、处理大量数据、多步骤流程、并行处理
  - 验证 LLM 能够正确判断是否需要分解

- [ ] 7.1.2 验证 LLM 能够正确调用 `enqueue_task` 工具
  - 验证工具调用参数正确（`prompt` 和 `summary`）
  - 验证工具返回结果正确

- [ ] 7.1.3 验证系统能够自动执行队列中的任务
  - 验证任务按顺序执行
  - 验证所有任务都被执行
  - 验证任务执行结果正确

- [ ] 7.1.4 验证循环检测机制有效
  - 验证队列任务无法调用 `enqueue_task`
  - 验证错误消息清晰
  - 验证 LLM 能够调整行为

- [ ] 7.1.5 验证 Hook 防护机制有效
  - 验证队列任务执行时 Hook 不触发
  - 验证用户消息执行时 Hook 正常触发

- [ ] 7.1.6 验证文档和示例完整
  - 验证用户文档清晰
  - 验证开发者文档完整
  - 验证示例可运行

- [ ] 7.1.7 验证单元测试和集成测试通过
  - 运行所有单元测试
  - 运行所有集成测试
  - 验证测试覆盖率 > 80%

- [ ] 7.1.8 验证性能满足要求
  - 验证任务执行时间 < 5 秒
  - 验证队列操作时间 < 100 毫秒


### 7.2 用户验收

**目标**：确保用户满意

- [ ] 7.2.1 邀请用户测试
  - 邀请至少 3 名用户测试
  - 提供测试指南和场景
  - 收集用户反馈

- [ ] 7.2.2 收集反馈
  - 收集用户对功能的反馈
  - 收集用户对文档的反馈
  - 收集用户对性能的反馈
  - 收集用户对易用性的反馈

- [ ] 7.2.3 修复问题
  - 根据用户反馈修复问题
  - 优化功能和文档
  - 重新测试

**验收标准**：
- ✅ 用户满意度 > 90%
- ✅ 所有关键问题已修复

### 7.3 发布准备

**目标**：准备发布

- [ ] 7.3.1 更新 CHANGELOG
  - 添加新功能说明
  - 添加改进说明
  - 添加修复说明

- [ ] 7.3.2 更新版本号
  - 更新 `package.json` 中的版本号
  - 更新其他相关文件中的版本号

- [ ] 7.3.3 创建发布说明
  - 创建发布说明文档
  - 包括功能介绍、使用方法、注意事项

**验收标准**：
- ✅ CHANGELOG 更新完成
- ✅ 版本号更新完成
- ✅ 发布说明完整

---

## 📁 关键文件位置清单

### 系统提示词
- `src/agents/system-prompt.ts` - 系统提示词构建逻辑
- `src/agents/system-prompt.l10n.zh.ts` - 中文翻译
- `src/agents/system-prompt.l10n.en.ts` - 英文翻译

### 工具定义
- `src/agents/tools/enqueue-task-tool.ts` - `enqueue_task` 工具定义
- `src/agents/clawdbot-tools.ts` - 工具注册
- `src/agents/pi-tools.ts` - 工具列表

### 队列管理
- `src/auto-reply/reply/queue/types.ts` - 队列数据结构
- `src/auto-reply/reply/queue/enqueue.ts` - 入队逻辑
- `src/auto-reply/reply/queue/drain.ts` - 出队逻辑
- `src/auto-reply/reply/queue/state.ts` - 队列存储
- `src/auto-reply/reply/queue/settings.ts` - 队列配置

### 任务执行
- `src/auto-reply/reply/agent-runner.ts` - 任务执行入口
- `src/agents/pi-embedded-runner/run/attempt.ts` - Hook 触发逻辑

### 文档
- `docs/intelligent-task-decomposition.md` - 用户文档
- `docs/dev/intelligent-task-decomposition-architecture.md` - 开发者文档
- `examples/intelligent-task-decomposition/` - 示例代码

---

## ⚠️ 注意事项

### 1. LLM 驱动原则
- 所有任务识别和分解都由 LLM 完成
- 系统只提供工具和基础设施
- 不使用硬编码规则（如字数阈值、数据量阈值）

### 2. 复用现有机制
- 复用现有的队列管理机制（`src/auto-reply/reply/queue/`）
- 复用现有的任务执行流程（`src/auto-reply/reply/agent-runner.ts`）
- 不重复造轮子

### 3. 系统提示词设计原则
- 简单直接 > 复杂精确
- 负面规则 > 正面规则
- 可选步骤 > 强制步骤
- 具体示例 > 抽象描述
- 短句子 > 长句子

### 4. 不破坏现有功能
- 所有修改都要向后兼容
- 不影响现有的工具和功能
- 充分测试

### 5. 充分测试和文档
- 单元测试覆盖率 > 80%
- 集成测试覆盖所有场景
- 文档完整清晰

---

## 🔍 调试技巧

### 查看 trace 日志
```powershell
# 查看最新的 trace 日志
$trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json

# 查看 LLM payload
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
$payloads[0].payload.payload | ConvertTo-Json -Depth 10

# 查看工具调用
$toolCalls = $trace | Where-Object { $_.event -eq "tool.call" }
$toolCalls | ForEach-Object {
    Write-Host "Tool: $($_.payload.toolName)"
    Write-Host "Args: $($_.payload.args)"
}

# 查看工具返回结果
$toolResults = $trace | Where-Object { $_.event -eq "tool.result" }
$toolResults | ForEach-Object {
    Write-Host "Tool: $($_.payload.toolName)"
    Write-Host "Result: $($_.payload.result)"
}
```

### 查看系统提示词
```powershell
# 提取系统提示词
$trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
$systemPrompt = $payloads[0].payload.payload.systemInstruction.parts[0].text

# 保存到文件
$systemPrompt | Out-File "runtimelog/tempfile/system_prompt.txt" -Encoding UTF8
```

### 查看队列状态
```powershell
# 查看队列相关事件
$trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$queueEvents = $trace | Where-Object { $_.event -like "*queue*" }
$queueEvents | ForEach-Object {
    Write-Host "Event: $($_.event)"
    Write-Host "Payload: $($_.payload | ConvertTo-Json -Compress)"
}
```

---

**版本**：v20260204_3  
**最后更新**：2026-02-04  
**变更**：基于 tasks-standard.md 和 tasks-original-guide.md，重新编写详细的、可执行的任务列表

---

## 阶段 8：Agent Orchestrator 与队列状态管理

### 8.1 实现 Agent Orchestrator

**目标**：协调所有组件，实现完整的任务分解流程

- [x] 8.1.1 创建 Orchestrator 文件
  - 创建 `src/agents/intelligent-task-decomposition/orchestrator.ts` 文件
  - 实现任务规模判断和分解触发逻辑
  - 协调 TaskAnalyzer、TaskDecomposer、QueueExecutor 和 SelfChecker
  - 处理用户交互（确认、调整等）
  - _需求: 1.1, 1.5, 2.1_

### 8.2 实现队列状态管理

**目标**：正确管理队列状态，防止重复加入任务

- [x] 8.2.1 实现队列深度检查
  - 复用 `.kiro/lessons-learned/84_队列管理的自动加入陷阱.md` 中的机制
  - 检查队列深度
  - 防止重复加入用户消息
  - _需求: 7.1, 7.2, 7.3_

### 8.3 实现用户场景支持

**目标**：支持常见的用户场景

- [x] 8.3.1 支持生成大量内容场景
  - 支持连续任务
  - _需求: 9.1_

- [x] 8.3.2 支持总结大量内容场景
  - 支持依赖任务
  - _需求: 9.2_

- [x] 8.3.3 支持分析复杂项目场景
  - 支持树形任务
  - _需求: 9.3_

- [x] 8.3.4 支持并行处理多个文件场景
  - 支持分支任务
  - _需求: 9.4_

- [x] 8.3.5 支持多步骤流程场景
  - 支持依赖任务
  - _需求: 9.5_

---

## 阶段 9：任务树持久化与管理

### 9.1 实现 TaskTreeManager 接口

**目标**：实现任务树的持久化和管理

**关键文件**：
- `src/agents/intelligent-task-decomposition/task-tree-manager.ts` - 任务树管理器

- [x] 9.1.1 创建 TaskTreeManager 文件
  - 创建 `src/agents/intelligent-task-decomposition/task-tree-manager.ts` 文件
  - 实现 `initialize(rootTask: string, sessionId: string): Promise<TaskTree>` 方法
  - 实现 `save(taskTree: TaskTree): Promise<void>` 方法
  - 实现 `load(sessionId: string): Promise<TaskTree | null>` 方法
  - 实现 `updateSubTaskStatus(taskTree: TaskTree, subTaskId: string, status: SubTask["status"]): Promise<void>` 方法
  - _需求: 10.1, 10.2, 10.3_

### 9.2 实现检查点管理

**目标**：定期创建检查点，支持回滚

- [x] 9.2.1 实现检查点创建
  - 实现 `createCheckpoint(taskTree: TaskTree): Promise<string>` 方法
  - 保存任务树快照到 `.clawdbot/tasks/{sessionId}/checkpoints/{checkpointId}.json`
  - _需求: 14.1, 14.2_

- [x] 9.2.2 实现检查点恢复
  - 实现 `restoreFromCheckpoint(taskTree: TaskTree, checkpointId: string): Promise<TaskTree>` 方法
  - 从检查点文件恢复任务树
  - _需求: 14.4_

- [x] 9.2.3 实现检查点清理
  - 最多保留 10 个检查点
  - 删除最旧的检查点
  - _需求: 14.3, 14.5_

### 9.3 实现任务树渲染

**目标**：生成清晰的 Markdown 格式

- [x] 9.3.1 实现 Markdown 渲染
  - 实现 `renderToMarkdown(taskTree: TaskTree): string` 方法
  - 生成清晰的 Markdown 格式
  - 同时保存 JSON 和 Markdown 到文件系统
  - _需求: 10.1, 10.2_

### 9.4 实现原子写入和备份

**目标**：确保数据一致性

- [x] 9.4.1 实现原子写入
  - 先写入临时文件（`.tmp`）
  - 写入成功后，重命名为目标文件
  - _需求: 10.3_

- [x] 9.4.2 实现备份机制
  - 每次保存前，先备份当前文件到 `.bak`
  - 如果主文件损坏，从备份文件恢复
  - _需求: 10.4, 10.5_

**验收标准**：
- ✅ 任务树能够保存到磁盘
- ✅ 任务树能够从磁盘加载
- ✅ 检查点能够创建和恢复
- ✅ 原子写入确保数据一致性
- ✅ 备份机制能够恢复损坏的文件

---

## 阶段 10：重试机制实现

### 10.1 实现 RetryManager 接口

**目标**：实现自动重试机制

**关键文件**：
- `src/agents/intelligent-task-decomposition/retry-manager.ts` - 重试管理器

- [ ] 10.1.1 创建 RetryManager 文件
  - 创建 `src/agents/intelligent-task-decomposition/retry-manager.ts` 文件
  - 实现 `isRetryable(error: Error): boolean` 方法
  - 实现 `executeWithRetry<T>(subTask: SubTask, executor: () => Promise<T>, maxRetries: number): Promise<T>` 方法
  - 实现 `logFailure(subTask: SubTask, error: Error, sessionId: string): Promise<void>` 方法
  - 实现 `getFailureLogs(sessionId: string): Promise<FailureLog[]>` 方法
  - _需求: 12.1, 12.2, 12.3, 12.4, 12.5_

### 10.2 实现可重试错误识别

**目标**：识别哪些错误可以重试

- [x] 10.2.1 实现错误类型判断
  - 识别网络超时、网络连接失败、LLM 请求限流等可重试错误
  - 识别代码错误、文件不存在等不可重试错误
  - _需求: 12.2, 12.3_

### 10.3 实现重试策略

**目标**：使用指数退避重试

- [x] 10.3.1 实现指数退避
  - 使用指数退避（1s, 2s, 4s）
  - 最多重试 3 次
  - 记录每次重试的日志
  - _需求: 12.2, 12.4_

### 10.4 实现失败日志记录

**目标**：记录所有失败信息

- [x] 10.4.1 实现日志记录
  - 保存到 `.clawdbot/tasks/{sessionId}/failures.log`
  - 包含时间戳、子任务 ID、错误信息、堆栈跟踪、重试次数
  - _需求: 12.5_

**验收标准**：
- ✅ 可重试错误能够自动重试
- ✅ 不可重试错误立即失败
- ✅ 重试使用指数退避
- ✅ 失败日志记录完整

---

## 阶段 11：错误处理实现

### 11.1 实现 ErrorHandler 接口

**目标**：实现完整的错误处理机制

**关键文件**：
- `src/agents/intelligent-task-decomposition/error-handler.ts` - 错误处理器

- [x] 11.1.1 创建 ErrorHandler 文件
  - 创建 `src/agents/intelligent-task-decomposition/error-handler.ts` 文件
  - 实现 `handleError(error: Error, context: Record<string, unknown>, sessionId: string): Promise<void>` 方法
  - 实现 `logError(errorType: ErrorLog["errorType"], error: Error, context: Record<string, unknown>, sessionId: string): Promise<void>` 方法
  - 实现 `getErrorLogs(sessionId: string): Promise<ErrorLog[]>` 方法
  - 实现 `tryRecover(error: Error, context: Record<string, unknown>): Promise<boolean>` 方法
  - _需求: 13.1, 13.2, 13.3, 13.4, 13.5_

### 11.2 实现错误分类

**目标**：针对不同错误类型采取不同策略

- [x] 11.2.1 实现错误类型判断
  - 分类 LLM 请求失败、文件系统操作失败、内存不足、系统崩溃等错误
  - 针对不同错误类型采取不同的处理策略
  - _需求: 13.1, 13.2, 13.3, 13.4_

### 11.3 实现错误日志记录

**目标**：记录所有错误信息

- [x] 11.3.1 实现日志记录
  - 保存到 `.clawdbot/tasks/{sessionId}/errors.log`
  - 包含时间戳、错误类型、错误信息、堆栈跟踪、上下文信息
  - _需求: 13.5_

### 11.4 实现错误恢复策略

**目标**：尝试从错误中恢复

- [x] 11.4.1 实现恢复策略
  - LLM 请求失败：重试
  - 文件系统操作失败：备份到临时位置
  - 内存不足：释放资源
  - 系统崩溃：从检查点恢复
  - _需求: 13.1, 13.2, 13.3, 13.4_

**验收标准**：
- ✅ 错误能够正确分类
- ✅ 错误日志记录完整
- ✅ 错误恢复策略有效

---

## 阶段 12：断点恢复实现

### 12.1 实现 RecoveryManager 接口

**目标**：实现断点恢复机制

**关键文件**：
- `src/agents/intelligent-task-decomposition/recovery-manager.ts` - 恢复管理器

- [x] 12.1.1 创建 RecoveryManager 文件
  - 创建 `src/agents/intelligent-task-decomposition/recovery-manager.ts` 文件
  - 实现 `hasUnfinishedTasks(sessionId: string): Promise<boolean>` 方法
  - 实现 `recoverUnfinishedTasks(sessionId: string): Promise<TaskTree>` 方法
  - 实现 `identifyInterruptedTasks(taskTree: TaskTree): SubTask[]` 方法
  - 实现 `reexecuteInterruptedTasks(taskTree: TaskTree, interruptedTasks: SubTask[]): Promise<void>` 方法
  - _需求: 11.1, 11.2, 11.3, 11.4, 11.5_

### 12.2 实现未完成任务检测

**目标**：检测是否有未完成的任务

- [x] 12.2.1 实现检测逻辑
  - 检查任务树文件是否存在
  - 检查是否有状态为 "pending"、"active" 或 "interrupted" 的任务
  - _需求: 11.1, 11.2_

### 12.3 实现恢复流程

**目标**：从断点恢复任务

- [x] 12.3.1 实现恢复逻辑
  - 从磁盘加载任务树
  - 识别未完成的任务
  - 将 "active" 状态的任务标记为 "interrupted"
  - 从最近的检查点恢复
  - 继续执行未完成的任务
  - _需求: 11.1, 11.2, 11.3, 11.4, 11.5_

### 12.4 实现中断任务处理

**目标**：重新执行中断的任务

- [x] 12.4.1 实现中断任务处理
  - 将 "interrupted" 状态的任务重新标记为 "pending"
  - 重新执行这些任务
  - 记录恢复日志
  - _需求: 11.3, 11.4_

**验收标准**：
- ✅ 能够检测未完成的任务
- ✅ 能够从断点恢复任务
- ✅ 中断的任务能够重新执行
- ✅ 恢复日志记录完整

---

## 阶段 13：与现有系统深度集成

### 13.1 集成 `enqueue_task` 工具

**目标**：确保正确使用现有工具

- [x] 13.1.1 验证集成
  - 确保 QueueExecutor 正确调用 `src/agents/tools/enqueue-task-tool.ts` 中的 `enqueue_task`
  - 确保使用 `followup` 模式
  - 确保不去重（`dedupeMode: "none"`）
  - _需求: 15.1_

### 13.2 集成全局上下文管理

**目标**：确保循环检测正确工作

- [x] 13.2.1 验证集成
  - 确保 Loop Detector 正确使用 `src/auto-reply/reply/agent-runner.ts` 中的全局上下文管理
  - 确保在 `enqueue_task` 工具中检测循环
  - _需求: 15.2_

### 13.3 集成队列执行逻辑

**目标**：确保队列自动排空

- [-] 13.3.1 验证集成
  - 确保 QueueExecutor 正确使用 `src/auto-reply/reply/followup-runner.ts` 中的队列执行逻辑
  - 确保队列自动排空
  - _需求: 15.3_

### 13.4 集成任务看板机制

**目标**：确保与任务看板兼容

- [x] 13.4.1 验证集成
  - 确保 TaskTreeManager 与 `src/agents/task-board/` 中的任务看板机制兼容
  - 确保任务树和任务看板可以互相转换
  - _需求: 15.4_

### 13.5 验证不破坏现有功能

**目标**：确保现有功能正常工作

- [x] 13.5.1 运行现有测试
  - 运行现有的连续任务测试
  - 确保现有功能正常工作
  - _需求: 15.5, 15.6_

**验收标准**：
- ✅ 所有现有测试通过
- ✅ 现有功能正常工作
- ✅ 新功能与现有系统无缝集成

---

## 阶段 14：检查点 - 确保所有核心功能正常工作

确保所有测试通过，如有问题请向用户报告。

---

## 阶段 15：文档和示例

### 15.1 编写用户文档

**目标**：为用户提供清晰的使用说明

- [ ] 15.1.1 创建用户文档
  - 创建 `docs/intelligent-task-decomposition.md` 文件
  - 说明如何启用智能任务分解
  - 说明如何使用不同的任务类型
  - 说明如何处理循环检测和 Hook 防护
  - 说明如何查看任务树和恢复任务
  - 说明如何处理任务失败和重试
  - _需求: 所有需求_

- [ ] 15.1.2 更新 README.md
  - 在 `README.md` 中添加智能任务分解功能的简介
  - 添加链接到详细文档

**验收标准**：
- ✅ 用户文档完整
- ✅ README 更新完成

### 15.2 编写开发者文档

**目标**：为开发者提供技术细节

- [ ] 15.2.1 创建开发者文档
  - 创建 `docs/dev/intelligent-task-decomposition-architecture.md` 文件
  - 说明架构设计和组件职责
  - 说明如何扩展任务分解策略
  - 说明如何与现有系统集成
  - 说明任务树持久化和恢复机制
  - 说明重试机制和错误处理
  - _需求: 所有需求_

- [ ] 15.2.2 更新 AGENTS.md
  - 在 `AGENTS.md` 中添加智能任务分解相关的开发规范
  - 添加关键文件位置清单
  - 添加调试技巧

**验收标准**：
- ✅ 开发者文档完整
- ✅ AGENTS.md 更新完成

### 15.3 创建示例

**目标**：提供可运行的示例代码

- [x] 15.3.1 创建示例目录
  - 创建目录：`examples/intelligent-task-decomposition/`

- [x] 15.3.2 创建示例脚本
  - 创建文件：`examples/intelligent-task-decomposition/test-task-decomposition.mjs`
  - 内容：
    - 示例 1：生成多段内容
    - 示例 2：总结多个文档
    - 示例 3：多步骤流程
    - 示例 4：任务恢复
    - 示例 5：任务失败重试

- [ ] 15.3.3 创建 README.md
  - 创建文件：`examples/intelligent-task-decomposition/README.md`
  - 内容：
    - 示例说明
    - 运行方法
    - 预期结果

**验收标准**：
- ✅ 示例目录创建完成
- ✅ 示例脚本可运行
- ✅ README 完整

### 15.4 编写故障排查指南

**目标**：帮助用户解决常见问题

- [ ] 15.4.1 创建故障排查指南
  - 创建 `docs/troubleshooting/intelligent-task-decomposition.md` 文件
  - 说明常见错误和解决方案
  - 说明如何查看任务树和日志
  - 说明如何手动恢复任务
  - 说明如何处理系统崩溃
  - _需求: 11.1, 12.1, 13.1, 13.2, 13.3, 13.4, 13.5_

**验收标准**：
- ✅ 故障排查指南完整
- ✅ 常见问题都有解决方案

---

## 阶段 16：最终检查点 - 确保所有测试通过

确保所有测试通过，如有问题请向用户报告。

---
