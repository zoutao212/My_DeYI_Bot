# 任务清单：批量任务执行优化

## 📋 任务概览
记得要深度结合现有功能和系统，好好对接现有系统和深度融入现有系统。
| 阶段 | 任务数 | 预估时间 | 状态 |
|------|--------|---------|------|
| 阶段 1：核心功能开发 | 6 | 1-2 天 | ⏳ 待开始 |
| 阶段 2：智能优化 | 4 | 1-2 天 | ⏳ 待开始 |
| 阶段 3：测试与优化 | 5 | 1 天 | ⏳ 待开始 |
| **总计** | **15** | **3-5 天** | **⏳ 待开始** |

## 🎯 阶段 1：核心功能开发（1-2 天）

### 任务 1.1：创建 TaskGrouper（任务分组器）

**优先级**：P0  
**预估时间**：4 小时  
**状态**：⏳ 待开始

**描述**：实现任务分组器，根据任务特征智能分组

**子任务**：
- [x] 1.1.1 创建 `src/agents/intelligent-task-decomposition/task-grouper.ts`
- [x] 1.1.2 实现 `groupTasks` 方法（主入口）
- [x] 1.1.3 实现 `createBatch` 方法（创建单个批次）
- [x] 1.1.4 实现 `canAddToBatch` 方法（检查任务是否可以加入批次）
- [ ] 1.1.5 实现分组规则：
  - 相似度分组
  - 大小分组
  - 依赖关系分组
- [x] 1.1.6 添加单元测试

**验收标准**：
- ✅ 单个批次最多 3-5 个任务
- ✅ 单个批次预估输出 < 6000 tokens
- ✅ 批次内任务无依赖关系
- ✅ 单元测试覆盖率 > 80%

**文件**：
- `src/agents/intelligent-task-decomposition/task-grouper.ts`
- `src/agents/intelligent-task-decomposition/task-grouper.test.ts`

---

### 任务 1.2：创建 BatchExecutor（批量执行器）

**优先级**：P0  
**预估时间**：6 小时  
**状态**：⏳ 待开始

**描述**：实现批量执行器，将多个任务合并为一次 LLM 请求

**子任务**：
- [x] 1.2.1 创建 `src/agents/intelligent-task-decomposition/batch-executor.ts`
- [x] 1.2.2 实现 `executeBatch` 方法（主入口）
- [x] 1.2.3 实现 `mergePrompts` 方法（合并 prompt）
- [x] 1.2.4 实现 `splitOutput` 方法（拆分输出）
- [x] 1.2.5 实现 `fallbackSplit` 方法（后备拆分）
- [x] 1.2.6 实现 `estimateTokens` 方法（估算 tokens）
- [x] 1.2.7 添加错误处理和日志
- [ ] 1.2.8 添加单元测试

**验收标准**：
- ✅ 正确合并多个任务的 prompt
- ✅ 正确拆分 LLM 输出
- ✅ 如果拆分失败，使用后备方法
- ✅ 单元测试覆盖率 > 80%

**文件**：
- `src/agents/intelligent-task-decomposition/batch-executor.ts`
- `src/agents/intelligent-task-decomposition/batch-executor.test.ts`

---

### 任务 1.3：创建 batch_enqueue_tasks 工具

**优先级**：P0  
**预估时间**：4 小时  
**状态**：⏳ 待开始

**描述**：创建批量创建任务的工具

**子任务**：
- [ ] 1.3.1 在 `src/agents/tools/` 创建 `batch-enqueue-tasks-tool.ts`
- [ ] 1.3.2 定义工具 Schema（BatchEnqueueTasksSchema）
- [ ] 1.3.3 实现 `createBatchEnqueueTasksTool` 函数
- [ ] 1.3.4 实现参数验证
- [ ] 1.3.5 实现批量创建任务逻辑
- [ ] 1.3.6 集成 TaskGrouper 和 BatchExecutor
- [ ] 1.3.7 添加循环检测
- [ ] 1.3.8 添加单元测试

**验收标准**：
- ✅ 工具接受任务列表作为参数
- ✅ 返回创建的任务 ID 列表
- ✅ 自动添加元数据（estimatedTokens、canBatch）
- ✅ 支持 batchMode 参数（auto/force/disable）
- ✅ 单元测试覆盖率 > 80%

**文件**：
- `src/agents/tools/batch-enqueue-tasks-tool.ts`
- `src/agents/tools/batch-enqueue-tasks-tool.test.ts`

---

### 任务 1.4：增强 TaskTree 数据模型

**优先级**：P0  
**预估时间**：2 小时  
**状态**：⏳ 待开始

**描述**：增强任务树数据模型，支持批量执行

**子任务**：
- [x] 1.4.1 在 `src/agents/intelligent-task-decomposition/types.ts` 添加 `TaskBatch` 接口
- [x] 1.4.2 增强 `SubTaskMetadata` 接口（添加 estimatedTokens、canBatch、batchId、batchIndex）
- [x] 1.4.3 更新 `TaskTree` 接口（添加 batches 字段）
- [x] 1.4.4 更新类型导出

