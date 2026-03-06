/**
 * OpenCAWD ToolCall 2.0 - Tool Composer
 * 
 * 实现工具组合能力，让 Agent 能够通过代码编排多个静态工具
 */

import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import { CodeToolEngine, type CodeToolRequest } from './code-tool-engine.js';

/**
 * 工具组合配置
 */
export interface ToolCompositionConfig {
  /** 组合名称 */
  name: string;
  /** 组合描述 */
  description: string;
  /** 组合代码 */
  composition_code: string;
  /** 编程语言 */
  language: 'python' | 'javascript' | 'typescript';
  /** 输入参数 Schema */
  input_schema: Record<string, unknown>;
  /** 允许使用的工具列表 */
  allowed_tools: string[];
  /** 超时时间（秒） */
  timeout?: number;
}

/**
 * 工具组合执行结果
 */
export interface CompositionResult {
  /** 执行是否成功 */
  success: boolean;
  /** 组合输出 */
  output: unknown;
  /** 执行日志 */
  logs: string[];
  /** 工具调用记录 */
  tool_calls: Array<{
    tool_name: string;
    parameters: Record<string, unknown>;
    result: unknown;
    timestamp: number;
  }>;
  /** 执行时间（毫秒） */
  execution_time_ms: number;
  /** 错误信息 */
  error?: {
    type: 'timeout' | 'composition_error' | 'tool_error';
    message: string;
    details?: unknown;
  };
}

/**
 * 工具组合执行器
 */
export class ToolComposer {
  private codeEngine: CodeToolEngine;
  private availableTools: Map<string, (params: unknown) => Promise<AgentToolResult<unknown>>>;

  constructor() {
    this.codeEngine = new CodeToolEngine();
    this.availableTools = new Map();
  }

  /**
   * 注册可用工具
   */
  registerTool(name: string, handler: (params: unknown) => Promise<AgentToolResult<unknown>>): void {
    this.availableTools.set(name, handler);
  }

  /**
   * 执行工具组合
   */
  async executeComposition(config: ToolCompositionConfig, inputs: Record<string, unknown>): Promise<CompositionResult> {
    const startTime = Date.now();
    const logs: string[] = [];
    const tool_calls: CompositionResult['tool_calls'] = [];

    try {
      // 1. 生成组合执行代码
      const compositionCode = this.generateCompositionCode(config, inputs);

      // 2. 构建执行请求
      const request: CodeToolRequest = {
        language: config.language,
        code: compositionCode,
        inputs: {
          inputs,
          tools: this.createToolProxy(config.allowed_tools, tool_calls, logs),
          log: (message: string) => logs.push(`[${new Date().toISOString()}] ${message}`),
        },
        timeout: config.timeout || 60,
        allowed_modules: ['json', 'datetime'],
      };

      // 3. 执行组合代码
      const result = await this.codeEngine.execute(request);

      // 4. 处理执行结果
      if (!result.success) {
        return {
          success: false,
          output: null,
          logs,
          tool_calls,
          execution_time_ms: Date.now() - startTime,
          error: {
            type: 'composition_error',
            message: result.error?.message || '组合执行失败',
            details: result.error,
          },
        };
      }

      // 5. 解析输出
      let output: unknown = null;
      if (result.structured_output) {
        output = result.structured_output;
      } else if (result.stdout) {
        try {
          output = JSON.parse(result.stdout);
        } catch {
          output = result.stdout;
        }
      }

      return {
        success: true,
        output,
        logs,
        tool_calls,
        execution_time_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        logs,
        tool_calls,
        execution_time_ms: Date.now() - startTime,
        error: {
          type: 'composition_error',
          message: error instanceof Error ? error.message : String(error),
          details: error,
        },
      };
    }
  }

