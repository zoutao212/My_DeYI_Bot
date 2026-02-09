/**
 * 执行上下文工厂 — V2 核心组件
 *
 * 替代散落在 FollowupRun 上的布尔标记海洋（isQueueTask/isRootTask/isNewRootTask/taskDepth），
 * 用 4 个语义明确的角色（user/root/leaf/system）统一表达权限边界。
 *
 * 角色推导规则：
 *   user   → 用户直接发消息（非队列任务），完整权限
 *   root   → 根任务（isNewRootTask=true 或 isRootTask=true），可分解
 *   leaf   → 叶子子任务（队列执行的具体工作），仅执行，禁止 enqueue
 *   system → 系统自动分解（shouldAutoDecompose），受控分解
 */

import type {
  ExecutionRole,
  ExecutionContext,
  ExecutionPermissions,
  CreateExecutionContextParams,
} from "./types.js";
import { PERMISSION_MATRIX } from "./types.js";

/**
 * 从 FollowupRun 的旧布尔标记推导 ExecutionRole
 *
 * 过渡期使用：当 FollowupRun 尚未携带 ExecutionContext 时，
 * 从旧字段推导角色，保证向后兼容。
 *
 * @param params 旧布尔标记参数
 * @returns 推导出的执行角色
 */
export function deriveExecutionRole(params: {
  /** 是否是队列任务 */
  isQueueTask?: boolean;
  /** 是否是根任务 */
  isRootTask?: boolean;
  /** 是否是新根任务树 */
  isNewRootTask?: boolean;
  /** 任务深度 */
  taskDepth?: number;
  /** 是否是系统自动分解触发 */
  isAutoDecompose?: boolean;
}): ExecutionRole {
  // 系统自动分解（shouldAutoDecompose 触发）
  if (params.isAutoDecompose) return "system";

  // 用户直接发消息（非队列任务）
  if (!params.isQueueTask) return "user";

  // 新根任务或根任务（可分解子任务）
  if (params.isNewRootTask || params.isRootTask) return "root";

  // 默认：叶子任务（仅执行，禁止 enqueue）
  return "leaf";
}

/**
 * 创建 ExecutionContext（工厂函数）
 *
 * 权限由 role 自动推导（PERMISSION_MATRIX），不可手动覆盖。
 *
 * @param params 创建参数
 * @returns ExecutionContext 实例
 */
export function createExecutionContext(
  params: CreateExecutionContextParams,
): ExecutionContext {
  return {
    role: params.role,
    roundId: params.roundId,
    depth: params.depth,
    permissions: PERMISSION_MATRIX[params.role],
  };
}

/**
 * 获取角色对应的权限集
 *
 * @param role 执行角色
 * @returns 权限集
 */
export function getPermissions(role: ExecutionRole): ExecutionPermissions {
  return PERMISSION_MATRIX[role];
}
