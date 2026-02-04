# 智能任务分解系统 - 标准任务列表

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

- [ ] 1.1 设计系统提示词内容
  - [ ] 1.1.1 阅读现有系统提示词结构
  - [ ] 1.1.2 设计任务分解引导内容（遵循设计原则）
  - [ ] 1.1.3 设计 enqueue_task 工具使用说明

- [ ] 1.2 实现系统提示词注入
  - [ ] 1.2.1 修改 src/agents/system-prompt.ts（添加 buildTaskDecompositionSection）
  - [ ] 1.2.2 添加中文翻译到 src/agents/system-prompt.l10n.zh.ts
  - [ ] 1.2.3 添加英文翻译到 src/agents/system-prompt.l10n.en.ts
  - [ ] 1.2.4 验证注入效果（检查 trace 日志）

- [ ] 1.3 验证 LLM 理解和行为
  - [ ] 1.3.1 测试场景 1：生成多段内容
  - [ ] 1.3.2 测试场景 2：处理大量数据
  - [ ] 1.3.3 测试场景 3：多步骤流程
  - [ ] 1.3.4 检查 LLM 的 thinking

---

## 阶段 2：验证现有基础设施

- [ ] 2.1 验证 enqueue_task 工具
  - [ ] 2.1.1 检查工具定义（src/agents/tools/enqueue-task-tool.ts）
  - [ ] 2.1.2 检查工具注册（src/agents/clawdbot-tools.ts）
  - [ ] 2.1.3 检查工具调用（trace 日志验证）

- [ ] 2.2 验证队列管理机制
  - [ ] 2.2.1 检查队列数据结构（src/auto-reply/reply/queue/types.ts）
  - [ ] 2.2.2 检查队列入队逻辑（src/auto-reply/reply/queue/enqueue.ts）
  - [ ] 2.2.3 检查队列出队逻辑（src/auto-reply/reply/queue/drain.ts）
  - [ ] 2.2.4 检查队列存储（src/auto-reply/reply/queue/state.ts）
  - [ ] 2.2.5 测试队列功能（trace 日志验证）

- [ ] 2.3 验证任务执行流程
  - [ ] 2.3.1 检查任务执行入口（src/auto-reply/reply/agent-runner.ts）
  - [ ] 2.3.2 检查上下文传递（getCurrentFollowupRunContext）
  - [ ] 2.3.3 检查任务标记（isQueueTask 字段）
  - [ ] 2.3.4 测试任务执行（trace 日志验证）

---

## 阶段 3：循环检测机制

- [ ] 3.1 实现循环检测逻辑
  - [ ] 3.1.1 修改 enqueue_task 工具（添加循环检测）
  - [ ] 3.1.2 修改任务执行流程（设置 isQueueTask 标记）
  - [ ] 3.1.3 添加日志记录

- [ ] 3.2 测试循环检测
  - [ ] 3.2.1 测试场景 1：正常情况（队列任务不调用 enqueue_task）
  - [ ] 3.2.2 测试场景 2：循环检测触发（验证错误消息）
  - [ ] 3.2.3 检查日志记录

---

## 阶段 4：Hook 防护机制

- [ ] 4.1 实现 Hook 防护逻辑
  - [ ] 4.1.1 检查 Hook 触发逻辑（src/agents/pi-embedded-runner/run/attempt.ts）
  - [ ] 4.1.2 添加 Hook 防护（检查 isQueueTask）
  - [ ] 4.1.3 添加日志记录

- [ ] 4.2 测试 Hook 防护
  - [ ] 4.2.1 创建测试 Hook（.kiro/hooks/test-hook.json）
  - [ ] 4.2.2 测试场景 1：用户消息（Hook 正常触发）
  - [ ] 4.2.3 测试场景 2：队列任务（Hook 不触发）
  - [ ] 4.2.4 检查日志记录

---

## 阶段 5：文档和示例

