# 任务分解机制集成指南

本文档说明如何将任务分解和跟踪机制集成到 Clawdbot 的各个组件中。

## 目录

1. [LLM 驱动的任务分解](#llm-驱动的任务分解)
2. [Agent 系统集成](#agent-系统集成)
3. [CLI 集成](#cli-集成)
4. [Telegram/Discord 集成](#telegramdiscord-集成)
5. [maintain-rules Power 集成](#maintain-rules-power-集成)

---

## LLM 驱动的任务分解

### 概述

LLM 驱动的任务分解器使用大语言模型进行智能任务拆解，提供更准确和上下文相关的子任务生成。

### 使用方法

```typescript
import { createLLMTaskDecomposer, type LLMConfig } from "./agents/task-board/index.js";

// 配置 LLM
const llmConfig: LLMConfig = {
  provider: "openai",  // 或 "anthropic", "google"
  model: "gpt-4",
  apiKey: process.env.OPENAI_API_KEY,
  endpoint: "https://api.openai.com/v1"
};

// 创建 LLM 任务分解器
const decomposer = createLLMTaskDecomposer(llmConfig);

// 判断是否需要拆解
const shouldDecompose = await decomposer.shouldDecompose(
  "创建任务分解和跟踪机制，包括数据模型、持久化层、任务分解器、进度跟踪器和失败处理器"
);

if (shouldDecompose) {
  // 拆解任务
  const subTasks = await decomposer.decompose(task, {
    codebase: process.cwd(),
    recentMessages: []
  });
  
  console.log(`任务已拆解为 ${subTasks.length} 个子任务`);
}
```

### 实现 LLM 调用

目前 `decomposer-llm.ts` 中的 `callLLM` 方法是一个占位实现。你需要根据实际使用的 LLM 提供商实现它：

#### OpenAI 示例

```typescript
private async callLLM(prompt: string): Promise<string> {
  if (this.llmConfig.provider === "openai") {
    const response = await fetch(`${this.llmConfig.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.llmConfig.apiKey}`
      },
      body: JSON.stringify({
        model: this.llmConfig.model,
        messages: [
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      })
    });
    
    const data = await response.json();
    return data.choices[0].message.content;
  }
  
  throw new Error(`不支持的 LLM 提供商: ${this.llmConfig.provider}`);
}
```

---

## Agent 系统集成

### 概述

Agent 系统集成允许在 Clawdbot 的 Agent 中自动使用任务分解功能。

### 使用方法

```typescript
import { createAgentTaskDecompositionHandler } from "./agents/task-board/index.js";

// 创建处理器
const handler = createAgentTaskDecompositionHandler({
  enabled: true,
  enableConcurrentExecution: false,
  enableAutoRetry: false,
  maxRetries: 3
});

// 在 Agent 消息处理中使用
async function handleAgentMessage(message: string, context: AgentContext) {
  // 尝试任务分解
  const taskBoard = await handler.handleMessage(message, {
    sessionId: context.sessionId,
    codebase: context.codebase,
    recentMessages: context.recentMessages
  });
  
  if (taskBoard) {
    // 任务已分解，展示任务看板
    const formattedMessage = handler.formatTaskBoardMessage(taskBoard);
    await sendMessage(formattedMessage);
    
    // 开始执行子任务
    // ...
  } else {
    // 不需要分解，正常处理消息
    // ...
  }
}
```

### 配置选项

```typescript
interface AgentTaskDecompositionConfig {
  /** 是否启用任务分解 */
  enabled?: boolean;
  /** 是否启用并发执行 */
  enableConcurrentExecution?: boolean;
  /** 是否自动重试 */
  enableAutoRetry?: boolean;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 最少子任务数量 */
  minSubTasks?: number;
  /** 最多子任务数量 */
  maxSubTasks?: number;
}
```

---

## CLI 集成

### 概述

CLI 集成提供命令行界面的任务分解和跟踪功能。

### 使用方法

```typescript
import { cliTaskDecompose, cliTaskResume } from "./agents/task-board/index.js";

// 任务分解
await cliTaskDecompose(
  "创建任务分解和跟踪机制",
  {
    sessionId: "session_123",
    codebase: process.cwd(),
    enableConcurrent: false,
    enableAutoRetry: false,
    maxRetries: 3
  }
);

// 任务恢复
await cliTaskResume("session_123");
```

### 添加 CLI 命令

在 `src/cli/index.ts` 中添加新命令：

```typescript
import { cliTaskDecompose, cliTaskResume } from "../agents/task-board/index.js";

// 添加 task-decompose 命令
program
  .command("task-decompose <task>")
  .description("分解复杂任务")
  .option("-s, --session-id <id>", "会话 ID")
  .option("-c, --codebase <path>", "代码库路径")
  .option("--concurrent", "启用并发执行")
  .option("--auto-retry", "启用自动重试")
  .option("--max-retries <n>", "最大重试次数", "3")
  .action(async (task, options) => {
    await cliTaskDecompose(task, {
      sessionId: options.sessionId,
      codebase: options.codebase,
      enableConcurrent: options.concurrent,
      enableAutoRetry: options.autoRetry,
      maxRetries: parseInt(options.maxRetries)
    });
  });

// 添加 task-resume 命令
program
  .command("task-resume <session-id>")
  .description("恢复任务")
  .action(async (sessionId) => {
    await cliTaskResume(sessionId);
  });
```

---

## Telegram/Discord 集成

### 概述

Telegram 和 Discord 集成允许在消息平台中使用任务分解功能。

### Telegram 集成示例

```typescript
import { createAgentTaskDecompositionHandler } from "./agents/task-board/index.js";
import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const handler = createAgentTaskDecompositionHandler({ enabled: true });

bot.on("text", async (ctx) => {
  const message = ctx.message.text;
  const sessionId = `telegram_${ctx.from.id}`;
  
  // 尝试任务分解
  const taskBoard = await handler.handleMessage(message, {
    sessionId,
    codebase: process.cwd(),
    recentMessages: []
  });
  
  if (taskBoard) {
    // 任务已分解，发送任务看板
    const formattedMessage = handler.formatTaskBoardMessage(taskBoard);
    await ctx.reply(formattedMessage, { parse_mode: "Markdown" });
    
    // 添加交互按钮
    await ctx.reply("选择操作:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 开始执行", callback_data: `start_${sessionId}` },
            { text: "🔄 重新拆解", callback_data: `redecompose_${sessionId}` }
          ],
          [
            { text: "📋 查看详情", callback_data: `details_${sessionId}` },
            { text: "❌ 取消", callback_data: `cancel_${sessionId}` }
          ]
        ]
      }
    });
  } else {
    // 正常处理消息
    // ...
  }
});

// 处理按钮点击
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  
  if (data.startsWith("start_")) {
    const sessionId = data.replace("start_", "");
    await ctx.answerCallbackQuery("开始执行任务...");
    // 开始执行子任务
    // ...
  } else if (data.startsWith("redecompose_")) {
    const sessionId = data.replace("redecompose_", "");
    await ctx.answerCallbackQuery("请提供反馈...");
    // 请求用户反馈并重新拆解
    // ...
  }
});

bot.launch();
```

### Discord 集成示例

```typescript
import { createAgentTaskDecompositionHandler } from "./agents/task-board/index.js";
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const handler = createAgentTaskDecompositionHandler({ enabled: true });

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  
  const sessionId = `discord_${message.author.id}`;
  
  // 尝试任务分解
  const taskBoard = await handler.handleMessage(message.content, {
    sessionId,
    codebase: process.cwd(),
    recentMessages: []
  });
  
  if (taskBoard) {
    // 任务已分解，发送任务看板
    const formattedMessage = handler.formatTaskBoardMessage(taskBoard);
    
    // 创建交互按钮
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`start_${sessionId}`)
          .setLabel("✅ 开始执行")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`redecompose_${sessionId}`)
          .setLabel("🔄 重新拆解")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`details_${sessionId}`)
          .setLabel("📋 查看详情")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`cancel_${sessionId}`)
          .setLabel("❌ 取消")
          .setStyle(ButtonStyle.Danger)
      );
    
    await message.reply({
      content: formattedMessage,
      components: [row]
    });
  }
});

// 处理按钮点击
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  
  const customId = interaction.customId;
  
  if (customId.startsWith("start_")) {
    const sessionId = customId.replace("start_", "");
    await interaction.reply("开始执行任务...");
    // 开始执行子任务
    // ...
  } else if (customId.startsWith("redecompose_")) {
    const sessionId = customId.replace("redecompose_", "");
    await interaction.reply("请提供反馈...");
    // 请求用户反馈并重新拆解
    // ...
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
```

---

## maintain-rules Power 集成

### 概述

maintain-rules Power 集成允许自动将任务执行中的经验固化为规则或技能。

### 当前实现

目前 `self-improvement.ts` 中的 `solidifyExperience` 方法包含了调用 maintain-rules Power 的框架代码，但需要实际的 Kiro Powers 环境支持。

### 实现步骤

1. **激活 maintain-rules Power**：

```typescript
import { kiroPowers } from "./kiro-powers.js";

// 激活 Power
const powerInfo = await kiroPowers({
  action: "activate",
  powerName: "maintain-rules"
});

console.log("Power 工具:", powerInfo.toolsByServer);
```

2. **调用 Power 创建规则**：

```typescript
// 固化经验
const result = await kiroPowers({
  action: "use",
  powerName: "maintain-rules",
  serverName: "maintain-rules-server",  // 从 activate 响应中获取
  toolName: "create-rule",              // 从 activate 响应中获取
  arguments: {
    type: "rule",  // 或 "skill"
    title: "标准软件开发流程",
    description: "将标准软件开发流程固化为规则",
    pattern: "分析 -> 设计 -> 实现 -> 测试",
    steps: ["分析需求", "设计方案", "实现功能", "测试验证"]
  }
});

if (result.success) {
  console.log("✅ 经验已固化");
} else {
  console.error("❌ 固化失败:", result.error);
}
```

3. **更新 self-improvement.ts**：

```typescript
async solidifyExperience(suggestion: ImprovementSuggestion): Promise<boolean> {
  try {
    // 调用 Kiro Powers 的 maintain-rules
    const result = await kiroPowers({
      action: "use",
      powerName: "maintain-rules",
      serverName: "maintain-rules-server",
      toolName: "create-rule",
      arguments: {
        type: suggestion.type,
        title: suggestion.title,
        description: suggestion.description,
        pattern: suggestion.pattern,
        steps: suggestion.steps
      }
    });
    
    return result.success;
  } catch (error) {
    console.error("固化经验失败:", error);
    return false;
  }
}
```

---

## 完整集成示例

以下是一个完整的集成示例，展示如何在 Clawdbot Agent 中使用所有功能：

```typescript
import {
  createAgentTaskDecompositionHandler,
  createLLMTaskDecomposer,
  createOrchestrator,
  type LLMConfig,
  type AgentTaskDecompositionConfig
} from "./agents/task-board/index.js";

// 1. 配置 LLM
const llmConfig: LLMConfig = {
  provider: "openai",
  model: "gpt-4",
  apiKey: process.env.OPENAI_API_KEY
};

// 2. 配置任务分解
const taskDecompositionConfig: AgentTaskDecompositionConfig = {
  enabled: true,
  enableConcurrentExecution: false,
  enableAutoRetry: false,
  maxRetries: 3
};

// 3. 创建处理器
const handler = createAgentTaskDecompositionHandler(taskDecompositionConfig);

// 4. 在 Agent 中使用
async function handleUserMessage(message: string, context: AgentContext) {
  // 尝试任务分解
  const taskBoard = await handler.handleMessage(message, {
    sessionId: context.sessionId,
    codebase: context.codebase,
    recentMessages: context.recentMessages
  });
  
  if (taskBoard) {
    // 任务已分解
    console.log("✅ 任务已分解为", taskBoard.subTasks.length, "个子任务");
    
    // 展示任务看板
    const formattedMessage = handler.formatTaskBoardMessage(taskBoard);
    await sendMessage(formattedMessage);
    
    // 开始执行子任务
    const orchestrator = createOrchestrator({
      sessionId: context.sessionId,
      enableConcurrentExecution: false,
      enableAutoRetry: false,
      maxRetries: 3
    });
    
    // 执行任务（这会自动处理子任务执行、失败处理、进度跟踪等）
    // ...
    
    return;
  }
  
  // 不需要分解，正常处理消息
  // ...
}
```

---

## 下一步

1. **实现 LLM 调用**：根据你使用的 LLM 提供商实现 `callLLM` 方法
2. **添加 CLI 命令**：在 `src/cli/index.ts` 中添加任务分解命令
3. **集成到 Telegram/Discord**：在相应的消息处理器中添加任务分解逻辑
4. **实现 maintain-rules Power 调用**：在 `self-improvement.ts` 中实现实际的 Power 调用
5. **测试集成**：在实际环境中测试所有集成功能

---

## 故障排除

### 问题：LLM 调用失败

**解决方案**：
1. 检查 API 密钥是否正确
2. 检查网络连接
3. 检查 LLM 提供商的 API 端点是否正确
4. 查看错误日志获取详细信息

### 问题：任务看板文件不存在

**解决方案**：
1. 检查会话 ID 是否正确
2. 检查文件路径：`~/.clawdbot/tasks/{sessionId}/`
3. 确认任务分解模式已启用

### 问题：maintain-rules Power 调用失败

**解决方案**：
1. 确认 Kiro Powers 环境已正确配置
2. 检查 Power 是否已安装
3. 使用 `kiroPowers({ action: "list" })` 查看已安装的 Powers
4. 使用 `kiroPowers({ action: "activate", powerName: "maintain-rules" })` 激活 Power

---

## 参考文档

- [任务分解用户文档](./task-decomposition.md)
- [任务分解架构文档](./dev/task-board-architecture.md)
- [示例和教程](../examples/task-decomposition/)
