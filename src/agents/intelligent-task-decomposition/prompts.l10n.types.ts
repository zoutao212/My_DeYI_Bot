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
  // 🆕 V3: 总纲领生成提示词（Master Blueprint）
  // ========================================

  /** 总纲领生成 — 专家角色描述 */
  blueprintExpertRole: string;

  /** 总纲领生成 — 整体指令（纲领用途、详细度要求） */
  blueprintInstruction: string;

  /** 总纲领生成 — 保证并行一致性的要点列表 */
  blueprintConsistencyPoints: string[];

  /** 总纲领生成 — 按任务类型区分的内容要求 */
  blueprintTypeHints: {
    writing: string;
    coding: string;
    research: string;
    data: string;
    design: string;
    analysis: string;
    generic: string;
    [key: string]: string;
  };

  /** 总纲领生成 — 原始任务标签 */
  blueprintOriginalTaskLabel: string;

  /** 总纲领生成 — 输出格式提示（Markdown，不要 JSON） */
  blueprintOutputFormatHint: string;

  /** 分解提示词中的纲领注入指令（告知 LLM 如何基于纲领分解） */
  blueprintDecompositionInstruction: string;

  /** 分解提示词中的 chapterOutline 提取指令 */
  blueprintChapterOutlineInstruction: string;

  /** 纲领截断提示 */
  blueprintTruncatedHint: string;

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
  // 🆕 V5: 大文本 Map-Reduce 分析提示词
  // ========================================
  mapReduce: {
    /** Map 子任务标题模板 */
    mapTitle: (chunkIndex: number, totalChunks: number) => string;
    /** 读取文件指令 */
    mapReadFileInstruction: string;
    /** 行范围指令 */
    mapLineRangeInstruction: string;
    /** 分析目标引导语 */
    mapAnalysisGoalIntro: string;
    /** Map 重要提示标题 */
    mapImportantTitle: string;
    /** 必须先用 read 工具读取 */
    mapMustReadFirst: string;
    /** 将分析结果写入文件 */
    mapWriteToFile: string;
    /** 文件名格式说明 */
    mapFileNameFormat: string;
    /** 分析结果应包含 */
    mapResultContents: string;
    /** 需要精读提示 */
    mapDeepReadHint: string;
    /** 重叠行提示 */
    mapOverlapNote: (overlapLines: number) => string;

    /** Reduce 子任务标题模板 */
    reduceTitle: (batchIndex: number, totalBatches: number) => string;
    /** Reduce 读取引导语 */
    reduceReadIntro: string;
    /** Reduce 整合目标引导语 */
    reduceGoalIntro: string;
    /** Reduce 要求标题 */
    reduceRequirementsTitle: string;
    /** 使用 read 工具读取 */
    reduceReadFiles: string;
    /** 去重合并提炼 */
    reduceDedup: string;
    /** 保存到文件 */
    reduceSaveTo: string;
    /** 保留关键发现 */
    reduceKeepFindings: string;

    /** Finalize 子任务标题 */
    finalizeTitle: string;
    /** Finalize 读取引导语（reduce 来源） */
    finalizeReadIntroFromReduce: string;
    /** Finalize 读取引导语（map 直出） */
    finalizeReadIntroFromMap: string;
    /** Finalize 目标引导语 */
    finalizeGoalIntro: string;
    /** Finalize 要求标题 */
    finalizeRequirementsTitle: string;
    /** 使用 read 工具读取 */
    finalizeReadFiles: string;
    /** 综合分析生成交付物 */
    finalizeSynthesize: string;
    /** 使用 write 工具保存 */
    finalizeWriteOutput: string;
    /** 保存到目标文件 */
    finalizeSaveTo: string;
    /** 确保完整无遗漏 */
    finalizeEnsureComplete: string;

    /** chunk 子任务的文件类型提示（followup-runner 注入） */
    chunkFileTypeHint: string;
    /** 普通子任务的文件类型提示 */
    defaultFileTypeHint: string;
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
