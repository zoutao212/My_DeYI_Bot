# Hook 返回值字段遗漏问题处理方法论

> **来源**：Lina 人格接入调试（2026-02-02）  
> **问题**：在 Hook 类型定义中添加了新字段，但忘记在 Hook Runner 的合并逻辑中添加该字段的合并

---

## 问题识别

### 典型现象

- Hook 类型定义中有新字段（如 `characterName`）
- Hook 返回了该字段的值
- 但调用方收到的结果中该字段为 `undefined`
- 日志显示 Hook 正确执行并返回了值

### 根本原因

**类型定义和合并逻辑分离在不同文件**：
- 类型定义：`src/plugins/types.ts`
- 合并逻辑：`src/plugins/hooks.ts`

添加新字段时，只修改了类型定义，忘记更新合并逻辑。

---

## 标准修复流程

### 第一步：确认类型定义

检查 Hook 返回值类型是否包含新字段：

```typescript
// src/plugins/types.ts
export type PluginHookBeforeAgentStartResult = {
  systemPrompt?: string;
  prependContext?: string;
  characterName?: string;  // 🆕 新字段
};
```

### 第二步：检查合并逻辑

检查 Hook Runner 的合并逻辑是否包含新字段：

```typescript
// src/plugins/hooks.ts
async function runBeforeAgentStart(
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeAgentStartResult | undefined> {
  return runModifyingHook<"before_agent_start", PluginHookBeforeAgentStartResult>(
    "before_agent_start",
    event,
    ctx,
    (acc, next) => ({
      systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
      prependContext:
        acc?.prependContext && next.prependContext
          ? `${acc.prependContext}\n\n${next.prependContext}`
          : (next.prependContext ?? acc?.prependContext),
      // ❌ 缺少 characterName 合并！
    }),
  );
}
```

### 第三步：添加字段合并

在合并逻辑中添加新字段的合并：

```typescript
// src/plugins/hooks.ts
async function runBeforeAgentStart(
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeAgentStartResult | undefined> {
  return runModifyingHook<"before_agent_start", PluginHookBeforeAgentStartResult>(
    "before_agent_start",
    event,
    ctx,
    (acc, next) => ({
      systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
      prependContext:
        acc?.prependContext && next.prependContext
          ? `${acc.prependContext}\n\n${next.prependContext}`
          : (next.prependContext ?? acc?.prependContext),
      characterName: next.characterName ?? acc?.characterName,  // ✅ 添加合并
    }),
  );
}
```

### 第四步：更新注释

更新函数注释，说明合并了哪些字段：

```typescript
/**
 * Run before_agent_start hook.
 * Allows plugins to inject context into the system prompt.
 * Runs sequentially, merging systemPrompt, prependContext, and characterName from all handlers.
 */
```

### 第五步：验证修复

1. **构建项目**：`pnpm build`
2. **验证 dist 文件**：检查 `dist/plugins/hooks.js` 是否包含新字段合并
3. **运行测试**：验证 Hook 返回值是否正确传递

---

## 预防措施

### 1. 添加新字段时的检查清单

- [ ] 更新类型定义（`src/plugins/types.ts`）
- [ ] 更新合并逻辑（`src/plugins/hooks.ts`）
- [ ] 更新函数注释
- [ ] 搜索所有使用该类型的地方
- [ ] 运行测试验证

### 2. 代码审查要点

审查 Hook 类型扩展时，必须检查：
- 类型定义是否完整
- 合并逻辑是否包含所有字段
- 注释是否更新
- 是否有测试覆盖

### 3. 自动化检测

可以添加 TypeScript 类型检查来确保合并逻辑完整：

```typescript
// 类型检查：确保合并逻辑返回完整的类型
type MergeResult = ReturnType<typeof runBeforeAgentStart> extends Promise<infer T>
  ? T extends PluginHookBeforeAgentStartResult | undefined
    ? true
    : false
  : false;

const _typeCheck: MergeResult = true;  // 如果类型不匹配，这里会报错
```

---

## 适用范围

本方法论适用于所有 Hook 类型扩展：

- `before_agent_start`
- `agent_end`
- `before_compaction`
- `after_compaction`
- `message_received`
- `message_sending`
- `message_sent`
- `before_tool_call`
- `after_tool_call`
- `tool_result_persist`
- `session_start`
- `session_end`
- `gateway_start`
- `gateway_stop`

---

## 关键教训

1. **类型定义和实现要同步更新**
   - 添加新字段时，必须同时更新合并逻辑
   - 不要只修改类型定义

2. **合并逻辑要完整**
   - 所有字段都要有合并策略
   - 考虑字段的优先级（`next` 优先还是 `acc` 优先）

3. **验证要彻底**
   - 不要只看类型检查通过
   - 要运行测试验证实际行为

4. **文档要同步**
   - 更新函数注释
   - 更新类型文档

---

## 实战案例

### 案例：Lina 人格接入

**问题**：
- 在 `PluginHookBeforeAgentStartResult` 中添加了 `characterName` 字段
- Hook 返回了 `characterName: "lina"`
- 但 `buildEmbeddedSystemPrompt` 收到的 `hookCharacterName` 是 `undefined`

**原因**：
- `runBeforeAgentStart` 的合并逻辑中没有合并 `characterName` 字段

**修复**：
- 在合并逻辑中添加 `characterName: next.characterName ?? acc?.characterName`

**验证**：
- 运行测试脚本 `test-lina-integration.mjs`
- 确认 Hook 返回的 `characterName` 正确传递到 `buildEmbeddedSystemPrompt`
- 确认 Lina 人格设定成功注入到 System Prompt

---

## 相关文档

- `.kiro/lessons-learned/07_AI工具使用陷阱.md`：工具调用验证
- `.kiro/lessons-learned/10_构建验证流程.md`：构建后验证
- `.kiro/lessons-learned/12_配置项验证方法论.md`：配置验证

---

**版本**：v20260202_1  
**最后更新**：2026-02-02  
**关键词**：Hook, 返回值, 字段遗漏, 合并逻辑, 类型定义, Plugin
