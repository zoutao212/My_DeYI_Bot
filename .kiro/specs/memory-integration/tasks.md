# 记忆系统集成任务列表

## 任务概览

- **总任务数**: 20
- **预计总时间**: 2-3 小时
- **优先级**: ⭐⭐⭐⭐⭐ 最高

---

## 阶段 1：核心接口（30 分钟）

### 1.1 创建记忆服务接口
- [x] 1.1.1 创建 `src/agents/memory/types.ts`
  - 定义 `MemoryServiceConfig`
  - 定义 `MemoryRetrievalRequest` 和 `MemoryRetrievalResult`
  - 定义 `MemoryArchivalRequest` 和 `MemoryArchivalResult`
  - 定义 `IMemoryService` 接口

### 1.2 实现记忆检索服务
- [x] 1.2.1 创建 `src/agents/memory/retriever.ts`
  - 实现 `MemoryRetriever` 类
  - 实现 `retrieve()` 方法（调用 MemoryIndexManager）
  - 实现 `formatMemoryContext()` 方法
  - 实现超时处理和降级逻辑

### 1.3 实现记忆归档服务
- [x] 1.3.1 创建 `src/agents/memory/archiver.ts`
  - 实现 `MemoryArchiver` 类
  - 实现 `archive()` 方法
  - 实现 `formatSummary()` 方法
  - 实现归档策略判断

### 1.4 实现记忆服务
- [x] 1.4.1 创建 `src/agents/memory/service.ts`
  - 实现 `MemoryService` 类
  - 组合 `MemoryRetriever` 和 `MemoryArchiver`
  - 实现 `status()` 方法
  - 导出统一接口

### 1.5 编写单元测试
- [x] 1.5.1 创建 `src/agents/memory/service.test.ts`
  - 测试记忆检索功能
  - 测试记忆归档功能
  - 测试超时处理
  - 测试降级逻辑

---

## 阶段 2：管家层集成（45 分钟）

### 2.1 修改管家层 Agent
- [x] 2.1.1 修改 `src/agents/butler/agent.ts`
  - 添加 `memoryService` 依赖
  - 修改 `beforeConversation()` 实现记忆检索
  - 修改 `afterConversation()` 实现记忆归档
  - 添加错误处理和日志

### 2.2 修改上下文类型
- [x] 2.2.1 修改 `src/agents/multi-layer/types.ts`
  - 在 `ConversationContext` 中添加 `memories` 字段
  - 在 `ConversationContext` 中添加 `memoryContext` 字段

### 2.3 创建记忆服务工厂
- [x] 2.3.1 创建 `src/agents/memory/factory.ts`
  - 实现 `createMemoryService()` 工厂函数
  - 从配置加载记忆服务配置
  - 处理配置缺失情况

### 2.4 集成到协调器
- [x] 2.4.1 修改 `src/agents/multi-layer/coordinator.ts`
  - 添加记忆服务初始化
  - 传递记忆服务到管家层
  - 添加记忆服务状态查询

### 2.5 编写集成测试
- [x] 2.5.1 创建 `src/agents/butler/agent.memory.test.ts`
  - 测试记忆检索集成
  - 测试记忆归档集成
  - 测试降级处理
  - 测试错误处理

---

## 阶段 3：虚拟世界层集成（30 分钟）

### 3.1 实现角色记忆过滤
- [x] 3.1.1 创建 `src/agents/memory/filters.ts`
  - 实现 `filterTechnicalDetails()` 函数
  - 实现 `filterByRole()` 函数
  - 实现记忆格式化函数

### 3.2 修改虚拟世界层 Agent
- [x] 3.2.1 修改 `src/agents/virtual-world/agent.ts`
  - 添加 `memoryService` 依赖
  - 在 `handleMessage()` 中调用记忆检索
  - 应用角色记忆过滤
  - 格式化记忆为角色视角

### 3.3 编写集成测试
- [ ] 3.3.1 创建 `src/agents/virtual-world/agent.memory.test.ts`
  - 测试角色记忆检索
  - 测试技术细节过滤
  - 测试记忆格式化

---

## 阶段 4：配置和文档（15 分钟）

### 4.1 实现配置管理
- [x] 4.1.1 修改 `src/config/zod-schema.agents.ts`
  - 添加 `MemoryServiceSchema`
  - 添加到 `AgentConfigSchema`

- [x] 4.1.2 修改 `src/config/types.agents.ts`
  - 添加 `MemoryServiceConfig` 类型

- [x] 4.1.3 创建 `src/agents/memory/config.ts`
  - 实现 `resolveMemoryServiceConfig()` 函数
  - 实现配置验证
  - 实现默认配置

### 4.2 编写 API 文档
- [x] 4.2.1 创建 `docs/dev/memory-service.md`
  - 记忆服务概述
  - API 接口文档
  - 配置说明
  - 使用示例

### 4.3 编写使用示例
- [x] 4.3.1 创建 `examples/memory-integration/README.md`
  - 基本使用示例
  - 配置示例
  - 故障排查指南

---

## 验收标准

### 功能完整性
- [ ] 管家层记忆检索和归档完整实现
- [ ] 虚拟世界层记忆检索实现
- [ ] 记忆管理接口完整实现
- [ ] 配置管理完整实现

### 质量标准
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试通过
- [ ] 性能测试通过（检索 < 1s）
- [ ] 错误处理完整

### 文档标准
- [ ] API 文档完整
- [ ] 使用示例完整
- [ ] 配置说明完整
- [ ] 故障排查指南完整

---

**版本：** v1.0  
**创建时间：** 2026-01-31  
**作者：** Kiro AI Assistant
