# Power 创建与自动化部署流程

## 概述

本文档记录了从现有 Skill 创建 Kiro Power 并实现完全自动化的标准工作流。

---

## 适用场景

- 将现有的 `.kiro/skills/*` 转化为 Kiro Power
- 为新创建的 Power 实现自动化触发
- 让 Power 能够在日常工作中自动激活

---

## 完整工作流

### 阶段 1: 创建 Power 文件

#### 1.1 创建 Power 目录

```bash
mkdir -p powers/{power-name}
```

#### 1.2 创建 POWER.md

**必需的 frontmatter 字段：**
```yaml
---
name: "power-name"
displayName: "Human Readable Name"
description: "清晰的描述（最多 3 句话）"
keywords: ["关键词1", "关键词2", "关键词3"]
author: "作者名称"
---
```

**关键词选择原则：**
- ✅ 使用具体、精确的关键词（例如："代码地图"、"项目记忆"）
- ❌ 避免过于宽泛的关键词（例如："test"、"debug"、"help"）
- 包含中英文关键词，提高匹配率
- 至少 5-7 个关键词

**POWER.md 推荐章节：**
1. 概述（Overview）
2. 核心概念（Core Concepts）
3. 触发场景（Trigger Scenarios）
4. 工作流程（Workflow）
5. 质量门槛（Quality Gates）
6. 最佳实践（Best Practices）
7. 常见问题（FAQ）

#### 1.3 验证 Power 文件

```powershell
# 检查文件是否创建
Get-ChildItem -Path powers/{power-name} -Recurse

# 检查文件大小
Get-Item powers/{power-name}/POWER.md | Select Name, Length
```

---

### 阶段 2: 实施三层自动化

#### 2.1 层级 1: 关键词激活（内置）

**位置：** POWER.md frontmatter

**配置：**
```yaml
keywords: ["关键词1", "关键词2", ...]
```

**效果：** 用户消息包含关键词时，AI 主动激活 Power

**验证：** 在对话中使用关键词，观察 AI 是否自动激活

---

#### 2.2 层级 2: Steering Rules（持久化）

**位置：** `.kiro/steering/always/always_workflow.md`

**添加内容：**

```markdown
## 🧠 {Power 名称}（自动触发）

**核心原则：** {核心原则描述}

### 自动触发场景

当出现以下情况时，**主动激活 {power-name} Power**：

#### 1. {场景 1}
- ✅ {具体条件 1}
- ✅ {具体条件 2}

**行动：** {具体行动描述}

#### 2. {场景 2}
- ✅ {具体条件 1}
- ✅ {具体条件 2}

**行动：** {具体行动描述}

### 质量门槛（每次必须满足）

- ✅ {验证点 1}
- ✅ {验证点 2}
- ✅ {验证点 3}
```

**验证：**
```powershell
# 检查文件是否更新
Get-Content .kiro/steering/always/always_workflow.md -Tail 50
```

---

#### 2.3 层级 3: Agent Hooks（事件驱动）

**创建 Hook 的标准模板：**

```typescript
// Hook 配置
{
  "id": "hook-id",
  "name": "Hook 名称",
  "description": "Hook 描述",
  "eventType": "fileEdited|fileCreated|fileDeleted|agentStop",
  "filePatterns": "src/**/*.ts,src/**/*.js", // 仅文件事件需要
  "hookAction": "askAgent",
  "outputPrompt": "检查是否需要激活 Power..."
}
```

**常见 Hook 类型：**

1. **代码修改后检查**
   - 事件：`fileEdited`
   - 文件模式：`src/**/*.ts`, `src/**/*.js`, `server/**/*.py`
   - 提示：检查是否需要更新相关内容

2. **任务完成后回顾**
   - 事件：`agentStop`
   - 提示：回顾对话，识别可复用模式

3. **新建文件后记录**
   - 事件：`fileCreated`
   - 文件模式：代码文件 + 脚本文件
   - 提示：检查是否需要记录到索引

**验证：**
- 打开命令面板 → "Open Kiro Hook UI"
- 查看 Hook 是否已创建并启用

---

### 阶段 3: 创建配套文档

