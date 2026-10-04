import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteJobRepository } from "@flowforge/storage";
import { GenerationOrchestrator, SqliteJobQueue } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "flowforge-1k-"));
const dbPath = join(dir, "jobs.sqlite");
const output = join(dir, "generated.txt");
writeFileSync(output, "FLOWFORGE TEST ASSET");

const request = {
  projectId: "project-1",
  sceneId: "scene-1",
  provider: "fake-provider",
  prompt: "FLOWFORGE ORCHESTRATOR TEST — DO NOT GENERATE",
  references: [],
};

function makeProvider(counters, behavior = {}) {
  return {
    id: "fake-provider",
    async connect() { counters.connect += 1; },
    async inspectState() { return { ready: true }; },
    async submit() {
      counters.submit += 1;
      if (behavior.failSubmit) throw new Error("submit failed");
      return { externalId: "external-1" };
    },
    async waitForCompletion() {
      counters.complete += 1;
      if (behavior.failCompletion && counters.complete === 1) {
        throw new Error("completion failed");
      }
      return { jobId: "job-1", provider: "fake-provider", status: "VERIFYING", assets: [output] };
    },
    async download() {
      counters.download += 1;
      if (behavior.failDownload) throw new Error("download failed");
      return [output];
    },
    async disconnect() { counters.disconnect += 1; },
  };
}

// Full lifecycle.
{
  const repository = new SqliteJobRepository(dbPath);
  const queue = new SqliteJobQueue(repository);
  const counters = { connect: 0, submit: 0, complete: 0, download: 0, disconnect: 0 };
  const events = [];
  repository.create(request, "job-1");
  queue.enqueue("job-1");
  const result = await new GenerationOrchestrator(
    repository, queue, () => makeProvider(counters),
    { publish(event) { events.push(event); } },
  ).runOnce("job-1");

  assert.deepEqual(result, { jobId: "job-1", status: "COMPLETED", mode: "fresh" });
  assert.equal(repository.get("job-1")?.status, "COMPLETED");
  assert.equal(counters.submit, 1);
  assert.equal(counters.complete, 1);
  assert.equal(counters.download, 1);
  assert.equal(events.at(-1)?.type, "generation.completed");
  assert.equal(repository.listProjectAssets("project-1").length, 1);
  repository.close();
  console.log("[Phase 1K] full generation lifecycle: PASS");
}

// Provider failure persists and does not throw out of the orchestrator.
{
  const repository = new SqliteJobRepository(dbPath);
  const queue = new SqliteJobQueue(repository);
  const counters = { connect: 0, submit: 0, complete: 0, download: 0, disconnect: 0 };
  repository.create({ ...request, provider: "failing-provider" }, "job-failure");
  queue.enqueue("job-failure");
  const result = await new GenerationOrchestrator(
    repository, queue, () => ({
      ...makeProvider(counters),
      id: "failing-provider",
      async submit() { counters.submit += 1; throw new Error("submit failed"); },
    }),
  ).runOnce("job-failure");

  assert.deepEqual(result, { jobId: "job-failure", status: "FAILED", mode: "fresh" });
  assert.equal(repository.get("job-failure")?.status, "FAILED");
  assert.equal(counters.submit, 1);
  repository.close();
  console.log("[Phase 1K] failure propagation: PASS");
}

// Recovery from GENERATING resumes completion and never resubmits.
{
  const repository = new SqliteJobRepository(dbPath);
  const queue = new SqliteJobQueue(repository);
  const counters = { connect: 0, submit: 0, complete: 0, download: 0, disconnect: 0 };
  repository.create(request, "job-recovery");
  repository.setExternalId("job-recovery", "external-recovery");
  repository.transition("job-recovery", "PREPARING");
  repository.transition("job-recovery", "SUBMITTING");
  repository.transition("job-recovery", "GENERATING");
  const result = await new GenerationOrchestrator(
    repository, queue, () => makeProvider(counters),
  ).runOnce("job-recovery");

  assert.deepEqual(result, { jobId: "job-recovery", status: "COMPLETED", mode: "resume" });
  assert.equal(counters.submit, 0);
  assert.equal(counters.complete, 1);
  assert.equal(repository.get("job-recovery")?.status, "COMPLETED");
  repository.close();
  console.log("[Phase 1K] recovery without resubmission: PASS");
}

// Cancellation is a safe terminal no-op for orchestration.
{
  const repository = new SqliteJobRepository(dbPath);
  const queue = new SqliteJobQueue(repository);
  const counters = { connect: 0, submit: 0, complete: 0, download: 0, disconnect: 0 };
  repository.create(request, "job-cancelled");
  repository.transition("job-cancelled", "CANCELLED");
  const result = await new GenerationOrchestrator(
    repository, queue, () => makeProvider(counters),
  ).runOnce("job-cancelled");

  assert.deepEqual(result, { jobId: "job-cancelled", status: "CANCELLED", mode: "resume" });
  assert.equal(counters.submit, 0);
  repository.close();
  console.log("[Phase 1K] cancellation: PASS");
}

// Restart persistence: completed state remains idempotent.
{
  const repository = new SqliteJobRepository(dbPath);
  assert.equal(repository.get("job-1")?.status, "COMPLETED");
  repository.close();

  const reopened = new SqliteJobRepository(dbPath);
  const queue = new SqliteJobQueue(reopened);
  const counters = { connect: 0, submit: 0, complete: 0, download: 0, disconnect: 0 };
  const result = await new GenerationOrchestrator(
    reopened, queue, () => makeProvider(counters),
  ).runOnce("job-1");

  assert.deepEqual(result, { jobId: "job-1", status: "COMPLETED", mode: "resume" });
  assert.equal(counters.submit, 0);
  assert.equal(counters.complete, 0);
  reopened.close();
  console.log("[Phase 1K] restart persistence: PASS");
}

console.log("[Phase 1K] generation.completed: PASS");
console.log("[Phase 1K] Google Flow submission: NONE");
