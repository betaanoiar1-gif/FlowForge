import assert from "node:assert/strict";
import test from "node:test";
import { SqliteJobRepository } from "../dist/index.js";

function seed(repository) {
  const project = repository.createProject({ id: "project-1", name: "Test project" });
  const scene = repository.createScene({ id: "scene-1", projectId: project.id, sceneNumber: 1, title: "Scene" });
  const version = repository.createSceneVersion({ id: "scene-version-1", sceneId: scene.id, prompt: "  A test frame  " });
  const job = repository.createGenerationJob({
    projectId: project.id,
    sceneId: scene.id,
    sceneVersionId: version.id,
    provider: "mock",
  });
  return { project, scene, version, job };
}

test("fresh database migrations and logical generation creation are durable and idempotent", () => {
  const repository = new SqliteJobRepository(":memory:");
  try {
    assert.equal(repository.getSchemaVersion(), 3);
    const { project, scene, version, job } = seed(repository);
    assert.equal(version.prompt, "  A test frame  ");
    assert.equal(repository.getCurrentSceneVersion(scene.id).id, version.id);
    const version2 = repository.createSceneVersion({ sceneId: scene.id, prompt: "A revised test frame" });
    assert.equal(version2.parentVersionId, version.id);
    assert.equal(repository.getCurrentSceneVersion(scene.id).id, version2.id);
    const repeatedVersion1 = repository.createSceneVersion({
      id: version.id,
      sceneId: scene.id,
      prompt: version.prompt,
      references: version.references,
      metadata: version.metadata,
    });
    assert.equal(repeatedVersion1.id, version.id);
    assert.equal(repository.getCurrentSceneVersion(scene.id).id, version2.id);
    assert.throws(() => repository.createSceneVersion({ id: version.id, sceneId: scene.id, prompt: "mutated" }), /different content/);
    const duplicate = repository.createGenerationJob({
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: version.id,
      provider: "mock",
    });
    assert.equal(duplicate.id, job.id);
    assert.equal(repository.countGenerationJobs(), 1);
    assert.equal(repository.queueSize(), 1);
    assert.equal(repository.getQueueItemByJob(job.id).status, "QUEUED");
  } finally {
    repository.close();
  }
});

test("expired queue leases resume the same attempt and fence the stale worker", () => {
  const repository = new SqliteJobRepository(":memory:");
  try {
    const { job } = seed(repository);
    const firstNow = new Date(Date.now() + 1_000).toISOString();
    const firstClaim = repository.claimNext("worker-old", 1_000, firstNow);
    assert.ok(firstClaim);
    repository.markAttemptRunning(job.id, firstClaim.attempt.id, "worker-old", firstNow);

    const expiredAt = new Date(Date.parse(firstNow) + 1_001).toISOString();
    assert.equal(repository.recoverExpiredLeases(expiredAt), 1);
    const secondClaim = repository.claimNext("worker-new", 5_000, expiredAt);
    assert.ok(secondClaim);
    assert.equal(secondClaim.attempt.id, firstClaim.attempt.id);
    assert.equal(secondClaim.attempt.attemptNumber, 1);
    assert.equal(secondClaim.job.attemptCount, 1);
    assert.equal(repository.extendLease(job.id, "worker-old", 5_000, expiredAt), false);
    assert.throws(
      () => repository.setProviderJobId(job.id, firstClaim.attempt.id, "worker-old", "provider-job", expiredAt),
      /does not own the active lease/,
    );
  } finally {
    repository.close();
  }
});

test("scene and project status writes stay guarded by the domain transition tables", () => {
  const repository = new SqliteJobRepository(":memory:");
  try {
    const { scene, project } = seed(repository);
    assert.equal(repository.updateSceneStatus(scene.id, "READY").status, "READY");
    assert.equal(repository.updateSceneStatus(scene.id, "READY").status, "READY", "an identical status write is a no-op, not an error");
    assert.equal(repository.updateSceneStatus(scene.id, "DRAFT").status, "DRAFT");
    assert.equal(repository.updateSceneStatus(scene.id, "ARCHIVED").status, "ARCHIVED");
    assert.throws(() => repository.updateSceneStatus(scene.id, "READY"), /Invalid scene status transition: ARCHIVED -> READY/);
    assert.throws(() => repository.updateSceneStatus("missing-scene", "READY"), /Scene not found/);

    assert.equal(repository.updateProjectStatus(project.id, "ARCHIVED").status, "ARCHIVED");
    assert.equal(repository.updateProjectStatus(project.id, "ARCHIVED").status, "ARCHIVED");
    assert.throws(() => repository.updateProjectStatus(project.id, "ACTIVE"), /Invalid project status transition: ARCHIVED -> ACTIVE/);
  } finally {
    repository.close();
  }
});

test("job creation reports whether the durable request was newly created or reused", () => {
  const repository = new SqliteJobRepository(":memory:");
  try {
    const { job, project, scene, version } = seed(repository);
    const identity = {
      projectId: project.id,
      sceneId: scene.id,
      sceneVersionId: version.id,
      provider: "mock",
    };
    const reused = repository.createGenerationJobWithCreated(identity);
    assert.equal(reused.created, false);
    assert.equal(reused.job.id, job.id);
    assert.equal(repository.queueSize(), 1, "a reused request must not enqueue a second item");

    const fresh = repository.createGenerationJobWithCreated({ ...identity, provider: "other" });
    assert.equal(fresh.created, true);
    assert.notEqual(fresh.job.id, job.id);
    assert.equal(fresh.job.status, "QUEUED");
    assert.equal(repository.getQueueItemByJob(fresh.job.id).status, "QUEUED");
  } finally {
    repository.close();
  }
});

test("operator listings narrow by durable identity without loading the whole table", () => {
  const repository = new SqliteJobRepository(":memory:");
  try {
    const { project, scene, version, job } = seed(repository);
    const other = repository.createProject({ id: "project-2", name: "Other" });
    const otherScene = repository.createScene({ id: "scene-2", projectId: other.id, sceneNumber: 1, title: "Other scene" });
    const otherVersion = repository.createSceneVersion({ sceneId: otherScene.id, prompt: "Other prompt" });
    const flowJob = repository.createGenerationJob({
      projectId: other.id,
      sceneId: otherScene.id,
      sceneVersionId: otherVersion.id,
      provider: "google-flow",
      priority: 5,
    });

    assert.deepEqual(repository.listGenerationJobs({ projectId: project.id }).map((entry) => entry.id), [job.id]);
    assert.deepEqual(repository.listGenerationJobs({ projectId: other.id, sceneId: otherScene.id }).map((entry) => entry.id), [flowJob.id]);
    assert.deepEqual(repository.listGenerationJobs({ provider: "google-flow", status: "QUEUED" }).map((entry) => entry.id), [flowJob.id]);
    assert.deepEqual(repository.listGenerationJobs({ sceneVersionId: version.id, status: "SUCCEEDED" }), []);

    const queued = repository.listQueueItems({ statuses: ["QUEUED"] });
    assert.equal(queued.length, 2);
    assert.equal(queued[0].generationJobId, flowJob.id, "priority ordering matches how work is claimed");
    assert.deepEqual(repository.listQueueItems({ status: "ACKED" }), []);
  } finally {
    repository.close();
  }
});
