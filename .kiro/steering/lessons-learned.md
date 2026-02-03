# 经验教训（索引）

> ⚠️ **注意**：详细内容已拆分到 `.kiro/lessons-learned/` 目录，按需加载。

## 快速查找

| **问题类型** | **文件** |
|---------|------|
| **LLM 无限循环** | `.kiro/lessons-learned/70_LLM行为异常的完整调试流程.md` |
| **LLM 无限循环** | `.kiro/lessons-learned/72_LLM无限循环的系统提示词修复.md` |
| **LLM 无限循环** | `.kiro/lessons-learned/73_LLM无限循环的根本解决方案.md` |
| **LLM 行为异常** | `.kiro/lessons-learned/70_LLM行为异常的完整调试流程.md` |
| **工具结果格式问题** | `.kiro/lessons-learned/71_工具结果格式问题调试方法论.md` |
| **系统提示词措辞** | `.kiro/lessons-learned/70_LLM行为异常的完整调试流程.md` |
| **14 次修复失败** | `.kiro/lessons-learned/70_LLM行为异常的完整调试流程.md` |
| **工具调用失败** | `.kiro/lessons-learned/07_AI工具使用陷阱.md` |
| **工具调用歧义** | `.kiro/lessons-learned/33_AI工具调用歧义问题处理方法论.md` |
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
| **数据流调试** | `.kiro/lessons-learned/32_数据流断点调试方法论.md` |
| **中转 API 错误** | `.kiro/lessons-learned/39_中转API错误调试方法论.md` |
| **LLM 角色扮演 vs 工具调用** | `.kiro/lessons-learned/40_LLM角色扮演与工具调用的区分.md` |
| **大型项目任务拆分** | `.kiro/lessons-learned/41_大型项目任务拆分和管理方法论.md` |
| **配置开关实现** | `.kiro/steering/always/gloab_always_workflow.md#第八章` |
| **Windows exec 命令报错** | `.kiro/lessons-learned/26_Windows_exec工具命令语法规范.md` |
| **中文文本文件乱码** | `.kiro/lessons-learned/27_中文文本文件编码问题处理.md` |
| **工具增强的包装模式** | `.kiro/lessons-learned/28_工具增强的包装模式.md` |
| **Buffer 解码编码问题** | `.kiro/lessons-learned/29_Buffer解码编码问题处理.md` |
| **AI 工具调用行为修正** | `.kiro/lessons-learned/30_AI工具调用行为修正方法论.md` |
| **全局拦截器副作用** | `.kiro/lessons-learned/31_全局拦截器副作用问题.md` |
| **全局拦截器错误处理** | `.kiro/lessons-learned/37_全局拦截器错误处理规范.md` |
| **数据流断点调试** | `.kiro/lessons-learned/32_数据流断点调试方法论.md` |
| **SessionManager 缓存问题** | `.kiro/lessons-learned/34_SessionManager缓存问题处理.md` |
| **数据提取模式** | `.kiro/lessons-learned/35_增强型数据提取模式.md` |
| **渐进式功能增强** | `.kiro/lessons-learned/36_渐进式功能增强模式.md` |
| **Agent 架构分析** | `.kiro/steering/agent-architecture-analysis.md` |
| **Hook 返回值字段遗漏** | `.kiro/lessons-learned/45_Hook返回值字段遗漏问题处理.md` |
| **路径处理智能检测** | `.kiro/lessons-learned/46_路径处理智能检测模式.md` |
| **内置 Plugin 动态注册失败** | `.kiro/lessons-learned/47_内置Plugin动态注册失败调试方法论.md` |
| **模板文件与实际使用路径区分** | `.kiro/lessons-learned/48_模板文件与实际使用路径区分.md` |
| **Provider API 兼容性问题** | `.kiro/lessons-learned/49_Provider特定API兼容性问题处理.md` |
| **工具调用验证与重试** | `.kiro/lessons-learned/50_工具调用验证与重试机制.md` |
| **系统提示词过长** | `.kiro/lessons-learned/51_系统提示词过长导致模型行为异常.md` |
| **LLM 行为异常调试** | `.kiro/lessons-learned/52_LLM行为异常调试标准流程.md` |
| **中文标点符号干扰** | `.kiro/lessons-learned/53_中文标点符号干扰LLM工具调用.md` |
| **批量文本替换** | `.kiro/lessons-learned/54_批量文本替换标准流程.md` |
| **工具 Schema 调试** | `.kiro/lessons-learned/55_工具Schema调试方法论.md` |
| **Provider 字段位置差异** | `.kiro/lessons-learned/57_Provider字段位置差异处理方法论.md` |
| **混合 API 格式混淆** | `.kiro/lessons-learned/59_混合API格式混淆调试方法论.md` |
| **Wrapper 执行顺序错误** | `.kiro/lessons-learned/60_Wrapper执行顺序设计原则.md` |
| **验证器格式支持不全** | `.kiro/lessons-learned/61_验证器与格式转换的协同设计.md` |
| **Session 格式混乱** | `.kiro/lessons-learned/62_Session格式统一原则.md` |
| **格式转换 ID 不匹配** | `.kiro/lessons-learned/63_格式转换ID一致性原则.md` |
| **格式转换不完整** | `.kiro/lessons-learned/64_格式转换完整性原则.md` |
| **多次修复无效** | `.kiro/lessons-learned/65_多次修复无效的根因分析方法论.md` |
| **字段保留失败** | `.kiro/lessons-learned/66_字段保留原则.md` |
| **字段在数据流中丢失** | `.kiro/lessons-learned/67_字段在数据流中丢失的调试方法论.md` |
| **构建系统 .buildstamp 陷阱** | `.kiro/lessons-learned/68_构建系统buildstamp陷阱.md` |

