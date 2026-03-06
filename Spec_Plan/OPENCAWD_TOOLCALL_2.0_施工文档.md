# OpenCAWD ToolCall 2.0 施工文档
> **面向 Claude Code 的完整软件工程施工指引**  
> 版本：2.0.0 | 状态：施工就绪

---

## 📋 目录

1. [背景与动机](#1-背景与动机)
2. [架构对比：1.0 vs 2.0](#2-架构对比)
3. [核心设计：Code-as-Tool 范式](#3-核心设计)
4. [施工任务清单](#4-施工任务清单)
5. [模块详细施工规范](#5-模块详细施工规范)
6. [数据结构定义](#6-数据结构定义)
7. [执行引擎施工](#7-执行引擎施工)
8. [安全沙箱施工](#8-安全沙箱施工)
9. [测试验收标准](#9-测试验收标准)
10. [施工顺序与里程碑](#10-施工顺序与里程碑)

---

## 1. 背景与动机

### 1.1 ToolCall 1.0 的现状与瓶颈

OpenCAWD 的当前 ToolCall 1.0 系统采用**静态注册 + 预定义调用**模式：

```
Agent → 选择预注册工具 → 填写参数 → 执行固定逻辑 → 返回结果
```

**1.0 架构的核心限制：**

| 问题 | 描述 | 影响 |
|------|------|------|
| 工具静态性 | 工具逻辑在注册时固化，无法运行时定制 | Agent 无法处理新类型任务 |
| 参数结构僵化 | JSON Schema 约束死参数类型 | 复杂逻辑无法表达 |
| 无组合能力 | 工具之间相互独立，无法编排 | 多步骤任务需要多轮交互 |
| 计算能力受限 | 工具只能做预定义操作 | 无法执行动态算法 |
| 调试困难 | 工具黑盒，执行过程不透明 | 失败时难以定位问题 |

### 1.2 ToolCall 2.0 的核心洞察

> **洞察：代码本身就是最强大的工具调用协议。**

Agent 不应该被限制在预定义工具的"菜单"里选菜，而应该能够**编写代码来构造任意工具逻辑**，然后在受控环境中执行。

```
Agent → 生成执行代码 → 沙箱执行 → 结构化返回 → 继续推理
```

这本质上是将 Agent 从**工具消费者**升级为**工具制造者**。

---

## 2. 架构对比

### 2.1 ToolCall 1.0 架构图

```
┌─────────────────────────────────────────────┐
│                   Agent LLM                  │
└──────────────────────┬──────────────────────┘
                       │ tool_call { name, args }
                       ▼
┌─────────────────────────────────────────────┐
│              Tool Registry (静态)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ tool_A   │ │ tool_B   │ │ tool_C   │    │
│  │(固定逻辑)│ │(固定逻辑)│ │(固定逻辑)│    │
│  └──────────┘ └──────────┘ └──────────┘    │
└──────────────────────┬──────────────────────┘
                       │ result
                       ▼
┌─────────────────────────────────────────────┐
│              Result Formatter                │
└─────────────────────────────────────────────┘
```

**问题：** 工具库是固定的，Agent 只能"点菜"，不能"自己做菜"。

### 2.2 ToolCall 2.0 架构图

```
┌──────────────────────────────────────────────────────┐
│                     Agent LLM                         │
│                                                        │
│  推理层：分析任务 → 决定用已有工具还是生成新工具        │
└──────┬────────────────────────────┬───────────────────┘
       │                            │
       │ 调用已注册工具               │ 生成执行代码
       ▼                            ▼
┌─────────────┐          ┌──────────────────────┐
│ 静态工具库   │          │   Code Tool Engine    │
│ (基础原语)   │          │                        │
│ • fs_read   │          │  ┌──────────────────┐  │
│ • http_get  │          │  │  代码解析 & 验证   │  │
│ • db_query  │          │  └────────┬─────────┘  │
│ • shell_run │          │           │             │
└──────┬──────┘          │  ┌────────▼─────────┐  │
       │                 │  │   安全沙箱执行     │  │
       │                 │  │  (隔离环境)        │  │
       │                 │  └────────┬─────────┘  │
       │                 │           │             │
       │                 │  ┌────────▼─────────┐  │
       │                 │  │  结果结构化 & 返回  │  │
       │                 │  └──────────────────┘  │
       │                 └──────────┬─────────────┘
       │                            │
       └─────────────┬──────────────┘
                     │
                     ▼
          ┌──────────────────┐
          │  统一结果总线      │
          │  ToolResult 2.0  │
          └──────────────────┘
```

---

## 3. 核心设计：Code-as-Tool 范式

### 3.1 新增：`code_tool` 工具类型

ToolCall 2.0 引入一种特殊的顶级工具：`code_tool`。

Agent 调用它时，不是传递普通参数，而是传递**一段可执行代码**：

```json
{
  "tool_call": {
    "type": "code_tool",
    "language": "python",
    "code": "
import json
import requests

# Agent 动态编写的逻辑
def analyze_data(data):
    results = []
    for item in data:
        if item['value'] > threshold:
            results.append(item)
    return results

output = analyze_data(input_data)
print(json.dumps({'result': output, 'count': len(output)}))
    ",
    "inputs": {
      "input_data": [...],
      "threshold": 42
    },
    "timeout": 30,
    "allowed_modules": ["json", "requests", "pandas"]
  }
}
```

### 3.2 执行流程的三个阶段

#### 阶段 A：代码生成（Agent 侧）

Agent 在系统提示词中被赋予以下能力描述：

```
你可以通过 code_tool 执行任意 Python/JavaScript 代码。
规则：
1. 使用 input_data 变量访问传入数据
2. 将结果赋值给 output 变量或用 print(json.dumps(...)) 输出
3. 可以导入 allowed_modules 中的模块
4. 执行时间限制为 timeout 秒
```

#### 阶段 B：沙箱执行（引擎侧）

```
代码接收 → 静态分析(AST) → 注入输入变量 → 沙箱运行 → 捕获输出
```

#### 阶段 C：结果回传（协议侧）

```json
{
  "tool_result": {
    "type": "code_tool_result",
    "success": true,
    "stdout": "...",
    "structured_output": {...},
    "execution_time_ms": 145,
    "error": null
  }
}
```

### 3.3 高级模式：工具组合器（Tool Composer）

2.0 的另一个核心能力：Agent 可以通过代码**组合多个静态工具**：

```python
# Agent 生成的组合工具代码
async def composed_workflow():
    # 调用静态工具1：读文件
    file_content = await tools.fs_read("/data/input.csv")
    
    # 自定义处理逻辑
    parsed = parse_csv(file_content)
    filtered = [row for row in parsed if row['status'] == 'active']
    
    # 调用静态工具2：HTTP 请求
    api_result = await tools.http_post(
        url="https://api.example.com/process",
        body={"data": filtered}
    )
    
    # 调用静态工具3：写入数据库
    await tools.db_insert("results", api_result['items'])
    
    return {"processed": len(filtered), "inserted": len(api_result['items'])}

output = await composed_workflow()
```

---

## 4. 施工任务清单

> Claude Code 请按顺序执行以下任务。每完成一项，在对应位置标记 `[x]`。

### Phase 0：准备工作（预计 30 分钟）

```
[ ] P0-1: 阅读现有 toolcall 1.0 源码，理解当前 ToolRegistry、ToolExecutor、ToolResult 结构
[ ] P0-2: 绘制现有代码的模块依赖图（输出为注释或文档）
[ ] P0-3: 确认现有测试覆盖率，记录关键测试用例
[ ] P0-4: 创建 feature/toolcall-2.0 分支
```

### Phase 1：数据结构扩展（预计 1 小时）

```
[ ] P1-1: 新增 CodeToolCall 类型定义
[ ] P1-2: 新增 CodeToolResult 类型定义
[ ] P1-3: 扩展 ToolCall union type 包含 code_tool
[ ] P1-4: 扩展 ToolResult union type 包含 code_tool_result
[ ] P1-5: 编写类型单元测试
```

### Phase 2：代码解析器（预计 2 小时）

```
[ ] P2-1: 实现 CodeParser 模块（Python AST 分析）
[ ] P2-2: 实现模块白名单验证
[ ] P2-3: 实现危险操作检测（os.system, exec, eval 等）
[ ] P2-4: 实现输入变量注入逻辑
[ ] P2-5: 编写解析器测试用例（含恶意代码测试）
```

### Phase 3：沙箱执行引擎（预计 3 小时）

```
[ ] P3-1: 选型并集成沙箱方案（RestrictedPython / subprocess隔离 / Docker）
[ ] P3-2: 实现 SandboxExecutor 类
[ ] P3-3: 实现超时控制机制
[ ] P3-4: 实现内存使用限制
[ ] P3-5: 实现 stdout/stderr 捕获
[ ] P3-6: 实现结构化输出解析
[ ] P3-7: 沙箱逃逸测试（安全审计）
```

### Phase 4：工具组合器（预计 2 小时）

```
[ ] P4-1: 设计 tools 代理对象（在沙箱内可用）
[ ] P4-2: 实现静态工具的异步代理包装
[ ] P4-3: 实现工具调用结果的上下文传递
[ ] P4-4: 编写组合工具集成测试
```

### Phase 5：Agent 系统提示词更新（预计 1 小时）

```
[ ] P5-1: 更新系统提示词，描述 code_tool 使用规范
[ ] P5-2: 添加代码工具的 few-shot 示例
[ ] P5-3: 添加安全边界说明（不允许什么操作）
[ ] P5-4: 在 Tool Schema 中注册 code_tool 定义
```

### Phase 6：集成测试与验收（预计 2 小时）

```
[ ] P6-1: 端到端测试：简单代码执行
[ ] P6-2: 端到端测试：工具组合场景
[ ] P6-3: 端到端测试：错误处理与回退
[ ] P6-4: 性能测试：并发执行
[ ] P6-5: 安全测试：边界验证
```

---

## 5. 模块详细施工规范

### 5.1 文件结构规划

```
opencawd/
├── toolcall/
│   ├── v1/                          # 保留现有 1.0（不删除）
│   │   ├── registry.py
│   │   ├── executor.py
│   │   └── types.py
│   │
│   └── v2/                          # 新建 2.0 目录
│       ├── __init__.py
│       ├── types.py                 # 扩展类型定义
│       ├── registry.py              # 兼容 1.0 + 新增 code_tool
│       ├── executor.py              # 统一执行入口
│       │
│       ├── code_engine/             # Code-as-Tool 核心引擎
│       │   ├── __init__.py
│       │   ├── parser.py            # 代码解析与验证
│       │   ├── sandbox.py           # 沙箱执行
│       │   ├── injector.py          # 变量注入
│       │   └── result_formatter.py  # 输出格式化
│       │
│       ├── composer/                # 工具组合器
│       │   ├── __init__.py
│       │   ├── tool_proxy.py        # 静态工具代理
│       │   └── workflow.py          # 工作流编排
│       │
│       └── tests/
│           ├── test_types.py
│           ├── test_parser.py
│           ├── test_sandbox.py
│           ├── test_composer.py
│           └── test_e2e.py
```

### 5.2 与现有代码的集成点

Claude Code 需要找到以下现有接口并进行扩展（而不是替换）：

```python
# 找到现有的工具分发逻辑，通常类似：
def dispatch_tool(tool_call: ToolCall) -> ToolResult:
    tool = registry.get(tool_call.name)
    return tool.execute(tool_call.args)

# 扩展为：
def dispatch_tool(tool_call: ToolCall) -> ToolResult:
    # 新增：检测是否为 code_tool
    if tool_call.type == "code_tool":
        return code_engine.execute(tool_call)  # ← 新路由
    
    # 原有逻辑保持不变
    tool = registry.get(tool_call.name)
    return tool.execute(tool_call.args)
```

---

## 6. 数据结构定义

### 6.1 TypeScript 定义（如果项目是 TS）

```typescript
// toolcall/v2/types.ts

// ===== Code Tool Call =====
export interface CodeToolCall {
  type: "code_tool";
  id: string;
  language: "python" | "javascript" | "shell";
  code: string;
  inputs?: Record<string, unknown>;
  timeout?: number;           // 秒，默认 30
  memory_limit_mb?: number;   // MB，默认 256
  allowed_modules?: string[]; // 允许 import 的模块白名单
  allow_tool_access?: boolean; // 是否允许调用静态工具
}

// ===== Code Tool Result =====
export interface CodeToolResult {
  type: "code_tool_result";
  tool_call_id: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  structured_output?: unknown;  // 解析自 stdout 的 JSON
  execution_time_ms: number;
  memory_used_mb?: number;
  error?: {
    type: "timeout" | "memory" | "security" | "runtime" | "parse";
    message: string;
    traceback?: string;
  };
}

// ===== 扩展 Union Types =====
export type ToolCall = 
  | LegacyToolCall      // 1.0 原有类型
  | CodeToolCall;       // 2.0 新增

export type ToolResult = 
  | LegacyToolResult    // 1.0 原有类型
  | CodeToolResult;     // 2.0 新增
```

### 6.2 Python 定义（如果项目是 Python）

```python
# toolcall/v2/types.py
from dataclasses import dataclass, field
from typing import Optional, Any, Literal, Union
from enum import Enum

class CodeLanguage(str, Enum):
    PYTHON = "python"
    JAVASCRIPT = "javascript"
    SHELL = "shell"

class CodeErrorType(str, Enum):
    TIMEOUT = "timeout"
    MEMORY = "memory"
    SECURITY = "security"
    RUNTIME = "runtime"
    PARSE = "parse"

@dataclass
class CodeToolCall:
    type: Literal["code_tool"] = "code_tool"
    id: str = ""
    language: CodeLanguage = CodeLanguage.PYTHON
    code: str = ""
    inputs: dict[str, Any] = field(default_factory=dict)
    timeout: int = 30
    memory_limit_mb: int = 256
    allowed_modules: list[str] = field(default_factory=list)
    allow_tool_access: bool = False

@dataclass
class CodeError:
    type: CodeErrorType
    message: str
    traceback: Optional[str] = None

@dataclass
class CodeToolResult:
    type: Literal["code_tool_result"] = "code_tool_result"
    tool_call_id: str = ""
    success: bool = False
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    structured_output: Optional[Any] = None
    execution_time_ms: int = 0
    memory_used_mb: Optional[float] = None
    error: Optional[CodeError] = None

# Union types for backward compatibility
ToolCall = Union[LegacyToolCall, CodeToolCall]
ToolResult = Union[LegacyToolResult, CodeToolResult]
```

---

## 7. 执行引擎施工

### 7.1 代码解析器（parser.py）

```python
# toolcall/v2/code_engine/parser.py
import ast
from typing import NamedTuple

class ParseResult(NamedTuple):
    is_safe: bool
    violations: list[str]
    ast_tree: ast.AST | None

# 禁止的调用列表
FORBIDDEN_CALLS = {
    "exec", "eval", "compile", "__import__",
    "open",        # 改用 allowed fs 工具
    "subprocess",  # 改用 allowed shell 工具
    "os.system", "os.popen", "os.exec",
    "socket",      # 改用 allowed http 工具
}

FORBIDDEN_ATTRIBUTES = {
    "__class__", "__bases__", "__subclasses__",
    "__builtins__", "__globals__", "__code__",
}

class SecurityVisitor(ast.NodeVisitor):
    """AST 访问器，检测危险操作"""
    
    def __init__(self):
        self.violations = []
    
    def visit_Call(self, node: ast.Call):
        # 检测直接调用
        if isinstance(node.func, ast.Name):
            if node.func.id in FORBIDDEN_CALLS:
                self.violations.append(f"禁止调用: {node.func.id}")
        
        # 检测属性调用 (os.system 等)
        if isinstance(node.func, ast.Attribute):
            full_name = self._get_attr_chain(node.func)
            for forbidden in FORBIDDEN_CALLS:
                if forbidden in full_name:
                    self.violations.append(f"禁止调用: {full_name}")
        
        self.generic_visit(node)
    
    def visit_Attribute(self, node: ast.Attribute):
        if node.attr in FORBIDDEN_ATTRIBUTES:
            self.violations.append(f"禁止访问属性: {node.attr}")
        self.generic_visit(node)
    
    def visit_Import(self, node: ast.Import):
        # Import 检查由 injector 的白名单处理
        pass
    
    def _get_attr_chain(self, node) -> str:
        if isinstance(node, ast.Attribute):
            return f"{self._get_attr_chain(node.value)}.{node.attr}"
        if isinstance(node, ast.Name):
            return node.id
        return ""


def parse_and_validate(
    code: str,
    allowed_modules: list[str]
) -> ParseResult:
    """
    解析代码并进行安全验证
    返回 ParseResult，包含是否安全和违规列表
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return ParseResult(False, [f"语法错误: {e}"], None)
    
    visitor = SecurityVisitor()
    visitor.visit(tree)
    
    # 检查 import 语句是否在白名单内
    import_violations = _check_imports(tree, allowed_modules)
    
    all_violations = visitor.violations + import_violations
    
    return ParseResult(
        is_safe=len(all_violations) == 0,
        violations=all_violations,
        ast_tree=tree if len(all_violations) == 0 else None
    )


def _check_imports(tree: ast.AST, allowed: list[str]) -> list[str]:
    violations = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split('.')[0] not in allowed:
                    violations.append(f"未授权模块: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module.split('.')[0] not in allowed:
                violations.append(f"未授权模块: {module}")
    return violations
```

### 7.2 沙箱执行器（sandbox.py）

```python
# toolcall/v2/code_engine/sandbox.py
import json
import time
import signal
import traceback
from io import StringIO
from contextlib import redirect_stdout, redirect_stderr
from typing import Any

from .types import CodeToolCall, CodeToolResult, CodeError, CodeErrorType


class TimeoutError(Exception):
    pass


def _timeout_handler(signum, frame):
    raise TimeoutError("执行超时")


class SandboxExecutor:
    """
    受控沙箱执行器
    
    安全机制：
    1. 白名单模块控制
    2. 执行超时
    3. 内存限制（通过 resource 模块）
    4. 受限内置函数
    5. 隔离的全局命名空间
    """
    
    # 允许的内置函数白名单
    SAFE_BUILTINS = {
        'abs', 'all', 'any', 'bool', 'chr', 'dict', 'dir',
        'divmod', 'enumerate', 'filter', 'float', 'format',
        'frozenset', 'getattr', 'hasattr', 'hash', 'help',
        'hex', 'int', 'isinstance', 'issubclass', 'iter',
        'len', 'list', 'map', 'max', 'min', 'next', 'oct',
        'ord', 'pow', 'print', 'range', 'repr', 'reversed',
        'round', 'set', 'slice', 'sorted', 'str', 'sum',
        'tuple', 'type', 'vars', 'zip',
        # 数学
        'abs', 'round', 'pow',
        # 类型检查
        'callable', 'id', 'isinstance',
    }
    
    def execute(self, tool_call: CodeToolCall) -> CodeToolResult:
        start_time = time.time()
        
        # 构建受限的执行环境
        safe_globals = self._build_safe_globals(tool_call)
        safe_locals = dict(tool_call.inputs or {})
        
        stdout_capture = StringIO()
        stderr_capture = StringIO()
        
        # 设置超时
        signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(tool_call.timeout)
        
        try:
            with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
                exec(tool_call.code, safe_globals, safe_locals)
            
            signal.alarm(0)  # 取消超时
            
            stdout = stdout_capture.getvalue()
            
            # 尝试从 locals 获取 output 变量
            structured_output = safe_locals.get('output', None)
            
            # 如果没有 output 变量，尝试解析 stdout 为 JSON
            if structured_output is None and stdout.strip():
                try:
                    structured_output = json.loads(stdout.strip())
                except json.JSONDecodeError:
                    pass
            
            return CodeToolResult(
                type="code_tool_result",
                tool_call_id=tool_call.id,
                success=True,
                stdout=stdout,
                stderr=stderr_capture.getvalue(),
                structured_output=structured_output,
                execution_time_ms=int((time.time() - start_time) * 1000),
            )
        
        except TimeoutError:
            signal.alarm(0)
            return CodeToolResult(
                type="code_tool_result",
                tool_call_id=tool_call.id,
                success=False,
                execution_time_ms=int((time.time() - start_time) * 1000),
                error=CodeError(
                    type=CodeErrorType.TIMEOUT,
                    message=f"执行超时（限制 {tool_call.timeout} 秒）"
                )
            )
        
        except Exception as e:
            signal.alarm(0)
            return CodeToolResult(
                type="code_tool_result",
                tool_call_id=tool_call.id,
                success=False,
                execution_time_ms=int((time.time() - start_time) * 1000),
                error=CodeError(
                    type=CodeErrorType.RUNTIME,
                    message=str(e),
                    traceback=traceback.format_exc()
                )
            )
    
    def _build_safe_globals(self, tool_call: CodeToolCall) -> dict:
        """构建受限的全局命名空间"""
        
        # 受限的 __builtins__
        safe_builtins = {
            name: __builtins__[name]
            for name in self.SAFE_BUILTINS
            if name in __builtins__
        }
        
        globals_dict = {
            '__builtins__': safe_builtins,
            '__name__': '__sandbox__',
        }
        
        # 注入允许的模块
        for module_name in (tool_call.allowed_modules or []):
            try:
                globals_dict[module_name] = __import__(module_name)
            except ImportError:
                pass
        
        return globals_dict
```

### 7.3 统一执行入口（executor.py）

```python
# toolcall/v2/executor.py
from .types import ToolCall, ToolResult, CodeToolCall
from .code_engine.parser import parse_and_validate
from .code_engine.sandbox import SandboxExecutor
from ..v1.executor import LegacyExecutor  # 保持 1.0 向后兼容

class ToolExecutor:
    """
    ToolCall 2.0 统一执行器
    自动路由：code_tool → 新引擎，其他 → 1.0 引擎
    """
    
    def __init__(self):
        self.legacy_executor = LegacyExecutor()
        self.sandbox = SandboxExecutor()
    
    def execute(self, tool_call: ToolCall) -> ToolResult:
        # 路由到代码执行引擎
        if isinstance(tool_call, dict) and tool_call.get('type') == 'code_tool':
            tool_call = CodeToolCall(**tool_call)
        
        if isinstance(tool_call, CodeToolCall):
            return self._execute_code_tool(tool_call)
        
        # 回退到 1.0 引擎（向后兼容）
        return self.legacy_executor.execute(tool_call)
    
    def _execute_code_tool(self, tool_call: CodeToolCall) -> ToolResult:
        # Step 1: 安全验证
        parse_result = parse_and_validate(
            tool_call.code,
            tool_call.allowed_modules or []
        )
        
        if not parse_result.is_safe:
            from .types import CodeToolResult, CodeError, CodeErrorType
            return CodeToolResult(
                type="code_tool_result",
                tool_call_id=tool_call.id,
                success=False,
                error=CodeError(
                    type=CodeErrorType.SECURITY,
                    message=f"代码安全检查失败: {'; '.join(parse_result.violations)}"
                )
            )
        
        # Step 2: 沙箱执行
        return self.sandbox.execute(tool_call)
```

---

## 8. 安全沙箱施工

### 8.1 安全威胁模型

在施工沙箱时，Claude Code 需要防御以下攻击向量：

```
威胁1：模块导入逃逸
  示例: import os; os.system("rm -rf /")
  防御: 模块白名单 + AST 静态分析

威胁2：内置函数滥用
  示例: eval("__import__('os').system(...)")  
  防御: 替换 __builtins__ 为白名单版本

威胁3：对象属性遍历
  示例: ().__class__.__bases__[0].__subclasses__()
  防御: 禁止 __dunder__ 属性访问

威胁4：无限循环/资源耗尽
  示例: while True: pass
  防御: 执行超时 + 内存限制

威胁5：写文件攻击
  示例: open("/etc/passwd", "w")
  防御: 禁止 open() 内置函数（提供 fs 工具替代）
```

### 8.2 Docker 沙箱（生产级方案）

对于生产环境，推荐使用 Docker 隔离：

```python
# toolcall/v2/code_engine/docker_sandbox.py
import docker
import json
import tempfile
import os

class DockerSandboxExecutor:
    """
    生产级 Docker 沙箱
    每次执行在独立容器中运行，完全隔离
    """
    
    DOCKER_IMAGE = "opencawd-sandbox:latest"  # 预构建的受限镜像
    
    def __init__(self):
        self.client = docker.from_env()
    
    def execute(self, tool_call: CodeToolCall) -> CodeToolResult:
        # 将代码和输入写入临时文件
        with tempfile.TemporaryDirectory() as tmpdir:
            code_file = os.path.join(tmpdir, "code.py")
            input_file = os.path.join(tmpdir, "input.json")
            
            # 包装代码，注入输入变量
            wrapped_code = self._wrap_code(tool_call.code)
            with open(code_file, 'w') as f:
                f.write(wrapped_code)
            
            with open(input_file, 'w') as f:
                json.dump(tool_call.inputs or {}, f)
            
            try:
                container = self.client.containers.run(
                    self.DOCKER_IMAGE,
                    command=f"python /workspace/code.py",
                    volumes={tmpdir: {'bind': '/workspace', 'mode': 'ro'}},
                    mem_limit=f"{tool_call.memory_limit_mb}m",
                    cpu_period=100000,
                    cpu_quota=50000,    # 50% CPU
                    network_mode='none', # 无网络访问
                    read_only=True,
                    remove=True,
                    detach=False,
                    timeout=tool_call.timeout,
                    stderr=True,
                )
                
                # 解析输出
                output_str = container.decode('utf-8')
                return self._parse_output(tool_call.id, output_str)
                
            except docker.errors.ContainerError as e:
                return CodeToolResult(
                    success=False,
                    error=CodeError(
                        type=CodeErrorType.RUNTIME,
                        message=str(e)
                    )
                )
    
    def _wrap_code(self, user_code: str) -> str:
        return f"""
import json, sys

# 读取输入
with open('/workspace/input.json') as f:
    _inputs = json.load(f)

# 注入输入变量
for _k, _v in _inputs.items():
    globals()[_k] = _v

# 执行用户代码
{user_code}

# 如果有 output 变量，输出它
if 'output' in dir():
    print(json.dumps({{"__output__": output}}))
"""
```

---

## 9. 测试验收标准

### 9.1 功能测试用例

Claude Code 必须确保以下测试全部通过：

```python
# tests/test_e2e.py

class TestToolCall2E2E:
    
    def test_basic_python_execution(self):
        """基础 Python 代码执行"""
        call = CodeToolCall(
            code="output = 1 + 1",
            language="python"
        )
        result = executor.execute(call)
        assert result.success == True
        assert result.structured_output == 2
    
    def test_input_injection(self):
        """输入变量注入"""
        call = CodeToolCall(
            code="output = [x * 2 for x in numbers]",
            inputs={"numbers": [1, 2, 3, 4, 5]}
        )
        result = executor.execute(call)
        assert result.structured_output == [2, 4, 6, 8, 10]
    
    def test_json_stdout_parsing(self):
        """从 stdout 解析 JSON 输出"""
        call = CodeToolCall(
            code='import json; print(json.dumps({"key": "value"}))',
            allowed_modules=["json"]
        )
        result = executor.execute(call)
        assert result.structured_output == {"key": "value"}
    
    def test_timeout_enforcement(self):
        """超时控制"""
        call = CodeToolCall(
            code="while True: pass",
            timeout=2
        )
        result = executor.execute(call)
        assert result.success == False
        assert result.error.type == "timeout"
    
    def test_security_module_blocking(self):
        """模块白名单安全控制"""
        call = CodeToolCall(
            code="import os; os.system('ls')",
            allowed_modules=["json"]  # os 不在白名单
        )
        result = executor.execute(call)
        assert result.success == False
        assert result.error.type == "security"
    
    def test_security_eval_blocking(self):
        """危险内置函数阻断"""
        call = CodeToolCall(
            code="eval('1+1')"
        )
        result = executor.execute(call)
        assert result.success == False
        assert result.error.type == "security"
    
    def test_backward_compatibility(self):
        """向后兼容：1.0 工具仍然正常工作"""
        legacy_call = LegacyToolCall(name="fs_read", args={"path": "/test"})
        result = executor.execute(legacy_call)
        # 验证 1.0 工具未受影响
        assert isinstance(result, LegacyToolResult)
    
    def test_complex_data_processing(self):
        """复杂数据处理场景"""
        call = CodeToolCall(
            code="""
data = input_records
total = sum(r['amount'] for r in data if r['status'] == 'completed')
output = {"total": total, "count": len(data)}
            """,
            inputs={
                "input_records": [
                    {"amount": 100, "status": "completed"},
                    {"amount": 200, "status": "pending"},
                    {"amount": 150, "status": "completed"},
                ]
            }
        )
        result = executor.execute(call)
        assert result.structured_output == {"total": 250, "count": 3}
```

### 9.2 验收门槛

| 指标 | 最低要求 | 目标 |
|------|---------|------|
| 单元测试覆盖率 | ≥ 80% | ≥ 90% |
| 安全测试通过率 | 100% | 100% |
| 基础执行延迟 | < 500ms | < 200ms |
| 超时响应延迟 | timeout + 1s | timeout + 0.5s |
| 1.0 兼容测试 | 100% 通过 | 100% 通过 |
| 并发执行 | 10 并发无错误 | 50 并发无错误 |

---

## 10. 施工顺序与里程碑

### 10.1 推荐执行顺序

```
Day 1：基础设施
  ├── P0: 环境准备 & 代码阅读
  ├── P1: 数据结构定义
  └── P2: 代码解析器（含安全测试）

Day 2：核心引擎
  ├── P3: 沙箱执行引擎
  └── P4: 工具组合器

Day 3：集成 & 验收
  ├── P5: Agent 提示词更新
  └── P6: 集成测试 & 验收
```

### 10.2 关键决策点

在施工过程中，Claude Code 需要在以下位置做出架构决策：

```
决策1 [P3-1]：沙箱方案选型
  选项A: RestrictedPython（纯 Python，轻量，适合低风险场景）
  选项B: subprocess 隔离（进程级隔离，中等安全）
  选项C: Docker 容器（最安全，有额外 overhead）
  → 建议：开发环境用 A，生产环境用 C

决策2 [P4-1]：工具代理设计
  选项A: 同步代理（简单，但阻塞）
  选项B: 异步代理（复杂，但高性能）
  → 建议：根据现有代码库的 async 情况决定

决策3 [P5-4]：工具 Schema 位置
  选项A: 在现有 tools 数组中新增 code_tool 定义
  选项B: 作为独立的系统级能力，不通过 tools 数组暴露
  → 建议：选项 A，保持接口统一性
```

### 10.3 Claude Code 施工注意事项

1. **不要删除 1.0 代码** — 2.0 必须完全向后兼容，1.0 的工具继续工作
2. **先写测试，再写实现** — 安全相关代码尤其重要
3. **每个 Phase 完成后提交一次** — 便于回滚
4. **沙箱逃逸测试必须在真实环境跑** — 不要只跑单元测试
5. **关注错误消息质量** — Agent 看到错误时需要能理解并修正代码

---

## 附录：Agent 系统提示词更新模板

在 Phase 5 施工时，将以下内容添加到 Agent 的系统提示词：

```
## 高级工具调用：code_tool

除了常规工具外，你还可以使用 code_tool 执行任意代码来完成复杂任务。

### 使用场景
- 需要复杂数据处理或计算时
- 需要组合多个操作时
- 预定义工具无法满足需求时

### 使用规范

```json
{
  "type": "code_tool",
  "language": "python",
  "code": "# 你的代码\noutput = ...",
  "inputs": {"变量名": 值},
  "allowed_modules": ["json", "math"],
  "timeout": 30
}
```

### 规则
1. 将结果赋值给 `output` 变量，或用 `print(json.dumps(...))` 输出
2. 只能 import 你在 `allowed_modules` 中声明的模块
3. 不能使用 `exec`, `eval`, `open`, `os.system` 等危险操作
4. 代码必须在 `timeout` 秒内完成

### 示例：数据聚合

```json
{
  "type": "code_tool",
  "code": "output = {'total': sum(r['amount'] for r in records), 'avg': sum(r['amount'] for r in records) / len(records)}",
  "inputs": {"records": [{"amount": 100}, {"amount": 200}]},
  "allowed_modules": []
}
```
```

---

*文档版本：2.0.0 | 创建时间：2026-03-06 | 适用项目：OpenCAWD*
