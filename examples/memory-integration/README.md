# 记忆系统集成示例

本示例展示如何在 Clawdbot 中使用记忆系统，实现对话历史的智能检索和归档。

---

## 📋 目录

- [快速开始](#快速开始)
- [基本使用](#基本使用)
- [配置示例](#配置示例)
- [高级用法](#高级用法)
- [故障排查](#故障排查)

---

## 🚀 快速开始

### 1. 启用记忆系统

在 `~/.clawdbot/clawdbot.json` 中添加配置：

```json
{
  "agents": {
    "main": {
      "memory": {
        "enabled": true
      }
    }
  }
}
```

### 2. 验证配置

```bash
# 检查记忆系统状态
clawdbot memory status

# 输出示例：
# ✓ Memory system enabled
# ✓ Retrieval: available
# ✓ Archival: available
```

### 3. 开始对话

记忆系统会自动：
- **对话前**：检索相关历史记忆
- **对话后**：归档会话总结

---

## 📖 基本使用

### 自动记忆检索

当你发送消息时，系统会自动检索相关的历史记忆：

```
用户: 上次我们讨论的多层架构是怎么设计的？

AI: [自动检索到相关记忆]
根据之前的讨论（会话 abc123，2026-01-30），
多层架构包含三层：虚拟世界层、管家层、执行层...
```

### 自动会话归档

对话结束后，系统会自动生成总结并归档：

```
会话总结已保存到：
memory/sessions/2026-01-31/session-xyz789.md

包含：
- 任务目标
- 关键操作
- 关键决策
- 遇到的问题
```

---

## ⚙️ 配置示例

### 基础配置（推荐）

```json
{
  "agents": {
    "main": {
      "memory": {
        "enabled": true,
        "retrieval": {
          "maxResults": 5,
          "minScore": 0.7
        },
        "archival": {
          "strategy": "threshold",
          "frequency": 5
        }
      }
    }
  }
}
```

**说明**：
- `maxResults: 5` - 最多返回 5 条相关记忆
- `minScore: 0.7` - 相关性分数阈值（0-1）
- `strategy: "threshold"` - 每 5 轮对话归档一次

### 高性能配置

适用于快速响应场景：

```json
{
  "agents": {
    "main": {
      "memory": {
        "enabled": true,
        "retrieval": {
          "maxResults": 3,
          "minScore": 0.8,
          "timeoutMs": 3000,
          "sources": ["memory"]
        },
        "archival": {
          "strategy": "on-demand"
        }
      }
    }
  }
}
```

**说明**：
- `maxResults: 3` - 减少结果数量
- `minScore: 0.8` - 提高相关性阈值
- `timeoutMs: 3000` - 3 秒超时
- `sources: ["memory"]` - 只检索记忆文件（不检索会话）
- `strategy: "on-demand"` - 手动触发归档

### 详细归档配置

适用于需要完整记录的场景：

```json
{
  "agents": {
    "main": {
      "memory": {
        "enabled": true,
        "retrieval": {
          "maxResults": 10,
          "minScore": 0.5,
          "sources": ["memory", "sessions"]
        },
        "archival": {
          "strategy": "always",
          "path": "memory/sessions",
          "format": "markdown"
        }
      }
    }
  }
}
```

**说明**：
- `maxResults: 10` - 返回更多结果
- `minScore: 0.5` - 降低相关性阈值
- `sources: ["memory", "sessions"]` - 检索所有来源
- `strategy: "always"` - 每次对话都归档

---

## 🔧 高级用法

### 手动检索记忆

```typescript
import { MemoryService } from "@/agents/memory/service";

const memoryService = new MemoryService(config);

const result = await memoryService.retrieve({
  query: "多层架构设计",
  context: {
    userId: "user123",
    sessionId: "session456",
    layer: "butler",
  },
  params: {
    maxResults: 10,
    minScore: 0.6,
  },
});

console.log("检索到的记忆：", result.memories);
console.log("格式化的上下文：", result.formattedContext);
```

### 手动归档会话

```typescript
import { MemoryService } from "@/agents/memory/service";
import { generateSessionSummary } from "@/agents/session-summary";

const memoryService = new MemoryService(config);

// 生成会话总结
const summary = generateSessionSummary(messages);

// 归档
const result = await memoryService.archive({
  summary,
  context: {
    userId: "user123",
    sessionId: "session456",
  },
  params: {
    path: "memory/custom-path",
    format: "markdown",
  },
});

console.log("归档路径：", result.path);
console.log("归档成功：", result.success);
```

### 自定义记忆过滤

```typescript
import { MemoryRetriever } from "@/agents/memory/retriever";

const retriever = new MemoryRetriever(config);

// 只检索特定层的记忆
const result = await retriever.retrieve({
  query: "任务分解",
  context: {
    userId: "user123",
    sessionId: "session456",
    layer: "butler", // 只检索管家层的记忆
  },
});
```

---

## 🐛 故障排查

### 问题 1：记忆检索没有结果

**症状**：
```
用户: 上次我们讨论的内容是什么？
AI: 我没有找到相关的历史记忆。
```

**可能原因**：
1. 记忆索引未初始化
2. 相关性分数阈值过高
3. 记忆文件不存在

**解决方案**：

```bash
# 1. 检查记忆索引状态
clawdbot memory status

# 2. 重建记忆索引
clawdbot memory rebuild

# 3. 降低相关性阈值
# 在 clawdbot.json 中设置：
{
  "memory": {
    "retrieval": {
      "minScore": 0.5  // 从 0.7 降低到 0.5
    }
  }
}

# 4. 检查记忆文件是否存在
ls -la ~/.clawdbot/memory/
```

### 问题 2：记忆检索超时

**症状**：
```
[warn] Memory retrieval timeout after 5000ms
```

**可能原因**：
1. 记忆文件过多
2. 向量检索性能问题
3. 超时时间设置过短

**解决方案**：

```json
{
  "memory": {
    "retrieval": {
      "timeoutMs": 10000,  // 增加到 10 秒
      "maxResults": 3,     // 减少结果数量
      "sources": ["memory"] // 只检索记忆文件
    }
  }
}
```

### 问题 3：会话归档失败

**症状**：
```
[error] Memory archival failed: ENOENT: no such file or directory
```

**可能原因**：
1. 归档目录不存在
2. 权限不足
3. 磁盘空间不足

**解决方案**：

```bash
# 1. 创建归档目录
mkdir -p ~/.clawdbot/memory/sessions

# 2. 检查权限
ls -la ~/.clawdbot/memory/

# 3. 检查磁盘空间
df -h ~/.clawdbot/

# 4. 手动测试归档
clawdbot memory archive --session <session-id>
```

### 问题 4：记忆内容不准确

**症状**：
- 检索到的记忆与当前对话无关
- 记忆内容过时

**可能原因**：
1. 记忆索引未更新
2. 向量嵌入质量问题
3. 关键词匹配不准确

**解决方案**：

```bash
# 1. 重建记忆索引
clawdbot memory rebuild

# 2. 清理过时的记忆文件
# 手动删除 ~/.clawdbot/memory/ 中的旧文件

# 3. 调整检索参数
{
  "memory": {
    "retrieval": {
      "minScore": 0.8,  // 提高相关性阈值
      "maxResults": 3   // 减少结果数量
    }
  }
}
```

### 问题 5：记忆系统占用过多资源

**症状**：
- 对话响应变慢
- CPU/内存占用高

**可能原因**：
1. 记忆文件过多
2. 向量检索性能问题
3. 归档频率过高

**解决方案**：

```json
{
  "memory": {
    "retrieval": {
      "timeoutMs": 3000,    // 减少超时时间
      "maxResults": 3,      // 减少结果数量
      "sources": ["memory"] // 只检索记忆文件
    },
    "archival": {
      "strategy": "threshold", // 使用阈值策略
      "frequency": 10          // 每 10 轮归档一次
    }
  }
}
```

### 调试技巧

#### 1. 启用详细日志

```bash
# 设置日志级别为 debug
export CLAWDBOT_LOG_LEVEL=debug

# 运行 Clawdbot
clawdbot gateway run
```

#### 2. 查看记忆检索日志

```bash
# 查看最近的记忆检索日志
tail -f ~/.clawdbot/logs/memory-retrieval.log
```

#### 3. 手动测试记忆检索

```bash
# 测试记忆检索
clawdbot memory search "多层架构"

# 输出示例：
# Found 3 memories:
# 1. memory/sessions/2026-01-30/session-abc123.md (score: 0.85)
# 2. memory/docs/architecture.md (score: 0.78)
# 3. memory/sessions/2026-01-29/session-xyz789.md (score: 0.72)
```

#### 4. 检查记忆索引状态

```bash
# 查看记忆索引统计
clawdbot memory stats

# 输出示例：
# Total memories: 150
# Total sessions: 45
# Index size: 2.3 MB
# Last updated: 2026-01-31 10:30:00
```

---

## 📚 相关文档

- [记忆系统设计文档](../../.kiro/specs/memory-integration/design.md)
- [记忆系统需求文档](../../.kiro/specs/memory-integration/requirements.md)
- [记忆服务 API 文档](../../docs/dev/memory-service.md)
- [多层 Agent 架构文档](../../docs/dev/multi-layer-architecture.md)

---

## 🤝 贡献

如果你发现问题或有改进建议，欢迎：
1. 提交 Issue
2. 提交 Pull Request
3. 更新文档

---

**版本：** v1.0  
**创建时间：** 2026-01-31  
**作者：** Kiro AI Assistant
