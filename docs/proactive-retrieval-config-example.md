# 主动检索增强功能配置示例

本文档提供主动检索增强功能的详细配置示例和最佳实践。

---

## 🚀 快速开始

### 最小化配置

只需一个环境变量即可启用主动检索：

```bash
CLAWDBOT_PROACTIVE_RETRIEVAL_ENABLED=1
```

系统会自动使用以下默认值：
- `maxSnippets`: 6
- `minScore`: 0.3
- `enableMemory`: true
- `enableNovel`: true
- `enableToolDefs`: true
- `timeoutMs`: 3000

---

## ⚙️ 完整配置

### 环境变量方式

```bash
# ==================== 开关控制 ====================
# 启用主动检索 (默认：0)
CLAWDBOT_PROACTIVE_RETRIEVAL_ENABLED=1

# ==================== 检索参数 ====================
# 最大返回片段数 (默认：6)
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=8

# 最低分数阈值 (默认：0.3)
CLAWDBOT_PROACTIVE_MIN_SCORE=0.35

# 检索超时时间 (毫秒，默认：3000)
CLAWDBOT_PROACTIVE_TIMEOUT_MS=2000

# ==================== 通道控制 ====================
# 启用记忆检索 (默认：1)
CLAWDBOT_PROACTIVE_ENABLE_MEMORY=1

# 启用小说文本检索 (默认：1)
CLAWDBOT_PROACTIVE_ENABLE_NOVEL=1

# 启用 Agent 定义关键词抽取 (默认：0)
CLAWDBOT_PROACTIVE_ENABLE_AGENT_DEF=0

# 启用 ToolCall 2.0 工具定义注入 (默认：1)
CLAWDBOT_PROACTIVE_ENABLE_TOOL_DEFS=1

# ==================== 高级选项 ====================
# 是否启用调试日志 (默认：0)
CLAWDBOT_PROACTIVE_DEBUG=0

# 是否跳过空查询的检索 (默认：1)
CLAWDBOT_PROACTIVE_SKIP_EMPTY_QUERY=1
```

### 配置文件方式

在 `.env` 或 `config.json` 中配置：

```json
{
  "agents": {
    "defaults": {
      "proactiveRetrieval": {
        "enabled": true,
        "maxSnippets": 8,
        "minScore": 0.35,
        "timeoutMs": 2000,
        "enableMemory": true,
        "enableNovel": true,
        "enableAgentDef": false,
        "enableToolDefs": true,
        "debug": false,
        "skipEmptyQuery": true
      }
    }
  }
}
```

---

## 🎯 场景化配置

### 场景 1: 日常对话 (快速响应优先)

适用于：日常聊天、问答场景

```bash
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=4
CLAWDBOT_PROACTIVE_MIN_SCORE=0.4
CLAWDBOT_PROACTIVE_TIMEOUT_MS=1500
CLAWDBOT_PROACTIVE_ENABLE_NOVEL=0  # 不需要小说检索
```

**特点**：
- 少量高相关性片段
- 更高的分数阈值
- 更快的响应速度
- 预计延迟：< 500ms

---

### 场景 2: 小说创作 (质量优先)

适用于：小说续写、剧本创作

```bash
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=10
CLAWDBOT_PROACTIVE_MIN_SCORE=0.25
CLAWDBOT_PROACTIVE_TIMEOUT_MS=3000
CLAWDBOT_PROACTIVE_ENABLE_MEMORY=1
CLAWDBOT_PROACTIVE_ENABLE_NOVEL=1
CLAWDBOT_PROACTIVE_ENABLE_AGENT_DEF=1
```

**特点**：
- 更多片段以保证创作素材充足
- 较低的分数阈值以获取更多灵感
- 启用所有检索通道
- 预计延迟：1-2 秒

---

### 场景 3: 任务分解 (精度优先)

适用于：复杂任务分解、项目管理

```bash
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=6
CLAWDBOT_PROACTIVE_MIN_SCORE=0.45
CLAWDBOT_PROACTIVE_TIMEOUT_MS=2000
CLAWDBOT_PROACTIVE_ENABLE_NOVEL=0  # 不需要小说
CLAWDBOT_PROACTIVE_ENABLE_TOOL_DEFS=1  # 必须有工具定义
```

**特点**：
- 高精度检索
- 强调工具定义的注入
- 中等响应速度
- 预计延迟：800ms-1.5 秒

---

### 场景 4: 调试模式 (信息最大化)

适用于：开发调试、问题排查

```bash
CLAWDBOT_PROACTIVE_DEBUG=1
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=12
CLAWDBOT_PROACTIVE_MIN_SCORE=0.2
CLAWDBOT_PROACTIVE_TIMEOUT_MS=5000
```

**特点**：
- 详细的调试日志
- 最大化的检索结果
- 不介意较长的延迟
- 预计延迟：2-4 秒

---

## 📊 性能调优指南

### Token 消耗估算

