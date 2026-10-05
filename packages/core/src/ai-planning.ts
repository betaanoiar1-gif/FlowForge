import type { BriefConstraintKind, CreativeBrief, GenerationSpecKind, ProviderCapabilityKey } from "./index.js";

/**
 * The AI planner adapter port (Phase 4C).
 *
 * This file defines *what an AI planner is to FlowForge* and nothing about any particular vendor. An
 * adapter turns a brief plus explicit planning context into a structured `PlanningProposal`; it is a
 * proposal mechanism, never a source of truth. Everything after it — normalization, identities,
 * durations, specs, capabilities, validation, lifecycle — is the Phase 4B deterministic planner and the
 * Phase 4A domain, and those keep their authority. The pipeline this port exists to serve:
 *
 *   CreativeBrief → AIPlanner.propose() → PlanningProposal → schema validation → PlannerInput
 *     → deterministic planner (4B) → validation (4A) → ProductionPlanVersion
 *
 * Consequences spelled out here because they are the whole point of the boundary:
 *
 * - A request carries only planning context: the brief's text, the project's character/world/DNA
 *   *names*, and the operator's constraints. No database handle, no queue, no provider registry object,
 *   no browser, no execution service, and no credential material.
 * - A response carries a proposal or a typed failure. Prose that is not a valid proposal is a failure,
 *   never a partial success, and an adapter must not invent required content the model omitted.
 * - Names, not ids: the proposal refers to characters, worlds, and visual DNA the way an operator
 *   speaks about them. Resolving a name to a row is the application layer's job, so a model can never
 *   reach a record the project does not have.
 */

/** Version of the proposal schema the domain accepts. A proposal must declare it and match it exactly. */
export const AI_PLANNING_SCHEMA_VERSION = "ai-planning-proposal-v1";

/** What an adapter is called in provenance when nothing better is configured. */
export const AI_PROVENANCE_UNAVAILABLE = "unavailable";

/**
 * Hard bounds of a proposal. They exist so a model answer cannot turn into an unbounded document inside a
 * planning run, and so provider-side structured-output settings and FlowForge's validator agree by
 * construction rather than by memory. A provider package renders these into its wire schema; the service
 * validator enforces them, and the validator is what decides — a provider that accepted a longer document
 * would still be refused here.
 */
export const AI_PROPOSAL_LIMITS = Object.freeze({
  /** Upper bound on scenes in one proposal. The planner's own development-scene default is far below it. */
  maxScenes: 24,
  /** Upper bound on characters a single scene may name. */
  maxCharactersPerScene: 12,
  /** Upper bound on a scene or story title, in characters. */
  maxTitle: 200,
  /** Upper bound on premise, intent, and other free text, in characters. */
  maxText: 4000,
  /** Upper bound on a scene's continuity note, which the planner keeps as an exact continuity statement. */
  maxNote: 600,
  /** Upper bound on a requested scene duration, in milliseconds. */
  maxDurationMs: 600_000,
});

/** How a run reached (or failed to reach) the deterministic planner. */
export type AiPlannerPath = "ai-adapter" | "deterministic-fallback";

/**
 * Typed failures an adapter may report. They are deliberately coarse and stable: an operator needs to
 * know *which boundary* refused (no credentials, no service, a timeout, a bad response), not the
 * vendor's internal error string, which is where secrets and request bodies tend to leak.
 */
export type AIPlannerErrorCode =
  /** The adapter is configured but has no credential to use. Nothing was sent. */
  | "AI_CREDENTIAL_MISSING"
  | "AI_UNAVAILABLE"
  | "AI_TIMEOUT"
  | "AI_HTTP_ERROR"
  | "AI_EMPTY_RESPONSE"
  | "AI_TRUNCATED"
  /** The response arrived but was not JSON, not an object, or not this schema. */
  | "AI_INVALID_JSON"
  | "AI_SCHEMA_MISMATCH"
  | "AI_REFUSAL"
  | "AI_FAILED";

export interface AIPlannerFailure {
  status: "FAILED";
  code: AIPlannerErrorCode;
  message: string;
  /** Safe to retry the same request? Retrying is still the caller's decision, never the adapter's. */
  retryable?: boolean;
  /** Field or response path the failure is about, when there is one. Never a request body. */
  field?: string;
}

/**
 * The structured proposal. Every field is optional except the schema version and the story/scene lists,
 * and every string is text the operator may later read: no instructions, no prompt scaffolding, and no
 * provider-specific payload survives here.
 */
export interface PlanningProposalScene {
  /** Stable slug for the scene; the deterministic planner derives a key from the title when absent. */
  key?: string;
  title: string;
  /** What this scene is for, in one or two sentences. Becomes the scene plan's narrative purpose. */
  intent: string;
  /** Narrative weight, used by the deterministic duration rule; never a duration in itself. */
  emphasis?: "establish" | "develop" | "resolve";
  /** Character *names*, in appearance order. Unknown names fail the run rather than being dropped. */
  characters?: string[];
  /** World name. An unknown world fails the run rather than planning a scene without a setting. */
  world?: string;
  /** Requested duration for this scene in whole milliseconds. Allocation remains the planner's rule. */
  durationMs?: number;
  /** Output kinds the scene is meant to produce; capability limits are still applied by the planner. */
  kinds?: GenerationSpecKind[];
  /** A continuity note describing what this scene inherits; wording is preserved, structure is the planner's. */
  continuity?: string;
  /** Extra scene-level rules the model was asked to carry from the brief. */
  constraints?: string[];
}

