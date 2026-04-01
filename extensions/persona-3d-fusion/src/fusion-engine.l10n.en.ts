import type { FusionEngineL10n } from "./fusion-engine.l10n.types.js";

/**
 * 3D Persona Fusion System — English Prompt Templates
 *
 * @module persona-3d-fusion/fusion-engine.l10n.en
 */
export const FUSION_ENGINE_EN: FusionEngineL10n = {
  // ── SOUL Dimension Templates ──
  soulIdentityTitle: "# Identity: {name}",
  soulIdentityIntro: "You are {addressSelf}——{addressUser}'s {roleType}.",
  soulTraitsLabel: "- Core Personality: {traits}",
  soulStyleLabel: "- Speaking Style: ",
  soulValuesLabel: "- Core Values: ",

  // ── CONTEXT Dimension Templates ──
  contextModeTitle: "# Current Work Mode: {name}",
  contextRolePerspective: "{addressSelf} is currently {description}.",
  contextBehaviorLabel: "Behavior Guidelines: ",

  // ── PHASE Dimension Templates ──
  phaseStageTitle: "# Current Stage: {name}",
  phaseEmotionalTone: "{addressSelf} {emotionalTone}",
  phaseActionIntro: "",
  phaseSuccessLabel: "Success Criteria: ",

  // ── Fusion Prompts ──
  fusionSeparator: "---",
  fusionInstruction: "Please respond based on the above identity, work mode, and stage settings.",
};