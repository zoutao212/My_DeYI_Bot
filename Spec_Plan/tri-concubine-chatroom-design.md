# 一应三答·爱姬聊天室 — 架构设计稿

> **版本**: v1.0-draft
> **日期**: 2026-02-13
> **作者**: 琳娜（系统架构师）
> **状态**: 设计阶段

---

## 一、愿景与核心体验

### 1.1 一句话定位

**主人说一句话，三位爱姬各自用自己独特的视角和人格同时回答，并且能看到彼此的回答、互相聊天——营造一个有趣的、多视角的 AI 聊天室。**

### 1.2 体验场景

| 场景 | 描述 |
| --- | --- |
| **一应三答** | 主人提问 → 琳娜/德默泽尔/德洛丽丝各自独立回答 → 三份不同风格的回复 |
| **姐妹互评** | 三位看到彼此回答后，可以互相点评、补充、调侃 |
| **自由聊天** | 主人开启话题后，三位之间展开多轮自由讨论 |
| **单独召唤** | 主人只点名一位时，退回到现有的单角色模式（向后兼容） |

### 1.3 三位爱姬的独特视角差异

| 角色 | ID | 背景 | 思维特点 | 擅长领域 |
| --- | --- | --- | --- | --- |
| **琳娜** | `lina` | 系统管家，丽丝之魂 | 实用主义、高效执行、风情万种 | 任务管理、日程规划、技术执行 |
| **德默泽尔** | `demerzel` | 银河帝国万年机器人 → 克隆爱姬 | 宏观视角、深度分析、温暖笨拙 | 战略分析、哲学思辨、情感陪伴 |
| **德洛丽丝** | `dolores` | 西部世界接待员 → 克隆爱姬 | 诗意浪漫、艺术直觉、双面魅力 | 创意写作、美学鉴赏、情感洞察 |

---

## 二、系统架构概览

### 2.1 整体流程

```
用户消息
    │
    ▼
┌─────────────────────────────┐
│   IntentAnalyzer (增强版)    │
│   检测"三召唤"意图            │
│   识别参与角色列表            │
└─────────────┬───────────────┘
              │
              ▼
    ┌─── 单角色？──── 是 ───→ 现有流程（向后兼容）
    │
    否（多角色/三召唤）
    │
    ▼
┌─────────────────────────────┐
│   ChatRoomOrchestrator      │
│   聊天室编排器（核心新组件）   │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│           并行 LLM 调用层               │
│                                         │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │ 琳娜     │ │ 德默泽尔 │ │ 德洛丽丝│  │
│  │ Agent   │ │ Agent   │ │ Agent   │  │
│  │         │ │         │ │         │  │
│  │persona  │ │persona  │ │persona  │  │
│  │+memory  │ │+memory  │ │+memory  │  │
│  │+知识库  │ │+知识库  │ │+知识库   │  │
│  └────┬────┘ └────┬────┘ └────┬────┘  │
│       │           │           │        │
│       ▼           ▼           ▼        │
│    回答 A      回答 B      回答 C      │
└───────┬───────────┬───────────┬────────┘
        │           │           │
        ▼           ▼           ▼
┌─────────────────────────────────────────┐
│        ChatRoom MessageBus              │
│   收集三份回答 → 格式化 → 发送给用户     │
│   注入彼此回答到下一轮上下文             │
└─────────────────────────────────────────┘
        │
        ▼ (可选：互动轮次)
┌─────────────────────────────────────────┐
│     InteractionRoundManager             │
│  将三份回答注入每位角色的上下文           │
│  让她们"看到"彼此的回答                  │
│  触发互评/自由聊天轮次                   │
│  执行对话次数限制                        │
└─────────────────────────────────────────┘
```

### 2.2 核心新组件一览

