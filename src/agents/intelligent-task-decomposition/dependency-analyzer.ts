/**
 * 依赖分析器 (Dependency Analyzer)
 *
 * 基于拓扑排序分析子任务间的依赖关系，识别可并行执行的任务组。
 * 用于 followup-runner 的并行 drain 逻辑。
 *
 * @module agents/intelligent-task-decomposition/dependency-analyzer
 */

import type { SubTask } from "./types.js";

/**
 * 基于拓扑排序将任务分组为可并行执行的批次
 *
 * 同一批次内的任务互不依赖，可以并发执行。
 * 批次之间严格按顺序执行（后一批依赖前一批的产出）。
 *
 * @param tasks - 待分析的子任务列表（仅 pending 状态）
 * @returns 按执行顺序排列的并行批次，每批次内的任务可并发
 */
export function findParallelGroups(tasks: SubTask[]): SubTask[][] {
  if (tasks.length === 0) return [];
  if (tasks.length === 1) return [tasks];

  const groups: SubTask[][] = [];
  const remaining = new Set(tasks.map((t) => t.id));
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // 已完成的任务 ID 集合（不在 remaining 中的依赖视为已满足）
  while (remaining.size > 0) {
    const ready: SubTask[] = [];

    for (const id of remaining) {
      const task = taskMap.get(id);
      if (!task) continue;

      // 检查所有依赖是否已满足（不在 remaining 中 = 已完成或已在前序批次中）
      const deps = task.dependencies ?? [];
      const allDepsSatisfied = deps.every((depId) => !remaining.has(depId));

      if (allDepsSatisfied) {
        ready.push(task);
      }
    }

    // 循环依赖保护：如果没有任何任务就绪但 remaining 仍有任务
    if (ready.length === 0) {
      // 将剩余任务强制归入最后一个批次（打破死锁）
      const forced = [...remaining].map((id) => taskMap.get(id)!).filter(Boolean);
      if (forced.length > 0) {
        console.warn(
          `[dependency-analyzer] ⚠️ Circular dependency detected, forcing ${forced.length} tasks into final group`,
        );
        groups.push(forced);
      }
      break;
    }

    groups.push(ready);
    for (const t of ready) {
      remaining.delete(t.id);
    }
  }

  return groups;
}

/**
 * 判断一组任务中是否存在并行机会
 *
 * @param tasks - 待检查的子任务列表
 * @returns true 如果存在可并行的任务（即第一个 group 有 > 1 个任务）
 */
export function hasParallelOpportunity(tasks: SubTask[]): boolean {
  const groups = findParallelGroups(tasks);
  return groups.length > 0 && groups[0].length > 1;
}
