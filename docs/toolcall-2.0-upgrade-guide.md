# OpenCAWD ToolCall 2.0 升级指南

> 从静态工具调用升级到动态代码执行和工具组合

## 📋 概述

ToolCall 2.0 是 OpenCAWD 系统的重大架构升级，将 Agent 从**工具消费者**升级为**工具制造者**。通过 Code-as-Tool 范式，Agent 可以动态生成代码来构造任意工具逻辑，并在受控环境中执行。

## 🔄 核心变化

### 1.0 → 2.0 架构对比

| 特性 | ToolCall 1.0 | ToolCall 2.0 |
|------|-------------|-------------|
| 工具定义 | 静态注册 | 动态代码生成 |
| 参数结构 | 固定 JSON Schema | 灵活代码逻辑 |
| 组合能力 | 无 | 完整工具编排 |
| 计算能力 | 预定义操作 | 任意算法实现 |
| 调试能力 | 黑盒执行 | 完整执行日志 |

## 🛠️ 新增组件

### 1. Code Tool Engine (`code-tool-engine.ts`)

**核心执行引擎**，负责：
- 代码静态分析（安全检查、语法验证）
- 沙箱环境执行（进程隔离、资源限制）
- 结果结构化处理（JSON 解析、错误处理）

```typescript
const engine = new CodeToolEngine();
const result = await engine.execute({
  language: 'python',
  code: 'output = [x for x in inputs.data if x > threshold]',
  inputs: { data: [1, 5, 10], threshold: 3 },
  timeout: 30
});
```

### 2. Code Tool (`code-tool.ts`)

**Agent 可调用的代码执行工具**：
- 支持 Python、JavaScript、TypeScript
- 安全沙箱执行
- 模块白名单控制
- 超时和内存限制

```json
{
  "tool_call": {
    "name": "code_tool",
    "parameters": {
      "language": "python",
      "code": "result = analyze_data(inputs)",
      "inputs": {"data": [...]},
      "timeout": 60,
      "allowed_modules": ["pandas", "numpy"]
    }
  }
}
```

### 3. Tool Composer (`tool-composer.ts`)

**工具组合编排器**，实现：
- 多工具工作流编排
- 异步工具调用管理
- 执行日志和错误追踪
- 预定义组合模板

```typescript
const composer = new ToolComposer();
const result = await composer.executeComposition(config, inputs);
```

### 4. Tool Composer Tool (`tool-composer-tool.ts`)

**Agent 可调用的组合管理工具**：
- 列出可用组合
- 执行预定义组合
- 创建自定义组合

## 🚀 快速开始

### 1. 启用 ToolCall 2.0

在 `createClawdbotTools` 调用时添加配置：

```typescript
const tools = createClawdbotTools({
  // ... 其他配置
  toolCallV2: {
    enableCodeTool: true,        // 启用代码工具
    enableToolComposer: true,   // 启用工具组合器
  }
});
```

### 2. Agent 使用示例

#### 基础代码执行

```python
# Agent 生成的代码
import json

def analyze_sentiment(text):
    # 简单的情感分析逻辑
    positive_words = ['好', '棒', '优秀', '满意']
    negative_words = ['差', '糟', '失望', '不满']
    
    pos_count = sum(1 for word in positive_words if word in text)
    neg_count = sum(1 for word in negative_words if word in text)
    
    if pos_count > neg_count:
        return 'positive'
    elif neg_count > pos_count:
        return 'negative'
    else:
        return 'neutral'

# 处理输入数据
results = []
for item in inputs['texts']:
    sentiment = analyze_sentiment(item)
    results.append({
        'text': item,
        'sentiment': sentiment
    })

output = {
    'total_texts': len(inputs['texts']),
    'results': results
}
```

#### 工具组合使用

```javascript
// Agent 调用预定义组合
{
  "action": "execute",
  "composition_name": "file_analysis_pipeline",
  "inputs": {
    "file_path": "/data/report.txt",
    "analysis_type": "summary",
    "output_path": "/output/analysis.md"
  }
}

// 或者创建自定义组合
{
  "action": "create",
  "language": "javascript",
  "composition_code": `
    // 读取数据
    const data = await call_tool('read', {path: inputs.data_file});
    
    // 处理数据
    const processed = data.content.split('\\n')
      .filter(line => line.trim())
      .map(line => line.toUpperCase());
    
    // 保存结果
    await call_tool('write', {
      path: inputs.output_file,
      content: processed.join('\\n')
    });
    
    result = {processed_lines: processed.length};
  `,
  "allowed_tools": ["read", "write"],
  "inputs": {
    "data_file": "/input/raw.txt",
    "output_file": "/output/processed.txt"
  }
}
```

## 🔧 配置选项

### Code Tool 配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `language` | string | - | 编程语言：python/javascript/typescript |
| `code` | string | - | 要执行的代码 |
| `inputs` | object | `{}` | 输入变量（在代码中作为 `inputs` 访问） |
| `timeout` | number | 30 | 超时时间（秒） |
| `allowed_modules` | array | `[]` | 允许导入的模块列表 |
| `allow_network` | boolean | false | 是否允许网络访问 |
| `memory_limit` | number | 512 | 内存限制（MB） |

### Tool Composer 配置

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 执行动作：list/execute/create |
| `composition_name` | string | 预定义组合名称（execute 时使用） |
| `composition_code` | string | 组合代码（create 时使用） |
| `language` | string | 编程语言（create 时使用） |
| `inputs` | object | 组合输入参数 |
| `allowed_tools` | array | 允许使用的工具列表 |

