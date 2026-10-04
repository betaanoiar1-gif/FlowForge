import type { GenerationProvider } from "@flowforge/core";
import type { LocalQueueWorker, SqliteJobQueue } from "@flowforge/queue";
import type { SqliteJobRepository } from "@flowforge/storage";

/**
 * The exact persistence surface the application layer is allowed to use. Keeping this as a
 * structural `Pick` of `SqliteJobRepository` means the services cannot reach a write method
 * that has not been reviewed, and a test can supply a partial fake without a database.
 *
 * Every write here is still executed by the repository inside its own `BEGIN IMMEDIATE`
 * transaction; the services never hold SQL, statements, or file handles.
 */
export type JobRepository = Pick<
  SqliteJobRepository,
  // Projects and scenes
  | "createProject"
  | "getProject"
  | "listProjects"
  | "updateProjectStatus"
  | "createScene"
  | "getScene"
  | "listProjectScenes"
  | "createSceneVersion"
  | "getSceneVersion"
  | "getCurrentSceneVersion"
  | "listSceneVersions"
  | "setCurrentSceneVersion"
  | "updateSceneStatus"
  // Generation requests, jobs, attempts, queue
  | "createGenerationJobWithCreated"
  | "getGenerationJob"
  | "listGenerationJobs"
  | "countGenerationJobs"
  | "getActiveAttempt"
  | "listGenerationAttempts"
  | "cancelGenerationJob"
  | "retryFailedJob"
  | "getQueueItemByJob"
  | "listQueueItems"
  // Assets, QC, review, selection
  | "getAsset"
  | "listProjectAssets"
  | "getAssetVersion"
  | "getAssetVersionByAttempt"
  | "listAssetVersionsForSceneVersion"
  | "getQCResult"
  | "getReviewByAssetVersion"
  | "decideReview"
  | "selectApprovedAssetVersion"
  | "getSelectedAssetVersion"
>;

/** Read and recovery view of the durable queue. Claiming stays inside the worker. */
export type QueuePort = Pick<SqliteJobQueue, "size" | "has" | "get" | "recoverExpiredLeases">;

/**
 * Execution surface of the durable local worker. The services only *drive* it; claiming,
 * lease renewal, retry scheduling, and recovery remain implemented in `@flowforge/queue`.
 */
export type WorkerPort = Pick<LocalQueueWorker, "workerId" | "runOnce" | "runUntilIdle" | "cancel">;

/**
 * Provider identity and declared capabilities. Used for admission checks and for the
 * coverage guard only — the services never select a provider implementation, construct one,
 * or call it directly.
 */
export type ProviderDescriptor = Pick<GenerationProvider, "id" | "capabilities">;

export type ProviderRegistry = ReadonlyMap<string, ProviderDescriptor>;
