# 对话历史格式混乱导致 LLM 行为异常

> **来源**：LLM 无限循环调试实战（用户消息格式转换缺失）  
> **日期**：2026-02-03  
> **关键词**：对话历史、格式混乱、OpenAI 格式、Gemini 格式、用户消息转换、convertOpenAIToGeminiFormat

---

## 问题场景

**现象**：
- LLM 反复执行相同的工具调用
- LLM 无法完成简单的任务
- LLM 把历史消息当成了新任务
- LLM 的行为不可预测

**常见误判**：
- 以为是系统提示词问题（"会话初始化"）
- 以为是 LLM 幻觉（"日期错误"）
- 以为是工具调用问题

**实际根因**：对话历史中混合了 OpenAI 和 Gemini 两种格式，LLM 无法理解。

---

## 根本原因

### 为什么对话历史会格式混乱？

1. **用户消息使用 OpenAI 格式**
   - `pi-coding-agent` 库使用 OpenAI 格式保存用户消息
   - 格式：`{ role: "user", content: [{ type: "text", text: "..." }] }`

2. **LLM 返回的消息使用 Gemini 格式**
   - `vectorengine` provider 使用 Gemini 格式
   - 格式：`{ role: "model", parts: [{ text: "...", thoughtSignature: "..." }] }`

3. **格式转换不完整**
   - `convertOpenAIToGeminiFormat` 函数只转换了 `assistant`、`tool`、`toolResult` 消息
   - **但没有转换普通的 `user` 消息**
   - 导致对话历史混合了两种格式

### 为什么格式混乱会导致 LLM 行为异常？

1. **LLM 无法理解混合格式**
   - LLM 期望所有消息都是同一种格式
   - 混合格式会让 LLM 迷失

2. **LLM 把历史消息当成新任务**
   - 用户消息是 OpenAI 格式（`content` 数组）
   - LLM 返回的消息是 Gemini 格式（`parts` 数组）
   - LLM 可能把 OpenAI 格式的消息当成"新的用户输入"

3. **LLM 无法区分"当前任务"和"历史记录"**
   - 格式不一致导致 LLM 无法正确解析对话历史
   - LLM 可能重复执行历史任务

---

## 调试流程

### 第一步：检查 session 中保存的消息格式

```powershell
# 读取 session 文件
$session = Get-Content "C:\Users\zouta\.clawdbot\agents\main\sessions\sessions.json" -Encoding UTF8 | ConvertFrom-Json

# 检查消息格式
$session.messages | ForEach-Object {
  $role = $_.role
  $hasParts = $_.parts -ne $null
  $hasContent = $_.content -ne $null
  Write-Host "role=$role hasParts=$hasParts hasContent=$hasContent"
}
```

**预期结果**：
- 用户消息：`role=user hasContent=True hasParts=False`（OpenAI 格式）
- LLM 回复：`role=model hasParts=True hasContent=False`（Gemini 格式）

**问题识别**：
- 如果格式混乱（同时有 `content` 和 `parts`），说明保存逻辑有问题
- 如果格式不一致（有些消息是 OpenAI 格式，有些是 Gemini 格式），说明格式转换不完整

### 第二步：检查发送给 API 的 payload 格式

```powershell
# 读取 trace 日志
$trace = Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json

# 提取最新的 payload
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
$payload = $payloads[-1].payload.payload

# 检查消息格式
$payload.messages | ForEach-Object {
  $role = $_.role
  $hasParts = $_.parts -ne $null
  $hasContent = $_.content -ne $null
  Write-Host "role=$role hasParts=$hasParts hasContent=$hasContent"
}
```

**预期结果**（vectorengine provider）：
- 所有消息：`hasParts=True hasContent=False`（Gemini 格式）

**问题识别**：
- 如果有消息是 OpenAI 格式（`hasContent=True`），说明格式转换不完整
- 如果格式混乱，LLM 无法理解

### 第三步：检查格式转换日志

```powershell
# 检查格式转换日志
$trace = Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$formatLogs = $trace | Where-Object { $_.event -eq "log" -and $_.payload.message -like "*format*" }
$formatLogs | ForEach-Object { Write-Host $_.payload.message }
```

**预期结果**：
- 看到 "Converting OpenAI format to Gemini format" 日志
- 看到 "Converted user message from OpenAI format to Gemini format" 日志

**问题识别**：
- 如果没有看到格式转换日志，说明格式转换没有执行
- 如果只看到部分消息的转换日志，说明格式转换不完整

---

## 修复方案

### 修改位置

**文件**：`src/agents/gemini-payload-thought-signature.ts`

**函数**：`convertOpenAIToGeminiFormat`

### 修改内容

在 `convertOpenAIToGeminiFormat` 函数的末尾，添加对普通用户消息的处理：

