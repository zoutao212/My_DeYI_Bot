
# Plan（/plan-mode）

> 说明：本文件由 /plan-mode 工作流在 Phase 2 生成并持续维护。

## Phase 1 研究结论摘要

- 当前 Cognito Core 的系统提示词依赖多个 markdown/txt 文件（核心身份、人物卡、世界书等），每次需要人工编辑才会生效，无法支撑 AI 自主迭代提示词。
- 需要在 `VirtualWorld/99_System/docs_editor` 构建“安全文本编辑服务”，让外部 LLM 返回的修改指令可以经由 Cognito Core Server 自动执行，支持创建/删除/局部替换并自动备份。
- 前端（cognito.html）要新增“允许修改提示词文件”勾选项，并在发送请求时带上开关；Server 在解析 LLM 响应时需识别“文本编辑操作”并调用新的 docs_editor API。

### 风险 / 不确定点

1. LLM 如何描述文本编辑操作？需要定义 DSL（例如 ` ```doc-edit {"path": ..., "operations": [...]}```）。
2. 执行权限与路径安全：必须限定在白名单目录，且需要备份/回滚策略。
3. 如何在 UI 暴露执行结果与失败信息，避免静默失败。

### 进入 Phase 2 的结论

- 需求目标、范围、成功标准已清晰，可进入方案规划。

## Phase 2 计划

1. **docs_editor 服务蓝图**：
   - 在 `VirtualWorld/99_System/docs_editor` 设计模块化目录结构（`backup.py`, `operations.py`, `api.py` 等），实现按路径白名单、自动备份、原子写入、CRLF/LF 保持的基础能力。
   - 参考 SafeFileEditor 的操作模型，抽象统一的 `FileOperation`（insert/replace/delete/append）与批处理执行。

2. **文本编辑 DSL & 解析器**：
   - 定义 ` ```doc-edit {...}``` ` 代码块 schema，包括 `path`、`encoding`、`mode`、`operations`（支持 anchor、line_range、regex）。
   - 在 `cognito_core/engines/response_parser.py` 新增 `OperationType.DOC_EDIT` 与 Schema 校验，输出结构化 payload。

3. **Server 侧执行链路**：
   - 新建 `docs_editor` 包下的 `service.py` + `executor.py`，提供 `apply_edit_instruction(instruction: Dict)`，内部调用备份、文件锁、差异报告。
   - 在 `server/cognito_api.py` 的 `/process-response` 流程中，当 parser 返回 `DOC_EDIT` 操作时调用 docs_editor executor；执行结果纳入 OperationResult。

4. **前端 UI & API 入参**：
   - 在 `server/templates/cognito.html` 的提交区新增“允许自动修改系统提示文件”开关，默认关闭，并在 JS 请求体加入 `allow_doc_edits`。
   - 在 `cognito_prompt_sources.js` 或主要请求脚本中，发送请求时附带开关状态；Server 若未勾选则忽略 LLM doc-edit 指令。

5. **安全性 & 可观测性**：
   - 维护 `docs_editor/config/allowed_paths.yaml`，限制可写目录，支持相对路径解析。
   - 为每次操作写入日志（包含 diff 摘要、耗时、AI session id），并在 UI 操作日志面板展示最新修改记录。

6. **验证 & 回滚策略**：
   - 编写单元测试覆盖 DSL 解析、基本操作（局部替换、整段重写、失败回滚）。
   - 在手动验证脚本中对示例 prompt 文件执行往返测试，确认文件内容、备份、UI 控制链条正常。
