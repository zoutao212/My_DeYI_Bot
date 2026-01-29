# API 格式切换验证方法论

> **核心原则：切换 API 格式后，必须验证新格式是否支持现有的所有字段和功能。**

---

## 问题模式

### 现象

- 切换了 API 格式（例如从 OpenAI Completions 切换到 Gemini 原生格式）
- 配置看起来正确，日志显示使用了新格式
- 但系统行为仍然异常（报错、功能不工作）

### 根本原因

**新 API 格式可能不支持某些字段或功能：**

1. **字段不兼容**：新格式不支持旧格式中的某些字段
2. **供应商实现不完整**：供应商没有完全实现新格式的规范
3. **字段位置不同**：同样的字段在不同格式中的位置不同
4. **验证规则不同**：新格式有不同的验证规则

### 实战案例

**案例：从 OpenAI Completions 切换到 Gemini 原生格式**

**背景：**
- 使用 OpenAI Completions API 时，供应商的适配层丢失了 `thought_signature`
- 尝试切换到 Gemini 原生格式绕过适配层

**结果：**
- 配置已生效（日志显示 `api=google-generative-ai`）
- 但仍然报错："Request contains an invalid argument"
- 原因：Gemini 原生格式不支持 `thought_signature` 字段

**教训：**
- 切换 API 格式不一定能解决问题
- 必须验证新格式是否支持我们添加的字段
- 如果不支持，需要禁用相关字段或回退到旧格式

---

## 标准验证流程

### 第一步：验证配置是否生效

**检查点：**

1. **配置文件已修改**
   ```powershell
   # 读取配置
   $config = Get-Content "~/.clawdbot/clawdbot.json" -Raw -Encoding UTF8 | ConvertFrom-Json
   Write-Host "api: $($config.models.providers.xxx.api)"
   ```

2. **服务已重启**
   ```powershell
   # 重启服务
   .\Gateway-Service-Stop.cmd
   .\Gateway-Service-Start.cmd
   ```

3. **日志显示新格式**
   ```powershell
   # 检查日志
   Get-Content "日志文件" -Encoding UTF8 | Select-String "api=" | Select-Object -Last 5
   ```

**验证标准：**
- ✅ 配置文件中的 `api` 值已修改
- ✅ 服务已重启
- ✅ 日志显示使用了新的 `api` 值

### 第二步：对比新旧格式的字段差异

**方法 1：查看官方文档**

**OpenAI Completions API 格式：**
```json
{
  "model": "xxx",
  "messages": [
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        {
          "id": "xxx",
          "type": "function",
          "function": {
            "name": "read",
            "arguments": "{...}"
          }
        }
      ]
    }
  ],
  "tools": [...]
}
```

**Gemini 原生格式：**
```json
{
  "model": "xxx",
  "contents": [
    {
      "role": "model",
      "parts": [
        {
          "functionCall": {
            "name": "read",
            "args": {...}
          }
        }
      ]
    }
  ],
  "tools": [...]
}
```

**关键差异：**
- `messages` → `contents`
- `tool_calls` → `parts[].functionCall`
- `function.arguments` (string) → `functionCall.args` (object)

**方法 2：搜索代码中的格式转换逻辑**

```powershell
# 搜索格式转换代码
grepSearch -query "contents.*parts|messages.*tool_calls" -includePattern "src/**/*.ts"
```

### 第三步：检查是否有不支持的字段

**检查方法：**

1. **查看官方文档**
   - 新格式的官方文档中是否有我们添加的字段？
   - 字段的位置是否正确？

2. **查看错误信息**
   - 错误信息是否提到某个字段？
   - 例如："invalid argument"、"unknown field"

3. **对比成功和失败的请求**
   - 第一次请求成功，后续失败？
   - 差异在哪里？（通常是后续请求有额外的字段）

**实战案例：**

**第一次请求（成功）：**
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "..."}]
    }
  ]
}
```

**后续请求（失败）：**
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "..."}]
    },
    {
      "role": "model",
      "parts": [
        {
          "functionCall": {
            "name": "read",
            "args": {...},
            "thought_signature": "xxx"  // ← 不支持的字段
          }
        }
      ]
    }
  ]
}
```

**发现：** `thought_signature` 字段导致 "invalid argument" 错误

### 第四步：禁用不支持的字段或回退

**方案 1：禁用不支持的字段（推荐）**

**修改代码：**
```typescript
// 检查是否应该添加该字段
function shouldAddField(params: {
  provider?: string;
  modelApi?: string | null;
}): boolean {
  const modelApi = (params.modelApi ?? "").trim().toLowerCase();
  
  // 对不支持的 API 格式禁用
  if (modelApi === "google-generative-ai") {
    return false;
  }
  
  return true;
}
```

**验证：**
1. 重新构建：`pnpm build`
2. 重启服务
3. 测试功能
4. 检查日志和供应商后台

**方案 2：回退到旧格式**

**修改配置：**
```json
{
  "provider": {
    "api": "openai-completions"  // 回退到旧格式
  }
}
```

**说明：**
- 如果新格式不可用，回退到旧格式
- 但需要解决旧格式的问题（例如禁用导致问题的字段）

### 第五步：验证修复效果

**验证清单：**

