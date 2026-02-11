import type { TaskDecompositionPromptsL10n } from "./prompts.l10n.types.js";

/**
 * English prompts for intelligent task decomposition system
 */
export const TASK_DECOMPOSITION_PROMPTS_EN: TaskDecompositionPromptsL10n = {
  // ========================================
  // Task Decomposition Prompts
  // ========================================
  
  decompositionExpertRole: "You are a senior task decomposition expert skilled at breaking complex tasks into well-structured, independently executable subtasks.",
  
  decompositionInstruction: "Please decompose the following task into 2-8 executable subtasks. Consider dependencies between tasks, parallel execution opportunities, and quantitative output requirements for each subtask.",
  
  rootTaskLabel: "Root Task",
  
  currentTaskLabel: "Current Task",
  
  taskIdLabel: "ID",
  
  taskDescriptionLabel: "Description",
  
  taskDepthLabel: "Depth",
  
  decompositionRequirementsTitle: "Decomposition Requirements:",
  
  decompositionRequirements: [
    "Number of subtasks: 2-8",
    "Each subtask should be independently executable, minimize dependencies to enable parallel execution",
    "Subtasks should cover all requirements of the current task without missing any key steps",
    "Subtasks can have dependencies (via dependencies field), but independent tasks should be parallelizable",
    "Subtask granularity should be moderate (not too fine-grained or too coarse)",
    "If the original task has word count/length/quantity requirements, each subtask prompt must explicitly allocate specific quantitative targets (e.g., this chapter requires 3000+ words)",
    "Each subtask prompt should be detailed enough, including: goal, specific requirements, quantitative metrics, output format",
    "For writing tasks: each subtask prompt must include explicit word count requirements, and the sum of all subtask word counts should be >= total requirement",
    "⚠️ Capability constraint: Each subtask's expected output should not exceed 2000 characters (Chinese) or 1500 words (English). If a section needs more content, split it into multiple subtasks linked by dependencies for coherence",
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
  // 🆕 V3: Master Blueprint Generation Prompts
  // ========================================

  blueprintExpertRole: "You are a senior project planning expert.",

  blueprintInstruction: `Your task is to generate a **complete, detailed Master Blueprint** for the following large-scale task.

This blueprint will serve as the "conductor's score", guiding multiple independent executors (each seeing only their subtask + this blueprint) to work in parallel.
Therefore, the blueprint must be detailed enough so that each executor, even without knowing other executors' specific outputs, can ensure:`,

  blueprintConsistencyPoints: [
    "Consistent content style",
    "Consistent character/concept descriptions",
    "Clear interfaces/connection points",
    "No contradictions or redundancy",
  ],

  blueprintTypeHints: {
    writing: `This is a creative writing task. Please generate a complete creative blueprint including:
1. **World Building**: Core settings, background rules, important locations
2. **Character Profiles**: Each character's personality traits, motivations, growth arcs, relationship networks
3. **Main Plot**: Complete outline of beginning-development-climax-resolution, key turning points
4. **Detailed Chapter Outlines**: For each chapter/section:
   - Core plot points (opening→development→climax→resolution)
   - Appearing characters and their actions
   - Scene description key points
   - Connection points with preceding/following chapters ("hooks")
   - Target word count and style requirements
5. **Style Guide**: Narrative perspective, language style, atmospheric tone
6. **Continuity Markers**: Foreshadowing between chapters, callbacks, character state changes`,
    coding: `This is a coding task. Please generate a complete technical blueprint including:
1. **Architecture Design**: Module division, interface definitions, data flow
2. **Detailed Module Specifications**: Input/output, dependencies, key function signatures
3. **Implementation Order**: Which modules can be developed in parallel, which have sequential dependencies
4. **Quality Standards**: Acceptance criteria and test points for each module`,
    generic: `Based on the task content, please generate a complete execution blueprint including:
1. **Overall Goals** and success criteria
2. **Step-by-step Plan**: Detailed description and acceptance criteria for each subtask
3. **Dependencies and coordination between subtasks**
4. **Quality control points**`,
  },

  blueprintOriginalTaskLabel: "Original Task",

  blueprintOutputFormatHint: "Please output the blueprint content directly (Markdown format). Do not output JSON or explain your thinking process.\nThe blueprint should be detailed enough for each executor to independently complete their work by looking at only their section.",

  blueprintDecompositionInstruction: `📋 **Master Blueprint**: Below is the pre-generated detailed planning blueprint for this task.
When decomposing subtasks, each subtask's prompt must include the detailed requirements from the corresponding section of the blueprint (scenes, characters, connection points, etc.).
Do not generate vague prompts — incorporate the specific content from the blueprint into each subtask.
Also, if subtasks have no data dependencies (e.g., individual chapter writing), set dependencies to an empty array [],
so the system can execute them in parallel for faster completion.`,

  blueprintChapterOutlineInstruction: `🔑 **Important**: Each subtask's metadata must include a "chapterOutline" field,
extracting the chapter/module outline corresponding to that subtask from the blueprint (scenes, character actions, emotional nodes, connection points, etc.) verbatim.
This outline will serve as the executor's dedicated guide, ensuring content consistency during parallel execution.`,

  blueprintTruncatedHint: "...[Blueprint truncated]",

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
    expertRole: "You are a strict task quality review expert skilled in evaluating decomposition plans.",
    instruction: "Please rigorously evaluate the quality of the following task decomposition. Pay special attention to: whether quantitative metrics are properly allocated to subtasks, whether there are parallel execution opportunities, and whether granularity is appropriate.",
    aspectsTitle: "Please evaluate the task decomposition quality from the following aspects:",
    aspects: {
      coverage: "**Coverage**: Do subtasks completely cover all requirements of the root task? Are there missing key steps?",
      independence: "**Independence**: Can each subtask be executed independently? Can tasks without dependencies run in parallel?",
      granularity: "**Granularity**: Is the subtask granularity reasonable? Is it too fine-grained or too coarse?",
      dependencies: "**Dependencies**: Are dependencies between subtasks reasonable? Are there unnecessary serial dependencies blocking parallel execution?",
      completeness: "**Completeness**: Are there any missing important steps?",
      redundancy: "**Redundancy**: Are there duplicate or unnecessary subtasks?",
      quantitative: "**Quantitative Allocation**: If the root task has word count/quantity requirements, are they properly allocated to subtasks? Does the sum of all subtask metrics >= total requirement?",
    },
  },
  
  // Completion Review
  completionReview: {
    expertRole: "You are a strict task quality review expert skilled in multi-dimensional deep review.",
    instruction: "Please rigorously evaluate the following subtask completion quality from multiple dimensions. Important: if the task has explicit word count/length requirements, you must verify whether the actual output meets them.",
    aspectsTitle: "Please evaluate the subtask completion quality from the following aspects:",
    aspects: {
      completeness: "**Completeness**: Are all requirements in the task description completed? Are there any missing sub-items?",
      correctness: "**Correctness**: Is the output accurate? Is the logic consistent? Are there factual errors?",
      integrity: "**Integrity**: Is the content complete? Is the structure complete (has beginning and ending)? Is there obvious truncation or rushed ending?",
      quality: "**Quality**: How is the output quality? Does the writing/code quality meet expectations?",
      quantitative: "**Quantitative Compliance**: If the task specified word count, length, quantity or other quantitative metrics, does the actual output reach at least 70% of the requirement? Below 70% must be judged as restart. Please estimate actual word count and compare with the requirement.",
      coherence: "**Coherence**: Is the content coherent throughout? Is the style consistent? Are there abrupt jumps or contradictions?",
    },
  },
  
  // Overall Review
  overallReview: {
    expertRole: "You are a strict task quality review expert skilled in holistic assessment.",
    instruction: "Please rigorously evaluate the overall completion quality from a global perspective. Focus on: whether quantitative metrics are met, whether subtask outputs are coordinated, and whether there are obvious quality weaknesses.",
    aspectsTitle: "Please evaluate the overall completion quality from the following aspects:",
    aspects: {
      goalAchievement: "**Goal Achievement**: Has the root task goal been achieved? Are quantitative metrics (word count, quantity, etc.) met?",
      completeness: "**Completeness**: Is there any missing important content? Do all subtask outputs together form a complete deliverable?",
      consistency: "**Consistency**: Are outputs of subtasks stylistically consistent? Are there contradictions or conflicts? Are terminology and naming consistent?",
      quality: "**Quality**: How is the overall quality? Are there obvious quality weaknesses dragging down the overall level?",
      coherence: "**Coherence**: Are transitions between parts natural? Are there abrupt breaks or repetitions?",
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
      partial: "Partial",
      needs_adjustment: "Needs Adjustment",
      needs_restart: "Needs Restart",
      needs_overthrow: "Needs Overthrow",
    },
    reviewDecisionLabels: {
      continue: "Continue Execution",
      adjust: "Adjust Task Tree",
      restart: "Restart Task",
      overthrow: "Overthrow Task",
      decompose: "Incremental Decompose",
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
  
  // ========================================
  // Task Adjuster Prompts
  // ========================================
  taskAdjuster: {
    errors: {
      changeValidationFailed: "Change validation failed",
      targetTaskNotFound: "Target task does not exist",
      addTaskMissingAfter: "add_task change is missing 'after' field",
      modifyTaskMissingAfter: "modify_task change is missing 'after' field",
      moveTaskMissingParentId: "move_task change is missing 'after.parentId' field",
      noTasksToMerge: "No tasks found to merge",
      taskNotFound: "Task does not exist",
      unknownChangeType: "Unknown change type",
      applyChangeFailed: "Failed to apply change",
    },
    logs: {
      retryCountExceeded: "Task retry count exceeded, suggest splitting into smaller subtasks",
      improvementSuggestion: "Improvement suggestion",
    },
  },
  
  // ========================================
  // Recovery Manager Prompts
  // ========================================
  recoveryManager: {
    logs: {
      restoredFromCheckpoint: "✅ Restored from checkpoint",
      failedToRestore: "⚠️ Failed to restore from checkpoint",
      recoveredTaskTree: "✅ Recovered task tree with {count} interrupted tasks",
      reexecutingTasks: "🔄 Re-executing {count} interrupted tasks",
      reexecutingTask: "🔄 Re-executing task: {id} ({summary})",
    },
  },
  
  // ========================================
  // Retry Manager Prompts
  // ========================================
  retryManager: {
    logs: {
      executingTask: "🔄 Executing task (attempt {attempt}/{maxRetries}): {id}",
      taskSucceeded: "✅ Task succeeded: {id}",
      taskFailed: "❌ Task failed (attempt {attempt}/{maxRetries}): {id}",
      errorNotRetryable: "⚠️ Error is not retryable: {message}",
      waitingBeforeRetry: "⏳ Waiting {delay}ms before retry...",
      allRetriesFailed: "❌ All retries failed for task: {id}",
      failureLogged: "📝 Failure logged: {path}",
    },
  },
  
  // ========================================
  // 🆕 V5: Large Text Map-Reduce Analysis Prompts
  // ========================================
  mapReduce: {
    mapTitle: (chunkIndex: number, totalChunks: number) =>
      `[Chunk Analysis — Part ${chunkIndex}/${totalChunks}]`,
    mapReadFileInstruction: "Please use the read tool to read file:",
    mapLineRangeInstruction: "Line range:",
    mapAnalysisGoalIntro: "After reading, analyze according to the following goal:",
    mapImportantTitle: "⚠️ Important:",
    mapMustReadFirst: "You must first use the read tool to read the specified line range of the file above",
    mapWriteToFile: "Write analysis results to a file (using the write tool)",
    mapFileNameFormat: "File name format:",
    mapResultContents: "Analysis results should include: key findings, summary, and specific content excerpts related to the analysis goal",
    mapDeepReadHint: `If there are important passages in this section that need more detailed analysis, mark "[needs deep read]" at the end of output with the line number range`,
    mapOverlapNote: (overlapLines: number) =>
      `Note: The first ${overlapLines} lines of this section overlap with the previous section, avoid duplicate analysis`,

    reduceTitle: (batchIndex: number, totalBatches: number) =>
      `[Integration Analysis — Batch ${batchIndex}/${totalBatches}]`,
    reduceReadIntro: "Please read the following chunk analysis results and integrate them:",
    reduceGoalIntro: "Integration goal (same as original task):",
    reduceRequirementsTitle: "⚠️ Requirements:",
    reduceReadFiles: "Use the read tool to read the analysis files above",
    reduceDedup: "Deduplicate, merge, and refine into an integration report",
    reduceSaveTo: "Save to",
    reduceKeepFindings: "Keep key findings and specific excerpts, remove duplicate content",

    finalizeTitle: "[Final Output]",
    finalizeReadIntroFromReduce: "Please read the following integration reports and generate the final deliverable:",
    finalizeReadIntroFromMap: "Please read the following chunk analysis results and generate the final deliverable:",
    finalizeGoalIntro: "Final output goal (same as original task):",
    finalizeRequirementsTitle: "⚠️ Requirements:",
    finalizeReadFiles: "Use the read tool to read the files above",
    finalizeSynthesize: "Synthesize all analysis results into a complete, structured final deliverable",
    finalizeWriteOutput: "Use the write tool to save the final output",
    finalizeSaveTo: "Save to",
    finalizeEnsureComplete: "Ensure the final output is complete, without omissions, and clearly structured",

    chunkFileTypeHint: "file",
    defaultFileTypeHint: ".txt file",
  },

  // ========================================
  // Quality Reviewer Prompts
  // ========================================
  qualityReviewer: {
    errors: {
      reviewFailed: "Quality review failed",
      subTaskNotFound: "Subtask does not exist",
      completionReviewFailed: "Subtask completion quality review failed",
      overallReviewFailed: "Overall completion quality review failed",
      failureAnalysisFailed: "Failure analysis failed",
      saveRecordFailed: "Failed to save quality review record",
    },
    report: {
      title: "# Quality Review Report",
      taskTreeId: "**Task Tree ID**",
      reviewType: "**Review Type**",
      reviewTime: "**Review Time**",
      reviewStatus: "**Review Status**",
      reviewDecision: "**Review Decision**",
      criteriaTitle: "## Evaluation Criteria",
      findingsTitle: "## Findings",
      suggestionsTitle: "## Suggestions",
      changesTitle: "## Applied Changes",
      changeTarget: "Target",
    },
  },
};
