---
trigger: always_on
---
--================================================================================
  Clawdbot 智能任务分解系统 - 完整调查报告
  生成时间: 2026-02-09（P0-P4 修复后更新）
--================================================================================

目录
  第一部分：系统概述与架构总览
  第二部分：核心组件清单与职责
  第三部分：完整调用链梳理（7个阶段）
  第四部分：数据模型分析
  第五部分：断裂点与已知问题
  第六部分：改进方向与建议
  第七部分：设计文档vs实际代码对照表
  第八部分：结论与优先级排序
  第九部分：端到端验收测试任务（30步 · 长篇小说生成+Telegram交付）

--================================================================================
第一部分：系统概述与架构总览
--================================================================================

1.1 系统定位
  LLM驱动的自动化任务管理框架，核心能力：
  - 任务识别与分解：LLM自主判断，自动拆分复杂任务
  - 递归分解：支持最多3层（自适应深度控制）
  - 自动队列执行：子任务自动排队、执行、推进
  - AI自主质量评估：分解后、子任务完成后、整体完成后
  - 动态调整：continue/adjust/restart/overthrow
  - 失败学习：记录失败经验，下次参考
  - 文件产出追踪与兜底落盘
  - 合并输出与交付报告生成

1.2 技术栈
  TypeScript(ESM), Node22+/Bun, completeSimple(pi-ai)+auth profiles
  持久化:JSON文件(~/.clawdbot/tasks/{sessionId}/)
  队列:内存队列(FOLLOWUP_QUEUES Map)
  并行:Promise.allSettled

1.3 核心目录
  src/agents/intelligent-task-decomposition/ (核心，20+文件)
  src/agents/tools/enqueue-task-tool.ts (入口工具)
  src/auto-reply/reply/followup-runner.ts (执行引擎)
  src/auto-reply/reply/queue/drain.ts (队列调度)
  .kiro/specs/ (设计文档3组)

--================================================================================
第二部分：核心组件清单与职责
--================================================================================

2.1 Orchestrator（任务协调器）- 中枢大脑
  文件：orchestrator.ts（~1885行，最大文件；P0-P4修复后增加约130行）
  职责：协调所有组件，管理完整任务生命周期
  主要方法：
    initializeTaskTree()                - 创建任务树+FileManager+复杂度评分
    addSubTask()                        - 添加子任务（深度计算、状态守卫）
    executeSubTask()                    - 执行子任务（重试+文件追踪+委托postProcess）
    ★ postProcessSubTaskCompletion()   - [P0新增] 公共后处理（质检+决策+文件验证+交付+持久化）
    ★ ensureFileManager()              - [P0新增] 延迟初始化FileManager（followup-runner路径兜底）
    ★ shouldAutoDecompose()            - [P2新增] 轻量前置检查（prompt>500字符+深度未满）
    ★ mergeRoundOutputs()              - [P4新增] 统一合并入口（委托FileManager.mergeTaskOutputs）
    decomposeSubTask()                  - 递归分解（LLM分解+质量评估）
    adjustTaskTree()                    - 动态调整（验证+应用变更）
    isRoundCompleted()                  - 轮次完成判定（rootTaskId隔离）
    markRoundCompleted()                - 标记轮次完成
    getExecutableTasks()                - 获取可执行任务（依赖检查+汇总注入+批量分组）
    reviewSubTaskCompletion()           - 子任务质量评估
    reviewRoundCompletion()             - 轮次整体质量评估
    generateFinalDeliverable()          - 生成最终交付产物
    generateDeliveryReport()            - 生成结构化交付报告
    calculateAdaptiveMaxDepth()         - 自适应深度控制
    validateDecomposition()             - 分解验证（循环依赖检测）
    renderTaskBoard()                   - 任务看板渲染
    buildTaskContextPrompt()            - 构建任务上下文注入SystemPrompt

2.2 enqueue_task工具 - 入口大门
  文件：enqueue-task-tool.ts（409行）
  核心逻辑：
    全局Orchestrator单例（globalOrchestrator）
    全局FollowupRun上下文（currentFollowupRunContext）
    循环检测（融合3层：isQueueTask + isRootTask + depth guard）
    轮次隔离（rootTaskId: UUID，同一次用户消息共享）
    自适应深度控制（首次入队自动计算maxDepth）
    参数验证（isNewRootTask与parentId互斥）
    构建FollowupRun并enqueueFollowupRun()

