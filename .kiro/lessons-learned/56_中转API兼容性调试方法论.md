# 中转 API 兼容性调试方法论

**日期**：2026-02-02  
**问题**：中转 API 声称兼容官方 API，但实际行为不一致  
**根因**：中转 API 可能有隐藏的限制或实现差异

---

## 问题现象

### 症状
- 使用中转 API 时，某些功能不工作
- 切换到官方 API 后，同样的代码可以工作
- 中转 API 返回模糊的错误信息（如 "An unknown error occurred"）

### 典型场景
- OpenAI 兼容的中转 API
- Gemini 兼容的中转 API
- 其他声称"完全兼容"的中转服务

---

## 根本原因

### 1. 中转 API 的兼容性声明不可靠
- 中转 API 可能只实现了部分功能
- 可能有隐藏的限制（payload 大小、工具数量、字段支持等）
- 文档可能不准确或过时

### 2. 中转 API 的实现差异
- 可能对某些字段有不同的解释
- 可能对某些格式有额外的限制
- 可能有自己的扩展字段

### 3. 错误信息不准确
- 中转 API 的错误信息可能不反映真实问题
- 可能返回通用错误而不是具体错误

### 4. baseUrl 配置错误（常见陷阱）⚠️
- **问题**：Clawdbot 使用 `openai-completions` API 时，会自动在 `baseUrl` 后拼接 `/chat/completions`
- **错误示例**：`"baseUrl": "https://api.example.com/v1beta"` → 最终请求 `/v1beta/chat/completions` ❌
- **正确配置**：`"baseUrl": "https://api.example.com/v1"` → 最终请求 `/v1/chat/completions` ✅
- **规则**：`baseUrl` 应该只到域名或版本路径（如 `/v1`），不要包含 `/chat/completions`

---

## 调试方法

### 标准流程

#### 1. 查看官方文档
**目标**：找到官方 API 的正确格式

**步骤**：
1. 搜索官方 API 文档（如 "Gemini API function calling"）
2. 找到官方示例代码（Python、JavaScript、REST）
3. 提取标准格式（特别是 tools、systemInstruction 等关键字段）

**示例**：
```bash
# 搜索官方文档
web_search "Gemini API function calling tutorial"

# 查看官方示例
webFetch "https://ai.google.dev/gemini-api/docs/function-calling/tutorial"
```

#### 2. 创建最小化测试
**目标**：用最简单的 payload 测试官方 API

**步骤**：
1. 创建最小化的 payload（只包含必要字段）
2. 直接调用官方 API（不走中转）
3. 验证官方 API 是否正常工作

**示例**：
```javascript
// test_official_api.mjs
const payload = {
  model: "gemini-3-flash-preview",
  contents: [{ role: "user", parts: [{ text: "写入 hello 到 test.txt" }] }],
  systemInstruction: { parts: [{ text: "你是一个助手。使用 write 工具写入文件。" }] },
  tools: [{
    functionDeclarations: [{
      name: "write",
      description: "Write content to a file",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" }
        }
      }
    }]
  }]
};

const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-goog-api-key": process.env.GEMINI_API_KEY
  },
  body: JSON.stringify(payload)
});

const result = await response.json();
console.log(JSON.stringify(result, null, 2));
```

#### 3. 对比测试
**目标**：找出中转 API 和官方 API 的差异

**步骤**：
1. 用同样的 payload 分别调用官方 API 和中转 API
2. 对比两者的响应
3. 找出差异点

**对比维度**：
- ✅ 是否返回 functionCall
- ✅ 错误信息是否一致
- ✅ 响应格式是否一致
- ✅ 性能是否一致

#### 4. 逐步简化
**目标**：找到中转 API 的限制点

**步骤**：
1. 从完整 payload 开始
2. 逐步移除字段或减少内容
3. 找到中转 API 开始工作的临界点

**可能的限制**：
- Payload 大小限制
- 工具数量限制
- 系统提示词长度限制
- 特定字段不支持

---

## 解决方案

### 方案 1：切换到官方 API（推荐）
**优点**：
- 完全兼容
- 功能完整
- 错误信息准确

**缺点**：
- 可能需要额外的 API key
- 可能有地区限制

**实施**：
```json
{
  "models": {
    "providers": [{
      "id": "gemini-official",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "apiKey": "YOUR_GEMINI_API_KEY",
      "api": "google-generative-ai"
    }]
  }
}
```

### 方案 2：使用中转 API 的兼容模式
**思路**：使用中转 API 支持的格式（如 OpenAI 兼容模式）

**优点**：
- 可以继续使用中转 API
- 可能更稳定

**缺点**：
- 可能缺少某些功能
- 可能有其他兼容性问题

**实施**：
```json
{
  "models": {
    "providers": [{
      "id": "vectorengine",
      "baseUrl": "https://api.vectorengine.ai/v1",
      "api": "openai-completions"  // 使用 OpenAI 兼容模式
    }]
  }
}
```

### 方案 3：适配中转 API 的限制
**思路**：根据中转 API 的限制调整 payload

**可能的调整**：
- 减少系统提示词长度
- 减少工具数量
- 移除某些字段

**实施**：
```typescript
// 在发送前检查 payload 大小
if (JSON.stringify(payload).length > 50000) {
  // 精简系统提示词
  payload.systemInstruction = minimalSystemInstruction;
}

// 限制工具数量
if (payload.tools[0].functionDeclarations.length > 20) {
  // 只发送最相关的工具
  payload.tools[0].functionDeclarations = selectRelevantTools(payload.tools[0].functionDeclarations, userMessage);
}
```

