# API 格式兼容性调试标准流程

> **场景**：中转 API 使用标准接口（如 `openai-completions`），但实际期望不同的格式

**日期**：2026-02-03  
**来源**：yinli + vectorengine provider 调试实战

---

## 问题识别

### 典型症状

1. **第一次请求成功，后续请求失败**
   - seq=1 ✅
   - seq=2 ❌
   - seq=3 ❌

2. **错误信息不明确**
   - "missing thought_signature"
   - "invalid format"
   - "Connection error"

3. **相同的代码，不同的 provider 表现不同**
   - 官方 API 成功
   - 中转 API 失败

### 根本原因

**中转 API 声称兼容标准接口，但实际上期望不同的格式。**

常见差异：
- 字段位置不同（顶层 vs 嵌套）
- 字段名称不同（`tool_calls` vs `functionCall`）
- 数据类型不同（字符串 vs 对象）
- 角色名称不同（`assistant` vs `model`）

---

## 标准调试流程

### 步骤 1：确认问题模式

**检查点**：
- [ ] seq=1 成功？
- [ ] seq=2 失败？
- [ ] seq=3 失败？

**如果是**：很可能是历史消息格式问题。

### 步骤 2：提取完整 payload

**提取成功的 payload（seq=1）**：
```powershell
$trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
$seq1 = $trace | Where-Object { $_.event -eq "llm.payload" -and $_.payload.seq -eq 1 }
$seq1.payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload_seq1.json"
```

**提取失败的 payload（seq=2）**：
```powershell
$seq2 = $trace | Where-Object { $_.event -eq "llm.payload" -and $_.payload.seq -eq 2 }
$seq2.payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload_seq2.json"
```

### 步骤 3：逐层对比差异

**对比脚本**：
```powershell
$p1 = Get-Content "payload_seq1.json" | ConvertFrom-Json
$p2 = Get-Content "payload_seq2.json" | ConvertFrom-Json

# 对比 messages 数量
Write-Host "messages 数量: $($p1.messages.Count) vs $($p2.messages.Count)"

# 对比每条消息的结构
for ($i = 0; $i -lt $p2.messages.Count; $i++) {
    $msg = $p2.messages[$i]
    Write-Host "`n=== Message $i ==="
    Write-Host "role: $($msg.role)"
    Write-Host "content type: $(if ($msg.content -eq $null) { 'null' } elseif ($msg.content -is [array]) { "array($($msg.content.Count))" } else { $msg.content.GetType().Name })"
    
    # 检查 tool_calls
    if ($msg.tool_calls) {
        Write-Host "⚠️ 有 tool_calls 字段"
        Write-Host "tool_calls 数量: $($msg.tool_calls.Count)"
    }
    
    # 检查 content 中的 functionCall
    if ($msg.content -is [array]) {
        foreach ($block in $msg.content) {
            if ($block.functionCall) {
                Write-Host "✓ content 中有 functionCall"
            }
        }
    }
}
```

### 步骤 4：识别格式差异

**常见格式差异**：

| 差异类型 | OpenAI 格式 | Gemini 格式 | 其他格式 |
|---------|------------|------------|---------|
| 工具调用位置 | `tool_calls` 数组（顶层） | `content` 数组中的 `functionCall` | - |
| 角色名称 | `assistant` | `model` | - |
| 工具结果角色 | `tool` | `function` | - |
| 参数字段 | `arguments`（字符串） | `args`（对象） | - |
| 签名字段位置 | 顶层 + 内部 | 只在内部 | 只在顶层 |

### 步骤 5：实现格式转换

**位置**：`src/agents/gemini-payload-thought-signature.ts` 的 `wrapStreamFn`

**模板**：
```typescript
// 对于特定 provider，转换格式
if (base.provider && base.provider.toLowerCase().includes("provider-name")) {
  if (payload && typeof payload === "object" && "messages" in payload) {
    const messages = payloadObj.messages;
    
    for (const msg of messages) {
      // 转换逻辑
      if (needsConversion(msg)) {
        convertFormat(msg);
      }
    }
  }
}
```

**关键点**：
- 只影响特定 provider
- 在发送前转换（出站修复）
- 转换所有历史消息
- 保留 thought_signature

### 步骤 6：验证修复

**验证清单**：
- [ ] 构建成功：`pnpm build`
- [ ] dist 文件包含转换逻辑
- [ ] seq=1 成功
- [ ] seq=2 成功（历史消息被转换）
- [ ] seq=3 成功（多轮对话）
- [ ] 其他 provider 不受影响

---

## 实战案例

### 案例 1：yinli provider - thought_signature 位置差异

**问题**：yinli 不接受 `functionCall` 内部的 `thought_signature`

**解决**：在发送前移除内部的 `thought_signature`，只保留顶层的

**详见**：`.kiro/lessons-learned/57_Provider字段位置差异处理方法论.md`

### 案例 2：vectorengine provider - OpenAI vs Gemini 格式

**问题**：vectorengine 期望 Gemini 格式，但我们发送的是 OpenAI 格式

**解决**：在发送前转换 `tool_calls` 为 `content.functionCall`

**详见**：`Runtimelog/tempfile/vectorengine_格式转换修复完成_20260203.md`

---

## 预防措施

### 1. 新 provider 接入时

**检查清单**：
- [ ] 测试至少 3 轮对话
- [ ] 对比官方 API 和中转 API 的 payload
- [ ] 检查历史消息格式
- [ ] 检查工具调用格式
- [ ] 检查签名字段位置

### 2. 添加格式验证

**在 payload 构建后添加验证**：
```typescript
// 验证 payload 格式
function validatePayloadFormat(payload: unknown, provider: string): boolean {
  // 检查必需字段
  // 检查格式兼容性
  // 记录警告
  return true;
}
```

### 3. 添加格式转换日志

**记录所有格式转换**：
```typescript
log.info(`[format] Converted ${count} tool_calls to Gemini functionCall format`);
log.info(`[format] Converted tool message to Gemini functionResponse format`);
```

---

## 关键教训

1. **不要假设所有 `openai-completions` API 都接受相同的格式**
   - 中转 API 可能有自己的格式要求
   - 需要根据 provider 动态调整

2. **第一次成功不代表后续会成功**
   - 历史消息格式可能不对
   - 至少测试 3 轮对话

3. **错误信息可能不准确**
   - API 报错 "missing field X"，实际问题可能是整个格式不对
   - 需要对比完整 payload

4. **格式转换应该在发送前进行**
   - 不要在保存时转换（会影响其他 provider）
   - 在发送前根据 provider 动态转换

5. **保留所有签名字段**
   - 转换格式时，不要丢失 `thought_signature`
   - 确保签名字段在正确的位置

---

## 相关文档

- `.kiro/steering/agent-development-validation.md`（数据验证核心原则）
- `.kiro/lessons-learned/56_中转API兼容性调试方法论.md`（中转 API 兼容性）
- `.kiro/lessons-learned/57_Provider字段位置差异处理方法论.md`（字段位置差异）
- `.kiro/lessons-learned/32_数据流断点调试方法论.md`（数据流调试）

---

**版本**：v20260203_1  
**关键词**：API 格式兼容性、中转 API、格式转换、历史消息、OpenAI 格式、Gemini 格式、tool_calls、functionCall、逐层对比、payload 验证
