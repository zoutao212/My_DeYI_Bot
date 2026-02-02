# LLM 行为异常调试标准流程

**日期**：2026-02-02  
**适用场景**：LLM 行为不符合预期（应该调用工具，但返回文本；应该返回 JSON，但返回纯文本等）

---

## 问题识别

### 典型症状
- 模型应该使用 function calling，但返回了文本模拟
- 模型应该返回 JSON，但返回了纯文本
- 模型应该遵循指令，但完全忽略了
- 模型行为在不同环境下不一致

### 判断标准
**如果满足以下任一条件，说明是 LLM 行为异常：**
- 直接 API 测试成功，但集成到系统后失败
- 相同的指令，不同的上下文产生不同的结果
- 模型行为与系统提示词的指令不一致

---

## 标准调试流程

### 第一步：隔离变量 - 最小化测试

**目的**：排除系统复杂性，直接测试 API

#### 1.1 创建最小化 payload

**原则**：
- 只包含必要的字段
- 系统提示词尽可能简短（< 1KB）
- 用户消息尽可能简单
- 工具定义只包含必要的参数

**示例（Gemini API）**：
```json
{
  "model": "gemini-3-flash-preview",
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "写入 hello 到 test.txt"}]
    }
  ],
  "systemInstruction": {
    "parts": [{
      "text": "你是一个助手。当需要写入文件时，使用 write 工具。不要在文本中模拟工具调用，必须使用真正的 function call。"
    }]
  },
  "tools": [{
    "functionDeclarations": [{
      "name": "write",
      "description": "Write content to file",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {"type": "string"},
          "content": {"type": "string"}
        },
        "required": ["path", "content"]
      }
    }]
  }]
}
```

#### 1.2 直接调用 API

**PowerShell 示例**：
```powershell
$payload = Get-Content "test-payload.json" -Raw -Encoding UTF8
$response = Invoke-RestMethod -Uri "https://api.example.com/v1/chat" `
  -Method Post `
  -Headers @{"Authorization"="Bearer $env:API_KEY"} `
  -Body $payload `
  -ContentType "application/json"

$response | ConvertTo-Json -Depth 10 | Out-File "test-response.json"
```

#### 1.3 验证结果

**检查点**：
- ✅ API 是否返回了预期的结构（如 functionCall）？
- ✅ 是否有错误信息？
- ✅ 响应格式是否正确？

---

### 第二步：对比测试 - 找出差异

**目的**：找出最小化测试和实际系统之间的差异

#### 2.1 提取实际系统的 payload

**方法 1：从日志中提取**
```powershell
# 查找 LLM 请求日志
Get-Content "C:\Users\zouta\.clawdbot\runtimelog\*.jsonl" -Encoding UTF8 | 
  Select-String "llm.payload" | 
  Select-Object -Last 1 | 
  ForEach-Object { 
    $_ | ConvertFrom-Json | 
    Select-Object -ExpandProperty payload | 
    ConvertTo-Json -Depth 20 | 
    Out-File "actual-payload.json"
  }
```

**方法 2：添加日志输出**
在代码中添加：
```typescript
log.info(`[debug] Full payload: ${JSON.stringify(payload, null, 2).slice(0, 5000)}`);
```

#### 2.2 逐层对比

**对比清单**：
- [ ] **model**：模型名称是否一致？
- [ ] **systemInstruction**：系统提示词大小差异？
- [ ] **contents**：用户消息是否一致？
- [ ] **tools**：工具定义是否一致？
- [ ] **其他字段**：是否有额外的字段？

**PowerShell 对比脚本**：
```powershell
$minimal = Get-Content "test-payload.json" | ConvertFrom-Json
$actual = Get-Content "actual-payload.json" | ConvertFrom-Json

Write-Host "=== 系统提示词大小对比 ==="
Write-Host "最小化: $($minimal.systemInstruction.parts[0].text.Length) 字节"
Write-Host "实际: $($actual.systemInstruction.parts[0].text.Length) 字节"

Write-Host "`n=== 工具数量对比 ==="
Write-Host "最小化: $($minimal.tools[0].functionDeclarations.Count) 个"
Write-Host "实际: $($actual.tools[0].functionDeclarations.Count) 个"

