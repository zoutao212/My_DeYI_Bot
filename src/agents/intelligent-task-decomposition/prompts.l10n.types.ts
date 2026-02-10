/**
 * 智能任务分解系统的提示词本地化类型定义
 */

export interface TaskDecompositionPromptsL10n {
  // ========================================
  // 任务分解提示词
  // ========================================
  
  /** 任务分解专家角色描述 */
  decompositionExpertRole: string;
  
  /** 任务分解指令 */
  decompositionInstruction: string;
  
  /** 根任务标签 */
  rootTaskLabel: string;
  
  /** 当前任务标签 */
  currentTaskLabel: string;
  
  /** 任务 ID 标签 */
  taskIdLabel: string;
  
  /** 任务描述标签 */
  taskDescriptionLabel: string;
  
  /** 任务深度标签 */
  taskDepthLabel: string;
  
  /** 分解要求标题 */
  decompositionRequirementsTitle: string;
  
  /** 分解要求列表 */
  decompositionRequirements: string[];
  
  /** JSON 格式说明 */
  jsonFormatInstruction: string;
  
  /** 仅返回 JSON 提示 */
  jsonOnlyReminder: string;
  
  // ========================================
  // 失败经验学习提示词
  // ========================================
  
  /** 失败经验学习指令 */
  learningFromFailuresInstruction: string;
  
  /** 失败记录标题模板 */
  failureRecordTitle: (index: number) => string;
  
  /** 失败原因标签 */
  failureReasonLabel: string;
  
  /** 教训标签 */
  lessonsLabel: string;
  
  /** 改进建议标签 */
  improvementsLabel: string;
  
  /** 避免重复错误提示 */
  avoidRepeatMistakesReminder: string;
  
  /** 应用改进建议提示 */
  applyImprovementsReminder: string;
  
  // ========================================
  // 任务调整提示词
  // ========================================
  
  /** 任务调整专家角色描述 */
  adjustmentExpertRole: string;
  
  /** 任务调整指令 */
  adjustmentInstruction: string;
  
  /** 当前子任务标题 */
  currentSubTasksTitle: string;
  
  /** 质量评估结果标题 */
  qualityReviewResultTitle: string;
  
  /** 评估状态标签 */
  reviewStatusLabel: string;
  
  /** 评估决策标签 */
  reviewDecisionLabel: string;
  
  /** 发现的问题标题 */
  findingsTitle: string;
  
  /** 改进建议标题 */
  suggestionsTitle: string;
  
  /** 生成调整方案指令 */
  generateAdjustmentsInstruction: string;
  
  /** 支持的变更类型标题 */
  supportedChangeTypesTitle: string;
  
  /** 变更类型列表 */
  changeTypes: {
    addTask: string;
    removeTask: string;
    modifyTask: string;
    moveTask: string;
    mergeTasks: string;
    splitTask: string;
  };
  
  // ========================================
  // 任务估算提示词
  // ========================================
  
  /** 任务估算专家角色描述 */
  estimationExpertRole: string;
  
  /** 任务估算指令 */
  estimationInstruction: string;
  
  /** 任务信息标题 */
  taskInfoTitle: string;
  
  /** 评估方面标题 */
  evaluationAspectsTitle: string;
  
  /** 复杂度说明 */
  complexityDescription: {
    title: string;
    low: string;
    medium: string;
    high: string;
  };
  
  /** 预计时长说明 */
  durationDescription: {
    title: string;
    unit: string;
    considerations: string;
  };
  
  // ========================================
  // 质量评估提示词
  // ========================================
  
  /** 质量评估专家角色描述 */
  qualityReviewExpertRole: string;
  
  /** 质量评估指令 */
  qualityReviewInstruction: string;
  
  /** 评估标准标题 */
  reviewCriteriaTitle: string;
  
  /** 评估标准列表 */
  reviewCriteria: string[];
  
  /** 评估决策说明 */
  reviewDecisions: {
    title: string;
    continue: string;
    adjust: string;
    restart: string;
    overthrow: string;
  };
  
