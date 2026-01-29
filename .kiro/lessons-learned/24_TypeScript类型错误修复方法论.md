# TypeScript 类型错误修复方法论

> **触发场景**：编译时出现类型不匹配错误

---

## 问题识别

### 典型错误信息

```
error TS2322: Type 'X' is not assignable to type 'Y'
error TS2339: Property 'xxx' does not exist on type 'Y'
error TS2305: Module 'xxx' has no exported member 'Y'
```

### 常见原因

1. **属性不存在**：访问了联合类型中某些成员没有的属性
2. **类型不匹配**：赋值的类型与目标类型不兼容
3. **导入错误**：从错误的包导入类型

---

## 标准修复流程

### 第一步：定位错误位置

**阅读错误信息**：
- 文件路径和行号
- 具体的类型不匹配信息
- 期望类型 vs 实际类型

**示例**：
```
src/agents/pi-embedded-runner/history.ts:43:13 - error TS2322
Type '{ content: any[]; role: "user"; ... }' is not assignable to type 'AgentMessage'
Property 'content' does not exist on type 'BashExecutionMessage'
```

**分析**：
- 位置：`history.ts:43:13`
- 问题：`AgentMessage` 是联合类型，其中 `BashExecutionMessage` 没有 `content` 属性
- 原因：代码假设所有 `AgentMessage` 都有 `content`，但实际不是

### 第二步：搜索类型定义

**使用 grepSearch 查找类型定义**：

```powershell
# 搜索类型定义
grepSearch -query "type AgentMessage.*=" -includePattern "src/**/*.ts"

# 搜索接口定义
grepSearch -query "interface AgentMessage" -includePattern "src/**/*.ts"

# 搜索导出的类型
grepSearch -query "export.*AgentMessage" -includePattern "src/**/*.ts"
```

**查看类型定义文件**：
- 理解联合类型的所有成员
- 确认哪些成员有目标属性
- 确认属性的类型

### 第三步：选择修复策略

#### 策略 1：使用类型守卫（Type Guard）

**适用场景**：需要访问联合类型中部分成员才有的属性

**示例**：
```typescript
// ❌ 错误：直接访问可能不存在的属性
const content = message.content;

// ✅ 正确：使用 in 操作符检查
if ("content" in message && message.content !== undefined) {
  const content = message.content;
}
```

#### 策略 2：类型过滤（Type Filter）

**适用场景**：需要过滤数组中的特定类型

**示例**：
```typescript
// ❌ 错误：假设所有元素都是某个类型
const textItems = items.map(item => item.text);

// ✅ 正确：使用类型断言过滤
const textItems = items.filter(
  (item): item is TextContent => item.type === "text"
);
```

#### 策略 3：创建新对象

**适用场景**：类型不匹配，无法直接修改

**示例**：
```typescript
// ❌ 错误：修改对象导致类型不匹配
const modified = {
  ...original,
  content: newContent  // 类型不匹配
};

// ✅ 正确：创建符合目标类型的新对象
const newMessage: TargetType = {
  role: "user",
  content: newContent,
  timestamp: original.timestamp
};
```

#### 策略 4：修正导入路径

**适用场景**：类型导入错误

**示例**：
```typescript
// ❌ 错误：从错误的包导入
import type { TextContent } from "@mariozechner/pi-agent-core";

// ✅ 正确：搜索正确的导入位置
// grepSearch -query "import.*TextContent" -includePattern "src/**/*.ts"
import type { TextContent } from "@mariozechner/pi-ai";
```

### 第四步：验证修复

**重新构建**：
```powershell
pnpm build
```

**检查结果**：
- ✅ 编译成功
- ✅ 没有新的类型错误
- ✅ 逻辑正确

---

## 实战案例

### 案例 1：联合类型属性访问

**错误**：
```typescript
const taskGoalWithMarker: AgentMessage = {
  ...taskGoal,
  content: Array.isArray(taskGoal.content) ? [...] : [...]
};
// Error: Property 'content' does not exist on type 'BashExecutionMessage'
```

**分析**：
- `AgentMessage` 是联合类型
- 不是所有成员都有 `content` 属性
- 需要先检查属性是否存在

**修复**：
```typescript
if ("content" in taskGoal && taskGoal.content !== undefined) {
  const taskGoalWithMarker: AgentMessage = {
    ...taskGoal,
    content: Array.isArray(taskGoal.content) ? [...] : [...]
  };
}
```

### 案例 2：类型过滤

**错误**：
```typescript
const taskGoalWithMarker: AgentMessage = {
  ...taskGoal,
  content: [
    { type: "text", text: "..." },
    ...taskGoal.content  // 可能包含 ThinkingContent 和 ToolCall
  ]
};
// Error: Type 'ThinkingContent' is not assignable to type 'TextContent'
```

**分析**：
- `taskGoal.content` 可能包含多种类型
- 目标类型只接受 `TextContent` 和 `ImageContent`
- 需要过滤掉不兼容的类型

**修复**：
```typescript
const filteredContent = Array.isArray(taskGoal.content)
  ? taskGoal.content.filter(
      (item): item is TextContent | ImageContent =>
        item.type === "text" || item.type === "image"
    )
  : [];

const taskGoalWithMarker: AgentMessage = {
  ...taskGoal,
  content: [
    { type: "text", text: "..." },
    ...filteredContent
  ]
};
```

### 案例 3：导入路径错误

**错误**：
```typescript
import type { TextContent, ImageContent } from "@mariozechner/pi-agent-core";
// Error: Module has no exported member 'TextContent'
```

**分析**：
- 类型从错误的包导入
- 需要搜索正确的导入位置

**修复**：
```powershell
# 搜索正确的导入位置
grepSearch -query "import.*TextContent" -includePattern "src/**/*.ts"
```

```typescript
// 正确的导入
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
```

---

## 检查清单

修复类型错误时，按以下顺序检查：

- [ ] **阅读错误信息**：理解具体的类型不匹配
- [ ] **搜索类型定义**：理解联合类型的所有成员
- [ ] **选择修复策略**：类型守卫 / 类型过滤 / 创建新对象 / 修正导入
- [ ] **实施修复**：编写符合类型系统的代码
- [ ] **重新构建**：验证编译成功
- [ ] **逻辑验证**：确保修复后逻辑正确

---

## 常见错误模式

### 错误 1：盲目使用 any

```typescript
// ❌ 错误：使用 any 绕过类型检查
const content: any = taskGoal.content;

// ✅ 正确：使用类型守卫
if ("content" in taskGoal) {
  const content = taskGoal.content;
}
```

### 错误 2：假设所有成员都有某个属性

```typescript
// ❌ 错误：假设所有 AgentMessage 都有 content
const content = message.content;

// ✅ 正确：检查属性是否存在
if ("content" in message) {
  const content = message.content;
}
```

### 错误 3：不验证修复效果

```typescript
// ❌ 错误：修改后不重新构建
// 可能引入新的类型错误

// ✅ 正确：修改后立即构建验证
pnpm build
```

---

## 关键教训

1. **类型系统是朋友，不是敌人** - 类型错误帮助我们发现潜在的运行时错误
2. **理解联合类型** - 不是所有成员都有相同的属性
3. **使用类型守卫** - `in` 操作符是最常用的类型守卫
4. **类型过滤很有用** - 使用类型断言过滤数组
5. **搜索正确的导入** - 不要猜测类型的导入位置
6. **立即验证** - 修改后立即构建验证

---

**版本：** v20260129_1  
**最后更新：** 2026-01-29  
**来源：** 记忆功能改进实战（TypeScript 类型错误修复）
