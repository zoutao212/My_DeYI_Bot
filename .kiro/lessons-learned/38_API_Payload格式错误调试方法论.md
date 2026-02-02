# API Payload 格式错误调试方法论

**触发场景**：API 返回格式错误（如 "Request contains an invalid argument"），但错误信息不明确

**核心价值**：系统化的调试流程，避免盲目尝试，快速定位真正的格式问题

---

## 问题识别

### 典型症状

1. **API 返回错误**：
   - "Request contains an invalid argument"
   - "Invalid request format"
   - "Unexpected field in request"

2. **错误信息不准确**：
   - 错误信息指向的字段不是真正的问题
   - 错误信息太笼统，无法定位具体问题

3. **修复无效**：
   - 按照错误信息修复后，问题仍然存在
   - 修复了一个问题，又出现新的问题

### 为什么会反复发生

1. **依赖库生成的格式可能不符合 API 规范**
2. **API 错误信息可能不准确**
3. **Payload 结构复杂，难以手动检查**
4. **修复不彻底，遗漏相似的代码**

---

## 标准调试流程（5 步法）

### 第一步：提取成功和失败的 Payload

**目的**：找到真正的差异

**操作**：
```powershell
# 1. 找到最新的日志文件
$logFile = Get-ChildItem "C:\Users\zouta\.clawdbot\runtimelog" -Filter "trace__*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

# 2. 提取所有 llm.payload 事件
$trace = Get-Content $logFile.FullName -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }

# 3. 保存成功和失败的 payload
$payloads[0].payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload_success.json"
$payloads[1].payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload_failure.json"
```

**关键点**：
- 必须提取**完整的 payload**（不要只看部分）
- 必须提取**成功和失败的对比**（不要只看失败的）

### 第二步：逐层对比差异

**目的**：找出所有不同的字段

**操作**：
```powershell
# 1. 加载两个 payload
$p1 = Get-Content "payload_success.json" | ConvertFrom-Json
$p2 = Get-Content "payload_failure.json" | ConvertFrom-Json

# 2. 对比顶层字段
Write-Host "=== 顶层字段对比 ==="
$p1.PSObject.Properties.Name | ForEach-Object {
    $key = $_
    if ($p2.PSObject.Properties.Name -notcontains $key) {
        Write-Host "⚠️ p2 缺少字段: $key"
    }
}
$p2.PSObject.Properties.Name | ForEach-Object {
    $key = $_
    if ($p1.PSObject.Properties.Name -notcontains $key) {
        Write-Host "⚠️ p2 多了字段: $key"
    }
}

# 3. 对比 messages 数量
Write-Host "=== messages 数量对比 ==="
Write-Host "p1: $($p1.messages.Count) messages"
Write-Host "p2: $($p2.messages.Count) messages"

# 4. 对比每条消息
for ($i = 0; $i -lt [Math]::Max($p1.messages.Count, $p2.messages.Count); $i++) {
    Write-Host "=== message[$i] 对比 ==="
    
    if ($i -ge $p1.messages.Count) {
        Write-Host "⚠️ p1 没有 message[$i]"
        continue
    }
    if ($i -ge $p2.messages.Count) {
        Write-Host "⚠️ p2 没有 message[$i]"
        continue
    }
    
    $m1 = $p1.messages[$i]
    $m2 = $p2.messages[$i]
    
    # 对比 role
    if ($m1.role -ne $m2.role) {
        Write-Host "⚠️ role 不同: $($m1.role) vs $($m2.role)"
    }
    
    # 对比 content
    if ($m1.content -eq $null -and $m2.content -ne $null) {
        Write-Host "⚠️ p1.content 是 null, p2.content 不是 null"
    }
    if ($m1.content -ne $null -and $m2.content -eq $null) {
        Write-Host "⚠️ p2.content 是 null, p1.content 不是 null"
    }
    
    # 对比字段
    $m1.PSObject.Properties.Name | ForEach-Object {
        $key = $_
        if ($m2.PSObject.Properties.Name -notcontains $key) {
            Write-Host "⚠️ p2.messages[$i] 缺少字段: $key"
        }
    }
    $m2.PSObject.Properties.Name | ForEach-Object {
        $key = $_
        if ($m1.PSObject.Properties.Name -notcontains $key) {
            Write-Host "⚠️ p2.messages[$i] 多了字段: $key"
        }
    }
}
```

