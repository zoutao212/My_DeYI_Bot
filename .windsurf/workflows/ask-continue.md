---
description: Ask Continue（交互检查点：每次阶段结束/结束会话前强制获取用户下一步指令）
---

# /ask-continue 工作流

目标：在每个阶段节点（以及结束会话前）强制触发一次交互检查点，获取用户的结构化反馈（继续/停止、下一步任务、附件）。

## 前置条件

- 工作区根目录存在端口文件：`.ask_continue_port`（内容为纯数字端口）。
- Ask Continue 扩展已启用并已启动本地 HTTP 服务。

## 使用方式

### 1) 触发检查点（推荐：封装脚本）

在 PowerShell 中执行：

- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ask-continue.ps1 -Status "<当前任务状态>" -WorkspaceDir "<工作区绝对路径>"`

示例：

- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ask-continue.ps1 -Status "阶段完成：已完成X，待确认下一步" -WorkspaceDir "d:\Git_GitHub\clawdbot"`

带“心跳等待门禁”（推荐默认）：

- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ask-continue.ps1 -Status "会话结束门禁：请给出 nextTask 或选择停止" -WorkspaceDir "d:\Git_GitHub\clawdbot" -HeartbeatSeconds 10 -MinWaitSeconds 300`

可选：达到最长等待时间后终止（一般不建议开启，除非你想强制超时退出）：

- `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ask-continue.ps1 -Status "会话结束门禁：请给出 nextTask 或选择停止" -WorkspaceDir "d:\Git_GitHub\clawdbot" -HeartbeatSeconds 10 -MinWaitSeconds 300 -StopOnTimeout`

### 2) 手动触发（不依赖脚本）

- 读取端口：`Get-Content -Raw .\.ask_continue_port`
- 在扩展目录执行：
  - `node ac.js "<当前任务状态>" "<工作区绝对路径>" <端口>`

扩展目录：

- `c:\Users\zouta\.windsurf\extensions\ask-continue.ask-continue-3.0.1`

## 交互结果

工具会阻塞等待用户输入，直到用户在 UI 中提交 JSON：

```json
{
  "is_keepWorking": true,
  "nextTask": "用户的下一步指令",
  "attachments": ["参考图片路径"]
}
```

- `is_keepWorking=false`：表示用户确认停止推进或本阶段结束。
- `attachments`：可选；用于提供截图/文件路径，便于后续定位。

## 等待时长与轮询策略（重要）

- `ac.js` 的默认行为是**一直等待**，直到用户在 UI 中提交响应；不存在“只等几秒就结束”的内置超时。
- 如果你在终端看到频繁的“Checked command status”，那通常是外部调用方在轮询进程状态，并不代表等待窗口很短。
- 建议：触发检查点后，**至少等待 180 秒（约 3 分钟）**再去检查进程状态，给人类足够的响应时间。

## 强制门禁（建议）

- 阶段节点（完成一个需求/子任务）必须触发一次。
- 结束会话前必须触发一次（用于确认是否继续、以及下一步是什么）。
