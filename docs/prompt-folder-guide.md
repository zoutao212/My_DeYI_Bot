# 提示词文件夹管理指南

本文档说明 Clawdbot 的提示词加载架构、目录规范和角色配置方法。

---

## 一、架构总览（5 层模型）

```
┌──────────────────────────────────────────────────────────┐
│              最终 System Prompt（送给 LLM）                │
│                                                          │
│  Layer 5: Hook 动态注入                                    │
│    └── before_agent_start hook 返回的 prependContext       │
│                                                          │
│  Layer 4: 记忆层（Memory）                                 │
│    └── MemoryService 检索的相关记忆                         │
│    └── 角色的 core-memories.md                             │
│                                                          │
│  Layer 3: 人格层（Persona）                                │
│    └── characters/{name}/ 目录制角色                       │
│    └── 或 clawdbot.json 的 persona 字段（fallback）        │
│                                                          │
│  Layer 2: 系统操作层（System）                              │
│    └── 硬编码 l10n 模板（工具/消息/心跳/沙箱/推理格式...）    │
│    └── buildAgentSystemPrompt()                           │
│                                                          │
│  Layer 1: Workspace 文件层（Context）                      │
│    └── AGENTS.md / SOUL.md / USER.md / TOOLS.md 等        │
└──────────────────────────────────────────────────────────┘
```

### 核心规则

- **Layer 3 存在时覆盖 Layer 1 的 SOUL.md**：当 `system-persona` 类型角色已加载，`SOUL.md` 不再注入（避免重复定义"你是谁"）
- **Layer 4 统一注入**：所有记忆在 MemoryService 返回后一次性渲染到模板，不提前替换
- **Layer 2 不感知人格**：`buildAgentSystemPrompt` 不加载角色，只负责系统操作指令
- **Layer 3 不感知工具**：角色的 system prompt 不包含工具列表，工具由 Layer 2 提供

---

## 二、运行时工作区目录（`~/clawd/`）

```
~/clawd/
├── AGENTS.md              ← [Layer 1] 工作区操作规范
├── SOUL.md                ← [Layer 1] 身份与风格（无角色时生效）
├── USER.md                ← [Layer 1] 用户信息
├── TOOLS.md               ← [Layer 1] 工具使用笔记
├── HEARTBEAT.md           ← [Layer 1] 心跳检查清单
├── IDENTITY.md            ← [Layer 1] 保留（空文件占位）
├── MEMORY.md              ← [Layer 4] 全局长期记忆
│
├── memory/                ← [Layer 4] 全局日记型记忆
│   ├── YYYY-MM-DD.md
│   └── heartbeat-state.json
│
├── characters/            ← [Layer 3] 角色目录
│   ├── lina/
│   └── lisi/
│
├── skill/                 ← 技能目录
├── canvas/                ← 画布
└── workspace/             ← 工作区
```

### 文件职责说明

| 文件 | 层级 | 职责 | 注意事项 |
|------|------|------|---------|
| `AGENTS.md` | L1 | 记忆管理规则、安全规范、工具使用、心跳行为 | **禁止**放角色人格内容 |
| `SOUL.md` | L1 | 无角色时定义 agent 的基本人格 | 当 system-persona 角色存在时**自动跳过** |
| `USER.md` | L1 | 用户名、时区、偏好、协作习惯 | 只保留一份 |
| `TOOLS.md` | L1 | 工具使用笔记 | — |
| `HEARTBEAT.md` | L1 | 心跳检查清单 | — |

---

## 三、角色目录结构（`characters/{name}/`）

```
characters/lina/
│
├── config.json            ← 角色元配置（系统行为）
├── persona.md             ← 🆕 人格声明（人类友好编辑）
├── profile.md             ← 角色档案（UI 展示用）
│
├── prompts/
│   └── system.md          ← System Prompt 模板
│
├── knowledge/
│   ├── capabilities.md    ← 能力说明
│   └── guidelines.md      ← 行为准则
│
└── memory/
    ├── core-memories.md   ← 核心记忆
    └── sessions/          ← 会话归档
        └── YYYY-MM-DD_sessionId.md
```

### 3.1 `config.json` — 角色元配置

只放**系统行为配置**，不放人格描述：

```jsonc
{
  "name": "lina",
  "displayName": "栗娜",
  "version": "1.1",
  "type": "system-persona",    // "system-persona" | "virtual-character"
  "enabled": true,

  "recognition": {
    "names": ["栗娜", "lina"],
    "triggers": ["帮我", "安排", "提醒"],
    "contexts": ["任务", "日程", "待办"]
  },

  "features": {
    "reminders": true,
    "taskManagement": true,
    "memoryManagement": true
  },

  "systemPrompt": {
    "role": "管家助理",
    "personality": ["主动", "细心", "友好"],
    "addressUser": "主人",
    "addressSelf": "栗娜"
  },

  "memory": {
    "coreMemoriesFile": "core-memories.md",
    "sessionArchiveDir": "sessions",
    "maxRetrievalResults": 10
  },

  "prompts": { "systemPromptTemplate": "system.md" },
  "knowledge": { "files": ["capabilities.md", "guidelines.md"] },

  // 🆕 文件路径配置
  "files": {
    "persona": "persona.md",
    "systemPrompt": "prompts/system.md",
    "profile": "profile.md",
    "knowledge": ["capabilities.md", "guidelines.md"],
    "coreMemories": "memory/core-memories.md"
  },

  // 🆕 声明此角色覆盖的 Workspace 文件
  "overrides": {
    "SOUL.md": true
  }
}
```

