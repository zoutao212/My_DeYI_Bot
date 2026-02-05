import type { TaskDecompositionPromptsL10n } from "./prompts.l10n.types.js";

/**
 * 智能任务分解系统的中文提示词
 */
export const TASK_DECOMPOSITION_PROMPTS_ZH: TaskDecompositionPromptsL10n = {
  // ========================================
  // 任务分解提示词
  // ========================================
  
  decompositionExpertRole: "你是一个任务分解专家。",
  
  decompositionInstruction: "请将以下任务分解为 2-8 个可执行的子任务。",
  
  rootTaskLabel: "根任务",
  
  currentTaskLabel: "当前任务",
  
  taskIdLabel: "ID",
  
  taskDescriptionLabel: "描述",
  
  taskDepthLabel: "深度",
  
  decompositionRequirementsTitle: "分解要求：",
  
  decompositionRequirements: [
    "子任务数量：2-8 个",
    "每个子任务应该是独立可执行的",
    "子任务应该覆盖当前任务的所有要求",
    "子任务之间可以有依赖关系",
    "子任务的粒度应该适中（不要过于细碎或过于粗糙）",
  ],
  
  jsonFormatInstruction: "请按照以下 JSON 格式返回分解结果：",
  
  jsonOnlyReminder: "请只返回 JSON 对象，不要包含其他内容。",
  
  // ========================================
  // 失败经验学习提示词
  // ========================================
  
  learningFromFailuresInstruction: "**重要：从以下失败经验中学习，避免重复错误**",
  
  failureRecordTitle: (index: number) => `### 失败记录 ${index + 1}`,
  
  failureReasonLabel: "原因",
  
  lessonsLabel: "教训",
  
  improvementsLabel: "改进建议",
  
  avoidRepeatMistakesReminder: "**特别注意避免上述失败记录中提到的问题**",
  
  applyImprovementsReminder: "应用失败记录中的改进建议",
  
  // ========================================
  // 任务调整提示词
  // ========================================
  
  adjustmentExpertRole: "你是一个任务调整专家。",
  
  adjustmentInstruction: "请根据质量评估结果生成任务树调整方案。",
  
  currentSubTasksTitle: "当前子任务：",
  
  qualityReviewResultTitle: "质量评估结果：",
  
  reviewStatusLabel: "状态",
  
  reviewDecisionLabel: "决策",
  
  findingsTitle: "发现的问题：",
  
  suggestionsTitle: "改进建议：",
  
  generateAdjustmentsInstruction: "请生成具体的调整方案，将改进建议转换为可执行的变更操作。",
  
  supportedChangeTypesTitle: "支持的变更类型：",
  
  changeTypes: {
    addTask: "add_task: 添加新的子任务",
    removeTask: "remove_task: 删除不必要的子任务",
    modifyTask: "modify_task: 修改子任务的描述或依赖关系",
    moveTask: "move_task: 移动子任务到新的父任务",
    mergeTasks: "merge_tasks: 合并多个子任务",
    splitTask: "split_task: 拆分子任务为多个子任务",
  },
  
  // ========================================
  // 任务估算提示词
  // ========================================
  
  estimationExpertRole: "你是一个任务估算专家。",
  
  estimationInstruction: "请估算以下任务的复杂度和预计时长。",
  
  taskInfoTitle: "任务信息：",
  
  evaluationAspectsTitle: "请从以下几个方面评估任务：",
  
  complexityDescription: {
    title: "**复杂度**：",
    low: "low: 简单任务，可以快速完成",
    medium: "medium: 中等复杂度，需要一定时间",
    high: "high: 复杂任务，需要较长时间",
  },
  
  durationDescription: {
    title: "**预计时长**：",
    unit: "以毫秒为单位",
    considerations: "考虑任务的复杂度和工作量",
  },
  
  // ========================================
  // 质量评估提示词
  // ========================================
  
  qualityReviewExpertRole: "你是一个质量评估专家。",
  
  qualityReviewInstruction: "请评估以下任务树的质量。",
  
  reviewCriteriaTitle: "评估标准：",
  
  reviewCriteria: [
    "任务分解是否合理",
    "子任务是否覆盖了所有要求",
    "子任务之间的依赖关系是否正确",
    "任务粒度是否适中",
    "是否存在重复或冗余的任务",
  ],
  
  reviewDecisions: {
    title: "评估决策：",
    continue: "continue: 继续执行，质量良好",
    adjust: "adjust: 需要调整，但不需要重新分解",
    restart: "restart: 需要重新分解，保留失败经验",
    overthrow: "overthrow: 完全推翻，从头开始",
  },
  
  // 任务分解评估
  decompositionReview: {
    expertRole: "你是一个任务质量评估专家。",
    instruction: "请评估以下任务分解的质量。",
    aspectsTitle: "请从以下几个方面评估任务分解的质量：",
    aspects: {
      coverage: "**覆盖性**：子任务是否完整覆盖了根任务的所有要求？",
      independence: "**独立性**：每个子任务是否可以独立执行？",
      granularity: "**合理性**：子任务的粒度是否合理？是否过于细碎或过于粗糙？",
      dependencies: "**依赖性**：子任务之间的依赖关系是否合理？",
      completeness: "**完整性**：是否有遗漏的重要步骤？",
      redundancy: "**冗余性**：是否有重复或不必要的子任务？",
    },
  },
  
  // 子任务完成评估
  completionReview: {
    expertRole: "你是一个任务质量评估专家。",
    instruction: "请评估以下子任务的完成质量。",
    aspectsTitle: "请从以下几个方面评估子任务的完成质量：",
    aspects: {
      completeness: "**完成度**：是否完成了任务描述中的所有要求？",
      correctness: "**正确性**：输出是否正确？是否有错误？",
      integrity: "**完整性**：是否有遗漏的内容？",
      quality: "**质量**：输出的质量如何？是否需要改进？",
    },
  },
  
  // 整体完成评估
  overallReview: {
    expertRole: "你是一个任务质量评估专家。",
    instruction: "请评估以下任务的整体完成质量。",
    aspectsTitle: "请从以下几个方面评估整体完成质量：",
    aspects: {
      goalAchievement: "**目标达成**：是否达成了根任务的目标？",
      completeness: "**完整性**：是否有遗漏的重要内容？",
      consistency: "**一致性**：各个子任务的输出是否一致？是否有冲突？",
      quality: "**质量**：整体质量如何？是否需要改进？",
    },
  },
  
  // 失败分析
  failureAnalysis: {
    expertRole: "你是一个任务失败分析专家。",
    instruction: "请分析以下子任务失败的原因。",
    aspectsTitle: "请从以下几个方面分析失败原因：",
    aspects: {
      directCause: "**直接原因**：导致失败的直接原因是什么？",
      rootCause: "**根本原因**：失败的根本原因是什么？",
      lessons: "**教训**：从这次失败中可以学到什么？",
      improvements: "**改进建议**：如何避免类似的失败？",
    },
    decisionsTitle: "决策说明：",
    decisions: {
      adjust: "adjust: 小问题，调整后重试",
      restart: "restart: 严重问题，需要保留经验并重新分解",
      overthrow: "overthrow: 根本性错误，需要完全推翻重来",
    },
  },
  
  // 通用标签
  labels: {
    rootTask: "根任务",
    subTaskList: "子任务列表",
    subTaskInfo: "子任务信息",
    completedSubTasks: "已完成的子任务",
    errorInfo: "错误信息",
    reviewStatus: "状态",
    reviewDecision: "决策",
    findings: "发现的问题",
    suggestions: "改进建议",
    evaluationCriteria: "评估标准",
    description: "描述",
    status: "状态",
    output: "输出",
    noOutput: "无",
    reviewTypeLabels: {
      initial_decomposition: "初始任务分解",
      subtask_completion: "子任务完成",
      overall_completion: "整体完成",
      failure_analysis: "失败分析",
    },
    qualityStatusLabels: {
      pending: "待评估",
      passed: "通过",
      needs_adjustment: "需要调整",
      needs_restart: "需要重启",
      needs_overthrow: "需要推翻",
    },
    reviewDecisionLabels: {
      continue: "继续执行",
      adjust: "调整任务树",
      restart: "重启任务",
      overthrow: "推翻任务",
    },
    changeTypeLabels: {
      add_task: "添加任务",
      remove_task: "删除任务",
      modify_task: "修改任务",
      move_task: "移动任务",
      merge_tasks: "合并任务",
      split_task: "拆分任务",
    },
  },
};
