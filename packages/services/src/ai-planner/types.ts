import type {
  AIPlannerErrorCode,
  AIPlanningRequest,
  GenerationSpecKind,
  PlanAiProvenance,
  PlannerTraceStep,
  PlanningFinding,
  ProductionPlan,
  ProductionPlanVersion,
  ProviderCapabilityKey,
} from "@flowforge/core";
import type { PlanValidationView } from "../planning-read-models.js";
import type { PlannerNotice } from "../planner/types.js";
import type { PlannerCastInput, PlannerOptionsInput, PlannerStoryInput, PlannerWorldInput } from "../planner/types.js";
import type { AiPlanningIssue } from "./schema.js";

/**
 * Contracts of the AI planning orchestration (Phase 4C).
 *
 * `AiPlannerService` is the only place an AI answer reaches FlowForge, and it owns exactly two steps:
 * build the request from reviewed reads, and translate a schema-valid proposal into the deterministic
 * planner's input. Everything after that is Phase 4B authoring and Phase 4A validation, unchanged —
 * including reuse, content hashing, lifecycle, and the executability gate.
 */

/** Operator guidance for one attempt: bounds and notes. Never instructions to a person, never a secret. */
export type AiPlanningGuidance = NonNullable<AIPlanningRequest["guidance"]>;

/** A notice from the AI stages. It shares the planner notice's shape but not its code vocabulary: an
 * adapter's problems are not rule violations, and keeping them in one union would force either side to
 * borrow the other's names. */
export interface AiPlanningNotice {
  code: string;
  severity: PlannerNotice["severity"];
  /** Which stage spoke, named by the stage rather than by a planner rule. */
  stage?: string;
  message: string;
  field?: string;
}

export type AiPlanNotice = PlannerNotice | AiPlanningNotice;

/** What the operator asked for, in one command. */
export interface AiPlanProductionCommand {
  projectId: string;
  /** Absent means the project's current active brief, as in the deterministic planner's command. */
  briefId?: string;
  /**
   * The plan to author into. Always the operator's words, never the model's: plan identity is
   * (project, brief, title), so a title taken from the proposal would fork a *plan* on wording alone.
   */
  planTitle?: string;
  /** Bounds and notes handed to the adapter. Not instructions to a person, and not a place for secrets. */
  guidance?: AIPlanningRequest["guidance"];
  /** Options the deterministic planner runs with. They win over anything the proposal implies. */
  options?: PlannerOptionsInput;
  /** Overrides the proposal's visual DNA choice with a project definition id. */
  visualDnaId?: string;
  /** Provider ids whose declarations the model is told about and the planner is adapted to. */
  providers?: readonly string[];
  /**
   * The operator's own planner input, used *only* by `fallback: "deterministic"`. A proposal never sees
   * it and cannot be merged with it: either the proposal is accepted and planned, or the fallback plans
   * what you wrote.
   */
  story?: PlannerStoryInput;
  cast?: PlannerCastInput[];
  worlds?: PlannerWorldInput[];
  /** Report the whole attempt — including the real model call — without writing a byte. */
  dryRun?: boolean;
  /** Validate, approve, and (with `providers`) mark executable in one call, like `planner run`. */
  approve?: boolean;
  reviewer?: string;
  /**
   * What to do when the adapter produces nothing usable. `"none"` (the default) fails the run;
   * `"deterministic"` plans the operator's own input through the Phase 4B planner. There is no automatic
   * choice: an inconvenient answer is never a reason to change routes on the operator's behalf.
   */
  fallback?: "none" | "deterministic";
  now?: string;
}

/** How the run reached — and left — the deterministic planner. */
export type AiPlanOutcome =
  /** The version is structurally sound. */
  | "SUCCESS"
  /** A version exists but 4A refused it. */
  | "VALIDATION_FAILURE"
  /** The proposal was accepted, and the deterministic rules refused to produce a plan from it. */
  | "PLANNING_FAILURE"
  /** The proposal never became planner input: the adapter failed or the answer was not a valid proposal. */
  | "AI_FAILURE";

export interface AiPlanningSummary {
  adapter: string;
  adapterVersion: string;
  provider: string;
  model: string;
  schemaVersion: string;
  path: PlanAiProvenance["path"];
  fallback: boolean;
  requestFingerprint: string;
  proposalFingerprint: string | null;
  responseFingerprint: string | null;
  /** False when nothing was written (a failed or dry run) or when a reused version kept its own record. */
  provenanceRecorded: boolean;
  /** Why `provenanceRecorded` is false, whenever there is a reason to explain. */
  provenanceReason?: string;
  /** Schema-level problems, in path order. Present whenever the proposal was rejected. */
  issues: readonly AiPlanningIssue[];
}

export interface AiPlanProductionResult {
  outcome: AiPlanOutcome;
  ai: AiPlanningSummary;
  /** The plan this attempt authored into, or the one it would have written to. */
  plan: ProductionPlan | null;
  version: ProductionPlanVersion | null;
  created: boolean;
  reused: boolean;
  validation: PlanValidationView | null;
  /** The AI-stage notices first, then the planner's own. */
  notices: readonly AiPlanNotice[];
  findings: readonly PlanningFinding[];
  /** The persisted trace: the AI stages, then the rule steps, then the stored validation outcome. */
  trace: readonly PlannerTraceStep[];
  rulesApplied: readonly string[];
  errors: readonly { code: AIPlannerErrorCode | string; message: string; field?: string }[];
  scenePlans: number;
  specs: number;
  planner: {
    plannerVersion: string;
    rulesVersion: string;
    seed: number;
    inputFingerprint: string;
    outputFingerprint: string | null;
    providerCandidates: number;
    rules: readonly string[];
  } | null;
  availableKinds: readonly GenerationSpecKind[];
  availableCapabilities: readonly ProviderCapabilityKey[];
  nextAction: string;
}
