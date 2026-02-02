# Lina Agent - 人格化 AI 助手

## 概述

Lina Agent 是一个基于配置文件驱动的人格化 AI 助手系统。它通过角色配置文件定义人格特征、能力和交互风格，复用 Butler 的所有核心能力（TaskDelegator、MemoryService）。

## 核心特性

- **配置驱动**：通过 JSON 和 Markdown 文件定义角色
- **能力复用**：复用 Butler 的 TaskDelegator 和 MemoryService
- **智能路由**：根据用户消息自动路由到对应能力
- **动态 System Prompt**：基于角色配置生成 System Prompt

## 架构

```
LinaAgent
├── config/
│   └── loader.ts          # 配置加载器
├── prompts/
│   └── system-prompt-generator.ts  # System Prompt 生成器
├── routing/
│   └── capability-router.ts        # 能力路由器
└── agent.ts               # 主 Agent 类
```

## 使用方法

### 1. 创建角色配置

在 `clawd/characters/{characterName}/` 目录下创建：

**config.json**
```json
{
  "name": "栗娜",
  "version": "1.0.0",
  "personality": {
    "traits": ["温柔", "细心", "负责"],
    "values": ["效率", "关怀", "成长"],
    "communication_style": ["友好", "专业", "耐心"]
  },
  "capabilities": {
    "task_management": true,
    "memory_service": true,
    "daily_planning": true,
    "reminders": false
  },
  "system_prompt": {
    "role": "你的私人助理和生活管家",
    "core_principles": [
      "始终以用户的需求为中心",
      "提供高效、准确的服务",
      "保持友好、专业的态度"
    ],
    "interaction_guidelines": [
      "用温暖、友好的语气交流",
      "主动提供帮助和建议",
      "及时反馈任务进度"
    ]
  }
}
```

**profile.md**
```markdown
## 背景故事

栗娜是一位经验丰富的私人助理...

## 性格特点

温柔、细心、负责...

## 核心能力

- 任务管理
- 记忆服务
- 日程规划

## 互动风格

友好、专业、耐心...
```

### 2. 初始化 Agent

```typescript
import { createLinaAgent } from "./agents/lina/agent.js";
import { createTaskDelegator } from "./agents/butler/task-delegator.js";
import { createMemoryService } from "./agents/memory/service.js";

// 创建依赖
const taskDelegator = createTaskDelegator({ /* ... */ });
const memoryService = createMemoryService({ /* ... */ });

// 创建 Lina Agent
const lina = await createLinaAgent({
  characterName: "lina",
  basePath: process.cwd(),
  taskDelegator,
  memoryService,
});
```

### 3. 处理用户消息

```typescript
const response = await lina.handleMessage({
  userMessage: "帮我记录一下今天的会议内容",
  userName: "张三",
  conversationHistory: [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！我是栗娜" },
  ],
});

console.log(response.message);
console.log(response.capability); // "记忆服务 - 使用 MemoryService 处理记忆相关请求"
```

## 能力路由

Lina Agent 会根据用户消息中的关键词自动路由到对应能力：

| 能力 | 关键词 | 示例 |
|------|--------|------|
| 任务管理 | 任务、待办、todo、完成、进度 | "帮我创建一个任务" |
| 记忆服务 | 记住、记录、保存、回忆、之前 | "记住我今天的会议内容" |
| 日程规划 | 今天、明天、本周、日程、安排 | "今天有什么安排？" |
| 通用对话 | 其他 | "你好" |

## System Prompt 生成

Lina Agent 会基于角色配置自动生成 System Prompt：

```typescript
const systemPrompt = lina.getSystemPrompt();
console.log(systemPrompt);
```

生成的 System Prompt 包含：
- 角色定位
- 性格特点
- 核心能力
- 互动风格
- 核心原则
- 互动指南
- 上下文信息

## 扩展到其他角色

要创建新的角色，只需：

1. 在 `clawd/characters/` 下创建新目录
2. 添加 `config.json` 和 `profile.md`
3. 使用相同的 API 创建 Agent

```typescript
const butler = await createLinaAgent({
  characterName: "butler",  // 不同的角色名
  basePath: process.cwd(),
  taskDelegator,
  memoryService,
});
```

## 注意事项

- 角色配置文件必须符合 `CharacterConfig` 接口
- 能力路由基于简单的关键词匹配，可以根据需要扩展
- TaskDelegator 和 MemoryService 是可选的，如果未提供会返回友好提示
- System Prompt 会在 Agent 初始化时生成并缓存

## 相关文件

- 配置加载器：`src/agents/lina/config/loader.ts`
- System Prompt 生成器：`src/agents/lina/prompts/system-prompt-generator.ts`
- 能力路由器：`src/agents/lina/routing/capability-router.ts`
- 主 Agent 类：`src/agents/lina/agent.ts`
- 角色配置示例：`clawd/characters/lina/`
