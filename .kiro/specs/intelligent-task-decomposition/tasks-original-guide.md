# 智能任务分解系统 - 实施任务

> **核心原则**：LLM 驱动，系统只提供工具和基础设施

---

## 📋 任务概览

本 spec 实现一个智能任务分解系统，让 LLM 能够主动将复杂任务分解为多个子任务，并通过队列机制自动执行。

**关键特性**：
- ✅ LLM 驱动：所有任务识别和分解都由 LLM 完成
- ✅ 复用现有机制：复用现有的队列管理和任务执行流程
- ✅ 循环检测：防止无限循环
- ✅ Hook 防护：防止副作用

**实施阶段**：
1. 系统提示词设计和实现
2. 验证现有基础设施
3. 循环检测机制
4. Hook 防护机制
5. 文档和示例
6. 测试和优化
7. 最终验收

---

## 阶段 1：系统提示词设计和实现

### 1.1 设计系统提示词内容

**目标**：设计清晰、简单、有效的系统提示词，引导 LLM 主动分解任务

**背景知识**：
- 系统提示词位置：`src/agents/system-prompt.ts`
- 构建函数：`buildAgentSystemPrompt`
- 设计原则：`.kiro/steering/system-prompt-design-principles.md`

**实施步骤**：

1. **阅读现有系统提示词结构**
   ```powershell
   # 查看系统提示词构建逻辑
   Get-Content "src/agents/system-prompt.ts" -Encoding UTF8 | Select-String -Pattern "function buildAgentSystemPrompt" -Context 5,50
   ```

2. **设计任务分解引导内容**
   
   遵循"简单直接、负面规则、可选步骤、具体示例、短句子"的原则：
   
   ```markdown
   ## 任务分解（可选）
   
   当你收到一个复杂的任务时，你可以将它分解成多个子任务。
   
   ### 什么时候需要分解任务？
   
   你可以根据以下情况判断是否需要分解任务：
   - 任务涉及大量内容生成（如生成 10000 字的文章）
   - 任务涉及大量数据处理（如总结 100 万字的电子书）
   - 任务涉及多个步骤（如先读取文件，再分析内容，最后生成报告）
   - 任务需要并行处理多个文件或数据
   
   ### 如何分解任务？
   
   1. **分析任务**：理解用户的需求，识别任务的关键步骤
   2. **创建子任务**：为每个步骤创建一个子任务，使用 `enqueue_task` 工具
   3. **提供清晰的 prompt**：每个子任务的 prompt 应该清晰、具体、可执行
   4. **提供简短的 summary**：每个子任务的 summary 应该简短地描述任务的目标
   
   ### 示例
   
   **用户请求**：请帮我生成一个 10000 字的科幻小说
   
   **你的分解**：
   1. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 1-2000 字，包括开头和人物介绍"，summary: "生成小说第 1-2000 字"
   2. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 2001-4000 字，继续故事发展"，summary: "生成小说第 2001-4000 字"
   3. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 4001-6000 字，推进情节"，summary: "生成小说第 4001-6000 字"
   4. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 6001-8000 字，进入高潮"，summary: "生成小说第 6001-8000 字"
   5. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 8001-10000 字，结局和总结"，summary: "生成小说第 8001-10000 字"
   6. 回复用户："我已经为你创建了 5 个任务，系统会自动执行它们。"
   
   ### 重要规则
   
   - ❌ **不要在队列任务中调用 `enqueue_task`**：如果你正在执行一个队列任务，不要再调用 `enqueue_task` 创建新任务
   - ✅ **直接完成当前任务**：如果你正在执行一个队列任务，直接生成当前任务要求的内容
   - ✅ **检查任务完成情况**：在创建子任务后，告诉用户你创建了多少个任务
   ```

3. **设计 `enqueue_task` 工具使用说明**
   
   在 Tooling section 中添加 `enqueue_task` 工具的说明：
   
   ```markdown
   - enqueue_task: 将任务加入队列，稍后自动执行。用于生成多段内容或执行一系列关联任务。每个任务会单独执行并回复。
   ```

**验收标准**：
- ✅ 系统提示词内容清晰、简单、易懂
- ✅ 遵循系统提示词设计原则
- ✅ 提供了具体的示例和规则
- ✅ 不使用复杂的概念和条件判断

---