**关键点**：
- 逐层对比（顶层 → messages → parts → nested objects）
- 重点检查：`content: null`、多余字段、缺失字段
- 记录所有差异，不要只看第一个

### 第三步：查阅 API 规范

**目的**：确认哪些字段是符合规范的，哪些不是

**操作**：
1. 打开 API 文档（例如：Gemini API 文档）
2. 查找 payload 格式规范
3. 对比实际 payload 和规范

**关键点**：
- 不要相信错误信息，要自己验证
- 重点检查：字段位置、字段类型、字段名称
- 注意：有些字段应该在顶层，有些应该在嵌套对象中

### 第四步：列出修复清单

**目的**：确保修复彻底，不遗漏任何位置

**操作**：
```markdown
## 修复清单

### 问题 1：functionCall 的 thoughtSignature
- [ ] 位置 1：functionCall 对象本身（不应该有）
- [ ] 位置 2：包含 functionCall 的 part wrapper（应该有）

### 问题 2：functionResponse 的 thoughtSignature
- [ ] 位置 1：functionResponse 对象本身（不应该有）
- [ ] 位置 2：包含 functionResponse 的 part wrapper（应该有）

### 问题 3：config 字段格式错误
- [ ] 检测 config 字段
- [ ] 展开 config.systemInstruction 到顶层
- [ ] 展开 config.tools 到顶层
- [ ] 展开 config.maxOutputTokens 到 generationConfig.maxOutputTokens
- [ ] 删除 config 字段
```

**关键点**：
- 搜索所有相关代码（不要只修复看到的）
- 明确列出所有需要修复的位置
- 逐一验证每个位置

### 第五步：逐一修复并验证

**目的**：确保每个修复都生效

**操作**：
1. **修复代码**：按照修复清单逐一修复
2. **构建验证**：`pnpm build`
3. **代码验证**：用 PowerShell 确认 dist 文件包含修复
4. **功能验证**：重启 Gateway，发送测试消息

**关键点**：
- 每修复一个位置，就验证一次
- 不要一次性修复所有位置后再验证
- 如果验证失败，立即回滚并重新分析

---

## 修复策略

### 优先级 1：在发送前拦截并修复（最佳）

**位置**：`src/agents/gemini-payload-thought-signature.ts` 的 `nextOnPayload` 函数

**优点**：
- 从根本上解决问题
- 不依赖依赖库的修复
- 可以添加详细的日志

**示例**：
```typescript
const nextOnPayload = (payload: unknown) => {
  // Fix 1: Flatten config field to top level
  if (payload && typeof payload === "object" && "config" in payload) {
    // 展开 config 字段到顶层
    // 删除 config 字段
  }
  
  // Fix 2: Add thought_signature to parts
  // ...
};
```

### 优先级 2：修改依赖库（不推荐）

**不推荐原因**：
- 依赖库可能被更新覆盖
- 难以维护
- 可能影响其他功能

---

## 常见错误模式

### 错误 1：只修复表面症状

**问题**：
- 只修复了 `functionCall`，没有修复 `functionResponse`
- 只修复了 `thought_signature`，没有修复 `config` 字段

**解决**：
- 搜索所有相关代码
- 列出修复清单
- 逐一修复

### 错误 2：相信 API 的错误信息

**问题**：
- API 说 "thought_signature is not valid"，但真正的问题是 `content: null`
- API 说 "invalid argument"，但真正的问题是 `config` 字段

**解决**：
- 不要相信错误信息
- 必须通过 payload 对比找到真正的差异

### 错误 3：修复后不验证

**问题**：
- 修改了代码，但没有验证是否生效
- 构建成功，但 dist 文件没有包含修复

**解决**：
- 每次修复后都要验证
- 用 PowerShell 确认 dist 文件包含修复
- 重启 Gateway 并测试

---

## 质量门槛

每次修复后必须满足：

- ✅ **提取了成功和失败的 payload**
- ✅ **逐层对比了所有差异**
- ✅ **查阅了 API 规范**
- ✅ **列出了修复清单**
- ✅ **逐一修复并验证**
- ✅ **构建成功**
- ✅ **dist 文件包含修复**
- ✅ **功能验证通过**

---

## 实战案例

### 案例 1：functionCall 的 thoughtSignature 问题

**问题**：API 返回 "Request contains an invalid argument"

