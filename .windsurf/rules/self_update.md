---
trigger: always_on
---

# 规则生效路径与自我认知（SSOT）

## 1) IDE 实际生效规则（单一真相源）

本 IDE 环境中，规则的单一真相源（SSOT）为：
- `.windsurf/rules/global_rules.md`
- `.windsurf/rules/self_update.md`
- `.windsurf/rules/work_flow.md`
- `.windsurf/rules/work_style.md`

因此：
- 任何“需要让 IDE 立刻生效”的规则升级，必须写入 `.windsurf/rules/*`。

## 2) `.agent/*` 的定位（仓库内技能/参考，不等价于 IDE 生效规则）

仓库中还存在 `.agent/rules/*`、`.agent/skills/*` 等目录：
- 它们用于“仓库内部的 Skill/规则资产沉淀、可迁移备份、跨环境复用”
- 但它们**不保证**等价于本 IDE 的实际生效规则

因此：
- 不得把“写入 `.agent/rules/*`”误认为“升级了 IDE 规则”。

## 3) 规则文件写入受限时的升级通道

当 IDE 内置写入工具无法修改 `.windsurf/rules/*` 时：
- 允许使用 SafeFileEditor 作为升级通道（备份 -> 预览 -> 最小改动 -> 复核 -> 可回滚）。

关键词：SSOT、`.windsurf/rules`、SafeFileEditor、global_rules、work_flow
