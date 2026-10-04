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
