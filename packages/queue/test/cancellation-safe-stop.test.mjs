import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteJobRepository } from "@flowforge/storage";
import {
  GenerationCancellationWorker,
  ProviderCompletionWorker,
  ProviderExecutionWorker,
  SqliteJobQueue,
} from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "flowforge-1i-"));
const dbPath = join(dir, "jobs.sqlite");

const provider = {
  id: "fake-provider",
  async connect() {},
  async inspectState() { return { ready: true }; },
  async submit() { throw new Error("SUBMIT MUST NOT RUN"); },
  async waitForCompletion() { throw new Error("COMPLETION MUST NOT RUN"); },
  async download() { throw new Error("DOWNLOAD MUST NOT RUN"); },
  async disconnect() {},
};

const events = [];
const publisher = { publish(event) { events.push(event); } };

// CREATED + queued cancellation removes the queue entry atomically.
{
  const repository = new SqliteJobRepository(dbPath);
  repository.create({
    projectId: "project-1",
    sceneId: "scene-1",
    provider: "fake-provider",
    prompt: "FLOWFORGE CANCELLATION TEST — DO NOT GENERATE",
    references: [],
  }, "job-created");
  new SqliteJobQueue(repository).enqueue("job-created");
  assert.equal(repository.queueSize(), 1);

  const result = new GenerationCancellationWorker(repository, publisher)
    .cancel("job-created", "user requested stop");
  assert.equal(result.status, "CANCELLED");
  assert.equal(repository.get("job-created")?.status, "CANCELLED");
  assert.equal(repository.hasQueueEntry("job-created"), false);
  assert.equal(repository.queueSize(), 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "generation.cancelled");

  const again = new GenerationCancellationWorker(repository, publisher).cancel("job-created");
  assert.equal(again.status, "CANCELLED");
  assert.equal(events.length, 1);
  repository.close();
  console.log("[Phase 1I] queued job cancellation + queue removal: PASS");
}

// Every non-terminal execution stage can be safely cancelled.\n{\n  const cancellable = ["PREPARING", "SUBMITTING", "GENERATING", "VERIFYING", "DOWNLOADING", "VALIDATING"];\n  for (const status of cancellable) {\n    const repository = new SqliteJobRepository(dbPath);\n    const id = `job-cancel-${status.toLowerCase()}`;\n    repository.create({ projectId: "project-1", sceneId: "scene-1", provider: "fake-provider", prompt: "FLOWFORGE STAGE CANCEL TEST — DO NOT GENERATE", references: [] }, id);\n    for (const next of ["PREPARING", "SUBMITTING", "GENERATING", "VERIFYING", "DOWNLOADING", "VALIDATING"]) {\n      if (next === status) break;\n      repository.transition(id, next);\n    }\n    assert.equal(new GenerationCancellationWorker(repository, publisher).cancel(id).status, "CANCELLED");\n    repository.close();\n  }\n  console.log("[Phase 1I] all cancellable execution stages: PASS");\n}\n\n// Restart recovery preserves CANCELLED and cannot resume it.
{
  const repository = new SqliteJobRepository(dbPath);
  repository.create({
    projectId: "project-1",
    sceneId: "scene-1",
    provider: "fake-provider",
    prompt: "FLOWFORGE CANCELLATION RESTART TEST — DO NOT GENERATE",
    references: [],
  }, "job-restart");
  for (const next of ["PREPARING", "SUBMITTING", "GENERATING"]) {
    repository.transition("job-restart", next);
  }
  new GenerationCancellationWorker(repository, publisher).cancel("job-restart", "restart-safe stop");
  repository.close();

  const reopened = new SqliteJobRepository(dbPath);
  assert.equal(reopened.get("job-restart")?.status, "CANCELLED");
  await assert.rejects(
    () => new ProviderCompletionWorker(reopened, () => provider).runOnce("job-restart"),
    /Completion worker cannot start job job-restart from CANCELLED/,
  );
  reopened.close();
  console.log("[Phase 1I] restart persistence + cancelled job cannot resume: PASS");
}

// A cancelled job never reaches provider execution.
{
  const repository = new SqliteJobRepository(dbPath);
  repository.create({
    projectId: "project-1",
    sceneId: "scene-1",
    provider: "fake-provider",
    prompt: "FLOWFORGE EXECUTION GUARD TEST — DO NOT GENERATE",
    references: [],
  }, "job-execution");
  new SqliteJobQueue(repository).enqueue("job-execution");
  new GenerationCancellationWorker(repository, publisher).cancel("job-execution");

  const result = await new ProviderExecutionWorker(
    repository,
    new SqliteJobQueue(repository),
    () => provider,
    publisher,
  ).runOnce();
  assert.equal(result, null);
  assert.equal(repository.get("job-execution")?.status, "CANCELLED");
  repository.close();
  console.log("[Phase 1I] cancelled job blocked before provider submission: PASS");
}

// Completed jobs cannot be cancelled.
{
  const repository = new SqliteJobRepository(dbPath);
  repository.create({
    projectId: "project-1",
    sceneId: "scene-1",
    provider: "fake-provider",
    prompt: "FLOWFORGE COMPLETED CANCEL TEST — DO NOT GENERATE",
    references: [],
  }, "job-completed");
  for (const next of ["PREPARING", "SUBMITTING", "GENERATING", "VERIFYING", "DOWNLOADING", "VALIDATING", "COMPLETED"]) {
    repository.transition("job-completed", next);
  }
  assert.throws(
    () => repository.cancel("job-completed"),
    /Cannot cancel completed job job-completed/,
  );
  assert.equal(repository.get("job-completed")?.status, "COMPLETED");
  repository.close();
  console.log("[Phase 1I] completed job protection: PASS");
}

console.log("[Phase 1I] Google Flow submission: NONE");
