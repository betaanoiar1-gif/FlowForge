import type {
  AssetVersionRecord,
  GenerationAttempt,
  GenerationJob,
  JobStatus,
  QCResultRecord,
  QueueItemRecord,
  QueueItemStatus,
  SceneRecord,
  SceneStatus,
} from "@flowforge/core";
import type { ReviewRecord } from "@flowforge/core";
import type {
  AttemptSummary,
  GenerationStatus,
  JobSummary,
  OutputSummary,
  ProductionReadiness,
  QCSummary,
  QueueItemRow,
  QueueStatus,
  ReadinessBlocker,
  ReadinessBlockerCode,
  ReviewQueueItem,
  SceneListItem,
  SceneVersionSummary,
} from "./read-models.js";
import type { JobRepository, ProviderRegistry } from "./ports.js";
import { UNSAFE_RETRY_ERROR_CLASSES } from "@flowforge/storage";

const QUEUE_STATUS_KEY: Record<QueueItemStatus, "queued" | "claimed" | "acked" | "failed" | "cancelled"> = {
  QUEUED: "queued",
  CLAIMED: "claimed",
  ACKED: "acked",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

export const EMPTY_JOB_COUNTS: Record<JobStatus, number> = {
  QUEUED: 0,
  CLAIMED: 0,
  RUNNING: 0,
  SUCCEEDED: 0,
  FAILED: 0,
  CANCELLED: 0,
};

export function jobCounts(jobs: readonly GenerationJob[]): Record<JobStatus, number> {
  const counts: Record<JobStatus, number> = { ...EMPTY_JOB_COUNTS };
  for (const job of jobs) counts[job.status] += 1;
  return counts;
}

export function toJobSummary(job: GenerationJob): JobSummary {
  return {
    id: job.id,
    status: job.status,
    provider: job.request.provider,
    sceneVersionId: job.request.sceneVersionId,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function toAttemptSummary(attempt: GenerationAttempt): AttemptSummary {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    provider: attempt.provider,
    providerJobId: attempt.providerJobId,
    errorClass: attempt.errorClass,
    error: attempt.error,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    recoveryCount: attempt.recoveryCount,
  };
}

export function toQcSummary(qc: QCResultRecord | null): QCSummary | null {
  if (!qc) return null;
  return {
    status: qc.status,
    validatorVersion: qc.validatorVersion,
    failedChecks: Object.entries(qc.checks)
      .filter(([, evidence]) => evidence.status !== "PASS")
      .map(([name]) => name),
    createdAt: qc.createdAt,
  };
}

export function previewText(value: string, max = 160): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

export function toSceneVersionSummary(
  version: { id: string; versionNumber: number; prompt: string; references: string[]; createdAt: string },
  currentVersionId: string | undefined,
): SceneVersionSummary {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    prompt: version.prompt,
    references: version.references,
    createdAt: version.createdAt,
    isCurrent: version.id === currentVersionId,
  };
}

export function toOutputSummary(
  repository: JobRepository,
  assetVersion: AssetVersionRecord,
  selectedAssetVersionId: string | undefined,
): OutputSummary {
  const qc = toQcSummary(repository.getQCResult(assetVersion.id));
  const review: ReviewRecord | null = repository.getReviewByAssetVersion(assetVersion.id);
  return {
    assetVersionId: assetVersion.id,
    assetId: assetVersion.assetId,
    sceneVersionId: assetVersion.sceneVersionId,
    generationJobId: assetVersion.generationJobId,
    generationAttemptId: assetVersion.generationAttemptId,
    versionNumber: assetVersion.versionNumber,
    provider: assetVersion.provider,
    mimeType: assetVersion.mimeType,
    sizeBytes: assetVersion.sizeBytes,
    width: assetVersion.width,
    height: assetVersion.height,
    checksum: assetVersion.checksum,
    storagePath: assetVersion.storagePath,
    createdAt: assetVersion.createdAt,
    qc,
    review,
    selected: assetVersion.id === selectedAssetVersionId,
    approvedAndPassing: review?.status === "APPROVED" && qc?.status === "PASSED",
  };
}

/** Outputs persisted for a job, read back from the attempts that produced them. */
export function outputsForJob(repository: JobRepository, job: GenerationJob): AssetVersionRecord[] {
  const attempts = repository.listGenerationAttempts(job.id);
  const outputs: AssetVersionRecord[] = [];
  const seen = new Set<string>();
  const outputCount = readOutputCount(job);
  for (const attempt of attempts) {
    if (attempt.status !== "SUCCEEDED") continue;
    for (let index = 0; index < outputCount; index += 1) {
      const version = repository.getAssetVersionByAttempt(attempt.id, index);
      if (version && !seen.has(version.id)) {
        seen.add(version.id);
        outputs.push(version);
      }
    }
  }
  return outputs;
}

export function readOutputCount(job: GenerationJob): number {
  const raw = job.request.parameters?.outputCount;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, 16) : 1;
}