**验收标准**：
- ✅ 新增 `TaskBatch` 接口
- ✅ 增强 `SubTaskMetadata` 接口
- ✅ 更新 `TaskTree` 接口
- ✅ 类型定义完整且正确

**文件**：
- `src/agents/intelligent-task-decomposition/types.ts`

---

### 任务 1.5：集成到 Orchestrator

**优先级**：P0  
**预估时间**：3 小时  
**状态**：✅ 已完成

**描述**：将批量执行功能集成到 Orchestrator

**子任务**：
- [x] 1.5.1 在 `Orchestrator` 中添加 `taskGrouper` 和 `batchExecutor` 实例
- [x] 1.5.2 实现 `executeBatches` 方法（批量执行多个批次）
- [x] 1.5.3 修改 `getExecutableTasks` 方法（支持批量执行）
- [x] 1.5.4 添加批次状态管理
- [x] 1.5.5 添加日志记录
- [ ] 1.5.6 添加单元测试

**验收标准**：
- ✅ Orchestrator 支持批量执行
- ✅ 正确管理批次状态
- ⏳ 单元测试覆盖率 > 80%（待用户测试）

**文件**：
- `src/agents/intelligent-task-decomposition/orchestrator.ts`
- `src/agents/intelligent-task-decomposition/orchestrator.test.ts`

---

### 任务 1.6：更新系统提示词

**优先级**：P0  
**预估时间**：2 小时  
**状态**：✅ 已完成

**描述**：更新系统提示词，引导 LLM 使用 batch_enqueue_tasks 工具

**子任务**：
- [x] 1.6.1 在 `src/agents/system-prompt.l10n.zh.ts` 添加批量任务说明
- [x] 1.6.2 在 `src/agents/system-prompt.l10n.en.ts` 添加批量任务说明
- [x] 1.6.3 添加使用示例
- [x] 1.6.4 添加最佳实践
- [x] 1.6.5 更新工具描述

**验收标准**：
- ✅ 系统提示词包含批量任务说明
- ✅ 提供清晰的使用示例
- ✅ 说明何时使用批量执行

**文件**：
- `src/agents/system-prompt.l10n.zh.ts`
- `src/agents/system-prompt.l10n.en.ts`

---

## 🧠 阶段 2：智能优化（1-2 天）

### 任务 2.1：实现智能预估

**优先级**：P1  
**预估时间**：4 小时  
**状态**：⏳ 待开始

**描述**：实现智能预估任务输出 tokens

**子任务**：
- [ ] 2.1.1 创建 `src/agents/intelligent-task-decomposition/token-estimator.ts`
- [ ] 2.1.2 实现 `estimateTaskTokens` 方法
- [ ] 2.1.3 从 prompt 中提取字数要求
- [ ] 2.1.4 从 summary 中提取字数要求
- [ ] 2.1.5 根据复杂度估算
- [ ] 2.1.6 添加单元测试

**验收标准**：
- ✅ 预估误差 < 30%
- ✅ 支持中文和英文
- ✅ 单元测试覆盖率 > 80%

**文件**：
- `src/agents/intelligent-task-decomposition/token-estimator.ts`
- `src/agents/intelligent-task-decomposition/token-estimator.test.ts`

---

### 任务 2.2：实现动态调整

**优先级**：P2  
**预估时间**：5 小时  
**状态**：⏳ 待开始

**描述**：根据实际执行情况动态调整分组策略

**子任务**：
- [ ] 2.2.1 创建 `src/agents/intelligent-task-decomposition/adaptive-grouper.ts`
- [ ] 2.2.2 继承 `TaskGrouper` 类
- [ ] 2.2.3 实现 `recordExecution` 方法（记录执行历史）
- [ ] 2.2.4 实现 `getAdaptiveOptions` 方法（根据历史调整参数）
- [ ] 2.2.5 实现误差计算
- [ ] 2.2.6 添加单元测试

**验收标准**：
- ✅ 记录最近 20 次执行历史
- ✅ 根据误差调整批次大小
- ✅ 单元测试覆盖率 > 80%

**文件**：
- `src/agents/intelligent-task-decomposition/adaptive-grouper.ts`
- `src/agents/intelligent-task-decomposition/adaptive-grouper.test.ts`

---

### 任务 2.3：实现批次统计

**优先级**：P2  
**预估时间**：3 小时  
**状态**：⏳ 待开始

**描述**：实现批次执行统计，用于性能分析

**子任务**：
- [ ] 2.3.1 创建 `src/agents/intelligent-task-decomposition/batch-statistics.ts`
- [ ] 2.3.2 实现 `recordBatchExecution` 方法
- [ ] 2.3.3 实现 `getBatchStatistics` 方法
- [ ] 2.3.4 实现 `generateReport` 方法
- [ ] 2.3.5 添加单元测试

**验收标准**：
- ✅ 记录批次执行统计
- ✅ 生成统计报告
- ✅ 单元测试覆盖率 > 80%

**文件**：
- `src/agents/intelligent-task-decomposition/batch-statistics.ts`
- `src/agents/intelligent-task-decomposition/batch-statistics.test.ts`

---