2.3 followup-runner - 执行引擎
  文件：followup-runner.ts（~701行；P0-P4修复后约+20行）
  核心流程（修复后）：
    1)  加载任务树，查找子任务（subTaskId精确匹配/prompt回退）
    2)  ★[P2] shouldAutoDecompose() 前置检查 → 命中则调 decomposeSubTask() 并跳过直接执行
    3)  启动文件追踪 beginTracking()
    4)  设置全局上下文 setCurrentFollowupRunContext()
    5)  注入强制落盘指令到prompt本体
    6)  注入兄弟上下文到extraSystemPrompt（buildSiblingContext）
    7)  调用runEmbeddedPiAgent()执行LLM（含model fallback）
    8)  收集文件追踪结果 collectTrackedFiles()
    9)  兜底落盘（LLM未调用write时自动保存）
    10) Session瘦身（截断超长assistant消息）
    11) ★[P0+P1] 调用 postProcessSubTaskCompletion()（统一质检+决策响应+文件验证+持久化）
        - restart → 重置 pending + finalizeWithFollowup() 重新入队
        - overthrow → 标记 failed + return 停止执行
        - adjust → 内部自动应用 TaskAdjuster 变更
    12) 轮次完成检查
    13) ★[P4] 轮次完成后：mergeRoundOutputs()统一合并+交付报告+内存归档

2.4 drain.ts - 队列调度器
  文件：drain.ts（281行）
  守卫机制：
    守卫A：任务树全局status已终结 -> 丢弃残留
    守卫B：rootTaskId轮次完成 -> 逐项检查，丢弃已完成的
    守卫C：单个子任务已completed/failed -> 跳过
  并行执行：
    dependency-analyzer.findParallelGroups() 检测无依赖任务
    Promise.allSettled() 并发执行

2.5 LLMTaskDecomposer - 分解大脑
  文件：llm-task-decomposer.ts（616行）
  核心方法：
    canDecompose()          - 判断可分解性（深度/已分解/复杂度）
    decomposeRecursively()  - 递归分解（构建prompt->LLM->解析）
    decomposeWithLessons()  - 基于失败经验改进分解
    generateAdjustments()   - 生成调整方案
    estimateTask()          - 估算复杂度和时长
    detectWritingTask()     - 自动识别写作任务
  降级：LLM失败时降级到规则驱动（返回2个默认子任务）

2.6 QualityReviewer - 质检官
  文件：quality-reviewer.ts（714行）
  评估触发点：
    reviewDecomposition()       - 初始分解后
    reviewSubTaskCompletion()   - 子任务完成后
    reviewOverallCompletion()   - 所有子任务完成后
    analyzeFailure()            - 任务失败后
  决策：continue / adjust / restart / overthrow
  降级：LLM失败时默认"passed"+"continue"

2.7 TaskTreeManager - 持久化管家
  文件：task-tree-manager.ts（986行）
  特性：原子写入(.tmp->rename), 自动备份(.bak), 检查点(最多10个),
        rootTaskId作用域更新, Markdown同步渲染

2.8 FileManager - 文件系统
  文件：file-manager.ts（558行）
  目录：~/.clawdbot/tasks/{sessionId}/
    TASK_TREE.json, metadata/, checkpoints/, logs/,
    tasks/{subTaskId}/, deliverables/, fallback-outputs/, temp/

2.9 其他辅助组件
  SystemLLMCaller(120行)   - LLM调用桥接层
  BatchExecutor(372行)     - 批量执行器（合并prompt，拆分输出）
  TaskGrouper              - 任务分组器
  DeliveryReporter(178行)  - 结构化交付报告
  ComplexityScorer         - 复杂度评分器
  DependencyAnalyzer       - 依赖分析+并行组检测
  FileTracker              - 文件追踪器
  TaskAdjuster(397行)      - 任务动态调整器
  OutputFormatter          - 输出格式化器
  RetryManager             - 重试管理器（指数退避）
  ErrorHandler             - 错误处理器
  RecoveryManager          - 恢复管理器（断点恢复）