### 1.2 实现系统提示词注入

**目标**：将任务分解引导内容注入到系统提示词中

**关键文件**：
- `src/agents/system-prompt.ts` - 系统提示词构建逻辑
- `src/agents/system-prompt.l10n.zh.ts` - 中文翻译
- `src/agents/system-prompt.l10n.en.ts` - 英文翻译

**实施步骤**：

1. **修改 `src/agents/system-prompt.ts`**
   
   在 `buildAgentSystemPrompt` 函数中添加新的 section：
   
   ```typescript
   // 在 Tooling section 之后，Workspace section 之前添加
   function buildTaskDecompositionSection(params: {
     isMinimal: boolean;
     l10n: typeof SYSTEM_PROMPT_L10N_EN;
   }) {
     if (params.isMinimal) return [];
     return [
       params.l10n.taskDecompositionTitle,
       params.l10n.taskDecompositionIntro,
       "",
       params.l10n.taskDecompositionWhenTitle,
       params.l10n.taskDecompositionWhenLine1,
       params.l10n.taskDecompositionWhenLine2,
       params.l10n.taskDecompositionWhenLine3,
       params.l10n.taskDecompositionWhenLine4,
       "",
       params.l10n.taskDecompositionHowTitle,
       params.l10n.taskDecompositionHowLine1,
       params.l10n.taskDecompositionHowLine2,
       params.l10n.taskDecompositionHowLine3,
       params.l10n.taskDecompositionHowLine4,
       "",
       params.l10n.taskDecompositionExampleTitle,
       params.l10n.taskDecompositionExampleRequest,
       params.l10n.taskDecompositionExampleDecomposition,
       params.l10n.taskDecompositionExampleStep1,
       params.l10n.taskDecompositionExampleStep2,
       params.l10n.taskDecompositionExampleStep3,
       params.l10n.taskDecompositionExampleStep4,
       params.l10n.taskDecompositionExampleStep5,
       params.l10n.taskDecompositionExampleStep6,
       "",
       params.l10n.taskDecompositionRulesTitle,
       params.l10n.taskDecompositionRulesLine1,
       params.l10n.taskDecompositionRulesLine2,
       params.l10n.taskDecompositionRulesLine3,
       "",
     ];
   }
   
   // 在 buildAgentSystemPrompt 函数中调用
   const taskDecompositionSection = buildTaskDecompositionSection({
     isMinimal,
     l10n,
   });
   
   // 在 lines 数组中添加
   const lines = [
     // ... 现有内容 ...
     ...taskDecompositionSection,
     // ... 现有内容 ...
   ];
   ```

2. **添加中文翻译**
   
   在 `src/agents/system-prompt.l10n.zh.ts` 中添加：
   
   ```typescript
   export const SYSTEM_PROMPT_L10N_ZH = {
     // ... 现有内容 ...
     
     taskDecompositionTitle: "## 任务分解（可选）",
     taskDecompositionIntro: "当你收到一个复杂的任务时，你可以将它分解成多个子任务。",
     
     taskDecompositionWhenTitle: "### 什么时候需要分解任务？",
     taskDecompositionWhenLine1: "- 任务涉及大量内容生成（如生成 10000 字的文章）",
     taskDecompositionWhenLine2: "- 任务涉及大量数据处理（如总结 100 万字的电子书）",
     taskDecompositionWhenLine3: "- 任务涉及多个步骤（如先读取文件，再分析内容，最后生成报告）",
     taskDecompositionWhenLine4: "- 任务需要并行处理多个文件或数据",
     
     taskDecompositionHowTitle: "### 如何分解任务？",
     taskDecompositionHowLine1: "1. **分析任务**：理解用户的需求，识别任务的关键步骤",
     taskDecompositionHowLine2: "2. **创建子任务**：为每个步骤创建一个子任务，使用 `enqueue_task` 工具",
     taskDecompositionHowLine3: "3. **提供清晰的 prompt**：每个子任务的 prompt 应该清晰、具体、可执行",
     taskDecompositionHowLine4: "4. **提供简短的 summary**：每个子任务的 summary 应该简短地描述任务的目标",
     
     taskDecompositionExampleTitle: "### 示例",
     taskDecompositionExampleRequest: "**用户请求**：请帮我生成一个 10000 字的科幻小说",
     taskDecompositionExampleDecomposition: "**你的分解**：",
     taskDecompositionExampleStep1: '1. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 1-2000 字，包括开头和人物介绍"，summary: "生成小说第 1-2000 字"',
     taskDecompositionExampleStep2: '2. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 2001-4000 字，继续故事发展"，summary: "生成小说第 2001-4000 字"',
     taskDecompositionExampleStep3: '3. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 4001-6000 字，推进情节"，summary: "生成小说第 4001-6000 字"',
     taskDecompositionExampleStep4: '4. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 6001-8000 字，进入高潮"，summary: "生成小说第 6001-8000 字"',
     taskDecompositionExampleStep5: '5. 调用 `enqueue_task`，prompt: "请生成科幻小说的第 8001-10000 字，结局和总结"，summary: "生成小说第 8001-10000 字"',
     taskDecompositionExampleStep6: '6. 回复用户："我已经为你创建了 5 个任务，系统会自动执行它们。"',
     
     taskDecompositionRulesTitle: "### 重要规则",
     taskDecompositionRulesLine1: "- ❌ **不要在队列任务中调用 `enqueue_task`**：如果你正在执行一个队列任务，不要再调用 `enqueue_task` 创建新任务",
     taskDecompositionRulesLine2: "- ✅ **直接完成当前任务**：如果你正在执行一个队列任务，直接生成当前任务要求的内容",
     taskDecompositionRulesLine3: "- ✅ **检查任务完成情况**：在创建子任务后，告诉用户你创建了多少个任务",
     
     // ... 现有内容 ...
   };
   ```