  /**
   * 生成组合执行代码
   */
  private generateCompositionCode(config: ToolCompositionConfig, inputs: Record<string, unknown>): string {
    const templates: Record<string, string> = {
      python: `# 工具组合执行器
import json
from datetime import datetime

# 工具调用代理
def call_tool(name, parameters):
    """调用指定工具"""
    return tools[name](parameters)

# 组合逻辑开始
log(f"开始执行组合: {config.name}")
start_time = datetime.now()

try:
${config.composition_code}
    
    # 组合执行完成
    end_time = datetime.now()
    duration = (end_time - start_time).total_seconds()
    log(f"组合执行完成，耗时: {duration:.2f}秒")
    
    # 输出结果
    if 'result' in locals():
        output = {
            "success": True,
            "result": result,
            "duration_ms": int(duration * 1000)
        }
    else:
        output = {
            "success": True,
            "result": None,
            "message": "组合执行完成但没有产生结果",
            "duration_ms": int(duration * 1000)
        }
    
except Exception as e:
    import traceback
    error_info = {
        "success": False,
        "error": str(e),
        "traceback": traceback.format_exc()
    }
    log(f"组合执行失败: {e}")
    output = error_info

# 输出最终结果
print(json.dumps(output, ensure_ascii=False, indent=2))
`,
      javascript: `// 工具组合执行器
const log = (message) => {
  console.log(\`[\${new Date().toISOString()}] \${message}\`);
};

// 工具调用代理
const callTool = (name, parameters) => {
  return tools[name](parameters);
};

// 组合逻辑开始
log('开始执行组合: ${config.name}');
const startTime = Date.now();

try {
${config.composition_code}
    
    // 组合执行完成
    const duration = Date.now() - startTime;
    log(\`组合执行完成，耗时: \${duration}ms\`);
    
    // 输出结果
    let output;
    if (typeof result !== 'undefined') {
      output = {
        success: true,
        result: result,
        duration_ms: duration
      };
    } else {
      output = {
        success: true,
        result: null,
        message: '组合执行完成但没有产生结果',
        duration_ms: duration
      };
    }
    
} catch (e) {
  log(\`组合执行失败: \${e.message}\`);
  output = {
    success: false,
    error: e.message,
    stack: e.stack
  };
}

// 输出最终结果
console.log(JSON.stringify(output, null, 2));
`,
      typescript: `// 工具组合执行器
const log = (message: string) => {
  console.log(\`[\${new Date().toISOString()}] \${message}\`);
};

// 工具调用代理
const callTool = async (name: string, parameters: any) => {
  return await tools[name](parameters);
};

// 组合逻辑开始
log('开始执行组合: ${config.name}');
const startTime = Date.now();

try {
${config.composition_code}
    
    // 组合执行完成
    const duration = Date.now() - startTime;
    log(\`组合执行完成，耗时: \${duration}ms\`);
    
    // 输出结果
    let output;
    if (typeof result !== 'undefined') {
      output = {
        success: true,
        result: result,
        duration_ms: duration
      };
    } else {
      output = {
        success: true,
        result: null,
        message: '组合执行完成但没有产生结果',
        duration_ms: duration
      };
    }
    
} catch (e: any) {
  log(\`组合执行失败: \${e.message}\`);
  output = {
    success: false,
    error: e.message,
    stack: e.stack
  };
}

// 输出最终结果
console.log(JSON.stringify(output, null, 2));
`,
    };

    return templates[config.language] || templates.javascript;
  }

