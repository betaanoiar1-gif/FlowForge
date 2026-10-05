import type { CharacterRecord, Id, ProviderCapabilities } from "./index.js";

/**
 * Creative planning domain (Phase 4A).
 *
 * These contracts describe *what FlowForge intends to create*. They are deliberately
 * provider-neutral: nothing here creates a job, touches the queue, or names a provider
 * implementation. The only provider vocabulary is `ProviderCapabilityKey`, which reuses the
 * existing `ProviderCapabilities` model rather than inventing a parallel feature-flag system.
 */

/** Valid provider capability keys, derived from the existing provider contract. */
export const PROVIDER_CAPABILITY_KEYS = Object.freeze([
  "imageGeneration",
  "videoGeneration",
  "referenceImages",
  "startFrame",
  "endFrame",
  "batchGeneration",
] as const satisfies readonly (keyof ProviderCapabilities)[]);

export type ProviderCapabilityKey = (typeof PROVIDER_CAPABILITY_KEYS)[number];

export function isProviderCapabilityKey(value: unknown): value is ProviderCapabilityKey {
  return (
    typeof value === "string" &&
    (PROVIDER_CAPABILITY_KEYS as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ *
 * Creative brief
 * ------------------------------------------------------------------ */

export type BriefConstraintKind = "MUST" | "MUST_NOT" | "PREFERENCE";

export interface CreativeBriefConstraint {
  kind: BriefConstraintKind;
  value: string;
}

/** Brief snapshots are immutable; a revision creates a new version and supersedes the old one. */
export type CreativeBriefStatus = "ACTIVE" | "SUPERSEDED";

export interface CreativeBrief {
  id: Id;
  projectId: Id;
  versionNumber: number;
  title: string;
  /** What the piece is about, in the author's own words. */
  concept: string;
  /** What the piece must achieve. */
  objective: string;
  audience: string;
  tone: string;
  style: string;
  constraints: CreativeBriefConstraint[];
  status: CreativeBriefStatus;
  supersedesBriefId?: Id;
  contentHash: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Project definitions: worlds and visual DNA
 * ------------------------------------------------------------------ */

export type PlanningDefinitionStatus = "ACTIVE" | "SUPERSEDED";

export interface WorldDefinition {
  id: Id;
  projectId: Id;
  name: string;
  description: string;
  environment: string;
  /** In-world rules a generated shot must respect. */
  rules: string[];
  visualIdentity: WorldVisualIdentity;
  versionNumber: number;
  status: PlanningDefinitionStatus;
  supersedesWorldId?: Id;
  contentHash: string;
  createdAt: string;
}

export interface WorldVisualIdentity {
  description: string;
  palette: string[];
  lighting: string;
}

export interface VisualDnaDefinition {
  id: Id;
  projectId: Id;
  name: string;
  description: string;
  style: string;
  palette: string[];
  lighting: string;
  composition: string;
  cameraLanguage: string;
  renderingStyle: string;
  atmosphere: string;
  consistencyRules: string[];
  versionNumber: number;
  status: PlanningDefinitionStatus;
  supersedesDnaId?: Id;
  contentHash: string;
  createdAt: string;
}

/** Character identity additions; `role` on the plan-version cast overrides the canonical role. */
export interface CharacterTraits {
  role?: string;
  appearance: string;
  personality: string;
  voice?: string;
}

export interface CharacterVisualIdentity {
  description: string;
  distinguishingFeatures: string[];
  palette: string[];
}

export interface PlanningCharacterRecord extends CharacterRecord {
  traits?: CharacterTraits;
  visualIdentity?: CharacterVisualIdentity;
}

/* ------------------------------------------------------------------ *
 * Production plan aggregate
 * ------------------------------------------------------------------ */

export type PlanVersionStatus =
  | "DRAFT"
  | "VALIDATED"
  | "APPROVED"
  | "EXECUTABLE"
  | "ARCHIVED";

export const PLAN_VERSION_STATUSES = Object.freeze([
  "DRAFT",
  "VALIDATED",
  "APPROVED",
  "EXECUTABLE",
  "ARCHIVED",
] as const satisfies readonly PlanVersionStatus[]);

/**
 * Guarded plan-version lifecycle, following the Phase 3 transition philosophy: an approved or
 * archived version is never edited in place — revisions copy into a new version number.
 */
export const PLAN_VERSION_STATUS_TRANSITIONS: Readonly<
  Record<PlanVersionStatus, readonly PlanVersionStatus[]>
> = {
  DRAFT: ["VALIDATED", "ARCHIVED"],
  VALIDATED: ["APPROVED", "DRAFT", "ARCHIVED"],
  APPROVED: ["EXECUTABLE", "DRAFT", "ARCHIVED"],
  EXECUTABLE: ["DRAFT", "ARCHIVED"],
  ARCHIVED: [],
};

/** Statuses whose content is frozen; only `DRAFT` and `VALIDATED` accept edits. */
export const PLAN_EDITABLE_STATUSES = Object.freeze([
  "DRAFT",
  "VALIDATED",
] as const satisfies readonly PlanVersionStatus[]);

export function canEditPlanVersion(status: PlanVersionStatus): boolean {
  return (PLAN_EDITABLE_STATUSES as readonly string[]).includes(status);
}

export function canTransitionPlanVersionStatus(
  from: PlanVersionStatus,
  to: PlanVersionStatus,
): boolean {
  return PLAN_VERSION_STATUS_TRANSITIONS[from].includes(to);
}

export function assertPlanVersionStatusTransition(
  from: PlanVersionStatus,
  to: PlanVersionStatus,
  planVersionId?: Id,
): void {
  if (!canTransitionPlanVersionStatus(from, to)) {
    const suffix = planVersionId === undefined ? "" : ` (plan version ${planVersionId})`;
    throw new Error(`Invalid plan version status transition: ${from} -> ${to}${suffix}`);
  }
}

export interface ProductionPlan {
  id: Id;
  projectId: Id;
  title: string;
  /** The brief snapshot this plan was authored against; never follows newer brief versions. */
  briefId: Id;
  currentVersionId?: Id;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionPlanVersion {
  id: Id;
  planId: Id;
  versionNumber: number;
  status: PlanVersionStatus;
  /** Canonical hash of this version's story, cast, scene plans, and specs. */
  contentHash: string;
  /** Default aesthetic contract for scene plans that do not override it. */
  visualDnaId?: Id;
  predecessorVersionId?: Id;
  revisionNote?: string;
  approvedBy?: string;
  approvedAt?: string;
  /** Validation evidence the approval was granted against. */
  approvedValidationId?: Id;
  executableAt?: string;
  executableProviders?: string[];
  /**
   * Planning provenance (Phase 4B). Present only when the deterministic planner authored this
   * version, and recorded once: a later planner version must not silently reinterpret the plan, so
   * the full identity tuple (planner, rules, seed, fingerprints) stays attached to the content it
   * produced. A revised or hand-edited version has no provenance of its own.
   */
  plannerVersion?: string;
  plannerRulesVersion?: string;
  plannerSeed?: number;
  plannerInputFingerprint?: string;
  plannerOutputFingerprint?: string;
  /** The version's content hash as the planner left it: "unchanged since planning" is derivable. */
  plannerContentHash?: string;
  plannerTrace?: PlannerTraceStep[];
  createdAt: string;
  updatedAt: string;
}

/** Which rules ran, in order, and what they decided — persisted as plan provenance. */
export type PlannerTraceOutcome = "APPLIED" | "SKIPPED";

export interface PlannerTraceStep {
  rule: string;
  outcome: PlannerTraceOutcome;
  /** IDs or scene keys the rule touched, in the order it touched them. */
  subjects?: string[];
  detail?: string;
}

/** Everything a planner run is identified by, persisted with the version it authored. */
export interface PlanProvenance {
  plannerVersion: string;
  rulesVersion: string;
  seed: number;
  inputFingerprint: string;
  outputFingerprint: string;
  /** Content hash immediately after the run, so later edits are detectable. */
  contentHash: string;
  trace: PlannerTraceStep[];
}

export interface PlanStory {
  id: Id;
  planVersionId: Id;
  premise: string;
  structure: string;
  themes: string[];
  beginning: string;
  development: string;
  ending: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanCastLink {
  characterId: Id;
  role: string;
}

export type GenerationSpecKind = "image" | "video" | "audio" | "text";

export const GENERATION_SPEC_KINDS = Object.freeze([
  "image",
  "video",
  "audio",
  "text",
] as const satisfies readonly GenerationSpecKind[]);

export function isGenerationSpecKind(value: unknown): value is GenerationSpecKind {
  return (
    typeof value === "string" &&
    (GENERATION_SPEC_KINDS as readonly string[]).includes(value)
  );
}

export type PlanningReferenceKind =
  | "character"
  | "world"
  | "visualDna"
  | "scenePlan"
  | "assetVersion";

export interface PlanningReference {
  kind: PlanningReferenceKind;
  id: Id;
  note?: string;
}

export interface ScenePlanContinuity {
  statement: string;
  source?: string;
}

export interface PlannedOutput {
  kind: GenerationSpecKind;
  count: number;
  note?: string;
}

/** A planned narrative unit. Distinct from an executable `Scene`/`SceneVersion`. */
export interface ScenePlan {
  id: Id;
  planVersionId: Id;
  /** Stable logical identity preserved across plan versions. */
  sceneKey: string;
  sceneNumber: number;
  title: string;
  narrativePurpose: string;
  description: string;
  durationTargetMs?: number;
  worldId?: Id;
  visualDnaId?: Id;
  continuity: ScenePlanContinuity[];
  requiredReferences: PlanningReference[];
  plannedOutputs: PlannedOutput[];
  createdAt: string;
  updatedAt: string;
}

export interface ScenePlanCastLink {
  characterId: Id;
  role: string;
  position: number;
}

/** Provider-neutral execution intent for one scene plan. */
export interface GenerationSpec {
  id: Id;
  scenePlanId: Id;
  specNumber: number;
  kind: GenerationSpecKind;
  /** Authoritative instruction text; becomes the generation prompt only at execution mapping. */
  instructions: string;
  outputCount: number;
  aspectRatio?: string;
  durationMs?: number;
  references: PlanningReference[];
  constraints: string[];
  providerRequirements: GenerationSpecRequirements;
  createdAt: string;
}

export interface GenerationSpecRequirements {
  capabilities: ProviderCapabilityKey[];
  notes?: string;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export const PLANNING_VALIDATOR_VERSION = "planning-deterministic-v1";

/**
 * The deterministic planner engine's own version (Phase 4B). It is deliberately distinct from
 * `PLANNING_VALIDATOR_VERSION`: one identifies *who authored* a plan, the other identifies *who
 * checked* it. Persisted planner provenance is meaningless if a future engine silently reuses the
 * same identifier, so changing a rule that affects output means bumping the rules version, and
 * changing the engine's shape means bumping the planner version.
 */
export const DETERMINISTIC_PLANNER_VERSION = "deterministic-planner-v1";
/** Version of the rule set (order included) that `deterministic-planner-v1` runs. */
export const PLANNING_RULES_VERSION = "planning-rules-v1";

export type PlanningFindingSeverity = "ERROR" | "WARNING";

export type PlanningFindingCode =
  | "PROJECT_OWNERSHIP_MISSING"
  | "BRIEF_UNUSABLE"
  | "BRIEF_FIELD_MISSING"
  | "BRIEF_CONSTRAINT_INVALID"
  | "STORY_MISSING"
  | "STORY_FIELD_MISSING"
  | "SCENE_PLANS_EMPTY"
  | "SCENE_ORDER_CONFLICT"
  | "SCENE_KEY_DUPLICATE"
  | "SCENE_REQUIRED_FIELDS_MISSING"
  | "SCENE_DURATION_INVALID"
  | "CHARACTER_UNKNOWN_REFERENCE"
  | "CHARACTER_NOT_IN_CAST"
  | "CHARACTER_PROFILE_INCOMPLETE"
  | "WORLD_UNKNOWN_REFERENCE"
  | "WORLD_PROFILE_INCOMPLETE"
  | "VISUAL_DNA_MISSING"
  | "VISUAL_DNA_NOT_IN_PROJECT"
  | "VISUAL_DNA_INCOMPLETE"
  | "GENERATION_SPEC_WITHOUT_SCENE_PLAN"
  | "SCENE_WITHOUT_GENERATION_SPEC"
  | "GENERATION_SPEC_INVALID_VALUE"
  | "GENERATION_SPEC_UNKNOWN_CAPABILITY"
  | "GENERATION_SPEC_CAPABILITY_MISMATCH"
  | "CAPABILITY_UNAVAILABLE"
  | "DANGLING_PLANNING_REFERENCE"
  | "SCENE_CONTINUITY_EMPTY"
  | "PROVIDER_CAPABILITY_CHECK_SKIPPED";

export interface PlanningFindingSubject {
  kind:
    | "plan"
    | "planVersion"
    | "brief"
    | "story"
    | "scenePlan"
    | "generationSpec"
    | "world"
    | "visualDna"
    | "character";
  id: Id;
}

export interface PlanningFinding {
  code: PlanningFindingCode;
  severity: PlanningFindingSeverity;
  message: string;
  subject: PlanningFindingSubject;
}

export type PlanValidationStatus = "PASSED" | "FAILED";

export interface PlanValidationRecord {
  id: Id;
  planVersionId: Id;
  validatorVersion: string;
  status: PlanValidationStatus;
  /** Content hash the findings were produced for; compare with the version to detect staleness. */
  contentHash: string;
  findings: PlanningFinding[];
  errorCount: number;
  warningCount: number;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Version snapshot (the durable aggregate as one readable value)
 * ------------------------------------------------------------------ */

export interface ScenePlanNode {
  scenePlan: ScenePlan;
  cast: ScenePlanCastLink[];
  specs: GenerationSpec[];
}

export interface PlanVersionSnapshot {
  projectId: Id;
  plan: ProductionPlan;
  version: ProductionPlanVersion;
  brief: CreativeBrief | null;
  story: PlanStory | null;
  cast: PlanCastLink[];
  characters: PlanningCharacterRecord[];
  worlds: WorldDefinition[];
  visualDna: VisualDnaDefinition[];
  scenePlans: ScenePlanNode[];
  /** Every spec of the version, flat; lets the validator detect specs without a scene plan. */
  specs: GenerationSpec[];
}
