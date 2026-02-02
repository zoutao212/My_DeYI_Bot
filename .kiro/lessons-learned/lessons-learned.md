# 踩过的坑（经验教训）

开发过程中遇到的问题和解决方案，避免重复踩坑。

---

## 记忆检索系统

### 公理检索适配器错误 ⚠️ 重要
- **问题**：`AxiomAdapter` 错误地从 `memory_atoms` 表检索 `atom_type='AXIOM'` 的记录
- **根因**：公理实际存储在独立的 `axioms` 表中，不是 `memory_atoms` 表
- **解决**：修改 `AxiomAdapter` 使用 `AxiomRepository` 从 `axioms` 表检索
- **教训**：新建适配器时要确认数据源的实际存储位置

### 相似度阈值过高
- **问题**：`min_similarity: 0.5` 对于少量记忆来说过高，导致检索不到结果
- **解决**：将默认阈值从 0.5 降到 0.3
- **影响范围**：
  - `config.yaml` 中的 `unified_retrieval.min_similarity`
  - `RetrievalConfig` 的默认值
  - `UnifiedRetrievalConfig` 的默认值
  - 各个检索器的默认参数

### 检索调试困难
- **问题**：检索失败时难以定位原因
- **解决**：在关键节点添加详细日志
  - `AxiomAdapter`: 记录从 axioms 表获取的公理数量
  - `MemoryAtomAdapter`: 记录检索模式、耗时、降级情况
  - `retrieve_for_chat`: 记录启用的知识源和检索结果分布

### 中文分词优化
- **问题**：原始的正则分词对中文效果差，无法提取有意义的关键词
- **解决**：集成 jieba 词性标注分词
  - 使用 `jieba.posseg` 进行词性标注
  - 只保留名词(n)、动词(v)、形容词(a)等有意义的词
  - 添加中文停用词过滤
- **位置**：`atom_repository.py` 的 `_tokenize_query` 方法
- **注意**：jieba 首次加载较慢，建议在系统启动时预加载

### 全文搜索降级策略
- **问题**：PostgreSQL 的 tsvector 对中文支持有限
- **解决**：在 `search_by_text` 中实现自动降级
  1. 先用 jieba 分词预处理查询
  2. 尝试 tsvector 全文搜索
  3. 如果无结果，自动降级到 LIKE 模糊匹配
- **位置**：`atom_repository.py` 的 `search_by_text` 方法

### 预览与实际发送内容不一致 ⚠️ 重要
- **问题**：`preview_chat_context` 只返回检索到的记忆，但 `cognito_chat` 还会注入人格系统内容
- **表现**：预览显示 433 字符，实际发送了包含完整人格内容的长文本
- **根因**：预览 API 没有获取人格系统的 `persona_prompt`
- **解决**：
  1. 在 `preview_chat_context` 中添加人格系统获取逻辑
  2. 构建完整上下文：`检索结果 + 人格内容`
  3. 返回分离字段便于调试：`context`（完整）、`retrieval_context`（仅检索）、`persona_context`（仅人格）
- **教训**：预览 API 必须与实际发送 API 保持逻辑一致，否则用户无法准确预估发送内容

---

## 数据库设计

### 不要为小数据建专用表
- 用户偏好、配置项这类小数据，用 `kv_store` 通用表存储
- 一张表搞定所有配置类数据，通过 namespace 区分
- 只有数据量大（>10000条）或需要 embedding 时才建专用表

### Schema 文件要统一
- 所有表定义放在 `00_master_schema.sql`，不要散落各处
- 不要创建 fix_xxx.sql 补丁文件，直接改主 schema
- 改完数据库结构要同步更新 `structure.md`

### 危险操作
- `rebuild_database.py` 会**删除所有数据**！
- 日常开发用安全脚本（`add_kv_store.py`、`add_cognition_tables.py`）
- 只在全新部署时才用重建脚本

---

## 脚本和路径

### Python 脚本路径
- 用 `__file__` 获取脚本所在目录，不要假设当前目录
- 示例：`script_dir = Path(__file__).parent`

### Batch 脚本路径
- 用 `%~dp0` 获取脚本所在目录
- 示例：`cd /d "%~dp0"`