- [ ] 配置已修改（如果需要）
- [ ] 代码已修改（如果需要）
- [ ] 已重新构建（如果修改了代码）
- [ ] 服务已重启
- [ ] 日志显示使用了正确的 API 格式
- [ ] 第一次请求成功
- [ ] 后续请求（有复杂字段）也成功
- [ ] 供应商后台没有报错
- [ ] 功能正常工作

---

## 常见 API 格式对比

### OpenAI Completions API vs Gemini 原生 API

| 特性 | OpenAI Completions | Gemini 原生 |
|------|-------------------|-------------|
| 消息列表 | `messages` | `contents` |
| 工具调用 | `tool_calls` | `parts[].functionCall` |
| 工具结果 | `role: "tool"` | `parts[].functionResponse` |
| 参数格式 | `arguments` (string) | `args` (object) |
| 系统提示 | `role: "system"` | `systemInstruction` |

### OpenAI Completions API vs Anthropic Messages API

| 特性 | OpenAI Completions | Anthropic Messages |
|------|-------------------|-------------------|
| 消息列表 | `messages` | `messages` |
| 工具调用 | `tool_calls` | `content[].type: "tool_use"` |
| 工具结果 | `role: "tool"` | `content[].type: "tool_result"` |
| 系统提示 | `role: "system"` | `system` (顶层字段) |

---

## 预防措施

### 1. 切换前先查看文档

**必须查看：**
- 新格式的官方文档
- 字段对照表
- 示例 payload

**确认：**
- 新格式是否支持我们使用的所有字段
- 字段的位置是否正确
- 是否有特殊的验证规则

### 2. 先在测试环境验证

**步骤：**
1. 在测试环境切换 API 格式
2. 测试所有功能
3. 检查日志和错误信息
4. 确认没有问题后再在生产环境切换

### 3. 保留回退方案

**备份：**
- 备份配置文件
- 记录旧的 API 格式
- 准备回退步骤

**回退条件：**
- 新格式不支持某些字段
- 供应商实现不完整
- 功能不正常工作

### 4. 逐步切换

**步骤：**
1. 先切换配置，不修改代码
2. 测试基本功能
3. 如果有问题，修改代码适配新格式
4. 再次测试
5. 确认没有问题后完成切换

---

## 调试技巧

### 技巧 1：对比第一次和后续请求

**方法：**
```powershell
# 提取第一次请求的 payload
$log = Get-Content "日志文件" -Encoding UTF8 | Select-String "seq=1.*payloadPreview"

# 提取后续请求的 payload
$log = Get-Content "日志文件" -Encoding UTF8 | Select-String "seq=2.*payloadPreview"

# 对比差异
```

**关键：**
- 第一次请求通常结构简单
- 后续请求有额外的字段（tool_calls、tool result）
- 差异点通常是问题所在

### 技巧 2：查看供应商后台

**检查：**
- 供应商后台的错误信息
- 请求时间和状态
- 费用记录（成功的请求有费用，失败的没有）

**对比：**
- 本地日志显示的状态
- 供应商后台显示的状态
- 两者是否一致

### 技巧 3：使用 curl 测试

**直接测试供应商的 API：**
```powershell
# 测试新格式
curl -X POST "https://api.xxx.com/v1beta/models/xxx:generateContent" `
  -H "Authorization: Bearer xxx" `
  -H "Content-Type: application/json" `
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}'
```

**验证：**
- 供应商是否真的支持新格式
- 是否有特殊的参数要求
- 错误信息是什么

---

## 检查清单

API 格式切换时，必须检查：

- [ ] **查看官方文档**：确认新格式的字段和结构
- [ ] **对比字段差异**：列出新旧格式的差异
- [ ] **验证配置生效**：确认日志显示新格式
- [ ] **测试基本功能**：第一次请求是否成功
- [ ] **测试复杂功能**：后续请求（有 tool_calls）是否成功
- [ ] **检查供应商后台**：是否有报错
- [ ] **禁用不支持的字段**：如果新格式不支持某些字段
- [ ] **准备回退方案**：如果新格式不可用

---

## 关键教训

1. **切换 API 格式不一定能解决问题**
   - 新格式可能有新的限制
   - 必须验证新格式的兼容性

2. **不同格式有不同的字段要求**
   - 字段名称可能不同
   - 字段位置可能不同
   - 字段格式可能不同

3. **供应商的实现可能不完整**
   - 供应商可能没有完全实现规范
   - 需要测试和验证
   - 可能需要回退到更稳定的格式

4. **禁用不支持的字段**
   - 如果某个字段导致问题
   - 优先禁用该字段
   - 而不是强行使用

5. **第一次成功不代表后续也成功**
   - 第一次请求和后续请求的结构不同
   - 必须分别验证
   - 差异点通常是问题所在

---

## 相关文档

- `.kiro/lessons-learned/19_配置项验证方法论.md` - 配置项验证方法论
- `.kiro/lessons-learned/16_外部API报错调试方法论.md` - 外部 API 报错调试
- `.kiro/lessons-learned/18_修复无效的根因分析方法论.md` - 修复无效的根因分析

---

**版本：** v20260129_1  
**创建时间：** 2026-01-29  
**来源：** thought_signature 问题调试实战（API 格式切换）  
**关键词：** API 格式切换、格式验证、字段兼容性、供应商实现

