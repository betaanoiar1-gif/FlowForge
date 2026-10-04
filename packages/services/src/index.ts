/**
 * FlowForge application layer (Phase 3).
 *
 * These services sit between the operator surface and the durable engine. They validate intent,
 * delegate state changes to the single component that already owns them, and project the stored
 * state into operator-facing read models. They own no queue, no storage, no retry algorithm, no
 * provider selection, and no browser or asset-byte handling.
 */
export {
  ApplicationError,
  APPLICATION_ERROR_CODES,
  describeThrown,
  translateRepositoryError,
  type ApplicationErrorCode,
  type ApplicationErrorDetails,
} from "./errors.js";
export {
  createApplication,
  type ApplicationOptions,
  type FlowForgeApplication,
} from "./application.js";
export { ProjectService } from "./project-service.js";
export { SceneService } from "./scene-service.js";
export { GenerationService } from "./generation-service.js";
export { QueueService } from "./queue-service.js";
export { ReviewService } from "./review-service.js";
export { ProductionService } from "./production-service.js";
export type { ServiceDeps } from "./deps.js";
export type {
  AddSceneVersionCommand,
  CancelGenerationCommand,
  CommandOptions,
  CreateProjectCommand,
  CreateSceneCommand,
  DecideReviewCommand,
  JobIdCommand,
  ProjectIdCommand,
  ReopenableSceneStatus,
  RequestGenerationCommand,
  RetryGenerationCommand,
  RunWorkerCommand,
  SceneIdCommand,
  SelectAssetVersionCommand,
  SetCurrentSceneVersionCommand,
  SetSceneStatusCommand,
} from "./commands.js";
export type {
  JobRepository,
  PlanningRepository,
  ProviderDescriptor,
  ProviderRegistry,
  QueuePort,
  WorkerPort,
} from "./ports.js";
export type {
  AttemptSummary,
  CancellationResult,
  ExecutionResult,
  GenerationRequestResult,
  GenerationStatus,
  NextActionCode,
  OutputSummary,
  ProductionReadiness,
  ProjectOverview,
  ProjectProductionSummary,
  QCSummary,
  QueueItemRow,
  QueueStatus,
  ReadinessBlocker,
  ReadinessBlockerCode,
  RecoveryResult,
  ReviewDecisionResult,
  ReviewQueueItem,
  SceneDetail,
  SceneListItem,
  SceneSummaryRow,
  SceneVersionSummary,
  SelectionResult,
  JobSummary,
} from "./read-models.js";
export {
  blockerCodes,
  canRetryJob,
  EMPTY_JOB_COUNTS,
  generationStatus,
  hasUnsafeAttempt,
  jobCounts,
  nextActionFor,
  outputsForJob,
  queueStatus,
  readOutputCount,
  reviewQueueItem,
  sceneListItem,
  sceneReadiness,
  toAttemptSummary,
  toJobSummary,
  toOutputSummary,
  toQueueItemRow,
  toSceneVersionSummary,
} from "./projections.js";
export { LIMITS } from "./validation.js";
export {
  CreativeBriefService,
  PlanningDefinitionService,
  PlanningReadService,
  PlanningValidationService,
  ProductionPlanService,
  planningNotConfigured,
} from "./planning.js";
export {
  MAX_SPEC_OUTPUT_COUNT,
  MIN_SPEC_DURATION_MS,
  PLAN_ASPECT_RATIO_PATTERN,
  sortFindings,
  summarizePlanFindings,
  validatePlanVersion,
  type PlanValidationOptions,
  type PlanValidationSummary,
} from "./plan-validation.js";
export type {
  AddGenerationSpecCommand,
  AddScenePlanCommand,
  CreateBriefCommand,
  CreatePlanCommand,
  CreatePlanningCharacterCommand,
  CreateVisualDnaCommand,
  CreateWorldCommand,
  PlanLifecycleCommand,
  PlanVersionTarget,
  SetPlanCastCommand,
  SetPlanStoryCommand,
  SetScenePlanCastCommand,
} from "./commands.js";
export type {
  ExecutionPreview,
  ExecutionPreviewItem,
  PlanApprovalView,
  PlanCapabilityCoverage,
  PlanCastRow,
  PlanDetail,
  PlanExecutabilityView,
  PlanListItem,
  PlanningCounts,
  PlanningNextAction,
  PlanScenePlanRow,
  PlanValidationView,
  PlanVisualDnaResolution,
  ProjectPlanningOverview,
} from "./planning-read-models.js";