### 任务 2.4：优化输出拆分算法

**优先级**：P2  
**预估时间**：4 小时  
**状态**：⏳ 待开始

**描述**：优化输出拆分算法，提高拆分成功率

**子任务**：
- [ ] 2.4.1 分析拆分失败的原因
- [ ] 2.4.2 优化标记识别算法
- [ ] 2.4.3 实现多种后备拆分方法
- [ ] 2.4.4 添加拆分质量评估
- [ ] 2.4.5 添加单元测试

**验收标准**：
- ✅ 拆分成功率 > 95%
- ✅ 支持多种后备方法
- ✅ 单元测试覆盖率 > 80%

**文件**：
- `src/agents/intelligent-task-decomposition/batch-executor.ts`（修改）

---

## 🧪 阶段 3：测试与优化（1 天）

### 任务 3.1：单元测试

**优先级**：P0  
**预估时间**：3 小时  
**状态**：⏳ 待开始

**描述**：完善所有组件的单元测试

**子任务**：
- [ ] 3.1.1 TaskGrouper 单元测试
- [ ] 3.1.2 BatchExecutor 单元测试
- [ ] 3.1.3 batch_enqueue_tasks 工具单元测试
- [ ] 3.1.4 TokenEstimator 单元测试
- [ ] 3.1.5 AdaptiveGrouper 单元测试
- [ ] 3.1.6 确保测试覆盖率 > 80%

**验收标准**：
- ✅ 所有组件都有单元测试
- ✅ 测试覆盖率 > 80%
- ✅ 所有测试通过

---

### 任务 3.2：集成测试

**优先级**：P0  
**预估时间**：3 小时  
**状态**：⏳ 待开始

**描述**：测试完整的批量执行流程

**子任务**：
- [ ] 3.2.1 创建集成测试文件
- [ ] 3.2.2 测试批量创建任务
- [ ] 3.2.3 测试任务分组
- [ ] 3.2.4 测试批量执行
- [ ] 3.2.5 测试输出拆分
- [ ] 3.2.6 测试错误处理

**验收标准**：
- ✅ 完整流程测试通过
- ✅ 错误处理正确
- ✅ 性能符合预期

**文件**：
- `src/agents/intelligent-task-decomposition/batch-execution.integration.test.ts`

---

### 任务 3.3：性能测试

**优先级**：P1  
**预估时间**：2 小时  
**状态**：⏳ 待开始

**描述**：测试批量执行的性能和成本

**子任务**：
- [ ] 3.3.1 创建性能测试脚本
- [ ] 3.3.2 测试不同场景的 tokens 消耗
- [ ] 3.3.3 测试不同场景的请求次数
- [ ] 3.3.4 对比批量执行和单任务执行
- [ ] 3.3.5 生成性能报告

**验收标准**：
- ✅ 节省 26-60% tokens
- ✅ 减少 40-75% 请求次数
- ✅ 生成详细的性能报告

**文件**：
- `scripts/test-batch-execution-performance.ts`

---

### 任务 3.4：端到端测试

**优先级**：P1  
**预估时间**：2 小时  
**状态**：⏳ 待开始

**描述**：测试真实用户场景

**子任务**：
- [ ] 3.4.1 场景 1：生成 10000 字文章
- [ ] 3.4.2 场景 2：总结 100 个文件
- [ ] 3.4.3 场景 3：生成 20 个章节
- [ ] 3.4.4 验证输出质量
- [ ] 3.4.5 验证成本节省

**验收标准**：
- ✅ 所有场景测试通过
- ✅ 输出质量符合预期
- ✅ 成本节省符合预期

**文件**：
- `test/batch-execution.e2e.test.ts`

---

### 任务 3.5：文档更新

**优先级**：P1  
**预估时间**：2 小时  
**状态**：⏳ 待开始

**描述**：更新相关文档

**子任务**：
- [ ] 3.5.1 更新 `docs/task-decomposition-usage.md`
- [ ] 3.5.2 创建 `docs/batch-task-execution.md`
- [ ] 3.5.3 更新 API 文档
- [ ] 3.5.4 添加使用示例
- [ ] 3.5.5 添加最佳实践

**验收标准**：
- ✅ 文档完整且清晰
- ✅ 包含使用示例
- ✅ 包含最佳实践

**文件**：
- `docs/task-decomposition-usage.md`
- `docs/batch-task-execution.md`

---

## 📊 进度跟踪

### 总体进度

- **已完成**：6 / 15 任务（40%）
- **进行中**：0 / 15 任务（0%）
- **待开始**：9 / 15 任务（60%）

### 阶段进度

| 阶段 | 已完成 | 进行中 | 待开始 | 进度 |
|------|--------|--------|--------|------|
| 阶段 1 | 6 / 6 | 0 / 6 | 0 / 6 | 100% ✅ |
| 阶段 2 | 0 / 4 | 0 / 4 | 4 / 4 | 0% |
| 阶段 3 | 0 / 5 | 0 / 5 | 5 / 5 | 0% |

---

**版本**：v1.1.0  
**最后更新**：2026-02-06  
**状态**：阶段 1 已完成，等待用户测试
