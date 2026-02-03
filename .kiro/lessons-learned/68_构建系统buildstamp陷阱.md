# 构建系统 .buildstamp 陷阱

> **来源**：vectorengine API 无限循环问题调试（第 9-10 次修复）  
> **日期**：2026-02-03  
> **影响**：代码已修复，但运行时仍然使用旧代码，导致修复无效

---

## 问题描述

当你修改了源代码并运行 `pnpm build` 后，运行时仍然使用旧代码，导致修复无效。

**典型症状：**
- ✅ 代码已修改
- ✅ `pnpm build` 成功
- ✅ 重启了应用
- ❌ 但是修复没有生效
- ❌ trace 日志中没有修复日志
- ❌ dist 文件时间戳比 trace 文件旧

---

## 根本原因

### 1. `pnpm build` 不更新 `.buildstamp`

`pnpm build` 只运行 `tsc`，不更新 `.buildstamp` 文件。

**package.json:**
```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json && ..."
  }
}
```

**问题：** `tsc` 不会更新 `.buildstamp`，导致 `run-node.mjs` 认为不需要重新编译。

### 2. `run-node.mjs` 依赖 `.buildstamp` 判断是否需要重新编译

**scripts/run-node.mjs:**
```javascript
const shouldBuild = () => {
  if (env.CLAWDBOT_FORCE_BUILD === "1") return true;
  const stampMtime = statMtime(buildStampPath);
  if (stampMtime == null) return true;
  if (statMtime(distEntry) == null) return true;

  // 检查 src/ 中最新文件的时间戳
  const srcMtime = findLatestMtime(srcRoot, isExcludedSource);
  if (srcMtime != null && srcMtime > stampMtime) return true;
  return false;
};
```

**逻辑：**
1. 检查 `.buildstamp` 文件的时间戳
2. 检查 `src/` 中最新文件的时间戳
3. 如果 `src/` 中的文件比 `.buildstamp` 新，就重新编译
4. 否则，直接运行 `dist/entry.js`

**问题：** 如果 `.buildstamp` 时间戳比 `src/` 文件新，`shouldBuild()` 返回 `false`，直接运行旧代码。

### 3. 手动更新 `.buildstamp` 无效

**错误做法：**
```powershell
# 手动更新 .buildstamp
$timestamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
Set-Content "dist/.buildstamp" -Value "$timestamp`n" -Encoding UTF8
```

**问题：**
- 手动更新 `.buildstamp` 后，`.buildstamp` 时间戳比 `src/` 文件新
- `shouldBuild()` 认为不需要重新编译
- 运行时仍然使用旧代码

---

## 解决方案

### 方案 1：删除 `.buildstamp`，强制重新编译（推荐）

```powershell
# 删除 .buildstamp 文件
Remove-Item "dist/.buildstamp" -ErrorAction SilentlyContinue

# 重新编译
pnpm build
```

**原理：** `.buildstamp` 不存在时，`shouldBuild()` 返回 `true`，强制重新编译。

### 方案 2：设置环境变量强制编译

```powershell
# 设置环境变量
$env:CLAWDBOT_FORCE_BUILD = "1"

# 运行（会自动重新编译）
pnpm clawdbot ...
```

**原理：** `shouldBuild()` 检查 `CLAWDBOT_FORCE_BUILD` 环境变量，如果为 `"1"`，强制重新编译。

### 方案 3：验证 dist 文件时间戳

```powershell
# 检查 dist 文件时间戳
$distFile = Get-Item "dist/agents/pi-embedded-runner/google.js"
$latestTrace = Get-ChildItem "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Host "dist 文件时间: $($distFile.LastWriteTime)" -ForegroundColor Yellow
Write-Host "trace 文件时间: $($latestTrace.LastWriteTime)" -ForegroundColor Yellow

if ($distFile.LastWriteTime -lt $latestTrace.LastWriteTime) {
    Write-Host "❌ dist 文件比 trace 文件旧！新代码没有被加载" -ForegroundColor Red
    $diff = ($latestTrace.LastWriteTime - $distFile.LastWriteTime).TotalSeconds
    Write-Host "   时间差: $diff 秒" -ForegroundColor Red
} else {
    Write-Host "✅ dist 文件比 trace 文件新，新代码已加载" -ForegroundColor Green
}
```

---

## 验证方法

### 1. 检查 dist 文件时间戳

**判断标准：**
- ✅ **dist 文件时间戳 > trace 文件时间戳** → 新代码已加载
- ❌ **dist 文件时间戳 < trace 文件时间戳** → 旧代码被加载

### 2. 检查 trace 日志

**判断标准：**
- ✅ **trace 日志中有修复日志** → 新代码已加载
- ❌ **trace 日志中没有修复日志** → 旧代码被加载

**示例：**
```powershell
# 搜索修复日志
$latestTrace = Get-ChildItem "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$content = Get-Content $latestTrace.FullName -Encoding UTF8
$fixedLogs = $content | Select-String "Fixed Gemini functionResponse.name"

