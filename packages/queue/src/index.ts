import type { JobStatus, ProviderAdapter } from "@flowforge/core";
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
      await provider.connect();

      this.repository.transition(job.id, "SUBMITTING");
      const submission = await provider.submit(job.request);

      if (!submission.externalId) {
        throw new Error(
          `Provider ${provider.id} returned no externalId for job ${job.id}`,
        );
      }

      this.repository.setExternalId(job.id, submission.externalId);
      const updated = this.repository.transition(job.id, "GENERATING");

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
      }

      return null;
    } finally {
      await provider.disconnect().catch(() => undefined);
    }
  }
}
