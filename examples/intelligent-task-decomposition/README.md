# 智能任务分解系统 - 示例

本目录包含智能任务分解系统的使用示例。

## 前提条件

1. 构建项目：
   ```bash
   pnpm build
   ```

2. 确保 Node.js 版本 >= 22

## 示例列表

### 1. 基本使用示例 (`basic-usage.mjs`)

演示如何使用 Orchestrator 创建任务树、添加子任务、执行任务、恢复任务。

**运行方法**：
```bash
node examples/intelligent-task-decomposition/basic-usage.mjs
```

**预期输出**：
- 创建任务树
- 添加 2 个子任务
- 执行子任务
- 渲染任务树为 Markdown
- 检查未完成的任务
- 恢复任务树

**文件位置**：
- 任务树文件：`~/.clawdbot/tasks/{sessionId}/TASK_TREE.json`
- 任务树 Markdown：`~/.clawdbot/tasks/{sessionId}/TASK_TREE.md`
- 检查点目录：`~/.clawdbot/tasks/{sessionId}/checkpoints/`

## 核心组件

### Orchestrator（协调器）

协调所有组件，实现完整的任务分解流程。

**主要方法**：
- `initializeTaskTree(rootTask, sessionId)` - 初始化任务树
- `addSubTask(taskTree, prompt, summary)` - 添加子任务
- `executeSubTask(taskTree, subTask, executor)` - 执行子任务
- `hasUnfinishedTasks(sessionId)` - 检查是否有未完成的任务
- `recoverUnfinishedTasks(sessionId)` - 恢复未完成的任务
- `loadTaskTree(sessionId)` - 加载任务树
- `saveTaskTree(taskTree)` - 保存任务树
- `renderTaskTreeToMarkdown(taskTree)` - 渲染任务树为 Markdown

### TaskTreeManager（任务树管理器）

负责任务树的持久化、加载、更新和检查点管理。

**主要方法**：
- `initialize(rootTask, sessionId)` - 初始化任务树
- `save(taskTree)` - 保存任务树（原子写入）
- `load(sessionId)` - 加载任务树
- `updateSubTaskStatus(taskTree, subTaskId, status)` - 更新子任务状态
- `createCheckpoint(taskTree)` - 创建检查点
- `restoreFromCheckpoint(taskTree, checkpointId)` - 从检查点恢复
- `renderToMarkdown(taskTree)` - 渲染任务树为 Markdown

### RetryManager（重试管理器）

负责判断错误是否可重试、执行重试逻辑、记录失败日志。

**主要方法**：
- `isRetryable(error)` - 判断错误是否可重试
- `executeWithRetry(subTask, executor, maxRetries)` - 执行任务并自动重试
- `logFailure(subTask, error, sessionId)` - 记录失败日志
- `getFailureLogs(sessionId)` - 获取失败日志

### ErrorHandler（错误处理器）

负责处理各种错误、记录错误日志、尝试恢复。

**主要方法**：
- `handleError(error, context, sessionId)` - 处理错误
- `logError(errorType, error, context, sessionId)` - 记录错误日志
- `getErrorLogs(sessionId)` - 获取错误日志
- `tryRecover(error, context)` - 尝试恢复

### RecoveryManager（恢复管理器）

负责检测未完成的任务、恢复任务树、重新执行中断的任务。

**主要方法**：
- `hasUnfinishedTasks(sessionId)` - 检查是否有未完成的任务
- `recoverUnfinishedTasks(sessionId)` - 恢复未完成的任务
- `identifyInterruptedTasks(taskTree)` - 识别中断的任务
- `reexecuteInterruptedTasks(taskTree, interruptedTasks)` - 重新执行中断的任务

## 文件系统结构

```
~/.clawdbot/tasks/{sessionId}/
  ├── TASK_TREE.json          # 任务树主文件
  ├── TASK_TREE.json.bak      # 任务树备份文件
  ├── TASK_TREE.md            # 任务树 Markdown 格式
  ├── checkpoints/            # 检查点目录
  │   ├── {checkpointId}.json
  │   └── ...
  ├── failures.log            # 失败日志
  └── errors.log              # 错误日志
```

## 数据结构

### TaskTree（任务树）

```typescript
interface TaskTree {
  id: string;                 // 任务树 ID（通常是 sessionId）
  rootTask: string;           // 根任务描述
  subTasks: SubTask[];        // 所有子任务
  status: "pending" | "active" | "completed" | "failed";
  createdAt: number;          // 创建时间戳
  updatedAt: number;          // 更新时间戳
  checkpoints: string[];      // 检查点 ID 列表
}
```

### SubTask（子任务）

```typescript
interface SubTask {
  id: string;                 // 子任务 ID
  prompt: string;             // 任务提示词
  summary: string;            // 任务简短描述
  status: "pending" | "active" | "completed" | "failed" | "interrupted";
  output?: string;            // 任务输出
  error?: string;             // 错误信息
  retryCount: number;         // 重试次数
  createdAt: number;          // 创建时间戳
  completedAt?: number;       // 完成时间戳
}
```

## 注意事项

1. **原子写入**：所有文件写入都使用原子写入（先写临时文件，再重命名），确保数据一致性
2. **备份机制**：每次保存前会备份当前文件到 `.bak`，如果主文件损坏可以从备份恢复
3. **检查点管理**：最多保留 10 个检查点，超过后会删除最旧的检查点
4. **重试策略**：使用指数退避（1s, 2s, 4s），最多重试 3 次
5. **错误分类**：错误分为 LLM 请求失败、文件系统失败、内存不足、系统崩溃四类

## 故障排查

### 问题 1：任务树文件损坏

**症状**：无法加载任务树，报错 "Failed to load task tree"

**解决方案**：
1. 检查备份文件：`~/.clawdbot/tasks/{sessionId}/TASK_TREE.json.bak`
2. 如果备份文件存在，系统会自动从备份恢复
3. 如果备份文件也损坏，检查检查点目录：`~/.clawdbot/tasks/{sessionId}/checkpoints/`

### 问题 2：任务执行失败

**症状**：任务状态为 "failed"，错误日志中有错误信息

**解决方案**：
1. 查看失败日志：`~/.clawdbot/tasks/{sessionId}/failures.log`
2. 查看错误日志：`~/.clawdbot/tasks/{sessionId}/errors.log`
3. 根据错误类型采取相应措施：
   - LLM 请求失败：检查网络连接、API 配置
   - 文件系统失败：检查文件权限、磁盘空间
   - 内存不足：释放内存、增加系统内存
   - 系统崩溃：从检查点恢复

### 问题 3：任务恢复失败

**症状**：无法恢复未完成的任务

**解决方案**：
1. 检查任务树文件是否存在
2. 检查检查点文件是否存在
3. 手动加载任务树并检查状态
4. 如果所有检查点都损坏，需要重新开始任务

## 更多信息

- 用户文档：`docs/intelligent-task-decomposition.md`
- 开发者文档：`docs/dev/intelligent-task-decomposition-architecture.md`
- 设计文档：`.kiro/specs/intelligent-task-decomposition/design.md`
- 需求文档：`.kiro/specs/intelligent-task-decomposition/requirements.md`
