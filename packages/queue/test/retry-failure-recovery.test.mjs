import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteJobRepository } from "@flowforge/storage";
import {
  GenerationRetryWorker,
  ProviderCompletionWorker,
  ProviderExecutionWorker,
  SqliteJobQueue,
} from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "flowforge-1j-"));
const dbPath = join(dir, "jobs.sqlite");
const events = [];
const publisher = { publish(event) { events.push(event); } };

const baseRequest = {
  projectId: "project-1",
  sceneId: "scene-1",
  provider: "fake-provider",
  prompt: "FLOWFORGE RETRY TEST — DO NOT GENERATE",
  references: [],
};

// A failed job with no externalId may be retried and submitted once.
{
  const repository = new SqliteJobRepository(dbPath);
  const queue = new SqliteJobQueue(repository);
  let submitCalls = 0;
  const failing = {
    id: "fake-provider",
    async connect() {},
    async inspectState() { return { ready: true }; },
    async submit() { submitCalls += 1; throw new Error("first submit failed"); },
    async waitForCompletion() { throw new Error("not expected"); },
    async download() { throw new Error("not expected"); },
    async disconnect() {},
  };
  const recovered = {
    ...failing,
    async submit() { submitCalls += 1; return { externalId: "external-1" }; },
  };
  repository.create(baseRequest, "job-no-external");
  queue.enqueue("job-no-external");
  await new ProviderExecutionWorker(repository, queue, () => failing).runOnce();
  assert.equal(repository.get("job-no-external")?.status, "FAILED");
  assert.equal(repository.get("job-no-external")?.externalId, undefined);

  const retry = await new GenerationRetryWorker(repository, queue, () => recovered, publisher).retryOnce("job-no-external");
  assert.deepEqual(retry, { jobId: "job-no-external", status: "GENERATING", retryCount: 1, maxRetries: 3, mode: "submit" });
  assert.equal(submitCalls, 2);
  assert.equal(repository.get("job-no-external")?.externalId, "external-1");
  const submitRetryEvent = events.filter((event) =>
    event.type === "generation.retry_requested" && event.jobId === "job-no-external"
  ).at(-1);
  assert.equal(submitRetryEvent?.type, "generation.retry_requested");
  assert.equal(submitRetryEvent?.mode, "submit");
  repository.close();
  console.log("[Phase 1J] failed job without externalId -> safe resubmission: PASS");
}

// A failed job with an externalId must resume completion and never resubmit.
{
  const repository = new SqliteJobRepository(dbPath);
  const queue = new SqliteJobQueue(repository);
  let submitCalls = 0;
  let completionCalls = 0;
  const provider = {
    id: "fake-provider",
    async connect() {},
    async inspectState() { return { ready: true }; },
    async submit() { submitCalls += 1; return { externalId: "external-2" }; },
    async waitForCompletion() {
      completionCalls += 1;
      if (completionCalls === 1) throw new Error("completion temporarily failed");
      return { jobId: "job-external", provider: "fake-provider", status: "VERIFYING", assets: [] };
    },
    async download() { return []; },
    async disconnect() {},
  };
  repository.create(baseRequest, "job-external");
  queue.enqueue("job-external");
  await new ProviderExecutionWorker(repository, queue, () => provider).runOnce();
  await new ProviderCompletionWorker(repository, () => provider).runOnce("job-external");
  assert.equal(repository.get("job-external")?.status, "FAILED");
  assert.equal(repository.get("job-external")?.externalId, "external-2");
  assert.equal(submitCalls, 1);

  const retry = await new GenerationRetryWorker(repository, queue, () => provider, publisher).retryOnce("job-external");
  assert.deepEqual(retry, { jobId: "job-external", status: "VERIFYING", retryCount: 1, maxRetries: 3, mode: "resume" });
  assert.equal(submitCalls, 1);
  assert.equal(completionCalls, 2);
  assert.equal(repository.get("job-external")?.status, "VERIFYING");
  const resumeRetryEvent = events.filter((event) =>
    event.type === "generation.retry_requested" && event.jobId === "job-external"
  ).at(-1);
  assert.equal(resumeRetryEvent?.type, "generation.retry_requested");
  assert.equal(resumeRetryEvent?.mode, "resume");

  // Direct queue insertion is only forbidden by the externalId recovery guard
  // when the job is FAILED; other non-queueable states are rejected generically.
  repository.transition("job-external", "FAILED", "completion still requires recovery");
  assert.equal(repository.get("job-external")?.externalId, "external-2");
  assert.throws(() => queue.enqueue("job-external"), /externalId/);
  repository.close();
  console.log("[Phase 1J] failed job with externalId -> resume without resubmission: PASS");
}

// Retry budget persists across restart and prevents a second retry after exhaustion.
{
  const repository = new SqliteJobRepository(dbPath);
  const queue = new SqliteJobQueue(repository);
  let submitCalls = 0;
  const provider = {
    id: "budget-provider",
    async connect() {},
    async inspectState() { return { ready: true }; },
    async submit() { submitCalls += 1; throw new Error("still failing"); },
    async waitForCompletion() { throw new Error("not expected"); },
    async download() { throw new Error("not expected"); },
    async disconnect() {},
  };
  repository.create({ ...baseRequest, provider: "budget-provider" }, "job-budget");
  queue.enqueue("job-budget");
  await new ProviderExecutionWorker(repository, queue, () => provider).runOnce();
  const failedRetry = await new GenerationRetryWorker(repository, queue, () => provider, publisher).retryOnce("job-budget", 1);
  assert.equal(failedRetry, null);
  assert.equal(repository.get("job-budget")?.status, "FAILED");
  assert.equal(repository.getRetryState("job-budget").retryCount, 1);
  assert.equal(submitCalls, 2);
  repository.close();

  const reopened = new SqliteJobRepository(dbPath);
  assert.equal(reopened.getRetryState("job-budget").retryCount, 1);
  await assert.rejects(
    () => new GenerationRetryWorker(reopened, new SqliteJobQueue(reopened), () => provider, publisher).retryOnce("job-budget", 1),
    /Retry limit exhausted/,
  );
  assert.equal(submitCalls, 1);
  reopened.close();
  console.log("[Phase 1J] retry budget restart persistence + exhaustion: PASS");
}

// Cancelled and completed jobs cannot be retried.
{
  const repository = new SqliteJobRepository(dbPath);
  repository.create(baseRequest, "job-cancelled");
  repository.transition("job-cancelled", "CANCELLED");
  await assert.rejects(
    () => new GenerationRetryWorker(repository, new SqliteJobQueue(repository), () => undefined).retryOnce("job-cancelled"),
    /Cannot retry cancelled job/,
  );
  repository.create(baseRequest, "job-completed");
  for (const status of ["PREPARING", "SUBMITTING", "GENERATING", "VERIFYING", "DOWNLOADING", "VALIDATING", "COMPLETED"]) repository.transition("job-completed", status);
  await assert.rejects(
    () => new GenerationRetryWorker(repository, new SqliteJobQueue(repository), () => undefined).retryOnce("job-completed"),
    /Cannot retry completed job/,
  );
  repository.close();
  console.log("[Phase 1J] cancelled/completed retry protection: PASS");
}

console.log("[Phase 1J] Google Flow submission: NONE");
