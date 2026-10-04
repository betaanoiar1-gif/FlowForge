import type {
  AssetVersionRecord,
  GenerationAttempt,
  JobStatus,
  ProjectRecord,
  QCStatus,
  QueueItemRecord,
  SceneRecord,
  SceneStatus,
} from "@flowforge/core";
import type { ReviewRecord } from "@flowforge/core";

/**
 * Operator-facing read models. They are plain, serialisable objects with stable field names,
 * safe to `JSON.stringify` directly. They never carry secrets, browser state, or provider
 * internals, and list projections deliberately omit long prompt text (detail projections keep
 * it because the scene version is the local source of truth for what was requested).
 */

export interface SceneVersionSummary {
  id: string;
  versionNumber: number;
  prompt: string;
  references: string[];
  createdAt: string;
  isCurrent: boolean;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  provider: string;
  sceneVersionId?: string;
  attemptCount: number;
  maxAttempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptSummary {
  id: string;
  attemptNumber: number;
  status: GenerationAttempt["status"];
  provider: string;
  providerJobId?: string;
  errorClass?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  recoveryCount: number;
}

export interface QCSummary {
  status: QCStatus;
  validatorVersion: string;
  failedChecks: string[];
  createdAt: string;
}

export interface OutputSummary {
  assetVersionId: string;
  assetId: string;
  sceneVersionId: string;
  generationJobId: string;
  generationAttemptId: string;
  versionNumber: number;
  provider: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  checksum: string;
  storagePath: string;
  createdAt: string;
  qc: QCSummary | null;
  review: ReviewRecord | null;
  selected: boolean;
  approvedAndPassing: boolean;
}

export type ReadinessBlockerCode =
  | "NO_CURRENT_SCENE_VERSION"
  | "NO_SUCCEEDED_OUTPUT_FOR_VERSION"
  | "GENERATION_IN_PROGRESS"
  | "NO_SELECTED_ASSET_VERSION"
  | "QC_NOT_PASSED"
  | "REVIEW_NOT_APPROVED"
  | "SELECTED_VERSION_NOT_CURRENT"
  | "SCENE_ARCHIVED";

export interface ReadinessBlocker {
  code: ReadinessBlockerCode;
  message: string;
  subject?: Record<string, unknown>;
}

export interface ProductionReadiness {
  sceneId: string;
  sceneStatus: SceneStatus;
  currentSceneVersionId?: string;
  selectedAssetVersionId?: string;
  productionReady: boolean;
  blockers: ReadinessBlocker[];
}

export interface SceneListItem {
  sceneId: string;
  sceneNumber: number;
  title: string;
  status: SceneStatus;
  currentVersionId?: string;
  currentVersionNumber?: number;
  selectedAssetVersionId?: string;
  jobCount: number;
  openJobCount: number;
  pendingReviewCount: number;
  productionReady: boolean;
  blockers: ReadinessBlockerCode[];
}

export interface SceneDetail {
  scene: SceneRecord;
  versions: SceneVersionSummary[];
  jobs: JobSummary[];
  outputs: OutputSummary[];
  readiness: ProductionReadiness;
}

export interface ProjectOverview {
  project: ProjectRecord;
  scenes: SceneListItem[];
  totals: {
    scenes: number;
    readyScenes: number;
    jobs: number;
    jobsByStatus: Record<JobStatus, number>;
    pendingReviews: number;
    queuedWork: number;
    assets: number;
  };
}

export interface GenerationStatus {
  job: JobSummary;
  request: {
    projectId: string;
    sceneId: string;
    sceneVersionId?: string;
    provider: string;
    promptPreview: string;
    referenceCount: number;
    parameters: Record<string, unknown>;
  };
  queue: QueueItemRecord | null;
  activeAttempt: AttemptSummary | null;
  attempts: AttemptSummary[];
  outputs: OutputSummary[];
  nextAction: NextActionCode;
  safeToRetry: boolean;
}

/** Machine-readable operator guidance; derived only from durable state, never guessed. */
export type NextActionCode =
  | "AWAIT_WORKER"
  | "AWAIT_ATTEMPT"
  | "AWAIT_HUMAN_REVIEW"
  | "SELECT_APPROVED_VERSION"
  | "RESELECT_ASSET_VERSION"
  | "MARK_SCENE_READY"
  | "PRODUCTION_READY"
  | "RETRY_AVAILABLE"
  | "RETRY_LIMIT_REACHED"
  | "RETRY_BLOCKED_UNSAFE_STATE"
  | "REQUEST_NEW_SCENE_VERSION"
  | "SCENE_ARCHIVED";

export interface GenerationRequestResult {
  job: JobSummary;
  created: boolean;
  reusedExistingJob: boolean;
  queue: QueueItemRecord | null;
  status: GenerationStatus;
}

export interface CancellationResult {
  job: JobSummary;
  localCancellation: "CANCELLED" | "ALREADY_TERMINAL";
  providerCancellation: "ATTEMPTED" | "NOT_ATTEMPTED";
  providerCancellationReason?: string;
}

export interface QueueItemRow {
  queueItemId: string;
  jobId: string;
  jobStatus: JobStatus;
  provider: string;
  sceneId: string;
  status: QueueItemRecord["status"];
  priority: number;
  availableAt: string;
  claimCount: number;
  workerId?: string;
  claimedAt?: string;
  leaseUntil?: string;
  lastError?: string;
  claimableNow: boolean;
}

export interface QueueStatus {
  worker: { workerId: string; providerId: string } | null;
  configuredProviders: string[];
  depth: {
    total: number;
    queued: number;
    claimed: number;
    acked: number;
    failed: number;
    cancelled: number;
    claimableNow: number;
  };
  items: QueueItemRow[];
  jobsByStatus: Record<JobStatus, number>;
}

export interface ExecutionResult {
  workerId: string;
  attempted: number;
  results: {
    jobId: string;
    status: JobStatus;
    attemptNumber?: number;
    assetVersionId?: string;
    qcStatus?: QCStatus;
    error?: string;
  }[];
  after: QueueStatus;
}

export interface RecoveryResult {
  recoveredLeases: number;
  after: QueueStatus;
}

export interface ReviewQueueItem {
  assetVersionId: string;
  sceneId: string;
  sceneTitle: string;
  sceneNumber: number;
  sceneVersionId: string;
  sceneVersionNumber: number;
  jobId: string;
  jobStatus: JobStatus;
  provider: string;
  reviewStatus: ReviewRecord["status"];
  reviewer?: string;
  reason?: string;
  comment?: string;
  qcStatus: QCStatus | null;
  failedChecks: string[];
  selected: boolean;
  storagePath: string;
  createdAt: string;
}

export interface ReviewDecisionResult {
  review: ReviewRecord;
  idempotent: boolean;
  item: ReviewQueueItem;
}

export interface SelectionResult {
  scene: SceneRecord;
  assetVersion: AssetVersionRecord;
  readiness: ProductionReadiness;
}

export interface SceneSummaryRow {
  sceneId: string;
  title: string;
  status: SceneStatus;
  productionReady: boolean;
  blockers: ReadinessBlockerCode[];
  selectedAssetVersionId?: string;
  checksum?: string;
}

export interface ProjectProductionSummary {
  projectId: string;
  projectName: string;
  projectStatus: ProjectRecord["status"];
  productionReady: boolean;
  blockingReasons: string[];
  counts: { scenes: number; productionReady: number; draft: number; ready: number; archived: number };
  scenes: SceneSummaryRow[];
  assets: { count: number };
}
