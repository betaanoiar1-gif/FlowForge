/**
 * Phase 6 integration suite: the real Google Flow adapter driving the existing durable engine
 * (repository, queue, worker, asset store, deterministic QC, review queue) through a fake
 * `BrowserGateway`. Nothing here reaches Google: the browser is a scripted in-process fake, and the
 * engine under test is the same one `MockProvider` uses, so a pass proves the boundary, not a
 * live Flow session.
 *
 * The counters are the point. A pass is only meaningful if `generateClicks` stayed at 1 across
 * timeouts, transport failures, download failures, and recovery — that is what "recover the same
 * attempt instead of generating again" means in durable terms.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSystemAssetStore } from "../../../packages/assets/dist/index.js";
import { LocalQueueWorker, SqliteJobQueue } from "../../../packages/queue/dist/index.js";
import { SqliteJobRepository } from "../../../packages/storage/dist/index.js";
import { ApplicationError, createApplication } from "../../../packages/services/dist/index.js";
import { GOOGLE_FLOW_CAPABILITIES, GOOGLE_FLOW_PROVIDER_ID, GoogleFlowProvider } from "../dist/index.js";
import { completeGeneration, FakeFlowGateway } from "./support/fake-flow-gateway.mjs";

const PROMPT = "A narrow beam sweeps across wet rocks before dawn.";

async function withEngine(scenario, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-flow-engine-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const project = repository.createProject({ id: "flow-engine-project", name: "Flow engine" });
  const scene = repository.createScene({ id: "flow-engine-scene", projectId: project.id, sceneNumber: 1, title: "Lighthouse" });
  const version = repository.createSceneVersion({
    id: "flow-engine-version",
    sceneId: scene.id,
    prompt: PROMPT,
    references: [],
  });
  const gateway = new FakeFlowGateway(scenario);
  await gateway.connect();
  const provider = new GoogleFlowProvider(gateway, { rootDir: path.join(directory, "google-flow") });
  const queue = new SqliteJobQueue(repository);
  const worker = new LocalQueueWorker(repository, queue, provider, new FileSystemAssetStore(path.join(directory, "assets")), {
    workerId: "flow-engine-worker",
    retryDelayMs: 0,
    maxRecoveries: 4,
  });
  const app = createApplication(repository, {
    queue,
    worker,
    workerProviderId: provider.id,
    providers: [{ id: provider.id, capabilities: provider.capabilities }],
  });
  const job = repository.createGenerationJob({
    projectId: project.id,
    sceneId: scene.id,
    sceneVersionId: version.id,
    provider: GOOGLE_FLOW_PROVIDER_ID,
    parameters: { mode: "image", outputCount: 1 },
    maxAttempts: 2,
  });
  try {
    await run({ app, directory, gateway, job, provider, queue, repository, scene, version, worker });
  } finally {
    repository.close();
    await gateway.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Anything but the harness attaching/detaching would mean the adapter drove the page. */
function browserActivity(gateway) {
  return gateway.operations.filter((operation) => operation !== "connect" && operation !== "disconnect");
}

function attemptReport(repository, jobId) {
  return repository.listGenerationAttempts(jobId).map((attempt) => ({
    status: attempt.status,
    attemptNumber: attempt.attemptNumber,
    errorClass: attempt.errorClass,
    recoveryCount: attempt.recoveryCount,
    hasProviderJobId: Boolean(attempt.providerJobId),
    error: attempt.error,
  }));
}

