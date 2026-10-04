import type { JobStatus, ProviderAdapter } from "@flowforge/core";
import type { EventPublisher } from "@flowforge/events";
import { SqliteJobRepository, type QueueEntry } from "@flowforge/storage";

export { type QueueEntry };

export class SqliteJobQueue {
  constructor(private readonly repository: SqliteJobRepository) {}

  enqueue(jobId: string): QueueEntry {
    return this.repository.enqueue(jobId);
  }

  dequeue(): QueueEntry | null {
    return this.repository.dequeue();
  }

  size(): number {
    return this.repository.queueSize();
  }

  has(jobId: string): boolean {
    return this.repository.hasQueueEntry(jobId);
  }
}

export interface WorkerResult {
  jobId: string;
  status: JobStatus;
}

export class LocalQueueWorker {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly queue: SqliteJobQueue,
  ) {}

  runOnce(): WorkerResult | null {
    const entry = this.queue.dequeue();

    if (!entry) return null;

    const job = this.repository.get(entry.jobId);

    if (!job) {
      throw new Error(`Queued job disappeared: ${entry.jobId}`);
    }

    if (job.status === "CREATED" || job.status === "FAILED") {
      const updated = this.repository.transition(job.id, "PREPARING");

      return {
        jobId: updated.id,
        status: updated.status,
      };
    }

    throw new Error(
      `Worker cannot start job ${job.id} from ${job.status}`,
    );
  }
}

export type ProviderResolver = (
  providerId: string,
) => ProviderAdapter | undefined;

export interface ProviderExecutionResult {
  jobId: string;
  status: JobStatus;
  externalId: string;
}

export class ProviderExecutionWorker {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly queue: SqliteJobQueue,
    private readonly resolveProvider: ProviderResolver,
    private readonly events?: EventPublisher,
  ) {}

  async runOnce(): Promise<ProviderExecutionResult | null> {
    const entry = this.queue.dequeue();

    if (!entry) return null;

    const job = this.repository.get(entry.jobId);

    if (!job) {
      throw new Error(`Queued job disappeared: ${entry.jobId}`);
    }

    if (job.status !== "CREATED" && job.status !== "FAILED") {
      throw new Error(
        `Execution worker cannot start job ${job.id} from ${job.status}`,
      );
    }

    if (job.status === "FAILED" && job.externalId) {
      throw new Error(
        `Execution worker refuses to resubmit failed job ${job.id} with externalId ${job.externalId}`,
      );
    }

    this.events?.publish({ type: "generation.created", at: new Date().toISOString(), jobId: job.id });

    const provider = this.resolveProvider(job.request.provider);

    if (!provider) {
      this.repository.transition(
        job.id,
        "FAILED",
        `Provider not registered: ${job.request.provider}`,
      );
      return null;
    }

    try {
      this.repository.transition(job.id, "PREPARING");
      this.events?.publish({ type: "generation.preparing", at: new Date().toISOString(), jobId: job.id });
      await provider.connect();

      this.repository.transition(job.id, "SUBMITTING");
      this.events?.publish({ type: "generation.submitting", at: new Date().toISOString(), jobId: job.id });
      const submission = await provider.submit(job.request);

      if (!submission.externalId) {
        throw new Error(
          `Provider ${provider.id} returned no externalId for job ${job.id}`,
        );
      }

      this.repository.setExternalId(job.id, submission.externalId);
      const updated = this.repository.transition(job.id, "GENERATING");
      this.events?.publish({ type: "generation.generating", at: new Date().toISOString(), jobId: job.id, externalId: submission.externalId });

      return {
        jobId: updated.id,
        status: updated.status,
        externalId: submission.externalId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.repository.get(job.id);

      if (current && current.status !== "FAILED") {
        this.repository.transition(job.id, "FAILED", message);
        this.events?.publish({ type: "generation.failed", at: new Date().toISOString(), jobId: job.id, reason: message });
      }

      return null;
    } finally {
      await provider.disconnect().catch(() => undefined);
    }
  }
}

export interface ProviderCompletionResult {
  jobId: string;
  status: JobStatus;
  externalId: string;
  result: Awaited<ReturnType<ProviderAdapter["waitForCompletion"]>>;
}

