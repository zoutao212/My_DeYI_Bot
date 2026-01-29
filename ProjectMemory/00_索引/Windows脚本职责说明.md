# Windows 批处理脚本职责说明

## 脚本清单

| 脚本名称 | 职责 | 何时使用 |
|---------|------|---------|
| `Build-All.cmd` | 完整构建（TypeScript + UI） | 修改代码后 |
| `Start-Clawdbot.cmd` | 快速启动 Gateway | 日常启动 |
| `Gateway-Service-Start.cmd` | 启动 Gateway 服务 | 作为 Windows 服务运行 |
| `Gateway-Service-Stop.cmd` | 停止 Gateway 服务 | 停止服务 |

---

## Build-All.cmd（完整构建）

### 职责
1. 编译 TypeScript（`pnpm build`）
2. 构建 Control UI（`pnpm ui:build`）

### 何时使用
- 修改了 `src/` 目录下的源代码
- 修改了 `ui/` 目录下的 UI 代码
- 首次部署或长时间未构建

### 不负责
- ❌ 不启动 Gateway
- ❌ 不重启服务

### 验证方式
```powershell
# 检查构建产物时间戳
Get-Item "dist/agents/*.js" | Select Name, LastWriteTime | Sort LastWriteTime -Descending | Select -First 5
```

---

## Start-Clawdbot.cmd（快速启动）

### 职责
1. 停止旧的 Gateway 进程
2. 清理端口占用
3. 启动新的 Gateway 进程
4. 等待健康检查

### 何时使用
- 日常启动 Gateway
- 重启 Gateway
- 构建完成后启动

### 不负责
- ❌ 不构建代码
- ❌ 不检查构建产物

### 前置条件
- 必须先运行 `Build-All.cmd` 或确保 `dist/` 目录是最新的

### 验证方式
```cmd
# 检查 Gateway 健康状态
pnpm run clawdbot gateway health --bind loopback --port 18789
```

---

## 常见错误

### ❌ 修改代码后直接运行 Start-Clawdbot.cmd
**问题：** Gateway 仍然运行旧代码

**解决：**
1. 先运行 `Build-All.cmd`
2. 再运行 `Start-Clawdbot.cmd`

### ❌ 只运行 pnpm ui:build
**问题：** TypeScript 代码未编译

**解决：**
运行 `Build-All.cmd` 或手动运行 `pnpm build`

### ❌ 构建后不重启 Gateway
**问题：** Node.js 进程缓存了旧代码

**解决：**
运行 `Start-Clawdbot.cmd` 重启 Gateway

---

## 标准工作流

### 开发流程
```
修改代码
  ↓
Build-All.cmd（完整构建）
  ↓
验证构建产物
  ↓
Start-Clawdbot.cmd（启动）
  ↓
测试功能
```

### 日常启动
```
Start-Clawdbot.cmd（直接启动）
  ↓
等待健康检查
  ↓
开始使用
```

---

## 历史问题

### 问题 1：Rebuild-UI-And-Restart.cmd 只构建 UI
**时间：** 2026-01-29 之前

**问题：**
- 只运行 `pnpm ui:build`
- 不编译 TypeScript
- 导致修改 `src/` 后不生效

**解决：**
- 删除 `Rebuild-UI-And-Restart.cmd`
- 创建 `Build-All.cmd`（完整构建）

### 问题 2：Start-Clawdbot.cmd 触发重复构建
**时间：** 2026-01-29 之前

**问题：**
- 设置了 `CLAWDBOT_FORCE_BUILD=1`
- 导致启动时自动构建
- 加上 Gateway 自动检测 `dist is stale`，触发两次构建

**解决：**
- 移除 `CLAWDBOT_FORCE_BUILD=1`
- 启动脚本只负责启动，不负责构建

---

**版本：** v20260129_1
**最后更新：** 2026-01-29
**创建原因：** 固化 Windows 脚本职责分离的最佳实践