Write-Host "`n=== 用户消息对比 ==="
Write-Host "最小化: $($minimal.contents[0].parts[0].text)"
Write-Host "实际: $($actual.contents[0].parts[0].text)"
```

#### 2.3 识别关键差异

**常见差异点**：
1. **系统提示词过长**（最常见）
   - 最小化：< 1KB
   - 实际：> 20KB
   - **影响**：模型"迷失"，不知道应该做什么

2. **工具定义过多**
   - 最小化：1-3 个工具
   - 实际：20+ 个工具
   - **影响**：模型难以选择正确的工具

3. **用户消息格式问题**
   - 最小化：简单自然语言
   - 实际：包含误导性格式（如 JSON 块）
   - **影响**：模型模仿格式而不是调用工具

4. **历史消息干扰**
   - 最小化：无历史消息
   - 实际：包含大量历史消息
   - **影响**：模型受历史行为影响

---

### 第三步：添加调试日志 - 记录关键数据

**目的**：记录 API 返回的原始数据和关键处理步骤

#### 3.1 记录 API 响应

**位置**：`src/agents/session-tool-result-guard.ts`

```typescript
const guardedAppend = (message: AgentMessage) => {
  const role = (message as { role?: unknown }).role;

  if (role === "assistant") {
    const msg = message as Extract<AgentMessage, { role: "assistant" }>;
    
    // 🆕 DEBUG: 记录完整消息结构
    log.info(`[guard] [DEBUG] Full assistant message: ${JSON.stringify(msg, null, 2).slice(0, 2000)}`);
    
    // 🆕 DEBUG: 记录 content 类型
    const contentType = msg.content === null ? "null" : 
                       msg.content === undefined ? "undefined" : 
                       Array.isArray(msg.content) ? `array(${msg.content.length})` : 
                       typeof msg.content;
    log.info(`[guard] Content type: ${contentType}`);
    
    // 🆕 DEBUG: 如果是数组，记录每个元素的类型
    if (Array.isArray(msg.content)) {
      msg.content.forEach((block, i) => {
        const blockType = block && typeof block === "object" ? (block as any).type : typeof block;
        log.info(`[guard] Content[${i}] type: ${blockType}`);
      });
    }
  }
  
  // ... 其他处理
};
```

#### 3.2 记录关键处理步骤

**位置**：关键处理函数

```typescript
// 记录 payload 构建
log.info(`[payload] System prompt size: ${systemPrompt.length} bytes`);
log.info(`[payload] Tools count: ${tools.length}`);
log.info(`[payload] Messages count: ${messages.length}`);

// 记录 API 调用
log.info(`[llm] → Request: model=${model} provider=${provider}`);

// 记录 API 响应
log.info(`[llm] ← Response: ok=${ok} duration=${duration}ms`);
```

#### 3.3 查看日志

**PowerShell 命令**：
```powershell
# 查看最新日志
Get-Content "C:\Users\zouta\.clawdbot\runtimelog\*.jsonl" -Tail 100 -Encoding UTF8 | 
  Select-String "DEBUG|guard|llm" | 
  ForEach-Object { $_ }

# 搜索特定关键词
Get-Content "C:\Users\zouta\.clawdbot\runtimelog\*.jsonl" -Encoding UTF8 | 
  Select-String "functionCall|toolCall" -Context 3,3
