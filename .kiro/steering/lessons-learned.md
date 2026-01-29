# 经验教训（索引）

> ⚠️ **注意**：详细内容已拆分到 `.kiro/lessons-learned/` 目录，按需加载。

## 快速查找

| 问题类型 | 文件 |
|---------|------|
| **工具调用失败** | `.kiro/lessons-learned/07_AI工具使用陷阱.md` |
| **构建后不生效** | `.kiro/lessons-learned/10_构建验证流程.md` |
| **配置不生效** | `.kiro/lessons-learned/12_配置项验证方法论.md` |
| **配置验证** | `.kiro/lessons-learned/19_配置项验证方法论.md` |
| **创建 Power 失败** | `.kiro/lessons-learned/13_Kiro_Power创建规范.md` |
| **代码与注释不一致** | `.kiro/lessons-learned/14_代码与注释一致性验证.md` |
| **重试机制设计错误** | `.kiro/lessons-learned/15_重试机制设计最佳实践.md` |
| **外部 API 报错调试** | `.kiro/lessons-learned/16_外部API报错调试方法论.md` |
| **分析后不修复** | `.kiro/lessons-learned/17_分析到修复的完整闭环.md` |
| **检索不到结果** | `.kiro/lessons-learned/01_记忆检索系统.md` |
| **数据库设计** | `.kiro/lessons-learned/02_数据库设计.md` |
| **批处理脚本问题** | `.kiro/lessons-learned/03_脚本和路径.md` |
| **前端不更新** | `.kiro/lessons-learned/08_前端调试.md` |
| **供应商 API 报错** | `.kiro/lessons-learned/11_供应商API兼容性.md` |
| **外部 API 报错** | `.kiro/lessons-learned/16_外部API报错调试方法论.md` |
| **修复无效** | `.kiro/lessons-learned/18_修复无效的根因分析方法论.md` |
| **配置验证** | `.kiro/lessons-learned/19_配置项验证方法论.md` |
| **API 格式切换** | `.kiro/lessons-learned/20_API格式切换验证方法论.md` |
| **UI 配置问题** | `.kiro/lessons-learned/21_UI配置问题定位方法论.md` |
| **配置开关实现** | `.kiro/steering/always/gloab_always_workflow.md#第八章` |
| **Windows exec 命令报错** | `.kiro/lessons-learned/26_Windows_exec工具命令语法规范.md` |
| **中文文本文件乱码** | `.kiro/lessons-learned/27_中文文本文件编码问题处理.md` |
| **工具增强的包装模式** | `.kiro/lessons-learned/28_工具增强的包装模式.md` |

**关键词**：修复无效、打补丁、源头修复、重试绕过、数据流追踪、配置验证、schema 验证、静默失败、API 格式切换、字段兼容性、配置开关、功能开关、审批机制、Zod schema、类型定义、UI 配置、localStorage、默认值、干扰性功能、技术细节隐藏、Windows、PowerShell、CMD、exec 工具、中文路径、编码问题、命令语法、文本编码、GBK、GB2312、UTF-8、乱码、编码转换、read 工具、工具增强、包装模式、向后兼容、参数扩展、智能回退

## 使用方法

### 方式 1：查看索引（推荐）

打开 `.kiro/lessons-learned/README.md` 查看完整索引和关键词列表。

### 方式 2：关键词搜索

```powershell
grepSearch -query "关键词" -includePattern ".kiro/lessons-learned/**/*.md"
```

### 方式 3：激活 Power

激活 `lessons-learned` Power，使用关键词搜索和按需加载。

## 最重要的经验（必读）

### 0. 分析后必须立即修复 ⚠️ **最重要！**

**问题**：找到了根本原因，但停留在分析阶段，没有修复代码

**错误做法**：
- 写了详细的分析报告
- 创建了对比文档
- 但没有修复代码

**正确做法**：
1. 分析问题 → 找到根因
2. **立即修复代码**（不要停留在分析）
3. 构建验证
4. 创建修复文档

**教训**：
- 分析是手段，修复才是目的
- 用户期望的是"解决问题"，不是"分析问题"
- 找到问题后，立即动手修复

**详见**：`.kiro/lessons-learned/17_分析到修复的完整闭环.md`

### 1. 工具调用必须验证 ⚠️

**问题**：工具调用显示成功，但文件没有实际修改

**解决**：每次修改后用 PowerShell 验证

**详见**：`.kiro/lessons-learned/07_AI工具使用陷阱.md`

### 2. 构建后必须验证 ⚠️

**问题**：修改了源码，但运行时没有变化

**解决**：运行 `Build-All.cmd`，验证 `dist/` 时间戳和内容

**详见**：`.kiro/lessons-learned/10_构建验证流程.md`

### 3. 配置项必须验证 ⚠️

**问题**：添加了配置，但系统没有使用

**解决**：搜索代码确认读取逻辑，追踪调用链，交叉验证

**详见**：`.kiro/lessons-learned/12_配置项验证方法论.md`

### 4. Power 创建必须遵守规范 ⚠️

**问题**：创建的 Power 无法安装

**解决**：只包含允许的文件，frontmatter 在开头，代码放 Skill 目录

**详见**：`.kiro/lessons-learned/13_Kiro_Power创建规范.md`

## 完整索引

查看 `.kiro/lessons-learned/README.md` 获取完整的文件列表和关键词索引。

---

**版本：** v20260129_15  
**最后更新：** 2026-01-29  
**变更：** 新增"工具增强的包装模式"（在不破坏现有功能的前提下增强工具的通用方法）
