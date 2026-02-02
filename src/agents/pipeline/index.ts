/**
 * 动态管道模块
 *
 * 导出所有管道相关的类型、类和函数
 *
 * @module agents/pipeline
 */

// 类型
export type {
  Capability,
  CapabilityCall,
  CapabilityDescription,
  CapabilityExecuteParams,
  CharacterRecognitionConfig,
  DetectedCharacter,
  ExecutionPlan,
  PipelineContext,
  PipelineState,
  PostProcessResult,
  PreProcessResult,
} from "./types.js";

// 能力池
export { CapabilityPool, createDefaultCapabilityPool } from "./capability-pool.js";
export type { CreateCapabilityPoolConfig } from "./capability-pool.js";

// 意图分析器
export { IntentAnalyzer, createIntentAnalyzer } from "./intent-analyzer.js";
export type { AnalyzeParams, AnalyzeResult, IntentAnalyzerConfig } from "./intent-analyzer.js";

// 插件
export {
  clearAllPipelineStates,
  getPipelineState,
  onAgentEnd,
  onBeforeAgentStart,
  pipelinePlugin,
} from "./plugin.js";

// 注册
export { registerPipelinePlugin } from "./register.js";

// 角色服务
export {
  CharacterService,
  createCharacterService,
  getCharacterService,
} from "./characters/character-service.js";
export type {
  CharacterKnowledge,
  CharacterMemories,
  CharacterProfile,
  FullCharacterConfig,
  LoadedCharacter,
} from "./characters/character-service.js";

