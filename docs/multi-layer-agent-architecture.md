# 多层 Agent 架构

## 概述

多层 Agent 架构是一个创新的 AI 助手架构设计，通过将功能分层，实现了更清晰的职责分离和更高效的 token 使用。

## 架构层次

### 1. 虚拟世界层（Virtual World Layer）

**职责**：
- 提供纯粹的角色扮演体验
- 处理情感交互和对话
- 维护角色人格和世界观

**特点**：
- 不知道任何技术细节
- 不能直接调用工具
- 不能访问底层系统
- System Prompt 只包含角色设定（节省 40-50% token）

**使用场景**：
- 角色扮演对话
- 情感陪伴
- 故事创作

### 2. 管家层（Butler Layer）

**职责**：
- 理解用户意图
- 分解任务为可执行的子任务
- 委托任务给任务调度层
- 将执行结果以友好的方式反馈给用户

**特点**：
- 可以调用独立的系统技能（记忆检索、知识查询等）
- 可以调用任务委托接口
- 处理对话前后的任务调度（记忆填充、总结归档）
- System Prompt 包含任务委托接口（节省 30-40% token）

**使用场景**：
- 任务管理
- 意图理解
- 记忆管理

### 3. 任务调度层（Task Scheduler Layer）

**职责**：
- 接收管家层的任务委托
- 分解复杂任务为子任务
- 调度任务执行
- 跟踪任务进度

**特点**：
- 使用现有的 TaskBoard 系统
- 通过 DelegationAdapter 适配接口
- 支持进度回调
- System Prompt 包含任务分解相关提示词（节省 20-30% token）

**使用场景**：
- 复杂任务分解
- 任务执行调度
- 进度跟踪

### 4. 执行层（Execution Layer）

**职责**：
- 执行具体的工具调用
- 执行技能调用
- 处理执行错误
- 返回执行结果

**特点**：
- 封装现有的工具系统和技能系统
- 提供统一的执行接口
- 完善的错误处理和超时控制
- System Prompt 包含完整的工具使用提示词（无 token 节省）

**使用场景**：
- 文件操作
- 命令执行
- 搜索查询
- 其他工具调用

## 架构优势

### 1. Token 优化

通过分层 System Prompt，不同层次只包含必要的提示词：

| 层次 | Token 节省 | 说明 |
|------|-----------|------|
| 虚拟世界层 | 40-50% | 只包含角色设定 |
| 管家层 | 30-40% | 只包含任务委托接口 |
| 任务调度层 | 20-30% | 只包含任务分解提示词 |
| 执行层 | 0% | 包含完整的工具提示词 |

**整体 token 消耗降低 30-50%**

### 2. 职责清晰

每个层次有明确的职责边界：
- 虚拟世界层：只负责角色扮演
- 管家层：只负责意图理解和任务委托
- 任务调度层：只负责任务分解和调度
- 执行层：只负责工具执行

### 3. 易于扩展

- 可以独立扩展每个层次
- 可以添加新的层次
- 可以自定义层次行为

### 4. 向后兼容

- 默认使用执行层（与现有行为一致）
- 可以逐步迁移到多层架构
- 不影响现有功能

## 快速开始

### 1. 启用多层架构

在 `clawdbot.json` 中添加配置：

\`\`\`json
{
  "multiLayer": {
    "enabled": true,
    "defaultLayer": "execution"
  }
}
\`\`\`

### 2. 使用虚拟世界层

创建角色配置：

\`\`\`typescript
import { LISI_PROFILE } from "./src/agents/virtual-world/character-profiles.js";
import { VirtualWorldAgent } from "./src/agents/virtual-world/agent.js";

const agent = new VirtualWorldAgent("丽丝", LISI_PROFILE, llmProvider);
const response = await agent.handleMessage("你好", context);
\`\`\`

### 3. 使用管家层

\`\`\`typescript
import { ButlerAgent } from "./src/agents/butler/agent.js";

const agent = new ButlerAgent(taskDelegator, skillCaller, llmProvider);
const response = await agent.handleMessage("帮我创建一个文件", context);
\`\`\`

### 4. 使用协调器

\`\`\`typescript
import { MultiLayerCoordinator } from "./src/agents/multi-layer/coordinator.js";

const coordinator = new MultiLayerCoordinator(
  virtualWorldAgent,
  butlerAgent,
  toolExecutor,
  skillExecutor
);

const response = await coordinator.handleMessage({
  content: "你好",
  context
});
\`\`\`

## 配置选项

### 多层架构配置

\`\`\`json
{
  "multiLayer": {
    "enabled": true,
    "defaultLayer": "execution",
    "enableAutoSwitch": true,
    "enableLogging": true,
    "logLevel": "info"
  }
}
\`\`\`

### 虚拟世界层配置

\`\`\`json
{
  "virtualWorld": {
    "characterName": "丽丝",
    "characterProfile": "LISI_PROFILE"
  }
}
\`\`\`

### 管家层配置

\`\`\`json
{
  "butler": {
    "enableMemoryFill": true,
    "enableSummaryArchive": true
  }
}
\`\`\`

## 常见问题

### Q: 如何判断应该使用哪个层次？

A: 根据任务类型选择：
- 角色扮演对话 → 虚拟世界层
- 任务管理 → 管家层
- 复杂任务分解 → 任务调度层
- 工具调用 → 执行层

### Q: 多层架构会增加延迟吗？

A: 会有轻微增加（< 20%），但通过 token 优化可以降低 LLM 响应时间，整体延迟可能持平或略有降低。

### Q: 如何迁移现有代码？

A: 多层架构是可选的，默认使用执行层（与现有行为一致）。可以逐步迁移，不影响现有功能。

### Q: 如何自定义层次行为？

A: 可以扩展对应的 Agent 类，或者修改 System Prompt 模板。

## 更多资源

- [开发者文档](./dev/multi-layer-architecture.md)
- [API 文档](./api/multi-layer-architecture.md)
- [示例代码](../examples/multi-layer-agent/)
- [迁移指南](./migration/multi-layer-architecture.md)

## 反馈和支持

如有问题或建议，请：
- 提交 GitHub Issue
- 加入社区讨论
- 查看故障排查指南
