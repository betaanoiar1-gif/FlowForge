import type { GenerationProvider } from "@flowforge/core";
import type { LocalQueueWorker, SqliteJobQueue } from "@flowforge/queue";
import type { SqliteJobRepository, SqlitePlanningRepository } from "@flowforge/storage";

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
  // Character identities: the planning domain extends this table rather than duplicating it.
  | "createCharacter"
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

/**
 * Persistence surface of the creative planning domain. Like `JobRepository` this is a structural
 * `Pick`, so the planning services can only use reviewed write methods, and a test may supply a
 * partial fake. The repository owns the transactions; the services own the decisions.
 */
export type PlanningRepository = Pick<
  SqlitePlanningRepository,
  // Briefs and project definitions
  | "createBrief"
  | "getBrief"
  | "listBriefs"
  | "currentBrief"
  | "createWorld"
  | "getWorld"
  | "listWorlds"
  | "createVisualDna"
  | "getVisualDna"
  | "listVisualDna"
  | "setCharacterIdentity"
  | "getCharacter"
  | "listProjectCharacters"
  // Aggregate
  | "createPlanWithInitialVersion"
  | "getPlan"
  | "listPlans"
  | "getPlanVersion"
  | "getPlanVersionByNumber"
  | "listPlanVersions"
  | "setPlanCurrentVersion"
  | "transitionPlanVersionStatus"
  | "copyPlanVersion"
  // Children
  | "upsertStory"
  | "replacePlanCast"
  | "getScenePlan"
  | "getGenerationSpec"
  | "addScenePlan"
  | "updateScenePlan"
  | "deleteScenePlan"
  | "replaceScenePlanCast"
  | "addGenerationSpec"
  | "deleteGenerationSpec"
  // Evidence and aggregate reads
  | "recordPlanValidation"
  | "getLatestPlanValidation"
  | "getPlanValidation"
  | "listPlanValidations"
  | "loadPlanVersionSnapshot"
  | "planVersionContentHash"
>;
