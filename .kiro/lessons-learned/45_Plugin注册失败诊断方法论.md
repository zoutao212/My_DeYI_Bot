# Plugin 注册失败诊断方法论

> **背景**：动态管道 Plugin 注册失败，导致 Hook 未执行

---

## 问题现象

**典型症状：**
- 日志中显示 `plugins: []`（Plugin 列表为空）
- Hook 没有被触发（`before_agent_start` 未执行）
- 功能未生效（例如角色人格未注入）

---

## 系统化诊断流程

### 第一步：检查日志中的 plugins 数组

**目标：** 确认 Plugin 是否被注册

**操作：**
```powershell
# 查看最新的 trace 日志
Get-ChildItem "C:\Users\zouta\.clawdbot\runtimelog" -Filter "trace__*.jsonl" | 
  Sort-Object LastWriteTime -Descending | 
  Select-Object -First 1 | 
  ForEach-Object { 
    Get-Content $_.FullName -Tail 50 -Encoding UTF8 | 
    ConvertFrom-Json | 
    Where-Object { $_.event -eq "llm.payload" } | 
    Select-Object -First 1 | 
    ForEach-Object { $_.payload.payload | ConvertTo-Json -Depth 5 }
  }
```

**判断标准：**
- ✅ **正常**：`"plugins": ["clawdbot-pipeline", ...]`
- ❌ **异常**：`"plugins": []`

### 第二步：搜索 Plugin 注册代码位置

**目标：** 找到 Plugin 注册的入口点

**操作：**
```powershell
# 搜索 Plugin 注册代码
Select-String -Path "src/**/*.ts" -Pattern "registerPlugin|loadClawdbotPlugins" -Encoding UTF8
```

**关键文件：**
- `src/plugins/loader.ts`：Plugin 加载器
- `src/plugins/registry.ts`：Plugin 注册表
- `src/agents/pipeline/register.ts`：动态管道 Plugin 注册

### 第三步：检查注册时机（同步 vs 异步）

**目标：** 确认 Plugin 注册是否在 `initializeGlobalHookRunner` 之前完成

**关键代码位置：**
```typescript
// src/plugins/loader.ts

// ❌ 错误：异步导入导致注册延迟
import("../agents/pipeline/register.js")
  .then(({ registerPipelinePlugin }) => {
    registerPipelinePlugin(pipelineApi);
  });

// ✅ 正确：同步导入确保注册顺序
const pipelineModule = jiti("../agents/pipeline/register.js");
pipelineModule.registerPipelinePlugin(pipelineApi);

// 注册完成后才初始化 HookRunner
initializeGlobalHookRunner(registry);
```

**判断标准：**
- ✅ **正常**：Plugin 注册使用同步导入（jiti）
- ❌ **异常**：Plugin 注册使用异步导入（import().then()）

### 第四步：验证 dist/ 文件是否包含修改

**目标：** 确认代码已经构建并包含修改

**操作：**
```powershell
# 构建代码
pnpm build

# 验证 dist 文件
Select-String -Path "dist/plugins/loader.js" -Pattern "registerPipelinePlugin|clawdbot-pipeline" -Context 2,2 -Encoding UTF8
```

**判断标准：**
- ✅ **正常**：`dist/plugins/loader.js` 包含 `registerPipelinePlugin` 调用
- ❌ **异常**：`dist/plugins/loader.js` 不包含修改

### 第五步：重启 Gateway 验证

**目标：** 让修改生效

**操作：**
```powershell
# 重启 Gateway（使用你的启动脚本）
# 例如：.\Start-Clawdbot.cmd
```

**验证：**
- 发送测试消息
- 检查日志中的 `plugins` 数组
- 检查 Hook 是否被触发

---

## 关键教训

### 1. Plugin 注册必须同步

**原因：**
- `initializeGlobalHookRunner(registry)` 会立即执行
- 如果 Plugin 注册是异步的，HookRunner 初始化时 Plugin 还未注册
- 导致 Hook 无法被触发

**解决方案：**
- 使用 `jiti` 同步加载模块
- 确保 Plugin 注册在 `initializeGlobalHookRunner` 之前完成

### 2. 必须验证 dist/ 文件

**原因：**
- 源码修改不代表构建产物已更新
- Gateway 运行的是 `dist/` 目录下的代码

**解决方案：**
- 修改源码后立即运行 `pnpm build`
- 验证 `dist/` 文件是否包含修改
- 不要只看源码，要看构建产物

### 3. 重启 Gateway 才能生效

**原因：**
- Gateway 启动时加载 Plugin
- 修改代码后必须重启才能加载新代码

**解决方案：**
- 修改代码 → 构建 → 重启 Gateway
- 不要跳过任何一步

---

## 快速检查清单

当 Plugin 注册失败时，按以下顺序检查：

- [ ] **日志检查**：`plugins` 数组是否为空？
- [ ] **代码检查**：Plugin 注册是否使用同步导入？
- [ ] **构建检查**：`dist/` 文件是否包含修改？
- [ ] **重启检查**：Gateway 是否已重启？
- [ ] **验证检查**：Hook 是否被触发？

---

## 相关文档

- `.kiro/lessons-learned/44_Hook执行时序问题诊断和修复方法论.md`：Hook 执行时序问题
- `ProjectMemory/00_索引/模块地图.md`：Plugin 系统架构
- `src/plugins/loader.ts`：Plugin 加载器源码

---

**版本：** v20260202_1  
**最后更新：** 2026-02-02  
**变更：** 新增 Plugin 注册失败诊断方法论
