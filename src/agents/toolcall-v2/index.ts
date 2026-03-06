/**
 * OpenCAWD ToolCall 2.0 - 集成模块
 * 
 * 提供统一的入口，将 Code Tool 和 Tool Composer 集成到现有系统中
 */

import { createCodeTool } from './code-tool.js';
import { createToolComposerTool } from './tool-composer-tool.js';
import { ToolComposer } from './tool-composer.js';
import type { AnyAgentTool } from '../tools/common.js';

/**
 * ToolCall 2.0 工具集合
 */
export interface ToolCallV2Tools {
  /** 代码执行工具 */
  codeTool: AnyAgentTool;
  /** 工具组合器 */
  toolComposer: AnyAgentTool;
  /** 工具组合器实例（用于注册工具） */
  composer: ToolComposer;
}

/**
 * 创建 ToolCall 2.0 工具集
 */
export function createToolCallV2Tools(): ToolCallV2Tools {
  // 创建工具组合器实例
  const composer = new ToolComposer();
  
  // 创建工具
  const codeTool = createCodeTool();
  const toolComposer = createToolComposerTool();

  return {
    codeTool,
    toolComposer,
    composer,
  };
}

/**
 * 将 ToolCall 2.0 工具集成到现有工具列表中
 */
export function integrateToolCallV2(
  existingTools: AnyAgentTool[],
  options?: {
    /** 是否启用代码工具 */
    enableCodeTool?: boolean;
    /** 是否启用工具组合器 */
    enableToolComposer?: boolean;
    /** 自定义工具注册器 */
    customToolRegistrar?: (composer: ToolComposer, v2Tools: ToolCallV2Tools) => void;
  }
): AnyAgentTool[] {
  const {
    enableCodeTool = true,
    enableToolComposer = true,
    customToolRegistrar,
  } = options || {};

  const v2Tools = createToolCallV2Tools();

  // 注册自定义工具
  if (customToolRegistrar) {
    customToolRegistrar(v2Tools.composer, v2Tools);
  } else {
    // 使用默认工具注册器
    const defaultRegistrar = createDefaultToolRegistrar(existingTools);
    defaultRegistrar(v2Tools.composer, v2Tools);
  }

  // 集成工具到现有列表
  const integratedTools = [...existingTools];

  if (enableCodeTool) {
    integratedTools.push(v2Tools.codeTool);
  }

  if (enableToolComposer) {
    integratedTools.push(v2Tools.toolComposer);
  }

  return integratedTools;
}

/**
 * 创建默认的工具注册器，用于注册常用的静态工具到 Tool Composer
 */
export function createDefaultToolRegistrar(existingTools: AnyAgentTool[]) {
  return (composer: ToolComposer, v2Tools: ToolCallV2Tools) => {
    // 注册常用的静态工具
    const toolMap = new Map<string, AnyAgentTool>();
    
    // 将现有工具转换为映射
    existingTools.forEach(tool => {
      toolMap.set(tool.name, tool);
    });

    // 注册常用工具到组合器
    const commonToolNames = [
      'read',
      'write',
      'edit',
      'exec',
      'web_search',
      'web_fetch',
      'memory_search',
      'memory_write',
      'browser_navigate',
      'browser_screenshot',
    ];

    commonToolNames.forEach(toolName => {
      const tool = toolMap.get(toolName);
      if (tool) {
        composer.registerTool(toolName, async (params: unknown) => {
          try {
            // 调用原始工具
            const result = await (tool as any).execute?.('tool-call', params);
            return result || { content: [], details: null };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `工具 ${toolName} 调用失败: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: { error: error instanceof Error ? error.message : String(error) },
            };
          }
        });
      }
    });

    // 注册代码工具本身，允许在组合中调用代码工具
    composer.registerTool('code_tool', async (params: unknown) => {
      const codeTool = v2Tools.codeTool;
      try {
        const result = await (codeTool as any).execute?.('tool-call', params);
        return result || { content: [], details: null };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `代码工具调用失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    });
  };
}

// 导出所有类型和工具
export * from './code-tool.js';
export * from './code-tool-engine.js';
export * from './tool-composer.js';
export * from './tool-composer-tool.js';
