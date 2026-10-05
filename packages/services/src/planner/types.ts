import type {
  BriefConstraintKind,
  CreativeBrief,
  PlanningCharacterRecord,
  GenerationSpecKind,
  PlanningFinding,
  PlanningReferenceKind,
  PlannerTraceStep,
  ProviderCapabilities,
  ProviderCapabilityKey,
  ScenePlanContinuity,
  VisualDnaDefinition,
  WorldDefinition,
} from "@flowforge/core";

/**
 * Contracts of the deterministic planner engine (Phase 4B).
 *
 * The planner is a pure function over an explicit input: it reads no database, no clock beyond the
 * timestamp it is handed, no provider instance, and no random source. Everything it decides is a
 * named rule, so an identical normalized input always produces an identical plan — same scene order,
 * same ids, same instructions, same durations, same capability requirements.
 */

/** Namespaces are part of every digest, so a fingerprint can never be mistaken for another key type. */
export const PLANNER_ID_NAMESPACE = "flowforge:planner-id:v1";
export const PLANNER_INPUT_FINGERPRINT_NAMESPACE = "flowforge:planner-input:v1";

/** Namespace for the identity of the *plan* a run targets: project + brief + title, nothing else. */
export const PLANNER_PLAN_IDENTITY_NAMESPACE = "flowforge:planner-plan-identity:v1";
export const PLANNER_OUTPUT_FINGERPRINT_NAMESPACE = "flowforge:planner-output:v1";

export type PlannerOutcome = "SUCCESS" | "VALIDATION_FAILURE" | "PLANNING_FAILURE";

/** What to do when a plan for this input already exists. */
export type PlannerReplanPolicy = "new-version" | "in-place" | "fail";

export type StoryBeatEmphasis = "establish" | "develop" | "resolve";

/** How much narrative weight a beat carries when the duration budget is divided. */
export const BEAT_EMPHASIS_WEIGHT: Readonly<Record<StoryBeatEmphasis, number>> = Object.freeze({
  establish: 3,
  develop: 2,
  resolve: 2,
});

export const PLANNER_DEFAULTS = Object.freeze({
  /** A scene is planned for each beat; the derived beat count when a story has no explicit beats. */
  developmentScenes: 2,
  sceneDurationMs: 5_000,
  minSceneDurationMs: 1_000,
  maxTotalDurationMs: 3_600_000,
  aspectRatio: "16:9",
  outputCountPerSpec: 1,
  defaultOutputKinds: ["image"] as const,
  seed: 0,
  replan: "new-version" as PlannerReplanPolicy,
});

export interface PlannerNotice {
  /** Planner-specific code (`PLANNER_*`). Validator findings keep their own code space. */
  code: string;
  severity: "ERROR" | "WARNING" | "INFO";
  message: string;
  rule: string;
  field?: string;
}

export interface StoryBeatInput {
  /** Stable identity for the beat; defaults to a slug of its title or purpose. */
  key?: string;
  title?: string;
  purpose?: string;
  /** Character IDs that must appear in this beat; omit to inherit the cast rotation. */
  characters?: readonly string[];
  worldId?: string;
  /** Explicit duration; otherwise the allocation rule divides the total budget. */
  durationMs?: number;
  emphasis?: StoryBeatEmphasis;
  /** Spec kinds for this beat; defaults to `options.defaultOutputKinds`. */
  outputKinds?: readonly GenerationSpecKind[];
  /**
   * A continuity intent for this beat, in the caller's own words (Phase 4C: an AI proposal states what a
   * scene inherits; an operator may too). It is *content*: it changes both fingerprints and therefore
   * forks a version rather than reusing one. What a continuity record looks like — its fields, its
   * position, its relation to the previous scene — stays the `continuity-linking` rule's decision.
   */
  continuityNote?: string;
}

export interface PlannerStoryInput {
  premise?: string;
  structure?: string;
  themes?: readonly string[];
  beginning?: string;
  development?: string;
  ending?: string;
  /** Explicit beats win over derived ones. Order is meaningful and is preserved exactly. */
  beats?: readonly StoryBeatInput[];
}

export interface PlannerCastInput {
  characterId: string;
  role?: string;
  /** Beat keys this character must appear in. Omit to follow the cast rotation. */
  scenes?: readonly string[];
}

export interface PlannerWorldInput {
  worldId: string;
  /** Beat keys this world belongs to. Omit for a single-world plan, where every beat uses it. */
  scenes?: readonly string[];
}

export interface PlannerProviderCandidate {
  id: string;
  /** Declarations only. The engine never constructs or contacts a provider. */
  capabilities: ProviderCapabilities;
}

export interface PlannerProjectDefinitionInput {
  /**
   * The project's characters, worlds, and visual DNA. The caller (a service) reads these from
   * persistence; the engine treats them as given and never queries. They are used twice: the
   * normalized projection of the fields a rule can read drives planning and fingerprints, and the
   * records themselves are handed to the Phase 4A validator for the draft self-check, so profile
   * completeness is judged by exactly the rules that will judge the stored plan.
   */
  characters: readonly PlanningCharacterRecord[];
  worlds: readonly WorldDefinition[];
  visualDna: readonly VisualDnaDefinition[];
}

