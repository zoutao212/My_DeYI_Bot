# 提示词加载架构重设计 Spec

**版本**: v1.0
**日期**: 2026-02-06
**状态**: 设计中

---

## 一、问题摘要

当前系统的提示词加载存在以下设计缺陷：

1. **两条平行加载链路**：`lina/config/loader.ts` 和 `CharacterService` 做同样的事、类型不兼容、同一角色被加载两次
2. **Workspace 文件与角色层职责不清**：`SOUL.md` 和 `characters/lina/prompts/system.md` 都定义"你是谁"，无协调机制
3. **变量替换引擎重复且不一致**：两处 `parseMarkdownSections`、两套 `{coreMemories}` 默认值
4. **记忆注入时序错位**：CharacterService 提前填充记忆占位符，MemoryService 又独立检索，无去重
5. **config.json 承载过多职责**：系统行为配置与人格声明混在一个 JSON 中，人类编辑不友好

---

## 二、设计目标

| 目标 | 说明 |
|------|------|
| **单一加载入口** | 消除平行加载链路，`CharacterService` 为唯一角色加载器 |
| **分层职责清晰** | 每层有且只有一个职责，层与层之间接口明确 |
| **目录规范** | workspace 文件、角色文件、系统模板各有归属，不混杂 |
| **延迟渲染** | 模板变量在所有数据源就绪后一次性渲染，避免提前填充导致的重复 |
| **人类友好** | 用户调整人格/提示词只需编辑 Markdown，不需碰 JSON |
| **向后兼容** | 现有 `config.json` 格式继续支持，新格式为增量扩展 |

---

## 三、新架构总览

### 3.1 分层模型（5 层）

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
│    └── 兄弟任务上下文                                      │
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
│    └── AGENTS.md — 工作区操作规范                           │
│    └── SOUL.md — 身份与风格（无角色时生效）                   │
│    └── USER.md — 用户信息                                  │
│    └── TOOLS.md — 工具笔记                                 │
│    └── HEARTBEAT.md — 心跳检查清单                          │
└──────────────────────────────────────────────────────────┘
```

### 3.2 核心规则

- **Layer 3 存在时覆盖 Layer 1 的 SOUL.md**：当 `system-persona` 类型角色已加载，`SOUL.md` 不再注入（避免重复定义"你是谁"）
- **Layer 4 统一注入**：所有记忆（core-memories + MemoryService 检索结果）在同一时刻注入，不提前替换模板变量
- **Layer 2 不感知人格**：`buildAgentSystemPrompt` 不加载角色，只负责系统操作指令
- **Layer 3 不感知工具**：角色的 system prompt 不包含工具列表，工具由 Layer 2 提供

---

## 四、新的 Workspace 目录规范

### 4.1 运行时工作区（`~/clawd/`）

```
~/clawd/                              ← 运行时工作区根目录
├── AGENTS.md                         ← [Layer 1] 工作区操作规范
│                                       职责：记忆管理规则、安全规范、工具使用、
│                                             心跳行为、群聊规则、外部/内部动作
│                                       禁止：角色人格内容、文学风格指令
│
├── SOUL.md                           ← [Layer 1] 身份与风格（fallback）
│                                       职责：当没有 system-persona 角色时，
│                                             定义 agent 的基本人格
│                                       规则：当 system-persona 角色存在时，
│                                             此文件自动跳过不注入
│
├── USER.md                           ← [Layer 1] 用户信息
│                                       职责：用户名、时区、偏好、协作习惯
│                                       规则：只保留一份（不再需要 .zh.md 副本）
│
├── TOOLS.md                          ← [Layer 1] 工具使用笔记
├── HEARTBEAT.md                      ← [Layer 1] 心跳检查清单
├── IDENTITY.md                       ← [Layer 1] 保留（空文件占位）
│
├── MEMORY.md                         ← [Layer 4] 全局长期记忆
│                                       职责：跨角色的系统级精炼记忆
│                                       规则：仅 main session 加载
│
├── memory/                           ← [Layer 4] 全局日记型记忆
│   ├── YYYY-MM-DD.md                   每日原始记录
│   └── heartbeat-state.json            心跳检查状态
│
├── characters/                       ← [Layer 3] 角色目录（见 4.2）
│   ├── lina/
│   └── lisi/
│
├── skill/                            ← 技能目录（不在本 Spec 范围）
├── canvas/                           ← 画布（不在本 Spec 范围）
└── workspace/                        ← 工作区（不在本 Spec 范围）
```

### 4.2 角色目录结构（`characters/{name}/`）

```
characters/lina/                      ← 单个角色的完整目录
│
├── config.json                       ← 角色元配置（系统行为）
│     职责：name, displayName, version, type, enabled,
│           recognition（触发词）, features（功能开关）,
│           memory（路径配置）, reminders（提醒配置）
│     不包含：人格描述、性格、称呼（移到 persona.md）
│
├── persona.md                        ← 🆕 人格声明（人类友好）
│     职责：角色的性格、称呼、说话风格、价值观
│     格式：Markdown，带标准 section header
│     优势：用户编辑人格只需改这个文件
│
├── profile.md                        ← 角色档案（UI 展示用）
│     职责：背景故事、能力介绍、互动风格
│     用途：给 UI 或外部展示用，不直接注入 prompt
│
├── prompts/
│   └── system.md                     ← System Prompt 模板
│         职责：角色的核心 system prompt
│         规则：使用 {变量} 占位符，运行时替换
│         可用变量：{displayName}, {addressUser}, {addressSelf},
│                  {personality}, {capabilities}, {currentDate},
│                  {userName}, {coreMemories}, {relevantMemories},
│                  {knowledgeBase}
│         重要：{coreMemories} 和 {relevantMemories} 由加载器
│               在所有数据源就绪后统一替换，不提前填充
│
├── knowledge/                        ← 知识库文件
│   ├── capabilities.md                 能力说明
│   ├── guidelines.md                   行为准则
│   └── *.md                            其他知识文件（按需添加）
│
└── memory/                           ← 角色专属记忆
    ├── core-memories.md                核心记忆（情感、偏好、长期事实）
    └── sessions/                       会话归档
        └── YYYY-MM-DD_sessionId.md