if ($fixedLogs.Count -gt 0) {
    Write-Host "✅ 找到修复日志，新代码已加载" -ForegroundColor Green
} else {
    Write-Host "❌ 没有找到修复日志，旧代码被加载" -ForegroundColor Red
}
```

### 3. 不要只看"编译成功"

**错误做法：**
```powershell
pnpm build
# 看到 "Done" 就认为新代码已加载
```

**正确做法：**
```powershell
pnpm build
# 验证 dist 文件时间戳
# 验证 trace 日志
# 确认新代码真的被加载
```

---

## 标准流程

### 修改代码后的标准流程

```powershell
# 1. 删除 .buildstamp
Remove-Item "dist/.buildstamp" -ErrorAction SilentlyContinue

# 2. 重新编译
pnpm build

# 3. 验证 dist 文件时间戳
$distFile = Get-Item "dist/agents/pi-embedded-runner/google.js"
Write-Host "dist 文件时间: $($distFile.LastWriteTime)" -ForegroundColor Green

# 4. 重启应用
# 使用 .A_Start-Clawdbot.cmd 或其他启动脚本

# 5. 测试
# 执行测试用例

# 6. 验证 trace 日志
$latestTrace = Get-ChildItem "C:\Users\zouta\.clawdbot\runtimelog\trace__*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$content = Get-Content $latestTrace.FullName -Encoding UTF8
$fixedLogs = $content | Select-String "你的修复日志关键词"

if ($fixedLogs.Count -gt 0) {
    Write-Host "✅ 修复生效" -ForegroundColor Green
} else {
    Write-Host "❌ 修复未生效，检查 dist 文件时间戳" -ForegroundColor Red
}
```

---

## 常见错误

### 错误 1：只运行 `pnpm build`，不删除 `.buildstamp`

**问题：** `.buildstamp` 时间戳可能比 `src/` 文件新，导致 `shouldBuild()` 认为不需要重新编译。

**解决：** 删除 `.buildstamp` 后再编译。

### 错误 2：手动更新 `.buildstamp`

**问题：** 手动更新 `.buildstamp` 后，`.buildstamp` 时间戳比 `src/` 文件新，导致 `shouldBuild()` 认为不需要重新编译。

**解决：** 删除 `.buildstamp`，不要手动更新。

### 错误 3：不验证 dist 文件时间戳

**问题：** 只看"编译成功"，不验证 dist 文件时间戳，导致不知道新代码是否被加载。

**解决：** 每次编译后验证 dist 文件时间戳。

### 错误 4：不检查 trace 日志

**问题：** 只看"重启成功"，不检查 trace 日志，导致不知道修复是否生效。

**解决：** 每次测试后检查 trace 日志。

---

## 关键教训

1. **`pnpm build` 不更新 `.buildstamp`**
   - 必须删除 `.buildstamp` 后再编译
   - 或者设置 `CLAWDBOT_FORCE_BUILD=1`

2. **手动更新 `.buildstamp` 无效**
   - 会导致 `shouldBuild()` 认为不需要重新编译
   - 必须删除 `.buildstamp`

3. **验证 dist 文件时间戳**
   - 不要只看"编译成功"
   - 必须验证 dist 文件时间戳是否比 trace 文件新

4. **检查 trace 日志**
   - 不要只看"重启成功"
   - 必须检查 trace 日志中是否有修复日志

5. **标准流程**
   - 删除 `.buildstamp` → 编译 → 验证时间戳 → 重启 → 测试 → 检查日志

---

## 实战案例

**案例：vectorengine API 无限循环问题（第 9-10 次修复）**

**问题：**
- 第 9 次修复：代码已修复，但运行时仍然使用旧代码
- 原因：手动更新了 `.buildstamp`，导致 `shouldBuild()` 认为不需要重新编译

**解决：**
- 第 10 次修复：删除 `.buildstamp`，强制重新编译
- 验证 dist 文件时间戳
- 检查 trace 日志

**教训：**
- 不要手动更新 `.buildstamp`
- 必须删除 `.buildstamp` 后再编译
- 必须验证 dist 文件时间戳和 trace 日志

---

**版本：** v20260203_1  
**最后更新：** 2026-02-03  
**关键词：** 构建系统、.buildstamp、pnpm build、run-node.mjs、shouldBuild、时间戳判断、验证方法、标准流程
