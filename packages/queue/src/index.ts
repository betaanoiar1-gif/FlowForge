import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type {
  GenerationJob,
  GenerationProvider,
  GenerationProviderRequest,
  JobStatus,
  ProviderArtifact,
  ProviderGenerationHandle,
  ProviderGenerationSnapshot,
  QCStatus,
  QueueItemRecord,
} from "@flowforge/core";
import { GenerationProviderError } from "@flowforge/core";
import { FileSystemAssetStore, hashFileSha256 } from "@flowforge/assets";
import { validateAssetFile } from "@flowforge/qc";
import {
  SqliteJobRepository,
  type ClaimedGeneration,
} from "@flowforge/storage";

export { type QueueItemRecord };

export class SqliteJobQueue {
  constructor(private readonly repository: SqliteJobRepository) {}

  claimNext(workerId: string, leaseMs: number, now?: string): ClaimedGeneration | null {
    return this.repository.claimNext(workerId, leaseMs, now);
  }

  recoverExpiredLeases(now?: string): number {
    return this.repository.recoverExpiredLeases(now);
  }

  size(): number {
    return this.repository.queueSize();
  }

  has(jobId: string): boolean {
    return this.repository.hasQueueItem(jobId);
  }

  get(jobId: string): QueueItemRecord | null {
    return this.repository.getQueueItemByJob(jobId);
  }
}

export interface WorkerResult {
  jobId: string;
  status: JobStatus;
  attemptNumber?: number;
  assetVersionId?: string;
  qcStatus?: QCStatus;
  error?: string;
}

export interface LocalQueueWorkerOptions {
  workerId?: string;
  leaseMs?: number;
  retryDelayMs?: number;
  maxRecoveries?: number;
  now?: () => Date;
}

