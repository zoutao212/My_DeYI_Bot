# 外部 API 报错调试方法论

## 问题描述

当外部 API 返回错误或警告时，容易误判为本地代码问题，导致：
- 浪费时间修改不需要修改的代码
- 忽略真正的根因（网络连接、API 服务端问题）
- 缺少系统化的调试流程

## 典型场景

- API 返回 "参数缺失" 警告，但本地代码已正确添加参数
- API 返回 "格式错误" 警告，但本地序列化正常
- API 返回 "认证失败" 警告，但本地配置正确

## 根本原因

**本地操作成功 ≠ 远程操作成功**

可能的断点：
1. 本地代码正常，但序列化过程中丢失数据
2. 本地序列化正常，但网络传输失败
3. 网络传输成功，但 API 服务端验证失败

## 系统化调试流程

### 第一步：验证本地代码

**目标**：确认本地代码是否正常工作

**方法**：
1. 读取 trace 日志（`trace__*.jsonl`）
2. 查找相关的事件（如 `patch.*`, `tool.*`）
3. 确认本地操作是否成功

**示例**：
```powershell
# 读取 trace 日志
Get-Content "Runtimelog/log/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json | Where-Object { $_.event -like "patch.*" }
```

**验证点**：
- ✅ 本地 patcher 是否正常工作？
- ✅ 数据是否正确添加？
- ✅ 序列化前的数据是否完整？

---

### 第二步：验证网络传输

**目标**：确认请求是否成功发送到远程 API

**方法**：
1. 读取 runbundle 日志（`runbundle_*.json`）
2. 查找 `connectionErrors` 字段
3. 查找 `llmProgress` 字段

**示例**：
```powershell
# 检查连接错误
Get-Content "Runtimelog/log/runbundle_*.json" -Encoding UTF8 | Select-String -Pattern "connectionErrors"

# 检查请求序列
Get-Content "Runtimelog/log/runbundle_*.json" -Encoding UTF8 | ConvertFrom-Json | Select-Object -ExpandProperty llmProgress
```

**验证点**：
- ✅ 是否有连接错误？
- ✅ 请求是否成功发送？
- ✅ 是否触发了重试机制？

---

### 第三步：验证远程响应

**目标**：确认 API 返回的是什么

**方法**：
1. 读取响应日志（`resmsg_*.log`）
2. 查找 `rawReply` 字段
3. 查找错误信息

**示例**：
```powershell
# 检查原始回复
Get-Content "Runtimelog/log/resmsg_*.log" -Encoding UTF8 | Select-String -Pattern "rawReply"
```

**验证点**：
- ✅ API 返回的是正常响应还是错误响应？
- ✅ 错误信息是什么？
- ✅ 是否包含警告信息？

---

### 第四步：PowerShell 交叉验证

**目标**：用独立工具验证关键证据

**方法**：
1. 用 PowerShell 直接读取日志文件
2. 提取关键字段
3. 确认数据的一致性

**示例**：
```powershell
# 验证连接错误次数
$json = Get-Content "Runtimelog/log/runbundle_*.json" -Encoding UTF8 | ConvertFrom-Json
Write-Host "连接错误次数: $($json.llmProgress.connectionErrors)"

# 验证原始回复
Write-Host "原始回复: $($json.rawReply)"
```

**验证点**：
- ✅ 工具返回的数据是否准确？
- ✅ 是否存在缓存问题？
- ✅ 关键证据是否一致？

---

### 第五步：构建因果链

**目标**：找到根本原因

**方法**：
1. 列出所有验证点的结果
2. 构建完整的因果链
3. 找到断点位置

**示例**：
```
1. 本地 patcher 正常 ✅
   ↓
2. 序列化正常 ✅
   ↓
3. 网络传输失败 ❌ (连接错误)
   ↓
4. API 返回错误响应 ⚠️
   ↓
5. 错误响应中包含警告信息
```

**结论**：根本原因是网络传输失败，不是本地代码问题

---

### 第六步：Payload 对比（当错误信息不可信时）⚠️

**目标**：找到成功和失败请求的真正差异

**触发条件**：
- API 错误信息不清晰或可能不准确
- 本地代码验证正常，但 API 仍然报错
- 需要找到格式差异

**方法**：

#### 1. 提取成功和失败的 payload

