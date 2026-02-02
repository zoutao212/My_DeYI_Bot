/**
 * 能力路由器
 * 将用户请求路由到对应的能力模块（TaskDelegator、MemoryService）
 */

import type { CharacterConfig } from "../config/loader.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("lina:router");

export interface RoutingContext {
  userMessage: string;
  config: CharacterConfig;
  conversationHistory?: Array<{ role: string; content: string }>;
}

export interface RoutingResult {
  capability: "task_management" | "memory_service" | "daily_planning" | "general";
  confidence: number;
  reason: string;
}

/**
 * 路由用户请求到对应能力
 */
export function routeCapability(context: RoutingContext): RoutingResult {
  const { userMessage, config } = context;
  const message = userMessage.toLowerCase();

  // 1. 任务管理关键词
  const taskKeywords = [
    "任务",
    "待办",
    "todo",
    "完成",
    "进度",
    "计划",
    "安排",
    "提醒",
    "deadline",
    "截止",
  ];

  if (config.capabilities.task_management && containsKeywords(message, taskKeywords)) {
    return {
      capability: "task_management",
      confidence: 0.8,
      reason: "检测到任务管理相关关键词",
    };
  }

  // 2. 记忆服务关键词
  const memoryKeywords = [
    "记住",
    "记录",
    "保存",
    "回忆",
    "之前",
    "上次",
    "历史",
    "记得",
    "忘记",
    "查找",
  ];

  if (config.capabilities.memory_service && containsKeywords(message, memoryKeywords)) {
    return {
      capability: "memory_service",
      confidence: 0.8,
      reason: "检测到记忆服务相关关键词",
    };
  }

  // 3. 日程规划关键词
  const planningKeywords = [
    "今天",
    "明天",
    "本周",
    "下周",
    "日程",
    "安排",
    "规划",
    "时间表",
    "schedule",
  ];

  if (config.capabilities.daily_planning && containsKeywords(message, planningKeywords)) {
    return {
      capability: "daily_planning",
      confidence: 0.7,
      reason: "检测到日程规划相关关键词",
    };
  }

  // 4. 默认：通用对话
  return {
    capability: "general",
    confidence: 0.5,
    reason: "未匹配到特定能力，使用通用对话",
  };
}

/**
 * 检查消息是否包含关键词
 */
function containsKeywords(message: string, keywords: string[]): boolean {
  return keywords.some((keyword) => message.includes(keyword));
}

/**
 * 获取能力描述
 */
export function getCapabilityDescription(
  capability: RoutingResult["capability"]
): string {
  const descriptions: Record<string, string> = {
    task_management: "任务管理 - 使用 TaskDelegator 处理任务相关请求",
    memory_service: "记忆服务 - 使用 MemoryService 处理记忆相关请求",
    daily_planning: "日程规划 - 处理日程安排相关请求",
    general: "通用对话 - 使用角色人格进行自然对话",
  };

  return descriptions[capability] || "未知能力";
}

/**
 * 记录路由决策
 */
export function logRoutingDecision(result: RoutingResult): void {
  log.info(
    `[CapabilityRouter] 路由决策: ${result.capability} (置信度: ${result.confidence}, 原因: ${result.reason})`
  );
}