/** True when any attempt of this job carries a state that makes resubmission unsafe. */
export function hasUnsafeAttempt(repository: JobRepository, jobId: string): boolean {
  return repository
    .listGenerationAttempts(jobId)
    .some((attempt) => attempt.errorClass && UNSAFE_RETRY_ERROR_CLASSES.includes(attempt.errorClass));
}

export function canRetryJob(job: GenerationJob, unsafeState: boolean): { allowed: boolean; reason: string } {
  if (job.status !== "FAILED") {
    return { allowed: false, reason: `Only failed jobs can be retried (status: ${job.status}).` };
  }
  if (job.idempotencyKey.startsWith("legacy:")) {
    return { allowed: false, reason: "Legacy jobs lack safe attempt history; create a new scene-versioned request." };
  }
  if (unsafeState) {
    return {
      allowed: false,
      reason: "A prior attempt has an uncertain or known provider result; create a new scene version instead of resubmitting.",
    };
  }
  if (job.attemptCount >= job.maxAttempts) {
    return { allowed: false, reason: `Retry limit reached (${job.attemptCount}/${job.maxAttempts}).` };
  }
  return { allowed: true, reason: "The job is failed, has attempt budget left, and shows no uncertain provider state." };
}

export function sceneReadiness(repository: JobRepository, scene: SceneRecord): ProductionReadiness {
  const blockers: ReadinessBlocker[] = [];
  const version = scene.currentVersionId ? repository.getSceneVersion(scene.currentVersionId) : null;
  const base = {
    sceneId: scene.id,
    sceneStatus: scene.status,
    currentSceneVersionId: scene.currentVersionId,
    selectedAssetVersionId: scene.selectedAssetVersionId,
  };

  if (scene.status === "ARCHIVED") {
    return {
      ...base,
      productionReady: false,
      blockers: [
        { code: "SCENE_ARCHIVED", message: "The scene is archived; restore it before producing from it." },
      ],
    };
  }
  if (!version) {
    blockers.push({
      code: "NO_CURRENT_SCENE_VERSION",
      message: "The scene has no current scene version, so there is no canonical prompt to produce.",
    });
    return { ...base, productionReady: false, blockers };
  }

  const succeededJobs = repository
    .listGenerationJobs({ sceneId: scene.id, sceneVersionId: version.id })
    .filter((job) => job.status === "SUCCEEDED");
  const openJobs = repository
    .listGenerationJobs({ sceneId: scene.id })
    .filter((job) => job.status === "QUEUED" || job.status === "CLAIMED" || job.status === "RUNNING");

  const outputs = succeededJobs.flatMap((job) => outputsForJob(repository, job));
  if (outputs.length === 0) {
    blockers.push({
      code: "NO_SUCCEEDED_OUTPUT_FOR_VERSION",
      message: `Scene version ${version.versionNumber} has no persisted asset from a succeeded generation.`,
      subject: { sceneVersionId: version.id },
    });
  }
  if (openJobs.length > 0) {
    blockers.push({
      code: "GENERATION_IN_PROGRESS",
      message: `${openJobs.length} generation job(s) for this scene are still queued or running.`,
      subject: { jobIds: openJobs.map((job) => job.id) },
    });
  }

  const selected = scene.selectedAssetVersionId
    ? repository.getAssetVersion(scene.selectedAssetVersionId)
    : null;
  if (!selected) {
    blockers.push({
      code: "NO_SELECTED_ASSET_VERSION",
      message: "No asset version has been explicitly selected for this scene.",
    });
    return { ...base, productionReady: false, blockers };
  }
  if (selected.sceneVersionId !== version.id) {
    blockers.push({
      code: "SELECTED_VERSION_NOT_CURRENT",
      message: "The selected asset version belongs to a different scene version than the current one.",
      subject: {
        assetVersionId: selected.id,
        selectedSceneVersionId: selected.sceneVersionId,
        currentSceneVersionId: version.id,
      },
    });
  }
  const qc = toQcSummary(repository.getQCResult(selected.id));
  if (!qc) {
    blockers.push({
      code: "QC_NOT_PASSED",
      message: "The selected asset version has no deterministic QC record.",
      subject: { assetVersionId: selected.id },
    });
  } else if (qc.status !== "PASSED") {
    blockers.push({
      code: "QC_NOT_PASSED",
      message: `Deterministic QC ${qc.status} for the selected asset version (failed checks: ${qc.failedChecks.join(", ") || "unspecified"}).`,
      subject: { assetVersionId: selected.id, failedChecks: qc.failedChecks },
    });
  }
  const review = repository.getReviewByAssetVersion(selected.id);
  if (!review || review.status !== "APPROVED") {
    blockers.push({
      code: "REVIEW_NOT_APPROVED",
      message: `Human review is ${review ? review.status : "missing"}, not APPROVED.`,
      subject: { assetVersionId: selected.id, reviewStatus: review?.status ?? "MISSING" },
    });
  }

  return { ...base, productionReady: blockers.length === 0, blockers };
}

