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
