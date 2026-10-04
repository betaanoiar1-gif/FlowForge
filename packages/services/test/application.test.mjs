import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSystemAssetStore } from "@flowforge/assets";
import { MockGenerationProvider } from "@flowforge/provider-mock";
import { LocalQueueWorker, SqliteJobQueue } from "@flowforge/queue";
import { SqliteJobRepository } from "@flowforge/storage";
import {
  GenerationService,
  ReviewService,
  canRetryJob,
  createApplication,
  hasUnsafeAttempt,
} from "../dist/index.js";

const FIXED_TIME = "2026-01-01T00:00:00.000Z";
const PROMPT = "A lantern lights a dark stairwell at dusk.";

/**
 * The services are exercised against the real durable stack (SQLite repository, durable queue,
 * local worker, deterministic mock provider) so every assertion is about orchestration of the
 * existing engine rather than a mocked approximation of it.
 */
async function createHarness(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-services-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const queue = new SqliteJobQueue(repository);
  const provider = new MockGenerationProvider({
    rootDir: path.join(directory, "mock-provider"),
    mode: options.mode,
    artifact: options.artifact,
    failAttempts: options.failAttempts,
  });
  const worker = new LocalQueueWorker(repository, queue, provider, new FileSystemAssetStore(path.join(directory, "assets")), {
    workerId: options.workerId ?? "services-test-worker",
    leaseMs: options.leaseMs ?? 60_000,
    retryDelayMs: 0,
    maxRecoveries: options.maxRecoveries ?? 5,
    now: () => new Date(FIXED_TIME),
  });
  const app = createApplication(repository, {
    queue,
    worker: options.worker === false ? undefined : worker,
    workerProviderId: options.worker === false ? undefined : "mock",
    providers: options.providers ?? [provider],
    now: () => new Date(FIXED_TIME),
    defaultMaxAttempts: options.defaultMaxAttempts,
  });

  const project = app.projects.createProject({ projectId: "pilot", name: "Pilot", description: "One-scene pilot" });
  const scene = app.scenes.createScene({ projectId: "pilot", sceneId: "scene-1", title: "Opening shot" });
  const version = app.scenes.addSceneVersion({ sceneId: "scene-1", prompt: PROMPT, references: options.references });
  const request = options.skipRequest
    ? null
    : app.generation.requestGeneration({ projectId: "pilot", sceneId: "scene-1", provider: options.provider ?? "mock" });

  return {
    directory,
    repository,
    queue,
    provider,
    worker,
    app,
    project,
    scene,
    version,
    request,
    async close() {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function drainToSuccess(harness) {
  const execution = await harness.app.execution.drain();
  assert.equal(execution.results[0].status, "SUCCEEDED");
  return execution;
}

function outputIdOf(harness) {
  const [output] = harness.app.generation.status(harness.request.job.id).outputs;
  assert.ok(output, "expected one persisted output");
  return output.assetVersionId;
}

test("the service layer drives the full chain from request to production-ready scene", async () => {
  const harness = await createHarness();
  try {
    assert.equal(harness.request.created, true);
    assert.equal(harness.request.reusedExistingJob, false);
    assert.equal(harness.request.job.status, "QUEUED");
    assert.equal(harness.request.queue.status, "QUEUED");
    assert.equal(harness.request.status.nextAction, "AWAIT_WORKER");
    assert.equal(harness.request.status.request.promptPreview, PROMPT);

    const beforeRun = harness.app.production.readiness(harness.scene.id);
    assert.deepEqual(
      beforeRun.blockers.map((blocker) => blocker.code).sort(),
      ["GENERATION_IN_PROGRESS", "NO_SELECTED_ASSET_VERSION", "NO_SUCCEEDED_OUTPUT_FOR_VERSION"],
    );
    assert.throws(
      () => harness.app.production.markReady(harness.scene.id),
      (error) => error.code === "READINESS_NOT_SATISFIED" && error.details.blockers.length === 3,
    );

    const execution = await drainToSuccess(harness);
    assert.equal(execution.attempted, 1);
    assert.equal(execution.workerId, "services-test-worker");
    assert.equal(execution.after.depth.acked, 1);
    assert.equal(execution.after.depth.claimableNow, 0);

    const status = harness.app.generation.status(harness.request.job.id);
    assert.equal(status.job.status, "SUCCEEDED");
    assert.equal(status.attempts.length, 1);
    assert.equal(status.attempts[0].status, "SUCCEEDED");
    assert.equal(status.outputs.length, 1);
    assert.equal(status.outputs[0].qc.status, "PASSED");
    assert.equal(status.outputs[0].review.status, "PENDING");
    assert.equal(status.nextAction, "AWAIT_HUMAN_REVIEW");

    assert.deepEqual(
      harness.app.production.readiness(harness.scene.id).blockers.map((blocker) => blocker.code),
      ["NO_SELECTED_ASSET_VERSION"],
    );

    const pending = harness.app.reviews.listPending({ projectId: "pilot" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sceneTitle, "Opening shot");
    assert.equal(pending[0].qcStatus, "PASSED");

    const assetVersionId = outputIdOf(harness);
    const decision = harness.app.reviews.decide({
      assetVersionId,
      decision: "APPROVED",
      reviewer: "mina",
      comment: "Approved for the pilot.",
    });
    assert.equal(decision.review.status, "APPROVED");
    assert.equal(decision.idempotent, false);
    assert.equal(harness.app.reviews.listPending({ projectId: "pilot" }).length, 0);

    assert.equal(harness.app.generation.status(harness.request.job.id).nextAction, "SELECT_APPROVED_VERSION");

    const selection = harness.app.reviews.select({ sceneId: harness.scene.id, assetVersionId });
    assert.equal(selection.scene.selectedAssetVersionId, assetVersionId);
    assert.equal(selection.scene.currentVersionId, harness.version.id);
    assert.equal(selection.readiness.productionReady, true);

    const ready = harness.app.production.markReady(harness.scene.id);
    assert.equal(ready.sceneStatus, "READY");
    assert.equal(ready.productionReady, true);
    assert.equal(harness.app.generation.status(harness.request.job.id).nextAction, "PRODUCTION_READY");
    assert.equal(harness.app.production.markReady(harness.scene.id).productionReady, true, "markReady is idempotent");

    const summary = harness.app.production.projectSummary("pilot");
    assert.equal(summary.productionReady, true);
    assert.deepEqual(summary.blockingReasons, []);
    assert.equal(summary.counts.ready, 1);
    assert.equal(summary.scenes[0].checksum, selection.assetVersion.checksum);
  } finally {
    await harness.close();
  }
});

test("detail read models keep the canonical prompt while list projections omit long text", async () => {
  const harness = await createHarness();
  try {
    const overview = harness.app.projects.overview("pilot");
    assert.equal(overview.totals.scenes, 1);
    assert.equal(overview.totals.jobs, 1);
    assert.equal(overview.totals.jobsByStatus.QUEUED, 1);
    assert.equal(overview.scenes[0].title, "Opening shot");
    assert.ok(!JSON.stringify(overview).includes(PROMPT), "list projections must not embed prompt text");

    const detail = harness.app.scenes.detail("scene-1");
    assert.equal(detail.versions.length, 1);
    assert.equal(detail.versions[0].prompt, PROMPT);
    assert.equal(detail.versions[0].isCurrent, true);
    assert.equal(detail.jobs[0].id, harness.request.job.id);
    assert.equal(JSON.parse(JSON.stringify(detail)).scene.id, "scene-1", "read models are JSON-safe");
  } finally {
    await harness.close();
  }
});

test("an identical request reuses the durable job and never double-enqueues", async () => {
  const harness = await createHarness();
  try {
    const repeat = harness.app.generation.requestGeneration({
      projectId: "pilot",
      sceneId: "scene-1",
      sceneVersionId: harness.version.id,
      provider: "mock",
    });
    assert.equal(repeat.job.id, harness.request.job.id);
    assert.equal(repeat.created, false);
    assert.equal(repeat.reusedExistingJob, true);
    assert.equal(harness.repository.countGenerationJobs(), 1);
    assert.equal(harness.repository.queueSize(), 1);

    const changedPrompt = harness.app.scenes.addSceneVersion({ sceneId: "scene-1", prompt: "Second take: the lantern flickers." });
    const second = harness.app.generation.requestGeneration({ projectId: "pilot", sceneId: "scene-1", provider: "mock" });
    assert.notEqual(second.job.id, harness.request.job.id);
    assert.equal(second.created, true);
    assert.equal(second.job.sceneVersionId, changedPrompt.id);
    assert.equal(harness.repository.queueSize(), 2, "each distinct request enqueues exactly one item");
    assert.equal(harness.app.generation.statusForScene("scene-1").length, 2);
  } finally {
    await harness.close();
  }
});

test("requests are refused before anything is written when identity or scope is wrong", async () => {
  const harness = await createHarness();
  try {
    assert.throws(
      () => harness.app.generation.requestGeneration({ projectId: "nope", sceneId: "scene-1", provider: "mock" }),
      (error) => error.code === "NOT_FOUND" && error.details.projectId === "nope",
    );
    assert.throws(
      () => harness.app.generation.requestGeneration({ projectId: "pilot", sceneId: "scene-elsewhere", provider: "mock" }),
      (error) => error.code === "NOT_FOUND",
    );
    assert.throws(
      () => harness.app.generation.requestGeneration({ projectId: "pilot", sceneId: "scene-1", provider: "mock", prompt: "inline" }),
      (error) => error.code === "VALIDATION_FAILED" && /scene versions/.test(error.message),
    );
    assert.throws(
      () => harness.app.generation.requestGeneration({ projectId: "pilot", sceneId: "scene-1", provider: "mock", maxAttempts: 0 }),
      (error) => error.code === "VALIDATION_FAILED" && error.details.field === "maxAttempts",
    );
    assert.throws(
      () => harness.app.generation.requestGeneration({ projectId: "pilot", sceneId: "scene-1", provider: "other" }),
      (error) => error.code === "PROVIDER_NOT_CONFIGURED" && error.details.configuredProviders.includes("mock"),
    );
    assert.equal(harness.repository.countGenerationJobs(), 1, "no rejected command created a job");

    const tolerant = harness.app.generation.requestGeneration({
      projectId: "pilot",
      sceneId: "scene-1",
      provider: "other",
      allowUnconfiguredProvider: true,
    });
    assert.equal(tolerant.created, true);
    assert.equal(tolerant.job.provider, "other");
  } finally {
    await harness.close();
  }
});

test("a scene without a current version cannot be generated, and versions are immutable snapshots", async () => {
  const harness = await createHarness({ skipRequest: true });
  try {
    const empty = harness.app.scenes.createScene({ projectId: "pilot", title: "Unwritten scene" });
    assert.throws(
      () => harness.app.generation.requestGeneration({ projectId: "pilot", sceneId: empty.id, provider: "mock" }),
      (error) => error.code === "VALIDATION_FAILED" && error.details.field === "sceneVersionId",
    );
    assert.equal(harness.app.scenes.getCurrentVersion(empty.id), null);
    assert.equal(harness.app.production.readiness(empty.id).blockers[0].code, "NO_CURRENT_SCENE_VERSION");

    const first = harness.app.scenes.addSceneVersion({ sceneId: empty.id, prompt: "First wording." });
    const second = harness.app.scenes.addSceneVersion({ sceneId: empty.id, prompt: "Second wording." });
    assert.equal(harness.app.scenes.getScene(empty.id).currentVersionId, second.id);
    assert.deepEqual(
      harness.app.scenes.listSceneVersions(empty.id).map((entry) => [entry.versionNumber, entry.isCurrent]),
      [[1, false], [2, true]],
    );
    harness.app.scenes.setCurrentVersion({ sceneId: empty.id, sceneVersionId: first.id });
    assert.equal(harness.app.scenes.getScene(empty.id).currentVersionId, first.id);
    assert.throws(
      () => harness.app.scenes.setCurrentVersion({ sceneId: empty.id, sceneVersionId: "unrelated" }),
      (error) => error.code === "NOT_FOUND",
    );
    assert.throws(
      () => harness.app.scenes.addSceneVersion({ sceneId: empty.id, prompt: "   " }),
      (error) => error.code === "VALIDATION_FAILED",
    );
    assert.equal(harness.repository.getSceneVersion(first.id).prompt, "First wording.", "prior versions stay intact");
  } finally {
    await harness.close();
  }
});

test("provider capabilities are checked at admission so impossible work is never queued", async () => {
  const narrow = {
    id: "narrow",
    capabilities: {
      imageGeneration: true,
      videoGeneration: false,
      referenceImages: false,
      startFrame: false,
      endFrame: false,
      batchGeneration: false,
    },
  };
  const harness = await createHarness({ skipRequest: true, providers: [narrow] });
  try {
    const base = { projectId: "pilot", sceneId: "scene-1", provider: "narrow" };
    harness.app.scenes.addSceneVersion({ sceneId: "scene-1", prompt: PROMPT });
    assert.equal(harness.app.generation.requestGeneration(base).created, true);

    assert.throws(
      () => harness.app.generation.requestGeneration({ ...base, parameters: { mode: "video" } }),
      (error) => error.code === "PROVIDER_UNSUPPORTED_REQUEST" && error.details.capability === "videoGeneration",
    );
    assert.throws(
      () => harness.app.generation.requestGeneration({ ...base, parameters: { outputCount: 3 } }),
      (error) => error.code === "PROVIDER_UNSUPPORTED_REQUEST" && error.details.capability === "batchGeneration",
    );
    assert.throws(
      () => harness.app.generation.requestGeneration({ ...base, parameters: { mode: "audio" } }),
      (error) => error.code === "VALIDATION_FAILED",
    );

    const withReferences = harness.app.scenes.createScene({ projectId: "pilot", title: "Reference shot" });
    harness.app.scenes.addSceneVersion({ sceneId: withReferences.id, prompt: PROMPT, references: ["asset-version-42"] });
    assert.throws(
      () => harness.app.generation.requestGeneration({ ...base, sceneId: withReferences.id }),
      (error) => error.code === "PROVIDER_UNSUPPORTED_REQUEST" && error.details.capability === "referenceImages",
    );
    assert.equal(harness.repository.countGenerationJobs(), 1, "only the accepted request persisted");
  } finally {
    await harness.close();
  }
});

test("the queue guard refuses to run work whose provider is not served here", async () => {
  const harness = await createHarness({ skipRequest: true });
  try {
    const foreign = harness.app.generation.requestGeneration({
      projectId: "pilot",
      sceneId: "scene-1",
      provider: "google-flow",
      allowUnconfiguredProvider: true,
    });
    assert.equal(foreign.created, true);

    assert.throws(
      () => harness.app.execution.assertProviderCoverage(),
      (error) =>
        error.code === "PROVIDER_COVERAGE_INCOMPLETE" &&
        error.details.uncovered["google-flow"] === 1 &&
        error.details.servedProviders.includes("mock"),
    );
    await assert.rejects(
      () => harness.app.execution.drain(),
      (error) => error.code === "PROVIDER_COVERAGE_INCOMPLETE",
    );
    const untouched = harness.repository.getGenerationJob(foreign.job.id);
    assert.equal(untouched.status, "QUEUED", "the guard must not consume attempts");
    assert.equal(untouched.attemptCount, 0);

    const queueStatus = harness.app.execution.status();
    assert.equal(queueStatus.depth.claimableNow, 1);
    assert.equal(queueStatus.worker.providerId, "mock");
    assert.deepEqual(queueStatus.configuredProviders, ["mock"]);
    assert.equal(queueStatus.items[0].provider, "google-flow");

    // Deliberately overriding the guard shows why it exists: the durable worker fails the
    // mismatched job permanently rather than serving it.
    const forced = await harness.app.execution.drain({ ignoreProviderCoverage: true });
    assert.equal(forced.results[0].status, "FAILED");
    assert.match(forced.results[0].error, /does not match job provider/);
    assert.equal(harness.repository.getGenerationJob(foreign.job.id).status, "FAILED");
  } finally {
    await harness.close();
  }
});

test("cancellation is local and final, and only contacts a provider through its own worker", async () => {
  const harness = await createHarness();
  const detached = createApplication(harness.repository, { providers: [harness.provider] });
  try {
    const attempted = await harness.app.generation.cancel({ jobId: harness.request.job.id });
    assert.equal(attempted.localCancellation, "CANCELLED");
    assert.equal(attempted.providerCancellation, "ATTEMPTED");
    assert.equal(attempted.job.status, "CANCELLED");
    assert.equal(harness.repository.getQueueItemByJob(harness.request.job.id).status, "CANCELLED");

    const repeat = await harness.app.generation.cancel({ jobId: harness.request.job.id });
    assert.equal(repeat.localCancellation, "ALREADY_TERMINAL");

    const second = harness.app.generation.requestGeneration({
      projectId: "pilot",
      sceneId: "scene-1",
      provider: "mock",
      parameters: { size: 3 },
    });
    assert.equal(second.created, true, "a distinct request must create a distinct job");
    const withoutWorker = await detached.generation.cancel({ jobId: second.job.id });
    assert.equal(withoutWorker.job.status, "CANCELLED");
    assert.equal(withoutWorker.providerCancellation, "NOT_ATTEMPTED");
    assert.match(withoutWorker.providerCancellationReason, /No durable worker/);
  } finally {
    await harness.close();
  }
});

test("retry is offered only when the durable state proves it is safe", async () => {
  const harness = await createHarness({ mode: "PERMANENT_FAILURE" });
  try {
    const execution = await harness.app.execution.drain({ maxJobs: 3 });
    assert.equal(execution.results[execution.results.length - 1].status, "FAILED");

    const status = harness.app.generation.status(harness.request.job.id);
    assert.equal(status.job.status, "FAILED");
    assert.equal(status.safeToRetry, true);
    assert.equal(status.nextAction, "RETRY_AVAILABLE");

    const later = new Date(Date.parse(FIXED_TIME) + 5 * 60_000).toISOString();
    const retried = harness.app.generation.retry({ jobId: harness.request.job.id, availableAt: later });
    assert.equal(retried.job.status, "QUEUED");
    assert.equal(retried.status.nextAction, "AWAIT_WORKER");
    assert.equal(harness.repository.getQueueItemByJob(harness.request.job.id).availableAt, later);
    assert.equal(
      harness.app.execution.status().items.find((item) => item.jobId === harness.request.job.id).claimableNow,
      false,
      "a backoff instant in the future must not read as claimable",
    );

    assert.throws(
      () => harness.app.generation.retry({ jobId: harness.request.job.id }),
      (error) => error.code === "RETRY_NOT_ALLOWED" && /Only failed jobs/.test(error.message),
    );

    const exhausted = harness.app.generation.requestGeneration({
      projectId: "pilot",
      sceneId: "scene-1",
      provider: "mock",
      maxAttempts: 1,
      parameters: { size: 2 },
    });
    await harness.app.execution.drain({ maxJobs: 3 });
    assert.equal(harness.app.generation.status(exhausted.job.id).nextAction, "RETRY_LIMIT_REACHED");
    assert.throws(
      () => harness.app.generation.retry({ jobId: exhausted.job.id }),
      (error) => error.code === "RETRY_NOT_ALLOWED",
    );
  } finally {
    await harness.close();
  }
});

test("an uncertain provider state blocks resubmission with a typed reason", async () => {
  const harness = await createHarness({ mode: "TIMEOUT", maxRecoveries: 1 });
  try {
    await harness.app.execution.drain({ maxJobs: 4 });
    const status = harness.app.generation.status(harness.request.job.id);
    assert.equal(status.job.status, "FAILED");
    assert.ok(
      status.attempts.some((attempt) => attempt.errorClass === "UNCERTAIN_PROVIDER_STATE"),
      `expected an uncertain attempt, got ${JSON.stringify(status.attempts)}`,
    );
    assert.equal(status.safeToRetry, false);
    assert.throws(
      () => harness.app.generation.retry({ jobId: harness.request.job.id }),
      (error) => error.code === "RETRY_BLOCKED_UNSAFE_STATE",
    );
    assert.equal(harness.repository.getGenerationJob(harness.request.job.id).status, "FAILED");
  } finally {
    await harness.close();
  }
});

test("review decisions are explicit, final, and idempotent only when identical", async () => {
  const harness = await createHarness();
  try {
    await drainToSuccess(harness);
    const assetVersionId = outputIdOf(harness);

    const first = harness.app.reviews.decide({ assetVersionId, decision: "REJECTED", reviewer: "mina", reason: "too dark" });
    assert.equal(first.review.status, "REJECTED");
    assert.equal(first.item.qcStatus, "PASSED");
    const repeat = harness.app.reviews.decide({ assetVersionId, decision: "REJECTED", reviewer: "mina", reason: "too dark" });
    assert.equal(repeat.idempotent, true);
    assert.throws(
      () => harness.app.reviews.decide({ assetVersionId, decision: "APPROVED", reviewer: "mina" }),
      (error) => error.code === "REVIEW_ALREADY_DECIDED" && error.details.currentStatus === "REJECTED",
    );
    assert.throws(
      () => harness.app.reviews.select({ sceneId: harness.scene.id, assetVersionId }),
      (error) => error.code === "SELECTION_NOT_ALLOWED" && error.details.reviewStatus === "REJECTED",
    );
    const readiness = harness.app.production.readiness(harness.scene.id);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "NO_SELECTED_ASSET_VERSION"));

    const rejectedStatus = harness.app.generation.status(harness.request.job.id);
    assert.equal(rejectedStatus.outputs[0].review.status, "REJECTED");
    assert.equal(rejectedStatus.outputs[0].approvedAndPassing, false);

    assert.throws(() => harness.app.reviews.get("missing-version"), (error) => error.code === "NOT_FOUND");
    assert.throws(() => harness.app.reviews.decide({ assetVersionId: "missing", decision: "APPROVED" }), (error) => error.code === "NOT_FOUND");
  } finally {
    await harness.close();
  }
});

test("a QC-failing output stays reviewable but is never selectable", async () => {
  const harness = await createHarness({ artifact: "INVALID_PNG" });
  try {
    const execution = await harness.app.execution.drain();
    assert.equal(execution.results[0].status, "SUCCEEDED", "QC failure is recorded, not hidden");
    assert.equal(execution.results[0].qcStatus, "FAILED");

    const status = harness.app.generation.status(harness.request.job.id);
    assert.equal(status.outputs[0].qc.status, "FAILED");
    assert.deepEqual(status.outputs[0].qc.failedChecks, ["mime_type"]);
    assert.equal(status.nextAction, "AWAIT_HUMAN_REVIEW");

    const assetVersionId = status.outputs[0].assetVersionId;
    assert.throws(
      () => harness.app.reviews.select({ sceneId: harness.scene.id, assetVersionId }),
      (error) => error.code === "SELECTION_NOT_ALLOWED" || error.code === "QC_NOT_PASSED",
    );
    harness.app.reviews.decide({ assetVersionId, decision: "APPROVED", reviewer: "mina" });
    assert.throws(
      () => harness.app.reviews.select({ sceneId: harness.scene.id, assetVersionId }),
      (error) => error.code === "QC_NOT_PASSED" && error.details.qcStatus === "FAILED",
    );
    assert.equal(harness.app.generation.status(harness.request.job.id).nextAction, "REQUEST_NEW_SCENE_VERSION");
    const readiness = harness.app.production.readiness(harness.scene.id);
    assert.ok(!readiness.productionReady);
    assert.deepEqual(readiness.blockers.map((blocker) => blocker.code), ["NO_SELECTED_ASSET_VERSION"]);
    assert.throws(() => harness.app.production.markReady(harness.scene.id), (error) => error.code === "READINESS_NOT_SATISFIED");
  } finally {
    await harness.close();
  }
});

test("scene status transitions stay gated by the domain rules", async () => {
  const harness = await createHarness();
  try {
    assert.throws(
      () => harness.app.scenes.setStatus({ sceneId: harness.scene.id, status: "READY" }),
      (error) => error.code === "READINESS_NOT_SATISFIED",
    );
    assert.throws(
      () => harness.app.production.reopen(harness.scene.id),
      (error) => error.code === "INVALID_STATE_TRANSITION" && /Only a READY scene/.test(error.message),
    );

    const archived = harness.app.scenes.setStatus({ sceneId: harness.scene.id, status: "ARCHIVED" });
    assert.equal(archived.status, "ARCHIVED");
    assert.throws(
      () => harness.app.scenes.setStatus({ sceneId: harness.scene.id, status: "DRAFT" }),
      (error) => error.code === "INVALID_STATE_TRANSITION" && /terminal/.test(error.message),
    );
    const readiness = harness.app.production.readiness(harness.scene.id);
    assert.deepEqual(readiness.blockers.map((blocker) => blocker.code), ["SCENE_ARCHIVED"]);
    assert.throws(() => harness.app.production.markReady(harness.scene.id), (error) => error.code === "READINESS_NOT_SATISFIED");
  } finally {
    await harness.close();
  }
});

test("project archival waits for open work and the overview reflects durable state", async () => {
  const harness = await createHarness();
  try {
    assert.throws(
      () => harness.app.projects.archiveProject({ projectId: "pilot" }),
      (error) => error.code === "ACTIVE_WORK_PRESENT" && error.details.openJobIds.length === 1,
    );
    await harness.app.generation.cancel({ jobId: harness.request.job.id });
    assert.equal(harness.app.projects.archiveProject({ projectId: "pilot" }).status, "ARCHIVED");
    assert.equal(harness.app.projects.archiveProject({ projectId: "pilot" }).status, "ARCHIVED");

    const overview = harness.app.projects.overview("pilot");
    assert.equal(overview.project.status, "ARCHIVED");
    assert.equal(overview.totals.jobsByStatus.CANCELLED, 1);
    assert.equal(overview.scenes[0].jobCount, 1);
    assert.equal(overview.scenes[0].openJobCount, 0);
    assert.equal(overview.totals.assets, 0);

    assert.throws(() => harness.app.projects.overview("other"), (error) => error.code === "NOT_FOUND");
    assert.throws(() => harness.app.projects.createProject({ name: "   " }), (error) => error.code === "VALIDATION_FAILED");
    const circular = { self: {} };
    circular.self.self = circular;
    assert.throws(
      () => harness.app.projects.createProject({ name: "Bad metadata", metadata: circular }),
      (error) => error.code === "VALIDATION_FAILED" && error.details.field === "metadata",
    );
    assert.throws(() => harness.app.projects.createProject({ name: "Bad id", projectId: "has spaces" }), (error) => error.code === "VALIDATION_FAILED");
  } finally {
    await harness.close();
  }
});

test("lease recovery is exposed as an operator action without duplicating the mechanism", async () => {
  const harness = await createHarness();
  try {
    const claim = harness.queue.claimNext("abandoned-worker", 1, FIXED_TIME);
    assert.ok(claim);
    assert.equal(harness.repository.getQueueItemByJob(harness.request.job.id).workerId, "abandoned-worker");
    assert.equal(harness.app.execution.status().depth.claimed, 1);

    const recoveryApp = createApplication(harness.repository, {
      queue: harness.queue,
      now: () => new Date(Date.parse(FIXED_TIME) + 60_000),
    });
    const recovered = recoveryApp.execution.recoverLeases();
    assert.equal(recovered.recoveredLeases, 1);
    const queued = recovered.after.items.find((item) => item.jobId === harness.request.job.id);
    assert.equal(queued.status, "QUEUED");
    assert.equal(queued.claimCount, 1, "the attempt count is durable evidence, not a reset counter");
    assert.equal(recovered.after.depth.claimableNow, 1);

    assert.equal(
      harness.app.execution.status().depth.claimableNow,
      0,
      "recovery defers availability so the abandoned worker cannot double-run the attempt",
    );

    const resumedClock = () => new Date(Date.parse(FIXED_TIME) + 60_000);
    const resumedWorker = new LocalQueueWorker(
      harness.repository,
      harness.queue,
      harness.provider,
      new FileSystemAssetStore(path.join(harness.directory, "assets")),
      { workerId: "resumed-worker", leaseMs: 60_000, retryDelayMs: 0, maxRecoveries: 5, now: resumedClock },
    );
    const resumedApp = createApplication(harness.repository, {
      queue: harness.queue,
      worker: resumedWorker,
      workerProviderId: "mock",
      providers: [harness.provider],
      now: resumedClock,
    });
    const idle = await resumedApp.execution.runOnce();
    assert.equal(idle.attempted, 1);
    assert.equal(idle.results[0].jobId, harness.request.job.id);
    assert.equal(idle.results[0].status, "SUCCEEDED");

    const resumedStatus = resumedApp.generation.status(harness.request.job.id);
    assert.equal(resumedStatus.attempts.length, 1, "recovery resumes the same durable attempt");
    assert.equal(resumedStatus.attempts[0].status, "SUCCEEDED");
    assert.equal(resumedStatus.job.attemptCount, 1);
  } finally {
    await harness.close();
  }
});

test("execution commands fail loudly when no durable worker is wired", async () => {
  const harness = await createHarness({ worker: false });
  const bare = createApplication(harness.repository, {});
  try {
    await assert.rejects(
      () => harness.app.execution.drain(),
      (error) => error.code === "WORKER_NOT_CONFIGURED" && /No durable worker/.test(error.message),
    );
    assert.deepEqual(harness.app.execution.recoverLeases(), {
      recoveredLeases: 0,
      after: harness.app.execution.status(),
    }, "lease recovery needs the queue port only");
    assert.throws(() => bare.execution.recoverLeases(), (error) => error.code === "WORKER_NOT_CONFIGURED");
    const status = harness.app.execution.status();
    assert.equal(status.worker, null);
    assert.equal(status.depth.queued, 1);
    assert.equal(harness.repository.getGenerationJob(harness.request.job.id).status, "QUEUED");
  } finally {
    await harness.close();
  }
});

test("retry classification matches the durable guard without re-implementing it", () => {
  const unsafeAttempt = { errorClass: "UNCERTAIN_PROVIDER_STATE" };
  const repository = { listGenerationAttempts: () => [unsafeAttempt] };
  assert.equal(hasUnsafeAttempt(repository, "job-1"), true);
  assert.equal(hasUnsafeAttempt({ listGenerationAttempts: () => [{ errorClass: "PROVIDER_TRANSIENT" }] }, "job-1"), false);

  const failed = { status: "FAILED", attemptCount: 1, maxAttempts: 3, idempotencyKey: "key" };
  assert.deepEqual(canRetryJob(failed, false), {
    allowed: true,
    reason: "The job is failed, has attempt budget left, and shows no uncertain provider state.",
  });
  assert.equal(canRetryJob({ ...failed, idempotencyKey: "legacy:1" }, false).allowed, false);
  assert.equal(canRetryJob({ ...failed, attemptCount: 3 }, false).allowed, false);
  assert.match(canRetryJob({ ...failed, status: "SUCCEEDED" }, false).reason, /Only failed jobs/);
  assert.match(canRetryJob(failed, true).reason, /uncertain or known provider result/);
});

test("a service rejects a command whose scene has no reviewable output", async () => {
  const harness = await createHarness();
  try {
    const fakeRepository = {
      getAssetVersion: (id) => (id === "av-1" ? { id: "av-1", assetId: "a-1" } : null),
      getQCResult: () => null,
      getReviewByAssetVersion: () => null,
    };
    const reviews = new ReviewService({ repository: fakeRepository, providers: new Map(), now: () => new Date(FIXED_TIME), defaultMaxAttempts: 3 });
    assert.throws(
      () => reviews.decide({ assetVersionId: "av-1", decision: "APPROVED", reviewer: "mina" }),
      (error) => error.code === "QC_NOT_RECORDED" && error.details.assetVersionId === "av-1",
    );
    assert.throws(() => reviews.get("av-404"), (error) => error.code === "NOT_FOUND");

    const generation = new GenerationService({
      repository: {
        getGenerationJob: () => ({
          id: "job-1",
          status: "FAILED",
          attemptCount: 1,
          maxAttempts: 3,
          idempotencyKey: "key",
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
          request: { projectId: "pilot", sceneId: "scene-1", provider: "mock", prompt: PROMPT, references: [] },
        }),
        listGenerationAttempts: () => [{ id: "at-1", attemptNumber: 1, status: "FAILED", provider: "mock", errorClass: "UNCERTAIN_PROVIDER_STATE", recoveryCount: 1 }],
        getActiveAttempt: () => null,
        getQueueItemByJob: () => null,
        getScene: () => null,
      },
      providers: new Map(),
      now: () => new Date(FIXED_TIME),
      defaultMaxAttempts: 3,
    });
    assert.throws(
      () => generation.retry({ jobId: "job-1" }),
      (error) => error.code === "RETRY_BLOCKED_UNSAFE_STATE" && error.details.jobId === "job-1",
    );
    assert.equal(generation.status("job-1").nextAction, "RETRY_BLOCKED_UNSAFE_STATE");
  } finally {
    await harness.close();
  }
});