```powershell
# 读取 trace 日志
$trace = Get-Content "Runtimelog/log/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json

# 提取所有 llm.payload 事件
$payloads = $trace | Where-Object { $_.event -eq "llm.payload" }

# 保存第一次（成功）和第二次（失败）的 payload
$payloads[0].payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload_success.json" -Encoding UTF8
$payloads[1].payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload_failure.json" -Encoding UTF8
```

#### 2. 逐层对比

```powershell
# 读取两个 payload
$p1 = Get-Content "payload_success.json" -Encoding UTF8 | ConvertFrom-Json
$p2 = Get-Content "payload_failure.json" -Encoding UTF8 | ConvertFrom-Json

# 对比顶层字段
Write-Host "model: $($p1.model) vs $($p2.model)"
Write-Host "messages 数量: $($p1.messages.Count) vs $($p2.messages.Count)"
Write-Host "tools 数量: $($p1.tools.Count) vs $($p2.tools.Count)"

# 对比 tools（如果数量一致）
for ($i = 0; $i -lt $p1.tools.Count; $i++) {
    $t1 = $p1.tools[$i] | ConvertTo-Json -Depth 10 -Compress
    $t2 = $p2.tools[$i] | ConvertTo-Json -Depth 10 -Compress
    if ($t1 -eq $t2) {
        Write-Host "tool[$i]: 一致 ✓"
    } else {
        Write-Host "tool[$i]: 不一致 ✗"
    }
}

# 对比 messages（逐条检查）
for ($i = 0; $i -lt [Math]::Max($p1.messages.Count, $p2.messages.Count); $i++) {
    if ($i -lt $p1.messages.Count -and $i -lt $p2.messages.Count) {
        Write-Host "message[$i] role: $($p1.messages[$i].role) vs $($p2.messages[$i].role)"
        
        # 检查 content 是否为 null
        if ($p1.messages[$i].content -eq $null) {
            Write-Host "  ⚠️ 第一次的 content 是 null"
        }
        if ($p2.messages[$i].content -eq $null) {
            Write-Host "  ⚠️ 第二次的 content 是 null"
        }
    } elseif ($i -ge $p1.messages.Count) {
        Write-Host "message[$i]: 第二次多出来的消息 (role: $($p2.messages[$i].role))"
    } else {
        Write-Host "message[$i]: 第一次多出来的消息 (role: $($p1.messages[$i].role))"
    }
}
```

#### 3. 重点检查

- **messages 数量差异**：第二次请求是否包含了第一次的对话历史？
- **content: null**：assistant 消息的 content 是否为 null？
- **字段缺失**：是否有必需字段缺失？
- **格式错误**：是否有字段类型不符合 API 规范？

**验证点**：
- ✅ 找到具体的格式差异
- ✅ 确认差异是否违反 API 规范
- ✅ 验证修复方向是否正确

---

## 常见误判

### 误判 1：完全相信 API 的错误信息 ⚠️ **最重要！**

**错误做法**：
- API 返回 "thought_signature 缺失" 警告
- 立即检查 patcher 代码
- 花大量时间验证 thought_signature 是否正确添加
- 但实际上 patcher 完全正常

**实际问题**：
- 真正的问题是 `content: null`（格式错误）
- API 的错误信息不准确，指向了错误的字段
- 错误信息指向"症状"而非"根因"

**正确做法**：
- **不要完全相信 API 的错误信息**
- 通过 payload 对比找到真正的差异
- 对比成功和失败的请求，找出格式差异
- 验证差异是否违反 API 规范

**教训**：
- API 错误信息可能不准确
- 格式错误可能导致 API 验证失败，但错误信息指向错误的字段
- 必须通过日志对比找到真正的差异

---

### 误判 2：看到警告就改代码

**错误做法**：
- API 返回 "参数缺失" 警告
- 立即修改本地代码添加参数
- 但实际上本地代码已经正确添加了参数

**正确做法**：
- 先验证本地代码是否正常
- 再验证网络传输是否成功
- 最后确认是否是 API 服务端问题

---

### 误判 3：只看工具返回值

**错误做法**：
- 工具显示 "成功添加 10 个参数"
- 认为问题已解决
- 但实际上网络传输失败，参数未发送到 API

**正确做法**：
- 不要只相信工具返回值
- 用 PowerShell 交叉验证
- 验证整个链路（本地 → 网络 → 远程）

---

### 误判 4：忽略连接错误

**错误做法**：
- 看到 "连接错误" 但认为是偶然问题
- 继续调试本地代码
- 浪费大量时间

**正确做法**：
- 连接错误是根本原因的强信号
- 优先解决网络问题
- 不要在网络不通的情况下调试代码

