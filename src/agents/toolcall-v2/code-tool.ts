/**
 * OpenCAWD ToolCall 2.0 - Code Tool
 * 
 * 将 Code Tool Engine 集成到 Agent 工具系统中
 */

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { CodeToolEngine, type CodeToolRequest, type CodeToolResult } from './code-tool-engine.js';
import { jsonResult } from '../tools/common.js';

/**
 * Code Tool 参数 Schema
 */
const CodeToolSchema = Type.Object({
  language: Type.Union([
    Type.Literal('python'),
    Type.Literal('javascript'),
    Type.Literal('typescript'),
  ], {
    description: '编程语言',
  }),
  code: Type.String({
    description: '要执行的代码',
  }),
  inputs: Type.Optional(Type.Object({
    additionalProperties: Type.Any(),
  }, {
    description: '传递给代码的输入变量（在代码中作为 inputs 变量访问）',
  })),
  timeout: Type.Optional(Type.Number({
    minimum: 1,
    maximum: 300,
    description: '超时时间（秒，默认30秒）',
  })),
  allowed_modules: Type.Optional(Type.Array(Type.String(), {
    description: '允许导入的模块列表（安全限制）',
  })),
  allow_network: Type.Optional(Type.Boolean({
    description: '是否允许网络访问（默认false）',
  })),
  memory_limit: Type.Optional(Type.Number({
    minimum: 64,
    maximum: 1024,
    description: '内存限制（MB）',
  })),
});

type CodeToolParams = typeof CodeToolSchema.static;

/**
 * 创建 Code Tool
 */
export function createCodeTool(): AgentTool {
  const engine = new CodeToolEngine();

  return {
    name: 'code_tool',
    label: 'Code Tool',
    description: `执行动态生成的 Python/JavaScript/TypeScript 代码，实现自定义工具逻辑。

使用方式：
1. 编写代码逻辑，使用 inputs 变量访问输入数据
2. 将结果赋值给 output 变量或用 print/json.dumps 输出
3. 可以导入 allowed_modules 中的模块
4. 执行时间受 timeout 限制

示例：
python: "result = [x for x in inputs['data'] if x > threshold]; output = result"
javascript: "const result = inputs.data.filter(x => x > inputs.threshold); output = result;"`,
    parameters: CodeToolSchema,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<AgentToolResult<unknown>> => {
      try {
        // 类型断言和验证
        const typedParams = params as CodeToolParams;
        
        if (!typedParams.language || !typedParams.code) {
          return {
            content: [
              {
                type: 'text',
                text: '错误：缺少必需的参数 language 或 code',
              },
            ],
            details: { error: 'Missing required parameters' },
          };
        }

        // 构建执行请求
        const request: CodeToolRequest = {
          language: typedParams.language,
          code: typedParams.code,
          inputs: typedParams.inputs || {},
          timeout: typedParams.timeout,
          allowed_modules: typedParams.allowed_modules || [],
          sandbox: {
            allowNetwork: typedParams.allow_network || false,
            memoryLimit: typedParams.memory_limit,
          },
        };

        // 执行代码
        const result = await engine.execute(request);

        // 构建响应
        const response = {
          success: result.success,
          stdout: result.stdout,
          stderr: result.stderr,
          structured_output: result.structured_output,
          execution_time_ms: result.execution_time_ms,
          error: result.error,
        };

        // 如果执行失败，返回错误信息
        if (!result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `代码执行失败：${result.error?.message || '未知错误'}`,
              },
              {
                type: 'text',
                text: `错误详情：${JSON.stringify(result.error, null, 2)}`,
              },
            ],
            details: response,
          };
        }

        // 执行成功，返回结果
        let outputText = '代码执行成功\n\n';
        
        if (result.structured_output) {
          outputText += `结构化输出：\n${JSON.stringify(result.structured_output, null, 2)}\n\n`;
        }
        
        if (result.stdout) {
          outputText += `标准输出：\n${result.stdout}\n\n`;
        }
        
        if (result.stderr) {
          outputText += `标准错误：\n${result.stderr}\n\n`;
        }

        outputText += `执行时间：${result.execution_time_ms}ms`;

        return {
          content: [
            {
              type: 'text',
              text: outputText.trim(),
            },
          ],
          details: response,
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Code Tool 执行异常：${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        };
      }
    },
  };
}
