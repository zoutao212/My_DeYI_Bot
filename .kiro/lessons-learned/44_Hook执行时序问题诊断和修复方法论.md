# Hook 执行时序问题诊断和修复方法论

> **来源**：动态管道架构接入实战（2026-02-02）  
> **问题**：Hook 返回值未生效，功能没有真正接入系统  
> **根因**：Hook 在目标函数之后执行，无法影响已生成的结果

---

## 问题识别

### 典型症状

1. ✅ Hook 代码已实现
2. ✅ Hook 已注册
3. ✅ Hook 被调用（日志显示执行成功）
4. ❌ Hook 返回值未生效
5. ❌ 功能实际不工作

### 用户批评

**"你刚才一通工作一通设计完全没有实际接入系统"**

这是最准确的诊断：表面上代码都存在，但执行顺序错误导致功能失效。

---

## 根本原因

### 执行时序错误

**错误的顺序**：
```
第 343 行：buildEmbeddedSystemPrompt()  ← 生成 system prompt（没有角色名）
第 860 行：hookRunner.runBeforeAgentStart()  ← 执行 hook（识别角色）
```

**问题**：
- Hook 在目标函数（`buildEmbeddedSystemPrompt`）**之后**执行
- Hook 返回的数据（`characterName`）无法影响已经生成的 system prompt
- 表面上 hook 执行成功，但数据流断裂

### 为什么会发生

1. **历史遗留**：Hook 机制后来添加，插入位置不合理
2. **缺乏验证**：只验证 hook 是否执行，未验证返回值是否被使用
3. **数据流不清晰**：未追踪数据从生产到消费的完整路径

---

## 诊断方法

### 第一步：追踪数据流

**问题**：Hook 返回的数据去哪了？

**方法**：
1. 找到 hook 返回值的定义（例如：`characterName`）
2. 搜索哪里使用了这个返回值
3. 确认使用位置是否在目标函数**之前**

**示例**：
```typescript
// Hook 返回
return { characterName: "lisi" };

// 目标函数需要
buildEmbeddedSystemPrompt({ characterName: ??? });

// 问题：目标函数在 hook 之前执行，拿不到 characterName
```

### 第二步：分析执行顺序

**问题**：Hook 在什么时候执行？目标函数在什么时候执行？

**方法**：
1. 找到 hook 调用位置（行号）
2. 找到目标函数调用位置（行号）
3. 比较行号，确认执行顺序

**示例**：
```
第 343 行：buildEmbeddedSystemPrompt()  ← 先执行
第 860 行：hookRunner.runBeforeAgentStart()  ← 后执行
```

**结论**：顺序错误！

### 第三步：验证数据传递

**问题**：即使顺序正确，数据是否真的被传递？

**方法**：
1. 在 hook 调用后添加日志，记录返回值
2. 在目标函数调用前添加日志，记录参数
3. 对比两者，确认数据是否传递

**示例**：
```typescript
const hookResult = await hookRunner.runBeforeAgentStart(...);
log.info(`Hook returned: ${JSON.stringify(hookResult)}`);  // 🔍 验证返回值

const appendPrompt = await buildEmbeddedSystemPrompt({
  characterName: hookResult?.characterName,  // 🔍 验证传递
});
log.info(`buildEmbeddedSystemPrompt called with characterName: ${hookResult?.characterName}`);
```

---

## 修复方法

### 方案 1：调整执行顺序（推荐）

**核心思路**：将 hook 移到目标函数**之前**

**步骤**：

#### 1. 提前创建依赖

如果 hook 需要某些依赖（例如 `sessionManager`），先创建它们：

```typescript
// 原来：sessionManager 在第 419 行创建
// 现在：提前到第 343 行创建

const sessionLock = await acquireSessionWriteLock({
  sessionFile: params.sessionFile,
});

let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
let hookCharacterName: string | undefined;  // 🆕 声明变量存储 hook 返回值
```

#### 2. 提前执行 hook

在目标函数调用之前执行 hook：

```typescript
// 🆕 在 buildEmbeddedSystemPrompt 之前执行 hook
const hookRunner = getGlobalHookRunner();
if (hookRunner?.hasHooks("before_agent_start")) {
  try {
    const hookResult = await hookRunner.runBeforeAgentStart(...);
    
    if (hookResult?.characterName) {
      hookCharacterName = hookResult.characterName;
      log.info(`hooks: detected character: ${hookCharacterName}`);
    }
  } catch (hookErr) {
    log.warn(`before_agent_start hook failed: ${String(hookErr)}`);
  }
}
```

#### 3. 传递数据给目标函数

将 hook 返回值传递给目标函数：

```typescript
const appendPrompt = await buildEmbeddedSystemPrompt({
  // ... 其他参数
  characterName: hookCharacterName,  // 🆕 传递 hook 返回值
  characterBasePath: process.cwd(),
});
```

#### 4. 移除重复调用

如果原来的位置还有 hook 调用，移除或注释掉：

```typescript
// ❌ 移除：重复的 hook 调用
// const hookRunner = getGlobalHookRunner();
// if (hookRunner?.hasHooks("before_agent_start")) { ... }

// ✅ 使用之前的返回值
let effectivePrompt = params.prompt;
if (hookPrependContext) {  // 使用之前 hook 返回的 prependContext
  effectivePrompt = `${hookPrependContext}\n\n${params.prompt}`;
}
```

