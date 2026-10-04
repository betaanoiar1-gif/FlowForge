export type Id = string;

export type ProjectStatus = "ACTIVE" | "ARCHIVED";
export type SceneStatus = "DRAFT" | "READY" | "ARCHIVED";

export type JobStatus =
  | "QUEUED"
  | "CLAIMED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type GenerationAttemptStatus =
  | "CLAIMED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type QueueItemStatus =
  | "QUEUED"
  | "CLAIMED"
  | "ACKED"
  | "FAILED"
  | "CANCELLED";

export interface GenerationRequest {
  projectId: Id;
  sceneId: Id;
  /** Optional only for migrated legacy jobs; new jobs always pin a scene version. */
  sceneVersionId?: Id;
  prompt: string;
  references?: string[];
  provider: string;
  parameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface GenerationJob {
  id: Id;
  request: GenerationRequest;
  idempotencyKey: string;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  externalId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  QUEUED: ["CLAIMED", "CANCELLED"],
  CLAIMED: ["RUNNING", "QUEUED", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "QUEUED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: ["QUEUED", "CANCELLED"],
  CANCELLED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid generation job transition: ${from} -> ${to}`);
  }
}

export function transitionJob(
  job: GenerationJob,
  to: JobStatus,
  error?: string,
): GenerationJob {
  assertTransition(job.status, to);
  return {
    ...job,
    status: to,
    error: to === "FAILED" ? error ?? job.error : undefined,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Allowed status transitions for the scene lifecycle. `READY` is only meaningful as a
 * production gate that the caller has already validated (see the application services);
 * this table keeps that gate from being bypassed by a direct repository write.
 * `ARCHIVED` is terminal.
 */
export const SCENE_STATUS_TRANSITIONS: Readonly<
  Record<SceneStatus, readonly SceneStatus[]>
> = {
  DRAFT: ["READY", "ARCHIVED"],
  READY: ["DRAFT", "ARCHIVED"],
  ARCHIVED: [],
};

/** Allowed status transitions for a project. `ARCHIVED` is terminal. */
export const PROJECT_STATUS_TRANSITIONS: Readonly<
  Record<ProjectStatus, readonly ProjectStatus[]>
> = {
  ACTIVE: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canTransitionSceneStatus(from: SceneStatus, to: SceneStatus): boolean {
  return SCENE_STATUS_TRANSITIONS[from].includes(to);
}

export function assertSceneStatusTransition(from: SceneStatus, to: SceneStatus): void {
  if (!canTransitionSceneStatus(from, to)) {
    throw new Error(`Invalid scene status transition: ${from} -> ${to}`);
  }
}

export function canTransitionProjectStatus(
  from: ProjectStatus,
  to: ProjectStatus,
): boolean {
  return PROJECT_STATUS_TRANSITIONS[from].includes(to);
}

export function assertProjectStatusTransition(
  from: ProjectStatus,
  to: ProjectStatus,
): void {
  if (!canTransitionProjectStatus(from, to)) {
    throw new Error(`Invalid project status transition: ${from} -> ${to}`);
  }
}

export interface GenerationAttempt {
  id: Id;
  generationJobId: Id;
  attemptNumber: number;
  provider: string;
  providerRequestKey: string;
  status: GenerationAttemptStatus;
  providerJobId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  errorClass?: string;
  recoveryCount: number;
}

export interface GenerationProviderRequest extends GenerationRequest {
  sceneVersionId: Id;
  jobId: Id;
  logicalIdempotencyKey: string;
  providerRequestKey: string;
  attemptNumber: number;
}

export type ProviderGenerationStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface ProviderGenerationHandle {
  providerJobId: string;
  status: ProviderGenerationStatus;
}

export interface ProviderGenerationSnapshot extends ProviderGenerationHandle {
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface ProviderArtifact {
  sourcePath: string;
  fileName: string;
  mimeType?: string;
  outputIndex?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderCapabilities {
  imageGeneration: boolean;
  videoGeneration: boolean;
  referenceImages: boolean;
  startFrame: boolean;
  endFrame: boolean;
  batchGeneration: boolean;
}

/** A provider operation failed with enough context for safe workflow recovery. */
export class GenerationProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly submissionUnknown: boolean;

  constructor(input: {
    message: string;
    code: string;
    retryable: boolean;
    submissionUnknown?: boolean;
  }) {
    super(input.message);
    this.name = "GenerationProviderError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.submissionUnknown = input.submissionUnknown ?? false;
  }
}

/** Provider port shared by MockProvider and future real providers. */
export interface GenerationProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  /** The optional request lets providers correlate visible remote state without storing its prompt. */
  findGeneration(providerRequestKey: string, request?: GenerationProviderRequest): Promise<ProviderGenerationHandle | null>;
  createGeneration(request: GenerationProviderRequest): Promise<ProviderGenerationHandle>;
  getGenerationStatus(providerJobId: string, request?: GenerationProviderRequest): Promise<ProviderGenerationSnapshot>;
  downloadResult(providerJobId: string, request?: GenerationProviderRequest): Promise<ProviderArtifact[]>;
  cancelGeneration(providerJobId: string): Promise<void>;
}

/** Backwards-compatible name for the provider boundary. */
export interface ProviderAdapter extends GenerationProvider {}

export interface JobEvent {
  generationJobId: Id;
  from: JobStatus;
  to: JobStatus;
  at: string;
  error?: string;
}

export interface ProjectRecord {
  id: Id;
  name: string;
  description?: string;
  status: ProjectStatus;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SceneRecord {
  id: Id;
  projectId: Id;
  sceneNumber: number;
  title: string;
  /** Legacy aliases retained for callers that used the initial repository API. */
  name: string;
  sequence: number;
  description?: string;
  status: SceneStatus;
  currentVersionId?: Id;
  selectedAssetVersionId?: Id;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SceneVersionRecord {
  id: Id;
  sceneId: Id;
  versionNumber: number;
  prompt: string;
  references: string[];
  metadata?: Record<string, unknown>;
  parentVersionId?: Id;
  createdAt: string;
}

export interface CharacterRecord {
  id: Id;
  projectId: Id;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SceneCharacterRecord {
  sceneId: Id;
  characterId: Id;
  role?: string;
  createdAt: string;
}

export interface QueueItemRecord {
  id: Id;
  generationJobId: Id;
  status: QueueItemStatus;
  priority: number;
  enqueuedAt: string;
  availableAt: string;
  claimedAt?: string;
  leaseUntil?: string;
  workerId?: string;
  claimCount: number;
  acknowledgedAt?: string;
  lastError?: string;
}

export interface AssetRecord {
  id: Id;
  projectId: Id;
  sceneId?: Id;
  jobId?: Id;
  kind: string;
  path: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  provider?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AssetVersionRecord {
  id: Id;
  assetId: Id;
  versionNumber: number;
  sceneVersionId: Id;
  generationJobId: Id;
  generationAttemptId: Id;
  provider: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  outputIndex: number;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type QCCheckStatus = "PASS" | "FAIL" | "NOT_EVALUATED";
export type QCStatus = "PASSED" | "FAILED" | "NOT_EVALUATED";

export interface QCCheckEvidence {
  status: QCCheckStatus;
  expected?: string | number | boolean;
  actual?: string | number | boolean;
  message?: string;
}

export interface QCResultRecord {
  id: Id;
  assetVersionId: Id;
  status: QCStatus;
  validatorVersion: string;
  checks: Record<string, QCCheckEvidence>;
  createdAt: string;
}

export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ReviewRecord {
  id: Id;
  assetVersionId: Id;
  status: ReviewStatus;
  reason?: string;
  comment?: string;
  reviewer?: string;
  createdAt: string;
  updatedAt: string;
}