--================================================================================
第三部分：完整调用链梳理（7个阶段）
--================================================================================

阶段1：任务创建
  触发：用户消息 -> LLM判断需要分解 -> 调用enqueue_task
  调用链：
    用户消息 -> agent-runner -> LLM -> enqueue_task.execute()
      -> 循环检测(isQueueTask/isRootTask/depth guard)
      -> 参数验证(isNewRootTask与parentId互斥)
      -> orchestrator.loadTaskTree() / initializeTaskTree()
      -> calculateAdaptiveMaxDepth()（首次）
      -> 轮次ID管理（生成/继承rootTaskId）
      -> orchestrator.addSubTask()
      -> 构建FollowupRun(isQueueTask/isRootTask/taskDepth/subTaskId/rootTaskId)
      -> enqueueFollowupRun() 入队

  数据流：
    prompt+summary+parentId+waitForChildren+isNewRootTask
      -> SubTask{id,prompt,summary,status:"pending",depth,rootTaskId}
      -> FollowupRun{prompt,subTaskId,rootTaskId,isQueueTask,taskDepth}
      -> FOLLOWUP_QUEUES.get(key).items.push(followupRun)

阶段2：任务分解（可选的递归分解）
  触发：orchestrator.decomposeSubTask()被调用
  调用链：
    orchestrator.decomposeSubTask(taskTree, subTaskId)
      -> llmDecomposer.canDecompose()
      -> llmDecomposer.decomposeRecursively()
        -> buildDecompositionPrompt()（含祖先上下文）
        -> callLLM()（优先系统管线，降级规则驱动）
        -> parseDecompositionResponse()（JSON解析+写作检测）
      -> qualityReviewer.reviewDecomposition()
        -> continue: 通过
        -> adjust: adjustTaskTree()
        -> restart: restartDecomposition()（保留经验重新分解）
        -> overthrow: overthrowDecomposition()（完全推翻）
      -> taskTreeManager.addSubTask()
      -> markAsDecomposed()

  ★ [P2修复后] 递归分解已在 followup-runner 中自动触发：
    shouldAutoDecompose() 判断 prompt>500字符且深度未满 → 命中时调用 decomposeSubTask()
    分解成功后跳过直接执行，子任务作为 pending 被后续 drain 拾取。
    LLM通过 enqueue_task 直接创建的扁平子任务(depth=0)如果 prompt较短，
    仍然直接执行不会被分解，这是符合预期的行为。

阶段3：任务执行
  触发：drain.ts调度 -> followup-runner执行
  调用链：
    scheduleFollowupDrain(key, runFollowup)
      -> drain while循环
        -> 守卫A：任务树全局status检查
        -> 守卫B：rootTaskId轮次完成检查
        -> 守卫C：单个子任务状态检查
        -> 并行组检测 findParallelGroups()
          -> Promise.allSettled() 并发
        -> 逐个执行 runFollowup(next)

    followup-runner(queued)
      -> 1.加载任务树+查找子任务(subTaskId精确/prompt回退)
      -> 2.启动文件追踪 beginTracking(subTask.id)
      -> 3.设置全局上下文 setCurrentFollowupRunContext()
      -> 4.注入强制落盘指令到prompt本体
      -> 5.注入兄弟上下文到extraSystemPrompt
      -> 6.调用runEmbeddedPiAgent()执行LLM(含model fallback)
      -> 7.收集结果+更新子任务状态
      -> 8.收集文件追踪 collectTrackedFiles()
      -> 9.兜底落盘（见阶段5）
      -> 10.质量评估（见阶段4）
      -> 11.轮次完成检查（见阶段6）
      -> 12.发送回复 sendFollowupPayloads()