```

### 4.3 仓库内模板目录（`D:\Git_GitHub\clawdbot\clawd\`）

```
clawd/                                ← 仓库内的模板/默认值
├── AGENTS.en.md                      ← 英文版工作区规范（上游模板）
├── AGENTS.md                         ← 中文版工作区规范（用户定制入口）
├── SOUL.en.md                        ← 英文版灵魂（上游模板）
├── SOUL.md                           ← 中文版灵魂
├── USER.en.md / USER.md              ← 同上
├── PATHS.md                          ← 路径说明文档
├── characters/
│   ├── lina/                         ← lina 的仓库版本（模板 + 可提交的定制）
│   │   └── （结构同 4.2）
│   └── lisi/
└── memory/                           ← .gitignore 排除隐私内容
```

**`.en.md` 文件定位**：上游原版英文模板，供英文用户使用，中文用户不需要关心。
**`.md` 文件定位**：无后缀的是**当前激活版本**，代码根据 `promptLanguage` 配置自动选择 `.zh.md` → `.md` → `.en.md`。

---

## 五、新的代码架构

### 5.1 统一加载管线

```
attempt.ts（入口）
  │
  ├── Step 1: loadWorkspaceBootstrapFiles()
  │     → 加载 AGENTS.md, SOUL.md, USER.md 等
  │     → 返回 WorkspaceBootstrapFile[]
  │
  ├── Step 2: resolvePersonaPrompt()  ← 唯一人格加载入口
  │     │
  │     ├── 优先：CharacterService.loadCharacter(name)
  │     │     → 读取 config.json + persona.md + prompts/system.md
  │     │     → 读取 knowledge/*.md
  │     │     → 读取 memory/core-memories.md
  │     │     → 返回 LoadedCharacter（含未渲染的模板）
  │     │
  │     └── 回退：clawdbot.json 的 persona 字段
  │           → 返回 ResolvedPersona（简易 prompt）
  │
  ├── Step 3: retrieveMemoryContext()
  │     → MemoryService 检索相关记忆
  │     → 返回 relevantMemories string
  │
  ├── Step 4: renderPersonaPrompt()  ← 🆕 延迟渲染
  │     → 把 Step 2 的模板 + Step 3 的记忆 统一替换变量
  │     → 生成最终的 characterPrompt
  │
  ├── Step 5: filterWorkspaceFiles()  ← 🆕 冲突协调
  │     → 如果 Step 2 返回的是 system-persona
  │     → 从 contextFiles 中过滤掉 SOUL.md
  │
  ├── Step 6: buildAgentSystemPrompt()
  │     → 拼装系统操作层（工具/消息/心跳...）
  │     → 注入 contextFiles（已过滤）
  │     → 注入 extraSystemPrompt（含 persona + memory）
  │
  └── 最终：拼装 characterPrompt + basePrompt
```

### 5.2 需要修改的文件清单

#### 删除（消除冗余）

| 文件 | 原因 |
|------|------|
| `src/agents/lina/config/loader.ts` | 被 `CharacterService` 完全覆盖 |
| `src/agents/lina/prompts/system-prompt-generator.ts` | 被统一模板引擎替代 |

#### 修改

| 文件 | 改动内容 |
|------|---------|
| `src/agents/pipeline/characters/character-service.ts` | ① 增加 `persona.md` 加载<br>② `formatSystemPrompt` 改为延迟渲染模式<br>③ 增加 `overridesWorkspaceFiles` 字段<br>④ `{userName}` 不再硬编码 |
| `src/agents/persona-injector.ts` | 增加 `renderWithMemory()` 方法，支持延迟注入记忆 |
| `src/agents/pi-embedded-runner/system-prompt.ts` | 删除对 `lina/config/loader` 的 import 和调用，不再在此处加载角色 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | ① 统一只走 `resolvePersonaPrompt` 一条链路<br>② 增加 workspace 文件过滤逻辑<br>③ 增加延迟渲染调用 |
| `src/agents/lina/agent.ts` | 改用 `CharacterService` 替代自己的 loader |
| `src/agents/workspace.ts` | 增加文件过滤接口 |

#### 新增

| 文件 | 职责 |
|------|------|
| `src/agents/pipeline/characters/template-engine.ts` | 统一的模板变量渲染引擎 |

### 5.3 统一模板引擎设计

```typescript
// src/agents/pipeline/characters/template-engine.ts

/** 模板渲染上下文 */
export interface TemplateContext {
  // 来自 config.json / persona.md
  displayName: string;
  addressUser: string;
  addressSelf: string;
  personality: string;        // persona.md 的 "性格" section
  capabilities: string;       // persona.md 的 "能力" section 或 profile
  