### 3.2 `persona.md` — 人格声明（🆕 推荐）

用 Markdown 编辑角色人格，比 JSON 更友好：

```markdown
# 角色人格

## 身份
- **角色名**: 栗娜
- **称呼用户**: 主人
- **自称**: 栗娜

## 性格
- 主动：不等用户开口，主动提醒和协助
- 细心：注意细节，不遗漏重要事项

## 说话风格
温暖而专业，偶尔带点俏皮。

## 价值观
- 主人的需求是最高优先级
- 保护隐私，绝不泄露信息
```

**加载优先级**：`persona.md` 存在时优先使用，不存在时 fallback 到 `config.json` 的 `systemPrompt.personality`。

### 3.3 `prompts/system.md` — System Prompt 模板

使用 `{变量}` 占位符，运行时由模板引擎统一替换：

```markdown
# 栗娜 System Prompt

你是栗娜，{userName}的专属管家助理。

## 身份
- **称呼用户**：{addressUser}
- **自称**：{addressSelf}

## 性格特征
{personality}

## 核心能力
{capabilities}

## 当前日期
{currentDate}

## 核心记忆
{coreMemories}

## 相关记忆
{relevantMemories}
```

**可用变量**：

| 变量 | 来源 | 说明 |
|------|------|------|
| `{displayName}` | config.json | 角色显示名 |
| `{addressUser}` | config.json / persona.md | 称呼用户 |
| `{addressSelf}` | config.json / persona.md | 自称 |
| `{personality}` | persona.md > config.json | 性格描述 |
| `{capabilities}` | profile.md | 能力说明 |
| `{userName}` | USER.md / ownerNumbers | 用户名 |
| `{currentDate}` | 运行时 | 当前日期 |
| `{coreMemories}` | memory/core-memories.md | 核心记忆（**延迟注入**） |
| `{relevantMemories}` | MemoryService | 检索记忆（**延迟注入**） |
| `{knowledgeBase}` | knowledge/*.md | 知识库合并内容 |
| `{characterProfile}` | profile.md | 角色档案原文 |

> **重要**：`{coreMemories}` 和 `{relevantMemories}` 在所有数据源就绪后才替换，不会被提前填充为默认值。

---

## 四、加载流程

```
attempt.ts（入口）
  │
  ├── Step 1: loadWorkspaceBootstrapFiles()
  │     → 加载 AGENTS.md, SOUL.md, USER.md 等
  │
  ├── Step 2: resolvePersonaPrompt()  ← 唯一人格加载入口
  │     ├── 优先：CharacterService.loadCharacter(name)
  │     │     → 读取 config.json + persona.md + system.md + knowledge + memory
  │     │     → 返回 LoadedCharacter（含未渲染模板）
  │     └── 回退：clawdbot.json 的 persona 字段
  │
  ├── Step 3: retrieveMemoryContext()
  │     → MemoryService 检索相关记忆
  │
  ├── Step 4: renderPersonaWithContext()  ← 延迟渲染
  │     → 模板 + 记忆 统一替换变量
  │
  ├── Step 5: filterWorkspaceFiles()  ← 冲突协调
  │     → system-persona 存在 → 过滤 SOUL.md
  │
  └── Step 6: buildAgentSystemPrompt()
        → 拼装系统操作层 + contextFiles + persona
```

---

## 五、如何创建新角色

### 快速开始

1. 在 `~/clawd/characters/` 下创建角色目录：

```bash
mkdir -p ~/clawd/characters/mychar/{prompts,knowledge,memory/sessions}
```

2. 创建 `config.json`（复制 lina 的模板修改）

3. 创建 `persona.md`（定义人格）

4. 创建 `prompts/system.md`（编写 System Prompt 模板）

5. 可选：创建 `profile.md`、`knowledge/*.md`、`memory/core-memories.md`

### 角色类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `system-persona` | 系统人格化，覆盖 SOUL.md | 栗娜（管家） |
| `virtual-character` | 虚拟角色，不覆盖 SOUL.md | 丽丝（角色扮演） |

---

## 六、常见问题

### Q: SOUL.md 和角色的 system.md 冲突怎么办？

在角色的 `config.json` 中设置 `"overrides": { "SOUL.md": true }`，系统会自动在该角色激活时跳过 SOUL.md 的注入。

### Q: 记忆为什么显示"暂无核心记忆"？

模板变量 `{coreMemories}` 在 `memory/core-memories.md` 为空时会显示默认值。向该文件写入内容即可。

### Q: 如何让角色使用英文？

在 `clawdbot.json` 中设置 `agents.defaults.promptLanguage: "en"`，系统会自动加载 `.en.md` 后缀的文件。

### Q: persona.md 和 config.json 的 personality 字段哪个优先？

`persona.md` 优先。如果 `persona.md` 不存在，fallback 到 `config.json` 的 `systemPrompt.personality` 数组。