  // 任务分解评估
  decompositionReview: {
    expertRole: string;
    instruction: string;
    aspectsTitle: string;
    aspects: {
      coverage: string;
      independence: string;
      granularity: string;
      dependencies: string;
      completeness: string;
      redundancy: string;
      quantitative: string;
    };
  };
  
  // 子任务完成评估
  completionReview: {
    expertRole: string;
    instruction: string;
    aspectsTitle: string;
    aspects: {
      completeness: string;
      correctness: string;
      integrity: string;
      quality: string;
      quantitative: string;
      coherence: string;
    };
  };
  
  // 整体完成评估
  overallReview: {
    expertRole: string;
    instruction: string;
    aspectsTitle: string;
    aspects: {
      goalAchievement: string;
      completeness: string;
      consistency: string;
      quality: string;
      coherence: string;
    };
  };
  
  // 失败分析
  failureAnalysis: {
    expertRole: string;
    instruction: string;
    aspectsTitle: string;
    aspects: {
      directCause: string;
      rootCause: string;
      lessons: string;
      improvements: string;
    };
    decisionsTitle: string;
    decisions: {
      adjust: string;
      restart: string;
      overthrow: string;
    };
  };
  
  // 通用标签
  labels: {
    rootTask: string;
    subTaskList: string;
    subTaskInfo: string;
    completedSubTasks: string;
    errorInfo: string;
    reviewStatus: string;
    reviewDecision: string;
    findings: string;
    suggestions: string;
    evaluationCriteria: string;
    description: string;
    status: string;
    output: string;
    noOutput: string;
    reviewTypeLabels: {
      initial_decomposition: string;
      subtask_completion: string;
      overall_completion: string;
      failure_analysis: string;
    };
    qualityStatusLabels: {
      pending: string;
      passed: string;
      partial: string;
      needs_adjustment: string;
      needs_restart: string;
      needs_overthrow: string;
    };
    reviewDecisionLabels: {
      continue: string;
      adjust: string;
      restart: string;
      overthrow: string;
      decompose: string;
    };
    changeTypeLabels: {
      add_task: string;
      remove_task: string;
      modify_task: string;
      move_task: string;
      merge_tasks: string;
      split_task: string;
    };
  };
  
  // ========================================
  // 任务调整器提示词
  // ========================================
  taskAdjuster: {
    errors: {
      changeValidationFailed: string;
      targetTaskNotFound: string;
      addTaskMissingAfter: string;
      modifyTaskMissingAfter: string;
      moveTaskMissingParentId: string;
      noTasksToMerge: string;
      taskNotFound: string;
      unknownChangeType: string;
      applyChangeFailed: string;
    };
    logs: {
      retryCountExceeded: string;
      improvementSuggestion: string;
    };
  };
  
  // ========================================
  // 恢复管理器提示词
  // ========================================
  recoveryManager: {
    logs: {
      restoredFromCheckpoint: string;
      failedToRestore: string;
      recoveredTaskTree: string;
      reexecutingTasks: string;
      reexecutingTask: string;
    };
  };
  
  // ========================================
  // 重试管理器提示词
  // ========================================
  retryManager: {
    logs: {
      executingTask: string;
      taskSucceeded: string;
      taskFailed: string;
      errorNotRetryable: string;
      waitingBeforeRetry: string;
      allRetriesFailed: string;
      failureLogged: string;
    };
  };
  
  // ========================================
  // 质量评审器提示词
  // ========================================
  qualityReviewer: {
    errors: {
      reviewFailed: string;
      subTaskNotFound: string;
      completionReviewFailed: string;
      overallReviewFailed: string;
      failureAnalysisFailed: string;
      saveRecordFailed: string;
    };
    report: {
      title: string;
      taskTreeId: string;
      reviewType: string;
      reviewTime: string;
      reviewStatus: string;
      reviewDecision: string;
      criteriaTitle: string;
      findingsTitle: string;
      suggestionsTitle: string;
      changesTitle: string;
      changeTarget: string;
    };
  };
}