test("the real adapter runs one image end to end and hands it to the existing asset, QC, and review path", async () => {
  await withEngine({}, async ({ app, gateway, job, provider, repository, scene, worker }) => {
    const submitted = await worker.runOnce();
    assert.equal(submitted.status, "QUEUED", "a busy Flow page defers; the adapter does not guess a result");
    assert.equal(gateway.generateClicks, 1);
    completeGeneration(gateway);
    const result = await worker.runOnce();
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.qcStatus, "PASSED");
    assert.equal(gateway.generateClicks, 1, "one attempt, one Generate submission");
    assert.equal(gateway.downloadCalls, 1, "one download of the correlated result");
    assert.ok(gateway.pollCalls >= 3, "the adapter polled the page rather than assuming an outcome");
    assert.ok(gateway.pollCalls <= 8, "polling stays bounded per cycle");

    const attempt = repository.listGenerationAttempts(job.id)[0];
    assert.equal(attempt.status, "SUCCEEDED");
    assert.match(attempt.providerJobId, /^flow-[a-f0-9]{64}$/);
    const assetVersion = repository.getAssetVersion(result.assetVersionId);
    assert.equal(assetVersion.generationJobId, job.id);
    assert.equal(assetVersion.generationAttemptId, attempt.id);
    assert.equal(assetVersion.provider, GOOGLE_FLOW_PROVIDER_ID, "the asset stays attributed to the real provider");
    assert.equal(assetVersion.mimeType, "image/png");
    assert.equal(assetVersion.versionNumber, 1);
    assert.equal(repository.getQCResult(assetVersion.id).status, "PASSED");
    assert.equal(assetVersion.metadata?.providerRequestKey, attempt.providerRequestKey);
    assert.equal(assetVersion.metadata?.providerJobId, attempt.providerJobId);

    // The handoff is provider-neutral: the review queue and read models are the existing ones.
    const pending = app.reviews.listPending({ sceneId: scene.id });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].assetVersionId, assetVersion.id);
    const status = app.generation.status(job.id);
    assert.equal(status.job.status, "SUCCEEDED");
    assert.equal(status.job.attemptCount, 1);
    assert.equal(repository.getQueueItemByJob(job.id).status, "ACKED");
    assert.equal(attemptReport(repository, job.id).length, 1);

    const state = await provider.attemptState(attempt.providerRequestKey);
    assert.equal(state.phase, "RESULT_STORED");
  });
});

test("a poll timeout at the engine level recovers the same attempt and never submits twice", async () => {
  await withEngine({ clickResult: "unverified" }, async ({ gateway, job, repository, worker }) => {
    const first = await worker.runOnce();
    assert.equal(first.status, "QUEUED", "the engine defers rather than failing the attempt");
    assert.equal(gateway.generateClicks, 1, "the timeout alone never earns a second Generate click");
    const [deferred] = attemptReport(repository, job.id);
    assert.equal(deferred.status, "RUNNING", "the same attempt stays open for observation");
    assert.equal(deferred.attemptNumber, 1);
    assert.equal(deferred.recoveryCount, 1);
    assert.equal(deferred.errorClass, "UNCERTAIN_PROVIDER_STATE", "the existing Phase 1 classification is reused");

    completeGeneration(gateway);
    const second = await worker.runOnce();
    assert.equal(second.status, "SUCCEEDED");
    assert.equal(second.qcStatus, "PASSED");
    assert.equal(gateway.generateClicks, 1);
    assert.deepEqual(attemptReport(repository, job.id).map((entry) => entry.attemptNumber), [1]);
    assert.equal(repository.listGenerationJobs({ sceneId: "flow-engine-scene" })[0].status, "SUCCEEDED");
  });
});

test("a download failure at the engine level resumes the same attempt without regenerating", async () => {
  await withEngine({}, async ({ gateway, job, provider, repository, worker }) => {
    await worker.runOnce();
    completeGeneration(gateway);
    gateway.fail("download");
    const first = await worker.runOnce();
    assert.equal(first.status, "QUEUED");
    assert.equal(gateway.generateClicks, 1, "a failed download never re-runs the generation");
    assert.equal(gateway.downloadCalls, 1);
    const [deferred] = attemptReport(repository, job.id);
    assert.equal(deferred.recoveryCount, 2, "the busy pass and the download failure are both recoveries of one attempt");
    const record = await provider.attemptState(repository.listGenerationAttempts(job.id)[0].providerRequestKey);
    assert.equal(record.phase, "RESULT_DETECTED", "the correlated result is remembered across the failure");
    assert.equal(record.hasDownloadedArtifact, false);

    gateway.setPage({ failOps: [] });
    const second = await worker.runOnce();
    assert.equal(second.status, "SUCCEEDED");
    assert.equal(gateway.downloadCalls, 2, "the same correlated result was downloaded again");
    assert.equal(gateway.generateClicks, 1);
  });
});

