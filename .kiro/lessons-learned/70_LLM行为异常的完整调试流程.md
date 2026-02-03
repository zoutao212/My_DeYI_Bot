# LLM 行为异常的完整调试流程

> **来源**：vectorengine API 无限循环调试实战（14 次修复失败）  
> **日期**：2026-02-03  
> **关键词**：LLM 行为异常、无限循环、系统提示词、thinking 分析、完整数据流

---

## 问题场景

**现象**：LLM 一直重复调用同一个工具（write、read、exec 等），无法停止，导致 token 消耗暴增。

**常见误判**：
- 以为是工具结果为空
- 以为是格式转换错误
- 以为是 provider 配置问题
- 以为是数据流中某个环节出错

**实际根因**：系统提示词的措辞导致 LLM 误解了执行时机。

---

## 根本原因

### 为什么会修复 14 次都失败？

1. **没有追踪完整数据流**
   - 只看了：工具执行 → 工具结果 → 格式转换 → LLM 接收
   - 没有看：**LLM thinking** → LLM 输出

2. **假设错误的根因**
   - 假设问题在工具结果为空
   - 假设问题在格式转换
   - 假设问题在 provider 空字符串
   - 但都没有验证假设是否正确

3. **没有分析 LLM 行为**
   - 没有看 LLM 的 thinking
   - 没有理解 LLM 为什么会重复调用工具
   - 没有分析 LLM 的决策逻辑

4. **忽略了系统提示词**
   - 没有检查 AGENTS.zh.md 等配置文件
   - 没有检查系统提示词对 LLM 行为的影响
   - 没有检查措辞是否明确

---

## 完整调试流程

### 第一步：追踪完整数据流

**必须追踪的环节**：

```
用户输入
  ↓
系统提示词（AGENTS.md、SOUL.md 等）
  ↓
LLM 接收（payload）
  ↓
LLM thinking（推理过程）⚠️ 最容易忽略
  ↓
LLM 输出（tool_calls 或 text）
  ↓
工具执行
  ↓
工具结果
  ↓
格式转换
  ↓
LLM 接收（下一轮）
```

**关键**：不要只看数据流，要看 **LLM 的 thinking**！

### 第二步：分析 LLM 的 thinking

**如何获取 thinking**：

1. **从控制台日志中提取**：
   ```powershell
   # 搜索 thinking 字段
   Select-String -Path "runtimelog/*.jsonl" -Pattern "thinking" -Context 2,2
   ```

2. **从 trace 日志中提取**：
   ```powershell
   $trace = Get-Content "runtimelog/trace__*.jsonl" -Encoding UTF8 | ConvertFrom-Json
   $thinking = $trace | Where-Object { $_.event -eq "llm.response" } | ForEach-Object { $_.payload.thinking }
   ```

**分析 thinking 的关键问题**：

- LLM 为什么要调用这个工具？
- LLM 认为任务完成了吗？
- LLM 是否误解了系统提示词？
- LLM 是否陷入了某种循环逻辑？

### 第三步：检查系统提示词

**必须检查的文件**：

1. **系统提示词**：`src/agents/system-prompt*.ts`
2. **配置文件**：`clawd/AGENTS.md`、`clawd/SOUL.md`、`clawd/USER.md`
3. **角色设定**：`clawd/characters/*/config.json`、`clawd/characters/*/prompts/*.md`

**检查重点**：

- 措辞是否明确？
- 是否有歧义？
- 是否明确了执行时机？
- 是否明确了执行次数？
- 是否明确了异常处理？

### 第四步：验证假设

**在修复前，必须验证假设**：

1. **提取实际数据**：
   ```powershell
   # 提取 payload
   $payloads = $trace | Where-Object { $_.event -eq "llm.payload" }
   $payloads[0].payload.payload | ConvertTo-Json -Depth 10
   ```

2. **对比成功和失败的数据**：
   - 成功的请求是什么样的？
   - 失败的请求是什么样的？
   - 差异在哪里？

3. **确认根因**：
   - 根因是数据问题？
   - 根因是格式问题？
   - 根因是 LLM 行为问题？
   - 根因是系统提示词问题？

### 第五步：修复并验证

**修复原则**：

1. **在源头修复**：不要在中间环节打补丁
2. **修复后验证**：确认问题不再重现
3. **添加日志**：便于下次调试

**验证方法**：

1. **重启系统**：确保修改生效
2. **测试简单场景**：避免复杂场景干扰
3. **检查 thinking**：确认 LLM 行为正确
4. **检查 payload**：确认数据格式正确

---

## 实战案例：vectorengine API 无限循环

### 问题现象

LLM 一直重复调用 write 工具，无法停止。

### 14 次修复失败的过程

1. **第 1-3 次**：以为是工具结果为空，添加了 result fallback
2. **第 4-6 次**：以为是格式转换错误，修改了格式转换逻辑
3. **第 7-9 次**：以为是 provider 空字符串，修改了 provider 判断逻辑
4. **第 10-12 次**：以为是数据流中某个环节出错，添加了各种日志
5. **第 13-14 次**：以为是工具结果没有被正确传递，修改了工具包装逻辑

**所有修复都失败了，因为都没有看 LLM 的 thinking。**

### 真正的根因

**从 LLM 的 thinking 中发现**：