3. **添加英文翻译**
   
   在 `src/agents/system-prompt.l10n.en.ts` 中添加对应的英文翻译。

4. **验证注入效果**
   
   ```powershell
   # 启动系统
   .\.A_Start-Clawdbot.cmd
   
   # 发送测试消息
   # 在 UI 中发送："你好"
   
   # 检查 trace 日志中的 system prompt
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
   $systemPrompt = $payloads[0].payload.payload.systemInstruction.parts[0].text
   
   # 检查是否包含任务分解内容
   if ($systemPrompt -match "任务分解") {
       Write-Host "✅ 系统提示词注入成功" -ForegroundColor Green
   } else {
       Write-Host "❌ 系统提示词注入失败" -ForegroundColor Red
   }
   
   # 查看完整的系统提示词
   $systemPrompt | Out-File "runtimelog/tempfile/system_prompt_check.txt" -Encoding UTF8
   Write-Host "系统提示词已保存到 runtimelog/tempfile/system_prompt_check.txt"
   ```

**验收标准**：
- ✅ 系统提示词中包含任务分解引导内容
- ✅ 中英文翻译完整
- ✅ trace 日志中可以看到完整的系统提示词
- ✅ 系统提示词格式正确，没有语法错误

---


### 1.3 验证 LLM 理解和行为

**目标**：验证 LLM 是否理解系统提示词，并能正确使用 `enqueue_task` 工具

**实施步骤**：

1. **测试场景 1：生成多段内容**
   
   ```powershell
   # 在 UI 中发送消息
   # 用户消息：请生成 3 段内容，每段 100 字
   
   # 预期行为：
   # 1. LLM 调用 enqueue_task 创建任务 2 和任务 3
   # 2. LLM 回复第 1 段内容
   # 3. 系统自动执行任务 2 和任务 3
   
   # 检查 trace 日志
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $toolCalls = $trace | Where-Object { $_.event -eq "tool.call" -and $_.payload.toolName -eq "enqueue_task" }
   
   Write-Host "enqueue_task 调用次数: $($toolCalls.Count)"
   $toolCalls | ForEach-Object {
       $args = $_.payload.args | ConvertFrom-Json
       Write-Host "  - summary: $($args.summary)"
       Write-Host "    prompt: $($args.prompt)"
   }
   ```

2. **测试场景 2：处理大量数据**
   
   ```powershell
   # 在 UI 中发送消息
   # 用户消息：请总结 docs/ 目录下的所有文档
   
   # 预期行为：
   # 1. LLM 读取文档列表
   # 2. LLM 调用 enqueue_task 为每个文档创建总结任务
   # 3. LLM 回复第一个文档的总结
   # 4. 系统自动执行其他文档的总结任务
   
   # 检查 trace 日志
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $toolCalls = $trace | Where-Object { $_.event -eq "tool.call" }
   
   Write-Host "工具调用顺序:"
   $toolCalls | ForEach-Object {
       Write-Host "  - $($_.payload.toolName)"
   }
   ```