/** Durable local worker with lease renewal and provider-key recovery before submission. */
export class LocalQueueWorker {
  readonly workerId: string;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRecoveries: number;
  private readonly now: () => Date;

  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly queue: SqliteJobQueue,
    private readonly provider: GenerationProvider,
    private readonly assetStore: FileSystemAssetStore,
    options: LocalQueueWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRecoveries = options.maxRecoveries ?? 20;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) throw new Error("leaseMs must be a positive integer.");
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) throw new Error("retryDelayMs must be a non-negative integer.");
    if (!Number.isSafeInteger(this.maxRecoveries) || this.maxRecoveries < 1) throw new Error("maxRecoveries must be a positive integer.");
  }

  async runOnce(): Promise<WorkerResult | null> {
    const now = this.nowIso();
    this.queue.recoverExpiredLeases(now);
    const claim = this.queue.claimNext(this.workerId, this.leaseMs, now);
    if (!claim) return null;

    return this.withLeaseHeartbeat(claim, () => this.processClaim(claim));
  }

  async runUntilIdle(maxJobs = 100): Promise<WorkerResult[]> {
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) throw new Error("maxJobs must be a positive integer.");
    const results: WorkerResult[] = [];
    for (let index = 0; index < maxJobs; index += 1) {
      const result = await this.runOnce();
      if (!result) break;
      results.push(result);
    }
    return results;
  }

  async cancel(jobId: string): Promise<GenerationJob> {
    const activeAttempt = this.repository.getActiveAttempt(jobId);
    const providerJobId = activeAttempt?.providerJobId;
    const job = this.repository.cancelGenerationJob(jobId, this.nowIso());
    if (providerJobId) {
      try {
        await this.provider.cancelGeneration(providerJobId);
      } catch {
        // Cancellation of the persisted local job is final; provider cancellation is best effort.
      }
    }
    return job;
  }

  private async processClaim(claim: ClaimedGeneration): Promise<WorkerResult> {
    const { job, attempt } = claim;
    if (this.provider.id !== job.request.provider) {
      return this.failAttempt(
        claim,
        `Worker provider ${this.provider.id} does not match job provider ${job.request.provider}.`,
        "PROVIDER_MISMATCH",
        false,
      );
    }
    this.repository.markAttemptRunning(job.id, attempt.id, this.workerId, this.nowIso());
    const providerRequest = toProviderRequest(job, attempt);

    let handle: ProviderGenerationHandle;
    try {
      if (attempt.providerJobId) {
        handle = { providerJobId: attempt.providerJobId, status: "RUNNING" };
      } else {
        // Always ask the provider first. This closes the crash window after remote acceptance
        // but before providerJobId has been committed to SQLite.
        handle = await this.provider.findGeneration(attempt.providerRequestKey) ??
          await this.provider.createGeneration(providerRequest);
        this.repository.setProviderJobId(
          job.id,
          attempt.id,
          this.workerId,
          handle.providerJobId,
          this.nowIso(),
        );
      }
    } catch (error) {
      if (error instanceof GenerationProviderError && !error.submissionUnknown) {
        return this.failAttempt(claim, error.message, error.code, error.retryable);
      }
      return this.deferAttempt(
        claim,
        `Provider submission/recovery outcome is uncertain: ${errorMessage(error)}`,
        "UNCERTAIN_PROVIDER_STATE",
      );
    }

    if (!attempt.providerJobId && !handle.providerJobId) {
      return this.deferAttempt(claim, "Provider returned no generation ID.", "UNCERTAIN_PROVIDER_STATE");
    }

    let snapshot: ProviderGenerationSnapshot;
    try {
      snapshot = await this.provider.getGenerationStatus(handle.providerJobId);
    } catch (error) {
      return this.deferAttempt(
        claim,
        `Provider status lookup failed; retaining the same attempt: ${errorMessage(error)}`,
        "UNCERTAIN_PROVIDER_STATE",
      );
    }

    if (snapshot.status === "QUEUED" || snapshot.status === "RUNNING") {
      return this.deferAttempt(
        claim,
        `Provider generation is still ${snapshot.status.toLowerCase()}.`,
        "UNCERTAIN_PROVIDER_STATE",
      );
    }
    if (snapshot.status === "CANCELLED") {
      return this.failAttempt(claim, snapshot.error ?? "Provider generation was cancelled.", "PROVIDER_CANCELLED", false);
    }
    if (snapshot.status === "FAILED") {
      return this.failAttempt(
        claim,
        snapshot.error ?? "Provider generation failed.",
        snapshot.errorCode ?? "PROVIDER_REPORTED_FAILURE",
        snapshot.retryable ?? false,
      );
    }

    return this.finalizeSuccessfulProviderResult(claim, snapshot);
  }

  private async finalizeSuccessfulProviderResult(
    claim: ClaimedGeneration,
    snapshot: ProviderGenerationSnapshot,
  ): Promise<WorkerResult> {
    try {
      const providedArtifacts = await this.provider.downloadResult(snapshot.providerJobId);
      const artifacts = await normalizeArtifacts(providedArtifacts);
      if (artifacts.length !== 1) {
        return this.failAttempt(
          claim,
          `Mock Phase 1 worker expects one output; provider returned ${artifacts.length} distinct outputs.`,
          "PROVIDER_RESULT_INVALID",
          false,
        );
      }
      const artifact = artifacts[0]!;
      const stored = await this.assetStore.importFile({
        projectId: claim.job.request.projectId,
        sceneId: claim.job.request.sceneId,
        generationJobId: claim.job.id,
        outputIndex: artifact.outputIndex,
        sourcePath: artifact.sourcePath,
        fileName: artifact.fileName,
      });
      const mimeType = normalizeMimeType(artifact.mimeType) ?? mimeTypeForFile(artifact.fileName);
      const qc = await validateAssetFile({
        path: stored.storagePath,
        expectedMimeType: mimeType,
        expectedSizeBytes: stored.sizeBytes,
        expectedChecksum: stored.checksum,
      });
      const completed = this.repository.completeGeneration({
        jobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: this.workerId,
        providerJobId: snapshot.providerJobId,
        asset: {
          id: stableId("asset", claim.job.id, artifact.outputIndex),
          versionId: stableId("asset-version", claim.job.id, artifact.outputIndex),
          kind: assetKind(mimeType),
          storagePath: stored.storagePath,
          mimeType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          outputIndex: artifact.outputIndex,
          width: qc.width,
          height: qc.height,
          metadata: {
            ...(artifact.metadata ?? {}),
            providerRequestKey: claim.attempt.providerRequestKey,
            providerJobId: snapshot.providerJobId,
          },
        },
        qc: {
          status: qc.status,
          validatorVersion: qc.validatorVersion,
          checks: qc.checks,
        },
        now: this.nowIso(),
      });
      return {
        jobId: completed.job.id,
        status: completed.job.status,
        attemptNumber: claim.attempt.attemptNumber,
        assetVersionId: completed.assetVersion.id,
        qcStatus: completed.qcResult.status,
      };
    } catch (error) {
      const errorClass = error instanceof InvalidProviderResultError
        ? "PROVIDER_RESULT_INVALID"
        : "ASSET_PERSISTENCE_EXHAUSTED";
      if (error instanceof InvalidProviderResultError) {
        return this.failAttempt(claim, error.message, errorClass, false);
      }
      return this.deferAttempt(
        claim,
        `Provider succeeded; artifact persistence will resume on the same attempt: ${errorMessage(error)}`,
        errorClass,
      );
    }
  }

  private failAttempt(claim: ClaimedGeneration, error: string, errorClass: string, retryable: boolean): WorkerResult {
    const now = this.nowIso();
    const updated = this.repository.failAttemptAndScheduleRetry({
      jobId: claim.job.id,
      attemptId: claim.attempt.id,
      workerId: this.workerId,
      error,
      errorClass,
      retryable,
      retryAt: this.addDelay(now, this.retryDelayMs),
      now,
    });
    return {
      jobId: updated.id,
      status: updated.status,
      attemptNumber: claim.attempt.attemptNumber,
      error: updated.error,
    };
  }

  private deferAttempt(claim: ClaimedGeneration, error: string, errorClass: string): WorkerResult {
    const now = this.nowIso();
    const updated = this.repository.deferAttemptForRecovery({
      jobId: claim.job.id,
      attemptId: claim.attempt.id,
      workerId: this.workerId,
      error,
      errorClass,
      retryAt: this.addDelay(now, this.retryDelayMs),
      maxRecoveries: this.maxRecoveries,
      now,
    });
    return {
      jobId: updated.id,
      status: updated.status,
      attemptNumber: claim.attempt.attemptNumber,
      error: updated.error,
    };
  }

  private async withLeaseHeartbeat<T>(claim: ClaimedGeneration, operation: () => Promise<T>): Promise<T> {
    const intervalMs = Math.max(25, Math.floor(this.leaseMs / 3));
    let renewalPending = false;
    const timer = setInterval(() => {
      if (renewalPending) return;
      renewalPending = true;
      try {
        this.repository.extendLease(claim.job.id, this.workerId, this.leaseMs, this.nowIso());
      } catch {
        // Every state transition still verifies lease ownership; a renewal failure can never ack stale work.
      } finally {
        renewalPending = false;
      }
    }, intervalMs);
    timer.unref?.();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
    }
  }

  private nowIso(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw new Error("Worker clock returned an invalid date.");
    return value.toISOString();
  }

  private addDelay(from: string, delayMs: number): string {
    return new Date(Date.parse(from) + delayMs).toISOString();
  }
}