**调试过程**：
1. 提取 payload → 发现 `functionCall` 对象本身有 `thoughtSignature`
2. 查阅 API 规范 → 确认 `functionCall` 对象不应该有这个字段
3. 列出修复清单 → `functionCall` 和 `function_call`
4. 修复代码 → 只给 part wrapper 添加 `thoughtSignature`
5. 验证 → 构建成功，dist 文件包含修复

### 案例 2：functionResponse 的 thoughtSignature 问题

**问题**：修复了 `functionCall` 后，问题仍然存在

**调试过程**：
1. 提取 payload → 发现 `functionResponse` 对象本身也有 `thoughtSignature`
2. 查阅 API 规范 → 确认 `functionResponse` 对象也不应该有这个字段
3. 列出修复清单 → `functionResponse` 和 `function_response`
4. 修复代码 → 补充修复 `functionResponse`
5. 验证 → 构建成功，dist 文件包含修复

**教训**：修复不彻底比不修复更危险

### 案例 3：config 字段格式错误

**问题**：修复了 `thoughtSignature` 后，问题仍然存在

**调试过程**：
1. 提取 payload → 发现有一个 `config` 字段
2. 查阅 API 规范 → 确认 Gemini API 不认识 `config` 字段
3. 列出修复清单 → 展开 `config` 字段到顶层
4. 修复代码 → 在 `nextOnPayload` 中添加修复逻辑
5. 验证 → 构建成功，dist 文件包含修复

**教训**：依赖库生成的格式可能不符合 API 规范

---

## 最佳实践

### 1. 不要推脱外部错误

**原则**：永远假设问题在我们这边，直到证明不是

**做法**：
- 先验证我们发送的数据格式是否正确
- 对比成功和失败的请求
- 不要相信 API 的错误信息

### 2. 修复要彻底

**原则**：搜索所有相关代码，不要遗漏任何位置

**做法**：
- 用 `grep` 搜索所有相关的字段
- 列出修复清单
- 逐一修复并验证

### 3. 分层修复

**原则**：从明显问题到深层问题，逐层修复

**做法**：
- 第一层：修复明显问题
- 第二层：修复遗漏问题
- 第三层：修复深层问题

### 4. 添加详细日志

**原则**：所有修复都要添加日志，便于调试

**做法**：
- 警告日志：发现问题
- 信息日志：修复过程
- 成功日志：修复完成

---

## 工具脚本

### 提取 Payload 脚本

```powershell
# extract-payload.ps1
param(
    [string]$LogDir = "C:\Users\zouta\.clawdbot\runtimelog",
    [string]$OutputDir = "."
)

# 找到最新的日志文件
$logFile = Get-ChildItem $LogDir -Filter "trace__*.jsonl" | 
    Sort-Object LastWriteTime -Descending | 
    Select-Object -First 1

Write-Host "使用日志文件: $($logFile.Name)"

# 提取所有 llm.payload 事件
$trace = Get-Content $logFile.FullName -Encoding UTF8 | ConvertFrom-Json
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }

Write-Host "找到 $($payloads.Count) 个 payload"

# 保存每个 payload
for ($i = 0; $i -lt $payloads.Count; $i++) {
    $outputFile = Join-Path $OutputDir "payload_$i.json"
    $payloads[$i].payload.payload | ConvertTo-Json -Depth 20 | Out-File $outputFile
    Write-Host "保存到: $outputFile"
}
```

### 对比 Payload 脚本

```powershell
# compare-payload.ps1
param(
    [string]$File1 = "payload_0.json",
    [string]$File2 = "payload_1.json"
)

$p1 = Get-Content $File1 | ConvertFrom-Json
$p2 = Get-Content $File2 | ConvertFrom-Json

Write-Host "=== 顶层字段对比 ==="
# ... (见第二步的完整代码)
```

---

## 总结

API Payload 格式错误调试的核心原则：

1. **不要推脱外部错误** - 先验证我们的数据格式
2. **不要相信错误信息** - 必须通过对比找到真正的差异
3. **修复要彻底** - 搜索所有相关代码，不要遗漏
4. **分层修复** - 从明显问题到深层问题
5. **添加详细日志** - 便于调试和验证

通过这套方法论，可以：
- 快速定位真正的格式问题
- 避免盲目尝试
- 确保修复彻底
- 降低调试时间

---

**版本：** v20260131_1  
**最后更新：** 2026-01-31  
**来源：** API 错误修复三部曲实战（functionCall + functionResponse + config 字段）