### Batch 脚本中文问题 ⚠️ 重要
- **避免在 echo 语句中使用中文冒号**（会被 CMD 误识别为命令）
- **避免单独的中文词语**（如"等待"会被识别为命令）
- 解决方案：
  - 标题和提示用英文
  - 或者在中文前后加空格/符号
  - 示例：`echo Version: v8.1` 而不是 `echo 版本: v8.1`
  - 示例：`echo Waiting for PostgreSQL...` 而不是 `echo 等待 PostgreSQL...`

### 批处理脚本依赖检查
- 需要数据库的脚本应该先检查 PostgreSQL 是否运行
- 可以自动启动依赖服务，提升用户体验
- 示例：
```batch
tasklist /FI "IMAGENAME eq postgres.exe" | find /I "postgres.exe"
if %ERRORLEVEL% neq 0 (
    call Start_PostgreSQL.bat
)
```

### 给用户的命令
- 不要给相对路径的命令，用户的工作目录可能不是项目根目录
- 要么给绝对路径，要么让用户先 cd 到正确目录

---

## 新功能开发

### 先想后做
- 加新功能前先想想：能不能用现有的表/组件？
- 小额数据优先用 kv_store，不要动不动就建表
- 复用比新建更好

### 文档同步
- 改完数据库结构要同步更新 steering 文档
- 新增重要组件要更新 `structure.md`
- 配置变更要更新 `know.md`

---

## API 开发

### 错误处理
- API 失败时前端要显示友好提示，不要卡在"加载中"
- 后端要返回有意义的错误信息

### 异步操作
- 使用 `@async_route` 装饰器处理异步 API
- 数据库操作用 `await`

---

## 前端开发

### UI 反馈
- 操作成功/失败要有 Toast 提示
- 长时间操作要有 loading 状态
- 按钮点击后要禁用防止重复提交

---

## AI 工具使用陷阱 ⚠️ 极其重要

### 工具调用成功 ≠ 文件实际写入 ⚠️ 血泪教训
- **问题**：`strReplace`、`fsWrite` 等工具调用显示成功，但文件实际上没有写入磁盘
- **表现**：
  - 工具返回 "Replaced text in xxx" 或 "File written"
  - 但用 PowerShell `Get-Content` 读取文件，内容没变
  - 用户刷新浏览器，看不到任何变化
- **根因**：工具可能有内部缓存，或者写入操作被某种机制阻止
- **解决方案**：
  1. **永远用 PowerShell 验证**：修改后立即用 `Get-Content` 或 `Select-String` 验证
  2. **不要相信工具的返回值**：必须独立验证
  3. **如果工具失败，改用 PowerShell 直接写入**：
     ```powershell
     $content = Get-Content $filePath -Raw -Encoding UTF8
     $newContent = $content -replace 'old', 'new'
     [System.IO.File]::WriteAllText($filePath, $newContent, [System.Text.Encoding]::UTF8)
     ```
- **教训**：工具调用成功只是"请求成功"，不代表"操作成功"

### 文件读取工具的缓存问题
- **问题**：`readFile` 工具可能返回缓存的旧内容，而不是磁盘上的最新内容
- **表现**：工具显示文件有某段代码，但 PowerShell 读取显示没有
- **解决方案**：
  1. 关键验证必须用 PowerShell 而不是 readFile
  2. 如果怀疑缓存，用 `Get-Content -Head 10` 快速验证
- **教训**：调试时不要只依赖一种工具，要交叉验证

### 修改大文件的正确姿势
- **问题**：大文件（>1000行）的修改容易出问题
- **解决方案**：
  1. 先用 `Select-String` 找到要修改的行号
  2. 用 `Get-Content` 读取周围几行确认上下文
  3. 用 PowerShell 的字符串替换或行插入来修改
  4. 修改后立即验证
- **示例**：
  ```powershell
  # 找到目标行
  Select-String -Path $file -Pattern "目标文本" | Select LineNumber
  
  # 读取上下文
  $lines = Get-Content $file -Encoding UTF8
  $lines[550..560]
  
  # 修改并写回
  $lines[556] = "新内容"
  [System.IO.File]::WriteAllLines($file, $lines, [System.Text.Encoding]::UTF8)
  ```

---

## 前端调试

### 浏览器缓存问题
- **问题**：修改了模板文件，但浏览器显示旧版本
- **排查步骤**：
  1. 先确认文件真的被修改了（用 PowerShell 验证）
  2. 在文件中添加版本标记（如 `<!-- VERSION: 2026-01-02-v3 -->`）
  3. 修改 `<title>` 标签，这是最容易观察的变化
  4. 强制刷新：Ctrl+F5
  5. 如果还不行，打开隐身窗口测试