### 方案 2：延迟目标函数调用（备选）

**核心思路**：保持 hook 位置不变，将目标函数移到 hook 之后

**适用场景**：
- Hook 位置合理，目标函数位置不合理
- 目标函数可以延迟调用

**步骤**：
1. 将目标函数调用移到 hook 之后
2. 传递 hook 返回值给目标函数
3. 确保不影响其他依赖

**注意**：这种方案改动较大，优先考虑方案 1。

### 方案 3：重新设计 Hook 接口（最后手段）

**核心思路**：修改 hook 接口，让目标函数主动调用 hook

**适用场景**：
- 方案 1 和方案 2 都不可行
- Hook 和目标函数耦合太紧

**步骤**：
1. 在目标函数内部调用 hook
2. 根据 hook 返回值调整行为
3. 更新所有 hook 实现

**注意**：这种方案改动最大，只在必要时使用。

---

## 验证方法

### 第一步：构建验证

```powershell
pnpm build
```

**预期**：构建成功，无错误

### 第二步：代码验证

```powershell
# 验证数据传递
Select-String -Path "dist/xxx/yyy.js" -Pattern "characterName.*hookCharacterName" -Context 2,2

# 验证 hook 执行位置
Select-String -Path "dist/xxx/yyy.js" -Pattern "detected character:" -Context 1,1
```

**预期**：
- 看到 `characterName: hookCharacterName` 传递
- 看到 hook 在目标函数之前执行

### 第三步：运行时验证

```powershell
# 启动系统
clawdbot gateway run

# 发送测试消息
clawdbot message send "测试消息"

# 检查日志
Select-String -Path "C:\Users\xxx\.clawdbot\runtimelog\trace__*.jsonl" -Pattern "detected character:"
```

**预期**：
- Hook 执行成功
- 角色被识别
- 数据被传递
- 功能正常工作

---

## 常见错误

### 错误 1：只验证 hook 是否执行

**问题**：看到 hook 执行日志就认为功能正常

**正确做法**：
- 验证 hook 返回值是否被使用
- 验证目标函数是否收到数据
- 验证最终结果是否符合预期

### 错误 2：只修改 hook，不修改调用方

**问题**：修改了 hook 返回值，但调用方没有使用

**正确做法**：
- 修改 hook 返回值后，同步修改调用方
- 确保数据流完整

### 错误 3：忘记移除重复调用

**问题**：提前执行了 hook，但原来的位置还有调用

**正确做法**：
- 移除或注释掉重复的 hook 调用
- 复用之前的返回值

### 错误 4：破坏其他依赖

**问题**：调整执行顺序后，影响了其他功能

**正确做法**：
- 仔细分析依赖关系
- 确保调整后不影响其他功能
- 完整测试所有相关功能

---

## 最佳实践

### 1. 设计 Hook 时考虑执行顺序

**原则**：Hook 应该在需要其返回值的地方**之前**执行

**示例**：
- `before_agent_start` 应该在 agent 创建之前执行
- `before_llm_call` 应该在 LLM 调用之前执行
- `after_response` 应该在响应发送之后执行

### 2. 明确 Hook 的数据流

**原则**：清楚地记录 hook 返回值的用途和传递路径

**示例**：
```typescript
/**
 * before_agent_start hook
 * 
 * 返回值：
 * - characterName: 动态识别的角色名，传递给 buildEmbeddedSystemPrompt
 * - prependContext: 记忆上下文，注入到用户消息前
 * 
 * 执行时机：在 buildEmbeddedSystemPrompt 之前
 */
```

### 3. 添加验证日志

**原则**：在关键位置添加日志，便于诊断

**示例**：
```typescript
// Hook 返回值
log.info(`Hook returned: characterName=${hookResult?.characterName}`);

// 目标函数参数
log.info(`buildEmbeddedSystemPrompt called with characterName=${characterName}`);

// 最终结果
log.info(`System prompt includes character: ${systemPrompt.includes("你是丽丝")}`);
```

### 4. 完整测试数据流

**原则**：不仅测试 hook 是否执行，还要测试数据是否传递

**测试清单**：
- ✅ Hook 是否执行
- ✅ Hook 返回值是否正确
- ✅ 目标函数是否收到数据
- ✅ 最终结果是否符合预期

---

## 相关模式

### 与"分析到修复的完整闭环"的关系

本模式是"分析到修复的完整闭环"的具体应用：
1. **分析**：追踪数据流，分析执行顺序
2. **修复**：调整执行顺序，传递数据
3. **验证**：构建验证、代码验证、运行时验证

### 与"复用现有逻辑"的关系

本模式强调：
- 不要重新实现目标函数
- 只调整执行顺序和数据传递
- 复用现有的实现逻辑

---

## 总结

### 核心原则

**Hook 必须在需要其返回值的地方之前执行。**

### 诊断步骤

1. 追踪数据流：Hook 返回值去哪了？
2. 分析执行顺序：Hook 和目标函数谁先执行？
3. 验证数据传递：数据是否真的被传递？

### 修复步骤

1. 提前创建依赖
2. 提前执行 hook
3. 传递数据给目标函数
4. 移除重复调用

### 验证步骤

1. 构建验证
2. 代码验证
3. 运行时验证

---

**版本**：v20260202_1  
**最后更新**：2026-02-02  
**来源**：动态管道架构接入实战