- [ ] 5.1 编写用户文档
  - [ ] 5.1.1 创建 docs/intelligent-task-decomposition.md
  - [ ] 5.1.2 更新 README.md

- [ ] 5.2 编写开发者文档
  - [ ] 5.2.1 创建 docs/dev/intelligent-task-decomposition-architecture.md
  - [ ] 5.2.2 更新 AGENTS.md

- [ ] 5.3 创建示例
  - [ ] 5.3.1 创建示例目录（examples/intelligent-task-decomposition/）
  - [ ] 5.3.2 创建示例脚本（test-task-decomposition.mjs）
  - [ ] 5.3.3 创建 README.md

---

## 阶段 6：测试和优化

- [ ] 6.1 单元测试
  - [ ] 6.1.1 测试 enqueue_task 工具（src/agents/tools/enqueue-task-tool.test.ts）
  - [ ] 6.1.2 测试队列管理（src/auto-reply/reply/queue/enqueue.test.ts）
  - [ ] 6.1.3 测试循环检测（src/agents/tools/enqueue-task-tool.test.ts）

- [ ] 6.2 集成测试
  - [ ] 6.2.1 创建集成测试（test/intelligent-task-decomposition.e2e.test.ts）
  - [ ] 6.2.2 运行集成测试

- [ ] 6.3 性能优化
  - [ ] 6.3.1 分析性能瓶颈
  - [ ] 6.3.2 优化队列管理
  - [ ] 6.3.3 优化任务执行

---

## 阶段 7：最终验收

- [ ] 7.1 功能验收
  - [ ] 7.1.1 验证 LLM 能够识别需要分解的任务
  - [ ] 7.1.2 验证 LLM 能够正确调用 enqueue_task 工具
  - [ ] 7.1.3 验证系统能够自动执行队列中的任务
  - [ ] 7.1.4 验证循环检测机制有效
  - [ ] 7.1.5 验证 Hook 防护机制有效
  - [ ] 7.1.6 验证文档和示例完整
  - [ ] 7.1.7 验证单元测试和集成测试通过
  - [ ] 7.1.8 验证性能满足要求

- [ ] 7.2 用户验收
  - [ ] 7.2.1 邀请用户测试
  - [ ] 7.2.2 收集反馈
  - [ ] 7.2.3 修复问题

- [ ] 7.3 发布准备
  - [ ] 7.3.1 更新 CHANGELOG
  - [ ] 7.3.2 更新版本号
  - [ ] 7.3.3 创建发布说明

---

## 📁 关键文件位置清单

### 系统提示词
- `src/agents/system-prompt.ts` - 系统提示词构建逻辑
- `src/agents/system-prompt.l10n.zh.ts` - 中文翻译
- `src/agents/system-prompt.l10n.en.ts` - 英文翻译

### 工具定义
- `src/agents/tools/enqueue-task-tool.ts` - enqueue_task 工具定义
- `src/agents/clawdbot-tools.ts` - 工具注册
- `src/agents/pi-tools.ts` - 工具列表

### 队列管理
- `src/auto-reply/reply/queue/types.ts` - 队列数据结构
- `src/auto-reply/reply/queue/enqueue.ts` - 入队逻辑
- `src/auto-reply/reply/queue/drain.ts` - 出队逻辑
- `src/auto-reply/reply/queue/state.ts` - 队列存储

### 任务执行
- `src/auto-reply/reply/agent-runner.ts` - 任务执行入口
- `src/agents/pi-embedded-runner/run/attempt.ts` - Hook 触发逻辑

### 文档
- `docs/intelligent-task-decomposition.md` - 用户文档
- `docs/dev/intelligent-task-decomposition-architecture.md` - 开发者文档
- `examples/intelligent-task-decomposition/` - 示例代码

---

**版本**：v20260204_2  
**最后更新**：2026-02-04  
**变更**：将实施指南转换为标准任务列表格式