- **Flask 模板缓存**：
  - 确保 `app.config['TEMPLATES_AUTO_RELOAD'] = True`
  - 确保 `app.jinja_env.auto_reload = True`
  - 开发模式下 `debug=True` 应该自动重载

### 确认服务器端口
- **问题**：可能访问了错误的端口
- **排查**：
  ```powershell
  # 查看 Python 进程的命令行参数
  Get-CimInstance Win32_Process -Filter "name='python.exe'" | Select ProcessId, CommandLine
  
  # 查看端口监听情况
  netstat -ano | Select-String ":5000|:8000"
  ```
- **教训**：启动脚本可能配置了非默认端口（如 8000 而不是 5000）

---

## 调试方法论

### 问题定位的正确顺序
1. **确认文件是否真的被修改**：用 PowerShell 读取磁盘文件
2. **确认服务器是否加载了新文件**：检查端口、进程、工作目录
3. **确认浏览器是否加载了新内容**：查看页面源代码、检查标题
4. **确认代码逻辑是否正确**：检查 HTML 结构、JavaScript 函数

### 添加可观察的标记
- 修改文件时，同时添加一个明显的标记（版本号、标题变化）
- 这样可以快速判断修改是否生效
- 示例：`<title>🧠 智能记忆提取器 v3</title>`

### 不要假设，要验证
- 不要假设工具调用成功就是真的成功
- 不要假设文件存在就是内容正确
- 不要假设服务器重启就会加载新文件
- **每一步都要独立验证**


---

## 构建验证流程（必须执行）⚠️ 极其重要

### 触发场景
修改了 `src/` 目录下的 TypeScript 源代码后。

### 标准流程

1. **运行完整构建**
   ```cmd
   Build-All.cmd
   ```
   或手动：
   ```cmd
   pnpm build        # 编译 TypeScript
   pnpm ui:build     # 构建 UI
   ```

2. **验证构建产物时间戳**
   ```powershell
   Get-Item "dist/agents/<修改的文件>.js" | Select LastWriteTime
   ```
   确保时间戳是最新的（刚才构建的时间）。

3. **验证构建产物内容**
   ```powershell
   grepSearch -query "<关键代码片段>" -includePattern "dist/**/*.js"
   ```
   确保修复的代码已经出现在构建产物中。

4. **重启 Gateway**
   ```cmd
   Start-Clawdbot.cmd
   ```

### 常见错误

❌ **只运行 `pnpm ui:build`**
- 这只构建 UI，不编译 TypeScript
- 修改 `src/` 后必须运行 `pnpm build`

❌ **不验证构建产物**
- 构建可能失败但没有报错
- 必须检查 `dist/` 文件的时间戳和内容

❌ **不重启 Gateway**
- Node.js 进程缓存了旧代码
- 必须重启才能加载新代码

### 质量门槛

- ✅ `dist/` 文件时间戳是最新的
- ✅ 构建产物中包含修复的代码
- ✅ Gateway 重启后加载了新代码
- ✅ 用户测试确认问题已修复

---

## 供应商 API 兼容性排查流程

### 触发场景
- 供应商返回 HTTP 400 INVALID_ARGUMENT
- 日志显示 "ok" 但实际是错误
- 工具调用失败但原因不明

### 标准流程

1. **读取 trace 文件中的 responseSummary**
   ```powershell
   Get-Content "runtimelog/trace__...__<runId>.jsonl" | Select-String "llm.done"
   ```
   查看 `payload.responseSummary.samples[].error`

2. **检查是否有隐藏错误**
   即使日志显示 "ok"，也要检查 `responseSummary` 中是否有 `error` 字段。

3. **验证 payload 格式**
   - 检查 `messages` 数组格式
   - 检查 `role=tool` 是否有 `tool_call_id`
   - 检查 `tool_calls` 是否有必需字段

4. **针对特定供应商添加补丁**
   例如 vectorengine 需要 `thought_signature` 字段：
   - 在 `gemini-payload-thought-signature.ts` 中添加补丁
   - 验证补丁是否生效（检查 `dist/` 构建产物）

### 常见问题

❌ **只看控制台日志**
- 控制台可能只显示 "ok"
- 真实错误在 `trace` 文件的 `responseSummary` 中

