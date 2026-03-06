import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type { SubTask, TaskTree } from "./types.js";
import { ExecutionJournal } from "./execution-journal.js";

export type TaskExecutionResult = {
  ok: boolean;
  outputText: string;
  toolMetas: Array<{ toolName: string; meta?: string }>;
  spotRecoveryExecuted?: boolean;
  attemptOutcome?: EmbeddedPiRunResult["attemptOutcome"];
};

export type JudgeDecision =
  | { action: "accept" }
  | { action: "retry"; reason: string; delayMs?: number }
  | { action: "decompose"; reason: string }
  | { action: "fail"; reason: string };

export type RuntimeExecuteParams = {
  sessionId: string;
  rootTaskId?: string;
  taskTree: TaskTree;
  subTask: SubTask;
};

/**
 * TaskRuntime：把“执行(Executor) + 判定(Judge) + 调度意图(入队请求)”抽象为统一入口。
 *
 * 本文件先提供薄封装与事件落盘，后续逐步把 followup-runner 的散装分支迁移进来。
 */
export class TaskRuntime {
  private journal: ExecutionJournal;

  constructor(sessionId: string) {
    this.journal = new ExecutionJournal(sessionId);
  }

  async recordStart(params: RuntimeExecuteParams): Promise<void> {
    await this.journal.append({
      type: "exec_started",
      rootTaskId: params.rootTaskId,
      subTaskId: params.subTask.id,
      data: {
        taskType: params.subTask.taskType,
        retryCount: params.subTask.retryCount ?? 0,
      },
    });
  }

  async recordFinish(params: RuntimeExecuteParams, exec: TaskExecutionResult): Promise<void> {
    await this.journal.append({
      type: exec.ok ? "exec_finished" : "exec_failed",
      rootTaskId: params.rootTaskId,
      subTaskId: params.subTask.id,
      data: {
        ok: exec.ok,
        outputChars: exec.outputText.length,
        toolNames: exec.toolMetas.map((m) => m.toolName),
        spotRecoveryExecuted: exec.spotRecoveryExecuted ?? false,
      },
    });
  }

  async recordJudge(params: RuntimeExecuteParams, decision: JudgeDecision): Promise<void> {
    await this.journal.append({
      type: "judge_decided",
      rootTaskId: params.rootTaskId,
      subTaskId: params.subTask.id,
      data: decision as unknown as Record<string, unknown>,
    });
  }

  async recordEnqueueRequested(params: RuntimeExecuteParams, data: {
    reason: string;
    delayMs?: number;
    retryCount?: number;
  }): Promise<void> {
    await this.journal.append({
      type: "enqueue_requested",
      rootTaskId: params.rootTaskId,
      subTaskId: params.subTask.id,
      data: {
        reason: data.reason,
        delayMs: data.delayMs ?? 0,
        retryCount: data.retryCount,
      },
    });
  }
}
