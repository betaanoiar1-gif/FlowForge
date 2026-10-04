import type { SceneStatus } from "@flowforge/core";

/**
 * Command inputs for the application layer. They are intentionally narrow: an operator names
 * existing durable entities and supplies the intent; prompt text lives only on scene versions,
 * and provider behaviour is never parameterised here beyond the capability-relevant fields.
 */

export interface CommandOptions {
  /** Explicit clock for deterministic tests; defaults to the application clock. */
  now?: string;
}

export interface CreateProjectCommand extends CommandOptions {
  projectId?: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectIdCommand extends CommandOptions {
  projectId: string;
}

export interface CreateSceneCommand extends CommandOptions {
  projectId: string;
  sceneId?: string;
  title: string;
  sceneNumber?: number;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SceneIdCommand extends CommandOptions {
  sceneId: string;
}

export interface AddSceneVersionCommand extends SceneIdCommand {
  prompt: string;
  references?: string[];
  metadata?: Record<string, unknown>;
  parentVersionId?: string;
  sceneVersionId?: string;
}

export interface SetCurrentSceneVersionCommand extends SceneIdCommand {
  sceneVersionId: string;
}

/** `READY` is not accepted here: it requires the production-readiness gate. */
export type ReopenableSceneStatus = Exclude<SceneStatus, "READY">;

export interface SetSceneStatusCommand extends SceneIdCommand {
  status: ReopenableSceneStatus;
}

export interface RequestGenerationCommand extends CommandOptions {
  projectId: string;
  sceneId: string;
  /** Defaults to the scene's current version, which must exist. */
  sceneVersionId?: string;
  provider: string;
  /** Capability-relevant fields only: `mode`, `outputCount`, plus provider-safe extras. */
  parameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  maxAttempts?: number;
  priority?: number;
  /** Permits enqueueing work whose provider is not registered in this process. */
  allowUnconfiguredProvider?: boolean;
}

export interface JobIdCommand extends CommandOptions {
  jobId: string;
}

export interface CancelGenerationCommand extends JobIdCommand {
  /**
   * Skip provider-side cancellation and only flip the durable local state. Useful when an
   * operator wants the local queue cleared without contacting the provider at all.
   */
  localOnly?: boolean;
}

export interface RetryGenerationCommand extends JobIdCommand {
  /** Backoff instant for the requeued item; defaults to now. */
  availableAt?: string;
}

export interface RunWorkerCommand extends CommandOptions {
  maxJobs?: number;
  /** Overrides the provider-coverage guard for an intentional, reviewed run. */
  ignoreProviderCoverage?: boolean;
}

export interface DecideReviewCommand extends CommandOptions {
  assetVersionId: string;
  decision: "APPROVED" | "REJECTED";
  reason?: string;
  comment?: string;
  reviewer?: string;
}

export interface SelectAssetVersionCommand extends SceneIdCommand {
  assetVersionId: string;
}

/* -------------------------------------------------------------------------- *
 * Planning commands (Phase 4A). Same conventions as the Phase 3 commands: plain
 * JSON-safe input, explicit IDs, optional `now` for deterministic tests.
 * -------------------------------------------------------------------------- */

/** Address of a plan version: the current one by default, a specific number on request. */
export interface PlanVersionTarget {
  planId: string;
  versionNumber?: number;
}

export interface CreateBriefCommand {
  briefId?: string;
  projectId: string;
  title: string;
  concept?: string;
  objective?: string;
  audience?: string;
  tone?: string;
  style?: string;
  constraints?: readonly { kind: "MUST" | "MUST_NOT" | "PREFERENCE"; value: string }[];
  now?: string;
}

export interface CreateWorldCommand {
  worldId?: string;
  projectId: string;
  name: string;
  description?: string;
  environment?: string;
  rules?: readonly string[];
  visualIdentity?: { description?: string; palette?: readonly string[]; lighting?: string };
  now?: string;
}

export interface CreateVisualDnaCommand {
  visualDnaId?: string;
  projectId: string;
  name: string;
  description?: string;
  style: string;
  palette?: readonly string[];
  lighting?: string;
  composition?: string;
  cameraLanguage?: string;
  renderingStyle?: string;
  atmosphere?: string;
  consistencyRules?: readonly string[];
  now?: string;
}

export interface CreatePlanningCharacterCommand {
  characterId?: string;
  projectId: string;
  name: string;
  description?: string;
  traits?: { role?: string; appearance: string; personality: string; voice?: string };
  visualIdentity?: {
    description: string;
    distinguishingFeatures?: readonly string[];
    palette?: readonly string[];
  };
  now?: string;
}

export interface CreatePlanCommand {
  planId?: string;
  projectId: string;
  briefId: string;
  title: string;
  visualDnaId?: string;
  now?: string;
}

export interface SetPlanStoryCommand extends PlanVersionTarget {
  premise: string;
  structure?: string;
  themes?: readonly string[];
  beginning?: string;
  development?: string;
  ending?: string;
  now?: string;
}

export interface SetPlanCastCommand extends PlanVersionTarget {
  cast: readonly { characterId: string; role?: string }[];
  now?: string;
}

export interface AddScenePlanCommand extends PlanVersionTarget {
  sceneKey: string;
  sceneNumber?: number;
  title: string;
  narrativePurpose?: string;
  description?: string;
  durationTargetMs?: number;
  worldId?: string;
  visualDnaId?: string;
  continuity?: readonly { statement: string; source?: string }[];
  requiredReferences?: readonly { kind: string; id: string; note?: string }[];
  plannedOutputs?: readonly { kind: string; count: number; note?: string }[];
  cast?: readonly { characterId: string; role?: string; position?: number }[];
  now?: string;
}

export interface SetScenePlanCastCommand {
  scenePlanId: string;
  cast: readonly { characterId: string; role?: string; position?: number }[];
  now?: string;
}

export interface AddGenerationSpecCommand {
  scenePlanId: string;
  /** Validated against `GENERATION_SPEC_KINDS` by the service, not by the caller. */
  kind: string;
  instructions: string;
  outputCount?: number;
  aspectRatio?: string;
  durationMs?: number;
  references?: readonly { kind: string; id: string; note?: string }[];
  constraints?: readonly string[];
  requiredCapabilities?: readonly string[];
  requirementNotes?: string;
  now?: string;
}

export interface PlanLifecycleCommand extends PlanVersionTarget {
  reviewer?: string;
  providers?: readonly string[];
  note?: string;
  now?: string;
}
