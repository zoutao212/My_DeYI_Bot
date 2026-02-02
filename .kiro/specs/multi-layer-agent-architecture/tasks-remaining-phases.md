# 剩余阶段概述（阶段 4-8）

## 阶段 4：任务调度层适配器（第 7-8 周）

### 目标
创建适配器，将管家层的任务委托接口连接到现有的任务分解系统。

### 关键任务
1. **创建 DelegationAdapter**
   - 文件：`src/agents/task-board/delegation-adapter.ts`
   - 将 `TaskDelegationRequest` 转换为 TaskBoard 格式
   - 将 TaskBoard 结果转换为 `TaskDelegationResponse`

2. **集成现有 TaskBoard**
   - 复用 `src/agents/task-board/orchestrator.ts`
   - 复用 `src/agents/task-board/executor.ts`
   - 复用 `src/agents/task-board/progress-tracker.ts`

3. **实现进度回调**
   - 将 TaskBoard 的进度事件转换为 `TaskProgress`
   - 调用 `onProgress` 回调

4. **单元测试**
   - 测试适配器转换逻辑
   - 测试与 TaskBoard 的集成

---

## 阶段 5：执行层封装（第 9-10 周）

### 目标
封装现有的工具系统和技能系统，提供统一的执行接口。

### 关键任务
1. **创建 ToolExecutor**
   - 文件：`src/agents/execution/tool-executor.ts`
   - 封装 `src/agents/pi-tools.ts`
   - 提供统一的工具调用接口

2. **创建 SkillExecutor**
   - 文件：`src/agents/execution/skill-executor.ts`
   - 封装技能调用逻辑
   - 提供统一的技能调用接口

3. **实现错误处理**
   - 捕获所有工具调用错误
   - 返回标准的错误响应

4. **单元测试**
   - 测试工具调用
   - 测试技能调用
   - 测试错误处理

---

## 阶段 6：多层架构协调器（第 11-12 周）

### 目标
实现多层架构的协调器，管理各层之间的通信和切换。

### 关键任务
1. **创建 MultiLayerCoordinator**
   - 文件：`src/agents/multi-layer/coordinator.ts`
   - 管理虚拟世界层、管家层、执行层的实例
   - 处理层之间的消息路由

2. **实现层次切换逻辑**
   - 根据 `agentLayer` 参数选择对应的层
   - 处理虚拟世界层到管家层的转发

3. **集成到 Pi Agent Core**
   - 修改 `src/agents/pi-embedded-runner/run/attempt.ts`
   - 在 `runEmbeddedAttempt` 中注入多层架构逻辑

4. **单元测试**
   - 测试层次切换
   - 测试消息路由
   - 测试与 Pi Agent Core 的集成

---

## 阶段 7：System Prompt 分层优化（第 13-14 周）

### 目标
优化 System Prompt 构建，根据层次选择性包含提示词内容。

### 关键任务
1. **扩展 buildEmbeddedSystemPrompt**
   - 文件：`src/agents/pi-embedded-runner/system-prompt.ts`
   - 添加 `agentLayer` 参数
   - 根据层次选择性包含提示词

2. **虚拟世界层 System Prompt**
   - 只包含角色设定
   - 不包含工具使用提示词
   - 不包含底层系统提示词

3. **管家层 System Prompt**
   - 包含任务委托相关提示词
   - 包含独立技能的使用说明
   - 不包含底层工具的详细说明

4. **执行层 System Prompt**
   - 包含工具使用提示词
   - 包含工具参数说明
   - 包含错误处理说明

5. **Token 消耗测试**
   - 测试虚拟世界层的 token 消耗
   - 测试管家层的 token 消耗
   - 测试执行层的 token 消耗
   - 验证预期节省 30-50%

---

## 阶段 8：集成测试和文档（第 15-16 周）

### 目标
完成端到端集成测试，编写完整的文档和示例。

### 关键任务
1. **端到端集成测试**
   - 测试虚拟世界层 → 管家层 → 任务调度层 → 执行层的完整流程
   - 测试对话前后的任务调度
   - 测试 System Prompt 分层优化

2. **性能测试**
   - 测试系统延迟（不超过 20%）
   - 测试 token 消耗（降低 30-50%）
   - 测试并发性能

3. **编写用户文档**
   - 创建 `docs/multi-layer-agent-architecture.md`
   - 说明如何使用多层架构
   - 说明如何配置不同的层次

4. **编写开发者文档**
   - 创建 `docs/dev/multi-layer-architecture.md`
   - 说明架构设计和组件职责
   - 说明如何扩展和定制

5. **创建示例和教程**
   - 创建 `examples/multi-layer-agent/`
   - 提供虚拟世界层的示例
   - 提供管家层的示例
   - 提供完整流程的示例

6. **迁移指南**
   - 创建 `docs/migration/multi-layer-architecture.md`
   - 说明如何从旧架构迁移到新架构
   - 提供迁移检查清单

---

## 总体时间线

| 阶段 | 时间 | 关键里程碑 |
|------|------|-----------|
| 阶段 1 | 第 1-2 周 | 基础设施准备完成 |
| 阶段 2 | 第 3-4 周 | 虚拟世界层实现完成 |
| 阶段 3 | 第 5-6 周 | 管家层实现完成 |
| 阶段 4 | 第 7-8 周 | 任务调度层适配器完成 |
| 阶段 5 | 第 9-10 周 | 执行层封装完成 |
| 阶段 6 | 第 11-12 周 | 多层架构协调器完成 |
| 阶段 7 | 第 13-14 周 | System Prompt 分层优化完成 |
| 阶段 8 | 第 15-16 周 | 集成测试和文档完成 |

**总计**：16 周（约 4 个月）

---

## 下一步

如果需要更详细的任务列表，可以为每个阶段创建独立的详细任务文件（类似 `tasks-phase1.md`、`tasks-phase2.md`、`tasks-phase3.md`）。

当前已创建的详细任务文件：
- ✅ `tasks-phase1.md`：阶段 1 详细任务（22 个任务）
- ✅ `tasks-phase2.md`：阶段 2 详细任务（15 个任务）
- ✅ `tasks-phase3.md`：阶段 3 详细任务（14 个任务）

待创建的详细任务文件：
- ⏳ `tasks-phase4.md`：阶段 4 详细任务
- ⏳ `tasks-phase5.md`：阶段 5 详细任务
- ⏳ `tasks-phase6.md`：阶段 6 详细任务
- ⏳ `tasks-phase7.md`：阶段 7 详细任务
- ⏳ `tasks-phase8.md`：阶段 8 详细任务
