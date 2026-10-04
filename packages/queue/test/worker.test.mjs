import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSystemAssetStore } from "@flowforge/assets";
import { MockGenerationProvider } from "../../../providers/mock/dist/index.js";
import { LocalQueueWorker, SqliteJobQueue } from "../dist/index.js";
import { SqliteJobRepository } from "@flowforge/storage";

const FIXED_TIME = new Date(Date.now() + 60_000).toISOString();

test("success completes a durable project-to-review-to-explicit-selection flow", async () => {
  const harness = await createHarness({ mode: "SUCCESS" });
  try {
    const result = await harness.worker.runOnce();
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.qcStatus, "PASSED");
    assert.ok(result.assetVersionId);

    const job = harness.repository.getGenerationJob(harness.job.id);
    const queueItem = harness.repository.getQueueItemByJob(harness.job.id);
    const attempts = harness.repository.listGenerationAttempts(harness.job.id);
    const assetVersion = harness.repository.getAssetVersion(result.assetVersionId);
    assert.equal(job.status, "SUCCEEDED");
    assert.equal(queueItem.status, "ACKED");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "SUCCEEDED");
    assert.equal(job.externalId, attempts[0].providerJobId);
    assert.equal(assetVersion.sceneVersionId, harness.version.id);
    assert.equal(assetVersion.generationAttemptId, attempts[0].id);
    assert.deepEqual([assetVersion.width, assetVersion.height], [2, 2]);
    assert.equal(harness.repository.getQCResult(assetVersion.id).status, "PASSED");
    assert.equal(harness.repository.getReviewByAssetVersion(assetVersion.id).status, "PENDING");
    assert.ok((await stat(assetVersion.storagePath)).isFile());
    assert.ok(assetVersion.storagePath.startsWith(harness.assetRoot));

    const review = harness.repository.decideReview({
      assetVersionId: assetVersion.id,
      status: "APPROVED",
      reviewer: "test-reviewer",
      comment: "Approved exact asset version.",
    });
    assert.equal(review.status, "APPROVED");
    const selectedScene = harness.repository.selectApprovedAssetVersion(harness.scene.id, assetVersion.id);
    assert.equal(selectedScene.currentVersionId, harness.version.id);
    assert.equal(selectedScene.selectedAssetVersionId, assetVersion.id);
    assert.equal(harness.repository.getSelectedAssetVersion(harness.scene.id).id, assetVersion.id);
    assert.equal(await harness.provider.countPersistedGenerations(), 1);
  } finally {
    await harness.close();
  }
});

test("duplicate logical requests and duplicate provider outputs create one job and one accepted asset", async () => {
  const harness = await createHarness({ mode: "DUPLICATE_RESULT", parameters: { format: "png", size: 2 } });
  try {
    const duplicateJob = harness.repository.createGenerationJob({
      projectId: harness.project.id,
      sceneId: harness.scene.id,
      sceneVersionId: harness.version.id,
      provider: "mock",
      parameters: { size: 2, format: "png" },
    });
    assert.equal(duplicateJob.id, harness.job.id);
    assert.equal(harness.repository.countGenerationJobs(), 1);
    assert.equal(harness.repository.queueSize(), 1);

    const result = await harness.worker.runOnce();
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(harness.repository.listAssetVersionsForSceneVersion(harness.version.id).length, 1);
    assert.equal(harness.repository.listProjectAssets(harness.project.id).length, 1);
    assert.equal(await harness.provider.countPersistedGenerations(), 1);
  } finally {
    await harness.close();
  }
});