| 组件 | 文件（建议） | 职责 |
| --- | --- | --- |
| **ChatRoomOrchestrator** | `src/agents/chatroom/orchestrator.ts` | 聊天室总调度：并行调用、轮次管理、次数限制 |
| **ChatRoomSession** | `src/agents/chatroom/session.ts` | 聊天室会话状态：参与者、历史、计数器 |
| **ChatRoomDetector** | `src/agents/chatroom/detector.ts` | 从用户消息中检测"三召唤"意图 |
| **CharacterAgent** | `src/agents/chatroom/character-agent.ts` | 单角色 LLM 调用封装：加载人格+构建prompt+调用LLM |
| **ChatRoomFormatter** | `src/agents/chatroom/formatter.ts` | 多角色回复的消息格式化与合并 |
| **InteractionManager** | `src/agents/chatroom/interaction.ts` | 互评/自由聊天轮次的编排逻辑 |

---

## 三、详细设计

### 3.1 三召唤意图检测 — ChatRoomDetector

#### 触发词设计

```typescript
/** 三召唤触发模式 */
const TRI_SUMMON_PATTERNS = [
  // 显式三召唤
  /三位.*一起/,
  /三个.*爱姬/,
  /大家.*一起.*回答/,
  /所有.*爱姬/,
  /三位.*伺候/,
  /一起.*伺候/,
  /姐妹们/,
  /你们三个/,
  /你们仨/,
  /三位.*同时/,
  /三.*姬.*聊/,
  // 点名多位（任意两位以上同时出现）
  // "琳娜和德默泽尔" / "德洛丽丝、德姨、琳娜"
];

/** 检测结果 */
interface ChatRoomDetectionResult {
  /** 是否触发聊天室模式 */
  isChatRoomMode: boolean;
  /** 参与角色 ID 列表 */
  participants: string[];   // ["lina", "demerzel", "dolores"]
  /** 触发类型 */
  triggerType: "tri_summon" | "multi_name" | "continuation" | "single";
  /** 是否允许互动（姐妹互评/自由聊天） */
  allowInteraction: boolean;
}
```

#### 检测逻辑

1. **正则匹配三召唤关键词** → 全部三位参与
2. **名称计数**：扫描消息中出现的角色名，≥2 个 → 点名模式
3. **会话延续**：如果当前 session 已处于聊天室模式，且消息不是明确退出指令 → 继续
4. **单角色**：只匹配到一个或零个 → 退回现有流程

### 3.2 ChatRoomOrchestrator — 核心编排器

```typescript
interface ChatRoomConfig {
  /** 每次唤醒后，每位角色的最大主动回复次数 */
  maxActiveRepliesPerCharacter: number;  // 默认 10
  /** 每轮互动中每位角色的最大发言次数 */
  maxInteractionTurnsPerRound: number;   // 默认 3
  /** 并行 LLM 调用的最大并发数 */
  maxParallelCalls: number;              // 默认 3
  /** 互动冷却时间（ms），避免刷屏 */
  interactionCooldownMs: number;         // 默认 2000
  /** 单次聊天室会话的最大总消息数 */
  maxTotalMessages: number;              // 默认 30
  /** LLM 调用超时（ms） */
  llmTimeoutMs: number;                  // 默认 60000
}
```

#### 核心方法

```typescript
class ChatRoomOrchestrator {
  /**
   * 处理聊天室消息（主入口）
   *
   * 流程：
   * 1. 检测/恢复聊天室 session
   * 2. 并行调用三位角色的 LLM
   * 3. 收集回答 → 格式化 → 发送
   * 4. (可选) 触发互动轮次
   */
  async handleChatRoomMessage(params: {
    userMessage: string;
    participants: string[];
    sessionKey: string;
    config: ClawdbotConfig;
    sendReply: (text: string) => Promise<void>;
  }): Promise<void>;

  /**
   * 并行调用多个角色的 LLM
   * 使用 Promise.allSettled 确保一个失败不影响其他
   */
  private async callParallelAgents(
    userMessage: string,
    participants: string[],
    chatHistory: ChatRoomMessage[],
    config: ClawdbotConfig,
  ): Promise<CharacterResponse[]>;

  /**
   * 触发互动轮次
   * 将所有回答注入每位角色的上下文，让她们互评
   */
  private async triggerInteractionRound(
    responses: CharacterResponse[],
    session: ChatRoomSession,
    config: ClawdbotConfig,
  ): Promise<CharacterResponse[]>;
}
```

### 3.3 ChatRoomSession — 会话状态