每个检索片段的 token 消耗：

| 片段长度 | Tokens | 适用场景 |
|---------|--------|---------|
| 短 (100 字) | ~50 | 快速参考 |
| 中 (300 字) | ~150 | 标准参考 |
| 长 (500 字) | ~250 | 深度参考 |

**计算公式**：
```
总 Token ≈ maxSnippets × 平均片段 Token 数

例如：maxSnippets=8, 平均 150 tokens
     总 Token ≈ 8 × 150 = 1200 tokens
```

### 延迟优化

**影响因素**：
1. `maxSnippets`: 每增加 1 个片段，延迟增加约 50-100ms
2. `minScore`: 降低阈值会增加候选数量，延迟增加
3. 启用的通道数量：每多一个通道，延迟增加 200-500ms

**优化建议**：
```bash
# 快速模式 (< 500ms)
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=4
CLAWDBOT_PROACTIVE_MIN_SCORE=0.5
CLAWDBOT_PROACTIVE_ENABLE_NOVEL=0

# 平衡模式 (500ms-1.5s)
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=6
CLAWDBOT_PROACTIVE_MIN_SCORE=0.35
CLAWDBOT_PROACTIVE_ENABLE_NOVEL=1

# 深度模式 (1.5s-3s)
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=10
CLAWDBOT_PROACTIVE_MIN_SCORE=0.25
CLAWDBOT_PROACTIVE_ENABLE_ALL=1
```

---

## 🔧 故障排查

### 问题 1: 检索结果为空

**可能原因**：
- `minScore` 设置过高
- 记忆系统/小说文本库为空
- 关键词抽取失败

**解决方法**：
```bash
# 降低分数阈值
CLAWDBOT_PROACTIVE_MIN_SCORE=0.2

# 启用调试日志查看详细过程
CLAWDBOT_PROACTIVE_DEBUG=1

# 检查记忆系统是否正常
# 运行：node --loader ts-node/esm test-memory-search.mjs
```

---

### 问题 2: 检索延迟过长 (> 5 秒)

**可能原因**：
- `maxSnippets` 过大
- 小说文本库太大
- 网络/IO 瓶颈

**解决方法**：
```bash
# 减少片段数量
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=5

# 设置超时保护
CLAWDBOT_PROACTIVE_TIMEOUT_MS=2000

# 暂时禁用小说检索
CLAWDBOT_PROACTIVE_ENABLE_NOVEL=0
```

---

### 问题 3: Token 消耗过多

**可能原因**：
- `maxSnippets` 过大
- 片段长度未控制

**解决方法**：
```bash
# 减少片段数量
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=4

# 配合预算管理系统使用
# 在 followup-runner.ts 中使用 allocateBudget()
```

---

## 🧪 测试命令

### 基础测试

```bash
# 运行主动检索测试套件
node --loader ts-node/esm test-proactive-retrieval.mjs
```

### 压力测试

```bash
# 连续运行 100 次检索，统计性能指标
for i in {1..100}; do
  node --loader ts-node/esm test-proactive-retrieval.mjs >> benchmark.log
done

# 分析结果
cat benchmark.log | grep "durationMs" | awk '{sum+=$NF} END {print "Average:", sum/NR}'
```

### 集成测试

```bash
# 运行完整的 E2E 测试
npm run test:e2e -- --grep "proactive"
```

---

## 📝 最佳实践

### 1. 渐进式启用

第一次部署时，建议使用保守配置：

```bash
CLAWDBOT_PROACTIVE_MAX_SNIPPETS=4
CLAWDBOT_PROACTIVE_MIN_SCORE=0.4
CLAWDBOT_PROACTIVE_TIMEOUT_MS=2000
```

观察一周后，根据实际情况调整。

### 2. 监控关键指标

定期检查：
- 平均检索延迟
- 检索成功率
- Token 消耗增长
- 用户反馈

### 3. A/B 测试

对不同用户群体使用不同配置：

```bash
# 组 A: 快速模式
if (userId % 2 === 0) {
  maxSnippets = 4;
  minScore = 0.45;
} else {
  // 组 B: 标准模式
  maxSnippets = 6;
  minScore = 0.35;
}
```

### 4. 动态调整

根据时间段调整配置：

```javascript
// 高峰期使用快速模式
if (isPeakHour()) {
  config.maxSnippets = 4;
  config.timeoutMs = 1500;
} else {
  config.maxSnippets = 8;
  config.timeoutMs = 3000;
}
```

---

## 🔗 相关资源

- [主动检索优化方案](./聊天背景相关性检索优化方案.md)
- [记忆系统使用指南](../文档 Doc/Clawdbot_记忆功能实现详解.md)
- [ToolCall 2.0 升级指南](./toolcall-2.0-upgrade-guide.md)
- [性能优化白皮书](./performance-optimization.md)

---

*德姨 · 2026-03-17*  
*"配置决定行为，细节决定成败"*