export class ProviderCompletionWorker {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly resolveProvider: ProviderResolver,
    private readonly events?: EventPublisher,
  ) {}

  async runOnce(jobId: string): Promise<ProviderCompletionResult | null> {
    const job = this.repository.get(jobId);

    if (!job) {
      throw new Error(`Generation job not found: ${jobId}`);
    }

    if (job.status !== "GENERATING") {
      throw new Error(
        `Completion worker cannot start job ${job.id} from ${job.status}`,
      );
    }

    if (!job.externalId) {
      throw new Error(`Generation job ${job.id} has no externalId`);
    }

    const provider = this.resolveProvider(job.request.provider);

    if (!provider) {
      const reason = `Provider not registered: ${job.request.provider}`;
      this.repository.transition(job.id, "FAILED", reason);
      this.events?.publish({
        type: "generation.failed",
        at: new Date().toISOString(),
        jobId: job.id,
        reason,
      });
      return null;
    }

    try {
      const result = await provider.waitForCompletion(job.externalId);

      if (result.jobId !== job.id) {
        throw new Error(
          `Provider result jobId mismatch: expected ${job.id}, got ${result.jobId}`,
        );
      }

      if (result.provider !== provider.id) {
        throw new Error(
          `Provider result provider mismatch: expected ${provider.id}, got ${result.provider}`,
        );
      }

      const updated = this.repository.transition(job.id, "VERIFYING");
      this.events?.publish({
        type: "generation.verifying",
        at: new Date().toISOString(),
        jobId: job.id,
        externalId: job.externalId,
      });

      return {
        jobId: updated.id,
        status: updated.status,
        externalId: job.externalId,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.repository.get(job.id);

      if (current && current.status !== "FAILED") {
        this.repository.transition(job.id, "FAILED", message);
        this.events?.publish({
          type: "generation.failed",
          at: new Date().toISOString(),
          jobId: job.id,
          reason: message,
        });
      }

      return null;
    }
  }
}

export interface ProviderDownloadResult {
  jobId: string;
  status: JobStatus;
  assets: string[];
}

export class ProviderDownloadWorker {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly resolveProvider: ProviderResolver,
    private readonly events?: EventPublisher,
  ) {}

  async runOnce(
    jobId: string,
    result: Awaited<ReturnType<ProviderAdapter["waitForCompletion"]>>,
  ): Promise<ProviderDownloadResult | null> {
    const job = this.repository.get(jobId);

    if (!job) {
      throw new Error(`Generation job not found: ${jobId}`);
    }

    if (job.status !== "VERIFYING") {
      throw new Error(
        `Download worker cannot start job ${job.id} from ${job.status}`,
      );
    }

    if (!job.externalId) {
      throw new Error(`Generation job ${job.id} has no externalId`);
    }

    const provider = this.resolveProvider(job.request.provider);

    if (!provider) {
      const reason = `Provider not registered: ${job.request.provider}`;
      this.repository.transition(job.id, "FAILED", reason);
      this.events?.publish({
        type: "generation.failed",
        at: new Date().toISOString(),
        jobId: job.id,
        reason,
      });
      return null;
    }

    try {
      this.repository.transition(job.id, "DOWNLOADING");
      this.events?.publish({
        type: "generation.downloading",
        at: new Date().toISOString(),
        jobId: job.id,
        externalId: job.externalId,
      });

      const paths = await provider.download(result);

      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path.trim())) {
        throw new Error(`Provider ${provider.id} returned invalid asset paths for job ${job.id}`);
      }

      for (const path of paths) {
        const assetId = `asset_${createDeterministicAssetId(job.id, path)}`;
        if (!this.repository.getAsset(assetId)) {
          this.repository.registerAsset({
            id: assetId,
            projectId: job.request.projectId,
            sceneId: job.request.sceneId,
            jobId: job.id,
            kind: "generation-output",
            path,
            provider: provider.id,
            externalId: job.externalId,
          });
        }
      }

      const updated = this.repository.transition(job.id, "VALIDATING");
      this.events?.publish({
        type: "generation.validating",
        at: new Date().toISOString(),
        jobId: job.id,
        externalId: job.externalId,
      });

      return {
        jobId: updated.id,
        status: updated.status,
        assets: paths,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.repository.get(job.id);

      if (current && current.status !== "FAILED") {
        this.repository.transition(job.id, "FAILED", message);
        this.events?.publish({
          type: "generation.failed",
          at: new Date().toISOString(),
          jobId: job.id,
          reason: message,
        });
      }

      return null;
    }
  }
}


