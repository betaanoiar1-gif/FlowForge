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
