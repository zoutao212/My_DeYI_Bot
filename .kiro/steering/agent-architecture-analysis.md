---
inclusion: manual
---

# Agent 架构分析方法论

> **适用场景**：需要理解复杂的 Agent 系统如何组织和调度 LLM 请求

---

## 问题场景

当你需要：
- 改进 Agent 的记忆和上下文管理
- 集成新功能到 Agent 系统
- 调试 Agent 的"遗忘"问题
- 理解 Agent 的数据流和决策机制

**核心挑战**：Agent 系统通常涉及多个层次和组件，数据流复杂，难以快速定位关键机制。

---

## 分析方法论

### 第一步：识别核心入口

**目标**：找到 Agent 运行的主入口函数

**方法**：
1. 搜索关键词：
   - `embedded-runner`
   - `runEmbeddedPiAgent`
   - `agent-runner`
   - `run-agent`

2. 查看文件结构：
   - `src/agents/` 目录
   - `*-runner.ts` 文件
   - `run.ts` 文件

3. 确认入口函数：
   - 通常是 `runXxxAgent` 或 `executeXxx`
   - 接受用户输入和配置参数
   - 返回 Agent 响应

**示例**：
```typescript
// Clawdbot 的核心入口
runEmbeddedPiAgent(params: RunEmbeddedPiAgentParams)
  → src/agents/pi-embedded-runner/run.ts
```

---

### 第二步：追踪数据流

**目标**：理解数据如何从用户输入流向 LLM，再流回用户

**方法**：
1. 从入口函数开始，逐层追踪调用链：
   ```
   用户输入
     ↓
   运行器（run.ts）
     ↓
   尝试器（attempt.ts）
     ↓
   Session Manager
     ↓
   System Prompt 构建
     ↓
   LLM API 调用
     ↓
   响应处理
     ↓
   返回给用户
   ```

2. 在每一层记录：
   - 输入数据格式
   - 处理逻辑
   - 输出数据格式
   - 关键函数调用

3. 绘制数据流图：
   - 使用 Mermaid 或文本图
   - 标注关键转换点
   - 标注数据格式变化

**示例**：
```
用户输入 "继续实现任务"
  ↓
[1] 加载 Session Manager
    → 读取 ~/.clawdbot/sessions/xxx.jsonl
    → 加载所有历史消息（可能 100+ 条）
  ↓
[2] 限制历史（limitHistoryTurns）
    → 保留第 1 条（任务目标）+ 最后 20 轮
    → 结果：21 条消息
  ↓
[3] 生成会话摘要（generateSessionSummary）
    → 提取任务目标、操作、决策、问题
  ↓
[4] 构建 System Prompt
    → 包含：工具、技能、文档、会话摘要
  ↓
[5] 调用 LLM API
    → Payload: { system, messages, tools }
  ↓
[6] 处理响应
    → 提取 text, tool_calls, thinking
    → 保存到 Session Manager
  ↓
返回给用户
```

---

### 第三步：分析关键组件

**目标**：深入理解每个关键组件的职责和实现

**关键组件清单**：

#### 1. System Prompt（Agent 的"指令集"）
- **职责**：定义 Agent 的身份、能力、行为规范
- **关键文件**：`system-prompt.ts`
- **分析重点**：
  - 包含哪些部分？（身份、工具、技能、文档、运行时信息）
  - 如何动态生成？（根据环境、渠道、模型）
  - 如何注入上下文？（会话摘要、任务看板）

#### 2. 对话历史（Agent 的"短期记忆"）
- **职责**：管理最近的对话历史，控制 token 消耗
- **关键文件**：`history.ts`, `limitHistoryTurns`
- **分析重点**：
  - 如何限制历史？（保留最近 N 轮）
  - 如何保留关键信息？（任务目标、重要决策）
  - 如何处理长对话？（压缩、摘要）

#### 3. Session Manager（Agent 的"持久化存储"）
- **职责**：保存和加载所有历史消息
- **关键文件**：`SessionManager` (Pi Agent Core)
- **分析重点**：
  - 如何存储消息？（.jsonl 文件格式）
  - 如何加载消息？（`buildSessionContext`）
  - 是否有缓存问题？（可能返回空数组）

#### 4. 会话摘要（Agent 的"中期记忆"）
- **职责**：将长对话压缩成结构化摘要
- **关键文件**：`session-summary.ts`
- **分析重点**：
  - 提取哪些信息？（任务目标、操作、决策、问题）
  - 如何注入到 System Prompt？
  - 如何更新摘要？（每次请求时重新生成）

---

### 第四步：绘制架构图

**目标**：用可视化方式展示 Agent 的整体架构

**推荐格式**：

#### 1. 层次结构图
```
┌─────────────────────────────────────┐
│   System Prompt（指令集）            │
│   - 身份、工具、技能、文档            │
│   - 会话摘要（任务上下文）            │
└─────────────────────────────────────┘
           ↓
┌─────────────────────────────────────┐
│   对话历史（短期记忆）                │
│   - 最近 N 轮对话                    │
│   - 保留任务目标（第一条消息）        │
└─────────────────────────────────────┘
           ↓
┌─────────────────────────────────────┐
│   Session Manager（持久化）          │
│   - 所有历史消息存储                  │
│   - .jsonl 文件格式                  │
└─────────────────────────────────────┘
```