export interface PlannerOptionsInput {
  planTitle?: string;
  /** Total duration budget for the plan; defaults to one default scene length per beat. */
  totalDurationMs?: number;
  minSceneDurationMs?: number;
  /** Number of derived develop beats when the story provides no explicit beats. */
  developmentScenes?: number;
  aspectRatio?: string;
  outputCountPerSpec?: number;
  defaultOutputKinds?: readonly GenerationSpecKind[];
  /**
   * Deterministic variation knob. It participates in every fingerprint and shifts the cast rotation
   * across develop beats; nothing else in the engine uses it. A re-plan with a new seed is therefore a
   * new plan rather than a collision with the old one.
   */
  seed?: number;
  replan?: PlannerReplanPolicy;
  /** Record provenance and the trace even for a dry run (defaults true). */
  includeTrace?: boolean;
}

/** The complete, explicit input to one planning run. */
export interface PlannerInput {
  projectId: string;
  /** The brief snapshot to author against. It must be `ACTIVE`; the planner never creates or edits one. */
  brief: CreativeBrief;
  story?: PlannerStoryInput;
  cast?: readonly PlannerCastInput[];
  worlds?: readonly PlannerWorldInput[];
  visualDnaId?: string;
  definitions: PlannerProjectDefinitionInput;
  providerCandidates?: readonly PlannerProviderCandidate[];
  options?: PlannerOptionsInput;
  /** Timestamp recorded on the drafted rows; excluded from fingerprints (it is not plan content). */
  asOf?: string;
}

/**
 * A spec as the planner decided it. These shapes are mutable while a run is in progress (rules fill
 * them in, in order) and are handed out read-only in the result, so a caller cannot rewrite a plan
 * after the fact and call it the planner's output.
 */
export interface PlannedSpec {
  id: string;
  specNumber: number;
  kind: GenerationSpecKind;
  instructions: string;
  outputCount: number;
  aspectRatio?: string;
  durationMs?: number;
  references: { kind: PlanningReferenceKind; id: string; note?: string }[];
  constraints: string[];
  requiredCapabilities: ProviderCapabilityKey[];
  requirementNotes: string;
}

export interface PlannedScenePlan {
  id: string;
  sceneKey: string;
  sceneNumber: number;
  title: string;
  narrativePurpose: string;
  description: string;
  durationTargetMs: number;
  /** Structural weight the beat carried into `duration-allocation`. */
  emphasis: StoryBeatEmphasis;
  /** An operator-stated beat duration is honoured exactly; the field records that it was one. */
  fixedDurationMs?: number;
  /** True when the share computed by `duration-allocation` was below `minSceneDurationMs`. */
  durationWasFloored?: boolean;
  worldId?: string;
  visualDnaId?: string;
  continuity: ScenePlanContinuity[];
  requiredReferences: { kind: PlanningReferenceKind; id: string; note?: string }[];
  plannedOutputs: { kind: GenerationSpecKind; count: number; note?: string }[];
  cast: { characterId: string; role: string; position: number }[];
  specs: PlannedSpec[];
  /** The beat this scene came from, for traceability in the trace and in tests. */
  beatKey: string;
  /** The output kinds that beat asked for, carried forward so later rules need no beat lookup. */
  outputKinds: readonly GenerationSpecKind[];
  /** The kinds actually planned, after capability adaptation; differs from `outputKinds` only when refused. */
  plannedKinds?: readonly GenerationSpecKind[];
  /**
   * Caller-stated continuity intent from the beat (Phase 4C: an AI proposal's words, or an operator's).
   * `continuity-linking` turns it into a `ScenePlanContinuity` entry; the note itself is not a row field,
   * so it exists only inside the plan the rules are building.
   */
  continuityNote?: string;
}

/** Everything a planning run decided, before anything is persisted. */
export interface PlannerDraft {
  /** The project the plan belongs to; taken verbatim from the planner input. */
  projectId: string;
  /**
   * Deterministic plan identity: derived from (project, brief, title) only, so a re-plan of the same
   * piece — even with a different seed — lands on the same plan, while the fingerprints say whether
   * its content changed.
   */
  planId: string;
  title: string;
  briefId: string;
  visualDnaId?: string;
  story: {
    premise: string;
    structure: string;
    themes: readonly string[];
    beginning: string;
    development: string;
    ending: string;
  };
  cast: readonly { characterId: string; role: string }[];
  scenePlans: readonly PlannedScenePlan[];
}

/** The plan-level cast the version declares, in order. */
export interface PlannedCastEntry {
  characterId: string;
  role: string;
}

export interface PlannerRun {
  outcome: PlannerOutcome;
  plannerVersion: string;
  rulesVersion: string;
  inputFingerprint: string;
  /** Null when the run never produced a draft: there is no plan content to fingerprint. */
  outputFingerprint: string | null;
  seed: number;
  draft?: PlannerDraft;
  notices: readonly PlannerNotice[];
  /** Findings from running the Phase 4A validator over the draft. Never empty on VALIDATION_FAILURE. */
  findings: readonly PlanningFinding[];
  trace: readonly PlannerTraceStep[];
  rulesApplied: readonly string[];
  errors: readonly { code: string; message: string; field?: string }[];
}

/** Constraint text is carried into spec constraints verbatim; only whitespace is normalized. */
export interface NormalizedBriefConstraint {
  kind: BriefConstraintKind;
  value: string;
}