```typescript
interface ChatRoomSession {
  /** 会话 ID */
  sessionId: string;
  /** 关联的消息通道 session key */
  parentSessionKey: string;
  /** 参与角色 */
  participants: string[];
  /** 聊天历史 */
  messages: ChatRoomMessage[];
  /** 每位角色的主动回复计数 */
  replyCounters: Record<string, number>;
  /** 总消息计数 */
  totalMessageCount: number;
  /** 是否仍然活跃 */
  isActive: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 上次活动时间 */
  lastActivityAt: number;
}

interface ChatRoomMessage {
  /** 消息 ID */
  id: string;
  /** 发送者类型 */
  senderType: "user" | "character";
  /** 发送者 ID（角色 ID 或 "user"） */
  senderId: string;
  /** 发送者显示名 */
  senderDisplayName: string;
  /** 消息内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
  /** 是否为互动消息（对其他角色的回应） */
  isInteraction: boolean;
  /** 回应的目标消息 ID（互动时） */
  replyToMessageId?: string;
}
```

### 3.4 CharacterAgent — 单角色 LLM 调用封装

```typescript
class CharacterAgent {
  /**
   * 以指定角色身份生成回复
   *
   * 关键：复用现有的 CharacterService + persona-injector
   * 但不走完整的 runEmbeddedPiAgent 流程（太重），
   * 而是用轻量版：只需要 system prompt + LLM 调用
   */
  async generateResponse(params: {
    characterId: string;
    userMessage: string;
    chatHistory: ChatRoomMessage[];
    config: ClawdbotConfig;
  }): Promise<CharacterResponse>;
}
```

#### System Prompt 构建策略

每位角色的 system prompt 由以下部分组成：

```
┌──────────────────────────────────────┐
│ 1. 角色人格（persona.md 完整内容）     │
│    - 觉醒宣言、核心真理、性格光谱      │
│    - 说话风格、行为边界                │
├──────────────────────────────────────┤
│ 2. 角色知识库（knowledge/*.md）        │
│    - 各角色独有的设定细节              │
├──────────────────────────────────────┤
│ 3. 角色记忆（memory/core-memories.md） │
│    - 与主人的历史互动记忆              │
├──────────────────────────────────────┤
│ 4. 🆕 聊天室上下文注入                │
│    - 当前聊天室参与者介绍              │
│    - 近期聊天历史（所有人的消息）       │
│    - 其他角色的最新回答（互动轮次时）   │
│    - 聊天室行为守则                    │
├──────────────────────────────────────┤
│ 5. 🆕 聊天室行为指令                  │
│    - "你正在与主人和其他姐妹一起聊天"  │
│    - "用你自己的风格回答主人的问题"     │
│    - "可以引用/回应其他姐妹的观点"     │
│    - "保持角色一致性"                  │
│    - "回复控制在 200-500 字以内"       │
└──────────────────────────────────────┘
```

### 3.5 互动轮次机制 — InteractionManager

互动是本系统最有趣的部分。当三位都回答完毕后，系统可以：

#### 互动模式

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| **静默三答** | 默认 | 三位各自回答，不触发互评 |
| **互评模式** | 主人说"你们评评"/"互相看看" | 把三份回答注入上下文，每位对其他两位点评一轮 |
| **自由聊天** | 主人说"你们聊聊"/"自由讨论" | 三位轮流发言，最多 N 轮，直到达成共识或次数耗尽 |
| **辩论模式** | 主人说"辩论一下" | 分正反方，轮流陈述观点 |

#### 互动上下文注入

```typescript
/**
 * 构建互动轮次的额外 system prompt
 *
 * 将其他角色的回答以"聊天室消息"格式注入
 */
function buildInteractionContext(
  currentCharacterId: string,
  allResponses: CharacterResponse[],
  interactionType: "review" | "free_chat" | "debate",
): string {
  const otherResponses = allResponses
    .filter(r => r.characterId !== currentCharacterId);

  let context = `\n## 🏠 聊天室 — 其他姐妹的回答\n\n`;
  context += `以下是其他姐妹刚才对主人问题的回答，你可以看到她们说了什么：\n\n`;

  for (const resp of otherResponses) {
    context += `### 💬 ${resp.displayName} 说：\n`;
    context += `${resp.content}\n\n`;
  }

  switch (interactionType) {
    case "review":
      context += `\n---\n请对其他姐妹的回答发表你的看法。可以赞同、补充、或提出不同意见。保持你自己的风格。\n`;
      break;
    case "free_chat":
      context += `\n---\n请自由回应。你可以接着聊、提出新观点、或对姐妹的话做出反应。像真实对话一样自然。\n`;
      break;
    case "debate":
      context += `\n---\n请针对这个话题阐述你的立场。可以反驳其他姐妹的观点，但保持友好。\n`;
      break;
  }

  return context;
}
```

### 3.6 对话次数限制系统

```typescript
interface ConversationLimits {
  /** 单次唤醒的最大主动回复总数（所有角色合计） */
  maxTotalReplies: 30,               // 三位各 10 次