---

## 关键要点

1. **本地成功 ≠ 远程成功**：必须验证整个链路
2. **不要只看表面错误**：深入日志找根因
3. **用 PowerShell 交叉验证**：不要盲目相信工具返回值
4. **构建完整因果链**：找到真正的断点
5. **优先解决网络问题**：连接错误是最常见的根因
6. ⚠️ **不要完全相信 API 错误信息**：错误信息可能不准确，需要通过 payload 对比找到真正的差异
7. **Payload 对比是终极武器**：当其他方法都无法定位问题时，对比成功和失败的 payload

---

## 日志文件速查

| 日志类型 | 文件名模式 | 包含信息 |
|----------|-----------|----------|
| Trace 日志 | `trace__*.jsonl` | 事件级别的详细信息（patcher 扫描、工具调用） |
| 运行记录 | `runbundle_*.json` | 运行摘要（连接错误统计、LLM 请求序列） |
| 发送消息 | `sendmsg_*.log` | 发送的消息内容 |
| 响应消息 | `resmsg_*.log` | 最终回复和原始回复 |
| 会话日志 | `*.jsonl` | 时间线视图（重试过程、错误序列） |

---

## 实战案例

### 案例 1：thought_signature 警告（连接错误）

**问题**：vectorengine API 返回 "thought_signature 缺失" 警告

**调试过程**：

1. **验证本地代码**：
   - 读取 trace 日志
   - 发现 patcher 成功添加了 10 个 `thought_signature`
   - 结论：✅ 本地代码正常

2. **验证网络传输**：
   - 读取 runbundle 日志
   - 发现 `connectionErrors: 4`
   - 结论：❌ 网络传输失败

3. **验证远程响应**：
   - 读取响应日志
   - 发现 `rawReply: "Connection error."`
   - 结论：⚠️ API 返回连接错误

4. **PowerShell 交叉验证**：
   ```powershell
   Get-Content "runbundle_*.json" | Select-String "connectionErrors"
   # 输出: "connectionErrors": 4
   ```
   - 结论：✅ 确认 4 次连接错误

5. **构建因果链**：
   ```
   本地 patcher 添加 thought_signature ✅
     ↓
   发送请求到 vectorengine API
     ↓
   连接错误 ❌ (4 次)
     ↓
   API 返回错误响应
     ↓
   错误响应中包含 thought_signature 警告 ⚠️
   ```

**根本原因**：连接错误导致请求失败，API 在错误响应中返回了警告

**修复方向**：解决网络连接问题，不是修改 patcher 代码

---

### 案例 2：thought_signature 警告（格式错误）⚠️ **重要案例**

**问题**：vectorengine API 返回 "thought_signature 缺失" 警告，但连接正常

**初步调试**：

1. **验证本地代码**：
   - 读取 trace 日志
   - 发现 patcher 成功添加了 10 个 `thought_signature`
   - 结论：✅ 本地代码正常

2. **验证网络传输**：
   - 读取 runbundle 日志
   - 发现 `connectionErrors: 4`
   - 初步结论：❌ 网络传输失败

3. **用户纠正**：
   - 用户指出：不是连接问题，是第二次请求的格式有问题
   - 需要对比第一次（成功）和第二次（失败）的 payload

**深入调试（Payload 对比）**：

4. **提取 payload**：
   ```powershell
   $trace = Get-Content "trace.jsonl" | ConvertFrom-Json
   $payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
   $payloads[0].payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload1.json"
   $payloads[1].payload.payload | ConvertTo-Json -Depth 20 | Out-File "payload2.json"
   ```

5. **对比顶层字段**：
   ```powershell
   $p1 = Get-Content "payload1.json" | ConvertFrom-Json
   $p2 = Get-Content "payload2.json" | ConvertFrom-Json
   Write-Host "messages 数量: $($p1.messages.Count) vs $($p2.messages.Count)"
   # 输出: messages 数量: 2 vs 4
   ```
   - 发现：第二次请求多了 2 条消息

6. **对比 messages**：
   ```powershell
   # 检查第二次请求的 message[2]
   $p2.messages[2] | ConvertTo-Json -Depth 5
   ```
   - 发现：message[2] 的 `content` 是 `null`

7. **确认根本问题**：
   ```json
   {
     "role": "assistant",
     "content": null,  // ❌ 这里是 null！
     "tool_calls": [...]
   }
   ```