3. **测试场景 3：多步骤流程**
   
   ```powershell
   # 在 UI 中发送消息
   # 用户消息：请先读取 README.md，然后分析内容，最后生成报告
   
   # 预期行为：
   # 1. LLM 调用 enqueue_task 创建"分析内容"和"生成报告"任务
   # 2. LLM 读取 README.md 并回复
   # 3. 系统自动执行"分析内容"和"生成报告"任务
   ```

4. **检查 LLM 的 thinking**
   
   ```powershell
   # 查看 LLM 的 thinking（如果启用了 reasoning）
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
   
   # 查看 LLM 的回复
   $responses = $trace | Where-Object { $_.event -eq "llm.response" }
   $responses | ForEach-Object {
       $content = $_.payload.content
       if ($content -match "<think>") {
           Write-Host "LLM thinking:"
           Write-Host $content
       }
   }
   ```

**验收标准**：
- ✅ LLM 能够识别需要分解的任务
- ✅ LLM 能够正确调用 `enqueue_task` 工具
- ✅ LLM 能够提供清晰的 `prompt` 和 `summary`
- ✅ 系统能够自动执行队列中的任务
- ✅ LLM 的 thinking 显示它理解了任务分解的概念

---

## 阶段 2：验证现有基础设施

### 2.1 验证 `enqueue_task` 工具

**目标**：确认 `enqueue_task` 工具已经实现并可以正常工作

**关键文件**：
- `src/agents/tools/enqueue-task-tool.ts` - 工具定义
- `src/agents/clawdbot-tools.ts` - 工具注册

**实施步骤**：

1. **检查工具定义**
   
   ```powershell
   # 查看工具定义
   Get-Content "src/agents/tools/enqueue-task-tool.ts" -Encoding UTF8 | Select-String -Pattern "export function createEnqueueTaskTool" -Context 5,50
   
   # 检查工具 schema
   Get-Content "src/agents/tools/enqueue-task-tool.ts" -Encoding UTF8 | Select-String -Pattern "EnqueueTaskSchema" -Context 5,20
   ```

2. **检查工具注册**
   
   ```powershell
   # 查看工具注册
   Get-Content "src/agents/clawdbot-tools.ts" -Encoding UTF8 | Select-String -Pattern "enqueue_task" -Context 5,10
   ```

3. **检查工具调用**
   
   ```powershell
   # 发送测试消息，触发 LLM 调用 enqueue_task
   # 在 UI 中发送："请生成 3 段内容"
   
   # 检查 trace 日志中的工具调用记录
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $toolCalls = $trace | Where-Object { $_.event -eq "tool.call" -and $_.payload.toolName -eq "enqueue_task" }
   
   if ($toolCalls.Count -gt 0) {
       Write-Host "✅ enqueue_task 工具调用成功" -ForegroundColor Green
       $toolCalls | ForEach-Object {
           Write-Host "  - toolCallId: $($_.payload.toolCallId)"
           Write-Host "    args: $($_.payload.args)"
       }
   } else {
       Write-Host "❌ enqueue_task 工具未被调用" -ForegroundColor Red
   }
   
   # 检查工具返回结果
   $toolResults = $trace | Where-Object { $_.event -eq "tool.result" -and $_.payload.toolName -eq "enqueue_task" }
   $toolResults | ForEach-Object {
       Write-Host "工具返回结果:"
       Write-Host $_.payload.result
   }
   ```

**验收标准**：
- ✅ `enqueue_task` 工具已经实现
- ✅ 工具已经注册到工具列表
- ✅ LLM 可以成功调用工具
- ✅ 工具返回正确的结果（`success: true`）

---


### 2.2 验证队列管理机制

**目标**：确认队列管理机制已经实现并可以正常工作

**关键文件**：
- `src/auto-reply/reply/queue/types.ts` - 队列数据结构
- `src/auto-reply/reply/queue/enqueue.ts` - 入队逻辑
- `src/auto-reply/reply/queue/drain.ts` - 出队逻辑
- `src/auto-reply/reply/queue/state.ts` - 队列存储