```

---

### 第四步：逐步排查 - 验证假设

**目的**：根据差异点，逐个验证假设

#### 4.1 假设：系统提示词过长

**验证方法**：
1. 精简系统提示词到 < 10KB
2. 重新测试
3. 对比结果

**如果问题解决**：
- 确认是系统提示词过长导致
- 参考 `.kiro/lessons-learned/51_系统提示词过长导致模型行为异常.md`

#### 4.2 假设：工具定义过多

**验证方法**：
1. 只保留必要的工具（1-3 个）
2. 重新测试
3. 对比结果

**如果问题解决**：
- 确认是工具定义过多导致
- 考虑动态加载工具

#### 4.3 假设：用户消息格式问题

**验证方法**：
1. 使用简单自然语言
2. 避免包含 JSON 块或类似工具调用的格式
3. 重新测试

**如果问题解决**：
- 确认是用户消息格式导致
- 引导用户使用正确格式

#### 4.4 假设：历史消息干扰

**验证方法**：
1. 清空历史消息
2. 重新测试
3. 对比结果

**如果问题解决**：
- 确认是历史消息干扰
- 考虑限制历史消息数量或清理历史消息

---

### 第五步：修复并验证

**目的**：应用修复方案并验证效果

#### 5.1 应用修复

根据第四步的验证结果，应用对应的修复方案。

#### 5.2 验证修复

**验证清单**：
- [ ] 最小化测试通过
- [ ] 实际系统测试通过
- [ ] 日志显示正确的行为
- [ ] 没有引入新的问题

#### 5.3 回归测试

**测试场景**：
1. 简单指令（如"写入 hello 到 test.txt"）
2. 复杂指令（如"读取 file1.txt，处理后写入 file2.txt"）
3. 多轮对话
4. 错误处理

---

## 常见问题模式

### 模式 1：系统提示词过长

**症状**：
- 直接 API 测试成功
- 实际系统测试失败
- 系统提示词 > 20KB

**解决**：
- 精简系统提示词到 < 10KB
- 移除冗余描述
- 移除详细示例

**参考**：`.kiro/lessons-learned/51_系统提示词过长导致模型行为异常.md`

### 模式 2：工具定义过多

**症状**：
- 模型选择了错误的工具
- 模型不知道应该调用哪个工具
- 工具数量 > 20

**解决**：
- 动态加载工具
- 只提供当前场景需要的工具
- 优化工具描述

### 模式 3：用户消息格式误导

**症状**：
- 用户消息包含 JSON 块或类似工具调用的格式
- 模型模仿格式而不是调用工具

**解决**：
- 引导用户使用简单自然语言
- 在 UI 中添加提示
- 在文档中说明正确用法

**参考**：`.kiro/lessons-learned/40_LLM角色扮演与工具调用的区分.md`

### 模式 4：历史消息干扰

**症状**：
- 新会话正常
- 多轮对话后行为异常
- 历史消息数量 > 50

**解决**：
- 限制历史消息数量
- 定期清理历史消息
- 使用会话摘要

---

## 调试工具箱

### PowerShell 脚本

#### 提取 payload
```powershell
function Extract-LLMPayload {
    param([string]$LogFile, [string]$OutputFile)
    
    Get-Content $LogFile -Encoding UTF8 | 
      Select-String "llm.payload" | 
      Select-Object -Last 1 | 
      ForEach-Object { 
        $_ | ConvertFrom-Json | 
        Select-Object -ExpandProperty payload | 
        ConvertTo-Json -Depth 20 | 
        Out-File $OutputFile
      }
}
```

#### 对比 payload
```powershell
function Compare-Payloads {
    param([string]$File1, [string]$File2)
    
    $p1 = Get-Content $File1 | ConvertFrom-Json
    $p2 = Get-Content $File2 | ConvertFrom-Json
    
    Write-Host "=== 系统提示词大小 ==="
    Write-Host "File1: $($p1.systemInstruction.parts[0].text.Length) bytes"
    Write-Host "File2: $($p2.systemInstruction.parts[0].text.Length) bytes"
    
    Write-Host "`n=== 工具数量 ==="
    Write-Host "File1: $($p1.tools[0].functionDeclarations.Count)"
    Write-Host "File2: $($p2.tools[0].functionDeclarations.Count)"
}
```

#### 查看日志
```powershell
function Show-LLMLogs {
    param([string]$LogDir, [string]$Pattern)
    
    Get-ChildItem $LogDir -Filter "*.jsonl" | 
      Sort-Object LastWriteTime -Descending | 
      Select-Object -First 1 | 
      ForEach-Object {
        Get-Content $_.FullName -Tail 100 -Encoding UTF8 | 
          Select-String $Pattern
      }
}
```

### 测试模板

#### 最小化 payload 模板
```json
{
  "model": "model-name",
  "contents": [
    {"role": "user", "parts": [{"text": "simple instruction"}]}
  ],
  "systemInstruction": {
    "parts": [{"text": "You are an assistant. Use tools when needed."}]
  },
  "tools": [{
    "functionDeclarations": [{
      "name": "tool_name",
      "description": "Tool description",
      "parameters": {
        "type": "object",
        "properties": {},
        "required": []
      }
    }]
  }]
}
```

---

## 关键教训

### 1. 最小化测试是定位问题的最快方法
- 用最简单的 payload 测试 API
- 逐步添加复杂度，找出问题点
- 不要一开始就测试完整系统

### 2. 对比测试是验证假设的关键
- 直接 API 测试 vs 实际系统测试
- 找出差异点，验证假设
- 逐个排查差异点

### 3. 添加调试日志比盲目猜测更有效
- 记录 API 返回的原始数据结构
- 记录关键处理步骤
- 不要相信"应该是这样"

### 4. 系统提示词不是越详细越好
- 过长的系统提示词会导致模型"迷失"
- 保持简洁，只包含核心指令
- 移除冗余描述和详细示例

### 5. 用户消息格式很重要
- 避免在消息中包含类似工具调用的格式
- 使用简单自然语言
- 引导用户使用正确格式

---

## 相关文档

- `.kiro/lessons-learned/51_系统提示词过长导致模型行为异常.md` - 系统提示词问题
- `.kiro/lessons-learned/40_LLM角色扮演与工具调用的区分.md` - 用户理解问题
- `.kiro/lessons-learned/50_工具调用验证与重试机制.md` - 工具调用验证
- `.kiro/lessons-learned/38_API_Payload格式错误调试方法论.md` - Payload 格式问题

---

**版本：** v20260202_1  
**最后更新：** 2026-02-02  
**变更：** 新增"LLM 行为异常调试标准流程"
