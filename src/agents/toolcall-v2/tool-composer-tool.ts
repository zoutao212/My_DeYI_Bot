/**
 * OpenCAWD ToolCall 2.0 - Tool Composer Tool
 * 
 * 让 Agent 能够创建和执行工具组合
 */

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { ToolComposer, type ToolCompositionConfig, createPredefinedCompositions } from './tool-composer.js';
import { jsonResult } from '../tools/common.js';

/**
 * Tool Composer 参数 Schema
 */
const ToolComposerSchema = Type.Object({
  action: Type.Union([
    Type.Literal('execute'),
    Type.Literal('list'),
    Type.Literal('create'),
  ], {
    description: '执行动作',
  }),
  composition_name: Type.Optional(Type.String({
    description: '预定义组合名称（当 action=execute 时使用）',
  })),
  composition_code: Type.Optional(Type.String({
    description: '组合代码（当 action=create 时使用）',
  })),
  language: Type.Optional(Type.Union([
    Type.Literal('python'),
    Type.Literal('javascript'),
    Type.Literal('typescript'),
  ], {
    description: '编程语言（当 action=create 时使用）',
  })),
  inputs: Type.Optional(Type.Object({
    additionalProperties: Type.Any(),
  }, {
    description: '组合输入参数（当 action=execute 时使用）',
  })),
  allowed_tools: Type.Optional(Type.Array(Type.String(), {
    description: '允许使用的工具列表（当 action=create 时使用）',
  })),
  timeout: Type.Optional(Type.Number({
    minimum: 1,
    maximum: 600,
    description: '超时时间（秒，默认60秒）',
  })),
});

type ToolComposerParams = typeof ToolComposerSchema.static;

/**
 * 创建 Tool Composer
 */
