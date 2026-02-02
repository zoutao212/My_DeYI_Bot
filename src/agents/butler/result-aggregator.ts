/**
 * 结果聚合器
 * 
 * 负责整合多个子任务的执行结果
 */

import type { TaskDelegationResponse } from '../multi-layer/types.js';

/**
 * 聚合结果
 */
export interface AggregatedResult {
  /** 总体状态 */
  overallStatus: 'success' | 'partial' | 'failure';
  
  /** 成功的子任务数量 */
  successCount: number;
  
  /** 失败的子任务数量 */
  failureCount: number;
  
  /** 聚合后的结果 */
  result: unknown;
  
  /** 错误信息（如果有） */
  errors?: string[];
}

/**
 * 聚合多个任务的执行结果
 * 
 * @param responses - 任务响应列表
 * @returns 聚合后的结果
 */
export function aggregateResults(
  responses: TaskDelegationResponse[]
): AggregatedResult {
  const successCount = responses.filter(r => r.status === 'completed').length;
  const failureCount = responses.filter(r => r.status === 'failed').length;
  
  // 确定总体状态
  let overallStatus: 'success' | 'partial' | 'failure';
  if (failureCount === 0) {
    overallStatus = 'success';
  } else if (successCount === 0) {
    overallStatus = 'failure';
  } else {
    overallStatus = 'partial';
  }
  
  // 收集错误信息
  const errors = responses
    .filter(r => r.error)
    .map(r => r.error?.message || 'Unknown error');
  
  // 聚合结果
  const results = responses
    .filter(r => r.result !== undefined)
    .map(r => r.result);
  
  return {
    overallStatus,
    successCount,
    failureCount,
    result: results,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * 格式化聚合结果为用户友好的消息
 * 
 * @param aggregated - 聚合结果
 * @returns 格式化后的消息
 */
export function formatAggregatedResult(aggregated: AggregatedResult): string {
  const parts: string[] = [];
  
  // 总体状态
  if (aggregated.overallStatus === 'success') {
    parts.push('✅ 所有任务执行成功');
  } else if (aggregated.overallStatus === 'partial') {
    parts.push(`⚠️ 部分任务执行成功（${aggregated.successCount}/${aggregated.successCount + aggregated.failureCount}）`);
  } else {
    parts.push('❌ 所有任务执行失败');
  }
  
  // 错误信息
  if (aggregated.errors && aggregated.errors.length > 0) {
    parts.push('\n\n错误信息：');
    for (const error of aggregated.errors) {
      parts.push(`- ${error}`);
    }
  }
  
  return parts.join('\n');
}
