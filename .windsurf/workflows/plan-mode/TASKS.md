
# Task List（/plan-mode）

> 说明：本文件由 /plan-mode 工作流在 Phase 2 生成并持续维护。

## Tasks

1. **docs_editor 核心服务实现**
   - 输入：docs_editor 目录、现有 SafeFileEditor 设计、提示词文件白名单。
   - 输出：`docs_editor` 包含 `backup.py/operations.py/service.py`，支持 insert/replace/delete/append、自动备份、原子写入、换行保持。
   - 验证：针对示例 txt/md 执行 CRUD，检查备份生成与内容一致。

2. **doc-edit DSL 与解析扩展**
   - 输入：ResponseParser/OperationType 现状、需求 DSL 规格。
   - 输出：`OperationType.DOC_EDIT`、Schema 校验逻辑、结构化 payload。
   - 验证：单元测试覆盖合法/非法指令解析。

3. **Server 执行链路集成**
   - 输入：`/process-response` 流程、docs_editor 服务接口。
   - 输出：当检测到 DOC_EDIT 且允许执行时调用 docs_editor，记录 OperationResult。
   - 验证：模拟响应触发执行，查看日志与文件改动。

4. **前端 UI 与请求开关**
   - 输入：`cognito.html`、相关 JS。
   - 输出：新增“允许自动修改提示词文件”勾选框，JS 请求体附带 `allow_doc_edits`。
   - 验证：勾选与否在网络请求 payload 中正确体现。

5. **安全/审计与配置**
   - 输入：允许路径、日志需求。
   - 输出：`allowed_paths.yaml`、日志记录（diff、session、耗时）、UI 操作日志展示。
   - 验证：非白名单路径被拒绝并有错误提示；日志文件可查看。

6. **测试与回滚策略验证**
   - 输入：示例 prompt 文件、单元测试框架。
   - 输出：DSL/服务/集成测试用例、手动回归脚本。
   - 验证：测试全部通过，示例文件可正确回滚。

7. **Phase2→Phase3 自动倒计时（10s）**
   - 输入：`countdown.py` 脚本。
   - 输出：运行 10 秒倒计时，结束即进入 Phase 3。
   - 验证：终端输出倒计时并完成。
