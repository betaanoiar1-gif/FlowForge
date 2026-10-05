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
// The deterministic planner (Phase 4B): the engine module and the service that authors plans with it.
export { PlannerService, type PlanProductionResult } from "./planner-service.js";
export { mapPlanToJobs, type PlanExecutionMapping, type PlanExecutionOptions, type PlannedJobIntent } from "./plan-execution.js";
export * as planner from "./planner/index.js";
// AI-assisted planning (Phase 4C): the orchestration service, and the pieces it composes. The adapter
// implementations live in `providers/*`; nothing here names a vendor.
export { AiPlannerService } from "./ai-planner-service.js";
export {
  AI_PLANNING_ERROR_CODES,
  AI_PLANNING_NOTICE_CODES,
  type AiPlanningErrorCode,
} from "./ai-planner/codes.js";
export {
  AI_PROPOSAL_LIMITS,
  validateProposal,
  type AiPlanningIssue,
  type AiPlanningIssueCode,
  type ProposalValidation,
} from "./ai-planner/schema.js";
export {
  aiProposalFingerprint,
  aiRequestFingerprint,
  aiResponseFingerprint,
} from "./ai-planner/fingerprint.js";
export {
  translateProposal,
  type AiPlanningError,
  type TranslationContext,
  type TranslationResult,
  type TranslatedProposal,
} from "./ai-planner/translate.js";
export type {
  AiPlanNotice,
  AiPlanOutcome,
  AiPlanProductionCommand,
  AiPlanProductionResult,
  AiPlanningGuidance,
  AiPlanningNotice,
  AiPlanningSummary,
} from "./ai-planner/types.js";
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
  PlannerCastInput,
  PlannerDraft,
  PlannerNotice,
  PlannerOptionsInput,
  PlannerOutcome,
  PlannerProviderCandidate,
  PlannerRun,
  PlannerStoryInput,
  PlannerWorldInput,
  PlannedScenePlan,
  PlannedSpec,
} from "./planner/types.js";
export type {
  AddGenerationSpecCommand,
  AddScenePlanCommand,
  CreateBriefCommand,
  CreatePlanCommand,
  CreatePlanningCharacterCommand,
  CreateVisualDnaCommand,
  CreateWorldCommand,
  PlanLifecycleCommand,
  PlanProductionCommand,
  PlanVersionTarget,
  SetPlanCastCommand,
  SetPlanStoryCommand,
  SetScenePlanCastCommand,
} from "./commands.js";
/* -------------------------------------------------------------------------- *
 * Plan materialization (Phase 5). The pure identity/mapping/readiness helpers  *
 * are exported as a namespace, like the 4B planner, so a caller can derive an    *
 * execution fingerprint or assess readiness without a database; the service is    *
 * the only thing that writes, and it writes through the existing services.        */
export * as execution from "./execution/index.js";
export { PlanExecutionService } from "./execution/plan-execution-service.js";
export type {
  ExecutionBlocker,
  ExecutionNotice,
  ExecutionUnitOutcome,
  PlanExecutionRecord,
  PlanExecutionStatus,
} from "@flowforge/core";
export type {
  ExecutionStateDeps,
} from "./execution/execution-recovery.js";
export type {
  ExecutionMapping,
  ExecutionMappingOptions,
  ExecutionUnit,
} from "./execution/execution-mapping.js";
export type {
  ExecutionReadiness,
  ExecutionReadinessContext,
} from "./execution/execution-readiness.js";
export type {
  MaterializePlanCommand,
  PlanExecutionCounts,
  PlanExecutionReport,
  PlanExecutionState,
  PlanExecutionUnitState,
  PlanExecutionVersionTarget,
} from "./execution/execution-types.js";

export type {
  ExecutionPreview,
  ExecutionPreviewItem,
  PlanApprovalView,
  PlanCapabilityCoverage,
  PlanCastRow,
  PlanDetail,
  PlanExecutabilityView,
  PlanListItem,
  PlanPlannerView,
  PlanningCounts,
  PlanningNextAction,
  PlanScenePlanRow,
  PlanValidationView,
  PlanVisualDnaResolution,
  ProjectPlanningOverview,
} from "./planning-read-models.js";