  /**
   * 创建工具代理
   */
  private createToolProxy(
    allowedTools: string[],
    tool_calls: CompositionResult['tool_calls'],
    logs: string[]
  ): Record<string, (params: unknown) => Promise<unknown>> {
    const proxy: Record<string, (params: unknown) => Promise<unknown>> = {};

    for (const toolName of allowedTools) {
      proxy[toolName] = async (params: unknown) => {
        const startTime = Date.now();
        
        try {
          const toolHandler = this.availableTools.get(toolName);
          if (!toolHandler) {
            throw new Error(`工具 ${toolName} 未注册`);
          }

          logs.push(`调用工具: ${toolName}`);
          const result = await toolHandler(params);
          
          tool_calls.push({
            tool_name: toolName,
            parameters: params as Record<string, unknown>,
            result: result.details || result.content,
            timestamp: startTime,
          });

          return result.details || result.content;
        } catch (error) {
          const errorMsg = `工具 ${toolName} 调用失败: ${error instanceof Error ? error.message : String(error)}`;
          logs.push(errorMsg);
          
          tool_calls.push({
            tool_name: toolName,
            parameters: params as Record<string, unknown>,
            result: { error: errorMsg },
            timestamp: startTime,
          });

          throw error;
        }
      };
    }

    return proxy;
  }

  /**
   * 获取可用工具列表
   */
  getAvailableTools(): string[] {
    return Array.from(this.availableTools.keys());
  }

  /**
   * 检查工具是否可用
   */
  hasTool(name: string): boolean {
    return this.availableTools.has(name);
  }
}

/**
 * 创建预定义的工具组合
 */
export function createPredefinedCompositions(): ToolCompositionConfig[] {
  return [
    {
      name: 'file_analysis_pipeline',
      description: '文件分析流水线：读取文件 → 分析内容 → 生成报告',
      language: 'javascript',
      composition_code: `
// 1. 读取文件
const fileContent = await callTool('read', { path: inputs.file_path });
log(\`读取文件: \${inputs.file_path}\`);

// 2. 分析文件内容
const analysisResult = await callTool('analyze_text', {
  text: fileContent.content,
  analysis_type: inputs.analysis_type || 'summary'
});
log('完成文本分析');

// 3. 生成报告
const report = await callTool('write', {
  path: inputs.output_path || 'analysis_report.md',
  content: \`# 文件分析报告\\n\\n文件路径: \${inputs.file_path}\\n\\n分析结果:\\n\\n\${analysisResult.result}\`
});
log(\`生成报告: \${inputs.output_path || 'analysis_report.md'}\`);

result = {
  file_path: inputs.file_path,
  analysis: analysisResult.result,
  report_path: inputs.output_path || 'analysis_report.md'
};
`,
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          analysis_type: { type: 'string', enum: ['summary', 'keywords', 'sentiment'] },
          output_path: { type: 'string' },
        },
        required: ['file_path'],
      },
      allowed_tools: ['read', 'analyze_text', 'write'],
      timeout: 120,
    },
    {
      name: 'web_scraping_workflow',
      description: '网页抓取工作流：获取页面 → 提取内容 → 保存数据',
      language: 'python',
      composition_code: `
# 1. 获取网页内容
page_result = await call_tool('web_fetch', {
    'url': inputs['url'],
    'timeout': inputs.get('timeout', 30)
})
log(f"获取页面: {inputs['url']}")

# 2. 提取内容
extracted_data = await call_tool('extract_content', {
    'html': page_result['content'],
    'selectors': inputs.get('selectors', ['title', 'main'])
})
log('内容提取完成')

# 3. 保存数据
save_result = await call_tool('write', {
    'path': inputs.get('output_path', 'scraped_data.json'),
    'content': json.dumps(extracted_data, ensure_ascii=False, indent=2)
})
log(f"数据已保存到: {inputs.get('output_path', 'scraped_data.json')}")

result = {
    'url': inputs['url'],
    'extracted_data': extracted_data,
    'output_path': inputs.get('output_path', 'scraped_data.json'),
    'items_count': len(extracted_data) if isinstance(extracted_data, list) else 1
}
`,
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          selectors: { type: 'array', items: { type: 'string' } },
          output_path: { type: 'string' },
          timeout: { type: 'number' },
        },
        required: ['url'],
      },
      allowed_tools: ['web_fetch', 'extract_content', 'write'],
      timeout: 180,
    },
  ];
}
