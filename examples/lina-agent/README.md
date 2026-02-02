# Lina Agent 使用示例

这个目录包含 Lina Agent 的使用示例。

## 运行示例

```bash
# 基本使用
bun examples/lina-agent/basic-usage.ts
```

## 示例说明

### basic-usage.ts

演示 Lina Agent 的基本功能：

1. 创建 Lina Agent
2. 查看 System Prompt
3. 处理通用对话
4. 处理任务管理请求
5. 处理记忆服务请求
6. 处理日程规划请求
7. 查看路由元数据

## 预期输出

```
=== 创建 Lina Agent ===
✓ Lina Agent 创建成功
角色名称: 栗娜
角色版本: 1.0.0

=== System Prompt ===
# 角色定位

你是 栗娜，你的私人助理和生活管家

...

=== 通用对话 ===
用户: 你好，栗娜
栗娜: 张三，我是 栗娜。你好，栗娜
能力: 通用对话 - 使用角色人格进行自然对话

=== 任务管理请求 ===
用户: 帮我创建一个任务：完成项目报告
栗娜: 抱歉，任务管理功能暂未配置。请联系管理员启用 TaskDelegator。
能力: 任务管理 - 使用 TaskDelegator 处理任务相关请求

=== 记忆服务请求 ===
用户: 记住我今天开了一个重要会议
栗娜: 抱歉，记忆服务暂未配置。请联系管理员启用 MemoryService。
能力: 记忆服务 - 使用 MemoryService 处理记忆相关请求

=== 日程规划请求 ===
用户: 今天有什么安排？
栗娜: [日程规划] 正在处理日程请求: 今天有什么安排？
能力: 日程规划 - 处理日程安排相关请求

=== 路由元数据 ===
路由能力: daily_planning
置信度: 0.7
原因: 检测到日程规划相关关键词
```

## 注意事项

- 示例中没有提供 TaskDelegator 和 MemoryService，所以相关功能会返回友好提示
- 要启用完整功能，需要在创建 Agent 时提供这些依赖
- 角色配置文件位于 `clawd/characters/lina/`