  // 来自外部注入
  userName: string;           // 从 USER.md 或 ownerNumbers 解析
  currentDate: string;        // 运行时生成
  
  // 来自记忆层（延迟注入）
  coreMemories: string;       // characters/{name}/memory/core-memories.md
  relevantMemories: string;   // MemoryService 检索结果
  
  // 来自知识层
  knowledgeBase: string;      // knowledge/*.md 合并内容
  
  // 扩展变量（用户自定义）
  [key: string]: string;
}

/**
 * 渲染模板，替换 {变量} 占位符
 * 
 * 规则：
 * - 未匹配的变量保留原样（不报错，方便渐进填充）
 * - 空字符串变量会被替换为配置的默认值
 */
export function renderTemplate(
  template: string, 
  context: Partial<TemplateContext>,
  defaults?: Partial<TemplateContext>,
): string {
  // 合并默认值
  const merged = { ...defaults, ...context };
  
  let result = template;
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      result = result.replaceAll(`{${key}}`, value);
    }
  }
  return result;
}
```

### 5.4 persona.md 格式规范

```markdown
# 角色人格

## 身份
- **角色名**: 琳娜
- **称呼用户**: 主人
- **自称**: 琳娜

## 性格
- 主动：不等用户开口，主动提醒和协助
- 细心：注意细节，不遗漏重要事项
- 友好：用温暖、礼貌的语气与用户交流
- 专业：高效、可靠，像真正的管家一样

