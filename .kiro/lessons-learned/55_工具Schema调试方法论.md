# 工具 Schema 调试方法论

> **来源**：write 工具 Schema 错误导致 LLM 返回文本模拟  
> **版本**：v20260202_1  
> **最后更新**：2026-02-02

---

## 问题识别

### 典型症状

当 LLM 应该调用工具时，却返回文本模拟：

```
Tool call structure:
`write_file(file_path='...', content='...')`
```

或者：

```
我会使用 write 工具来完成这个任务...
```

而不是真正的 `functionCall`。

### 其他症状

- `stopReason: "error"` 但没有明确的错误信息
- 工具调用失败，但不知道原因
- 同样的请求有时成功，有时失败

---

## 调试流程（标准化）⭐ **重要**

### 步骤 1：提取完整 Payload

**不要只看日志中的 preview！**

```powershell
# 找到最新的 trace 文件
$traceFile = Get-ChildItem "C:\Users\zouta\.clawdbot\runtimelog" -Filter "trace__*.jsonl" | 
  Sort-Object LastWriteTime -Descending | 
  Select-Object -First 1

# 提取 llm.payload 事件
$lines = Get-Content $traceFile.FullName -Encoding UTF8
$payloadEvent = $lines | Where-Object { $_ -match '"event":"llm\.payload"' } | 
  Select-Object -Last 1

# 解析并保存
$json = $payloadEvent | ConvertFrom-Json
$payload = $json.payload.payload
$payload | ConvertTo-Json -Depth 20 | Out-File "payload_debug.json" -Encoding UTF8
```

**关键点**：
- 使用 `-Depth 20` 确保完整输出
- 保存到文件便于分析
- 不要相信日志中的 `payloadPreview`（可能被截断）

---

### 步骤 2：检查 Tools Schema

**重点检查 `required` 字段**

```powershell
# 读取 payload
$payload = Get-Content "payload_debug.json" -Raw -Encoding UTF8 | ConvertFrom-Json

# 提取特定工具的定义
$tool = $payload.tools.functionDeclarations | Where-Object { $_.name -eq "write" }

# 保存工具定义
$tool | ConvertTo-Json -Depth 10 | Out-File "tool_definition.json" -Encoding UTF8

# 检查 required 字段
Write-Host "Required fields: $($tool.parameters.required -join ', ')"
```

**检查清单**：
- [ ] `required` 字段是否包含所有必需参数？
- [ ] 是否有重复的字段（如 `path` 和 `file_path`）？
- [ ] 字段描述是否清晰？
- [ ] 是否有不必要的可选字段？

---

### 步骤 3：对比原始工具和修改后的工具

**创建测试脚本**

```javascript
import { createWriteTool } from "@mariozechner/pi-coding-agent";
import { patchToolSchemaForClaudeCompatibility } from "../../dist/agents/pi-tools.read.js";

// 1. 原始工具
const originalTool = createWriteTool(process.cwd());
console.log("原始 schema:", JSON.stringify(originalTool.parameters, null, 2));

// 2. 应用补丁后
const patchedTool = patchToolSchemaForClaudeCompatibility(originalTool);
console.log("补丁后 schema:", JSON.stringify(patchedTool.parameters, null, 2));

// 3. 对比 required 字段
console.log("原始 required:", originalTool.parameters.required);
console.log("补丁后 required:", patchedTool.parameters.required);
```

**关键点**：
- 对比 `required` 字段的变化
- 检查是否有字段被意外移除
- 验证别名字段是否正确添加

---

### 步骤 4：追踪代码修改逻辑

**搜索相关函数**

```powershell
# 搜索 patchToolSchemaForClaudeCompatibility
grepSearch -query "function patchToolSchemaForClaudeCompatibility" -includePattern "**/*.ts"

# 搜索 wrapToolParamNormalization
grepSearch -query "function wrapToolParamNormalization" -includePattern "**/*.ts"

# 搜索 CLAUDE_PARAM_GROUPS
grepSearch -query "CLAUDE_PARAM_GROUPS" -includePattern "**/*.ts"
```

**检查逻辑**：
- 是否有移除 `required` 字段的逻辑？
- 别名字段是如何添加的？
- 运行时验证是如何工作的？

---

### 步骤 5：验证修复

**创建验证脚本**

