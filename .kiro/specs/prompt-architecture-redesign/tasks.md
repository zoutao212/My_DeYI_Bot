# 提示词加载架构重设计 — 任务清单

## Phase 1：统一加载器（消除冗余）

- [x] 1.1 对齐 `FullCharacterConfig` 类型，确保覆盖 `lina/config/loader.ts` 的 `CharacterConfig` 所有字段
- [x] 1.2 修改 `buildEmbeddedSystemPrompt`（system-prompt.ts）：删除 import 和角色加载代码块，精简为 commonParams + 分层返回
- [x] 1.3 修改 `lina/agent.ts`：改用 `CharacterService` 替代自己的 loader
- [x] 1.4 删除 `src/agents/lina/config/loader.ts`
- [x] 1.5 删除 `src/agents/lina/prompts/system-prompt-generator.ts`
- [x] 1.6 `pnpm build` 通过（待运行 `pnpm test`）

## Phase 2：延迟渲染 + 统一模板引擎

- [x] 2.1 新建 `src/agents/pipeline/characters/template-engine.ts`（`TemplateContext` 接口 + `renderTemplate` + `buildTemplateContextFromCharacter`）
- [x] 2.2 修改 `CharacterService.loadCharacter()`：返回 `rawTemplate` + 保留 `formattedSystemPrompt` 向后兼容
- [x] 2.3 修改 `CharacterService.formatSystemPrompt()`：改用 `renderTemplate()`
- [x] 2.4 在 `persona-injector.ts` 增加 `renderPersonaWithContext(loaded, memoryContext)` 方法
- [x] 2.5 修改 `attempt.ts`：延迟渲染 + workspace 文件过滤
- [x] 2.6 `pnpm build` 通过

## Phase 3：Workspace 文件冲突协调

- [x] 3.1 在 `FullCharacterConfig` 增加 `overrides?: Record<string, boolean>` 字段
- [x] 3.2 在 `LoadedCharacter` 增加 `overridesWorkspaceFiles: string[]` 字段
- [x] 3.3 `CharacterService.loadCharacter()` 读取 `config.overrides`，填充 `overridesWorkspaceFiles`
- [x] 3.4 修改 `attempt.ts`：根据 `overridesWorkspaceFiles` 过滤 contextFiles（如 SOUL.md）
- [x] 3.5 更新 lina 的 `config.json`，增加 `overrides` + `files` 字段
- [x] 3.6 `pnpm build` 通过

## Phase 4：persona.md 拆分（可选）

- [x] 4.1 在 `config.json` 的 `files` 字段增加 `"persona": "persona.md"` 条目
- [x] 4.2 `CharacterService` 增加 `loadPersona(characterDir)` 方法（解析 Markdown sections）
- [x] 4.3 渲染模板时 `{personality}` 等变量优先从 `persona.md` 读取
- [x] 4.4 向后兼容：`persona.md` 不存在时 fallback 到 `config.json` 的 `systemPrompt.personality`
- [x] 4.5 为 lina 创建 `persona.md` 示例文件
- [x] 4.6 `pnpm build` 通过

## 文档更新

- [x] D.1 编写提示词文件夹管理指南（新文档）
- [ ] D.2 更新 `clawd/PATHS.md` 中的路径说明（增加 persona.md 说明）
- [ ] D.3 更新 `ProjectMemory/00_索引/` 相关代码地图
