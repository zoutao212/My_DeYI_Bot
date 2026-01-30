/**
 * 任务分解、展示和总结机制
 * 
 * 本模块提供了任务自动拆解、进度可视化、失败处理和自我改进的完整功能。
 * 
 * @example
 * ```typescript
 * import { createOrchestrator } from "./agents/task-board/index.js";
 * 
 * // 创建 Orchestrator
 * const orchestrator = createOrchestrator({
 *   sessionId: "session_123",
 *   enableConcurrentExecution: false,
 *   enableAutoRetry: false,
 *   maxRetries: 3
 * });
 * 
 * // 处理任务
 * const taskBoard = await orchestrator.handleTask(
 *   "创建任务分解和跟踪机制",
 *   {
 *     codebase: "/path/to/codebase",
 *     recentMessages: []
 *   }
 * );
 * 
 * // 恢复任务
 * const resumedBoard = await orchestrator.resumeTask("session_123");
 * ```
 */

// 导出类型
export type {
  TaskBoard,
  MainTask,
  SubTask,
  SubTaskStatus,
  MainTaskStatus,
  CurrentFocus,
  Checkpoint,
  Risk,
  ContextAnchors,
  DecompositionContext,
  ExecutionContext,
  ExecutionResult,
  FailureDecision,
  FailureSummary
} from "./types.js";

// 导出接口
export type { TaskDecomposer } from "./decomposer.js";
export type { TaskExecutor } from "./executor.js";
export type { ProgressTracker } from "./progress-tracker.js";
export type { FailureHandler } from "./failure-handler.js";

// 导出自我改进相关类型
export type {
  ReusablePattern,
  ImprovementSuggestion
} from "./self-improvement.js";

// 导出 Orchestrator
export {
  AgentOrchestrator,
  createOrchestrator,
  type OrchestratorConfig
} from "./orchestrator.js";

// 导出工厂函数
export { createTaskDecomposer } from "./decomposer.js";
export { createTaskExecutor } from "./executor.js";
export { createProgressTracker } from "./progress-tracker.js";
export { createFailureHandler } from "./failure-handler.js";
export { createSelfImprovementEngine } from "./self-improvement.js";

// 导出持久化函数
export {
  saveTaskBoard,
  loadTaskBoard,
  taskBoardExists,
  deleteTaskBoard,
  getTaskBoardDir,
  getTaskBoardJsonPath,
  getTaskBoardMarkdownPath
} from "./persistence.js";

// 导出渲染函数
export {
  renderToJSON,
  renderToMarkdown,
  saveTaskBoardWithRendering
} from "./renderer.js";

// 导出 LLM 驱动的任务分解器
export {
  LLMTaskDecomposer,
  createLLMTaskDecomposer,
  type LLMConfig
} from "./decomposer-llm.js";

// 导出 Agent 集成
export {
  AgentTaskDecompositionHandler,
  createAgentTaskDecompositionHandler,
  type AgentTaskDecompositionConfig
} from "./agent-integration.js";

// 导出 CLI 集成
export {
  cliTaskDecompose,
  cliTaskResume
} from "./cli-integration.js";