## 🔒 安全特性

### 1. 静态代码分析

- **危险操作检测**：自动检测 `eval`、`exec`、`subprocess` 等危险调用
- **模块白名单**：只允许导入指定的安全模块
- **语法验证**：执行前检查代码语法错误

### 2. 沙箱执行

- **进程隔离**：每个代码执行在独立进程中运行
- **资源限制**：CPU、内存、执行时间限制
- **文件系统隔离**：临时文件系统，自动清理

### 3. 权限控制

```typescript
// 危险操作示例（会被阻止）
{
  "language": "python",
  "code": "eval('__import__(\"os\").system(\"rm -rf /\")')", // ❌ 被阻止
  "allowed_modules": ["os"] // ❌ os 模块不在默认白名单中
}
```

## 📊 性能优化

### 1. 执行效率

- **并发执行**：支持多个代码任务并行执行
- **缓存机制**：模板和执行环境缓存
- **资源池化**：进程和内存资源复用

### 2. 内存管理

```typescript
// 建议的内存限制配置
const memoryLimits = {
  simple_task: 64,      // 简单任务 64MB
  data_processing: 256, // 数据处理 256MB
  ml_task: 512,         // 机器学习任务 512MB
  complex_analysis: 1024 // 复杂分析 1GB
};
```

## 🧪 测试和调试

### 1. 单元测试

```bash
# 运行 ToolCall 2.0 测试
node test-toolcall-v2.mjs
```

### 2. 调试技巧

```javascript
// 在代码中添加调试日志
console.log('调试信息:', JSON.stringify(inputs));

// 使用结构化输出便于调试
output = {
  debug_info: {
    input_length: inputs.data.length,
    processing_time: Date.now() - startTime,
    intermediate_results: intermediate_data
  },
  final_result: result
};
```

### 3. 错误处理

```typescript
// 推荐的错误处理模式
try {
  const result = await engine.execute(request);
  if (!result.success) {
    console.error('执行失败:', result.error);
    // 根据错误类型决定是否重试
    if (result.error.type === 'timeout') {
      // 超时重试
      return await retryWithLongerTimeout(request);
    }
  }
  return result;
} catch (error) {
  console.error('系统错误:', error);
  throw error;
}
```

## 📈 最佳实践

### 1. 代码编写

- **保持简单**：避免复杂的嵌套逻辑
- **明确输出**：始终设置 `output` 变量
- **错误处理**：使用 try-catch 处理异常
- **资源清理**：及时释放临时资源

```python
# 推荐的代码结构
import json

def main():
    try:
        # 输入验证
        if not inputs.get('data'):
            raise ValueError('缺少必需的 data 参数')
        
        # 核心逻辑
        processed = process_data(inputs['data'])
        
        # 输出结果
        output = {
            'status': 'success',
            'processed_count': len(processed),
            'results': processed
        }
        
    except Exception as e:
        # 错误处理
        output = {
            'status': 'error',
            'error_message': str(e),
            'error_type': type(e).__name__
        }

if __name__ == '__main__':
    main()
```

### 2. 工具组合

- **模块化设计**：将复杂流程拆分为多个步骤
- **错误传播**：合理处理工具调用错误
- **日志记录**：添加关键步骤的执行日志
- **超时设置**：为每个组合设置合理的超时时间

### 3. 性能优化

- **批量处理**：尽可能批量处理数据
- **内存控制**：避免加载过大的数据集
- **并行执行**：利用工具组合的并行能力
- **缓存结果**：缓存重复计算的结果

## 🔄 迁移指南

### 从 1.0 迁移到 2.0

1. **评估现有工具**：识别可以用代码工具替代的复杂工具
2. **创建组合模板**：将常用的工具序列转换为组合模板
3. **逐步替换**：先在测试环境验证，再逐步替换生产环境
4. **监控性能**：密切关注执行时间和资源使用

### 兼容性考虑

- **向后兼容**：ToolCall 1.0 的工具继续正常工作
- **渐进升级**：可以选择性启用 2.0 功能
- **回滚机制**：支持快速回滚到 1.0 模式

## 🚧 故障排除

### 常见问题

1. **代码执行超时**
   - 检查代码逻辑是否有无限循环
   - 增加 timeout 参数
   - 优化算法复杂度

2. **模块导入失败**
   - 检查模块是否在 `allowed_modules` 中
   - 确认模块名称拼写正确
   - 验证模块是否已安装

3. **内存不足**
   - 减少 `inputs` 数据大小
   - 增加 `memory_limit` 参数
   - 优化代码内存使用

4. **工具组合失败**
   - 检查 `allowed_tools` 列表
   - 验证工具调用参数
   - 查看执行日志定位问题

### 调试命令

```bash
# 检查 Python 环境
python3 --version

# 检查 Node.js 环境  
node --version

# 测试代码执行
echo "console.log('test')" | node

# 查看系统资源
top -p $(pgrep -f "code-tool")
```

## 📚 参考资料

- [API 文档](./toolcall-2.0-api.md)
- [示例代码](../examples/toolcall-v2/)
- [性能基准](./benchmarks/toolcall-v2.md)
- [安全指南](./security/toolcall-v2.md)

---

**注意**：ToolCall 2.0 目前处于实验阶段，建议在非关键任务中先行测试。