**根本原因**：
- 第二次请求的 assistant 消息的 `content` 是 `null`
- 这违反了 OpenAI API 规范（应该是空字符串 `""`）
- vectorengine API 拒绝了格式错误的请求
- **但 API 返回的错误信息是 "thought_signature 缺失"，而不是 "content 不能为 null"**

**修复方向**：
- 将 assistant 消息的 `content: null` 替换为 `content: ""`
- 不是修改 patcher 代码（patcher 完全正常）

**教训**：
- ⚠️ **API 错误信息可能不准确**
- 必须通过 payload 对比找到真正的差异
- 不要完全相信 API 的错误信息

---

### 案例 3：敏感词拦截导致空响应 ⚠️ **新增案例**

**问题**：系统突然无法响应，日志显示 `content=array(0)`（空数组）

**现象**：
```
05:35:39 [agent/guard] [guard] appendMessage called: role=assistant, content=array(0)
```

**调试过程**：

1. **检查 trace 日志**：
   ```powershell
   Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Encoding UTF8 -Tail 50
   ```
   - 发现：LLM 请求成功（`ok durationMs=1481`）
   - 但响应中包含错误：
     ```json
     {
       "error": {
         "message": "sensitive words detected (request id: ...)",
         "type": "new_api_error",
         "code": "local:sensitive_words"
       }
     }
     ```

2. **分析根本原因**：
   - 用户发送的消息包含敏感词（色情内容）
   - new_api（中转 API）检测到敏感词，拒绝请求
   - Gemini API 返回错误，content 为空数组
   - 系统保存了空 content 的 assistant 消息
   - 导致后续对话无法继续

3. **验证是否是系统 Bug**：
   - ❌ 不是系统 Bug
   - ✅ 是 new_api 的内容审核机制
   - ✅ 是用户发送的内容违反了中转 API 的规则

**根本原因**：
- 中转 API（new_api）有内容审核机制
- 用户消息包含敏感词，被拦截
- API 返回错误，content 为空
- 这不是系统 Bug，是内容审核的正常行为

**解决方案**：
1. **切换到官方 API**（推荐）- 没有敏感词过滤
2. **使用其他中转 API** - 找一个没有内容审核的
3. **避免发送敏感内容** - 如果必须使用 new_api
4. **清理当前会话** - 会话已被污染，需要重新开始

**教训**：
- ⚠️ **中转 API 可能有内容审核机制**
- 敏感词拦截会导致空响应
- 需要区分"系统 Bug"和"内容审核"
- 官方 API 通常没有额外的内容审核

---

## 预防措施

### 1. 添加详细日志

在网络请求代码中添加详细日志：

```typescript
// src/infra/llm-gated-fetch.ts

const wrapped: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const startTime = Date.now();
  
  try {
    const response = await original(input, init);
    const duration = Date.now() - startTime;
    
    log.info(`✅ 请求成功`, {
      url: input.toString(),
      status: response.status,
      duration: `${duration}ms`,
    });
    
    return response;
  } catch (error) {
    const duration = Date.now() - startTime;
    
    log.error(`❌ 连接错误`, {
      url: input.toString(),
      error: error.message,
      errorType: error.constructor.name,
      duration: `${duration}ms`,
    });
    
    throw error;
  }
};
```

### 2. 增加超时配置

在配置文件中增加超时时间：

```json
{
  "providers": {
    "vectorengine": {
      "timeout": 60000,
      "connectTimeout": 10000,
      "readTimeout": 50000
    }
  }
}
```

### 3. 添加健康检查

在启动时检查 API 可用性：

```typescript
async function checkApiHealth() {
  try {
    const response = await fetch("https://api.vectorengine.com/health");
    if (response.ok) {
      log.info("✅ API 健康检查通过");
    } else {
      log.warn("⚠️ API 健康检查失败", { status: response.status });
    }
  } catch (error) {
    log.error("❌ API 不可用", { error: error.message });
  }
}
```

---

## 总结

外部 API 报错时，不要急于修改本地代码。使用系统化的调试流程：

1. 验证本地代码
2. 验证网络传输
3. 验证远程响应
4. PowerShell 交叉验证
5. 构建因果链

找到真正的根因，对症下药。

---

**版本：** v20260130_3  
**最后更新：** 2026-01-30  
**来源：** thought_signature 警告调试实战（包含 payload 对比案例 + 敏感词拦截案例）  
**关键词**：外部 API、报错调试、payload 对比、连接错误、格式错误、敏感词拦截、内容审核、中转 API