export interface ProviderValidationResult {
  jobId: string;
  status: JobStatus;
  assets: string[];
}

export class ProviderValidationWorker {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly resolveProvider: ProviderResolver,
    private readonly events?: EventPublisher,
  ) {}

  async runOnce(jobId: string, assets: string[]): Promise<ProviderValidationResult | null> {
    const job = this.repository.get(jobId);
    if (!job) throw new Error(`Generation job not found: ${jobId}`);

    if (job.status !== "VALIDATING") {
      throw new Error(`Validation worker cannot start job ${job.id} from ${job.status}`);
    }

    if (!job.externalId) {
      throw new Error(`Generation job ${job.id} has no externalId`);
    }

    const provider = this.resolveProvider(job.request.provider);
    if (!provider) {
      const reason = `Provider not registered: ${job.request.provider}`;
      this.repository.transition(job.id, "FAILED", reason);
      this.events?.publish({ type: "generation.failed", at: new Date().toISOString(), jobId: job.id, reason });
      return null;
    }

    try {
      if (!Array.isArray(assets) || assets.length === 0 || assets.some((path) => typeof path !== "string" || !path.trim())) {
        throw new Error(`Validation failed: job ${job.id} has no valid assets`);
      }

      for (const path of assets) {
        const matches = this.repository.listProjectAssets(job.request.projectId)
          .filter((asset) => asset.jobId === job.id && asset.path === path);
        if (matches.length === 0) {
          throw new Error(`Validation failed: asset is not registered for job ${job.id}: ${path}`);
        }
      }

      const updated = this.repository.transition(job.id, "COMPLETED");
      this.events?.publish({
        type: "generation.completed",
        at: new Date().toISOString(),
        jobId: job.id,
        externalId: job.externalId,
        assets: [...assets],
      });

      return { jobId: updated.id, status: updated.status, assets: [...assets] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.repository.get(job.id);
      if (current && current.status !== "FAILED") {
        this.repository.transition(job.id, "FAILED", message);
        this.events?.publish({ type: "generation.failed", at: new Date().toISOString(), jobId: job.id, reason: message });
      }
      return null;
    }
  }
}


export class GenerationCancellationWorker {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly events?: EventPublisher,
  ) {}

  cancel(jobId: string, reason?: string): WorkerResult {
    const job = this.repository.get(jobId);
    if (!job) throw new Error(`Generation job not found: ${jobId}`);
    const updated = this.repository.cancel(jobId);
    if (updated.status === "CANCELLED" && job.status !== "CANCELLED") {
      this.events?.publish({
        type: "generation.cancelled",
        at: new Date().toISOString(),
        jobId,
        ...(reason ? { reason } : {}),
      });
    }
    return { jobId: updated.id, status: updated.status };
  }
}

export interface RecoveryResult {
  jobId: string;
  status: JobStatus;
}

