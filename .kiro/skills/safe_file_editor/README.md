---
description: SafeFileEditor - 大型文件/规则文件“安全改写引擎”入口页（完整说明见 SKILL.md）
---

# SafeFileEditor（技能入口）

这个目录提供一个面向大文件/受限文件的安全编辑工具集，目标是让你在受限编辑环境下也能完成：

- **原样复制粘贴大段代码块**（推荐 `--code-file`，避免命令行转义与 LLM 复写差异）
- **按行号/关键字/锚点精确定位并替换**
- **批量操作可预览 Diff + 可回放**（`apply-ops --dry-run`）
- **自动备份 + 原子写入**（降低误改与写入中断风险）

## 你应该读哪个文档

- **权威指引（唯一建议维护）**：`SKILL.md`
- README 仅作为入口索引，避免与 `SKILL.md` 重复导致长期漂移。

## 常用入口

- **CLI**：`.windsurf/skills/safe_file_editor/quick_replace.py`
- **Python API**：`.windsurf/skills/safe_file_editor/safe_file_editor.py`
