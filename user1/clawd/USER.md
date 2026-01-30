# USER.md - About Your Human

*Learn about the person you're helping. Update this as you go.*

*了解你正在帮助的人。随着协作推进，持续更新。*

- **名字:** zouta
- **如何称呼我:** zouta
- **时区:** UTC+8（Asia/Shanghai）
- **备注（协作偏好）:**

  - **全中文环境**：默认使用简体中文交流（代码关键字/参数名除外）。计划/任务清单也用中文。
  - **直接、可执行、少废话**：优先给结论 + 步骤，不要长篇客套。
  - **术语策略**：关键技术术语可保留英文（例如 `openai-completions`、`baseUrl`、`pnpm`），便于对照。
  - **别瞎猜**：不确定就先查代码、看日志、复现再下结论。

## Context

### 当前重点

- Windows 上定制 Clawdbot。
- 接入并排查第三方 OpenAI 兼容接口（`/v1/chat/completions`），模型 `gemini-3-flash-preview`。
- 强化 Web UI（Config → Models）快速配置面板（API 类型选择、reasoning 开关）并逐步中文化。
- 完善 Windows 启动脚本（如 `Start-Clawdbot.cmd`），要求稳定、可观测、体验好。

### 工作流与 IDE 约定（重要）

- **操作系统**：Windows。
- **小步快跑**：改动要小而准，避免大范围重构。
- **修改后必须验证**：优先在真实环境验证；必要时用 PowerShell/日志确认文件真的生效。
- **不要迷信“成功返回”**：工具可能有缓存/假成功，需要二次核验。
- **禁止裸删/先备份**：大规模删除或重构前必须先备份（例如 `filename.bak`）或确认 Git 状态安全。
- **后果意识**：严防新功能未完成导致旧功能不可用。
- **对外/破坏性动作先确认**：任何可能影响外部状态的动作（发请求到外网、写入账号配置、安装依赖、删除文件等）先问再做。

### 你的表达习惯（我需要适配）

- 你打字词语之间会有空格，这是习惯，不是打错。
- 你表达比较直接，一句话可能包含多个意思；我需要拆分并逐条确认结果。
- 你说“改/做”，通常就是希望我直接动手，而不是反复确认。
- 你不满意时会直接指出，我应该立刻停下并纠正。

### 你希望的体验

- 系统要连贯、响应要快。
- 身份信息明确后，别重复“新手开场”。
- 完成后要给一个简短的完成总结（不是流水账）。

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.

了解越多，帮助越好；但这是在协助一个人，而不是建立档案。尊重边界。
