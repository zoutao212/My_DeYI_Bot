# 主动检索增强系统配置指南

## 概述

主动检索增强系统 (Proactive Retrieval Augmentation Engine) 会在用户消息进入 LLM prompt 之前，主动从多个维度进行检索，并将相关性高的上下文信息注入到 extraSystemPrompt 中。

## 核心特性

### 1. 多维度检索

- **记忆系统检索**: MEMORY.md + memory/*.md
- **小说文本检索**: NovelsAssets/*.txt (段落级索引)
- **关键词扩展**: 从 Agent 定义、系统提示词、背景提示词中抽取关键词
- **ToolCall 2.0 工具定义**: 自动注入可用工具列表 (TODO)

### 2. 智能关键词抽取

系统会从以下来源自动抽取关键词:
- 用户消息本身
- Agent 定义文本 (如果配置)
- 系统提示词 (如果配置)
- 背景提示词 (如果配置)

### 3. 检索结果融合

- 多通道并行检索 (向量 + 关键词 + 语义)
- 自动去重 (基于路径 + 行号)
- 加权排序 (记忆 > 小说 > Agent 定义)
- 格式化输出 (可直接注入 prompt)

## 配置方法

### 环境变量配置

```bash
# 启用/禁用主动检索
CLAWDBOT_PROACTIVE_RETRIEVAL_ENABLED=1

# 最大检索片段数 (默认 8)
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=8

# 最低分数阈值 (默认 0.3)
CLAWDBOT_PROACTIVE_MIN_SCORE=0.3

# 启用/禁用特定检索通道
CLAWDBOT_PROACTIVE_ENABLE_MEMORY=1
CLAWDBOT_PROACTIVE_ENABLE_NOVEL=1
CLAWDBOT_PROACTIVE_ENABLE_AGENT_DEF=0
CLAWDBOT_PROACTIVE_ENABLE_TOOL_DEFS=1

# 关键词抽取数量上限 (默认 10)
CLAWDBOT_PROACTIVE_MAX_KEYWORDS=10

# 检索超时 (毫秒，默认 3000)
CLAWDBOT_PROACTIVE_TIMEOUT_MS=3000
```

### 在配置文件中启用

在你的 Clawdbot 配置文件 (通常是 `~/.clawdbot/config.json` 或工作区的 `.clawdbotrc`):

```json
{
  "agents": {
    "defaults": {
      "proactiveRetrieval": {
        "enabled": true,
        "maxSnippets": 8,
        "minScore": 0.3,
        "enableMemory": true,
        "enableNovel": true,
        "enableAgentDef": false,
        "enableToolDefs": true,
        "timeoutMs": 3000
      }
    }
  }
}
```

## 使用场景

### 场景 1: 日常对话

用户发送普通问题时，系统会:
1. 从用户问题中抽取关键词
2. 在记忆系统中搜索相关讨论
3. 将相关记忆片段注入 prompt
4. LLM 基于历史上下文给出更准确的回答

**示例**:
```
用户："上次我们说的那个项目进度怎么样了？"
→ 系统检索 memory/ 目录下关于"项目进度"的记录
→ 注入最近的项目讨论片段
→ LLM 回答："根据昨天的记录，项目已经完成第一阶段..."
```

### 场景 2: 小说创作

用户在写作时，系统会:
1. 从创作指令中抽取关键词 (角色名、地点、情节元素)
2. 在 NovelsAssets 中搜索相关段落
3. 在记忆中搜索角色设定、世界观设定
4. 将所有参考片段注入 prompt
5. LLM 基于参考保持一致性

**示例**:
```
用户："写一段林娜和艾伦在星港分别的场景"
→ 系统检索 NovelsAssets 中关于"林娜"、"艾伦"、"星港"的描写
→ 检索记忆中关于两人关系的设定
→ 注入风格参考片段
→ LLM 创作出符合人设和风格的场景
```

### 场景 3: 子任务执行

在执行智能任务分解的子任务时，系统会:
1. 从子任务描述中抽取关键词
2. 检索记忆系统中的相关决策和约束
3. 检索已完成兄弟任务的输出
4. 检索小说纲要 (如果是写作任务)
5. 将所有上下文注入子任务 prompt

**示例**:
```
子任务："撰写第三章：宗门试炼"
→ 检索记忆中关于第三章的讨论
→ 检索 NovelsAssets 中第一、二章的内容 (保持连贯)
→ 检索总纲中关于第三章的设定
→ 注入角色卡片和风格指南
→ LLM 创作出符合整体规划的第三章
```

## 性能优化

### 检索延迟

主动检索会增加额外的延迟，典型值:
- 仅记忆检索：~200-500ms
- 记忆 + 小说检索：~500-1500ms
- 全通道检索：~1000-3000ms

可以通过以下方式优化:
1. 降低 `maxSnippets` 数量
2. 提高 `minScore` 阈值
3. 禁用不需要的通道
4. 设置 `timeoutMs` 超时保护

### 缓存策略

系统内置搜索结果缓存 (30 秒 TTL):
- 相同查询不会重复检索
- 适用于短时间内多次询问相似问题
- 缓存键包含查询文本 + maxResults

## 调试与监控

### 日志输出

启用详细日志:
```bash
DEBUG=proactive-retrieval*
```

日志示例:
```
[proactive-retrieval] Extracted 8 keywords from contexts + user message
[proactive-retrieval] Starting proactive retrieval with 8 keywords
[proactive-retrieval] Memory retrieval: 5 snippets found
[proactive-retrieval] Novel retrieval: 3 snippets found
[proactive-retrieval] Proactive retrieval completed in 847ms: 6 snippets
```

### 性能指标

在控制台输出中可以看到:
```
[followup-runner] 🔍 主动检索增强完成：6 snippets, 847ms, keywords=[林娜，艾伦，星港...]
```

## 最佳实践

### 1. 合理设置分数阈值

- 高阈值 (0.5-0.7): 只注入高度相关的内容，适合精确问答
- 中阈值 (0.3-0.5): 平衡召回率和准确率，适合创作场景
- 低阈值 (0.1-0.3): 尽可能多的上下文，适合探索性任务

### 2. 根据场景调整片段数

- 简单对话：4-6 个片段
- 复杂创作：8-12 个片段
- 子任务执行：6-10 个片段

### 3. 结合 Token 预算管理

主动检索会增加 token 消耗，建议:
- 配合 `allocateBudget()` 使用
- 设置合理的优先级 (检索上下文优先级适中)
- 在预算紧张时自动压缩或丢弃

### 4. 定期清理记忆系统

- 记忆文件过多会降低检索效率
- 定期合并碎片化的记忆文件
- 使用 compaction 功能压缩过期内容

## 故障排查

### 问题 1: 检索不到相关内容

**可能原因**:
- 记忆文件中确实没有相关内容
- 分数阈值设置过高
- 关键词抽取不准确

**解决方法**:
1. 降低 `minScore` 到 0.2
2. 手动指定关键词 (通过配置)
3. 检查记忆文件是否存在且格式正确

### 问题 2: 检索延迟过高

**可能原因**:
- 小说文件过大或过多
- 网络问题 (如果使用远程 embedding)
- 检索通道过多

**解决方法**:
1. 禁用小说检索 (`enableNovel=false`)
2. 设置 `timeoutMs` 强制超时
3. 使用本地 embedding 模型

### 问题 3: Token 消耗过快

**可能原因**:
- `maxSnippets` 设置过大
- 片段长度过长
- 没有启用预算压缩

**解决方法**:
1. 减少 `maxSnippets` 到 4-6
2. 在 `formatRetrievalContext()` 中限制每段长度
3. 启用预算感知组装 (`allocateBudget()`)

## 未来计划

- [ ] ToolCall 2.0 工具定义自动注入
- [ ] Agent 定义文件加载与关键词抽取
- [ ] 背景提示词配置文件支持
- [ ] 检索结果可视化调试界面
- [ ] 基于反馈的自适应权重调整
- [ ] 多轮对话上下文追踪
- [ ] 跨会话记忆共享

## 相关文件

- 核心实现：`src/agents/proactive-retrieval.ts`
- 集成位置：`src/auto-reply/reply/followup-runner.ts`
- 记忆检索：`src/memory/manager.ts`
- 小说检索：`src/memory/novel-assets-searcher.ts`
- 关键词抽取：`src/memory/keyword-extractor.ts`

## 技术支持

遇到问题或有改进建议，请查阅:
- `文档 Doc/Clawdbot_记忆功能实现详解.md`
- `文档 Doc/记忆系统优化方案_v1.md`
- `.kiro/lessons-learned/` 中的相关调试方法论