export function blockerCodes(readiness: ProductionReadiness): ReadinessBlockerCode[] {
  return readiness.blockers.map((blocker) => blocker.code);
}

export function nextActionFor(
  job: GenerationJob,
  opts: {
    readiness: ProductionReadiness;
    sceneStatus: SceneStatus;
    outputs: OutputSummary[];
    retryAllowed: boolean;
    unsafeState: boolean;
  },
): GenerationStatus["nextAction"] {
  if (opts.sceneStatus === "ARCHIVED") return "SCENE_ARCHIVED";
  switch (job.status) {
    case "QUEUED":
      return "AWAIT_WORKER";
    case "CLAIMED":
    case "RUNNING":
      return "AWAIT_ATTEMPT";
    case "FAILED":
      if (opts.unsafeState) return "RETRY_BLOCKED_UNSAFE_STATE";
      return opts.retryAllowed ? "RETRY_AVAILABLE" : "RETRY_LIMIT_REACHED";
    case "CANCELLED":
      return "REQUEST_NEW_SCENE_VERSION";
    case "SUCCEEDED": {
      if (opts.readiness.productionReady) {
        return opts.sceneStatus === "READY" ? "PRODUCTION_READY" : "MARK_SCENE_READY";
      }
      const selectable = opts.outputs.some((output) => output.approvedAndPassing);
      if (!selectable) {
        const everyOutputDecided =
          opts.outputs.length > 0 && opts.outputs.every((output) => output.review && output.review.status !== "PENDING");
        return everyOutputDecided ? "REQUEST_NEW_SCENE_VERSION" : "AWAIT_HUMAN_REVIEW";
      }
      return opts.readiness.selectedAssetVersionId ? "RESELECT_ASSET_VERSION" : "SELECT_APPROVED_VERSION";
    }
  }
}

export function generationStatus(repository: JobRepository, job: GenerationJob): GenerationStatus {
  const scene = repository.getScene(job.request.sceneId);
  const readiness = scene
    ? sceneReadiness(repository, scene)
    : {
        sceneId: job.request.sceneId,
        sceneStatus: "DRAFT" as const,
        productionReady: false,
        blockers: [],
      };
  const versionId = job.request.sceneVersionId;
  const version = versionId ? repository.getSceneVersion(versionId) : null;
  const outputs = outputsForJob(repository, job).map((assetVersion) =>
    toOutputSummary(repository, assetVersion, scene?.selectedAssetVersionId),
  );
  const attempts = repository.listGenerationAttempts(job.id).map(toAttemptSummary);
  const activeAttempt = repository.getActiveAttempt(job.id);
  const unsafeState = hasUnsafeAttempt(repository, job.id);
  return {
    job: toJobSummary(job),
    request: {
      projectId: job.request.projectId,
      sceneId: job.request.sceneId,
      sceneVersionId: versionId,
      provider: job.request.provider,
      // The scene version is the canonical prompt; a legacy job record is the fallback.
      promptPreview: previewText(version?.prompt ?? job.request.prompt),
      referenceCount: version?.references.length ?? job.request.references?.length ?? 0,
      parameters: job.request.parameters ?? {},
    },
    queue: repository.getQueueItemByJob(job.id),
    activeAttempt: activeAttempt ? toAttemptSummary(activeAttempt) : null,
    attempts,
    outputs,
    nextAction: nextActionFor(job, {
      readiness,
      sceneStatus: scene?.status ?? "DRAFT",
      outputs,
      retryAllowed: canRetryJob(job, unsafeState).allowed,
      unsafeState,
    }),
    safeToRetry: canRetryJob(job, unsafeState).allowed,
  };
}