❌ **不验证 payload 格式**
- 供应商对格式要求严格
- 必须在发送前验证

❌ **补丁未生效**
- 修改了源代码但没有构建
- 必须验证 `dist/` 中的构建产物

### 质量门槛

- ✅ 读取了 `trace` 文件的 `responseSummary`
- ✅ 确认了真实错误原因
- ✅ 添加了 payload 格式验证
- ✅ 针对供应商添加了必要补丁
- ✅ 验证了补丁已生效

---

**版本：** v20260129_2
**最后更新：** 2026-01-29
**变更：** 新增构建验证流程和供应商 API 兼容性排查流程


---

## 配置项验证方法论 ⚠️ 极其重要

### 触发场景
- 用户添加了配置项，但配置不生效
- 不确定系统使用哪个配置项
- 配置项命名不规范，容易猜错

### 标准流程：配置项验证三步法

#### 第一步：搜索代码确认读取逻辑
**不要假设配置项存在，必须搜索代码确认。**

```powershell
# 搜索配置项读取逻辑
grepSearch -query "tools\.exec\.workdir" -includePattern "src/**/*.ts"
grepSearch -query "agents\.defaults\.workspace" -includePattern "src/**/*.ts"
```

**验证点**：
- ✅ 找到配置读取代码
- ✅ 确认配置路径正确
- ❌ 如果找不到，说明配置项不存在

#### 第二步：追踪完整调用链
**从用户接口到最终使用位置，追踪参数传递链。**

**方法**：
1. 从用户接口（API/CLI）开始
2. 追踪函数调用链
3. 定位配置读取位置
4. 确认最终使用位置

**工具**：
- `grepSearch` 搜索函数调用
- `readFile` 读取关键文件
- 交叉验证调用关系

#### 第三步：交叉验证配置生效
**用 PowerShell 读取配置文件，验证系统是否使用。**

```powershell
# 读取配置文件
$config = Get-Content "C:\Users\zouta\.clawdbot\clawdbot.json" -Raw -Encoding UTF8 | ConvertFrom-Json

# 验证配置值
$config.agents.defaults.workspace
$config.tools.exec.workdir  # 如果不存在会返回 null
```

**验证点**：
- ✅ 配置文件中有此配置
- ✅ 配置值符合预期
- ✅ 系统实际使用此配置

### 常见错误

#### ❌ 错误 1：假设配置项存在
**表现**：直接添加配置，不验证代码是否读取

**后果**：配置不生效，浪费时间

**正确做法**：先搜索代码确认读取逻辑

#### ❌ 错误 2：只看配置文件，不看代码
**表现**：配置文件有值，就认为配置生效

**后果**：不知道系统实际使用哪个配置

**正确做法**：追踪调用链，确认最终使用位置

#### ❌ 错误 3：不交叉验证
**表现**：只用一种方法验证（如只看日志）

**后果**：可能被缓存或其他因素误导

**正确做法**：用 PowerShell 交叉验证配置文件

### 质量门槛

- ✅ 找到配置读取代码
- ✅ 追踪完整调用链
- ✅ 交叉验证配置生效
- ✅ 能在 10 分钟内完成验证

### 示例：exec 工具工作目录配置

**问题**：用户添加了 `tools.exec.workdir` 配置，但不生效

**验证过程**：

1. **搜索代码**：
   ```bash
   grepSearch -query "tools\.exec\.workdir" -includePattern "src/**/*.ts"
   # 结果：无匹配
   ```
   **结论**：`tools.exec.workdir` 配置不存在

2. **追踪调用链**：
   ```
   chat.ts
     ↓
   resolveAgentWorkspaceDir(cfg, agentId)
     ↓ 读取 agents.defaults.workspace
     ↓
   createClawdbotCodingTools({ workspaceDir })
     ↓
   createExecTool({ cwd: workspaceDir })
     ↓
   exec 工具执行: params.workdir || defaults.cwd || process.cwd()
   ```
   **结论**：系统使用 `agents.defaults.workspace`

3. **交叉验证**：
   ```powershell
   $config = Get-Content "C:\Users\zouta\.clawdbot\clawdbot.json" -Raw -Encoding UTF8 | ConvertFrom-Json
   $config.agents.defaults.workspace
   # 输出: C:\Users\zouta\clawd
   ```
   **结论**：配置正确，系统正确使用

