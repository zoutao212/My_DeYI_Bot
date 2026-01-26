---
description: 认知面板多文件选择/持久化/渲染问题排障工作流
---

# 认知面板多文件问题排障工作流

## 使用场景

当出现以下任一现象时使用本工作流：

- 认知面板多文件：选了但列表不显示
- 复选框不回显（已选数量变了但勾选状态不对）
- 点保存后回包是空数组，或重开面板配置丢失

## 目标

用固定顺序把问题压缩到 5 类根因之一：

1. 前端渲染被 JS 异常打断
2. 网络回包/作用域（user_id）不一致
3. 写后读不一致（POST 返回不是读回结果）
4. DB jsonb 解码异常（jsonb 被当成字符串）
5. innerHTML/事件参数逃逸导致解析失败

## 0. 先做“最小复现”记录

- 记录你在 UI 上点击的路径：打开面板 -> 点击哪个“选择文件(多选)” -> 勾选几个 -> 点击确认/保存 -> 列表期望是什么
- 记录是否涉及特殊字符：引号 `'"`、反斜杠 `\`、空格、中文、`[](){}` 等

## 1. 前端渲染是否被异常打断（最高优先级）

1. 打开 DevTools -> Console
2. 刷新页面后立刻打开认知面板，观察是否有：
   - `SyntaxError`
   - `Uncaught`
   - 与 `cognito_ui.js` 相关的报错

判定：

- 若存在 JS 报错：优先修 JS（后端先不要动）。
- 若无 JS 报错：进入第 2 步。

## 2. 网络回包是否一致（GET/POST 两次核对）

1. 打开 DevTools -> Network
2. 触发一次 GET `/cognition/prompt-sources`
3. 做一次“选择文件 -> 保存”（触发 POST `/cognition/prompt-sources`）
4. 再触发一次 GET

检查 3 个点：

- `user_id`：GET 与 POST 必须一致（建议前端显式传 `default`，并在回包中打印 `user_id`）。
- `sources.xxx_files`：POST 回包中的 sources 是否已经包含你刚保存的文件。
- POST 后的 GET：是否与 POST 回包一致。

判定：

- 若 user_id 不一致：属于“作用域漂移”，先修前端请求参数。
- 若 POST 回包为空但 GET 正常：属于“返回值非读回”或“前端渲染问题”，进入第 3/5 步。
- 若 POST/GET 都为空：进入第 4 步（后端存储/解码）。

## 3. 写后读一致性（POST 必须用读回结果作为 sources）

要求：

- POST 保存后：后端应立即从 KV 读回一次 sources，并把“读回结果”作为 POST 响应中的 sources
- preview 也应基于“读回 sources”生成，避免写入与预览不同步

自检钩子（后端日志建议）：

- 打印 `POST saved_payload` 与 `read_back_sources`
- 强制对比：若不同，直接告警

判定：

- 若读回和保存不一致：优先看 KV/DB 读写。

## 4. DB jsonb 解码（非常高发）

现象：

- 数据库里是 jsonb，但驱动层返回 `str`，上层用 `isinstance(value, dict)` 判定失败，导致“看起来保存了，但读回全是默认空”。

自检钩子：

- 在 KVStore.get/get_all：
  - 若 value 是 `str`，尝试 `json.loads`
  - 失败要打印 key、scope、value 的前 200 字符

判定：

- 若修复 jsonb 解码后恢复：根因确认。

## 5. innerHTML/事件参数逃逸（路径字符串不要进 onclick/onchange）

高危写法：

- `innerHTML = "<button onclick=\"remove('" + path + "')\">"`

正确策略：

- 事件只传 `idx`（或 `group+idx`），渲染时从数组取真实 path
- 或使用 `JSON.stringify(path)` 生成安全字面量（仍然建议 idx 优先）

自检钩子：

- 搜索 `onclick=`、`onchange=`、`innerHTML` 拼接处，确认没有直接拼 path

## 6. 回归验证（必须过）

- 选择文件 -> 确认添加：列表立刻显示
- 点击保存/自动保存：Network 中 POST 回包 sources 非空且包含新文件
- 关闭面板/刷新页面：再次打开仍存在

## 关键词索引（用于快速 grep/检索）

- `prompt-sources`
- `core_identity_files`
- `KVStore.get`
- `jsonb` / `json.loads`
- `write-after-read`
- `innerHTML` / `onclick` / `onchange`
- `JSON.stringify`