export function createToolComposerTool(): AgentTool {
  const composer = new ToolComposer();
  const predefinedCompositions = createPredefinedCompositions();

  // 注册预定义组合中使用的工具（这里只是示例，实际需要注册真实工具）
  composer.registerTool('read', async (params: unknown) => {
    return {
      content: [{ type: 'text', text: '模拟 read 工具结果' }],
      details: { content: '文件内容模拟', path: (params as any).path },
    };
  });

  composer.registerTool('write', async (params: unknown) => {
    return {
      content: [{ type: 'text', text: '模拟 write 工具结果' }],
      details: { success: true, path: (params as any).path },
    };
  });

  composer.registerTool('analyze_text', async (params: unknown) => {
    return {
      content: [{ type: 'text', text: '模拟 analyze_text 工具结果' }],
      details: { analysis: '文本分析结果模拟' },
    };
  });

  composer.registerTool('web_fetch', async (params: unknown) => {
    return {
      content: [{ type: 'text', text: '模拟 web_fetch 工具结果' }],
      details: { content: '网页内容模拟', url: (params as any).url },
    };
  });

  composer.registerTool('extract_content', async (params: unknown) => {
    return {
      content: [{ type: 'text', text: '模拟 extract_content 工具结果' }],
      details: { extracted: ['内容1', '内容2', '内容3'] },
    };
  });

  return {
    name: 'tool_composer',
    label: 'Tool Composer',
    description: `工具组合器 - 让你能够编排多个工具形成复杂工作流。

支持的动作：
1. execute - 执行预定义的工具组合
2. list - 列出所有可用的预定义组合
3. create - 创建并执行自定义工具组合

使用示例：
- 执行预定义组合：{"action": "execute", "composition_name": "file_analysis_pipeline", "inputs": {"file_path": "/path/to/file.txt"}}
- 列出可用组合：{"action": "list"}
- 创建自定义组合：{"action": "create", "language": "javascript", "composition_code": "const result = await call_tool('read', {path: inputs.file_path});", "allowed_tools": ["read"]}`,
    parameters: ToolComposerSchema,
    execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<AgentToolResult<unknown>> => {
      try {
        const typedParams = params as ToolComposerParams;
        
        if (!typedParams.action) {
          return {
            content: [
              {
                type: 'text',
                text: '错误：缺少必需的参数 action',
              },
            ],
            details: { error: 'Missing required parameter: action' },
          };
        }

        switch (typedParams.action) {
          case 'list':
            return handleListAction(predefinedCompositions);

          case 'execute':
            return handleExecuteAction(composer, predefinedCompositions, typedParams);

          case 'create':
            return handleCreateAction(composer, typedParams);

          default:
            return {
              content: [
                {
                  type: 'text',
                  text: `错误：不支持的动作 ${typedParams.action}`,
                },
              ],
              details: { error: `Unsupported action: ${typedParams.action}` },
            };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Tool Composer 执行异常：${error instanceof Error ? error.message : String(error)}`,
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

/**
 * 处理 list 动作
 */
async function handleListAction(predefinedCompositions: ToolCompositionConfig[]): Promise<AgentToolResult<unknown>> {
  const compositionList = predefinedCompositions.map(comp => ({
    name: comp.name,
    description: comp.description,
    language: comp.language,
    allowed_tools: comp.allowed_tools,
    required_inputs: Object.entries(comp.input_schema.properties || {})
      .filter(([_, prop]: [string, any]) => prop.required)
      .map(([name, _]) => name),
  }));

  return {
    content: [
      {
        type: 'text',
        text: '可用的工具组合：\n\n' + compositionList.map(comp => 
          `📋 **${comp.name}** (${comp.language})\n${comp.description}\n可用工具: ${comp.allowed_tools.join(', ')}\n必需输入: ${comp.required_inputs.join(', ') || '无'}\n`
        ).join('\n'),
      },
    ],
    details: { compositions: compositionList },
  };
}

/**
 * 处理 execute 动作
 */
async function handleExecuteAction(
  composer: ToolComposer,
  predefinedCompositions: ToolCompositionConfig[],
  params: ToolComposerParams
): Promise<AgentToolResult<unknown>> {
  if (!params.composition_name) {
    return {
      content: [
        {
          type: 'text',
          text: '错误：execute 动作需要 composition_name 参数',
        },
      ],
      details: { error: 'Missing composition_name for execute action' },
    };
  }

  // 查找预定义组合
  const composition = predefinedCompositions.find(comp => comp.name === params.composition_name);
  if (!composition) {
    return {
      content: [
        {
          type: 'text',
          text: `错误：找不到预定义组合 ${params.composition_name}`,
        },
      ],
      details: { error: `Composition not found: ${params.composition_name}` },
    };
  }

  // 执行组合
  const result = await composer.executeComposition(composition, params.inputs || {});

  // 格式化输出
  let outputText = `工具组合执行结果：\n\n`;
  outputText += `组合名称: ${composition.name}\n`;
  outputText += `执行状态: ${result.success ? '✅ 成功' : '❌ 失败'}\n`;
  outputText += `执行时间: ${result.execution_time_ms}ms\n\n`;

  if (result.success) {
    outputText += `输出结果:\n${JSON.stringify(result.output, null, 2)}\n\n`;
  } else {
    outputText += `错误信息: ${result.error?.message}\n`;
  }

  if (result.tool_calls.length > 0) {
    outputText += `\n工具调用记录:\n`;
    result.tool_calls.forEach((call, index) => {
      const callResult = call.result as any;
      outputText += `${index + 1}. ${call.tool_name} - ${callResult?.error ? '失败' : '成功'}\n`;
    });
  }

  if (result.logs.length > 0) {
    outputText += `\n执行日志:\n${result.logs.join('\n')}`;
  }

  return {
    content: [
      {
        type: 'text',
        text: outputText.trim(),
      },
    ],
    details: {
      composition_name: composition.name,
      success: result.success,
      output: result.output,
      execution_time_ms: result.execution_time_ms,
      tool_calls: result.tool_calls,
      logs: result.logs,
      error: result.error,
    },
  };
}

/**
 * 处理 create 动作
 */
async function handleCreateAction(
  composer: ToolComposer,
  params: ToolComposerParams
): Promise<AgentToolResult<unknown>> {
  if (!params.composition_code || !params.language) {
    return {
      content: [
        {
          type: 'text',
          text: '错误：create 动作需要 composition_code 和 language 参数',
        },
      ],
      details: { error: 'Missing composition_code or language for create action' },
    };
  }

  // 创建临时组合配置
  const tempComposition: ToolCompositionConfig = {
    name: `temp_${Date.now()}`,
    description: '临时创建的工具组合',
    language: params.language,
    composition_code: params.composition_code,
    input_schema: { type: 'object' },
    allowed_tools: params.allowed_tools || [],
    timeout: params.timeout,
  };

  // 执行临时组合
  const result = await composer.executeComposition(tempComposition, params.inputs || {});

  // 格式化输出
  let outputText = `自定义工具组合执行结果：\n\n`;
  outputText += `编程语言: ${params.language}\n`;
  outputText += `执行状态: ${result.success ? '✅ 成功' : '❌ 失败'}\n`;
  outputText += `执行时间: ${result.execution_time_ms}ms\n\n`;

  if (result.success) {
    outputText += `输出结果:\n${JSON.stringify(result.output, null, 2)}\n\n`;
  } else {
    outputText += `错误信息: ${result.error?.message}\n`;
  }

  if (result.tool_calls.length > 0) {
    outputText += `\n工具调用记录:\n`;
    result.tool_calls.forEach((call, index) => {
      const callResult = call.result as any;
      outputText += `${index + 1}. ${call.tool_name} - ${callResult?.error ? '失败' : '成功'}\n`;
    });
  }

  if (result.logs.length > 0) {
    outputText += `\n执行日志:\n${result.logs.join('\n')}`;
  }

  return {
    content: [
      {
        type: 'text',
        text: outputText.trim(),
      },
    ],
    details: {
      language: params.language,
      success: result.success,
      output: result.output,
      execution_time_ms: result.execution_time_ms,
      tool_calls: result.tool_calls,
      logs: result.logs,
      error: result.error,
    },
  };
}