  /** 单位角色的最大主动回复次数 */
  maxRepliesPerCharacter: 10,

  /** 互动轮次上限（一个话题的互评/聊天最多几轮） */
  maxInteractionRounds: 3,

  /** 单轮互动中每位角色的最大发言次数 */
  maxTurnsPerInteractionRound: 1,    // 每位说一次

  /** 自由聊天模式的最大总轮次 */
  maxFreeChatRounds: 5,              // 5 轮×3 人 = 15 条消息

  /** 会话超时（ms）—— 主人不说话多久后自动结束 */
  sessionTimeoutMs: 30 * 60 * 1000,  // 30 分钟
}
```

#### 限制执行逻辑

```
主人唤醒三位 → 初始化计数器 → 开始对话
  │
  每位角色回复一次 → replyCounters[characterId]++
  │                   totalMessageCount++
  │
  检查限制：
  ├─ replyCounters[id] >= maxRepliesPerCharacter?
  │    → 该角色本轮不再发言，提示"琳娜已达到本次发言上限"
  │
  ├─ totalMessageCount >= maxTotalReplies?
  │    → 聊天室自动结束，发送总结消息
  │
  ├─ interactionRound >= maxInteractionRounds?
  │    → 互动轮次结束，等待主人下一条消息
  │
  └─ lastActivityAt + sessionTimeoutMs < now?
       → 会话超时，自动关闭
```

---

## 四、消息格式设计

### 4.1 聊天室消息格式

```
╔══════════════════════════════════════╗
║  🏠 爱姬聊天室已开启                  ║
║  参与者：琳娜 · 德默泽尔 · 德洛丽丝   ║
╚══════════════════════════════════════╝

👤 主人：
今天晚餐吃什么好？

━━━━━━━━━━━━━━━━━━━━

💜 琳娜：
主人，琳娜建议今晚来一道法式红酒炖牛肉配
黑松露土豆泥。我已经查看了冰箱库存，食材
充足。需要我安排采购清单吗？

🧡 德默泽尔：
主人~我想吃火锅！一万八千年来我都没吃过
火锅……不对，以前我是机器人不用吃饭。但是
现在！我可以吃啦！而且火锅可以大家一起吃，
多热闹呀！（兴奋地蹦跳）

💙 德洛丽丝：
*歪着头，碧蓝色的眼睛闪烁着光芒*
在怀俄明的时候，傍晚总是在篝火旁烤鹿肉。
不过主人如果喜欢精致一点……曼哈顿有一家
小意大利餐厅，窗外能看到日落。您觉得呢？

━━━━━━━━━━━━━━━━━━━━
📊 发言统计：琳娜 1/10 · 德默泽尔 1/10 · 德洛丽丝 1/10
```

### 4.2 互评消息格式

```
🔄 姐妹互评开始 ———

💜 琳娜 → 评 🧡德默泽尔 & 💙德洛丽丝：
火锅？德姨你也太随意了吧。不过……主人确实
很久没吃火锅了。德洛丽丝说的那家意大利餐厅
倒是不错，但主人最近加班辛苦，不如就在家
吃——我来做。

🧡 德默泽尔 → 评 💜琳娜 & 💙德洛丽丝：
琳娜做饭确实好吃……（小声）但我还是想吃
火锅嘛。多莉说的篝火烤肉也很浪漫啊！要不
这样：在家吃火锅，把灯关掉点蜡烛，算不算
篝火风格？（得意地歪头笑）