test("a transport interruption during polling defers, then resumes on the same attempt", async () => {
  await withEngine({}, async ({ gateway, job, repository, worker }) => {
    const submitted = await worker.runOnce();
    assert.equal(submitted.status, "QUEUED", "a busy page defers; it does not fail the attempt");
    assert.equal(gateway.generateClicks, 1);

    gateway.setPage({ failOps: ["observe"] }); // the CDP connection drops mid-poll
    const deferred = await worker.runOnce();
    assert.equal(deferred.status, "QUEUED");
    assert.equal(gateway.generateClicks, 1);
    const [attempt] = attemptReport(repository, job.id);
    assert.equal(attempt.attemptNumber, 1, "the interruption consumed no new attempt");
    assert.ok(attempt.recoveryCount >= 2, "each pass is a recovery of the same attempt");

    gateway.setPage({ failOps: [], resultMedia: 1, downloadVisible: true });
    const resumed = await worker.runOnce();
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal(gateway.generateClicks, 1, "an interrupted poll resumes; it does not resubmit");
  });
});

test("authentication lost mid-generation pauses the same attempt and resumes after a manual sign-in", async () => {
  await withEngine({}, async ({ gateway, job, repository, worker }) => {
    await worker.runOnce();
    const fillsBefore = gateway.fillCalls;
    const clicksBefore = gateway.generateClicks;
    gateway.setPage({ auth: true });
    const paused = await worker.runOnce();
    assert.equal(paused.status, "QUEUED");
    assert.equal(gateway.fillCalls, fillsBefore, "the adapter never types into an authentication wall");
    assert.equal(gateway.generateClicks, clicksBefore, "the adapter never submits through an authentication wall");
    const [attempt] = attemptReport(repository, job.id);
    assert.equal(attempt.status, "RUNNING", "authentication loss never fails the attempt on its own");
    assert.match(attempt.error ?? "", /authentication/i, "the operator is told what to do manually");
    assert.equal(gateway.generateClicks, 1, "the adapter never retries a submission through an auth wall");

    // The user signs in by hand; the same attempt then observes the completed result.
    gateway.setPage({ auth: false, busy: false, resultMedia: 1, downloadVisible: true });
    const resumed = await worker.runOnce();
    assert.equal(resumed.status, "SUCCEEDED");
    assert.equal(gateway.generateClicks, 1);
    assert.equal(attemptReport(repository, job.id)[0].attemptNumber, 1);
  });
});

test("an exhausted uncertainty budget fails visibly and the durable guard still blocks unsafe retry", async () => {
  await withEngine({ clickResult: "unconfirmed-timeout" }, async ({ gateway, job, repository, worker }) => {
    let result = await worker.runOnce();
    let passes = 1;
    while (result.status === "QUEUED" && passes < 12) {
      result = await worker.runOnce();
      passes += 1;
    }
    assert.equal(result.status, "FAILED", "bounded same-attempt recovery ends visibly instead of looping");
    assert.equal(gateway.generateClicks, 1, "bounded recovery never turns into a second submission");
    const report = attemptReport(repository, job.id);
    assert.deepEqual(report.map((entry) => entry.attemptNumber), [1], "no new attempt was created by the uncertainty");
    assert.equal(report[0].errorClass, "UNCERTAIN_PROVIDER_STATE");
    assert.throws(
      () => repository.retryFailedJob(job.id, new Date().toISOString()),
      /uncertain or known provider result/,
      "the reused Phase 1 guard refuses a blind resubmission of uncertain Flow work",
    );
  });
});

