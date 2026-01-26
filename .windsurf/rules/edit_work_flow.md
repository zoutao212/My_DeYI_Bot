---
trigger: always_on
---

# 大幅重构/拆分大文件：SafeFileEditor 强制工作流（必走）

适用：单文件进入“几千行 + 需要搬运/删除大段代码块 + 容易冲突/回滚”的场景。

## 一、开工前（必须）

- **备份优先**：大段删除/迁移前，必须确认存在备份（`.bak_时间戳` 或手动 copy）。
- **定位优先**：不要凭记忆用旧行号；先用搜索/grep 精确定位区块边界。

## 二、拆分/迁移（推荐最短路径）

### 宏拆分优先（修正认知）

当你的目标是“解决超大文件让 AI/编辑器难以操作”的痛点时：

- **优先把单个超大文件拆成 2-3 个大模块文件**（按业务域聚合），而不是拆成很多几百行的小文件。
- 小文件拆分只在“模块边界清晰、维护者需要细粒度复用”的情况下再做。

1. **先提取，后删除**（禁止反过来）：
   - 用 `extract-lines` 或 `extract-anchor` 把目标区块原样导出到新文件。
2. **删除优先级（越靠前越推荐）**：
   - `delete-anchor`：按锚点删除整段（最稳，绕开行号漂移）
   - `delete-keywords`：按关键字删除代码块（支持 `--pick` 选择候选）
   - `delete-range`：按行号直接删除区间（行号已稳定/刚定位完时最快）
   - 兜底：`by-lines` + `--code-file` 指向 **0 字节空文件** 实现删除

   交互控制：统一使用 `--non-interactive`（等价 `-y/--yes`）跳过确认。
3. **从底往上删**：
   - 优先删文件尾部区块，减少行号漂移对后续操作的干扰。

## 三、每一步必须闭环（读后验证）

- 每次 `by-lines/by-keywords` 修改后：
  - 立刻 `grep` 关键字确认目标已消失
  - 必要时再读几行上下文确认边界正确

- 前端静态脚本（`.js`）做拆分/删除/迁移后：
  - **追加一层“语法断裂防线”**：用 Node 做语法解析检查，提前拦截“半截模板字符串/括号未闭合/注释断裂”等致命错误。
  - PowerShell 示例（在仓库根目录执行）：
    - `node --check "VirtualWorld/99_System/server/static/cognito_chat_runtime.js"`
    - `node --check "VirtualWorld/99_System/server/static/cognito_chat_runtime_aux.js"`

## 四、遇到报错如何处理（速判）

- **Invalid line range**：行号已失效（文件缩短/变更）→ 重新定位区块边界后再做。
- **Found N matches**：关键字太宽 → 增加 `context_keywords` / 更具体的 `end_keyword` 收敛范围。

补充：当前 SafeFileEditor 的 `start/end` 行号区间在内部实现上是 **1-indexed 且 end 为包含式**。

- 习惯上更推荐用 `delete-anchor` / `delete-keywords` / `extract-anchor` 绕开行号语义差异与漂移。
- 必须用行号时：先测行数（`Measure-Object -Line`），并以“当前文件实际行数”为准重算区间。

## 五、完成后（必须）

- 更新页面脚本加载顺序（例如 `cognito.html` 的 `<script src>`），避免函数缺失。
- 做一次“页面硬刷新 + 关键功能冒烟验证”。