export class ResumableGenerationWorker {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly resolveProvider: ProviderResolver,
    private readonly events?: EventPublisher,
  ) {}

  async resumeOnce(jobId: string): Promise<RecoveryResult | null> {
    const job = this.repository.get(jobId);
    if (!job) throw new Error(`Generation job not found: ${jobId}`);

    if (job.status === "GENERATING") {
      const worker = new ProviderCompletionWorker(this.repository, this.resolveProvider, this.events);
      const result = await worker.runOnce(jobId);
      return result ? { jobId: result.jobId, status: result.status } : null;
    }

    if (job.status === "VERIFYING") {
      const provider = this.resolveProvider(job.request.provider);
      if (!provider) {
        const reason = `Provider not registered: ${job.request.provider}`;
        this.repository.transition(job.id, "FAILED", reason);
        this.events?.publish({ type: "generation.failed", at: new Date().toISOString(), jobId: job.id, reason });
        return null;
      }
      if (!job.externalId) throw new Error(`Generation job ${job.id} has no externalId`);
      try {
        const result = await provider.waitForCompletion(job.externalId);
        if (result.jobId !== job.id || result.provider !== provider.id) {
          throw new Error(`Provider completion result does not match job ${job.id}`);
        }
        const worker = new ProviderDownloadWorker(this.repository, this.resolveProvider, this.events);
        const downloaded = await worker.runOnce(jobId, result);
        return downloaded ? { jobId: downloaded.jobId, status: downloaded.status } : null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.repository.get(job.id);
        if (current && current.status !== "FAILED") {
          this.repository.transition(job.id, "FAILED", message);
          this.events?.publish({ type: "generation.failed", at: new Date().toISOString(), jobId: job.id, reason: message });
        }
        return null;
      }
    }

    if (job.status === "DOWNLOADING") {
      const provider = this.resolveProvider(job.request.provider);
      if (!provider) {
        const reason = `Provider not registered: ${job.request.provider}`;
        this.repository.transition(job.id, "FAILED", reason);
        this.events?.publish({ type: "generation.failed", at: new Date().toISOString(), jobId: job.id, reason });
        return null;
      }
      if (!job.externalId) throw new Error(`Generation job ${job.id} has no externalId`);
      try {
        const result = await provider.waitForCompletion(job.externalId);
        if (result.jobId !== job.id || result.provider !== provider.id) {
          throw new Error(`Provider completion result does not match job ${job.id}`);
        }
        const worker = new ProviderDownloadWorker(this.repository, this.resolveProvider, this.events);
        const downloaded = await worker.runOnce(jobId, result);
        return downloaded ? { jobId: downloaded.jobId, status: downloaded.status } : null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.repository.get(job.id);
        if (current && current.status !== "FAILED") {
          this.repository.transition(job.id, "FAILED", message);
          this.events?.publish({ type: "generation.failed", at: new Date().toISOString(), jobId: job.id, reason: message });
        }
        return null;
      }
    }

    if (job.status === "VALIDATING") {
      const assets = this.repository.listProjectAssets(job.request.projectId)
        .filter((asset) => asset.jobId === job.id)
        .map((asset) => asset.path);
      const worker = new ProviderValidationWorker(this.repository, this.resolveProvider, this.events);
      const validated = await worker.runOnce(jobId, assets);
      return validated ? { jobId: validated.jobId, status: validated.status } : null;
    }

    if (job.status === "COMPLETED") {
      return { jobId: job.id, status: job.status };
    }

    throw new Error(`Job ${job.id} is not resumable from ${job.status}`);
  }
}

export interface RetryExecutionResult {
  jobId: string;
  status: JobStatus;
  retryCount: number;
  maxRetries: number;
  mode: "submit" | "resume";
}

export class GenerationRetryWorker {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly queue: SqliteJobQueue,
    private readonly resolveProvider: ProviderResolver,
    private readonly events?: EventPublisher,
  ) {}

  async retryOnce(jobId: string, maxRetries = 3): Promise<RetryExecutionResult | null> {
    const job = this.repository.get(jobId);
    if (!job) throw new Error(`Generation job not found: ${jobId}`);

    let retryState;
    try {
      retryState = this.repository.requestRetry(jobId, maxRetries);
    } catch (error) {
      const state = this.repository.getRetryState(jobId, maxRetries);
      if (state.retryCount >= state.maxRetries) {
        this.events?.publish({
          type: "generation.retry_exhausted",
          at: new Date().toISOString(),
          jobId,
          retryCount: state.retryCount,
          maxRetries: state.maxRetries,
        });
      }
      throw error;
    }

    const mode = job.externalId ? "resume" : "submit";
    this.events?.publish({
      type: "generation.retry_requested",
      at: new Date().toISOString(),
      jobId,
      retryCount: retryState.retryCount,
      maxRetries: retryState.maxRetries,
      mode,
    });

    if (mode === "resume") {
      const worker = new ResumableGenerationWorker(this.repository, this.resolveProvider, this.events);
      const result = await worker.resumeOnce(jobId);
      return result ? { ...result, retryCount: retryState.retryCount, maxRetries: retryState.maxRetries, mode } : null;
    }

    const execution = new ProviderExecutionWorker(this.repository, this.queue, this.resolveProvider, this.events);
    const result = await execution.runOnce();
    return result ? { jobId: result.jobId, status: result.status, retryCount: retryState.retryCount, maxRetries: retryState.maxRetries, mode } : null;
  }
}

function createDeterministicAssetId(jobId: string, path: string): string {
  const input = `${jobId}\\0${path}`;
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    a ^= code;
    a = Math.imul(a, 0x01000193);
    b ^= code + index;
    b = Math.imul(b, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

export * from "./orchestrator.js";