interface NormalizedArtifact extends ProviderArtifact {
  outputIndex: number;
}

class InvalidProviderResultError extends Error {}

async function normalizeArtifacts(artifacts: ProviderArtifact[]): Promise<NormalizedArtifact[]> {
  if (!Array.isArray(artifacts)) throw new InvalidProviderResultError("Provider result is not an artifact list.");
  const byIndex = new Map<number, { artifact: NormalizedArtifact; checksum: string; sizeBytes: number }>();
  for (let arrayIndex = 0; arrayIndex < artifacts.length; arrayIndex += 1) {
    const artifact = artifacts[arrayIndex];
    if (!artifact || typeof artifact.sourcePath !== "string" || typeof artifact.fileName !== "string") {
      throw new InvalidProviderResultError(`Provider artifact ${arrayIndex} is missing its path or filename.`);
    }
    const outputIndex = artifact.outputIndex ?? arrayIndex;
    if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
      throw new InvalidProviderResultError(`Provider artifact ${arrayIndex} has an invalid output index.`);
    }
    let fileStat;
    let checksum: string;
    try {
      fileStat = await stat(artifact.sourcePath);
      if (!fileStat.isFile() || fileStat.size <= 0) {
        throw new Error("Artifact is not a non-empty regular file.");
      }
      checksum = await hashFileSha256(artifact.sourcePath);
    } catch (error) {
      throw new Error(`Provider artifact is unavailable: ${errorMessage(error)}`);
    }
    const normalized: NormalizedArtifact = { ...artifact, outputIndex };
    const existing = byIndex.get(outputIndex);
    if (existing) {
      if (existing.checksum !== checksum || existing.sizeBytes !== fileStat.size) {
        throw new InvalidProviderResultError(`Provider returned conflicting bytes for duplicate output index ${outputIndex}.`);
      }
      continue;
    }
    byIndex.set(outputIndex, { artifact: normalized, checksum, sizeBytes: fileStat.size });
  }
  return [...byIndex.values()].map(({ artifact }) => artifact).sort((a, b) => a.outputIndex - b.outputIndex);
}

function toProviderRequest(job: GenerationJob, attempt: ClaimedGeneration["attempt"]): GenerationProviderRequest {
  if (!job.request.sceneVersionId) throw new Error(`Generation job ${job.id} is missing a pinned scene version.`);
  return {
    ...job.request,
    sceneVersionId: job.request.sceneVersionId,
    jobId: job.id,
    logicalIdempotencyKey: job.idempotencyKey,
    providerRequestKey: attempt.providerRequestKey,
    attemptNumber: attempt.attemptNumber,
  };
}

function stableId(prefix: string, jobId: string, outputIndex: number): string {
  const hash = createHash("sha256").update(`${jobId}:${outputIndex}`).digest("hex").slice(0, 32);
  return `${prefix}-${hash}`;
}

function normalizeMimeType(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  return normalized || undefined;
}

function mimeTypeForFile(fileName: string): string {
  switch (fileName.slice(fileName.lastIndexOf(".")).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".wav": return "audio/wav";
    case ".mp3": return "audio/mpeg";
    case ".ogg": return "audio/ogg";
    default: return "application/octet-stream";
  }
}

function assetKind(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  return "BINARY";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