```javascript
// 验证修复后的 schema
const wrappedTool = wrapToolParamNormalization(patchedTool, CLAUDE_PARAM_GROUPS.write);
const required = wrappedTool.parameters?.required || [];

console.log("✅ 验证结果:");
console.log(`  - required: ${JSON.stringify(required)}`);
console.log(`  - 包含 path: ${required.includes("path")}`);
console.log(`  - 包含 content: ${required.includes("content")}`);

if (required.includes("path") && required.includes("content")) {
  console.log("🎉 修复成功！");
} else {
  console.log("❌ 修复失败！");
}
```

---

## 常见问题模式

### 模式 1：required 字段缺失

**症状**：
- LLM 返回文本模拟
- 工具调用失败

**原因**：
- Schema 的 `required` 字段不包含必需参数
- LLM 认为参数是可选的
- LLM 不知道应该提供哪些参数

**修复**：
- 确保 `required` 包含所有必需参数
- 不要在补丁逻辑中移除 `required` 字段

**示例**：
```typescript
// ❌ 错误：移除了 required
const idx = required.indexOf(original);
if (idx !== -1) {
  required.splice(idx, 1);  // 不要这样做！
}

// ✅ 正确：保留 required
// 不要移除 original 从 required
// 运行时会接受别名字段
```

---

### 模式 2：重复字段导致混淆

**症状**：
- LLM 不知道应该使用哪个字段
- 有时使用 `path`，有时使用 `file_path`

**原因**：
- Schema 同时包含 `path` 和 `file_path`
- 但 `required` 不包含任何一个
- LLM 不知道应该提供哪个

**修复**：
- 保留原字段在 `required` 中
- 添加别名字段到 `properties`
- 运行时规范化参数

**示例**：
```json
{
  "required": ["path", "content"],  // ✅ 明确要求 path
  "properties": {
    "path": { ... },                // ✅ 原字段
    "file_path": { ... },           // ✅ 别名（运行时接受）
    "content": { ... }
  }
}
```

---

### 模式 3：Schema 与运行时验证不一致

**症状**：
- Schema 说参数是可选的
- 但运行时验证要求参数

**原因**：
- Schema 是 LLM 的唯一指南
- 运行时验证不能弥补 schema 的错误
- LLM 只能看到 schema

**修复**：
- 确保 schema 准确反映 LLM 应该提供的参数
- 不要依赖运行时验证来"修正" schema

**示例**：
```typescript
// ❌ 错误：依赖运行时验证
{
  "required": [],  // Schema 说都是可选的
  // 但运行时验证要求 path
}

// ✅ 正确：Schema 明确要求
{
  "required": ["path", "content"],  // Schema 明确要求
  // 运行时验证只是额外的安全检查
}
```

---

## LLM 行为分析

### LLM 在 Schema 不清晰时的行为

**观察**：
- 当 LLM 遇到 `stopReason: "error"` 时
- 如果 schema 不清晰（如字段可选性不明确）
- LLM 会选择返回文本而不是调用工具
- 这是一种"安全"行为

**原因**：
- LLM 不想冒险调用可能失败的工具
- 返回文本是更安全的选择
- LLM 希望用户能提供更多信息

**教训**：
- 清晰的 schema 可以减少 LLM 的困惑
- 即使在错误情况下，LLM 也更可能尝试调用工具

---

## 预防措施

### 1. 代码审查清单

在修改工具 schema 时，检查：
- [ ] 是否保留了所有必需参数在 `required` 中？
- [ ] 别名字段是否正确添加到 `properties`？
- [ ] 是否有意外移除 `required` 字段的逻辑？
- [ ] 运行时验证是否与 schema 一致？

### 2. 测试清单

在部署前，测试：
- [ ] 创建测试脚本验证 schema
- [ ] 对比原始工具和修改后的工具
- [ ] 验证 `required` 字段是否正确
- [ ] 测试 LLM 是否能正确调用工具

### 3. 文档清单

在修改后，更新：
- [ ] 工具 schema 的文档
- [ ] 别名字段的说明
- [ ] 运行时验证的逻辑
- [ ] 常见问题和解决方案

---

## 调试工具箱

### PowerShell 脚本