clawdbot 实际的 系统日志在 C:\Users\zouta\.clawdbot\runtimelog
clawdbot 对话内容在 C:\Users\zouta\.clawdbot\agents\main\sessions

**关键词**：LLM 无限循环、LLM 行为异常、系统提示词措辞、thinking 分析、完整数据流、14 次修复失败、AGENTS.md、会话开始时、开始做任何事之前、修复无效、打补丁、源头修复、重试绕过、数据流追踪、配置验证、schema 验证、静默失败、API 格式切换、字段兼容性、配置开关、功能开关、审批机制、Zod schema、类型定义、UI 配置、localStorage、默认值、干扰性功能、技术细节隐藏、Windows、PowerShell、CMD、exec 工具、中文路径、编码问题、命令语法、文本编码、GBK、GB2312、UTF-8、乱码、编码转换、read 工具、工具增强、包装模式、向后兼容、参数扩展、智能回退、Buffer 解码、TextDecoder、替换字符、平台差异、AI 行为修正、工具调用、平台适配、系统提示词、工具描述、命令验证、全局拦截器、fetch、副作用、上下文检查、性能优化、数据流调试、断点调试、日志追踪、数据丢失、环节定位、工具调用歧义、API 混淆、配对机制、节点配对、频道配对、无限循环、错误提示、工具设计、SessionManager、buildSessionContext、fileEntries、缓存问题、状态管理、Agent 失忆、历史消息丢失、Agent 架构、LLM 调度、System Prompt、对话历史、会话摘要、数据提取、正则表达式、模式匹配、信息提取、文本解析、渐进式开发、功能增强、可选参数、测试驱动、错误处理、try-catch、AbortError、unhandledRejection、系统崩溃、错误传播、基础设施代码、API Payload、格式错误、逐层对比、修复清单、分层修复、中转 API、官方 API、错误信息不准确、限流、配额、内部错误、切换 API、简化测试、临时故障、重试机制、等待重试、角色扮演、文本生成、工具调用混淆、用户误解、操作验证、日志检查、项目管理、任务拆分、进度追踪、大型项目、分层管理、标准化格式、任务编号、状态标记、执行指南、文件拆分、阶段管理、Hook、返回值、字段遗漏、合并逻辑、Plugin、路径处理、智能检测、路径规范化、跨平台、目录检测、路径重复、内置 Plugin、动态注册、相对路径、绝对路径、jiti、模块加载、静默失败、测试环境、真实环境、路径解析、错误处理、日志输出、Provider 兼容性、thought_signature、API 扩展字段、Gemini API、中转 API 兼容性、shouldEnable、patcher 禁用、Corrupted thought signature、vectorengine、yinli、API 格式差异、工具调用验证、工具调用重试、验证机制、重试策略、错误分类、可重试错误、不可重试错误、工具调用失败、操作验证、结果确认、缓存问题、文件系统延迟、权限问题、路径问题、系统提示词过长、模型迷失、functionCall 失败、文本模拟、最小化测试、对比测试、调试日志、LLM 行为异常、隔离变量、逐步排查、中文标点符号、中文括号、工具描述、LLM 解析、tokenizer、Unicode、标点符号干扰、批量替换、文本处理、代码清理、正则表达式替换、PowerShell 脚本、编码问题、UTF8、备份、版本控制、工具 Schema、required 字段、别名字段、patchToolSchemaForClaudeCompatibility、wrapToolParamNormalization、CLAUDE_PARAM_GROUPS、payload 提取、trace 日志、工具定义、参数验证、运行时验证、LLM 安全行为、字段位置差异、分层处理、统一添加、选择性清理、多 provider 支持、兼容性设计、混合 API、格式混淆、OpenAI endpoint、Gemini payload、payload 对比、格式转换、tool_calls、functionCall、role: assistant、role: model、role: tool、role: function、parts、content、arguments、args、functionResponse、API 格式识别、Wrapper、洋葱模型、执行顺序、数据流、payload 验证、streamFn、包装顺序、依赖关系、日志顺序、验证器、格式支持、双格式支持、多格式验证、格式检测、字段位置、误报、协同设计、验证时机、Session 格式统一、格式混乱、保存前转换、发送前转换、双向转换、可逆转换、OpenAI 格式、Gemini 格式、session 管理、数据流追踪、格式验证、构建系统、.buildstamp、pnpm build、run-node.mjs、时间戳判断、验证方法

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

