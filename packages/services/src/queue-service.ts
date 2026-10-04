import { ApplicationError } from "./errors.js";
import { integerRange } from "./validation.js";
import type { RunWorkerCommand } from "./commands.js";
import type { ExecutionResult, QueueStatus, RecoveryResult } from "./read-models.js";
import { queueStatus as projectQueueStatus } from "./projections.js";
import type { ServiceDeps } from "./deps.js";
import type { WorkerResult } from "@flowforge/queue";

/**
 * Queue visibility plus durable-worker execution.
 *
 * This service never claims work, extends a lease, schedules a retry, or recovers an attempt by
 * itself: it drives `LocalQueueWorker` and `SqliteJobQueue`, which own those transitions. The one
 * rule it adds is the provider-coverage guard below, which protects durable state from an
 * operator mistake rather than working around it.
 */
export class QueueService {
  constructor(private readonly deps: ServiceDeps) {}

  status(): QueueStatus {
    return projectQueueStatus(this.deps.repository, {
      workerId: this.deps.worker?.workerId,
      providerId: this.deps.workerProviderId,
      providers: this.deps.providers,
      nowMs: this.deps.now().getTime(),
    });
  }

  /** Claims and processes at most one queued job, then returns the durable result. */
  async runOnce(): Promise<ExecutionResult> {
    return this.drain({ maxJobs: 1 });
  }

  /** Runs the durable worker until the queue is idle or `maxJobs` jobs have been attempted. */
  async drain(input: RunWorkerCommand = {}): Promise<ExecutionResult> {
    const worker = this.requireWorker();
    const maxJobs = integerRange(input.maxJobs, "maxJobs", { min: 1, max: 10_000, fallback: 100 });
    if (input.ignoreProviderCoverage !== true) this.assertProviderCoverage();
    const results = await worker.runUntilIdle(maxJobs);
    return {
      workerId: worker.workerId,
      attempted: results.length,
      results: results.map(toExecutionRow),
      after: this.status(),
    };
  }

  /**
   * Invokes the existing expired-lease recovery path and reports what it changed. Recovery
   * semantics (including the uncertain-submission rule) stay in the storage layer.
   */
  recoverLeases(): RecoveryResult {
    if (!this.deps.queue) {
      throw new ApplicationError("WORKER_NOT_CONFIGURED", "No durable queue is wired into this application.", {
        command: "recoverLeases",
      });
    }
    const recoveredLeases = this.deps.queue.recoverExpiredLeases(this.deps.now().toISOString());
    return { recoveredLeases, after: this.status() };
  }

  /**
   * Refuses to run work whose provider this process cannot serve. Without the guard the durable
   * worker would permanently fail each mismatched job (`PROVIDER_MISMATCH` is non-retryable),
   * so a mixed queue must be handled deliberately instead of incidentally.
   */
  assertProviderCoverage(): void {
    const coverage = this.coveredProviders();
    const uncovered = new Map<string, number>();
    for (const item of this.deps.repository.listQueueItems({ statuses: ["QUEUED"] })) {
      const job = this.deps.repository.getGenerationJob(item.generationJobId);
      if (!job || coverage.has(job.request.provider)) continue;
      uncovered.set(job.request.provider, (uncovered.get(job.request.provider) ?? 0) + 1);
    }
    if (uncovered.size > 0) {
      throw new ApplicationError(
        "PROVIDER_COVERAGE_INCOMPLETE",
        `Queued work exists for provider(s) this worker cannot serve: ${[...uncovered.keys()].join(", ")}. Running it now would fail those jobs permanently.`,
        {
          uncovered: Object.fromEntries(uncovered),
          servedProviders: [...coverage],
          hint: "Run the worker with the matching provider, or pass --ignore-provider-coverage after reviewing the queue.",
        },
      );
    }
  }

  private coveredProviders(): ReadonlySet<string> {
    if (this.deps.workerProviderId) return new Set([this.deps.workerProviderId]);
    return new Set(this.deps.providers.keys());
  }

  private requireWorker() {
    const worker = this.deps.worker;
    if (!worker) {
      throw new ApplicationError(
        "WORKER_NOT_CONFIGURED",
        "No durable worker is wired into this application, so queued work cannot be executed here.",
        { hint: "Construct the application with a LocalQueueWorker and its provider." },
      );
    }
    return worker;
  }
}

function toExecutionRow(result: WorkerResult): ExecutionResult["results"][number] {
  return {
    jobId: result.jobId,
    status: result.status,
    attemptNumber: result.attemptNumber,
    assetVersionId: result.assetVersionId,
    qcStatus: result.qcStatus,
    error: result.error,
  };
}