**实施步骤**：

1. **检查队列数据结构**
   
   ```powershell
   # 查看 FollowupRun 类型定义
   Get-Content "src/auto-reply/reply/queue/types.ts" -Encoding UTF8 | Select-String -Pattern "export type FollowupRun" -Context 5,20
   
   # 查看 QueueSettings 类型定义
   Get-Content "src/auto-reply/reply/queue/types.ts" -Encoding UTF8 | Select-String -Pattern "export type QueueSettings" -Context 5,20
   ```

2. **检查队列入队逻辑**
   
   ```powershell
   # 查看 enqueueFollowupRun 函数
   Get-Content "src/auto-reply/reply/queue/enqueue.ts" -Encoding UTF8 | Select-String -Pattern "export function enqueueFollowupRun" -Context 5,50
   ```

3. **检查队列出队逻辑**
   
   ```powershell
   # 查看 scheduleFollowupDrain 函数
   Get-Content "src/auto-reply/reply/queue/drain.ts" -Encoding UTF8 | Select-String -Pattern "export function scheduleFollowupDrain" -Context 5,50
   ```

4. **检查队列存储**
   
   ```powershell
   # 查看队列存储实现
   Get-Content "src/auto-reply/reply/queue/state.ts" -Encoding UTF8
   ```

5. **测试队列功能**
   
   ```powershell
   # 发送测试消息，触发 LLM 调用 enqueue_task
   # 在 UI 中发送："请生成 5 段内容"
   
   # 检查队列中的任务数量
   # 注意：队列存储在内存中，需要通过日志查看
   
   # 检查 trace 日志中的队列操作
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $queueEvents = $trace | Where-Object { $_.event -like "*queue*" }
   
   Write-Host "队列相关事件:"
   $queueEvents | ForEach-Object {
       Write-Host "  - event: $($_.event)"
       Write-Host "    payload: $($_.payload | ConvertTo-Json -Compress)"
   }
   
   # 检查任务是否按顺序执行
   $llmResponses = $trace | Where-Object { $_.event -eq "llm.response" }
   Write-Host "LLM 回复顺序:"
   $llmResponses | ForEach-Object {
       $content = $_.payload.content
       if ($content) {
           $preview = $content.Substring(0, [Math]::Min(50, $content.Length))
           Write-Host "  - $preview..."
       }
   }
   ```

**验收标准**：
- ✅ 队列数据结构完整（`FollowupRun`、`QueueSettings`）
- ✅ 入队逻辑正确（`enqueueFollowupRun`）
- ✅ 出队逻辑正确（`scheduleFollowupDrain`）
- ✅ 队列存储可靠（内存 Map）
- ✅ 任务按顺序执行

---

### 2.3 验证任务执行流程

**目标**：确认任务执行流程已经实现并可以正常工作

**关键文件**：
- `src/auto-reply/reply/agent-runner.ts` - 任务执行入口
- `src/agents/tools/enqueue-task-tool.ts` - 上下文传递

**实施步骤**：

1. **检查任务执行入口**
   
   ```powershell
   # 查看 runReplyAgent 函数
   Get-Content "src/auto-reply/reply/agent-runner.ts" -Encoding UTF8 | Select-String -Pattern "export async function runReplyAgent" -Context 5,50
   ```

2. **检查上下文传递**
   
   ```powershell
   # 查看 setCurrentFollowupRunContext 函数
   Get-Content "src/agents/tools/enqueue-task-tool.ts" -Encoding UTF8 | Select-String -Pattern "export function setCurrentFollowupRunContext" -Context 5,20
   
   # 查看 getCurrentFollowupRunContext 函数
   Get-Content "src/agents/tools/enqueue-task-tool.ts" -Encoding UTF8 | Select-String -Pattern "export function getCurrentFollowupRunContext" -Context 5,20
   ```

3. **检查任务标记**
   
   ```powershell
   # 查看 isQueueTask 字段的使用
   Get-Content "src/auto-reply/reply/agent-runner.ts" -Encoding UTF8 | Select-String -Pattern "isQueueTask" -Context 5,10
   ```