---

**版本：** v20260129_3
**最后更新：** 2026-01-29
**变更：** 新增配置项验证方法论


---

## Kiro Power 创建规范 ⚠️ 极其重要

### 触发场景
创建或修复 Kiro Power 时。

### 核心规则

#### 1. 文件限制（严格）

**允许的文件**：
- ✅ `POWER.md`（必需）
- ✅ `mcp.json`（Guided MCP Power 需要）
- ✅ `steering/*.md`（可选）

**不允许的文件**：
- ❌ Python 脚本（`.py`）
- ❌ 二进制文件（`.pyc`、`.exe`、`.so`）
- ❌ 隐藏文件（`.git`、`.DS_Store`）
- ❌ 凭证文件（`.env`、`credentials.json`）
- ❌ 压缩包（`.zip`、`.tar.gz`）
- ❌ README.md（不是标准 Power 文件）

**原因**：
- Powers 是文档和配置，不是代码分发工具
- 安全考虑：避免执行不受信任的代码
- 简化管理：只需要管理文档和 MCP 配置

#### 2. POWER.md Frontmatter 格式（严格）

**必须**：
- Frontmatter 必须在文件**最开头**（第一行）
- 格式：`---\n...\n---`
- 不能有任何内容在 frontmatter 之前（包括标题、注释）

**错误示例**：
```markdown
# Safe File Editor

---
name: "safe-file-editor"
...
---
```

**正确示例**：
```markdown
---
name: "safe-file-editor"
displayName: "Safe File Editor"
description: "..."
keywords: [...]
author: "..."
---

# Safe File Editor
```

**必需字段**：
- `name`（必需）：lowercase kebab-case
- `displayName`（必需）：human-readable title
- `description`（必需）：clear, concise (max 3 sentences)

**可选字段**：
- `keywords`（推荐）：array of search terms
- `author`（推荐）：creator name or organization

**不存在的字段**（不要使用）：
- ❌ `version`
- ❌ `tags`
- ❌ `repository`
- ❌ `license`

#### 3. Power 与 Skill 的分工

**Power（说明书）**：
- 📖 提供使用指南和最佳实践
- 🔧 配置 MCP 服务器（如果需要）
- 📋 提供工作流文档
- ❌ 不包含代码

**Skill（工具箱）**：
- 🛠️ 包含实际的工具代码
- 📦 提供可执行的脚本
- 🔌 提供 Python/JavaScript 库
- 📍 位置：`.kiro/skills/`

**正确做法**：
- 代码放在 Skill 目录（`.kiro/skills/`）
- Power 提供使用指南，指向 Skill 目录
- Power 是"说明书"，Skill 是"工具箱"

**示例**：
```markdown
## 工具位置

Safe File Editor 的 Python 工具位于项目的 Skill 目录：

```
.kiro/skills/safe_file_editor/
├── safe_file_editor.py      # Python API 主类
├── quick_replace.py          # CLI 快速替换工具
└── SKILL.md                  # 完整文档
```

## 使用方法

```python
import sys
sys.path.insert(0, '.kiro/skills/safe_file_editor')
from safe_file_editor import SafeFileEditor
```
```

#### 4. Power 类型选择

**Guided MCP Power**：
- 包含 MCP 服务器配置（`mcp.json`）
- 提供 MCP 工具的使用指南
- 示例：git MCP、Supabase MCP

**Knowledge Base Power**：
- 纯文档，无 MCP 配置
- 提供工具使用指南、最佳实践、工作流
- 示例：CLI 工具指南、最佳实践文档

### 验证清单

创建 Power 后，必须验证：

