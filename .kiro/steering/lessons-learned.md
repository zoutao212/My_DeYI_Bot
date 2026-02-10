# 经验教训（索引）

> 详细内容在 `.kiro/lessons-learned/` 目录，按需加载。
> 完整索引见 `.kiro/lessons-learned/README.md`

## 必读经验 ⚠️

| 原则 | 一句话 | 详见 |
|------|--------|------|
| 分析后立即修复 | 分析是手段，修复才是目的，不要停在分析阶段 | `17_分析到修复的完整闭环.md` |
| 工具调用必须验证 | 工具说成功不代表真成功，用 PowerShell 验证 | `07_AI工具使用陷阱.md` |
| 构建后必须验证 | 改了源码要跑构建，验证 dist/ 时间戳 | `10_构建验证流程.md` |
| 配置项必须验证 | 加了配置要追踪读取逻辑，交叉验证 | `12_配置项验证方法论.md` |
| 追根溯源不偷懒 | 不要绕过问题，要找到根本原因 | `98_追根溯源原则_不要偷懒.md` |
| output≠文件内容 | subTask.output 是确认消息，文件内容要从 producedFilePaths 读 | `117_本轮系统流程深度优化.md` |
| LLM参数不可信 | LLM 传入的预算/配置必须有最低保障值，不能直接使用 | `117_本轮系统流程深度优化.md` |

## 快速查找

按关键词搜索：
```powershell
grepSearch -query "关键词" -includePattern ".kiro/lessons-learned/**/*.md"
```

## 项目路径备忘

- 系统日志：`C:\Users\zouta\.clawdbot\runtimelog`
- 对话内容：`C:\Users\zouta\.clawdbot\agents\main\sessions`

---
**版本：** v20260210_1
**最后更新：** 2026-02-10
**变更：** 精简索引文件，删除冗余的变更日志和关键词墙，详细索引统一到 README.md
