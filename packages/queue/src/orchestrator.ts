import type { JobStatus } from "@flowforge/core";
import type { EventPublisher } from "@flowforge/events";
import { SqliteJobRepository } from "@flowforge/storage";
import {
  ProviderCompletionWorker,
  ProviderDownloadWorker,
  ProviderExecutionWorker,
  ProviderResolver,
  ProviderValidationWorker,
  ResumableGenerationWorker,
  SqliteJobQueue,
} from "./index.js";

export interface GenerationOrchestratorResult {
  jobId: string;
  status: JobStatus;
  mode: "fresh" | "resume";
}

export class GenerationOrchestrator {
  constructor(
    private readonly repository: SqliteJobRepository,
    private readonly queue: SqliteJobQueue,
    private readonly resolveProvider: ProviderResolver,
    private readonly events?: EventPublisher,
  ) {}

  async runOnce(jobId: string): Promise<GenerationOrchestratorResult | null> {
    const initial = this.repository.get(jobId);
    if (!initial) throw new Error(`Generation job not found: ${jobId}`);

    if (initial.status === "CANCELLED") {
      return { jobId, status: "CANCELLED", mode: "resume" };
    }

    if (initial.status === "COMPLETED") {
      return { jobId, status: "COMPLETED", mode: "resume" };
    }

    const mode: "fresh" | "resume" =
      initial.status === "GENERATING" ||
      initial.status === "VERIFYING" ||
      initial.status === "DOWNLOADING" ||
      initial.status === "VALIDATING"
        ? "resume"
        : "fresh";

    if (mode === "fresh") {
      const execution = await new ProviderExecutionWorker(
        this.repository,
        this.queue,
        this.resolveProvider,
        this.events,
      ).runOnce();

      if (!execution || execution.jobId !== jobId) {
        const current = this.repository.get(jobId);
        return current ? { jobId, status: current.status, mode } : null;
      }
    } else {
      const resumed = await new ResumableGenerationWorker(
        this.repository,
        this.resolveProvider,
        this.events,
      ).resumeOnce(jobId);

      if (!resumed) {
        const current = this.repository.get(jobId);
        return current ? { jobId, status: current.status, mode } : null;
      }

      if (resumed.status === "COMPLETED") {
        return { jobId, status: "COMPLETED", mode };
      }

      if (resumed.status === "VERIFYING" || resumed.status === "VALIDATING") {
        return await this.finishFromIntermediate(jobId, mode, resumed.status);
      }

      return { jobId, status: resumed.status, mode };
    }

    const generated = this.repository.get(jobId);
    if (!generated || generated.status !== "GENERATING") {
      return generated ? { jobId, status: generated.status, mode } : null;
    }

    const completion = await new ProviderCompletionWorker(
      this.repository,
      this.resolveProvider,
      this.events,
    ).runOnce(jobId);

    if (!completion) {
      const current = this.repository.get(jobId);
      return current ? { jobId, status: current.status, mode } : null;
    }

    const downloaded = await new ProviderDownloadWorker(
      this.repository,
      this.resolveProvider,
      this.events,
    ).runOnce(jobId, completion.result);

    if (!downloaded) {
      const current = this.repository.get(jobId);
      return current ? { jobId, status: current.status, mode } : null;
    }

    return this.validate(jobId, mode, downloaded.assets);
  }

  private async finishFromIntermediate(
    jobId: string,
    mode: "fresh" | "resume",
    status: JobStatus,
  ): Promise<GenerationOrchestratorResult> {
    if (status === "VERIFYING") {
      const job = this.repository.get(jobId)!;
      const provider = this.resolveProvider(job.request.provider);
      if (!provider) {
        const reason = `Provider not registered: ${job.request.provider}`;
        this.repository.transition(jobId, "FAILED", reason);
        this.events?.publish({
          type: "generation.failed",
          at: new Date().toISOString(),
          jobId,
          reason,
        });
        return { jobId, status: "FAILED", mode };
      }
      if (!job.externalId) throw new Error(`Generation job ${jobId} has no externalId`);

      try {
        const result = await provider.waitForCompletion(job.externalId);
        if (result.jobId !== jobId || result.provider !== provider.id) {
          throw new Error(`Provider completion result does not match job ${jobId}`);
        }
        const downloaded = await new ProviderDownloadWorker(
          this.repository,
          this.resolveProvider,
          this.events,
        ).runOnce(jobId, result);
        if (!downloaded) {
          const current = this.repository.get(jobId)!;
          return { jobId, status: current.status, mode };
        }
        return this.validate(jobId, mode, downloaded.assets);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.repository.get(jobId);
        if (current && current.status !== "FAILED") {
          this.repository.transition(jobId, "FAILED", message);
          this.events?.publish({
            type: "generation.failed",
            at: new Date().toISOString(),
            jobId,
            reason: message,
          });
        }
        return { jobId, status: "FAILED", mode };
      }
    }

    const assets = this.repository
      .listProjectAssets(this.repository.get(jobId)!.request.projectId)
      .filter((asset) => asset.jobId === jobId)
      .map((asset) => asset.path);

    return this.validate(jobId, mode, assets);
  }

  private async validate(
    jobId: string,
    mode: "fresh" | "resume",
    assets: string[],
  ): Promise<GenerationOrchestratorResult> {
    const validated = await new ProviderValidationWorker(
      this.repository,
      this.resolveProvider,
      this.events,
    ).runOnce(jobId, assets);

    const current = this.repository.get(jobId);
    return {
      jobId,
      status: validated?.status ?? current?.status ?? "FAILED",
      mode,
    };
  }
}