**提取 Payload**
```powershell
function Extract-LLMPayload {
  param([string]$OutputFile = "payload_debug.json")
  
  $traceFile = Get-ChildItem "C:\Users\zouta\.clawdbot\runtimelog" -Filter "trace__*.jsonl" | 
    Sort-Object LastWriteTime -Descending | 
    Select-Object -First 1
  
  $lines = Get-Content $traceFile.FullName -Encoding UTF8
  $payloadEvent = $lines | Where-Object { $_ -match '"event":"llm\.payload"' } | 
    Select-Object -Last 1
  
  $json = $payloadEvent | ConvertFrom-Json
  $payload = $json.payload.payload
  $payload | ConvertTo-Json -Depth 20 | Out-File $OutputFile -Encoding UTF8
  
  Write-Host "✅ Payload 已保存到: $OutputFile" -ForegroundColor Green
}
```

**检查工具 Schema**
```powershell
function Check-ToolSchema {
  param(
    [string]$PayloadFile = "payload_debug.json",
    [string]$ToolName = "write"
  )
  
  $payload = Get-Content $PayloadFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $tool = $payload.tools.functionDeclarations | Where-Object { $_.name -eq $ToolName }
  
  Write-Host "📋 $ToolName 工具 Schema:" -ForegroundColor Yellow
  Write-Host "  - required: $($tool.parameters.required -join ', ')" -ForegroundColor Cyan
  Write-Host "  - properties: $($tool.parameters.properties.PSObject.Properties.Name -join ', ')" -ForegroundColor Cyan
  
  $tool | ConvertTo-Json -Depth 10 | Out-File "${ToolName}_definition.json" -Encoding UTF8
  Write-Host "✅ 工具定义已保存到: ${ToolName}_definition.json" -ForegroundColor Green
}
```

### Node.js 测试脚本模板

```javascript
#!/usr/bin/env node

import { createWriteTool } from "@mariozechner/pi-coding-agent";
import { patchToolSchemaForClaudeCompatibility, CLAUDE_PARAM_GROUPS, wrapToolParamNormalization } from "../../dist/agents/pi-tools.read.js";

console.log("🔍 测试工具 schema\n");

// 1. 原始工具
const originalTool = createWriteTool(process.cwd());
console.log("1️⃣ 原始 schema:");
console.log(JSON.stringify(originalTool.parameters, null, 2));
console.log("");

// 2. 应用补丁
const patchedTool = patchToolSchemaForClaudeCompatibility(originalTool);
console.log("2️⃣ 补丁后 schema:");
console.log(JSON.stringify(patchedTool.parameters, null, 2));
console.log("");

// 3. 应用包装
const wrappedTool = wrapToolParamNormalization(patchedTool, CLAUDE_PARAM_GROUPS.write);
console.log("3️⃣ 包装后 schema:");
console.log(JSON.stringify(wrappedTool.parameters, null, 2));
console.log("");

// 4. 验证
const required = wrappedTool.parameters?.required || [];
console.log("✅ 验证结果:");
console.log(`  - required: ${JSON.stringify(required)}`);

if (required.includes("path") && required.includes("content")) {
  console.log("\n🎉 Schema 正确！");
} else {
  console.log("\n❌ Schema 错误！");
}
```

---

## 关键教训

1. **Schema 是 LLM 的唯一指南**
   - LLM 只能看到 schema
   - 运行时验证不能弥补 schema 的错误
   - Schema 必须准确反映 LLM 应该提供的参数

2. **不要假设问题在哪里**
   - 不要只看错误信息
   - 不要假设是系统提示词过长
   - 用数据说话：提取完整 payload，检查 schema

3. **别名字段的正确处理**
   - 添加别名字段到 `properties`
   - 保留原字段在 `required` 中
   - 运行时规范化参数

4. **LLM 在不确定时会选择安全行为**
   - Schema 不清晰 → LLM 返回文本
   - Schema 清晰 → LLM 调用工具
   - 清晰的 schema 可以提高工具调用成功率

5. **调试要系统化**
   - 提取完整 payload
   - 检查 tools schema
   - 对比原始和修改后的工具
   - 创建测试脚本验证
   - 追踪代码修改逻辑

---

## 相关文档

- `.kiro/lessons-learned/52_LLM行为异常调试标准流程.md` - LLM 行为异常调试
- `.kiro/lessons-learned/50_工具调用验证与重试机制.md` - 工具调用验证
- `.kiro/steering/agent-development-validation.md` - Agent 开发验证原则

---

**版本**：v20260202_1  
**最后更新**：2026-02-02  
**变更**：初始版本，总结工具 Schema 调试方法论
