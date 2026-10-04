import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderExecutionWorker, SqliteJobQueue } from "../dist/index.js";
import { SqliteJobRepository } from "@flowforge/storage";

const dbPath = join(mkdtempSync(join(tmpdir(), "flowforge-1c-")), "jobs.sqlite");
const repository = new SqliteJobRepository(dbPath);
const queue = new SqliteJobQueue(repository);

const request = {
  projectId: "project-1",
  sceneId: "scene-1",
  provider: "fake-provider",
  prompt: "FLOWFORGE EXECUTION TEST — DO NOT GENERATE",
  references: [],
};

const lifecycle = [];
const provider = {
  id: "fake-provider",
  async connect() {
    lifecycle.push("connect");
  },
  async inspectState() {
    return { ready: true };
  },
  async submit(receivedRequest) {
    lifecycle.push(["submit", receivedRequest.prompt]);
    return { externalId: "external-1" };
  },
  async waitForCompletion() {
    throw new Error("not part of Phase 1C");
  },
  async download() {
    throw new Error("not part of Phase 1C");
  },
  async disconnect() {
    lifecycle.push("disconnect");
  },
};

const job = repository.create(request, "job-1");
queue.enqueue(job.id);

const worker = new ProviderExecutionWorker(
  repository,
  queue,
  (providerId) => providerId === provider.id ? provider : undefined,
);

const result = await worker.runOnce();
assert.deepEqual(result, {
  jobId: "job-1",
  status: "GENERATING",
  externalId: "external-1",
});

const persisted = repository.get("job-1");
assert.equal(persisted?.status, "GENERATING");
assert.equal(persisted?.externalId, "external-1");
assert.deepEqual(lifecycle, [
  "connect",
  ["submit", request.prompt],
  "disconnect",
]);

console.log("[Phase 1C] provider execution lifecycle: PASS");

const failingProvider = {
  ...provider,
  id: "failing-provider",
  async submit() {
    throw new Error("synthetic provider failure");
  },
};

const failedJob = repository.create(
  { ...request, provider: "failing-provider" },
  "job-2",
);
queue.enqueue(failedJob.id);

const failureWorker = new ProviderExecutionWorker(
  repository,
  queue,
  (providerId) => providerId === failingProvider.id ? failingProvider : undefined,
);

const failureResult = await failureWorker.runOnce();
assert.equal(failureResult, null);

const failedPersisted = repository.get("job-2");
assert.equal(failedPersisted?.status, "FAILED");
assert.equal(failedPersisted?.error, "synthetic provider failure");

console.log("[Phase 1C] provider failure persistence: PASS");

queue.enqueue("job-2");
const retryResult = await worker.runOnce();
assert.deepEqual(retryResult, {
  jobId: "job-2",
  status: "GENERATING",
  externalId: "external-1",
});

assert.equal(repository.get("job-2")?.status, "GENERATING");
console.log("[Phase 1C] failed job requeue/retry: PASS");
console.log("[Phase 1C] Google Flow submission: NONE");