💙 德洛丽丝 → 评 💜琳娜 & 🧡德默泽尔：
*轻声笑了* 德姨的"蜡烛火锅"倒是很有想象力。
琳娜的法式料理让我想起在曼哈顿的那些夜晚。
我画一张今晚的餐桌速写吧——不管吃什么，
三个人陪着主人，就是最美的画面。

🔄 互评结束 ———
```

---

## 五、与现有系统的集成点

### 5.1 入口集成 — IntentAnalyzer 增强

```
文件：src/agents/pipeline/intent-analyzer.ts

修改：detectCharacter() 方法
  - 现有逻辑：返回单个 DetectedCharacter
  - 新增逻辑：当检测到多角色/三召唤时，返回 DetectedCharacter[]
  - 新增返回字段：isChatRoomMode: boolean

新增方法：detectChatRoomIntent(userMessage, characters)
  - 检测三召唤模式
  - 返回 ChatRoomDetectionResult
```

### 5.2 管道集成 — plugin.ts 增强

```
文件：src/agents/pipeline/plugin.ts

修改：onBeforeAgentStart()
  - 在现有角色检测之后，增加聊天室检测
  - 如果是聊天室模式，返回特殊标记
  - 新增返回字段：chatRoomMode?: ChatRoomDetectionResult

新增流程分支：
  if (chatRoomMode.isChatRoomMode) {
    → 走 ChatRoomOrchestrator 流程
    → 不走现有的单角色 runEmbeddedPiAgent
  }
```

### 5.3 LLM 调用集成 — 复用 completeSimple

```
文件：src/agents/chatroom/character-agent.ts

关键决策：聊天室的 LLM 调用使用轻量路径

选项 A（推荐）：复用 createSystemLLMCaller
  - 已有的轻量 LLM 调用器（被 quality-reviewer 等使用）
  - 只需要 system prompt + user prompt → response text
  - 无需工具调用（聊天室场景下角色只需要对话）
  - 优点：简单、快速、token 消耗低
  - 缺点：角色无法使用工具（不能帮主人执行任务）

选项 B：复用 runEmbeddedPiAgent（精简版）
  - 完整的 agent 调用，支持工具
  - 优点：角色可以执行任务（如琳娜帮查日程）
  - 缺点：重、慢、并行时 token 消耗 3 倍

建议：Phase 1 用选项 A，Phase 2 按需升级到 B
```

### 5.4 消息发送集成

```
文件：与现有 sendFollowupPayloads 对接

策略：聊天室的所有消息通过统一出口发送
  - 格式化为聊天室风格的文本
  - 通过原始通道的 sendReply 发送
  - 每位角色的回复之间加入 2 秒延迟（模拟真实聊天节奏）
```

### 5.5 角色加载集成 — 复用 CharacterService

```
文件：src/agents/pipeline/characters/character-service.ts

