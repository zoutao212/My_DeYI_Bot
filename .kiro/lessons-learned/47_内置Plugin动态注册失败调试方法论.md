# 内置 Plugin 动态注册失败调试方法论

> **场景**：测试脚本验证通过，但真实环境中 Plugin 完全不生效（静默失败）

---

## 问题特征（识别信号）

### 现象
1. **测试脚本验证通过**：单元测试、集成测试都成功
2. **真实环境完全不生效**：功能没有任何响应
3. **日志中没有相关事件**：完全看不到 Plugin 相关的日志（静默失败）
4. **用户可见效果为零**：预期的标记、提示、功能都没有出现

### 典型案例
- Pipeline Plugin 测试脚本通过，但真实环境中 Hook 完全没有被触发
- 内置 Plugin 在开发环境正常，但在生产环境（`dist/`）中失效
- Plugin 加载失败但没有错误日志，导致问题被忽略

---

## 根本原因（为什么会发生）

### 1. 相对路径解析失败
**问题**：内置 Plugin 使用相对路径动态加载模块，但相对路径在不同环境中解析结果不同。

**示例**：
```typescript
// ❌ 错误：相对路径在 dist/ 环境中可能解析失败
const pipelineModule = jiti("../agents/pipeline/register.js");
```

**原因**：
- `src/` 和 `dist/` 的目录结构可能不同
- `jiti` 的相对路径解析依赖于当前模块的位置
- 构建后的文件路径可能与源码路径不一致

### 2. 静默失败（错误被捕获但不输出）
**问题**：Plugin 加载失败但被 `try-catch` 捕获，只输出 `warn` 级别日志，容易被忽略。

**示例**：
```typescript
try {
  const pipelineModule = jiti("../agents/pipeline/register.js");
  pipelineModule.registerPipelinePlugin(pipelineApi);
} catch (err) {
  logger.warn(`Failed to setup plugin: ${String(err)}`); // ⚠️ 只输出 warn
}
```

**原因**：
- `warn` 级别日志容易被忽略
- 没有输出完整的错误堆栈
- 没有输出加载路径等上下文信息

### 3. 测试环境与真实环境不一致
**问题**：测试脚本直接导入模块，绕过了 Plugin 加载逻辑，导致测试通过但真实环境失败。

**示例**：
```typescript
// 测试脚本：直接导入（绕过 Plugin 加载）
import { registerPipelinePlugin } from "../agents/pipeline/register.js";

// 真实环境：通过 jiti 动态加载（可能失败）
const pipelineModule = jiti("../agents/pipeline/register.js");
```

**原因**：
- 测试脚本使用静态导入，不会触发路径解析问题
- 真实环境使用动态加载，路径解析可能失败
- 测试环境和真实环境的加载机制不同

---

## 调试流程（标准步骤）

### 第一步：检查运行日志
**目的**：确认 Plugin 是否被加载

**操作**：
```powershell
# 查看最新的运行日志
Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Encoding UTF8 -Tail 100

# 搜索 Plugin 相关日志
Select-String -Path "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Pattern "\[plugins\]" -Context 2,2
```

**判断标准**：
- ✅ **正常**：日志中出现 `[plugins] Loading plugin from: ...` 和 `[plugins] ✅ Registered plugin: ...`
- ❌ **异常**：日志中完全没有 Plugin 相关事件，或者只有 `[plugins] ❌ Failed to setup plugin: ...`

### 第二步：检查 Plugin 注册代码
**目的**：确认注册逻辑是否被执行

**操作**：
1. 找到 Plugin 加载代码（通常在 `src/plugins/loader.ts`）
2. 检查 Plugin 注册逻辑是否被执行
3. 检查是否有 `try-catch` 捕获了错误但没有输出

**关键检查点**：
- Plugin 注册代码是否在正确的位置（例如：在 `initializeGlobalHookRunner` 之前）
- 是否有条件判断导致 Plugin 没有被注册（例如：`if (enabled) { ... }`）
- 错误处理是否完善（是否输出完整的错误堆栈）

### 第三步：检查路径解析
**目的**：验证相对路径在 `dist/` 环境中是否正确

**操作**：
```powershell
# 检查 dist/ 目录结构
Get-ChildItem "dist/agents/pipeline" -Recurse

# 验证目标文件是否存在
Test-Path "dist/agents/pipeline/register.js"

# 检查 loader.js 中的路径
Select-String -Path "dist/plugins/loader.js" -Pattern "pipeline" -Context 2,5
```

**判断标准**：
- ✅ **正常**：目标文件存在，路径解析正确
- ❌ **异常**：目标文件不存在，或者路径解析错误

### 第四步：增强错误处理
**目的**：输出完整的错误堆栈和上下文信息

**操作**：
```typescript
try {
  // 输出加载路径
  logger.info(`[plugins] Loading plugin from: ${registerPath}`);
  
  const pipelineModule = jiti(registerPath);
  pipelineModule.registerPipelinePlugin(pipelineApi);
  
  // 输出注册状态
  logger.info("[plugins] ✅ Registered plugin: clawdbot-pipeline");
} catch (err) {
  // 输出完整的错误堆栈
  logger.error(`[plugins] ❌ Failed to setup plugin: ${String(err)}`);
  logger.error(`[plugins] Stack trace: ${err instanceof Error ? err.stack : String(err)}`);
}
```

---

## 解决方案（最小可复用解法）

### 方案 1：使用绝对路径（推荐）
**适用场景**：相对路径解析失败