4. **测试任务执行**
   
   ```powershell
   # 发送测试消息，触发 LLM 调用 enqueue_task
   # 在 UI 中发送："请生成 3 段内容"
   
   # 检查队列任务是否被正确执行
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   
   # 查找所有 LLM 请求
   $llmPayloads = $trace | Where-Object { $_.event -eq "llm.payload" }
   Write-Host "LLM 请求次数: $($llmPayloads.Count)"
   
   # 查找所有 LLM 回复
   $llmResponses = $trace | Where-Object { $_.event -eq "llm.response" }
   Write-Host "LLM 回复次数: $($llmResponses.Count)"
   
   # 检查每个任务的执行结果
   for ($i = 0; $i -lt $llmResponses.Count; $i++) {
       $response = $llmResponses[$i]
       $content = $response.payload.content
       if ($content) {
           $preview = $content.Substring(0, [Math]::Min(100, $content.Length))
           Write-Host "任务 $($i + 1) 回复: $preview..."
       }
   }
   ```

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

**实施步骤**：

1. **修改 `enqueue_task` 工具**
   
   在 `src/agents/tools/enqueue-task-tool.ts` 的 `execute` 函数中添加循环检测逻辑：
   
   ```typescript
   execute: async (_toolCallId, args) => {
     const params = args as Record<string, unknown>;
     const prompt = readStringParam(params, "prompt", { required: true });
     const summary = readStringParam(params, "summary");
     
     // ... 现有代码 ...
     
     // 从全局上下文获取当前的 FollowupRun
     const currentFollowupRun = getCurrentFollowupRunContext();
     
     if (!currentFollowupRun) {
       return jsonResult({
         success: false,
         error: "currentFollowupRun 未设置，无法加入队列（系统内部错误）",
       });
     }
     
     // 🔧 检测循环：如果当前正在执行队列任务，拒绝加入新任务
     const isQueueTask = currentFollowupRun.isQueueTask ?? false;
     if (isQueueTask) {
       console.warn("[enqueue_task] ⚠️ Cannot enqueue task while executing a queue task");
       return jsonResult({
         success: false,
         error: `❌ 不能在执行队列任务时加入新任务。
   
   ✅ 正确做法：
   1. 直接生成当前任务要求的内容
   2. 不要调用任何工具（包括 enqueue_task）
   3. 完成后系统会自动执行下一个任务
   
   示例：
   任务提示词：请生成第 1 段内容
   → 正确：直接输出"这是第 1 段内容..."
   → 错误：调用 enqueue_task 生成更多任务`,
       });
     }
     
     // ... 现有代码 ...
   }
   ```

2. **修改任务执行流程**
   
   在 `src/auto-reply/reply/agent-runner.ts` 中设置 `isQueueTask` 标记：
   
   ```typescript
   // 在执行用户消息时，设置 isQueueTask = false
   setCurrentFollowupRunContext({ ...followupRun, isQueueTask: false });
   
   // 在执行队列任务时，设置 isQueueTask = true
   // 注意：这需要在队列任务执行的地方添加
   // 具体位置需要查看 queue/drain.ts 中的实现
   ```

3. **添加日志**
   
   ```typescript
   // 在循环检测触发时，记录日志
   console.log(`[enqueue_task] 🔍 Checking loop: isQueueTask=${isQueueTask}`);
   
   if (isQueueTask) {
     console.warn("[enqueue_task] ⚠️ Loop detected! Rejecting enqueue request.");
   }
   
   // 在任务执行时，记录 isQueueTask 状态
   console.log(`[agent-runner] 🔍 Executing task: isQueueTask=${followupRun.isQueueTask}`);
   ```

**验收标准**：
- ✅ 循环检测逻辑正确
- ✅ 队列任务无法调用 `enqueue_task`
- ✅ 用户消息可以调用 `enqueue_task`
- ✅ 日志记录完整
- ✅ 错误消息清晰，提供了正确做法

---


### 3.2 测试循环检测

**目标**：验证循环检测机制是否有效

**实施步骤**：