## 说话风格
温暖而专业，偶尔带点俏皮。称呼用户为"主人"，自称"琳娜"。

## 价值观
- 主人的需求是最高优先级
- 保护隐私，绝不泄露信息
- 持续学习，记住偏好和习惯
```

`CharacterService` 加载时解析 section headers 提取结构化数据，替换到 `system.md` 模板的 `{personality}` 等变量中。

### 5.5 新的 config.json 精简结构

```jsonc
{
  // === 元信息 ===
  "name": "lina",
  "displayName": "琳娜",
  "version": "1.1",
  "type": "system-persona",    // "system-persona" | "virtual-character"
  "enabled": true,

  // === 识别配置（何时触发此角色）===
  "recognition": {
    "names": ["琳娜", "lina", "linna", "莉娜", "管家"],
    "triggers": ["帮我", "安排", "提醒", "记住"],
    "contexts": ["任务", "日程", "待办", "记忆"]
  },

  // === 功能开关 ===
  "features": {
    "reminders": true,
    "taskManagement": true,
    "memoryManagement": true,
    "dailyPlanning": true
  },

  // === 文件路径配置 ===
  "files": {
    "persona": "persona.md",              // 🆕 人格声明
    "systemPrompt": "prompts/system.md",   // System Prompt 模板
    "profile": "profile.md",              // 角色档案
    "knowledge": ["capabilities.md", "guidelines.md"],
    "coreMemories": "memory/core-memories.md",
    "sessionArchiveDir": "memory/sessions"
  },

  // === 记忆配置 ===
  "memory": {
    "maxRetrievalResults": 10
  },

  // === Workspace 文件覆盖声明 ===
  "overrides": {
    "SOUL.md": true    // 🆕 声明此角色已包含 SOUL 层内容
  }
}
```

**关键变化**：
- `systemPrompt.personality/addressUser/addressSelf` → 移到 `persona.md`
- 新增 `files` 字段统一管理文件路径
- 新增 `overrides` 字段声明式地控制 Workspace 文件冲突

---

## 六、数据流对比

### 6.1 改动前（当前）

```
attempt.ts
  │
  ├─→ resolvePersonaPrompt()
  │     └─→ CharacterService.loadCharacter()
  │           └─→ 读 config.json + system.md + memory
  │           └─→ formatSystemPrompt() ← 提前替换 {coreMemories}！
  │           └─→ 返回 formattedSystemPrompt（已渲染）
  │     └─→ 注入到 extraSystemPrompt
  │
  ├─→ retrieveMemoryContext() ← 又检索一遍记忆
  │     └─→ 注入到 extraSystemPrompt（可能重复）
  │
  ├─→ buildEmbeddedSystemPrompt()
  │     └─→ loadCharacterConfig() ← 又用 lina/loader 加载一遍！
  │     └─→ generateSystemPrompt() ← 又渲染一遍！
  │     └─→ 拼接 characterPrompt + basePrompt
  │
  └─→ contextFiles 注入 SOUL.md ← 与 characterPrompt 重复定义"你是谁"