export interface PlanningProposal {
  /** Must equal `AI_PLANNING_SCHEMA_VERSION`; an adapter that cannot say which schema it wrote is unusable. */
  schemaVersion: string;
  title?: string;
  logline?: string;
  /**
   * The narrative. `premise`, `beginning`, `development`, and `ending` are required, because the
   * deterministic planner refuses an incomplete story rather than inventing the missing movement;
   * `structure` and `themes` are optional because the planner derives a structure when none is stated.
   */
  story: {
    premise: string;
    structure?: string;
    themes?: string[];
    beginning: string;
    development: string;
    ending: string;
  };
  /** Ordered. The order is the proposed scene order and is preserved exactly. */
  scenes: PlanningProposalScene[];
  /** Visual DNA *name*, singular in intent: the aesthetic contract the piece should carry. */
  visualDna?: string;
  /** Brief constraints the model judged relevant, echoed back so an operator can see what was used. */
  constraints?: Array<{ kind: BriefConstraintKind; value: string }>;
}

export interface AIPlanningSuccess {
  status: "OK";
  /**
   * The document as received, deliberately typed `unknown` rather than `PlanningProposal`: an adapter
   * reports what the model answered, and only the service's schema validator may decide whether that is a
   * proposal. Typing it as the schema here would let an unvalidated answer carry the type all the way to
   * the planner, which is exactly the mistake this boundary exists to prevent.
   */
  proposal: unknown;
  /** Sanitized response metadata only: which model answered, and why it stopped. No headers, no bodies. */
  meta?: { model?: string; finishReason?: string; truncated?: boolean };
}

export type AIPlanningResponse = AIPlanningSuccess | AIPlannerFailure;

/**
 * What the adapter is allowed to know. Kept as data on purpose: an adapter that wanted a repository,
 * a queue, or a provider registry would be asking to plan outside the boundary that makes it optional.
 */
export interface AIPlanningRequest {
  schemaVersion: typeof AI_PLANNING_SCHEMA_VERSION;
  /** The brief snapshot being served, already read and pinned by the application layer. */
  brief: Pick<
    CreativeBrief,
    "title" | "concept" | "objective" | "audience" | "tone" | "style" | "constraints"
  >;
  /** The project's available identities, by name only, in the order the operator listed them. */
  characters: Array<{ name: string; role?: string; appearance?: string }>;
  worlds: Array<{ name: string; environment?: string }>;
  visualDna: Array<{ name: string; style?: string }>;
  /** The kinds the configured providers could actually serve, so a proposal is not born unsatisfiable. */
  availableKinds: GenerationSpecKind[];
  availableCapabilities: ProviderCapabilityKey[];
  /** Operator guidance for this attempt. Bounds, not instructions to a person. */
  guidance?: {
    sceneCount?: number;
    totalDurationMs?: number;
    aspectRatio?: string;
    /** Free text the operator typed for this attempt, e.g. "three short shots, no dialogue". */
    notes?: string;
    themes?: string[];
  };
}

/** The adapter port. Implementations live outside the domain (the shipped one is `providers/openai-chat`). */
export interface AIPlanner {
  /** Identity recorded in provenance: which adapter produced this proposal. */
  readonly id: string;
  /** Adapter implementation version, bumped when its prompting or parsing semantics change. */
  readonly adapterVersion: string;
  /** Vendor family, e.g. `"openai-compatible"`. Never a credential, endpoint, or account name. */
  readonly provider: string;
  /** Model name as configured. Recorded for auditability; an adapter may not invent one. */
  readonly model: string;
  /** The schema the adapter promises to return. Checked again by the caller: trust, then verify. */
  readonly schemaVersion: string;
  propose(request: AIPlanningRequest): Promise<AIPlanningResponse>;
}

/** Provenance of one AI planning attempt, persisted with the version it authored. */
export interface PlanAiProvenance {
  adapter: string;
  adapterVersion: string;
  provider: string;
  model: string;
  schemaVersion: string;
  /** How the run got to the deterministic planner: the proposal, or an explicit fallback request. */
  path: AiPlannerPath;
  /** Digest of the request the adapter was given (context only; no prompt text, no credentials). */
  requestFingerprint: string;
  /** Digest of the validated proposal, so an equivalent proposal can be recognised later. */
  proposalFingerprint: string;
  /** Digest of the raw response body, so a plan can be re-audited without pretending the model is deterministic. */
  responseFingerprint: string | null;
  /** True when the AI produced nothing and the operator had explicitly asked for the deterministic route. */
  fallback: boolean;
}

/**
 * The stages an AI-planned run records around the deterministic planner's own rule steps. They travel in
 * the version's single `PlannerTraceStep[]` — one trace per version, in execution order — because a second
 * trace table would be a second history to disagree with the first.
 */
export const AI_PLANNING_TRACE_STAGES = Object.freeze([
  "AI_REQUEST",
  "AI_RESPONSE",
  "AI_SCHEMA_VALIDATION",
  "NORMALIZATION",
  "DETERMINISTIC_PLANNING",
  "DOMAIN_VALIDATION",
] as const);