#### 2. 数据流图
```
用户输入
  ↓
加载历史 → 限制历史 → 生成摘要
  ↓
构建 Prompt → 调用 LLM → 处理响应
  ↓
保存到 Session Manager
  ↓
返回给用户
```

#### 3. 组件关系图
```
RunEmbeddedPiAgent
  ├── SessionManager (持久化)
  ├── SystemPrompt (指令集)
  ├── HistoryManager (短期记忆)
  ├── SessionSummary (中期记忆)
  └── LLM API (推理引擎)
```

---

### 第五步：识别改进点

**目标**：发现架构中的问题和改进机会

**检查清单**：

#### 1. 数据流断点
- [ ] 是否有数据丢失的环节？
- [ ] 是否有数据格式不一致的地方？
- [ ] 是否有缓存导致的数据不同步？

**示例**：
- ❌ `SessionManager.buildSessionContext()` 返回空数组
- ✅ 修复：直接从 `fileEntries` 读取消息

#### 2. 记忆管理
- [ ] 是否有"遗忘"问题？（长对话中忘记任务目标）
- [ ] 是否有 token 浪费？（保留过多无用历史）
- [ ] 是否缺少中期记忆？（会话摘要）

**示例**：
- ❌ 长对话中任务目标丢失
- ✅ 改进：保留第一条 user 消息

#### 3. 上下文注入
- [ ] System Prompt 是否包含足够的上下文？
- [ ] 是否有任务进度信息？
- [ ] 是否有关键决策记录？

**示例**：
- ❌ 缺少任务上下文摘要
- ✅ 改进：生成会话摘要并注入到 System Prompt

#### 4. 性能优化
- [ ] Token 使用是否合理？
- [ ] 是否有不必要的重复计算？
- [ ] 是否可以动态调整历史限制？

---

## 输出文档结构

完成分析后，创建一份完整的架构分析文档，包含：

### 1. 核心架构概览
- 入口层次结构
- 关键组件列表
- 组件职责说明

### 2. Agent "大脑" 的构建流程
- System Prompt 构建
- 对话历史管理
- 会话摘要机制

### 3. LLM 请求的完整数据流
- 数据流图
- 关键步骤详解
- 数据格式示例

### 4. 关键发现和改进点
- 已发现的问题
- 改进建议
- 实施步骤

### 5. 集成方案（如果需要）
- 集成点识别
- 实现步骤
- 验证方法

---

## 实战案例

### 案例：Clawdbot Agent 大脑架构分析

**背景**：需要理解 Clawdbot 如何组织和调度 LLM 请求，以便集成任务分解机制。

**执行步骤**：

1. **识别核心入口**：
   - 搜索 `embedded-runner`
   - 找到 `runEmbeddedPiAgent` (src/agents/pi-embedded-runner/run.ts)

2. **追踪数据流**：
   - 用户输入 → runEmbeddedPiAgent → runEmbeddedAttempt → createAgentSession → LLM API

3. **分析关键组件**：
   - System Prompt: `buildAgentSystemPrompt` (system-prompt.ts)
   - 对话历史: `limitHistoryTurns` (history.ts)
   - Session Manager: `SessionManager.open` (Pi Agent Core)
   - 会话摘要: `generateSessionSummary` (session-summary.ts)

4. **绘制架构图**：
   - 层次结构图：System Prompt → 对话历史 → Session Manager
   - 数据流图：用户输入 → 加载历史 → 限制历史 → 生成摘要 → 构建 Prompt → 调用 LLM

5. **识别改进点**：
   - 问题 1：`SessionManager.buildSessionContext()` 可能返回空数组
   - 问题 2：长对话中任务目标丢失
   - 问题 3：缺少任务上下文摘要
   - 改进：保留第一条消息、生成会话摘要、注入到 System Prompt

**成果**：
- 完整的架构分析文档（`Clawdbot_Agent大脑架构分析_20260130.md`）
- 发现了 3 个关键问题
- 提出了具体的改进方案
- 为任务分解机制集成提供了清晰的路径

---

## 关键教训

### 1. 不要只看表面
- ❌ 只看入口函数的签名
- ✅ 追踪完整的调用链，理解每一层的职责

### 2. 关注数据流
- ❌ 只关注代码逻辑
- ✅ 关注数据如何流动、转换、存储

### 3. 验证假设
- ❌ 假设代码按预期工作
- ✅ 验证实际行为（可能有缓存、状态管理问题）

### 4. 绘制可视化图
- ❌ 只用文字描述
- ✅ 用图表展示架构和数据流

### 5. 记录改进点
- ❌ 只分析现状
- ✅ 识别问题、提出改进、制定实施计划

---

## 工具推荐

### 1. 代码搜索
- `grepSearch`：搜索关键词
- `fileSearch`：查找文件
- `readMultipleFiles`：批量读取文件

### 2. 数据流追踪
- 添加日志：`log.info`, `log.debug`
- 使用调试器：断点、单步执行
- 查看运行时日志：`runtimelog/trace__*.jsonl`

### 3. 可视化工具
- Mermaid：绘制流程图、架构图
- 文本图：简单的 ASCII 图表
- Markdown 表格：组件对比、数据格式

---

**版本**：v20260130_1  
**来源**：Clawdbot Agent 大脑架构分析实战  
**适用范围**：所有复杂的 Agent 系统架构分析
