/**
 * 意图解析器
 * 
 * 负责理解用户意图，判断任务类型和复杂度
 */

/**
 * 用户意图
 */
export interface Intent {
  /** 意图类型 */
  type: 'task' | 'skill' | 'conversation';
  
  /** 意图描述 */
  description: string;
  
  /** 任务复杂度（仅任务类型） */
  complexity?: 'simple' | 'complex';
  
  /** 技能名称（仅技能类型） */
  skillName?: string;
  
  /** 参数 */
  parameters?: Record<string, unknown>;
  
  /** 置信度（0-1） */
  confidence?: number;
}

/**
 * 解析用户消息，提取意图
 * 
 * @param userMessage - 用户消息
 * @param context - 对话上下文
 * @returns 解析出的意图
 */
export async function parseIntent(
  userMessage: string,
  context?: {
    conversationHistory?: string[];
    userProfile?: Record<string, unknown>;
  }
): Promise<Intent> {
  // TODO: 实现意图解析逻辑
  // 当前返回默认意图，后续使用 LLM 实现
  
  // 简单的关键词匹配（临时实现）
  const lowerMessage = userMessage.toLowerCase();
  
  // 检查是否是技能调用
  if (lowerMessage.includes('记忆') || lowerMessage.includes('memory')) {
    return {
      type: 'skill',
      description: userMessage,
      skillName: 'memory',
      confidence: 0.8,
    };
  }
  
  // 检查是否是复杂任务
  if (
    lowerMessage.includes('帮我') ||
    lowerMessage.includes('请') ||
    lowerMessage.includes('能不能')
  ) {
    return {
      type: 'task',
      description: userMessage,
      complexity: 'simple',
      confidence: 0.7,
    };
  }
  
  // 默认为对话
  return {
    type: 'conversation',
    description: userMessage,
    confidence: 0.6,
  };
}

/**
 * 判断任务复杂度
 * 
 * @param taskDescription - 任务描述
 * @returns 任务复杂度
 */
export function assessTaskComplexity(
  taskDescription: string
): 'simple' | 'complex' {
  // TODO: 实现复杂度评估逻辑
  // 当前使用简单的启发式规则
  
  const lowerDesc = taskDescription.toLowerCase();
  
  // 复杂任务的特征
  const complexKeywords = [
    '分析',
    '比较',
    '总结',
    '整理',
    '多个',
    '所有',
    '批量',
    'analyze',
    'compare',
    'summarize',
    'multiple',
    'all',
    'batch',
  ];
  
  for (const keyword of complexKeywords) {
    if (lowerDesc.includes(keyword)) {
      return 'complex';
    }
  }
  
  return 'simple';
}
