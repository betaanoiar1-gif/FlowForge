import type { JobStatus } from "@flowforge/core";
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
