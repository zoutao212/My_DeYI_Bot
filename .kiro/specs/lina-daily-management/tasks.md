# 实现计划：栗娜（Lina）人格化系统

## 概述

本实现计划将 Lina 人格化系统分解为一系列可执行的编码任务。Lina 是 Butler 的人格化定义，所有能力都复用 Butler，只添加独有的提醒功能。

实现语言：**TypeScript**

## 核心原则

- **不重复造轮子**：复用 Butler 的所有能力（TaskDelegator、MemoryService、TaskBoard）
- **配置驱动**：通过配置文件定义角色，无需修改核心代码
- **快速实现**：工作量从 16 周减少到 1 天

## 任务

- [x] 1. 删除重复代码
  - [x] 删除 `src/agents/lina/managers/task-manager.ts`（重复 TaskDelegator）
  - [x] 删除 `src/agents/lina/managers/task-manager.test.ts`
  - [x] 删除 `src/agents/lina/managers/memory-manager.ts`（重复 MemoryService）
  - [x] 删除 `src/agents/lina/managers/memory-manager.test.ts`
  - _需求：系统集成（7.1, 7.2, 7.3）_

- [x] 2. 创建角色配置系统
  - [x] 创建目录结构：`clawd/characters/lina/`
  - [x] 创建角色设定文件：`profile.md`
  - [x] 创建角色配置文件：`config.json`
  - _需求：自然语言交互（6.1-6.6）_

- [x] 3. 实现角色配置加载器
  - [x] 3.1 创建配置加载器
    - 实现 `CharacterConfigLoader` 类
    - 读取 `config.json` 和 `profile.md`
    - 解析配置并验证
    - _需求：系统集成（7.5）_
  
  - [x] 3.2 集成到 Butler
    - 在 `ButlerAgent` 中添加 `personality` 配置
    - 根据配置调整 system prompt
    - 加载角色特定的功能（如提醒管理器）
    - _需求：系统集成（7.4）_

- [x] 5. 实现 System Prompt 生成器
  - [x] 5.1 创建 System Prompt 模板
    - 基于角色配置生成 system prompt
    - 包含角色设定、性格特征、对话风格
    - 包含能力说明和工作原则
    - _需求：自然语言交互（6.1-6.6）_
  
  - [x] 5.2 集成到 Butler
    - 在 Butler 初始化时加载 system prompt
    - 根据角色配置动态调整 prompt
    - _需求：系统集成（7.4）_

- [x] 6. 实现能力路由
  - [x] 6.1 创建能力路由器
    - 根据用户消息判断需要调用的能力
    - 路由到 TaskDelegator、MemoryService 或 ReminderManager
    - _需求：任务委托（3.1-3.6）、记忆管理（2.1-2.6）、智能提醒（5.1-5.6）_
  
  - [x] 6.2 实现能力调用封装
    - 封装 TaskDelegator 调用（任务管理）
    - 封装 MemoryService 调用（记忆管理）
    - 封装 ReminderManager 调用（提醒管理）
    - _需求：系统集成（7.1, 7.2, 7.3）_

- [ ] 7. 测试和验证
  - [ ] 7.1 单元测试
    - 测试配置加载器
    - 测试提醒管理器
    - 测试 system prompt 生成器
  
  - [ ] 7.2 集成测试
    - 测试 Lina 人格的完整对话流程
    - 测试能力路由和调用
    - 测试提醒功能
  
  - [ ] 7.3 端到端测试
    - 测试用户与 Lina 的完整交互
    - 测试多轮对话
    - 测试错误处理

- [x] 8. 文档和示例
  - [x] 8.1 创建使用文档
    - 编写 Lina 使用指南
    - 编写配置说明
    - 编写常见问题文档
  
  - [x] 8.2 创建示例
    - 创建基本使用示例
    - 创建高级使用示例
    - 创建自定义角色示例

## 工作量估算

- **删除重复代码**：✅ 已完成（30 分钟）
- **创建角色配置**：✅ 已完成（1 小时）
- **实现配置加载器**：2 小时
- **完善提醒管理器**：2 小时
- **实现 System Prompt 生成器**：1 小时
- **实现能力路由**：1.5 小时
- **测试和验证**：1.5 小时
- **文档和示例**：1 小时
- **总计**：**10.5 小时**（约 1.5 天）

## 注意事项

- 所有能力都复用 Butler，不重复实现
- 配置文件驱动，易于扩展到其他角色
- 提醒管理器是 Lina 的独有功能
- System Prompt 根据角色配置动态生成
