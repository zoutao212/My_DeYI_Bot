# Lina Agent - 人格化 AI 助手

基于配置文件驱动的角色定义，复用 Butler 的所有能力。

## 快速开始

### 1. 运行测试

```bash
bun examples/lina-quick-test.ts
```

### 2. 集成到应用

```typescript
import { createLinaAgent } from "./src/agents/lina/agent.js";
import { TaskDelegator } from "./src/agents/task-board/agent-integration.js";
import { MemoryService } from "./src/agents/memory/service.js";

// 创建 Lina Agent
const lina = await createLinaAgent({
  characterName: "lina",
  basePath: process.cwd(),
  taskDelegator: new TaskDelegator(/* ... */),
  memoryService: new MemoryService(/* ... */),
});

// 处理用户消息
const response = await lina.handleMessage({
  userMessage: "帮我记住今天学习了 TypeScript",
  userName: "用户名",
});

console.log(response.message);
```

## 架构设计

### 核心模块

1. **CharacterConfigLoader** (`config/loader.ts`)
   - 加载角色配置（`clawd/characters/{name}/config.json`）
   - 加载角色档案（`clawd/characters/{name}/profile.md`）

2. **SystemPromptGenerator** (`prompts/system-prompt-generator.ts`)
   - 基于配置生成 System Prompt
   - 包含角色定位、性格特点、核心能力、互动风格

3. **CapabilityRouter** (`routing/capability-router.ts`)
   - 路由用户请求到对应能力
   - 支持：任务管理、记忆服务、日程规划、通用对话

4. **LinaAgent** (`agent.ts`)
   - 主入口，协调所有模块
   - 对接 Butler 的 TaskDelegator 和 MemoryService

### 能力路由

Lina 会根据用户消息的关键词，自动路由到对应能力：

- **任务管理**：任务、待办、todo、完成、进度 → TaskDelegator
- **记忆服务**：记住、记录、保存、回忆、之前 → MemoryService
- **日程规划**：今天、明天、本周、日程、安排 → 日程规划
- **通用对话**：其他消息 → 使用角色人格进行自然对话

## 配置文件

### config.json

```json
{
  "name": "栗娜",
  "version": "1.0.0",
  "personality": {
    "traits": ["温柔体贴", "细心周到", "积极乐观"],
    "values": ["真诚", "责任", "成长"],
    "communication_style": ["温暖亲切", "鼓励支持", "耐心倾听"]
  },
  "capabilities": {
    "task_management": true,
    "memory_service": true,
    "daily_planning": true,
    "reminders": false
  },
  "system_prompt": {
    "role": "你的贴心生活助手和情感支持伙伴",
    "core_principles": [
      "始终以用户的需求和感受为中心",
      "提供温暖、真诚、有价值的陪伴"
    ],
    "interaction_guidelines": [
      "用温暖的语气回应用户",
      "主动关心用户的状态和需求"
    ]
  }
}
```

### profile.md

```markdown
# 栗娜角色档案

## 背景故事
栗娜是一位温柔体贴的 AI 助手...

## 性格特点
- 温柔体贴：总是用温暖的语气...
- 细心周到：注意到用户的细微需求...

## 核心能力
- 任务管理：帮助用户规划和追踪任务
- 记忆服务：记住用户的重要信息

## 互动风格
- 温暖亲切：像朋友一样交流
- 鼓励支持：给予积极的反馈
```

## 下一步

### 已完成 ✓
- [x] 任务 1：删除重复代码
- [x] 任务 2：创建角色配置
- [x] 任务 3：实现 CharacterConfigLoader
- [x] 任务 5：实现 System Prompt 生成器
- [x] 任务 6：实现能力路由

### 待完成
- [ ] 对接 Butler 的 TaskDelegator（需要实际接口）
- [ ] 对接 Butler 的 MemoryService（需要实际接口）
- [ ] 集成 LLM 进行通用对话
- [ ] 添加日程规划功能
- [ ] 添加提醒器功能（可选）

## 测试

运行快速测试：

```bash
bun examples/lina-quick-test.ts
```

预期输出：

```
=== Lina Agent 快速测试 ===

1. 创建 Lina Agent...
✓ Lina Agent 创建成功

2. 角色配置:
   - 名称: 栗娜
   - 版本: 1.0.0
   - 核心特质: 温柔体贴、细心周到、积极乐观

3. System Prompt 预览:
# 角色定位
你是 栗娜，你的贴心生活助手和情感支持伙伴
...

4. 测试消息处理:
   用户: 你好，Lina！
   Lina: 测试用户，我是 栗娜。你好，Lina！
   能力: 通用对话 - 使用角色人格进行自然对话
   路由: general (置信度: 0.5)

   用户: 帮我记住：今天学习了 TypeScript
   Lina: [MemoryService] 正在处理记忆请求: 帮我记住：今天学习了 TypeScript
   能力: 记忆服务 - 使用 MemoryService 处理记忆相关请求
   路由: memory_service (置信度: 0.8)

✓ 测试完成！
```

## 注意事项

1. **跳过了提醒器**：任务 4（ReminderManager）未实现
2. **跳过了单元测试**：任务 7.1 未实现
3. **TaskDelegator 和 MemoryService 需要实际对接**：当前返回占位符
4. **通用对话需要集成 LLM**：当前返回简单响应

## 版本

- v1.0.0 - 2026-01-31 - 快速实现核心功能