**版本：** v20260130_2  
**最后更新：** 2026-01-30  
**变更：** 新增"AI 工具调用歧义问题处理方法论"（当 AI 混淆相似概念导致调用错误 API 时的系统层面修正方法）


---

**版本：** v20260130_4  
**最后更新：** 2026-01-30  
**变更：** 新增"SessionManager 缓存问题处理"（buildSessionContext 返回空数组的诊断和修复方法）和"Agent 架构分析方法论"（系统化分析 Agent 系统的标准流程）

---

**版本：** v20260130_5  
**最后更新：** 2026-01-30  
**变更：** 新增"增强型数据提取模式"（从非结构化文本中提取结构化信息的系统化方法，包括进度、计划、文件等信息的提取）

---

**版本：** v20260130_6  
**最后更新：** 2026-01-30  
**变更：** 新增"渐进式功能增强模式"（在不破坏现有功能的前提下，通过可选参数和独立实现逐步增强系统能力的方法论）



---

**版本：** v20260130_7  
**最后更新：** 2026-01-30  
**变更：** 新增"全局拦截器错误处理规范"（所有全局拦截器必须有完整的错误处理，避免 AbortError 等特殊错误传播到顶层导致系统崩溃）


---

**版本：** v20260131_6  
**最后更新：** 2026-01-31  
**变更：** 
- 新增"中转 API 错误调试方法论"（当中转 API 返回不明确错误时的系统化调试流程）
- 更新"中转 API 错误调试方法论"（新增临时故障的识别和处理）
- 新增"LLM 角色扮演与工具调用的区分"（帮助用户理解文本生成和实际操作的区别）
- 新增"大型项目任务拆分和管理方法论"（329 个任务、16 周、8 个阶段的项目管理最佳实践）
- 新增"开发前系统架构梳理方法论"（避免重复造轮子，确保正确集成到现有系统）


---

**版本：** v20260202_1  
**最后更新：** 2026-02-02  
**变更：** 新增"Hook 执行时序问题诊断和修复方法论"（当 Hook 返回值未生效时的系统化诊断和修复流程）



---

**版本：** v20260202_3  
**最后更新：** 2026-02-02  
**变更：** 新增"内置 Plugin 动态注册失败调试方法论"（当测试脚本通过但真实环境中 Plugin 完全不生效时的系统化调试流程）


---

**版本：** v20260202_4  
**最后更新：** 2026-02-02  
**变更：** 新增"模板文件与实际使用路径区分"（当项目同时包含模板文件和用户实例时的路径识别方法）


---

**版本：** v20260202_8  
**最后更新：** 2026-02-02  
**变更：** 
- 新增"中文标点符号干扰LLM工具调用"（当系统提示词中使用中文括号等特殊符号时，LLM 可能无法正确调用工具）
- 新增"批量文本替换标准流程"（使用 PowerShell 和正则表达式批量处理文本的标准化方法）


---

**版本：** v20260203_1  
**最后更新：** 2026-02-03  
**变更：** 新增"Provider 字段位置差异处理方法论"（当不同 provider 对同一字段的位置要求不同时的系统化处理方法）


---

**版本：** v20260203_1  
**最后更新：** 2026-02-03  
**变更：** 新增"Session 格式统一原则"（当系统支持多种 API 格式时，session 必须统一使用一种格式，避免格式混乱）+ 新增"字段保留原则"（工具结果中的关键字段必须保留，避免格式转换时丢失信息）


---

**版本：** v20260203_2  
**最后更新：** 2026-02-03  
**变更：** 新增"LLM 行为异常的完整调试流程"（14 次修复失败的深刻反思：必须看 LLM 的 thinking，检查系统提示词措辞，追踪完整数据流）
