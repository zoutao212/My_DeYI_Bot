import type { TaskDecompositionPromptsL10n } from "./prompts.l10n.types.js";

/**
 * English prompts for intelligent task decomposition system
 */
export const TASK_DECOMPOSITION_PROMPTS_EN: TaskDecompositionPromptsL10n = {
  // ========================================
  // Task Decomposition Prompts
  // ========================================
  
  decompositionExpertRole: "You are a task decomposition expert.",
  
  decompositionInstruction: "Please decompose the following task into 2-8 executable subtasks.",
  
  rootTaskLabel: "Root Task",
  
  currentTaskLabel: "Current Task",
  
  taskIdLabel: "ID",
  
  taskDescriptionLabel: "Description",
  
  taskDepthLabel: "Depth",
  
  decompositionRequirementsTitle: "Decomposition Requirements:",
  
  decompositionRequirements: [
    "Number of subtasks: 2-8",
    "Each subtask should be independently executable",
    "Subtasks should cover all requirements of the current task",
    "Subtasks can have dependencies between them",
    "Subtask granularity should be moderate (not too fine-grained or too coarse)",
  ],
  
  jsonFormatInstruction: "Please return the decomposition result in the following JSON format:",
  
  jsonOnlyReminder: "Please return only the JSON object, without any other content.",
  
  // ========================================
  // Learning from Failures Prompts
  // ========================================
  
  learningFromFailuresInstruction: "**Important: Learn from the following failure experiences and avoid repeating mistakes**",
  
  failureRecordTitle: (index: number) => `### Failure Record ${index + 1}`,
  
  failureReasonLabel: "Reason",
  
  lessonsLabel: "Lessons",
  
  improvementsLabel: "Improvements",
  
  avoidRepeatMistakesReminder: "**Pay special attention to avoid the issues mentioned in the above failure records**",
  
  applyImprovementsReminder: "Apply the improvements from the failure records",
  
  // ========================================
  // Task Adjustment Prompts
  // ========================================
  
  adjustmentExpertRole: "You are a task adjustment expert.",
  
  adjustmentInstruction: "Please generate task tree adjustment plan based on quality review results.",
  
  currentSubTasksTitle: "Current Subtasks:",
  
  qualityReviewResultTitle: "Quality Review Results:",
  
  reviewStatusLabel: "Status",
  
  reviewDecisionLabel: "Decision",
  
  findingsTitle: "Findings:",
  
  suggestionsTitle: "Suggestions:",
  
  generateAdjustmentsInstruction: "Please generate specific adjustment plan, converting improvement suggestions into executable change operations.",
  
  supportedChangeTypesTitle: "Supported Change Types:",
  
  changeTypes: {
    addTask: "add_task: Add new subtask",
    removeTask: "remove_task: Remove unnecessary subtask",
    modifyTask: "modify_task: Modify subtask description or dependencies",
    moveTask: "move_task: Move subtask to new parent task",
    mergeTasks: "merge_tasks: Merge multiple subtasks",
    splitTask: "split_task: Split subtask into multiple subtasks",
  },
  
  // ========================================
  // Task Estimation Prompts
  // ========================================
  
  estimationExpertRole: "You are a task estimation expert.",
  
  estimationInstruction: "Please estimate the complexity and duration of the following task.",
  
  taskInfoTitle: "Task Information:",
  
  evaluationAspectsTitle: "Please evaluate the task from the following aspects:",
  
  complexityDescription: {
    title: "**Complexity**:",
    low: "low: Simple task, can be completed quickly",
    medium: "medium: Medium complexity, requires some time",
    high: "high: Complex task, requires considerable time",
  },
  
  durationDescription: {
    title: "**Estimated Duration**:",
    unit: "In milliseconds",
    considerations: "Consider task complexity and workload",
  },
  
  // ========================================
  // Quality Review Prompts
  // ========================================
  
  qualityReviewExpertRole: "You are a quality review expert.",
  
  qualityReviewInstruction: "Please evaluate the quality of the following task tree.",
  
  reviewCriteriaTitle: "Review Criteria:",
  
  reviewCriteria: [
    "Is the task decomposition reasonable",
    "Do subtasks cover all requirements",
    "Are dependencies between subtasks correct",
    "Is task granularity appropriate",
    "Are there duplicate or redundant tasks",
  ],
  
  reviewDecisions: {
    title: "Review Decisions:",
    continue: "continue: Continue execution, quality is good",
    adjust: "adjust: Needs adjustment, but no need to re-decompose",
    restart: "restart: Needs re-decomposition, retain failure experience",
    overthrow: "overthrow: Completely overthrow, start from scratch",
  },
  
  // Decomposition Review
  decompositionReview: {
    expertRole: "You are a task quality review expert.",
    instruction: "Please evaluate the quality of the following task decomposition.",
    aspectsTitle: "Please evaluate the task decomposition quality from the following aspects:",
    aspects: {
      coverage: "**Coverage**: Do subtasks completely cover all requirements of the root task?",
      independence: "**Independence**: Can each subtask be executed independently?",
      granularity: "**Granularity**: Is the subtask granularity reasonable? Is it too fine-grained or too coarse?",
      dependencies: "**Dependencies**: Are dependencies between subtasks reasonable?",
      completeness: "**Completeness**: Are there any missing important steps?",
      redundancy: "**Redundancy**: Are there duplicate or unnecessary subtasks?",
    },
  },
  
  // Completion Review
  completionReview: {
    expertRole: "You are a task quality review expert.",
    instruction: "Please evaluate the completion quality of the following subtask.",
    aspectsTitle: "Please evaluate the subtask completion quality from the following aspects:",
    aspects: {
      completeness: "**Completeness**: Are all requirements in the task description completed?",
      correctness: "**Correctness**: Is the output correct? Are there any errors?",
      integrity: "**Integrity**: Is there any missing content?",
      quality: "**Quality**: How is the output quality? Does it need improvement?",
    },
  },
  
  // Overall Review
  overallReview: {
    expertRole: "You are a task quality review expert.",
    instruction: "Please evaluate the overall completion quality of the following task.",
    aspectsTitle: "Please evaluate the overall completion quality from the following aspects:",
    aspects: {
      goalAchievement: "**Goal Achievement**: Has the root task goal been achieved?",
      completeness: "**Completeness**: Is there any missing important content?",
      consistency: "**Consistency**: Are outputs of subtasks consistent? Are there any conflicts?",
      quality: "**Quality**: How is the overall quality? Does it need improvement?",
    },
  },
  
  // Failure Analysis
  failureAnalysis: {
    expertRole: "You are a task failure analysis expert.",
    instruction: "Please analyze the cause of the following subtask failure.",
    aspectsTitle: "Please analyze the failure cause from the following aspects:",
    aspects: {
      directCause: "**Direct Cause**: What is the direct cause of the failure?",
      rootCause: "**Root Cause**: What is the root cause of the failure?",
      lessons: "**Lessons**: What can be learned from this failure?",
      improvements: "**Improvements**: How to avoid similar failures?",
    },
    decisionsTitle: "Decision Explanation:",
    decisions: {
      adjust: "adjust: Minor issue, retry after adjustment",
      restart: "restart: Serious issue, needs to retain experience and re-decompose",
      overthrow: "overthrow: Fundamental error, needs to completely overthrow and start over",
    },
  },
  
  // Common Labels
  labels: {
    rootTask: "Root Task",
    subTaskList: "Subtask List",
    subTaskInfo: "Subtask Information",
    completedSubTasks: "Completed Subtasks",
    errorInfo: "Error Information",
    reviewStatus: "Status",
    reviewDecision: "Decision",
    findings: "Findings",
    suggestions: "Suggestions",
    evaluationCriteria: "Evaluation Criteria",
    description: "Description",
    status: "Status",
    output: "Output",
    noOutput: "None",
    reviewTypeLabels: {
      initial_decomposition: "Initial Task Decomposition",
      subtask_completion: "Subtask Completion",
      overall_completion: "Overall Completion",
      failure_analysis: "Failure Analysis",
    },
    qualityStatusLabels: {
      pending: "Pending Review",
      passed: "Passed",
      needs_adjustment: "Needs Adjustment",
      needs_restart: "Needs Restart",
      needs_overthrow: "Needs Overthrow",
    },
    reviewDecisionLabels: {
      continue: "Continue Execution",
      adjust: "Adjust Task Tree",
      restart: "Restart Task",
      overthrow: "Overthrow Task",
    },
    changeTypeLabels: {
      add_task: "Add Task",
      remove_task: "Remove Task",
      modify_task: "Modify Task",
      move_task: "Move Task",
      merge_tasks: "Merge Tasks",
      split_task: "Split Task",
    },
  },
};