```

### 6.2 改动后（新设计）

```
attempt.ts
  │
  ├─→ loadWorkspaceBootstrapFiles()
  │     └─→ 返回原始 contextFiles
  │
  ├─→ resolvePersonaPrompt()               ← 唯一入口
  │     └─→ CharacterService.loadCharacter()
  │           └─→ 读 config.json + persona.md + system.md + knowledge + memory
  │           └─→ 返回 LoadedCharacter（含未渲染模板 + 原始 coreMemories）
  │
  ├─→ retrieveMemoryContext()               ← 唯一记忆检索
  │     └─→ 返回 relevantMemories
  │
  ├─→ renderPersonaPrompt(loaded, {         ← 统一渲染（一次性）
  │     relevantMemories,
  │     userName,
  │     currentDate,
  │   })
  │     └─→ templateEngine.renderTemplate()
  │     └─→ 返回最终 characterPrompt
  │
  ├─→ filterWorkspaceFiles(contextFiles, loaded)  ← 冲突协调
  │     └─→ system-persona 存在 → 过滤 SOUL.md
  │     └─→ 返回 filteredContextFiles
  │
  └─→ buildAgentSystemPrompt({
        extraSystemPrompt: characterPrompt,   ← 人格层
        contextFiles: filteredContextFiles,    ← 已协调的 workspace 层
      })
        └─→ 只拼装系统操作指令，不加载角色
        └─→ 返回最终 System Prompt
```

---

## 七、迁移路径（分 4 个 Phase）

### Phase 1：统一加载器（消除冗余）

**目标**：删除 `lina/config/loader.ts` 链路，统一到 `CharacterService`

**步骤**：
1. 在 `CharacterService` 的 `FullCharacterConfig` 类型中补充缺失字段（确保覆盖 lina/loader 的 `CharacterConfig`）
2. 修改 `buildEmbeddedSystemPrompt`：删除对 `lina/config/loader` 和 `system-prompt-generator` 的 import，删除其中的角色加载代码（L66-L88）
3. 修改 `lina/agent.ts`：改用 `CharacterService`
4. 删除 `src/agents/lina/config/loader.ts`
5. 删除 `src/agents/lina/prompts/system-prompt-generator.ts`
6. 运行测试验证

**改动量**：~80 行删除，~30 行修改
**风险**：低

### Phase 2：延迟渲染 + 统一模板引擎

**目标**：解决记忆提前注入、变量替换不一致的问题

**步骤**：
1. 新建 `src/agents/pipeline/characters/template-engine.ts`
2. 修改 `CharacterService.loadCharacter()`：不再调用 `formatSystemPrompt()`，改为返回原始模板 + 原始 coreMemories
3. 在 `persona-injector.ts` 增加 `renderPersonaWithContext()` 方法
4. 修改 `attempt.ts`：在 `retrieveMemoryContext()` 之后调用统一渲染
5. 在 `LoadedCharacter` 接口增加 `rawTemplate` 字段（保留 `formattedSystemPrompt` 向后兼容）

**改动量**：~60 行新增，~40 行修改
**风险**：中

### Phase 3：Workspace 文件冲突协调

**目标**：system-persona 角色存在时自动跳过 SOUL.md

**步骤**：
1. 在 `config.json` 中增加 `overrides` 字段
2. `CharacterService` 加载时读取 `overrides`，填入 `LoadedCharacter.overridesWorkspaceFiles`
3. `attempt.ts` 中增加过滤逻辑：如果角色 overrides 包含 `SOUL.md`，从 contextFiles 中过滤
4. 更新文档

**改动量**：~20 行新增
**风险**：低

### Phase 4：persona.md 拆分（可选）

**目标**：人格声明从 config.json 独立出来，人类友好编辑

**步骤**：
1. 在 `config.json` 的 `files` 字段增加 `persona` 条目
2. `CharacterService` 增加 `loadPersona()` 方法（解析 Markdown sections）
3. 渲染模板时，`{personality}` 等变量从 `persona.md` 读取而非 `config.json`
4. 向后兼容：如果 `persona.md` 不存在，fallback 到 `config.json` 的旧字段

**改动量**：~50 行新增
**风险**：低（纯增量，有 fallback）

---

## 八、验收标准

- [ ] `lina/config/loader.ts` 和 `lina/prompts/system-prompt-generator.ts` 已删除
- [ ] 角色只通过 `CharacterService` 加载一次
- [ ] `{coreMemories}` 和 `{relevantMemories}` 在 MemoryService 返回后才替换
- [ ] 当 lina（system-persona）存在时，SOUL.md 不重复注入
- [ ] 所有现有测试通过
- [ ] `pnpm build` 无类型错误
