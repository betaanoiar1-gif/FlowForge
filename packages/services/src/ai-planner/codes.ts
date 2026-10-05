/**
 * Failure codes the AI planning path reports when the *proposal* is the problem. They are separate from
 * `AIPlannerErrorCode` (core), which describes why an adapter could not answer at all, and from the
 * validator's `PLAN_*` findings, which describe why a plan is unusable. Three questions, three vocabularies:
 * "did the model answer?", "was the answer a valid proposal for this project?", "is the resulting plan
 * structurally sound?"
 *
 * Every one of them fails closed: none has a "best effort" path, and none may be downgraded into a plan.
 */
export const AI_PLANNING_ERROR_CODES = Object.freeze({
  /** The response is not a document this schema can interpret. */
  AI_PROPOSAL_INVALID: "AI_PROPOSAL_INVALID",
  /** The response was well formed but proposed nothing. */
  AI_PROPOSAL_EMPTY: "AI_PROPOSAL_EMPTY",
  /** A scene named a character this project does not have. */
  AI_PROPOSAL_UNKNOWN_CHARACTER: "AI_PROPOSAL_UNKNOWN_CHARACTER",
  /** A scene named a world this project does not have. */
  AI_PROPOSAL_UNKNOWN_WORLD: "AI_PROPOSAL_UNKNOWN_WORLD",
  /** The proposal named a visual DNA definition this project does not have. */
  AI_PROPOSAL_UNKNOWN_VISUAL_DNA: "AI_PROPOSAL_UNKNOWN_VISUAL_DNA",
  /** The proposal tried to add a creative rule the brief never stated. */
  AI_PROPOSAL_CONSTRAINT_UNKNOWN: "AI_PROPOSAL_CONSTRAINT_UNKNOWN",
  /** The AI produced nothing and the caller had not asked for the deterministic fallback. */
  AI_FALLBACK_NOT_REQUESTED: "AI_FALLBACK_NOT_REQUESTED",
} as const);

export type AiPlanningErrorCode = (typeof AI_PLANNING_ERROR_CODES)[keyof typeof AI_PLANNING_ERROR_CODES];

export const AI_PLANNING_NOTICE_CODES = Object.freeze({
  /** A proposal was accepted and turned into planner input. */
  PROPOSAL_ACCEPTED: "AI_PROPOSAL_ACCEPTED",
  /** An explicit fallback to the deterministic planner was used. */
  FALLBACK_USED: "AI_FALLBACK_USED",
  /** The version already held this content, so the AI attempt wrote nothing. */
  VERSION_REUSED: "AI_VERSION_REUSED",
  /** The version already carries provenance, so this attempt's AI record could not be attached. */
  PROVENANCE_NOT_RECORDED: "AI_PROVENANCE_NOT_RECORDED",
} as const);