export function toQueueItemRow(
  repository: JobRepository,
  item: QueueItemRecord,
  nowMs: number,
): QueueItemRow | null {
  const job = repository.getGenerationJob(item.generationJobId);
  if (!job) return null;
  return {
    queueItemId: item.id,
    jobId: job.id,
    jobStatus: job.status,
    provider: job.request.provider,
    sceneId: job.request.sceneId,
    status: item.status,
    priority: item.priority,
    availableAt: item.availableAt,
    claimCount: item.claimCount,
    workerId: item.workerId,
    claimedAt: item.claimedAt,
    leaseUntil: item.leaseUntil,
    lastError: item.lastError,
    claimableNow: item.status === "QUEUED" && Date.parse(item.availableAt) <= nowMs,
  };
}

export function queueStatus(
  repository: JobRepository,
  opts: { workerId?: string; providerId?: string; providers: ProviderRegistry; nowMs: number },
): QueueStatus {
  const items: QueueItemRow[] = [];
  for (const item of repository.listQueueItems()) {
    const row = toQueueItemRow(repository, item, opts.nowMs);
    if (row) items.push(row);
  }
  const depth = {
    total: items.length,
    queued: 0,
    claimed: 0,
    acked: 0,
    failed: 0,
    cancelled: 0,
    claimableNow: 0,
  };
  for (const item of items) {
    depth[QUEUE_STATUS_KEY[item.status]] += 1;
    if (item.claimableNow) depth.claimableNow += 1;
  }
  return {
    worker: opts.workerId && opts.providerId ? { workerId: opts.workerId, providerId: opts.providerId } : null,
    configuredProviders: [...opts.providers.keys()].sort(),
    depth,
    items: items.sort((left, right) => right.priority - left.priority || left.availableAt.localeCompare(right.availableAt)),
    jobsByStatus: jobCounts(repository.listGenerationJobs()),
  };
}

export function reviewQueueItem(repository: JobRepository, assetVersion: AssetVersionRecord): ReviewQueueItem | null {
  const asset = repository.getAsset(assetVersion.assetId);
  if (!asset?.sceneId) return null;
  const scene = repository.getScene(asset.sceneId);
  const version = repository.getSceneVersion(assetVersion.sceneVersionId);
  const job = repository.getGenerationJob(assetVersion.generationJobId);
  const review = repository.getReviewByAssetVersion(assetVersion.id);
  const qc = toQcSummary(repository.getQCResult(assetVersion.id));
  if (!scene || !version || !job || !review) return null;
  return {
    assetVersionId: assetVersion.id,
    sceneId: scene.id,
    sceneTitle: scene.title,
    sceneNumber: scene.sceneNumber,
    sceneVersionId: version.id,
    sceneVersionNumber: version.versionNumber,
    jobId: job.id,
    jobStatus: job.status,
    provider: assetVersion.provider,
    reviewStatus: review.status,
    reviewer: review.reviewer,
    reason: review.reason,
    comment: review.comment,
    qcStatus: qc?.status ?? null,
    failedChecks: qc?.failedChecks ?? [],
    selected: scene.selectedAssetVersionId === assetVersion.id,
    storagePath: assetVersion.storagePath,
    createdAt: review.createdAt,
  };
}

export function sceneListItem(repository: JobRepository, scene: SceneRecord): SceneListItem {
  const jobs = repository.listGenerationJobs({ sceneId: scene.id });
  const version = scene.currentVersionId ? repository.getSceneVersion(scene.currentVersionId) : null;
  const readiness = sceneReadiness(repository, scene);
  const pendingReviews = version
    ? repository
        .listAssetVersionsForSceneVersion(version.id)
        .filter((assetVersion) => repository.getReviewByAssetVersion(assetVersion.id)?.status === "PENDING").length
    : 0;
  return {
    sceneId: scene.id,
    sceneNumber: scene.sceneNumber,
    title: scene.title,
    status: scene.status,
    currentVersionId: scene.currentVersionId,
    currentVersionNumber: version?.versionNumber,
    selectedAssetVersionId: scene.selectedAssetVersionId,
    jobCount: jobs.length,
    openJobCount: jobs.filter((job) => job.status === "QUEUED" || job.status === "CLAIMED" || job.status === "RUNNING").length,
    pendingReviewCount: pendingReviews,
    productionReady: readiness.productionReady,
    blockers: blockerCodes(readiness),
  };
}