test("the provider registry resolves both providers and refuses unsupported Flow work before enqueue", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-flow-registry-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const gateway = new FakeFlowGateway({});
  await gateway.connect();
  try {
    const flowDescriptor = { id: GOOGLE_FLOW_PROVIDER_ID, capabilities: GOOGLE_FLOW_CAPABILITIES };
    const mockDescriptor = {
      id: "mock",
      capabilities: {
        imageGeneration: true,
        videoGeneration: true,
        referenceImages: true,
        startFrame: true,
        endFrame: true,
        batchGeneration: true,
      },
    };
    const app = createApplication(repository, { providers: [mockDescriptor, flowDescriptor] });
    assert.deepEqual([...app.providers.keys()], ["mock", "google-flow"], "both providers resolve from one registry");
    assert.equal(app.providers.get("google-flow").capabilities.videoGeneration, false);
    assert.equal(app.providers.get("google-flow").capabilities.imageGeneration, true);

    const project = repository.createProject({ id: "registry-project", name: "Registry" });
    const scene = repository.createScene({ id: "registry-scene", projectId: project.id, sceneNumber: 1, title: "Shot" });
    const plain = repository.createSceneVersion({ id: "registry-version", sceneId: scene.id, prompt: PROMPT, references: [] });
    const withReferences = repository.createSceneVersion({
      id: "registry-version-refs",
      sceneId: scene.id,
      prompt: PROMPT,
      references: ["asset-reference-1"],
    });
    const queue = new SqliteJobQueue(repository);

    const refuse = (label, input, capability) => {
      let caught;
      try {
        app.generation.requestGeneration({ projectId: project.id, sceneId: scene.id, provider: GOOGLE_FLOW_PROVIDER_ID, ...input });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof ApplicationError, `${label}: expected a typed refusal, got ${caught}`);
      assert.equal(caught.code, capability === null ? "PROVIDER_NOT_CONFIGURED" : "PROVIDER_UNSUPPORTED_REQUEST", label);
      if (capability !== null) assert.equal(caught.details.capability, capability, label);
      assert.equal(queue.size(), 0, `${label}: nothing may be enqueued for an unsupported request`);
      assert.equal(repository.listGenerationJobs({ sceneId: scene.id }).length, 0, `${label}: no job row either`);
    };

    refuse("video", { parameters: { mode: "video", outputCount: 1 } }, "videoGeneration");
    refuse("batch", { parameters: { mode: "image", outputCount: 2 } }, "batchGeneration");
    refuse("start frame", { parameters: { mode: "image", outputCount: 1, startFrame: "x" } }, "startFrame");
    refuse("end frame", { parameters: { mode: "image", outputCount: 1, endFrame: "x" } }, "endFrame");
    refuse("references", { sceneVersionId: withReferences.id, parameters: { mode: "image", outputCount: 1 } }, "referenceImages");
    refuse("unknown provider", { provider: "some-other-provider", parameters: { mode: "image" } }, null);

    const accepted = app.generation.requestGeneration({
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: plain.id,
      provider: GOOGLE_FLOW_PROVIDER_ID,
      parameters: { mode: "image", outputCount: 1 },
    });
    assert.equal(accepted.job.status, "QUEUED");
    assert.equal(queue.size(), 1, "the one verified unit is admitted");
    assert.deepEqual(browserActivity(gateway), [], "queueing Flow work never attaches a browser");
  } finally {
    repository.close();
    await gateway.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the engine refuses to run Flow work on the wrong provider instead of falling back silently", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-flow-fallback-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const gateway = new FakeFlowGateway({});
  await gateway.connect();
  try {
    const { MockGenerationProvider } = await import("../../../providers/mock/dist/index.js");
    const mock = new MockGenerationProvider({ rootDir: path.join(directory, "mock"), mode: "SUCCESS", artifact: "VALID_PNG" });
    const queue = new SqliteJobQueue(repository);
    const worker = new LocalQueueWorker(repository, queue, mock, new FileSystemAssetStore(path.join(directory, "assets")), {
      workerId: "mock-only-worker",
      retryDelayMs: 0,
    });
    const app = createApplication(repository, {
      queue,
      worker,
      workerProviderId: mock.id,
      providers: [
        { id: mock.id, capabilities: mock.capabilities },
        { id: GOOGLE_FLOW_PROVIDER_ID, capabilities: GOOGLE_FLOW_CAPABILITIES },
      ],
    });
    const project = repository.createProject({ id: "fallback-project", name: "Fallback" });
    const scene = repository.createScene({ id: "fallback-scene", projectId: project.id, sceneNumber: 1, title: "Shot" });
    const version = repository.createSceneVersion({ id: "fallback-version", sceneId: scene.id, prompt: PROMPT, references: [] });
    const job = repository.createGenerationJob({
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: version.id,
      provider: GOOGLE_FLOW_PROVIDER_ID,
      parameters: { mode: "image", outputCount: 1 },
      maxAttempts: 2,
    });

    await assert.rejects(
      () => app.execution.drain({ maxJobs: 1 }),
      (error) => error instanceof ApplicationError && error.code === "PROVIDER_COVERAGE_INCOMPLETE" && error.details.uncovered[GOOGLE_FLOW_PROVIDER_ID] === 1,
      "a worker that cannot serve Flow says so instead of running it on a different provider",
    );
    assert.equal(repository.getGenerationJob(job.id).status, "QUEUED", "the guard consumes no attempt");
    assert.deepEqual(browserActivity(gateway), [], "the Flow adapter was never consulted");

    // Even with the guard bypassed deliberately, the provider identity check still refuses the swap.
    const forced = await worker.runOnce();
    assert.equal(forced.status, "FAILED");
    assert.match(forced.error ?? "", /does not match job provider/i);
    const [attempt] = repository.listGenerationAttempts(job.id);
    assert.equal(attempt.errorClass, "PROVIDER_MISMATCH");
    assert.equal(attempt.providerJobId, undefined, "no provider job was created by the wrong adapter");
  } finally {
    repository.close();
    await gateway.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queueing and reads stay provider-neutral: MockProvider is unaffected by Flow being unwired", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-flow-mock-coexist-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  try {
    const { MockGenerationProvider } = await import("../../../providers/mock/dist/index.js");
    const mock = new MockGenerationProvider({ rootDir: path.join(directory, "mock"), mode: "SUCCESS", artifact: "VALID_PNG" });
    const queue = new SqliteJobQueue(repository);
    const worker = new LocalQueueWorker(repository, queue, mock, new FileSystemAssetStore(path.join(directory, "assets")), {
      workerId: "mock-worker",
      retryDelayMs: 0,
    });
    const app = createApplication(repository, {
      queue,
      worker,
      workerProviderId: mock.id,
      providers: [
        { id: mock.id, capabilities: mock.capabilities },
        { id: GOOGLE_FLOW_PROVIDER_ID, capabilities: GOOGLE_FLOW_CAPABILITIES },
      ],
    });
    const project = repository.createProject({ id: "coexist-project", name: "Coexist" });
    const flowScene = repository.createScene({ id: "coexist-flow", projectId: project.id, sceneNumber: 1, title: "Flow shot" });
    const flowVersion = repository.createSceneVersion({ id: "coexist-flow-version", sceneId: flowScene.id, prompt: PROMPT, references: [] });
    const mockScene = repository.createScene({ id: "coexist-mock", projectId: project.id, sceneNumber: 2, title: "Mock shot" });
    const mockVersion = repository.createSceneVersion({ id: "coexist-mock-version", sceneId: mockScene.id, prompt: PROMPT, references: [] });

    assert.equal(app.generation.requestGeneration({
      projectId: project.id,
      sceneId: mockScene.id,
      sceneVersionId: mockVersion.id,
      provider: "mock",
    }).job.status, "QUEUED");
    assert.equal(app.generation.requestGeneration({
      projectId: project.id,
      sceneId: flowScene.id,
      sceneVersionId: flowVersion.id,
      provider: GOOGLE_FLOW_PROVIDER_ID,
      parameters: { mode: "image", outputCount: 1 },
    }).job.status, "QUEUED", "Flow work can be queued while Flow is unconfigured, because queueing needs no browser");

    const drain = await app.execution.drain({ maxJobs: 4, ignoreProviderCoverage: true });
    assert.equal(drain.results.filter((result) => result.status === "SUCCEEDED").length, 1, "the mock job succeeds on its own merits");
    assert.equal(drain.results.filter((result) => result.status === "FAILED").length, 1, "the Flow job is refused, never executed by mock");

    assert.equal(app.reviews.listPending({ sceneId: mockScene.id }).length, 1);
    assert.equal(app.reviews.listPending({ sceneId: flowScene.id }).length, 0);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