- ✅ POWER.md frontmatter 在文件开头
- ✅ POWER.md 包含所有必需字段
- ✅ 只包含允许的文件（POWER.md + mcp.json + steering/*.md）
- ✅ 没有 Python 文件
- ✅ 没有二进制文件
- ✅ 没有隐藏文件
- ✅ 如果包含代码引用，指向正确的 Skill 目录

### 常见错误

#### 错误 1：包含 Python 代码

**错误**：
```
powers/my-power/
├── POWER.md
└── python/
    └── tool.py  ❌ 不允许
```

**正确**：
```
powers/my-power/
└── POWER.md  ✅ 指向 .kiro/skills/my-tool/

.kiro/skills/my-tool/
└── tool.py  ✅ 代码放在 Skill 目录
```

#### 错误 2：Frontmatter 不在开头

**错误**：
```markdown
# My Power  ❌ 标题在 frontmatter 之前

---
name: "my-power"
---
```

**正确**：
```markdown
---
name: "my-power"
---

# My Power  ✅ 标题在 frontmatter 之后
```

#### 错误 3：使用不存在的字段

**错误**：
```yaml
---
name: "my-power"
version: "1.0.0"  ❌ 不存在的字段
repository: "..."  ❌ 不存在的字段
---
```

**正确**：
```yaml
---
name: "my-power"
displayName: "My Power"
description: "..."
keywords: [...]
author: "..."
---
```

### 调试方法

#### 1. 验证 Frontmatter 格式

```powershell
# 读取文件前 10 行
Get-Content "powers/my-power/POWER.md" -Head 10 -Encoding UTF8

# 检查是否以 --- 开头
$content = Get-Content "powers/my-power/POWER.md" -Raw -Encoding UTF8
if ($content -match '^---\n') {
    Write-Host "✅ Frontmatter 格式正确"
} else {
    Write-Host "❌ Frontmatter 格式错误"
}
```

#### 2. 检查不允许的文件

```powershell
# 检查 Python 文件
Get-ChildItem "powers/my-power" -Recurse -Filter "*.py"

# 检查二进制文件
Get-ChildItem "powers/my-power" -Recurse -Filter "*.pyc"

# 检查隐藏文件
Get-ChildItem "powers/my-power" -Recurse -Force | Where-Object { $_.Name -like ".*" }
```

#### 3. 验证 Power 结构

```powershell
# 列出所有文件
Get-ChildItem "powers/my-power" -Recurse | ForEach-Object {
    $relativePath = $_.FullName.Replace((Get-Location).Path + "\", "")
    Write-Host $relativePath
}
```

### 参考资料

- **power-builder Power**：完整的 Power 创建指南
- **power-builder interactive.md**：交互式创建流程
- **power-builder testing.md**：测试和验证指南

---

**版本：** v20260129_4  
**最后更新：** 2026-01-29  
**变更：** 新增 Kiro Power 创建规范


---

## 大型项目分阶段快速开发模式 ⚠️ 新增

### 触发场景
- 项目任务数量 > 200 个
- 用户要求快速验证核心功能可行性
- 项目处于探索阶段
- 测试和文档可以后补

### 核心策略：分离核心功能与辅助任务

**核心功能任务**（必须实现）：
- 类型定义
- 核心类实现
- 接口实现
- 基础配置
- 关键逻辑

**辅助任务**（可延后）：
- 单元测试
- 集成测试
- 性能测试
- API 文档
- 使用示例
- 教程视频
- 性能优化
- 代码重构

### 执行流程

#### 第一步：任务分类
将任务分为"核心功能"和"辅助任务"两类。

#### 第二步：优先级排序
- **P0（最高优先级）**：核心类型定义、核心类实现、基础集成
- **P1（高优先级）**：错误处理、基础监控、基础文档
- **P2（中优先级）**：单元测试、集成测试、详细文档
- **P3（低优先级）**：性能优化、示例代码、教程视频

#### 第三步：分阶段执行
- **阶段 1**：只实现 P0 任务，每个阶段完成后验证编译
- **阶段 2**：实现 P1 任务，补充基础测试和文档
- **阶段 3**：实现 P2 和 P3 任务，补充完整测试和文档

#### 第四步：质量门槛
**核心功能阶段**：
- ✅ 编译通过（`pnpm tsc --noEmit`）
- ✅ 核心功能可运行
- ✅ 基础错误处理完善
- ✅ 阶段总结文档完整

**不要求**：
- ❌ 测试覆盖率
- ❌ 完整文档
- ❌ 性能优化
- ❌ 示例代码

### 实战案例：多层 Agent 架构项目

**项目背景**：
- 总任务数：329 个任务
- 预计时间：16 周（完整开发）
- 用户需求：快速验证核心功能可行性

**执行策略**：
- 只实现核心功能任务（~100 个）
- 跳过所有测试任务（~120 个）
- 跳过所有文档任务（~60 个）
- 跳过所有优化任务（~30 个）
- 跳过所有示例任务（~19 个）

**执行结果**：
- 实际完成任务：约 100 个核心任务
- 实际耗时：2-3 天（vs 16 周）
- 编译状态：✅ 通过
- 功能状态：✅ 核心功能可运行
- 效率提升：约 **95% 时间节省**（核心功能阶段）

### 使用子代理批量执行

```typescript
// 委托给子代理执行核心任务
invokeSubAgent({
  name: "general-task-execution",
  prompt: `
    执行项目的核心任务。
    
    **执行策略**：
    1. 只实现核心功能代码
    2. 跳过所有测试任务
    3. 跳过所有文档任务
    4. 跳过所有优化任务
    5. 每个阶段完成后验证编译
    6. 创建阶段完成总结
    
    **核心任务列表**：
    [列出核心任务]
  `
});
```

### 风险与缓解

**风险 1：技术债务累积**
- **缓解**：明确后续补充计划，预留足够时间

**风险 2：核心功能有 Bug**
- **缓解**：通过编译检查确保基本正确性，手动测试核心功能

**风险 3：文档缺失导致理解困难**
- **缓解**：创建阶段总结文档，添加代码注释

**风险 4：性能问题**
- **缓解**：在设计阶段考虑性能，避免明显的性能问题

### 最佳实践

1. **明确阶段目标**：每个阶段都要有明确的目标和验收标准
2. **保持沟通**：与用户保持沟通，确认优先级和阶段划分
3. **及时验证**：每个阶段完成后及时验证编译和基本功能
4. **记录决策**：记录为什么跳过某些任务，方便后续补充
5. **预留时间**：为后续阶段预留足够的时间补充测试和文档

### 适用场景

**适用**：
- ✅ 项目任务数量 > 200 个
- ✅ 用户要求快速验证可行性
- ✅ 项目处于探索阶段
- ✅ 测试和文档可以后补
- ✅ 有明确的阶段划分

**不适用**：
- ❌ 生产环境部署（必须有完整测试）
- ❌ 安全关键系统（必须有完整测试和文档）
- ❌ 团队协作项目（需要完整文档）
- ❌ 开源项目（需要完整文档和示例）

### 详细文档

完整的方法论请参考：`.kiro/lessons-learned/42_大型项目分阶段快速开发模式.md`

---

## 大型项目全面检查方法论 ⚠️ 新增

### 触发场景
- 大型项目（数百个任务、多个阶段）需要阶段性检查
- 项目交付前需要全面评估质量
- 项目遇到问题需要快速定位瓶颈
- 项目需要优化需要识别优先级

### 核心方法：六步系统化检查

**第一步：总体完成情况统计**
- 按阶段统计完成率
- 识别已完成和待完成的里程碑
- 计算总体完成率

**第二步：系统可靠性评估**
- 逐个检查核心组件
- 评分（1-5 星）
- 识别问题和建议

**第三步：流程运行状态检查**
- 检查关键流程的完整性
- 识别流程中的断点
- 评估测试覆盖情况

**第四步：细节对接检查**
- 检查多个系统之间的对接点
- 识别缺失的集成
- 评估影响和优先级

**第五步：快速优化建议**
- 按优先级分类（高、中、低）
- 估算时间和影响
- 提供具体的实施方案

**第六步：行动计划**
- 按周制定计划
- 估算总时间
- 明确交付物

### 实战案例

**项目**：多层 Agent 架构（329 个任务、8 个阶段）

**检查结果**：
- 总体完成率：92.5%
- 核心组件：7/8 完成
- 主要问题：记忆系统集成缺失、虚拟世界层转发未实现
- 优化建议：5 个高优先级、3 个中优先级
- 行动计划：3 周完成所有优化

**效果**：
- 快速识别关键问题
- 明确优化优先级
- 制定可执行的行动计划
- 预计 2-3 周完成所有工作

### 详细文档

完整的方法论请参考：`.kiro/lessons-learned/42_大型项目全面检查方法论.md`

---

**版本：** v20260131_3  
**最后更新：** 2026-01-31  
**变更：** 新增"大型项目全面检查方法论"（系统化的全面检查流程，包含六步方法和实战案例）



| **大型 Spec 项目执行** | `.kiro/lessons-learned/43_大型Spec项目执行策略.md` |

---

**版本：** v20260131_6  
**最后更新：** 2026-01-31  
**变更：** 新增"大型 Spec 项目执行策略"（41 个任务的执行前评估、持续执行、进度报告机制）
