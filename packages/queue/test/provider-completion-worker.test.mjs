import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderCompletionWorker } from "../dist/index.js";
import { SqliteJobRepository } from "@flowforge/storage";

function setup(id, provider) {
  const repository = new SqliteJobRepository(
    join(mkdtempSync(join(tmpdir(), "flowforge-1e-")), "jobs.sqlite"),
  );
  repository.create({
    projectId: "project-1",
    sceneId: "scene-1",
    provider: provider.id,
    prompt: "FLOWFORGE COMPLETION TEST — DO NOT GENERATE",
    references: [],
  }, id);
  repository.transition(id, "PREPARING");
  repository.transition(id, "SUBMITTING");
  repository.setExternalId(id, "external-1");
  repository.transition(id, "GENERATING");
  return repository;
}

const successEvents = [];
const successProvider = {
  id: "fake-provider",
  async connect() {},
  async inspectState() { return { ready: true }; },
  async submit() { return { externalId: "external-1" }; },
  async waitForCompletion(externalId) {
    assert.equal(externalId, "external-1");
    return {
      jobId: "job-1",
      provider: "fake-provider",
      status: "COMPLETED",
      assets: [],
    };
  },
  async download() { return []; },
  async disconnect() {},
};

const repository = setup("job-1", successProvider);
const worker = new ProviderCompletionWorker(
  repository,
  () => successProvider,
  { publish(event) { successEvents.push(event); } },
);
const result = await worker.runOnce("job-1");
assert.equal(result?.status, "VERIFYING");
assert.equal(result?.externalId, "external-1");
assert.equal(repository.get("job-1")?.status, "VERIFYING");
assert.deepEqual(successEvents.map((event) => event.type), [
  "generation.verifying",
]);
console.log("[Phase 1E] provider completion -> VERIFYING: PASS");

const failingProvider = {
  ...successProvider,
  id: "failing-provider",
  async waitForCompletion() {
    throw new Error("provider completion timeout");
  },
};
const failureRepository = setup("job-2", failingProvider);
const failureEvents = [];
const failureWorker = new ProviderCompletionWorker(
  failureRepository,
  () => failingProvider,
  { publish(event) { failureEvents.push(event); } },
);
const failureResult = await failureWorker.runOnce("job-2");
assert.equal(failureResult, null);
assert.equal(failureRepository.get("job-2")?.status, "FAILED");
assert.equal(failureRepository.get("job-2")?.error, "provider completion timeout");
assert.equal(failureEvents[0]?.type, "generation.failed");
console.log("[Phase 1E] provider completion failure persistence: PASS");

const mismatchProvider = {
  ...successProvider,
  id: "mismatch-provider",
  async waitForCompletion() {
    return {
      jobId: "wrong-job",
      provider: "mismatch-provider",
      status: "COMPLETED",
      assets: [],
    };
  },
};
const mismatchRepository = setup("job-3", mismatchProvider);
const mismatchWorker = new ProviderCompletionWorker(
  mismatchRepository,
  () => mismatchProvider,
);
const mismatchResult = await mismatchWorker.runOnce("job-3");
assert.equal(mismatchResult, null);
assert.equal(mismatchRepository.get("job-3")?.status, "FAILED");
assert.match(mismatchRepository.get("job-3")?.error ?? "", /jobId mismatch/);
console.log("[Phase 1E] provider result identity validation: PASS");

console.log("[Phase 1E] generation.completed: NOT EMITTED");
console.log("[Phase 1E] Google Flow submission: NONE");