1. **测试场景 1：正常情况**
   
   ```powershell
   # 在 UI 中发送消息
   # 用户消息：请生成 3 段内容
   
   # 预期行为：
   # 1. LLM 调用 enqueue_task 创建任务 2 和任务 3 ✅
   # 2. LLM 回复第 1 段内容 ✅
   # 3. 系统执行任务 2，LLM 直接回复第 2 段内容（不调用 enqueue_task）✅
   # 4. 系统执行任务 3，LLM 直接回复第 3 段内容（不调用 enqueue_task）✅
   
   # 检查日志
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $toolCalls = $trace | Where-Object { $_.event -eq "tool.call" -and $_.payload.toolName -eq "enqueue_task" }
   
   Write-Host "enqueue_task 调用次数: $($toolCalls.Count)"
   Write-Host "预期: 2 次（只在第一次回复时调用）"
   
   if ($toolCalls.Count -eq 2) {
       Write-Host "✅ 循环检测正常工作" -ForegroundColor Green
   } else {
       Write-Host "❌ 循环检测可能有问题" -ForegroundColor Red
   }
   ```

2. **测试场景 2：循环检测触发**
   
   如果 LLM 在执行任务 2 时尝试调用 `enqueue_task`：
   
   ```powershell
   # 检查工具返回结果
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $toolResults = $trace | Where-Object { $_.event -eq "tool.result" -and $_.payload.toolName -eq "enqueue_task" }
   
   $toolResults | ForEach-Object {
       $result = $_.payload.result | ConvertFrom-Json
       if ($result.success -eq $false -and $result.error -match "不能在执行队列任务时加入新任务") {
           Write-Host "✅ 循环检测成功触发" -ForegroundColor Green
           Write-Host "错误消息: $($result.error)"
       }
   }
   ```

3. **检查日志**
   
   ```powershell
   # 查看循环检测日志
   Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | Select-String -Pattern "Loop detected" -Context 5,5
   
   # 查看任务执行日志
   Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | Select-String -Pattern "isQueueTask" -Context 2,2
   ```

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

**实施步骤**：

1. **检查 Hook 触发逻辑**
   
   ```powershell
   # 查看 Hook 触发逻辑
   Get-Content "src/agents/pi-embedded-runner/run/attempt.ts" -Encoding UTF8 | Select-String -Pattern "hook" -Context 5,10
   ```

2. **添加 Hook 防护**
   
   在 Hook 触发前，检查当前是否在执行队列任务：
   
   ```typescript
   // 在 Hook 触发前添加检查
   import { getCurrentFollowupRunContext } from "../../tools/enqueue-task-tool.js";
   
   // 在 Hook 触发逻辑中
   const currentFollowupRun = getCurrentFollowupRunContext();
   const isQueueTask = currentFollowupRun?.isQueueTask ?? false;
   
   if (isQueueTask) {
     console.log("[hook] Skipping hook trigger during queue task execution");
     return; // 跳过 Hook 触发
   }
   
   // 继续执行 Hook
   // ...
   ```

3. **添加日志**
   
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

---

### 4.2 测试 Hook 防护

**目标**：验证 Hook 防护机制是否有效

**实施步骤**：