#### 3.1 自动化配置说明

**位置：** `ProjectMemory/00_索引/自动化配置说明_{power-name}.md`

**内容：**
- 已实施的自动化方案
- 自动化层级说明
- 预期效果
- 管理与维护方法

#### 3.2 快速参考卡片

**位置：** `ProjectMemory/00_索引/快速参考_{power-name}.md`

**内容：**
- Power 功能概述
- 自动触发机制
- 手动调用方法
- 效果验证标准

#### 3.3 更新模块地图

**位置：** `ProjectMemory/00_索引/模块地图.md`

**添加：**
```markdown
## 📚 索引导航

- [自动化配置说明_{power-name}](./自动化配置说明_{power-name}.md) - {Power 名称}的自动化配置
```

---

## 质量门槛（闭环验收）

### 1. Power 文件完整性
- ✅ POWER.md 包含完整的 frontmatter
- ✅ 关键词精确且足够（5-7 个）
- ✅ 文档结构清晰，章节完整

### 2. 自动化层级完整性
- ✅ 层级 1（关键词激活）已配置
- ✅ 层级 2（Steering Rules）已添加
- ✅ 层级 3（Agent Hooks）已创建

### 3. 文档完整性
- ✅ 自动化配置说明已创建
- ✅ 快速参考卡片已创建
- ✅ 模块地图已更新

### 4. 验证测试
- ✅ 关键词触发测试通过
- ✅ Hook 触发测试通过
- ✅ Steering Rules 生效

---

## 文件位置速查

| 文件类型 | 位置 | 用途 |
|----------|------|------|
| Power 定义 | `powers/{power-name}/POWER.md` | Power 的主文档 |
| Steering Rules | `.kiro/steering/always/always_workflow.md` | 持久化的自动触发规则 |
| Agent Hooks | `.kiro/hooks/` | 事件驱动的 Hook 配置 |
| 自动化说明 | `ProjectMemory/00_索引/自动化配置说明_{power-name}.md` | 完整的自动化配置文档 |
| 快速参考 | `ProjectMemory/00_索引/快速参考_{power-name}.md` | 快速参考卡片 |
| 模块地图 | `ProjectMemory/00_索引/模块地图.md` | 总导航 |

---

## 常见问题

### Q: 什么时候应该创建 Power 而不是 Skill？
A: 当你希望能力可以被其他项目/用户复用时，创建 Power。Skill 更适合项目特定的工作流。

### Q: 关键词应该如何选择？
A: 选择具体、精确的关键词。避免"test"、"debug"这类过于宽泛的词，会导致误触发。

### Q: 三层自动化都必须实施吗？
A: 不一定。根据实际需求：
- 最小配置：层级 1（关键词激活）
- 推荐配置：层级 1 + 层级 2（Steering Rules）
- 完全自动化：层级 1 + 层级 2 + 层级 3（Hooks）

### Q: Hook 触发太频繁怎么办？
A: 调整 Hook 的文件匹配模式，或者在 Hook UI 中禁用某些 Hook。

### Q: 如何验证自动化是否生效？
A: 
1. 关键词触发：在对话中使用关键词，观察 AI 反应
2. Steering Rules：查看 AI 是否在相应场景主动提及 Power
3. Hooks：触发相应事件（编辑文件、完成任务），观察 AI 反应

---

## 最佳实践

### 1. 先创建 Power，再实施自动化
不要一次性做完所有事情。先确保 Power 本身可用，再逐步添加自动化。

### 2. 从最小自动化开始
先实施层级 1（关键词激活），观察效果，再考虑是否需要更高层级。

### 3. 关键词要精确
宁可少而精，不要多而泛。过于宽泛的关键词会导致误触发。

### 4. 文档要完整
自动化配置说明和快速参考卡片很重要，方便后续维护和调整。

### 5. 定期回顾效果
观察自动化是否真的提升了效率，是否有误触发，及时调整。

---

**版本：** v20260129_1  
**创建时间：** 2026-01-29  
**最后更新：** 2026-01-29  
**变更：** 初始版本，记录 Power 创建与自动化部署的完整工作流
