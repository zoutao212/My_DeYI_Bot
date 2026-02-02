/**
 * Agent 层次解析器
 * 
 * 负责根据 sessionKey 和配置判断当前 Agent 应该运行在哪个层次
 */

/**
 * Agent 层次类型
 * 
 * - virtual-world: 虚拟世界层（角色扮演、世界观模拟）
 * - butler: 管家层（任务调度、意图理解）
 * - execution: 执行层（工具调用、具体操作）
 */
export type AgentLayer = 'virtual-world' | 'butler' | 'execution';

/**
 * 根据 sessionKey 和配置判断 Agent 层次
 * 
 * 判断优先级：
 * 1. 配置中的显式层次设置（config.agentLayer）
 * 2. sessionKey 前缀判断（virtual-world:, butler:）
 * 3. 默认使用执行层（向后兼容）
 * 
 * @param sessionKey - 会话标识
 * @param config - 配置对象
 * @returns Agent 层次
 * 
 * @example
 * ```typescript
 * // 通过配置指定
 * resolveAgentLayer('any-key', { agentLayer: 'virtual-world' }); // => 'virtual-world'
 * 
 * // 通过 sessionKey 前缀判断
 * resolveAgentLayer('virtual-world:lisi'); // => 'virtual-world'
 * resolveAgentLayer('butler:lina'); // => 'butler'
 * 
 * // 默认行为
 * resolveAgentLayer('default-session'); // => 'execution'
 * ```
 */
export function resolveAgentLayer(
  sessionKey: string,
  config?: Record<string, unknown>
): AgentLayer {
  // 1. 检查配置中的显式层次设置（最高优先级）
  if (config?.agentLayer) {
    const layer = config.agentLayer as string;
    if (layer === 'virtual-world' || layer === 'butler' || layer === 'execution') {
      return layer;
    }
  }
  
  // 2. 根据 sessionKey 前缀判断
  if (sessionKey.startsWith('virtual-world:')) {
    return 'virtual-world';
  }
  
  if (sessionKey.startsWith('butler:')) {
    return 'butler';
  }
  
  // 3. 默认使用执行层（向后兼容现有行为）
  return 'execution';
}