阶段4：质量评估
  触发点1：followup-runner中子任务执行完成后（通过postProcessSubTaskCompletion）
  触发点2：followup-runner中轮次完成后（整体评估）
  调用链（P0+P1修复后）：
    orchestrator.postProcessSubTaskCompletion(taskTree, subTask)
      -> qualityReviewer.reviewSubTaskCompletion()
        -> 构建评估prompt
        -> 调用LLM评估
        -> parseReviewResponse()
        -> 保存到quality-reviews.jsonl + subTask.metadata.qualityReview
    结果处理（决策已真正生效）：
      continue  -> 正常继续
      adjust    -> 自动调用 adjustTaskTree() 应用 TaskAdjuster 变更
      restart   -> 重置 pending + retryCount++ + needsRequeue=true → followup-runner 重新入队
      overthrow -> 标记 failed + markedFailed=true → followup-runner 停止后续执行

  ★ [已修复] followup-runner 不再自己调用 reviewSubTaskCompletion()，
    而是统一委托 postProcessSubTaskCompletion()，质检决策与 executeSubTask()
    完全对齐，4种决策分支均真正生效。

阶段5：落盘（文件持久化）
  三层落盘策略：

  第1层：LLM主动落盘（理想情况）
    LLM遵循prompt强制规则 -> 调用write工具写文件
    file-tracker.ts自动追踪 -> collectTrackedFiles()收集路径

  第2层：系统兜底落盘（LLM偷懒时）
    followup-runner检测LLM是否调用write/send_file
    未调用且输出>500字 -> 自动保存到fallback-outputs/{subTaskId}.txt
    记录到metadata.fallbackFilePath
    立即sendFallbackFile()发送到用户频道
    Session瘦身：截断超长assistant消息

  第3层：Orchestrator输出保存
    orchestrator.executeSubTask()中 -> fileManager.saveTaskOutput()
    保存到tasks/{subTaskId}/output.txt
    保存元数据+时间线事件

阶段6：总结与合并
  触发：followup-runner检测到轮次完成后
  调用链：
    orchestrator.isRoundCompleted() === true
      -> orchestrator.markRoundCompleted()

    ★[P4修复后] 统一合并逻辑：
      -> orchestrator.mergeRoundOutputs(taskTree)
        -> ensureFileManager() 延迟初始化
        -> FileManager.mergeTaskOutputs() 三策略合并：
           策略1：producedFilePaths（LLM主动写入的文件）
           策略2：artifacts（子任务产物目录）
           策略3：output.txt（兜底文本输出）
      -> sendFallbackFile() 发送合并文件

    生成交付报告：
      -> DeliveryReporter.generateReport()
      -> reporter.formatAsMarkdown()
      -> sendFollowupPayloads()发送

    内存归档（异步fire-and-forget）：
      -> createMemoryService().archive()

  汇总任务机制（getExecutableTasks中）：
    所有非根任务完成 -> 根任务变为可执行
    自动收集子任务输出注入根任务prompt
    添加汇总指令（整合内容、保持连贯）

  ★ [P4修复后] 合并逻辑已统一为两层：
    1) mergeRoundOutputs()（轮次级合并，替代旧的三套逻辑）
    2) getExecutableTasks汇总注入（仍保留，用于根任务prompt组装，定位不同）

阶段7：交付与发送
  交付产物类型：
    1) 兜底落盘文件（单个.txt）
    2) 合并兜底文件（merged_output.txt）
    3) 交付报告（Markdown）
    4) 最终交付产物（generateFinalDeliverable）
    5) 汇总任务文件输出
  发送通道：
    sendFallbackFile() - 多频道路由
    sendFollowupPayloads() - 文本/媒体
    Orchestrator.sendFileToChannel() - 仅Telegram
    Orchestrator.sendFileToTelegram() - Telegram Bot API

##
## C:\Users\zouta\.clawdbot\tasks\对应任务的 数据内容 本次任务ID 
## TASK_TREE.json: 任务树主文件（JSON 格式）
## C:\Users\zouta\.clawdbot\agents\main\sessions
## 实际请求 内容 
## C:\Users\zouta\.clawdbot\runtimelog
## 运行时日志

## 所有的构建 和 测试 不需要 你 随便 启动构建和 测试 
## 因为 构建 需要 很久，你的测试全是没用的垃圾 ！用户 会自己构建和测试！  你只需要分析问题修复问题！