**实现**：
```typescript
// 计算绝对路径
const modulePath = fileURLToPath(import.meta.url);
const loaderDir = path.dirname(modulePath);
const registerPath = path.resolve(loaderDir, "../agents/pipeline/register.js");

logger.info(`[plugins] Loading plugin from: ${registerPath}`);

// 使用绝对路径加载
const pipelineModule = jiti(registerPath) as {
  registerPipelinePlugin: (api: ReturnType<typeof createApi>) => void;
};

pipelineModule.registerPipelinePlugin(pipelineApi);
logger.info("[plugins] ✅ Registered plugin: clawdbot-pipeline");
```

**优点**：
- 路径解析稳定，不受环境影响
- 易于调试（可以输出完整路径）
- 兼容性好

### 方案 2：使用别名（适用于复杂项目）
**适用场景**：项目中有多个内置 Plugin，需要统一管理

**实现**：
```typescript
// 在 jiti 配置中添加别名
const jiti = createJiti(import.meta.url, {
  alias: {
    "@agents": path.resolve(loaderDir, "../agents"),
  },
});

// 使用别名加载
const pipelineModule = jiti("@agents/pipeline/register.js");
```

### 方案 3：增强错误处理（必须）
**适用场景**：所有内置 Plugin

**实现**：
```typescript
try {
  // 输出加载路径
  logger.info(`[plugins] Loading plugin from: ${registerPath}`);
  
  const pipelineModule = jiti(registerPath);
  pipelineModule.registerPipelinePlugin(pipelineApi);
  
  // 输出注册状态
  logger.info("[plugins] ✅ Registered plugin: clawdbot-pipeline");
  
  registry.plugins.push(pipelineRecord);
} catch (err) {
  // 输出完整的错误堆栈和上下文
  logger.error(`[plugins] ❌ Failed to setup plugin: ${String(err)}`);
  logger.error(`[plugins] Stack trace: ${err instanceof Error ? err.stack : String(err)}`);
  logger.error(`[plugins] Register path: ${registerPath}`);
  logger.error(`[plugins] Module path: ${modulePath}`);
}
```

---

## 验证方法（质量门槛）

### 1. 构建验证
```powershell
# 构建项目
pnpm build

# 验证 dist/ 文件包含修改
Select-String -Path "dist/plugins/loader.js" -Pattern "Loading plugin from" -Context 2,5

# 验证目标文件存在
Test-Path "dist/agents/pipeline/register.js"
```

**判断标准**：
- ✅ 构建成功
- ✅ `dist/plugins/loader.js` 包含修改
- ✅ 目标文件存在

### 2. 日志验证
```powershell
# 重启 Clawdbot
# 查看启动日志
Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Encoding UTF8 -Tail 100

# 搜索 Plugin 加载日志
Select-String -Path "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Pattern "Loading plugin from|Registered plugin" -Context 2,2
```

**判断标准**：
- ✅ 日志中出现 `[plugins] Loading plugin from: ...`
- ✅ 日志中出现 `[plugins] ✅ Registered plugin: ...`
- ✅ 没有错误日志

### 3. 功能验证
```powershell
# 发送测试消息
# 检查日志中是否出现 Plugin 相关事件
Select-String -Path "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Pattern "Pipeline.*hook triggered" -Context 2,2
```

**判断标准**：
- ✅ Plugin Hook 被触发
- ✅ 用户可见效果出现（例如：🔵 标记）
- ✅ 功能正常工作

---

## 预防措施（避免再次发生）

### 1. 统一路径管理
- 所有内置 Plugin 使用绝对路径加载
- 在 `loader.ts` 中统一管理路径解析逻辑
- 避免在多处重复路径解析代码

### 2. 增强日志输出
- 在关键步骤添加日志（加载路径、注册状态、错误堆栈）
- 使用 `info` 级别输出正常流程，使用 `error` 级别输出错误
- 输出足够的上下文信息（路径、模块名、错误原因）

### 3. 测试环境与真实环境一致
- 测试脚本应该模拟真实环境的加载机制
- 避免测试脚本绕过 Plugin 加载逻辑
- 在 `dist/` 环境中运行集成测试

### 4. 文档化
- 在 Plugin 开发文档中说明路径解析规则
- 在代码注释中说明为什么使用绝对路径
- 在 README 中说明如何调试 Plugin 加载问题

---

## 关键教训（必读）

1. **相对路径不可靠**
   - 相对路径在不同环境中解析结果不同
   - 使用绝对路径确保路径解析稳定

2. **静默失败很危险**
   - 错误被捕获但不输出，导致问题被忽略
   - 必须输出完整的错误堆栈和上下文信息

3. **测试脚本不等于真实环境**
   - 测试脚本可能绕过真实环境的加载机制
   - 必须在真实环境中验证功能

4. **日志是调试的关键**
   - 在关键步骤添加日志，便于定位问题
   - 输出足够的上下文信息（路径、模块名、错误原因）

5. **构建后必须验证**
   - 修改源码后必须构建并验证 `dist/` 文件
   - 不要相信工具的"成功"返回，必须交叉验证

---

## 适用范围

本方法论适用于以下场景：

1. **内置 Plugin 动态注册失败**
2. **测试脚本通过但真实环境失败**
3. **Plugin 加载失败但没有错误日志**
4. **相对路径解析失败导致模块加载失败**
5. **构建后功能不生效**

---

## 相关文档

- `.kiro/lessons-learned/07_AI工具使用陷阱.md`（工具调用必须验证）
- `.kiro/lessons-learned/10_构建验证流程.md`（构建后必须验证）
- `.kiro/lessons-learned/18_修复无效的根因分析方法论.md`（修复源头，不是症状）
- `.kiro/steering/agent-development-validation.md`（Agent 开发数据验证核心原则）

---

**版本：** v20260202_1  
**最后更新：** 2026-02-02  
**变更：** 新增"内置 Plugin 动态注册失败调试方法论"