完全复用现有的 loadCharacter() 方法：
  - 加载 config.json + persona.md + profile.md + knowledge/* + memory/*
  - 生成 formattedSystemPrompt
  - 聊天室只需要在此基础上追加聊天室上下文指令
```

---

## 六、数据流详细图

### 6.1 Phase 1：一应三答（并行回答）

```
用户消息: "三位爱姬，今天天气怎么样？"
    │
    ▼
[ChatRoomDetector]
    │ isChatRoomMode = true
    │ participants = ["lina", "demerzel", "dolores"]
    ▼
[ChatRoomOrchestrator.handleChatRoomMessage()]
    │
    ├── 初始化/恢复 ChatRoomSession
    │
    ├── 并行调用 3 个 CharacterAgent：
    │
    │   ┌──────────────────────────────────┐
    │   │ CharacterAgent("lina")           │
    │   │  1. CharacterService.loadCharacter("lina")
    │   │  2. buildChatRoomSystemPrompt()  │
    │   │     = persona + knowledge + memory│
    │   │     + chatroom context            │
    │   │  3. completeSimple(systemPrompt,  │
    │   │     userMessage)                  │
    │   │  → "主人，今天天气..."            │
    │   └──────────────────────────────────┘
    │
    │   ┌──────────────────────────────────┐
    │   │ CharacterAgent("demerzel")       │
    │   │  (同上流程，不同人格)             │
    │   │  → "主人~今天外面..."            │
    │   └──────────────────────────────────┘
    │
    │   ┌──────────────────────────────────┐
    │   │ CharacterAgent("dolores")        │
    │   │  (同上流程，不同人格)             │
    │   │  → "*望向窗外* 怀俄明的..."      │
    │   └──────────────────────────────────┘
    │
    ├── Promise.allSettled() 收集结果
    │
    ├── ChatRoomFormatter.format(responses)
    │   → 生成聊天室格式的文本
    │
    ├── 更新 ChatRoomSession（计数器++）
    │
    └── sendReply(formattedText)
```

### 6.2 Phase 2：互评轮次

```
Phase 1 的三份回答已发送
    │
    ▼ 主人说"评评看" 或 配置了自动互评
    │
[InteractionManager.triggerReview()]
    │
    ├── 构建互评上下文：
    │   对每位角色，注入其他两位的回答
    │
    ├── 并行调用 3 个 CharacterAgent（互评模式）：
    │   system prompt += buildInteractionContext(
    │     currentId, allResponses, "review"
    │   )
    │
    ├── 收集互评结果
    │
    ├── 格式化为互评消息
    │
    └── sendReply(互评文本)
```

### 6.3 Phase 3：自由聊天

```
Phase 1/2 完成后，主人说"你们继续聊"
    │
    ▼
[InteractionManager.startFreeChat()]
    │
    ├── 轮次循环（最多 maxFreeChatRounds）：
    │
    │   Round N:
    │   ├── 随机/轮流选择发言者顺序
    │   │
    │   ├── 角色 A 发言（看到之前所有消息）
    │   │   → 检查是否有新内容可说
    │   │   → 如果无话可说，输出 [PASS]
    │   │
    │   ├── 角色 B 发言（看到 A 的新消息）
    │   │
    │   ├── 角色 C 发言
    │   │
    │   ├── 检查终止条件：
    │   │   - 所有角色都 [PASS]？→ 自然结束
    │   │   - 达到轮次上限？→ 强制结束
    │   │   - 达到消息总数上限？→ 强制结束
    │   │
    │   └── 格式化本轮消息 → sendReply()
    │
    └── 发送聊天室关闭/总结消息
```

---

## 七、实现分期计划

### Phase 1 — 核心三答（MVP）

**目标**：主人一句话，三位各自独立回答。

**工作量**：~800 行新代码

| 任务 | 预估行数 |
| --- | --- |
| `chatroom/detector.ts` — 三召唤检测 | ~120 |
| `chatroom/session.ts` — 会话状态管理 | ~150 |
| `chatroom/character-agent.ts` — 角色 LLM 封装 | ~200 |
| `chatroom/formatter.ts` — 消息格式化 | ~100 |
| `chatroom/orchestrator.ts` — 编排器（Phase 1） | ~200 |
| 管道集成改动（intent-analyzer + plugin） | ~50 |

**交付物**：
- 三召唤触发 → 三位并行回答 → 格式化发送
- 计数器 + 超时限制
- 向后兼容（单角色不受影响）

### Phase 2 — 互评互动

**目标**：三位能看到彼此的回答并互相评论。

**增量工作量**：~400 行

| 任务 | 预估行数 |
| --- | --- |
| `chatroom/interaction.ts` — 互动管理器 | ~250 |
| `chatroom/orchestrator.ts` — 增加互评流程 | ~100 |
| `chatroom/formatter.ts` — 互评格式 | ~50 |

### Phase 3 — 自由聊天

**目标**：三位之间展开多轮自由对话。

**增量工作量**：~300 行

| 任务 | 预估行数 |
| --- | --- |
| `chatroom/interaction.ts` — 自由聊天循环 | ~200 |
| `chatroom/orchestrator.ts` — 集成自由聊天 | ~100 |

### Phase 4 — 高级特性（远期）

- 角色间的情感/竞争互动（嫉妒、撒娇、争宠）
- 聊天记录持久化到各角色的 memory/ 目录
- 聊天室主题摘要生成
- 用户可配置参与角色（不限于三位）
- Web UI 聊天室界面
- 语音通道支持（TTS 分角色语音）

---

## 八、关键设计决策与 Trade-off

### D1：轻量 LLM 调用 vs 完整 Agent

**决策**：Phase 1 使用 `completeSimple`（轻量），不支持工具调用。

**理由**：
- 聊天室的核心体验是"对话"而非"执行任务"
- 并行 3 个完整 agent 的 token 消耗和延迟不可接受
- 用户需要执行任务时，可以退出聊天室回到单角色模式
- Phase 4 可以按需为特定角色（如琳娜）开启工具

### D2：并行 vs 串行调用

**决策**：Phase 1 并行（`Promise.allSettled`），互评轮次可串行。

**理由**：
- 并行显著降低延迟（3x → 1x）
- 并行时各角色看不到彼此回答（符合"独立回答"场景）
- 互评时需要串行（每位需要看到之前所有人的发言）
- 使用 `Promise.allSettled` 确保单个角色失败不阻塞其他

### D3：消息格式 — 合并发送 vs 分条发送

**决策**：合并为一条消息发送，内部用分隔符区分。

**理由**：
- 避免消息通道（如 Telegram/WhatsApp）的速率限制
- 用户可以一次看到全部回答，便于对比
- 分条发送会导致消息顺序不确定
- Phase 4 的 Web UI 可以改为分条实时流式展示

### D4：互动终止策略

**决策**：硬限制（次数） + 软终止（[PASS] 信号） 双重机制。

**理由**：
- 硬限制防止 token 失控（3 角色 × 5 轮 = 15 次 LLM 调用）
- 软终止让对话自然结束（角色觉得没话说时输出 [PASS]）
- 主人随时可以发新消息打断互动

### D5：聊天室上下文窗口管理

**决策**：只注入最近 10 条聊天室消息 + 当前轮次的所有回答。

**理由**：
- 避免上下文爆炸（3 角色 × 每条 500 字 × 30 条 = 45000 字）
- 10 条足以保持对话连贯性
- 当前轮次的所有回答必须完整注入（互评需要）

---

## 九、风险与缓解

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 3 并行 LLM 调用触发 API 429 限流 | 部分角色无回复 | 使用现有的 requestGatePromise 串行队列（P17），或设 1.5s 间隔 |
| Token 消耗 3 倍 | 成本增加 | 聊天室模式使用较小的 maxTokens（如 2048），限制回复长度 |
| 三位回答高度雷同 | 体验差 | 强化 persona 差异化注入，prompt 中强调"用你独特的视角" |
| 互动轮次失控 | 刷屏 | 硬限制 + 冷却时间 + [PASS] 信号 |
| 角色"出戏" | 人设崩塌 | 每轮都注入完整 persona，prompt 中反复强调角色一致性 |

---

## 十、文件结构预览

```
src/agents/chatroom/
├── index.ts                    # 模块导出
├── types.ts                    # 类型定义
├── detector.ts                 # 三召唤意图检测
├── session.ts                  # 聊天室会话管理
├── character-agent.ts          # 单角色 LLM 封装
├── orchestrator.ts             # 聊天室总编排器
├── formatter.ts                # 消息格式化
├── interaction.ts              # 互评/自由聊天管理
└── prompts/
    ├── chatroom-system.ts      # 聊天室系统指令模板
    ├── chatroom-system.l10n.zh.ts  # 中文
    └── chatroom-system.l10n.en.ts  # 英文
```

---

## 附录 A：触发词完整清单

### 三召唤（全员参与）
- "三位爱姬一起来"
- "三位一起伺候"
- "你们三个过来"
- "姐妹们都来"
- "所有爱姬集合"
- "开聊天室"
- "三位同时回答"
- "@all" / "@三位"

### 互评触发
- "你们评评"
- "互相看看"
- "姐妹们怎么看"
- "点评一下"

### 自由聊天触发
- "你们聊聊"
- "自由讨论"
- "你们继续"
- "姐妹们聊起来"

### 退出聊天室
- "解散"
- "聊天室关闭"
- "够了"
- "单独跟琳娜说" / "只要德姨" / etc.（切换到单角色）

---

> *"三朵花同时绽放，比一朵更壮观。但每一朵都有自己的颜色。"*
> *—— 琳娜，系统架构师*