```typescript
// 其他消息保持不变
// 🔧 Fix: Convert user messages from OpenAI format to Gemini format
// User messages in OpenAI format: { role: "user", content: [{ type: "text", text: "..." }] }
// User messages in Gemini format: { role: "user", parts: [{ text: "..." }] }
if (role === "user") {
  const content = msgRec.content;
  
  // If already in Gemini format (has parts), return as-is
  if (msgRec.parts) {
    return msg;
  }
  
  // Convert OpenAI format to Gemini format
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        if (!block || typeof block !== "object") return null;
        const blockRec = block as Record<string, unknown>;
        
        // Extract text from OpenAI format
        if (blockRec.type === "text" && typeof blockRec.text === "string") {
          return { text: blockRec.text };
        }
        
        // Extract image from OpenAI format
        if (blockRec.type === "image_url" && blockRec.image_url && typeof blockRec.image_url === "object") {
          const imageUrl = blockRec.image_url as Record<string, unknown>;
          if (typeof imageUrl.url === "string") {
            return { inlineData: { mimeType: "image/jpeg", data: imageUrl.url } };
          }
        }
        
        return null;
      })
      .filter(Boolean);
    
    if (parts.length > 0) {
      log.debug(`[format] Converted user message from OpenAI format to Gemini format (${parts.length} parts)`);
      return {
        role: "user",
        parts: parts,
      };
    }
  }
  
  // If content is a string, convert to Gemini format
  if (typeof content === "string" && content.length > 0) {
    log.debug(`[format] Converted user message from OpenAI format (string) to Gemini format`);
    return {
      role: "user",
      parts: [{ text: content }],
    };
  }
}

return msg;
```

### 修复原理

1. **检查消息格式**：如果用户消息已经是 Gemini 格式（有 `parts` 字段），直接返回
2. **转换 OpenAI 格式**：
   - 如果 `content` 是数组，提取每个 block 的 `text` 或 `image_url`
   - 如果 `content` 是字符串，直接转换为 `parts: [{ text: content }]`
3. **统一格式**：所有用户消息都转换为 Gemini 格式

---

## 验证方法

### 1. 构建验证

```powershell
pnpm build
Select-String -Path "dist/agents/gemini-payload-thought-signature.js" -Pattern "Converted user message from OpenAI format" -Context 0,2 -Encoding UTF8
```

**预期结果**：找到两处日志输出

### 2. 运行时验证

重启 Clawdbot，发送消息，检查 trace 日志：

```powershell
$trace = Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$formatLogs = $trace | Where-Object { $_.event -eq "log" -and $_.payload.message -like "*Converted user message*" }
$formatLogs | ForEach-Object { Write-Host $_.payload.message }
```

**预期结果**：看到 "Converted user message from OpenAI format to Gemini format" 日志

### 3. 对话历史验证

检查发送给 API 的 payload，确认所有消息都是 Gemini 格式：

```powershell
$trace = Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
$payload = $payloads[-1].payload.payload
$payload.messages | ForEach-Object {
  $role = $_.role
  $hasParts = $_.parts -ne $null
  $hasContent = $_.content -ne $null
  Write-Host "role=$role hasParts=$hasParts hasContent=$hasContent"
}
```

**预期结果**：
- 所有 `role=user` 的消息都有 `hasParts=True`
- 所有 `role=model` 的消息都有 `hasParts=True`
- 没有消息同时有 `content` 和 `parts`

---

## 关键教训

### 1. 格式混乱是致命的

**问题**：
- 对话历史中混合了两种格式
- LLM 无法理解混合格式
- LLM 的行为变得不可预测

**解决方案**：
- 统一格式：所有消息都使用同一种格式
- 在数据流的关键节点进行格式转换
- 确保格式转换是完整的（不要遗漏某些消息类型）

### 2. 不要相信"已经实现了"

**问题**：
- `convertOpenAIToGeminiFormat` 函数已经实现了
- 但它只转换了部分消息类型
- 普通用户消息没有被转换

**教训**：
- 检查函数的实现，确认它处理了所有情况
- 不要假设"已经实现了"就意味着"完全正确"
- 测试所有边界情况

### 3. 用户的直觉可能是对的

**用户说**："我怀疑你在添加对话记录时，直接粗暴的添加了对话记录，但没有明确附加提示，每一个对话是什么时间的第一条对话，AI 的自己的回复是什么，导致她每次都以为是第一次对话！！！"

**实际情况**：
- 用户的直觉是对的！
- 对话历史的格式混乱，导致 LLM 无法区分"当前任务"和"历史记录"
- LLM 可能把历史消息当成了"新的任务"

**教训**：
- 认真听取用户的反馈
- 用户的直觉可能指向真正的问题
- 不要急于否定用户的观点

### 4. 追踪完整数据流

**错误做法**：
- 只看某个环节的数据
- 假设数据格式是正确的

**正确做法**：
- 追踪完整的数据流
- 检查每个环节的数据格式
- 验证格式转换是否完整

---

## 相关文档

- `.kiro/lessons-learned/70_LLM行为异常的完整调试流程.md` - LLM 行为异常的系统化调试方法
- `.kiro/lessons-learned/72_LLM无限循环的系统提示词修复.md` - 系统提示词导致的无限循环
- `.kiro/lessons-learned/73_LLM无限循环的根本解决方案.md` - 系统提示词设计原则
- `Runtimelog/tempfile/LLM无限循环根本修复_用户消息格式转换_20260203.md` - 完整的修复过程

---

**版本**：v20260203_1  
**最后更新**：2026-02-03  
**状态**：已修复，待验证
