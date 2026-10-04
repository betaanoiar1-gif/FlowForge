import type { GenerationJob, ProviderCapabilities } from "@flowforge/core";
import { ApplicationError, translateRepositoryError } from "./errors.js";
import { identifier, integerRange, isoTimestamp, metadataRecord, requiredText, LIMITS } from "./validation.js";
import { isoNow, type ServiceDeps } from "./deps.js";
import type { CancelGenerationCommand, RequestGenerationCommand, RetryGenerationCommand } from "./commands.js";
import type { CancellationResult, GenerationRequestResult, GenerationStatus } from "./read-models.js";
import { canRetryJob, generationStatus, hasUnsafeAttempt, toJobSummary } from "./projections.js";

/**
 * Turns a validated operator request into a durable, idempotent generation job and reports the
 * resulting state.
 *
 * What this service owns: input validation, referential checks (project/scene/scene-version),
 * provider capability admission, and the status projection.
 * What it deliberately does not own: the queue itself, claiming, lease renewal, retry
 * scheduling, provider selection, browser or CDP work, and asset storage. Job creation and
 * enqueueing are one atomic transaction inside `SqliteJobRepository.createGenerationJob`, so
 * there is no "enqueue" step to duplicate here, and a repeated request for the same canonical
 * identity reuses the stored job instead of queueing a second submission.
 */
export class GenerationService {
  constructor(private readonly deps: ServiceDeps) {}

  requestGeneration(input: RequestGenerationCommand): GenerationRequestResult {
    if (hasPromptOnRequest(input)) {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        "Prompts live on scene versions so they are durable and auditable; create a scene version instead of attaching a prompt to a generation request.",
        { field: "prompt" },
      );
    }
    const projectId = identifier(input.projectId, "projectId");
    const sceneId = identifier(input.sceneId, "sceneId");
    const project = this.deps.repository.getProject(projectId);
    if (!project) {
      throw new ApplicationError("NOT_FOUND", `Project not found: ${projectId}`, { projectId });
    }
    const scene = this.deps.repository.getScene(sceneId);
    if (!scene || scene.projectId !== projectId) {
      throw new ApplicationError("NOT_FOUND", `Scene ${sceneId} does not exist in project ${projectId}.`, {
        projectId,
        sceneId,
      });
    }

    const sceneVersionId = this.resolveSceneVersionId(scene, input.sceneVersionId);
    const provider = requiredText(input.provider, "provider", 64);
    const parameters = metadataRecord(input.parameters, "parameters") ?? {};
    this.assertProviderAccepts({ provider, parameters, sceneVersionId, allowUnconfigured: input.allowUnconfiguredProvider === true });

    const now = isoNow(this.deps, input.now);
    let result: { job: GenerationJob; created: boolean };
    try {
      result = this.deps.repository.createGenerationJobWithCreated({
        projectId,
        sceneId,
        sceneVersionId,
        provider,
        parameters,
        metadata: metadataRecord(input.metadata, "metadata"),
        maxAttempts: integerRange(input.maxAttempts, "maxAttempts", {
          min: 1,
          max: LIMITS.maxAttempts,
          fallback: this.deps.defaultMaxAttempts,
        }),
        priority: integerRange(input.priority, "priority", { min: -1000, max: 1000, fallback: 0 }),
        now,
      });
    } catch (error) {
      throw translateRepositoryError(error, "PERSISTENCE_REJECTED", { projectId, sceneId, sceneVersionId, provider });
    }

