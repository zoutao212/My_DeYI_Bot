# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:
- Camera names and locations
- SSH hosts and aliases  
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras
- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH
- home-server → 192.168.1.100, user: admin

### TTS
- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.


## 配对机制说明 ⚠️ 重要

### 节点配对（Node Pairing）
- **用途**：配对物理设备（手机、平板、电脑等）
- **工具**：`nodes` 工具的 `approve` 动作
- **示例**：`nodes({ action: "approve", requestId: "xxx" })`
- **场景**：当设备请求配对时使用

### 频道配对（Channel Pairing）
- **用途**：配对消息频道用户（Telegram、Discord、Slack 等）
- **工具**：CLI 命令（通过 `exec` 工具调用）
- **示例**：`exec({ command: "pnpm clawdbot pairing approve telegram CLLFACS9" })`
- **场景**：当用户在消息频道请求配对时使用

### ⚠️ 关键区别

| 特性 | 节点配对 | 频道配对 |
|------|---------|---------|
| 配对对象 | 物理设备 | 消息频道用户 |
| 使用工具 | `nodes` 工具 | `exec` 工具 + CLI 命令 |
| API | `node.pair.approve` | `approveChannelPairingCode()` |
| 请求 ID 格式 | UUID | 短码（如 CLLFACS9） |

**重要**：不要混淆这两种配对机制！看到 "pairing code" 时，先判断是设备配对还是用户配对。

### 如何判断

- **设备配对**：请求来自 `node.pair.list`，requestId 是 UUID 格式
- **用户配对**：请求来自消息频道（Telegram/Discord），code 是短码格式（8 位字母数字）

### 常见错误

❌ **错误**：看到 Telegram 配对码，使用 `nodes({ action: "approve", requestId: "CLLFACS9" })`
✅ **正确**：使用 `exec({ command: "pnpm clawdbot pairing approve telegram CLLFACS9" })`

❌ **错误**：看到设备配对请求，使用 `exec({ command: "pnpm clawdbot pairing approve node xxx" })`
✅ **正确**：使用 `nodes({ action: "approve", requestId: "xxx" })`
