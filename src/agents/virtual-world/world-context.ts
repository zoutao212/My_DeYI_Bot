/**
 * 世界上下文管理
 * 
 * 负责管理虚拟世界的状态、事件和环境信息
 */

/**
 * 世界状态
 */
export interface WorldState {
  /** 当前时间（虚拟世界时间） */
  currentTime?: string;
  
  /** 当前地点 */
  currentLocation?: string;
  
  /** 天气状况 */
  weather?: string;
  
  /** 环境描述 */
  environment?: string;
  
  /** 活跃的 NPC */
  activeNPCs?: string[];
  
  /** 最近的事件 */
  recentEvents?: WorldEvent[];
  
  /** 自定义状态 */
  customState?: Record<string, unknown>;
}

/**
 * 世界事件
 */
export interface WorldEvent {
  /** 事件 ID */
  id: string;
  
  /** 事件类型 */
  type: string;
  
  /** 事件描述 */
  description: string;
  
  /** 事件时间 */
  timestamp: number;
  
  /** 相关角色 */
  involvedCharacters?: string[];
  
  /** 事件影响 */
  impact?: string;
}

/**
 * 构建世界上下文 Prompt
 * 
 * @param state - 世界状态
 * @returns 世界上下文 Prompt
 */
export function buildWorldContextPrompt(state: WorldState): string {
  const sections: string[] = [];
  
  sections.push('# 世界上下文\n');
  
  if (state.currentTime) {
    sections.push(`**当前时间**：${state.currentTime}`);
  }
  
  if (state.currentLocation) {
    sections.push(`**当前地点**：${state.currentLocation}`);
  }
  
  if (state.weather) {
    sections.push(`**天气**：${state.weather}`);
  }
  
  if (state.environment) {
    sections.push(`\n**环境描述**：\n${state.environment}`);
  }
  
  if (state.activeNPCs && state.activeNPCs.length > 0) {
    sections.push(`\n**活跃的角色**：${state.activeNPCs.join('、')}`);
  }
  
  if (state.recentEvents && state.recentEvents.length > 0) {
    sections.push('\n**最近的事件**：');
    for (const event of state.recentEvents) {
      sections.push(`- ${event.description}`);
    }
  }
  
  return sections.join('\n');
}

/**
 * 更新世界状态
 * 
 * @param currentState - 当前状态
 * @param updates - 更新内容
 * @returns 新的世界状态
 */
export function updateWorldState(
  currentState: WorldState,
  updates: Partial<WorldState>
): WorldState {
  return {
    ...currentState,
    ...updates,
    customState: {
      ...currentState.customState,
      ...updates.customState,
    },
  };
}