```
seq=1 thinking:
"Before issuing the write command, I'm reading relevant context files: SOUL.zh.md and USER."

seq=2 thinking:
"Before writing, `AGENTS.zh.md` mandates reading specific files – `SOUL.zh.md`, `USER.zh.md`, and today's memory."

seq=4 thinking:
"My initial step involves gathering contextual information from the provided documents: `SOUL.zh.md`, `USER.zh.md`, and the current date's log file to ensure appropriate persona and style."
```

**LLM 认为 AGENTS.zh.md 要求它在每次工具调用前都必须先读取 SOUL.zh.md、USER.zh.md 等文件！**

### 根因定位

检查 `clawd/AGENTS.zh.md`：

```markdown
## 每次会话（强制顺序）

开始做任何事之前：
1. 读取 `SOUL.zh.md` —— 这是你的身份与风格
2. 读取 `USER.zh.md` —— 这是你正在帮助的用户
3. 读取 `memory/YYYY-MM-DD.md`（今天 + 昨天）—— 获取近期上下文
```

**问题**：措辞"开始做任何事之前"被 LLM 理解为"每次工具调用前"。

### 修复方案

修改 `clawd/AGENTS.zh.md`：

```markdown
## 每次会话（强制顺序）

**会话开始时**（收到第一条用户消息后）：
1. 读取 `SOUL.zh.md` —— 这是你的身份与风格
2. 读取 `USER.zh.md` —— 这是你正在帮助的用户
3. 读取 `memory/YYYY-MM-DD.md`（今天 + 昨天）—— 获取近期上下文

**重要**：
- 这些文件只在会话开始时读取一次，不要在每次工具调用前重复读取
- 如果文件不存在，跳过读取，直接执行用户任务
```

**关键变化**：
1. "开始做任何事之前" → "会话开始时"
2. 明确说明"只读取一次"
3. 明确说明"文件不存在时跳过"

### 修复效果

重启后测试，LLM 不再重复调用工具，问题解决。

---

## 关键教训

### 1. 必须看 LLM 的 thinking

**LLM 的 thinking 是理解其行为的关键。**

- 不要只看数据流
- 不要只看工具结果
- 不要只看格式转换
- **必须看 LLM 的 thinking**

### 2. 系统提示词的措辞非常重要

**措辞的细微差异会导致 LLM 行为完全不同。**

- "开始做任何事之前" vs "会话开始时"
- "每次都读取" vs "只读取一次"
- "必须读取" vs "文件不存在时跳过"

### 3. 验证假设再修复

**不要盲目修复，先验证假设是否正确。**

- 提取实际数据
- 对比成功和失败的数据
- 确认根因
- 再修复

### 4. 在源头修复

**不要在中间环节打补丁。**

- 如果问题在系统提示词，就修改系统提示词
- 如果问题在配置文件，就修改配置文件
- 不要在格式转换层、工具包装层打补丁

### 5. 修复后验证

**修复后必须验证问题不再重现。**

- 重启系统
- 测试简单场景
- 检查 thinking
- 检查 payload

---

## 调试检查清单

当 LLM 行为异常时，按以下步骤检查：

- [ ] **提取 LLM 的 thinking**：从控制台日志或 trace 日志中提取
- [ ] **分析 thinking**：理解 LLM 为什么这样做
- [ ] **检查系统提示词**：检查所有可能影响 LLM 行为的配置文件
- [ ] **检查措辞**：是否明确？是否有歧义？
- [ ] **提取实际数据**：从 trace 日志中提取 payload
- [ ] **对比数据**：对比成功和失败的数据
- [ ] **验证假设**：确认根因
- [ ] **在源头修复**：不要在中间环节打补丁
- [ ] **修复后验证**：确认问题不再重现

---

## 常见错误模式

### 错误 1：只看数据流，不看 thinking

```
❌ 错误做法：
- 只看工具执行 → 工具结果 → 格式转换 → LLM 接收
- 没有看 LLM 的 thinking

✅ 正确做法：
- 追踪完整数据流：工具执行 → 工具结果 → 格式转换 → LLM 接收 → **LLM thinking** → LLM 输出
```

### 错误 2：假设根因，不验证

```
❌ 错误做法：
- 看到问题就假设根因
- 直接修复，不验证假设

✅ 正确做法：
- 提取实际数据
- 对比成功和失败的数据
- 验证假设
- 再修复
```

### 错误 3：在中间环节打补丁

```
❌ 错误做法：
- 在格式转换层修复
- 在工具包装层修复
- 在数据流中间环节修复

✅ 正确做法：
- 找到根因
- 在源头修复（系统提示词、配置文件等）
```

### 错误 4：修复后不验证

```
❌ 错误做法：
- 修复后就认为问题解决了
- 不测试，不验证

✅ 正确做法：
- 重启系统
- 测试简单场景
- 检查 thinking
- 检查 payload
- 确认问题不再重现
```

---

## 总结

**LLM 行为异常的完整调试流程：**

1. **追踪完整数据流**（包括 LLM thinking）
2. **分析 LLM 的 thinking**（理解其行为）
3. **检查系统提示词**（检查措辞是否明确）
4. **验证假设**（提取数据，对比差异）
5. **在源头修复**（不要打补丁）
6. **修复后验证**（确认问题不再重现）

**关键**：不要只看数据流，**必须看 LLM 的 thinking**！

---

**版本：** v20260203_1  
**最后更新：** 2026-02-03  
**变更：** 新增"LLM 行为异常的完整调试流程"（14 次修复失败的深刻反思）