test("transient provider failure creates attempt history and retries with the next stable request key", async () => {
  const harness = await createHarness({ mode: "TRANSIENT_FAILURE" });
  try {
    const first = await harness.worker.runOnce();
    assert.equal(first.status, "QUEUED");
    const afterFirst = harness.repository.listGenerationAttempts(harness.job.id);
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0].status, "FAILED");
    assert.equal(afterFirst[0].errorClass, "MOCK_TRANSIENT_FAILURE");

    const second = await harness.worker.runOnce();
    assert.equal(second.status, "SUCCEEDED");
    const attempts = harness.repository.listGenerationAttempts(harness.job.id);
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0].providerRequestKey, attempts[1].providerRequestKey);
    assert.equal(attempts[1].status, "SUCCEEDED");
    assert.equal(harness.repository.getGenerationJob(harness.job.id).attemptCount, 2);
    assert.equal(harness.repository.listAssetVersionsForSceneVersion(harness.version.id).length, 1);
    assert.equal(await harness.provider.countPersistedGenerations(), 1);
  } finally {
    await harness.close();
  }
});

test("permanent provider failure is persisted and is not automatically retried", async () => {
  const harness = await createHarness({ mode: "PERMANENT_FAILURE" });
  try {
    const results = await harness.worker.runUntilIdle(5);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "FAILED");
    assert.equal(harness.repository.getGenerationJob(harness.job.id).status, "FAILED");
    assert.equal(harness.repository.getQueueItemByJob(harness.job.id).status, "FAILED");
    assert.equal(harness.repository.listGenerationAttempts(harness.job.id).length, 1);
    assert.equal(await harness.provider.countPersistedGenerations(), 0);
  } finally {
    await harness.close();
  }
});

test("timeout retains the same attempt and prevents unsafe manual resubmission", async () => {
  const harness = await createHarness({ mode: "TIMEOUT", maxRecoveries: 2 });
  try {
    const results = await harness.worker.runUntilIdle(10);
    assert.equal(results.length, 3);
    assert.equal(harness.repository.getGenerationJob(harness.job.id).status, "FAILED");
    const attempts = harness.repository.listGenerationAttempts(harness.job.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].attemptNumber, 1);
    assert.equal(attempts[0].recoveryCount, 3);
    assert.equal(attempts[0].errorClass, "UNCERTAIN_PROVIDER_STATE");
    assert.equal(await harness.provider.countPersistedGenerations(), 1);
    assert.throws(
      () => harness.repository.retryFailedJob(harness.job.id, FIXED_TIME),
      /uncertain or known provider result/,
    );
  } finally {
    await harness.close();
  }
});

test("QC failure is stored honestly and blocks explicit version selection", async () => {
  const harness = await createHarness({ mode: "SUCCESS", artifact: "INVALID_PNG" });
  try {
    const result = await harness.worker.runOnce();
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.qcStatus, "FAILED");
    const assetVersion = harness.repository.getAssetVersion(result.assetVersionId);
    const qc = harness.repository.getQCResult(assetVersion.id);
    assert.equal(qc.status, "FAILED");
    assert.equal(qc.checks.mime_type.status, "FAIL");
    assert.equal(harness.repository.getReviewByAssetVersion(assetVersion.id).status, "PENDING");

    harness.repository.decideReview({ assetVersionId: assetVersion.id, status: "APPROVED", reviewer: "test-reviewer" });
    assert.throws(
      () => harness.repository.selectApprovedAssetVersion(harness.scene.id, assetVersion.id),
      /passing deterministic QC/,
    );
    assert.equal(harness.repository.getSelectedAssetVersion(harness.scene.id), null);
  } finally {
    await harness.close();
  }
});