    return {
      job: toJobSummary(result.job),
      created: result.created,
      reusedExistingJob: !result.created,
      queue: this.deps.repository.getQueueItemByJob(result.job.id),
      status: this.status(result.job.id),
    };
  }

  status(jobIdInput: string): GenerationStatus {
    return generationStatus(this.deps.repository, this.requireJob(jobIdInput));
  }

  /** Newest-first status view of every request made against a scene. */
  statusForScene(sceneIdInput: string): GenerationStatus[] {
    const sceneId = identifier(sceneIdInput, "sceneId");
    if (!this.deps.repository.getScene(sceneId)) {
      throw new ApplicationError("NOT_FOUND", `Scene not found: ${sceneId}`, { sceneId });
    }
    return this.deps.repository
      .listGenerationJobs({ sceneId })
      .map((job) => generationStatus(this.deps.repository, job))
      .reverse();
  }

  /**
   * Local cancellation is final and is executed by the repository's transition guard. Provider
   * cancellation is only attempted through the durable worker, which owns the provider
   * instance; the service never calls a provider itself.
   */
  async cancel(input: CancelGenerationCommand): Promise<CancellationResult> {
    const job = this.requireJob(input.jobId);
    if (job.status === "CANCELLED") {
      return {
        job: toJobSummary(job),
        localCancellation: "ALREADY_TERMINAL",
        providerCancellation: "NOT_ATTEMPTED",
        providerCancellationReason: "The job was already cancelled.",
      };
    }
    if (job.status === "SUCCEEDED") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "A succeeded generation cannot be cancelled.", {
        jobId: job.id,
        status: job.status,
      });
    }

    const worker = input.localOnly === true ? undefined : this.deps.worker;
    const servedByWorker = worker !== undefined && this.deps.workerProviderId === job.request.provider;
    if (worker && servedByWorker) {
      const cancelled = await worker.cancel(job.id);
      return {
        job: toJobSummary(cancelled),
        localCancellation: "CANCELLED",
        providerCancellation: "ATTEMPTED",
        providerCancellationReason:
          "The worker attempts provider cancellation best-effort; a persisted local cancellation is not undone by it.",
      };
    }
    const cancelled = this.deps.repository.cancelGenerationJob(job.id, isoNow(this.deps, input.now));
    return {
      job: toJobSummary(cancelled),
      localCancellation: "CANCELLED",
      providerCancellation: "NOT_ATTEMPTED",
      providerCancellationReason: input.localOnly
        ? "Requested as local-only, so no provider was contacted."
        : worker
          ? `The configured worker serves provider "${this.deps.workerProviderId ?? "unknown"}", not "${job.request.provider}".`
          : "No durable worker is wired into this application, so no provider was contacted.",
    };
  }

  /**
   * Requeues a failed job through the repository guard. The guard, not this service, decides
   * safety; the service pre-checks the same conditions only to report a typed code and to make
   * the uncertainty rule visible to operators before anything is written.
   */
  retry(input: RetryGenerationCommand): { job: GenerationRequestResult["job"]; status: GenerationStatus } {
    const job = this.requireJob(input.jobId);
    const unsafeState = hasUnsafeAttempt(this.deps.repository, job.id);
    const verdict = canRetryJob(job, unsafeState);
    if (!verdict.allowed) {
      throw new ApplicationError(
        unsafeState ? "RETRY_BLOCKED_UNSAFE_STATE" : "RETRY_NOT_ALLOWED",
        verdict.reason,
        { jobId: job.id, status: job.status, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts },
      );
    }
    const availableAt = isoTimestamp(input.availableAt, "availableAt") ?? isoNow(this.deps, input.now);
    let retried: GenerationJob;
    try {
      retried = this.deps.repository.retryFailedJob(job.id, availableAt);
    } catch (error) {
      throw translateRepositoryError(error, "RETRY_NOT_ALLOWED", { jobId: job.id });
    }
    return { job: toJobSummary(retried), status: this.status(retried.id) };
  }

  private resolveSceneVersionId(scene: { id: string; currentVersionId?: string }, requested?: string): string {
    if (requested !== undefined) return identifier(requested, "sceneVersionId");
    if (!scene.currentVersionId) {
      throw new ApplicationError(
        "VALIDATION_FAILED",
        `Scene ${scene.id} has no current scene version. Create a scene version before requesting generation.`,
        { sceneId: scene.id, field: "sceneVersionId" },
      );
    }
    return scene.currentVersionId;
  }

  private assertProviderAccepts(options: {
    provider: string;
    parameters: Record<string, unknown>;
    sceneVersionId: string;
    allowUnconfigured: boolean;
  }): void {
    const descriptor = this.deps.providers.get(options.provider);
    if (!descriptor) {
      if (options.allowUnconfigured) return;
      throw new ApplicationError(
        "PROVIDER_NOT_CONFIGURED",
        `No provider named "${options.provider}" is registered in this process. Registered: ${
          [...this.deps.providers.keys()].join(", ") || "none"
        }.`,
        {
          provider: options.provider,
          configuredProviders: [...this.deps.providers.keys()],
          hint: "Pass --allow-unconfigured-provider to queue work for a provider that will be run elsewhere.",
        },
      );
    }
    const capabilities = descriptor.capabilities;
    const version = this.deps.repository.getSceneVersion(options.sceneVersionId);
    const reject = (reason: string, capability: keyof ProviderCapabilities): never => {
      throw new ApplicationError("PROVIDER_UNSUPPORTED_REQUEST", `Provider "${options.provider}" cannot ${reason}.`, {
        provider: options.provider,
        capability,
        sceneVersionId: version?.id,
      });
    };

    const mode = options.parameters.mode;
    if (mode !== undefined && mode !== "image" && mode !== "video") {
      throw new ApplicationError("VALIDATION_FAILED", 'parameters.mode must be "image" or "video".', {
        field: "parameters.mode",
      });
    }
    if (mode === "video" && !capabilities.videoGeneration) reject("generate video", "videoGeneration");
    if (!capabilities.imageGeneration) reject("generate images", "imageGeneration");

    const outputCount = options.parameters.outputCount;
    if (typeof outputCount === "number" && outputCount > 1 && !capabilities.batchGeneration) {
      reject(`produce ${outputCount} outputs in one request (batch generation)`, "batchGeneration");
    }
    if (options.parameters.startFrame !== undefined) reject("use a start frame", "startFrame");
    if (options.parameters.endFrame !== undefined) reject("use an end frame", "endFrame");
    if ((version?.references.length ?? 0) > 0 && !capabilities.referenceImages) {
      reject("accept reference images", "referenceImages");
    }
  }

  private requireJob(jobIdInput: string): GenerationJob {
    const jobId = identifier(jobIdInput, "jobId");
    const job = this.deps.repository.getGenerationJob(jobId);
    if (!job) {
      throw new ApplicationError("NOT_FOUND", `Generation job not found: ${jobId}`, { jobId });
    }
    return job;
  }
}

function hasPromptOnRequest(input: RequestGenerationCommand): boolean {
  return Object.prototype.hasOwnProperty.call(input, "prompt") && (input as { prompt?: unknown }).prompt !== undefined;
}