### 方案 4：联系中转 API 支持
**思路**：向中转 API 提供商反馈兼容性问题

**提供信息**：
- 完整的请求 payload
- 官方 API 的响应
- 中转 API 的响应
- 差异点分析

---

## 验证方法

### 1. 功能测试
发送简单指令：
```
写入 hello world 到 test.txt
```

**预期**：
- 官方 API：返回 functionCall
- 中转 API：返回 functionCall（如果兼容）

### 2. 对比测试
```powershell
# 测试官方 API
node test_official_api.mjs > official_response.json

# 测试中转 API
node test_proxy_api.mjs > proxy_response.json

# 对比响应
code --diff official_response.json proxy_response.json
```

### 3. 日志验证
查看日志中的完整 payload 和响应：
```powershell
Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Tail 50 | 
  ConvertFrom-Json | 
  Where-Object { $_.event -eq "llm.payload" -or $_.event -eq "llm.response" }
```

---

## 关键教训

### 1. 不要盲目相信"兼容性"声明
- 中转 API 的"完全兼容"可能只是营销话术
- 必须用官方 API 做对比测试

### 2. 官方文档是唯一的真相来源
- 中转 API 的文档可能不准确
- 始终以官方文档为准

### 3. 最小化测试是定位问题的最快方法
- 用最简单的 payload 测试
- 逐步添加复杂度，找出问题点

### 4. 中转 API 可能有隐藏的限制
- Payload 大小限制
- 工具数量限制
- 特定字段不支持

### 5. 错误信息不可靠
- 中转 API 的错误信息可能不反映真实问题
- 必须通过对比测试找到真正的差异

---

## 适用场景

当遇到以下情况时，考虑中转 API 兼容性问题：

- ✅ 功能在官方 API 上可以工作，但在中转 API 上不工作
- ✅ 中转 API 返回模糊的错误信息
- ✅ 切换 API 格式后行为不一致
- ✅ 中转 API 的文档和官方文档不一致

---

## 相关文档

- `.kiro/lessons-learned/51_系统提示词过长导致模型行为异常.md` - 系统提示词问题
- `.kiro/lessons-learned/52_LLM行为异常调试标准流程.md` - LLM 调试流程
- `.kiro/lessons-learned/39_中转API错误调试方法论.md` - 中转 API 错误调试

---

## 实战案例

### 案例：vectorengine Gemini API 兼容性问题

**问题**：
- 使用 `"api": "google-generative-ai"` 时，LLM 不调用工具
- 返回错误：`"stopReason": "error", "errorMessage": "An unknown error occurred"`

**调试过程**：
1. 检查 tools 格式 → 发现格式正确（符合官方文档）
2. 创建最小化测试 → 准备直接测试官方 API
3. 查看官方文档 → 确认格式完全一致
4. 结论：vectorengine 的中转 API 不完全兼容 Gemini 原生 API

**解决方案**：
- 切换回 OpenAI 兼容模式（`"api": "openai-completions"`）
- 或使用官方 Gemini API

**教训**：
- vectorengine 声称支持 Gemini API，但实际兼容性有问题
- 可能是 payload 大小或工具数量限制
- 必须用官方 API 做对比测试才能确认

---

### 案例 2：vectorengine baseUrl 配置错误导致 404

**问题**：
- 配置：`"baseUrl": "https://api.vectorengine.ai/v1beta"`
- 错误：`404 Invalid URL (POST /v1beta/chat/completions)`

**根本原因**：
- Clawdbot 自动拼接 `/chat/completions`
- 最终路径：`/v1beta/chat/completions` ❌（不存在）
- 正确路径：`/v1/chat/completions` ✅

**调试过程**：
1. 查看错误日志 → 发现完整请求路径
2. 对比 baseUrl 配置 → 发现包含了 `/v1beta`
3. 理解拼接逻辑 → Clawdbot 会自动添加 `/chat/completions`
4. 修正配置 → 改为 `/v1`

**解决方案**：
```json
{
  "models": {
    "providers": {
      "vectorengine": {
        "baseUrl": "https://api.vectorengine.ai/v1",  // ✅ 正确
        "api": "openai-completions"
      }
    }
  }
}
```

**快速诊断方法**：
```powershell
# 1. 查看错误日志中的完整请求路径
Get-Content "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" -Tail 20 | 
  ConvertFrom-Json | 
  Where-Object { $_.event -eq "llm.response" -and $_.payload.stopReason -eq "error" } | 
  Select-Object -ExpandProperty payload | 
  Select-Object errorMessage

# 2. 检查 baseUrl 配置
Get-Content "C:\Users\zouta\.clawdbot\clawdbot.json" -Encoding UTF8 | 
  Select-String -Pattern "baseUrl" -Context 2,2

# 3. 验证修复
# 修改 baseUrl 后重启 Gateway，重新测试
```

**教训**：
- `baseUrl` 配置要遵循标准格式
- 不要在 `baseUrl` 中包含 API 端点路径
- 404 错误优先检查 URL 拼接逻辑

---

**版本：** v20260202_2  
**最后更新：** 2026-02-02  
**变更：** 新增"baseUrl 配置错误"根因和"vectorengine baseUrl 404"实战案例