test("crash after provider success but before provider ID persistence recovers without resubmission", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-crash-recovery-"));
  let repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const assetRoot = path.join(directory, "assets");
  const provider = new MockGenerationProvider({ rootDir: path.join(directory, "mock-provider"), mode: "SUCCESS" });
  let harness;
  try {
    harness = seed(repository, provider, assetRoot);
    const firstClaim = repository.claimNext("worker-that-crashes", 1_000, FIXED_TIME);
    assert.ok(firstClaim);
    repository.markAttemptRunning(harness.job.id, firstClaim.attempt.id, "worker-that-crashes", FIXED_TIME);
    const request = {
      ...firstClaim.job.request,
      sceneVersionId: firstClaim.job.request.sceneVersionId,
      jobId: firstClaim.job.id,
      logicalIdempotencyKey: firstClaim.job.idempotencyKey,
      providerRequestKey: firstClaim.attempt.providerRequestKey,
      attemptNumber: firstClaim.attempt.attemptNumber,
    };
    const accepted = await provider.createGeneration(request);
    assert.equal(accepted.status, "SUCCEEDED");
    // Simulate process death before setProviderJobId(): the provider has persisted a successful result.
    repository.close();

    const recoveryTime = new Date(Date.parse(FIXED_TIME) + 1_001).toISOString();
    repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
    const recoveryProvider = new MockGenerationProvider({ rootDir: path.join(directory, "mock-provider"), mode: "SUCCESS" });
    const providerWithoutResubmit = {
      id: recoveryProvider.id,
      capabilities: recoveryProvider.capabilities,
      findGeneration: (key) => recoveryProvider.findGeneration(key),
      createGeneration: async () => { throw new Error("Recovery attempted a duplicate provider submission."); },
      getGenerationStatus: (providerJobId) => recoveryProvider.getGenerationStatus(providerJobId),
      downloadResult: (providerJobId) => recoveryProvider.downloadResult(providerJobId),
      cancelGeneration: (providerJobId) => recoveryProvider.cancelGeneration(providerJobId),
    };
    const worker = new LocalQueueWorker(
      repository,
      new SqliteJobQueue(repository),
      providerWithoutResubmit,
      new FileSystemAssetStore(assetRoot),
      {
        workerId: "recovery-worker",
        leaseMs: 5_000,
        retryDelayMs: 0,
        now: () => new Date(recoveryTime),
      },
    );
    const result = await worker.runOnce();
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.qcStatus, "PASSED");
    assert.equal(repository.getGenerationJob(harness.job.id).attemptCount, 1);
    assert.equal(repository.listGenerationAttempts(harness.job.id).length, 1);
    assert.equal(repository.listAssetVersionsForSceneVersion(harness.version.id).length, 1);
    assert.equal(repository.getQueueItemByJob(harness.job.id).status, "ACKED");
    assert.equal(await provider.countPersistedGenerations(), 1);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createHarness({ mode, artifact = "VALID_PNG", maxRecoveries = 20, parameters = {} }) {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-worker-"));
  const repository = new SqliteJobRepository(path.join(directory, "flowforge.sqlite"));
  const provider = new MockGenerationProvider({
    rootDir: path.join(directory, "mock-provider"),
    mode,
    artifact,
    failAttempts: mode === "TRANSIENT_FAILURE" ? 1 : 0,
  });
  const seeded = seed(repository, provider, path.join(directory, "assets"), parameters);
  const worker = new LocalQueueWorker(
    repository,
    new SqliteJobQueue(repository),
    provider,
    new FileSystemAssetStore(path.join(directory, "assets")),
    {
      workerId: "test-worker",
      leaseMs: 10_000,
      retryDelayMs: 0,
      maxRecoveries,
      now: () => new Date(FIXED_TIME),
    },
  );
  return {
    ...seeded,
    directory,
    assetRoot: path.join(directory, "assets"),
    provider,
    repository,
    worker,
    close: async () => {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function seed(repository, provider, assetRoot, parameters = {}) {
  const project = repository.createProject({ id: "integration-project", name: "Integration project" });
  const scene = repository.createScene({ id: "integration-scene", projectId: project.id, sceneNumber: 1, title: "Integration scene" });
  const version = repository.createSceneVersion({
    id: "integration-scene-version-1",
    sceneId: scene.id,
    prompt: "A peaceful forest clearing at dawn.",
    references: [],
  });
  const job = repository.createGenerationJob({
    projectId: project.id,
    sceneId: scene.id,
    sceneVersionId: version.id,
    provider: provider.id,
    parameters,
  });
  return { project, scene, version, job };
}