1. **创建测试 Hook**
   
   创建一个简单的 Hook，在每次 LLM 回复后触发：
   
   ```json
   // .kiro/hooks/test-hook.json
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

2. **测试场景 1：用户消息**
   
   ```powershell
   # 在 UI 中发送消息
   # 用户消息：你好
   
   # 预期行为：
   # 1. LLM 回复 ✅
   # 2. Hook 触发 ✅
   
   # 检查日志
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $hookEvents = $trace | Where-Object { $_.event -like "*hook*" }
   
   Write-Host "Hook 触发次数: $($hookEvents.Count)"
   Write-Host "预期: 1 次"
   ```

3. **测试场景 2：队列任务**
   
   ```powershell
   # 在 UI 中发送消息
   # 用户消息：请生成 3 段内容
   
   # 预期行为：
   # 1. LLM 调用 enqueue_task 创建任务 2 和任务 3 ✅
   # 2. LLM 回复第 1 段内容 ✅
   # 3. Hook 触发 ✅
   # 4. 系统执行任务 2，LLM 回复第 2 段内容 ✅
   # 5. Hook 不触发 ✅
   # 6. 系统执行任务 3，LLM 回复第 3 段内容 ✅
   # 7. Hook 不触发 ✅
   
   # 检查日志
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $hookEvents = $trace | Where-Object { $_.event -like "*hook*" }
   
   Write-Host "Hook 触发次数: $($hookEvents.Count)"
   Write-Host "预期: 1 次（只在第一次回复时触发）"
   
   if ($hookEvents.Count -eq 1) {
       Write-Host "✅ Hook 防护正常工作" -ForegroundColor Green
   } else {
       Write-Host "❌ Hook 防护可能有问题" -ForegroundColor Red
   }
   ```

4. **检查日志**
   
   ```powershell
   # 查看 Hook 防护日志
   Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | Select-String -Pattern "Skipping hook trigger" -Context 5,5
   ```

**验收标准**：
- ✅ 用户消息执行时，Hook 正常触发
- ✅ 队列任务执行时，Hook 不触发
- ✅ 日志记录完整

---

## 阶段 5：文档和示例

### 5.1 编写用户文档

**目标**：为用户提供清晰的使用说明

**实施步骤**：

1. **创建用户文档**
   
   文件：`docs/intelligent-task-decomposition.md`
   
   内容：
   - 功能介绍
   - 使用场景
   - 示例
   - 常见问题

2. **更新 README**
   
   在 `README.md` 中添加智能任务分解功能的简介。

**验收标准**：
- ✅ 用户文档完整
- ✅ README 更新完成

---

### 5.2 编写开发者文档

**目标**：为开发者提供技术细节

**实施步骤**：

1. **创建开发者文档**
   
   文件：`docs/dev/intelligent-task-decomposition-architecture.md`
   
   内容：
   - 系统架构
   - 数据流
   - 关键文件
   - 扩展指南

2. **更新 AGENTS.md**
   
   在 `AGENTS.md` 中添加智能任务分解相关的开发规范。

**验收标准**：
- ✅ 开发者文档完整
- ✅ AGENTS.md 更新完成

---

### 5.3 创建示例

**目标**：提供可运行的示例代码

**实施步骤**：

1. **创建示例目录**
   
   目录：`examples/intelligent-task-decomposition/`

2. **创建示例脚本**
   
   文件：`examples/intelligent-task-decomposition/test-task-decomposition.mjs`

3. **创建 README**
   
   文件：`examples/intelligent-task-decomposition/README.md`

**验收标准**：
- ✅ 示例目录创建完成
- ✅ 示例脚本可运行
- ✅ README 完整

---

## 阶段 6：测试和优化

### 6.1 单元测试

**目标**：为关键功能编写单元测试

**实施步骤**：

1. **测试 `enqueue_task` 工具**
   
   文件：`src/agents/tools/enqueue-task-tool.test.ts`

2. **测试队列管理**
   
   文件：`src/auto-reply/reply/queue/enqueue.test.ts`

3. **测试循环检测**
   
   文件：`src/agents/tools/enqueue-task-tool.test.ts`

**验收标准**：
- ✅ 单元测试覆盖率 > 80%
- ✅ 所有测试通过

---

### 6.2 集成测试

**目标**：测试完整的任务分解流程

**实施步骤**：

1. **创建集成测试**
   
   文件：`test/intelligent-task-decomposition.e2e.test.ts`

2. **运行集成测试**
   
   ```powershell
   pnpm test test/intelligent-task-decomposition.e2e.test.ts
   ```

**验收标准**：
- ✅ 集成测试通过
- ✅ 所有场景覆盖

---

### 6.3 性能优化

**目标**：优化系统性能，确保高效运行

**实施步骤**：

1. **分析性能瓶颈**
2. **优化队列管理**
3. **优化任务执行**

**验收标准**：
- ✅ 任务执行时间 < 5 秒
- ✅ 队列操作时间 < 100 毫秒

---

## 阶段 7：最终验收

### 7.1 功能验收

**验收清单**：
- ✅ LLM 能够识别需要分解的任务
- ✅ LLM 能够正确调用 `enqueue_task` 工具
- ✅ 系统能够自动执行队列中的任务
- ✅ 循环检测机制有效
- ✅ Hook 防护机制有效
- ✅ 文档和示例完整
- ✅ 单元测试和集成测试通过
- ✅ 性能满足要求

---

### 7.2 用户验收

**实施步骤**：

1. 邀请用户测试
2. 收集反馈
3. 修复问题

**验收标准**：
- ✅ 用户满意度 > 90%
- ✅ 所有关键问题已修复

---

### 7.3 发布准备

**实施步骤**：

1. 更新 CHANGELOG
2. 更新版本号
3. 创建发布说明

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

**版本**：v20260204_1  
**最后更新**：2026-02-04  
**变更**：创建详细的、可落地的实施任务列表
